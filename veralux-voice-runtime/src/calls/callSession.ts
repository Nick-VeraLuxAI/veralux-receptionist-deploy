
import fs from 'fs';
import path from 'path';
import { env } from '../env';
import { log } from '../log';
import { describeWavHeader, parseWavInfo } from '../audio/wavInfo';
import { runPlaybackPipeline } from '../audio/playbackPipeline';
import type { MediaFrame, Pcm16Frame } from '../media/types';
import { storeWav } from '../storage/audioStore';
import {
  ChunkedSTT,
  type SpeechStartInfo,
  type STTProvider as ChunkedSttProvider,
} from '../stt/chunkedSTT';
import { getProvider } from '../stt/registry';
import { PstnTelnyxTransportSession } from '../transport/pstnTelnyxTransport';
import type { TransferOptions, TransportSession } from '../transport/types';
import { synthesizeSpeech } from '../tts';
import { attachAudioMeta, getAudioMeta, markAudioSpan, probeWav } from '../diagnostics/audioProbe';
import type { TTSResult } from '../tts/types';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import { getEffectiveSpeakerWavUrl, type VoiceMode } from '../tenants/tenantConfig';
import { generateAssistantReply, generateAssistantReplyStream, type AssistantReplyResult } from '../ai/brainClient';
import { reportCallerMessage } from '../controlPlane';
import {
  CallSessionConfig,
  CallSessionMetrics,
  CallSessionState,
  CallTranscript,
  CallTranscriptTurn,
  ConversationTurn,
  TranscriptBuffer,
} from './types';
import { CallAudioCoordinator } from './callAudioCoordinator';
import { pushFarEndFrames } from '../audio/farEndReference';
import {
  processAec,
  releaseAecProcessor,
  resetAecProcessor,
  speexAecAvailable,
} from '../audio/aecProcessor';
import { startStageTimer, incStageError, observeStageDuration, incSttFramesFed } from '../metrics';

const PARTIAL_FAST_PATH_MIN_CHARS = 18;

// ─── Gibberish / Low-Quality Transcript Detection ────────────────────────────
// Catches common Whisper misheard / hallucinated outputs before they hit the LLM.
// Returns { gibberish: true, reason } if the transcript should be rejected.

const WHISPER_HALLUCINATIONS = [
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'the end',
  'you',         // Whisper often returns bare "you" for noise
];

// Short responses that are legitimate in a phone conversation and should
// never be rejected, even though they are 1-2 words.
const VALID_SHORT_RESPONSES = new Set([
  'no', 'yes', 'yeah', 'yep', 'nope', 'nah',
  'no thanks', 'no thank you', 'yes please',
  'goodbye', 'bye', 'bye bye', 'good bye',
  'okay', 'ok', 'sure', 'thanks', 'thank you',
  'hello', 'hi', 'hey',
  'help', 'transfer', 'operator', 'agent',
  'that\'s all', 'thats all', 'that is all', 'all good',
  'i\'m good', 'im good', 'nothing', 'never mind', 'nevermind',
  'not right now', 'no i\'m good', 'no im good',
]);

function detectGibberish(text: string): { gibberish: boolean; reason?: string } {
  const trimmed = text.trim().toLowerCase().replace(/[^\w\s']/g, '');
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);

  // 0) Allow known valid short responses — never reject these
  if (VALID_SHORT_RESPONSES.has(trimmed)) {
    return { gibberish: false };
  }

  // 1) Single bare word that isn't in the valid set — likely noise
  if (words.length === 1) {
    return { gibberish: true, reason: 'single_word_noise' };
  }

  // 2) Known Whisper hallucination phrases
  for (const hallucination of WHISPER_HALLUCINATIONS) {
    if (trimmed === hallucination || trimmed.startsWith(hallucination + ' ')) {
      return { gibberish: true, reason: `hallucination:${hallucination}` };
    }
  }

  // 3) Excessive repeated words (e.g., "the the the the")
  const wordCounts = new Map<string, number>();
  for (const w of words) {
    wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
  }
  const maxRepeat = Math.max(...wordCounts.values());
  if (words.length >= 4 && maxRepeat / words.length > 0.6) {
    return { gibberish: true, reason: 'excessive_repetition' };
  }

  // 4) Very short total characters relative to word count (random syllables)
  const avgWordLen = trimmed.replace(/\s/g, '').length / words.length;
  if (words.length >= 3 && avgWordLen < 2) {
    return { gibberish: true, reason: 'very_short_words' };
  }

  return { gibberish: false };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown_error';
}

function resolveDebugDir(): string {
  const dir = process.env.STT_DEBUG_DIR;
  return dir && dir.trim() !== '' ? dir.trim() : '/tmp/veralux-stt-debug';
}

function wavHeader(pcmDataBytes: number, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

function encodePcm16Wav(pcm16le: Buffer, sampleRateHz: number): Buffer {
  const header = wavHeader(pcm16le.length, sampleRateHz, 1);
  return Buffer.concat([header, pcm16le]);
}

export class CallSession {
  public readonly callControlId: string;
  public readonly tenantId?: string;
  public readonly from?: string;
  public readonly to?: string;
  public readonly requestId?: string;

  private state: CallSessionState = 'INIT';
  private readonly transcriptBuffer: TranscriptBuffer = [];
  private readonly conversationHistory: ConversationTurn[] = [];
  private readonly metrics: CallSessionMetrics;
  private readonly stt: ChunkedSTT;
  private readonly audioCoordinator: CallAudioCoordinator;
  private readonly transport: TransportSession;
  private readonly logContext: Record<string, unknown>;
  private readonly deadAirMs = env.DEAD_AIR_MS;
  private readonly deadAirNoFramesMs = env.DEAD_AIR_NO_FRAMES_MS;
  private readonly rxSampleRateHz: number;
  private readonly sttConfig?: RuntimeTenantConfig['stt'];
  private readonly ttsConfig?: RuntimeTenantConfig['tts'];
  private readonly transferProfiles?: RuntimeTenantConfig['transferProfiles'];
  private readonly assistantContext?: RuntimeTenantConfig['assistantContext'];
  private readonly _greetingText?: string;

  /**
   * Voice mode for XTTS: 'preset' uses built-in voice_id, 'cloned' uses reference audio.
   * Can be changed mid-call via setVoiceMode() for hot-swap functionality.
   */
  private currentVoiceMode: VoiceMode = 'preset';

  /**
   * Override speakerWavUrl for the current call. If set, takes precedence over
   * tenant config when currentVoiceMode is 'cloned'. Allows per-call voice customization.
   */
  private voiceModeOverrideSpeakerWavUrl?: string;
  private endedAt?: number;
  private endedReason?: string;
  private active = true;
  private pstnPlaybackEndAuthority: 'webhook' | 'watchdog' | null = null;

  private endPlaybackAuthoritatively(reason: 'webhook' | 'watchdog'): void {
    if (this.transport.mode !== 'pstn') {
      this.onPlaybackEnded();
      return;
    }

    this.pstnPlaybackEndAuthority = reason;
    try {
      this.onPlaybackEnded();
    } finally {
      this.pstnPlaybackEndAuthority = null;
    }
  }




  private isHandlingTranscript = false;
  private hasStarted = false;
  /** Consecutive gibberish/reprompt count — after N retries we pass through to the brain. */
  private gibberishRetryCount = 0;
  private readonly gibberishMaxRetries = 2;
  private turnSequence = 0;
  private deadAirTimer?: NodeJS.Timeout;
  private deadAirEligible = false;
  private repromptInFlight = false;
  private ingestFailurePrompted = false;
  private readonly logPreviewChars = 160;
  private ttsSegmentChain: Promise<void> = Promise.resolve();
  private ttsSegmentQueueDepth = 0;
  private playbackState: {
    active: boolean;
    interrupted: boolean;
    segmentId?: string;
    segmentDurationMs?: number;
  } = {
    active: false,
    interrupted: false,
  };
  /** Last TTS segment duration (ms) — used for Tier 2 measured listen-after-playback grace (300–900ms). */
  private lastPlaybackSegmentDurationMs = 0;
  private playbackStopSignal?: { promise: Promise<void>; resolve: () => void };
  private transcriptHandlingToken = 0;
  private transcriptAcceptedForUtterance = false;
  private deferredTranscript?: { text: string; source?: 'partial_fallback' | 'final' };
  private firstPartialAt?: number;
  private lastSpeechStartAtMs = 0;
  private lastDecodedFrameAtMs = 0;
  private lastInboundMediaAtMs = 0; // ✅ inbound PCM received (authoritative)
  private rxDumpActive = false;
  private rxDumpFlushTimer?: NodeJS.Timeout;
  private rxDumpSamplesTarget = 0;
  private rxDumpSamplesCollected = 0;
  private rxDumpBuffers: Buffer[] = [];
  private listeningSinceAtMs = 0;
  // pick reasonable defaults; you can env-ize later
  private readonly deadAirListeningGraceMs = 1200;  // prevents immediate reprompt right after enter LISTENING
  private readonly deadAirAfterSpeechStartGraceMs = 1500; // prevents reprompt while user has started speaking but transcript not ready
  // ===== STT in-flight tracking (prevents dead-air reprompt while Whisper HTTP is running) =====
  private sttInFlightCount = 0;
  // ===== Late FINAL grace window (accept FINAL transcript briefly after hangup) =====
  // Purpose: caller hangs up while Whisper final is still processing.
  // We want to CAPTURE the final transcript for logs/history, but NOT respond.
  private lateFinalGraceUntilMs: number = 0;

  private readonly lateFinalGraceMs = env.STT_LATE_FINAL_GRACE_MS ?? 1500;

  // Deferred teardown: when hangup happens with STT in flight, manager waits for transcript or grace expiry.
  private onReadyForTeardown?: () => void;
  private lateFinalGraceTimeout?: NodeJS.Timeout;
  /** Set while trying to play a response to a late-final transcript so we attempt Telnyx playback despite inactive. */
  private isRespondingToLateFinal = false;

  // ===== PSTN playback watchdog (prevents gate from staying closed if webhook is missed) =====
  private pstnPlaybackWatchdog?: NodeJS.Timeout;
  private pstnPlaybackWatchdogFor?: string;

  private readonly pstnPlaybackWatchdogMs = 8000; // tune 6000–12000ms as needed

  // ===== PSTN streaming: resolve when Telnyx playback.ended webhook fires for the current segment =====
  private pstnSegmentResolve: (() => void) | null = null;


  private onSttRequestStart(kind: 'partial' | 'final'): void {
    this.sttInFlightCount += 1;
    this.audioCoordinator.onSttRequestStart(kind, Date.now());

    log.info(
      {
        event: 'stt_req_start',
        kind,
        stt_in_flight: this.sttInFlightCount,
        ...(this.logContext ?? {}),
      },
      'stt request started',
    );
  }

  private onSttRequestEnd(kind: 'partial' | 'final'): void {
    this.sttInFlightCount = Math.max(0, this.sttInFlightCount - 1);
    this.audioCoordinator.onSttRequestEnd(kind, Date.now());

    log.info(
      {
        event: 'stt_req_end',
        kind,
        stt_in_flight: this.sttInFlightCount,
        ...(this.logContext ?? {}),
      },
      'stt request ended',
    );
  }

  /** Used by SessionManager to defer teardown until in-flight STT completes or grace expires. */
  public getSttInFlightCount(): number {
    return this.sttInFlightCount;
  }

  /**
   * Arm deferred teardown: when STT is in flight at hangup, manager calls this instead of teardown immediately.
   * We run the callback when (1) late final transcript is captured, or (2) grace period expires.
   */
  public armDeferredTeardown(callback: () => void): void {
    if (this.onReadyForTeardown != null) {
      log.warn(
        { event: 'deferred_teardown_already_armed', ...this.logContext },
        'armDeferredTeardown called more than once; replacing callback',
      );
    }
    this.onReadyForTeardown = callback;
    this.lateFinalGraceTimeout = setTimeout(() => {
      this.lateFinalGraceTimeout = undefined;
      this.settleLateFinalGrace();
    }, this.lateFinalGraceMs);
  }

  /**
   * Called when late final transcript is captured or grace timer fires.
   * Runs the deferred teardown callback once and clears state.
   */
  private settleLateFinalGrace(): void {
    if (this.lateFinalGraceTimeout != null) {
      clearTimeout(this.lateFinalGraceTimeout);
      this.lateFinalGraceTimeout = undefined;
    }
    this.lateFinalGraceUntilMs = 0;
    const cb = this.onReadyForTeardown;
    this.onReadyForTeardown = undefined;
    if (typeof cb === 'function') {
      cb();
    }
  }

  constructor(config: CallSessionConfig) {
    this.callControlId = config.callControlId;
    this.tenantId = config.tenantId;
    this.from = config.from;
    this.to = config.to;
    this.requestId = config.requestId;

    this.metrics = {
      createdAt: new Date(),
      lastHeardAt: undefined,
      turns: 0,
      transcriptsTotal: 0,
      transcriptsEmpty: 0,
      totalUtteranceMs: 0,
      totalTranscribedChars: 0,
    };

    this.sttConfig = config.tenantConfig?.stt;
    this.ttsConfig = config.tenantConfig?.tts;
    this.transferProfiles = config.tenantConfig?.transferProfiles;
    this.assistantContext = config.tenantConfig?.assistantContext;
    this._greetingText = (config.tenantConfig as any)?.greetingText;

    this.logContext = {
      call_control_id: this.callControlId,
      tenant_id: this.tenantId,
      requestId: this.requestId,
      telnyx_track: env.TELNYX_STREAM_TRACK,
    };

    // Initialize voice mode from tenant config (XTTS only)
    if (this.ttsConfig?.mode === 'coqui_xtts') {
      this.currentVoiceMode = this.ttsConfig.defaultVoiceMode ?? 'preset';
      log.info(
        {
          event: 'voice_mode_initialized',
          voice_mode: this.currentVoiceMode,
          has_cloned_voice: !!this.ttsConfig.clonedVoice,
          cloned_voice_label: this.ttsConfig.clonedVoice?.label,
          ...this.logContext,
        },
        'voice mode initialized',
      );
    }

    this.transport =
      config.transportSession ??
      new PstnTelnyxTransportSession({
        callControlId: this.callControlId,
        tenantId: this.tenantId,
        requestId: this.requestId,
        isActive: () => this.active && this.state !== 'ENDED',
        allowPlaybackWhenInactive: () => this.isRespondingToLateFinal,
      });

    // ✅ Ensure this is ALWAYS a string (tenant override → env fallback)
    let sttEndpointUrl =
      this.sttConfig?.config?.url ??
      this.sttConfig?.whisperUrl ??
      env.WHISPER_URL ??
      '';

    if (!sttEndpointUrl) {
      log.warn({ event: 'stt_url_missing', ...this.logContext }, 'No STT URL configured');
    }

    // ✅ Safety: if whisperUrl is a bare origin (no path), append /transcribe
    if (sttEndpointUrl) {
      try {
        const parsed = new URL(sttEndpointUrl);
        if (!parsed.pathname || parsed.pathname === '/') {
          sttEndpointUrl = `${sttEndpointUrl.replace(/\/$/, '')}/transcribe`;
          log.warn(
            {
              event: 'stt_url_auto_corrected',
              original: this.sttConfig?.whisperUrl ?? env.WHISPER_URL,
              corrected: sttEndpointUrl,
              ...this.logContext,
            },
            'whisperUrl had no path, auto-appended /transcribe',
          );
        }
      } catch {
        // not a valid URL, leave as-is
      }
    }


    const sttMode = this.sttConfig?.mode ?? 'whisper_http';

    const selectedMode =
      sttMode === 'http_wav_json' && !env.ALLOW_HTTP_WAV_JSON ? 'whisper_http' : sttMode;

    const provider = getProvider(selectedMode) as unknown as ChunkedSttProvider;

    log.info(
      {
        event: 'stt_provider_selected',
        call_control_id: this.callControlId,
        stt_mode: selectedMode,
        requested_mode: sttMode,
        provider_id: provider.id,
        ...(this.logContext ?? {}),
      },
      'stt provider selected',
    );
    const sttAudioInput =
      this.transport.mode === 'pstn'
        ? { codec: 'pcm16le' as const, sampleRateHz: env.TELNYX_TARGET_SAMPLE_RATE }
        : this.transport.audioInput;
    this.rxSampleRateHz = sttAudioInput.sampleRateHz;

    this.audioCoordinator = new CallAudioCoordinator({
      callControlId: this.callControlId,
      sampleRateHz: this.rxSampleRateHz,
      logContext: this.logContext,
      isPlaybackActive: () => this.isPlaybackActive(),
      isCallActive: () => this.active && this.state !== 'ENDED',
      canArmListening: () => this.active && this.state !== 'ENDED' && !this.isHandlingTranscript,
      isListening: () => this.state === 'LISTENING',
      onArmListening: (reason) => {
        void reason;
        this.enterListeningState(true);
      },
    });
    if (this.transport.mode !== 'pstn') {
      this.audioCoordinator.setWsConnected(true);
    }

    this.stt = new ChunkedSTT({
      provider,
      whisperUrl: sttEndpointUrl,
      language: this.sttConfig?.language ?? env.STT_LANGUAGE,
      prompt: env.STT_WHISPER_PROMPT,
      frameMs: this.sttConfig?.chunkMs ?? env.STT_CHUNK_MS,
      silenceEndMs: env.STT_SILENCE_MS,
      inputCodec: sttAudioInput.codec,
      sampleRate: sttAudioInput.sampleRateHz,
      onTranscript: async (text, source) => {
        await this.handleTranscript(text, source);
      },
      onSpeechStart: (info: SpeechStartInfo) => {
        void this.handleSpeechStart(info);
      },
      onUtteranceEnd: (info) => {
        this.audioCoordinator.onUtteranceEnd(info);
      },
      onFinalResult: (opts) => {
        this.metrics.transcriptsTotal += 1;
        if (opts.isEmpty) this.metrics.transcriptsEmpty += 1;
        this.metrics.totalUtteranceMs += opts.utteranceMs;
        this.metrics.totalTranscribedChars += opts.textLength;
      },
      // When AEC is on, ring buffer has raw audio but STT receives AEC-processed;
      // mixing causes "starts over" / duplication. Use internal pre-roll only.
      consumePreRoll: env.STT_AEC_ENABLED
        ? undefined
        : () => this.audioCoordinator.consumePreRollForUtterance(),
      // Feed preroll ring in STT order so snapshot at speech start doesn't include future frames (avoids "starts and repeats").
      onFrameForPreRoll: env.STT_AEC_ENABLED
        ? undefined
        : (buffer, _frameMs) => this.audioCoordinator.pushFrameForPreRoll(buffer, this.rxSampleRateHz),
      // ✅ STT in-flight hooks (ChunkedSTT calls these when provider requests start/end)
      onSttRequestStart: (kind) => this.onSttRequestStart(kind),
      onSttRequestEnd: (kind) => this.onSttRequestEnd(kind),

      isPlaybackActive: () => this.isPlaybackActive(),
      isListening: () => this.isListening(),
      isCallActive: () => this.active && this.state !== 'ENDED',

      getTrack: () => env.TELNYX_STREAM_TRACK,
      getCodec: () => this.transport.audioInput.codec,
      logContext: this.logContext,

      // Tier 2: measured listen-after-playback delay (300–900ms based on last segment length)
      getPostPlaybackGraceMs: () => this.computePostPlaybackGraceMs(),
    });
  }


  public start(options: { autoAnswer?: boolean } = {}): boolean {
    if (!this.active || this.state === 'ENDED' || this.hasStarted) {
      return false;
    }

    this.state = 'INIT';
    this.hasStarted = true;

    if (options.autoAnswer !== false) {
      void this.answerAndGreet();
    }

    return true;
  }

  public onAnswered(): boolean {
    if (!this.active || this.state === 'ENDED') {
      return false;
    }

    const previousState = this.state;
    if (this.state === 'INIT') {
      this.state = 'ANSWERED';
    }

    this.metrics.lastHeardAt = new Date();
    this.audioCoordinator.notifyListeningEligibilityChanged('answered');
    return previousState !== this.state;
  }

  public onMediaWsConnected(): void {
    this.audioCoordinator.setWsConnected(true);
  }

  public onMediaWsDisconnected(): void {
    this.handleMediaDisconnect('ws_close');
  }

  public onMediaStreamingStopped(): void {
    this.handleMediaDisconnect('streaming_stopped');
  }

  private handleMediaDisconnect(reason: 'ws_close' | 'streaming_stopped'): void {
    const now = Date.now();
    this.audioCoordinator.setWsConnected(false, now);
    if (this.audioCoordinator.shouldFinalizeOnDisconnect()) {
      if (!this.audioCoordinator.isFinalInFlight()) {
        this.stt.stop({ preserveInFlightFinal: true }).catch(() => undefined);
      }
    }
    if (this.active && this.state === 'LISTENING') {
      this.state = 'ANSWERED';
      this.listeningSinceAtMs = 0;
      this.deadAirEligible = false;
      this.clearDeadAirTimer();
    }
  }

  public onAudioFrame(frame: MediaFrame): void {
    if (!this.active || this.state === 'ENDED') return;

    // PSTN must feed STT with decoded PCM16 only (via onPcm16Frame)
    if (this.transport.mode === 'pstn') {
      log.warn(
        { event: 'unexpected_audio_frame_on_pstn', ...this.logContext },
        'PSTN transport should call onPcm16Frame (decoded pcm16) not onAudioFrame',
      );
      return;
    }

    // Non-PSTN / WebRTC can continue using this path if that's how your transport works.
    const now = Date.now();
    this.lastInboundMediaAtMs = now;   // ✅ NEW
    this.lastDecodedFrameAtMs = now;


    if (this.transport.audioInput.codec === 'pcm16le') {
      const sampleCount = Math.floor(frame.length / 2);
      if (sampleCount > 0) {
        const pcm16 = new Int16Array(frame.buffer, frame.byteOffset, sampleCount);
        this.audioCoordinator.onInboundFrame(
          { pcm16, sampleRateHz: this.rxSampleRateHz, channels: 1 },
          now,
        );
      }
    }

    if (this.state === 'LISTENING') {
      if (!this.deadAirEligible && this.audioCoordinator.isMediaReady()) {
        this.deadAirEligible = true;
      }
      this.scheduleDeadAirTimer();
    }

    this.metrics.lastHeardAt = new Date();
    incSttFramesFed();

    // IMPORTANT: only do rx dump here if you KNOW these bytes are pcm16.
    // If you don't, remove this line entirely.
    // this.maybeCaptureRxDump(frame as unknown as Buffer);

    // Only feed raw bytes into STT when they are PCM16LE frames.
    if (this.transport.audioInput.codec !== 'pcm16le') {
      return;
    }

    this.stt.ingest(frame);
  }


  public onPcm16Frame(frame: Pcm16Frame): void {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    const now = Date.now();

    // ✅ authoritative: inbound media was received
    this.lastInboundMediaAtMs = now;

    // keep existing marker too
    this.lastDecodedFrameAtMs = now;
    this.metrics.lastHeardAt = new Date();

    this.audioCoordinator.onInboundFrame(frame, now);

    // ✅ CRITICAL: keep dead-air timer fresh while listening
    if (this.state === 'LISTENING') {
      if (!this.deadAirEligible && this.audioCoordinator.isMediaReady()) {
        this.deadAirEligible = true;
      }
      this.scheduleDeadAirTimer();
    }

    if (frame.sampleRateHz !== this.rxSampleRateHz) {
      log.warn(
        {
          event: 'stt_sample_rate_mismatch',
          expected_hz: this.rxSampleRateHz,
          got_hz: frame.sampleRateHz,
          ...this.logContext,
        },
        'stt sample rate mismatch',
      );
    }

    const feedToStt = (pcm16: Int16Array, sampleRateHz: number) => {
      const pcmBuffer = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
      incSttFramesFed();
      this.maybeCaptureRxDump(pcmBuffer);
      this.stt.ingestPcm16(pcm16, sampleRateHz);
    };

    if (env.STT_AEC_ENABLED && speexAecAvailable && frame.sampleRateHz === 16000) {
      processAec(this.callControlId, frame.pcm16, frame.sampleRateHz, feedToStt, this.logContext);
    } else {
      feedToStt(frame.pcm16, frame.sampleRateHz);
    }
  }

  public isPlaybackActive(): boolean {
    if (!this.active || this.state === 'ENDED') return false;

    if (this.transport.mode === 'pstn') {
      // PSTN: only the authoritative playback flag matters
      return this.playbackState.active;
    }

    return this.playbackState.active || this.ttsSegmentQueueDepth > 0;
  }



  public isListening(): boolean {
    return this.state === 'LISTENING';
  }

  public getLastSpeechStartAtMs(): number {
    return this.lastSpeechStartAtMs;
  }

  public notifyIngestFailure(reason: string): void {
    if (!this.active || this.state === 'ENDED') {
      return;
    }
    if (this.ingestFailurePrompted || this.repromptInFlight) {
      return;
    }

    this.ingestFailurePrompted = true;
    this.repromptInFlight = true;
    this.stt.stop();

    const turnId = `ingest-${this.nextTurnId()}`;
    log.warn(
      { event: 'call_session_ingest_failure_prompt', reason, ...this.logContext },
      'ingest failure prompt',
    );

    void this.playText("I'm having trouble hearing you. Please try again.", turnId)
      .catch((error) => {
        log.warn({ err: error, ...this.logContext }, 'ingest failure reprompt failed');
      })
      .finally(() => {
        this.repromptInFlight = false;
        if (this.state === 'LISTENING') {
          this.scheduleDeadAirTimer();
        }
      });
  }

  public end(): boolean {
    if (this.state === 'ENDED') {
      this.markEnded('ended');
      return false;
    }

    this.markEnded('ended');
    this.state = 'ENDED';
    this.metrics.lastHeardAt = new Date();
    this.clearDeadAirTimer();
    this.stt.stop({ allowFinal: false, preserveInFlightFinal: true }).catch(() => undefined);
    return true;
  }

  public getState(): CallSessionState {
    return this.state;
  }

  public getTransport(): TransportSession {
    return this.transport;
  }

  /**
   * Transfer the call to another number or SIP URI. Only supported on PSTN (Telnyx).
   * After transfer, Telnyx will send call.bridged or call.hangup; session teardown is handled normally.
   */
  public async transferCall(to: string, options?: TransferOptions): Promise<void> {
    if (!this.transport.transfer) {
      log.warn(
        { event: 'transfer_not_supported', mode: this.transport.mode, ...this.logContext },
        'transfer not supported on this transport',
      );
      return;
    }
    if (!this.active) {
      log.warn({ event: 'transfer_ignored_inactive', ...this.logContext }, 'transfer ignored: call inactive');
      return;
    }
    try {
      // Send the transfer command to Telnyx BEFORE marking the call inactive,
      // otherwise the transport will skip the API call due to inactive state.
      await this.transport.transfer(to, options);
      log.info(
        { event: 'call_transfer_requested', to, ...this.logContext },
        'call transfer requested',
      );
      // Now mark ended — Telnyx will send call.bridged or call.hangup from here.
      this.markEnded('transfer');
    } catch (error) {
      log.error({ err: error, to, ...this.logContext }, 'call transfer failed');
      throw error;
    }
  }

  public isActive(): boolean {
    return this.active;
  }

  public markEnded(reason: string): void {
    if (!this.active) {
      if (!this.endedReason) {
        this.endedReason = reason;
      }
      return;
    }

    this.active = false;
    this.endedAt = Date.now();
    // If Whisper is in-flight, allow a brief window to accept the FINAL transcript.
    // This is log/history only — no assistant reply, no TTS.
    if (this.sttInFlightCount > 0) {
      this.lateFinalGraceUntilMs = this.endedAt + this.lateFinalGraceMs;

      log.info(
        {
          event: 'late_final_grace_armed',
          reason,
          stt_in_flight: this.sttInFlightCount,
          grace_ms: this.lateFinalGraceMs,
          grace_until_ms: this.lateFinalGraceUntilMs,
          ...this.logContext,
        },
        'late final grace armed',
      );
    }

    this.endedReason = reason;
    this.audioCoordinator.onHangup(this.endedAt, reason);
    log.info(
      { event: 'call_marked_inactive', reason, ...this.logContext },
      'call marked inactive',
    );
  }

  public getEndInfo(): { endedAt?: number; endedReason?: string } {
    return {
      endedAt: this.endedAt,
      endedReason: this.endedReason,
    };
  }

  public getMetrics(): CallSessionMetrics {
    return {
      createdAt: new Date(this.metrics.createdAt),
      lastHeardAt: this.metrics.lastHeardAt ? new Date(this.metrics.lastHeardAt) : undefined,
      turns: this.metrics.turns,
      transcriptsTotal: this.metrics.transcriptsTotal,
      transcriptsEmpty: this.metrics.transcriptsEmpty,
      totalUtteranceMs: this.metrics.totalUtteranceMs,
      totalTranscribedChars: this.metrics.totalTranscribedChars,
    };
  }

  public getLastActivityAt(): Date {
    return this.metrics.lastHeardAt ?? this.metrics.createdAt;
  }

  public appendTranscriptSegment(segment: string): void {
    if (segment.trim() === '') {
      return;
    }
    this.transcriptBuffer.push(segment);
  }
  
  private captureLateFinalTranscript(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Keep a record for debugging + analytics:
    this.appendTranscriptSegment(trimmed);
    this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });

    const preview =
      trimmed.length <= this.logPreviewChars
        ? trimmed
        : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;

    log.info(
      {
        event: 'late_final_captured',
        transcript_length: trimmed.length,
        transcript_preview: preview,
        ended_reason: this.endedReason,
        ended_at: this.endedAt,
        stt_in_flight: this.sttInFlightCount,
        ...this.logContext,
      },
      'late final transcript captured after hangup',
    );

    // Try to get an assistant reply and play it before teardown (media may already be closed).
    void this.tryRespondToLateFinal(trimmed);
  }

  /**
   * When we capture a late final (transcript arrived after hangup), try to respond so the user
   * might still hear an answer if the media path is briefly open. Always calls settleLateFinalGrace
   * when done so teardown runs.
   */
  private async tryRespondToLateFinal(transcript: string): Promise<void> {
    this.isRespondingToLateFinal = true;
    try {
      const tenantLabel = this.tenantId ?? 'unknown';
      let response = '';
      try {
        const reply = await generateAssistantReply({
          tenantId: this.tenantId,
          callControlId: this.callControlId,
          transcript,
          history: this.conversationHistory,
          transferProfiles: this.transferProfiles,
          assistantContext: this.assistantContext,
        });
        response = reply.text;
        log.info(
          {
            event: 'late_final_assistant_reply',
            transcript_length: transcript.length,
            reply_length: response.length,
            ...this.logContext,
          },
          'late final assistant reply generated',
        );
      } catch (error) {
        log.warn(
          { err: error, transcript_length: transcript.length, ...this.logContext },
          'late final assistant reply failed',
        );
      }

      if (response.trim()) {
        this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
        await this.playText(response, `late-final-${this.nextTurnId()}`, {
          allowWhenEndedForLateFinal: true,
        });
      }
    } catch (error) {
      log.warn(
        { err: error, ...this.logContext },
        'late final response (play) failed',
      );
    } finally {
      this.isRespondingToLateFinal = false;
      this.settleLateFinalGrace();
    }
  }


  public appendHistory(turn: ConversationTurn): void {
    this.conversationHistory.push(turn);
    this.metrics.turns += 1;
  }

  /** Full call transcript (caller + assistant text only, no audio). Use at teardown for summarizer / logs. */
  public getCallTranscript(endedAt?: Date): CallTranscript {
    const now = endedAt ?? new Date();
    const turns: CallTranscriptTurn[] = this.conversationHistory.map((t) => ({
      role: t.role,
      content: t.content,
      timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : String(t.timestamp),
    }));
    const startedAt = this.metrics.createdAt;
    const durationMs = now.getTime() - startedAt.getTime();
    return {
      callControlId: this.callControlId,
      tenantId: this.tenantId,
      from: this.from,
      to: this.to,
      startedAt: startedAt.toISOString(),
      endedAt: now.toISOString(),
      durationMs,
      turns,
    };
  }

  // ==================== Voice Mode Management (Hot-Swap) ====================

  /**
   * Get the current voice mode ('preset' or 'cloned').
   * Only meaningful for XTTS TTS mode.
   */
  public getVoiceMode(): VoiceMode {
    return this.currentVoiceMode;
  }

  /**
   * Set the voice mode for this call session. Enables hot-swap between preset and cloned voices.
   * Takes effect on the next TTS synthesis (ongoing playback is not interrupted).
   *
   * @param mode 'preset' to use built-in voice_id, 'cloned' to use reference audio
   * @param speakerWavUrl Optional override URL for cloned voice (if not using tenant config)
   */
  public setVoiceMode(mode: VoiceMode, speakerWavUrl?: string): void {
    const previousMode = this.currentVoiceMode;
    this.currentVoiceMode = mode;

    if (speakerWavUrl) {
      this.voiceModeOverrideSpeakerWavUrl = speakerWavUrl;
    }

    log.info(
      {
        event: 'voice_mode_changed',
        previous_mode: previousMode,
        new_mode: mode,
        has_override_url: !!speakerWavUrl,
        ...this.logContext,
      },
      'voice mode changed',
    );
  }

  /**
   * Check if voice cloning is available for this session.
   * Returns true if XTTS mode and a cloned voice is configured.
   */
  public isVoiceCloningAvailable(): boolean {
    if (this.ttsConfig?.mode !== 'coqui_xtts') {
      return false;
    }
    return !!(
      this.voiceModeOverrideSpeakerWavUrl ||
      this.ttsConfig.clonedVoice?.speakerWavUrl ||
      this.ttsConfig.speakerWavUrl
    );
  }

  /**
   * Get the effective speakerWavUrl for the current voice mode.
   * Returns undefined for 'preset' mode (uses voice_id), or the cloned voice URL for 'cloned' mode.
   */
  private getCurrentSpeakerWavUrl(): string | undefined {
    // Override takes precedence
    if (this.currentVoiceMode === 'cloned' && this.voiceModeOverrideSpeakerWavUrl) {
      return this.voiceModeOverrideSpeakerWavUrl;
    }

    // Use helper to get from tenant config
    return getEffectiveSpeakerWavUrl(this.ttsConfig, this.currentVoiceMode);
  }

  /**
   * Get voice mode info for external visibility (API, brain responses, etc.)
   */
  public getVoiceModeInfo(): {
    mode: VoiceMode;
    available: boolean;
    clonedVoiceLabel?: string;
  } {
    const available = this.isVoiceCloningAvailable();
    const clonedVoiceLabel =
      this.ttsConfig?.mode === 'coqui_xtts'
        ? this.ttsConfig.clonedVoice?.label
        : undefined;

    return {
      mode: this.currentVoiceMode,
      available,
      clonedVoiceLabel,
    };
  }

  // Called specifically when Telnyx sends call.playback.ended webhook
  public onTelnyxPlaybackEnded(meta?: { requestId?: string; source?: string }): void {
    // 🔒 PLAYBACK_END_TRANSITION (authoritative: pstn=webhook, webrtc=transport)
    if (this.transport.mode !== 'pstn') {
      log.warn(
        {
          event: 'telnyx_playback_ended_ignored_non_pstn',
          requestId: meta?.requestId,
          source: meta?.source ?? 'unknown',
          mode: this.transport.mode,
          state: this.state,
          ...this.logContext,
        },
        'ignoring telnyx playback ended for non-pstn transport',
      );
      return;
    }

    // Optional: log the authoritative webhook arrival
    log.info(
      {
        event: 'telnyx_playback_ended_webhook',
        requestId: meta?.requestId,
        source: meta?.source ?? 'unknown',
        state: this.state,
        playback_active: this.playbackState.active,
        tts_queue_depth: this.ttsSegmentQueueDepth,
        pstn_segment_streaming: !!this.pstnSegmentResolve,
        ...this.logContext,
      },
      'telnyx playback ended (webhook)',
    );

    // If a streaming segment is waiting for this webhook, resolve it so the next
    // segment in the chain can start. Don't trigger full playback-end transition yet —
    // that happens when the segment queue drains to 0.
    if (this.pstnSegmentResolve) {
      const resolve = this.pstnSegmentResolve;
      this.pstnSegmentResolve = null;
      resolve();
      return;
    }

    this.endPlaybackAuthoritatively('webhook');

  }




  public onPlaybackEnded(): void {
    // 🔒 PSTN AUTHORITY GUARD
    // 🔒 PSTN AUTHORITY GUARD (with failsafe)
    // Primary path: only accept playback end via endPlaybackAuthoritatively().
    // Failsafe: if playback is still active, accept and clean up anyway to avoid stuck state.
    if (this.transport.mode === 'pstn' && this.pstnPlaybackEndAuthority === null) {
      if (!this.playbackState.active) {
        log.warn(
          { event: 'playback_end_ignored_non_authoritative', state: this.state, ...this.logContext },
          'ignoring onPlaybackEnded() on pstn (non-authoritative caller)',
        );
        return;
      }

      // Failsafe: accept cleanup to prevent permanent stuck playback gate
      log.warn(
        { event: 'playback_end_non_authoritative_failsafe', state: this.state, ...this.logContext },
        'accepting onPlaybackEnded() on pstn without authority (failsafe)',
      );
    }


    const now = Date.now();

    // ✅ CLEAR watchdog (do NOT arm it here)
    if (this.pstnPlaybackWatchdog) {
      clearTimeout(this.pstnPlaybackWatchdog);
      this.pstnPlaybackWatchdog = undefined;
    }
    this.pstnPlaybackWatchdogFor = undefined;


    // If playback already inactive, just normalize state + notify coordinator
    if (!this.playbackState.active) {
      log.info(
        { event: 'playback_end_ignored_already_inactive', state: this.state, ...this.logContext },
        'playback end ignored (already inactive)',
      );

      if (this.active && this.state === 'SPEAKING') {
        this.state = 'ANSWERED';
        this.listeningSinceAtMs = 0;
      }

      this.audioCoordinator.onPlaybackEnded(now);
      return;
    }

    // ✅ If streaming segments are still queued, do NOT end playback yet.
    // Segment queue drain will call onPlaybackEnded() (non-PSTN) when depth hits 0.
    if (this.ttsSegmentQueueDepth > 0 && !this.playbackState.interrupted) {
      return;
    }

    const wasInterrupted = this.playbackState.interrupted;

    // Tier 2: capture segment duration for measured listen-after-playback grace
    const segMs = this.playbackState.segmentDurationMs;
    if (segMs != null && segMs > 0) {
      this.lastPlaybackSegmentDurationMs = segMs;
    }

    // ✅ ALWAYS clear playback flags FIRST
    this.playbackState.active = false;
    this.playbackState.interrupted = false;
    this.playbackState.segmentId = undefined;
    this.playbackState.segmentDurationMs = undefined;

    // ✅ resolve + clear stop signal
    this.resolvePlaybackStopSignal();
    this.playbackStopSignal = undefined;

    if (wasInterrupted) {
      log.info(
        { event: 'playback_ended_after_barge_in', ...this.logContext },
        'playback ended after barge-in',
      );

      // ✅ CRITICAL FIX: barge-in playback end must re-open the LISTENING gate
      if (this.active && this.state !== 'ENDED') {
        this.enterListeningState(false);
      }

      // optional but recommended: if a FINAL came in during playback, consume it now
      if (this.active) {
        this.flushDeferredTranscript();
        if (!this.isHandlingTranscript && this.state === 'LISTENING') {
          this.scheduleDeadAirTimer();
        }
      }

      this.startRxDumpAfterPlayback();
      this.audioCoordinator.onPlaybackEnded(now);
      return;
    }


    // ✅ normal playback end: enter LISTENING (but don't arm dead-air immediately)
    if (this.active && this.state !== 'ENDED') {
      this.enterListeningState(false);
    }

    // ✅ consume deferred FINAL immediately (no reprompt racing)
    if (this.active) {
      this.flushDeferredTranscript();

      if (!this.isHandlingTranscript && this.state === 'LISTENING') {
        this.scheduleDeadAirTimer();
      }
    }

    this.startRxDumpAfterPlayback();
    this.audioCoordinator.onPlaybackEnded(now);
  }


  private createPlaybackStopSignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void;
    const promise = new Promise<void>((resolver) => {
      resolve = resolver;
    });
    return { promise, resolve: resolve! };
  }

  /** Tier 2: compute listen-after-playback grace (300–900ms) from last segment length. */
  private computePostPlaybackGraceMs(): number {
    const minMs = env.STT_POST_PLAYBACK_GRACE_MIN_MS ?? 300;
    const maxMs = env.STT_POST_PLAYBACK_GRACE_MAX_MS ?? 900;
    const fixedMs = env.STT_POST_PLAYBACK_GRACE_MS;
    if (this.lastPlaybackSegmentDurationMs <= 0) {
      return fixedMs ?? minMs;
    }
    // Longer segment → longer pipeline tail/echo decay → longer grace
    const growth = (this.lastPlaybackSegmentDurationMs / 4000) * (maxMs - minMs);
    return Math.round(Math.min(maxMs, Math.max(minMs, minMs + growth)));
  }

  private armPstnPlaybackWatchdog(): void {
    if (this.transport.mode !== 'pstn') return;

    if (this.pstnPlaybackWatchdog) {
      clearTimeout(this.pstnPlaybackWatchdog);
      this.pstnPlaybackWatchdog = undefined;
    }

    this.pstnPlaybackWatchdogFor = this.playbackState.segmentId;

    this.pstnPlaybackWatchdog = setTimeout(() => {
      if (!this.active || this.state === 'ENDED') return;
      if (!this.playbackState.active) return;

      // ✅ stale watchdog guard
      // If playback was interrupted, segmentId may be cleared; still allow watchdog cleanup.
      if (!this.playbackState.interrupted && this.pstnPlaybackWatchdogFor !== this.playbackState.segmentId) {
        return;
      }


      log.warn(
        { event: 'pstn_playback_watchdog_fired', state: this.state, ...this.logContext },
        'forcing playback end (telnyx playback.ended webhook missing/delayed)',
      );

      // If a streaming segment is waiting for the webhook, unblock it
      if (this.pstnSegmentResolve) {
        const resolve = this.pstnSegmentResolve;
        this.pstnSegmentResolve = null;
        resolve();
        return; // let the segment queue drain handle final cleanup
      }

      this.endPlaybackAuthoritatively('watchdog');
    }, this.pstnPlaybackWatchdogMs);


    this.pstnPlaybackWatchdog.unref?.();
  }



  private beginPlayback(segmentId?: string): void {
    if (!this.playbackState.active) {
      this.playbackStopSignal = this.createPlaybackStopSignal();
    }
    this.playbackState.active = true;
    resetAecProcessor(this.callControlId);
    this.playbackState.interrupted = false;
    this.playbackState.segmentId = segmentId;
    this.state = 'SPEAKING';
    this.clearDeadAirTimer();
    this.resetRxDump();

    // ✅ PSTN safety: don't let playback gate stay closed forever if webhook is missed
    this.armPstnPlaybackWatchdog();
  }


  private resolvePlaybackStopSignal(): void {
    if (this.playbackStopSignal) {
      this.playbackStopSignal.resolve();
      this.playbackStopSignal = undefined;
    }
  }

  private clearTtsQueue(): void {
    this.ttsSegmentChain = Promise.resolve();
    this.ttsSegmentQueueDepth = 0;

    // Unblock any PSTN segment waiting for a playback.ended webhook
    if (this.pstnSegmentResolve) {
      const resolve = this.pstnSegmentResolve;
      this.pstnSegmentResolve = null;
      resolve();
    }
  }

  private invalidateTranscriptHandling(): void {
    this.transcriptHandlingToken += 1;
    this.isHandlingTranscript = false;
  }

  private flushDeferredTranscript(): void {
    if (!this.deferredTranscript) {
      return;
    }
    if (!this.active || this.state === 'ENDED' || this.isHandlingTranscript) {
      return;
    }

    const deferred = this.deferredTranscript;
    this.deferredTranscript = undefined;
    void this.handleTranscript(deferred.text, deferred.source);
  }

  private logTtsBytesReady(
    id: string,
    audio: Buffer,
    contentType: string | undefined,
  ): void {
    const header = describeWavHeader(audio);
    log.info(
      {
        event: 'tts_bytes_ready',
        id,
        bytes: audio.length,
        riff: header.riff,
        wave: header.wave,
        ...this.logContext,
      },
      'tts bytes ready',
    );

    if (!header.riff || !header.wave) {
      log.warn(
        {
          event: 'tts_non_wav_warning',
          id,
          content_type: contentType,
          first16_hex: header.first16Hex,
          bytes: audio.length,
          ...this.logContext,
        },
        'tts bytes are not wav',
      );
    }

    const audioLogContext = { ...this.logContext, tts_id: id };
    const baseMeta = {
      callId: this.callControlId,
      tenantId: this.tenantId,
      format: 'wav' as const,
      logContext: audioLogContext,
      lineage: ['tts:output'],
      kind: id,
    };
    attachAudioMeta(audio, baseMeta);
    probeWav('tts.out.raw', audio, baseMeta);

    this.logWavInfo(this.ttsConfig?.mode === 'coqui_xtts' ? 'coqui_xtts' : 'kokoro', id, audio);
  }

  private logWavInfo(source: 'kokoro' | 'coqui_xtts' | 'pipeline_output', id: string, audio: Buffer): void {
    try {
      const info = parseWavInfo(audio);
      log.info(
        {
          event: 'wav_info',
          source,
          id,
          sample_rate_hz: info.sampleRateHz,
          channels: info.channels,
          bits_per_sample: info.bitsPerSample,
          data_bytes: info.dataBytes,
          duration_ms: info.durationMs,
          ...this.logContext,
        },
        'wav info',
      );
    } catch (error) {
      log.warn(
        {
          event: 'wav_info_parse_failed',
          source,
          id,
          reason: getErrorMessage(error),
          ...this.logContext,
        },
        'wav info parse failed',
      );
    }
  }

  private resetTranscriptTracking(): void {
    this.transcriptAcceptedForUtterance = false;
    this.deferredTranscript = undefined;
    this.firstPartialAt = undefined;
  }

  private shouldTriggerPartialFastPath(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/[.!?]$/.test(trimmed)) return true;
    return trimmed.length >= PARTIAL_FAST_PATH_MIN_CHARS;
  }

  private handleSpeechStart(info: SpeechStartInfo): void {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    this.lastSpeechStartAtMs = Date.now();
    this.audioCoordinator.onSpeechStart(info.prependedMs ?? 0, this.lastSpeechStartAtMs);
    this.resetTranscriptTracking();

    const playbackActive = this.isPlaybackActive();
    if (!playbackActive || this.playbackState.interrupted) {
      return;
    }

    log.info(
      {
        event: 'barge_in',
        reason: 'speech_start',
        state: this.state,
        speech_rms: info.rms,
        speech_peak: info.peak,
        speech_frame_ms: Math.round(info.frameMs),
        speech_frame_streak: info.streak,
        ...this.logContext,
      },
      'barge in',
    );

    // ✅ mark interrupted, but DO NOT clear active here.
    // onPlaybackEnded() needs active=true to run its cleanup.
    this.playbackState.interrupted = true;

    this.resolvePlaybackStopSignal();

    // ✅ Cancel queued segments without double-manipulating the counter
    // clearTtsQueue() already sets queue depth to 0.
    this.clearTtsQueue();
    this.invalidateTranscriptHandling();

    // ✅ Stop playback first; onPlaybackEnded() will re-enter LISTENING and start rx dump.
    // Avoid double transitions + weird flush timing.
    void this.stopPlayback();


  }

  private async stopPlayback(): Promise<void> {
    // We want to stop playback, but we MUST NOT rely on Telnyx webhook timing to unblock state.
    // So on PSTN we perform an authoritative local cleanup after attempting stop().
    try {
      await this.transport.playback.stop();
    } catch (error) {
      log.warn({ err: error, ...this.logContext }, 'playback stop failed');
    } finally {
      if (this.transport.mode === 'pstn') {
        // ✅ Authoritative local cleanup (even if webhook is late/missed)
        this.endPlaybackAuthoritatively('watchdog');
        return;
      }

      // Non-PSTN: transport completion is authoritative
      this.onPlaybackEnded();
    }
  }

  private enterListeningState(armDeadAir: boolean = true): void {
    if (!this.active || this.state === 'ENDED') {
      return;
    }

    this.state = 'LISTENING';
    this.listeningSinceAtMs = Date.now();
    this.deadAirEligible = false;

    if (armDeadAir) {
      if (this.audioCoordinator.isMediaReady()) {
        this.deadAirEligible = true;
        this.scheduleDeadAirTimer();
      }
    }
  }



  private scheduleDeadAirTimer(): void {
    if (!this.active || this.state !== 'LISTENING') {
      return;
    }
    if (!this.deadAirEligible) {
      return;
    }

    this.clearDeadAirTimer();
    this.deadAirTimer = setTimeout(() => {
      void this.handleDeadAirTimeout();
    }, this.deadAirMs);
    this.deadAirTimer.unref?.();
  }

  private clearDeadAirTimer(): void {
    if (this.deadAirTimer) {
      clearTimeout(this.deadAirTimer);
      this.deadAirTimer = undefined;
    }
  }

  private startRxDumpAfterPlayback(): void {
    if (!env.STT_DEBUG_DUMP_RX_WAV) {
      return;
    }

    // clear any prior timer
    if (this.rxDumpFlushTimer) {
      clearTimeout(this.rxDumpFlushTimer);
      this.rxDumpFlushTimer = undefined;
    }

    this.rxDumpActive = true;

    // 0.75s can still be tiny if the caller speaks immediately; use ~1.25s
    this.rxDumpSamplesTarget = Math.max(1, Math.round(this.rxSampleRateHz * 1.25));

    this.rxDumpSamplesCollected = 0;
    this.rxDumpBuffers = [];

    // ✅ guaranteed flush: even if FINAL arrives fast, we still write a meaningful chunk
    this.rxDumpFlushTimer = setTimeout(() => {
      if (this.rxDumpActive && this.rxDumpSamplesCollected > 0) {
        void this.flushRxDump();
      } else {
        // nothing collected; just stop quietly
        this.rxDumpActive = false;
      }
    }, 900);

    this.rxDumpFlushTimer.unref?.();
  }


  private resetRxDump(): void {
    if (this.rxDumpFlushTimer) {
      clearTimeout(this.rxDumpFlushTimer);
      this.rxDumpFlushTimer = undefined;
    }
    this.rxDumpActive = false;
    this.rxDumpSamplesCollected = 0;
    this.rxDumpSamplesTarget = 0;
    this.rxDumpBuffers = [];
  }

  private maybeCaptureRxDump(frame: Buffer): void {
    if (!this.rxDumpActive) {
      return;
    }
    const sampleCount = Math.floor(frame.length / 2);
    if (sampleCount <= 0) {
      return;
    }
    this.rxDumpBuffers.push(Buffer.from(frame));
    this.rxDumpSamplesCollected += sampleCount;
    if (this.rxDumpSamplesCollected >= this.rxDumpSamplesTarget) {
      void this.flushRxDump();
    }
  }

  private async flushRxDump(): Promise<void> {
    if (!this.rxDumpActive) {
      return;
    }
    this.rxDumpActive = false;

    if (this.rxDumpFlushTimer) {
      clearTimeout(this.rxDumpFlushTimer);
      this.rxDumpFlushTimer = undefined;
    }

    const pcmBuffer = Buffer.concat(this.rxDumpBuffers);
    this.rxDumpBuffers = [];

    if (pcmBuffer.length === 0) {
      return;
    }

    const dir = resolveDebugDir();
    const filePath = path.join(
      dir,
      `rx_after_playback_${this.callControlId}_${Date.now()}.wav`,
    );

    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const wav = encodePcm16Wav(pcmBuffer, this.rxSampleRateHz);
      await fs.promises.writeFile(filePath, wav);
      log.info(
        {
          event: 'stt_debug_rx_wav_written',
          file_path: filePath,
          sample_rate_hz: this.rxSampleRateHz,
          bytes: wav.length,
          ...this.logContext,
        },
        'stt debug rx wav written',
      );
    } catch (error) {
      log.warn(
        { err: error, file_path: filePath, ...this.logContext },
        'stt debug rx wav write failed',
      );
    }
  }

  private async handleDeadAirTimeout(): Promise<void> {
    if (!this.active || this.state !== 'LISTENING' || this.repromptInFlight) {
      return;
    }

    // If STT is running / request in flight, don't reprompt.
    // (Stronger than isHandlingTranscript. Keep both if you want.)
    if (this.sttInFlightCount && this.sttInFlightCount > 0) {
      this.scheduleDeadAirTimer();
      return;
    }

    if (this.isHandlingTranscript) {
      this.scheduleDeadAirTimer();
      return;
    }

    const now = Date.now();

        log.info(
      {
        event: 'dead_air_check',
        now,
        state: this.state,
        listening_since_ms: this.listeningSinceAtMs,
        last_inbound_media_ms: this.lastInboundMediaAtMs,
        last_decoded_frame_ms: this.lastDecodedFrameAtMs,
        stt_in_flight: this.sttInFlightCount,
        is_handling_transcript: this.isHandlingTranscript,
        playback_active: this.isPlaybackActive(),
        dead_air_ms: this.deadAirMs,
        dead_air_no_frames_ms: this.deadAirNoFramesMs,
        ...this.logContext,
      },
      'dead air check',
    );


    // 1) Grace right after we enter LISTENING
    if (this.listeningSinceAtMs > 0 && now - this.listeningSinceAtMs < this.deadAirListeningGraceMs) {
      this.scheduleDeadAirTimer();
      return;
    }

    // 2) Grace after speech start (STT might be behind)
    if (this.lastSpeechStartAtMs > 0 && now - this.lastSpeechStartAtMs < this.deadAirAfterSpeechStartGraceMs) {
      this.scheduleDeadAirTimer();
      return;
    }

    // 3) If we recently received inbound media, don't reprompt
    if (this.lastInboundMediaAtMs > 0 && now - this.lastInboundMediaAtMs < this.deadAirNoFramesMs) {
      this.scheduleDeadAirTimer();
      return;
    }

    // 3b) If we have NOT received inbound media since entering LISTENING, never reprompt yet
    if (
      this.listeningSinceAtMs > 0 &&
      (this.lastInboundMediaAtMs === 0 || this.lastInboundMediaAtMs < this.listeningSinceAtMs)
    ) {
      this.scheduleDeadAirTimer();
      return;
    }


    // 4) Never reprompt during playback/tts
    if (this.isPlaybackActive()) {
      this.scheduleDeadAirTimer();
      return;
    }

    this.repromptInFlight = true;
    try {
      await this.playText('Are you still there?', `reprompt-${this.nextTurnId()}`);
      log.info({ event: 'call_session_reprompt', ...this.logContext }, 'dead air reprompt');
    }finally {
      this.repromptInFlight = false;
      if (this.state === 'LISTENING') {
        this.listeningSinceAtMs = Date.now(); // ✅ reset grace window baseline
        this.scheduleDeadAirTimer();
      }
    }
  }



  private async handleTranscript(
    text: string,
    transcriptSource?: 'partial_fallback' | 'final',
  ): Promise<void> {
    const now = Date.now();
    const isFinal = transcriptSource === 'final';

    // Allow FINAL transcript briefly after hangup if grace window is armed.
    // NOTE: This is capture-only; we do NOT respond or play audio.
    const allowLateFinalCapture =
      !this.active &&
      isFinal &&
      this.lateFinalGraceUntilMs > 0 &&
      now <= this.lateFinalGraceUntilMs;

    if (!this.active || this.state === 'ENDED' || this.isHandlingTranscript || this.audioCoordinator.isEnding()) {
      if (allowLateFinalCapture) {
        this.captureLateFinalTranscript(text);

        // After we capture one, close the window to avoid multiple finals.
        this.lateFinalGraceUntilMs = 0;
        return;
      }

      const reason = !this.active
        ? 'inactive'
        : this.state === 'ENDED'
          ? 'ended'
          : this.audioCoordinator.isEnding()
            ? 'ending'
            : 'already_handling';

      log.info(
        {
          event: 'transcript_ignored',
          reason,
          transcript_length: text.length,
          transcript_source: transcriptSource ?? 'unknown',
          ...this.logContext,
        },
        'transcript ignored',
      );
      return;
    }


    const trimmed = text.trim();
    if (trimmed === '') {
      log.info(
        {
          event: 'transcript_ignored_empty',
          transcript_length: text.length,
          transcript_source: transcriptSource ?? 'unknown',
          ...this.logContext,
        },
        'transcript ignored (empty)',
      );
      return;
    }

    const isPartial = transcriptSource === 'partial_fallback';
    const trigger = isPartial ? 'partial' : 'final';

    // If we've already accepted a transcript for this utterance, ignore anything else.
    if (this.transcriptAcceptedForUtterance) {
      log.info(
        {
          event: 'transcript_ignored_duplicate',
          transcript_length: trimmed.length,
          transcript_source: transcriptSource ?? 'unknown',
          ...this.logContext,
        },
        'transcript ignored (duplicate)',
      );
      return;
    }

    // ===== CHANGE #1 (CORE FIX): partials DO NOT trigger a turn =====
    // We only buffer partials for debugging/visibility. The agent reply + TTS is final-only.
    if (isPartial) {
      if (!this.firstPartialAt) {
        this.firstPartialAt = Date.now();
      }

      // Keep the latest partial around (useful for debugging and optional future fallback logic)
      this.deferredTranscript = { text: trimmed, source: 'partial_fallback' };

      const partialPreview =
        trimmed.length <= this.logPreviewChars
          ? trimmed
          : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;

      log.info(
        {
          event: 'partial_buffered_no_turn',
          trigger: 'partial',
          transcript_length: trimmed.length,
          transcript_preview: partialPreview,
          state: this.state,
          ...this.logContext,
        },
        'partial buffered (final-only turn policy)',
      );

      // IMPORTANT: do not set transcriptAcceptedForUtterance here.
      return;
    }

    // ===== From here on: FINAL ONLY =====

    // If playback is active and not interrupted, defer the FINAL until playback ends.
    const playbackActive = this.isPlaybackActive();
    if (playbackActive && !this.playbackState.interrupted) {
      this.deferredTranscript = { text: trimmed, source: 'final' };

      log.info(
        {
          event: 'transcript_deferred_playback',
          trigger: 'final',
          transcript_length: trimmed.length,
          state: this.state,
          playback_active: this.playbackState.active,
          tts_queue_depth: this.ttsSegmentQueueDepth,
          ...this.logContext,
        },
        'final transcript deferred during playback',
      );
      return;
    }

    const tenantLabel = this.tenantId ?? 'unknown';
    const responseStartAt = Date.now();

    // timing metric: if we had partials, measure partial->response
    if (this.firstPartialAt) {
      observeStageDuration(
        'stt_first_partial_to_response_ms',
        tenantLabel,
        responseStartAt - this.firstPartialAt,
      );
    } else {
      observeStageDuration('stt_final_to_response_ms', tenantLabel, 0);
    }

    log.info(
      {
        event: 'turn_trigger',
        trigger: 'final',
        transcript_length: trimmed.length,
        ...this.logContext,
      },
      'turn trigger',
    );

    // ─── Gibberish guard: reject low-quality / hallucinated STT output ───
    const gibberishCheck = detectGibberish(trimmed);
    if (gibberishCheck.gibberish && this.gibberishRetryCount < this.gibberishMaxRetries) {
      this.gibberishRetryCount += 1;
      log.warn(
        {
          event: 'transcript_rejected_gibberish',
          reason: gibberishCheck.reason,
          retry: this.gibberishRetryCount,
          max_retries: this.gibberishMaxRetries,
          transcript_preview: trimmed.slice(0, 80),
          ...this.logContext,
        },
        'transcript rejected as gibberish — prompting caller to repeat',
      );

      // Play a reprompt and return to listening
      const turnId = `clarify-${this.nextTurnId()}`;
      this.isHandlingTranscript = true;
      try {
        await this.playText(
          "Sorry, I didn't quite catch that. Could you please say that again?",
          turnId,
        );
      } finally {
        this.isHandlingTranscript = false;
        this.resetTranscriptTracking();
        if (this.active && this.state !== ('ENDED' as CallSessionState)) {
          if (!this.isPlaybackActive() && this.state !== 'LISTENING') {
            this.enterListeningState(true);
          }
        }
      }
      return;
    }

    // Reset gibberish counter on a good transcript
    if (!gibberishCheck.gibberish) {
      this.gibberishRetryCount = 0;
    }

    // Accept this FINAL as the utterance we will respond to.
    this.transcriptAcceptedForUtterance = true;
    this.isHandlingTranscript = true;
    this.audioCoordinator.onRespondingStart(Date.now());
    const handlingToken = (this.transcriptHandlingToken += 1);
    this.clearDeadAirTimer();
    // ✅ If we were capturing post-playback RX audio, force-write it now.
    // This guarantees we get an rx_after_playback_*.wav even on short turns.
    if (this.rxDumpActive && this.rxDumpSamplesCollected > 0) {
      await this.flushRxDump();
    }


    try {
      const transcriptPreview =
        trimmed.length <= this.logPreviewChars
          ? trimmed
          : `${trimmed.slice(0, this.logPreviewChars - 3)}...`;

      log.info(
        {
          event: 'transcript_received',
          transcript_length: trimmed.length,
          transcript_preview: transcriptPreview,
          ...this.logContext,
        },
        'final transcript received',
      );

      this.state = 'THINKING';
      this.appendTranscriptSegment(trimmed);
      this.appendHistory({ role: 'user', content: trimmed, timestamp: new Date() });

      // Report caller message to control plane analytics (fire-and-forget)
      void reportCallerMessage(this.tenantId ?? 'unknown', trimmed);

      let response = '';
      let replySource = 'unknown';
      let playbackDone: Promise<void> | undefined;
      let replyResult: AssistantReplyResult | undefined;

      try {
        if (env.BRAIN_STREAMING_ENABLED) {
          const streamResult = await this.streamAssistantReply(trimmed, handlingToken);
          replyResult = streamResult.reply;
          response = streamResult.reply.text;
          replySource = streamResult.reply.source;
          playbackDone = streamResult.playbackDone;
        } else {
          const endLlm = startStageTimer('llm', tenantLabel);
          try {
            const reply = await generateAssistantReply({
              tenantId: this.tenantId,
              callControlId: this.callControlId,
              transcript: trimmed,
              history: this.conversationHistory,
              transferProfiles: this.transferProfiles,
              assistantContext: this.assistantContext,
            });
            endLlm();
            replyResult = reply;
            response = reply.text;
            replySource = reply.source;
          } catch (error) {
            incStageError('llm', tenantLabel);
            endLlm();
            throw error;
          }
        }
      } catch (error) {
        response = 'Acknowledged.';
        replySource = 'fallback_error';
        log.error(
          { err: error, assistant_reply_source: replySource, ...this.logContext },
          'assistant reply generation failed',
        );
      }

      if (handlingToken !== this.transcriptHandlingToken) {
        return;
      }

      markAudioSpan('llm_result', {
        callId: this.callControlId,
        tenantId: this.tenantId,
        logContext: this.logContext,
      });

      const replyPreview =
        response.length <= this.logPreviewChars
          ? response
          : `${response.slice(0, this.logPreviewChars - 3)}...`;

      log.info(
        {
          event: 'assistant_reply_generated',
          assistant_reply_length: response.length,
          assistant_reply_source: replySource,
          assistant_reply_preview: replyPreview,
          ...this.logContext,
        },
        'assistant reply generated',
      );

      log.info(
        {
          event: 'assistant_reply_text',
          assistant_reply_text: replyPreview,
          assistant_reply_length: response.length,
          assistant_reply_source: replySource,
          ...this.logContext,
        },
        'assistant reply text',
      );

      if (handlingToken !== this.transcriptHandlingToken) {
        return;
      }

      // Apply voice directive from brain (hot-swap voice mode)
      if (replyResult?.voiceDirective) {
        log.info(
          {
            event: 'brain_voice_directive_received',
            directive_mode: replyResult.voiceDirective.mode,
            has_speaker_wav_url: !!replyResult.voiceDirective.speakerWavUrl,
            ...this.logContext,
          },
          'brain voice directive received',
        );
        this.setVoiceMode(
          replyResult.voiceDirective.mode,
          replyResult.voiceDirective.speakerWavUrl,
        );
      }

      // AI requested transfer: play reply text then transfer the call.
      if (replyResult?.transfer?.to) {
        this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
        if (env.BRAIN_STREAMING_ENABLED && playbackDone) {
          await playbackDone;
        } else {
          await this.playAssistantTurn(response);
        }
        try {
          await this.transferCall(replyResult.transfer.to, {
            audioUrl: replyResult.transfer.audioUrl,
            timeoutSecs: replyResult.transfer.timeoutSecs,
          });
          log.info(
            { event: 'ai_transfer_completed', to: replyResult.transfer.to, ...this.logContext },
            'AI requested transfer completed',
          );
        } catch (error) {
          log.error(
            { err: error, to: replyResult.transfer.to, ...this.logContext },
            'AI transfer failed',
          );
          await this.playAssistantTurn(
            "I wasn't able to complete the transfer. Please try again or stay on the line.",
          );
        }
        return;
      }

      // AI requested hangup: play goodbye then end the call.
      if (replyResult?.hangup) {
        this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });
        if (env.BRAIN_STREAMING_ENABLED && playbackDone) {
          await playbackDone;
        } else {
          await this.playAssistantTurn(response);
        }
        log.info(
          { event: 'ai_hangup_requested', ...this.logContext },
          'AI requested call hangup after goodbye',
        );
        this.markEnded('ai_goodbye');
        try {
          await this.transport.stop?.('ai_goodbye');
        } catch (error) {
          log.error({ err: error, ...this.logContext }, 'AI hangup failed');
        }
        return;
      }

      this.appendHistory({ role: 'assistant', content: response, timestamp: new Date() });

      if (env.BRAIN_STREAMING_ENABLED) {
        if (playbackDone) {
          await playbackDone;
        }
      } else {
        await this.playAssistantTurn(response);
      }
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call session transcript handling failed');
    } finally {
      if (handlingToken === this.transcriptHandlingToken) {
        // ✅ Reset utterance gating so next user turn isn't ignored
        this.resetTranscriptTracking();

        // reset handling flags and go back to listening
        this.isHandlingTranscript = false;
        if (this.active && this.state !== ('ENDED' as CallSessionState)) {
          // Only re-arm listening if we are NOT in playback and not already listening.
          if (!this.isPlaybackActive() && this.state !== 'LISTENING') {
            this.enterListeningState(true);
          } else if (this.state === 'LISTENING') {
            // If we're already listening, just ensure the timer can run.
            this.scheduleDeadAirTimer();
          }
          this.audioCoordinator.notifyListeningEligibilityChanged('transcript_complete');
        }
      }
    }
  }



  private async streamAssistantReply(
    transcript: string,
    handlingToken: number,
  ): Promise<{ reply: AssistantReplyResult; playbackDone?: Promise<void> }> {
    let bufferedText = '';
    let firstTokenAt: number | undefined;
    let speakCursor = 0;
    let firstSegmentQueued = false;
    let segmentIndex = 0;
    let queuedSegments = 0;
    let baseTurnId: string | undefined;
    const firstSegmentMin = env.BRAIN_STREAM_SEGMENT_MIN_CHARS;
    const nextSegmentMin = env.BRAIN_STREAM_SEGMENT_NEXT_CHARS;
    const firstAudioMaxMs = env.BRAIN_STREAM_FIRST_AUDIO_MAX_MS;

    // === PSTN streaming ===
    // Previously disabled for llama3.2:3b (unreliable streaming output).
    // Now re-enabled for qwen2.5:7b which streams reliably.
    // Set BRAIN_PSTN_NO_STREAM=true to force non-streaming on PSTN if needed.
    const forcePstnNoStream = process.env.BRAIN_PSTN_NO_STREAM === 'true';
    if (this.transport.mode === 'pstn' && forcePstnNoStream) {
      const tenantLabel = this.tenantId ?? 'unknown';
      const endLlm = startStageTimer('llm', tenantLabel);

      let reply: AssistantReplyResult;
      try {
        reply = await generateAssistantReply({
          tenantId: this.tenantId,
          callControlId: this.callControlId,
          transcript,
          history: this.conversationHistory,
          transferProfiles: this.transferProfiles,
          assistantContext: this.assistantContext,
        });
        endLlm();
      } catch (error) {
        incStageError('llm', tenantLabel);
        endLlm();
        throw error;
      }

      return { reply, playbackDone: this.playAssistantTurn(reply.text) };
    }

    const queueSegment = (segment: string): void => {

      if (handlingToken !== this.transcriptHandlingToken) return;

      const trimmed = segment.trim();
      if (!trimmed) return;

      const resolvedTurnId = baseTurnId ?? `turn-${this.nextTurnId()}`;
      baseTurnId = resolvedTurnId;

      segmentIndex += 1;
      queuedSegments += 1; // ✅ FIX: count queued segments

      const segmentId = `${resolvedTurnId}-${segmentIndex}`;
      this.queueTtsSegment(trimmed, segmentId, handlingToken);
    };


    const maybeQueueSegments = (force: boolean): void => {
      if (!this.active) {
        return;
      }

      while (true) {
        const pending = bufferedText.slice(speakCursor);
        if (!pending) {
          return;
        }

        if (!firstSegmentQueued) {
          const boundary = this.findSentenceBoundary(pending);
          if (boundary !== null) {
            queueSegment(pending.slice(0, boundary));
            speakCursor += boundary;
            firstSegmentQueued = true;
            continue;
          }

          if (pending.length >= firstSegmentMin) {
            const end = this.selectSegmentEnd(pending, firstSegmentMin);
            queueSegment(pending.slice(0, end));
            speakCursor += end;
            firstSegmentQueued = true;
            continue;
          }

          if (
            force ||
            (firstTokenAt && Date.now() - firstTokenAt >= firstAudioMaxMs)
          ) {
            queueSegment(pending);
            speakCursor += pending.length;
            firstSegmentQueued = true;
            continue;
          }

          return;
        }

        const boundary = this.findSentenceBoundary(pending);
        if (boundary !== null) {
          queueSegment(pending.slice(0, boundary));
          speakCursor += boundary;
          continue;
        }

        if (pending.length >= nextSegmentMin) {
          const end = this.selectSegmentEnd(pending, nextSegmentMin);
          queueSegment(pending.slice(0, end));
          speakCursor += end;
          continue;
        }

        if (force) {
          queueSegment(pending);
          speakCursor += pending.length;
        }
        return;
      }
    };

    const tenantLabel = this.tenantId ?? 'unknown';
    const endLlm = startStageTimer('llm', tenantLabel);

    let reply: AssistantReplyResult;
    try {
      reply = await generateAssistantReplyStream(
        {
          tenantId: this.tenantId,
          callControlId: this.callControlId,
          transcript,
          history: this.conversationHistory,
          transferProfiles: this.transferProfiles,
          assistantContext: this.assistantContext,
        },
        (chunk) => {
          if (!chunk) return;
          if (!firstTokenAt) firstTokenAt = Date.now();
          bufferedText += chunk;
          maybeQueueSegments(false);
        },
      );
      endLlm();
    } catch (error) {
      incStageError('llm', tenantLabel);
      endLlm();
      throw error;
    }


    if (handlingToken !== this.transcriptHandlingToken) {
      return { reply };
    }

    if (reply.source !== 'brain_http_stream') {
      if (handlingToken !== this.transcriptHandlingToken) {
        return { reply };
      }
      return { reply, playbackDone: this.playAssistantTurn(reply.text) };
    }

    if (reply.text.length > bufferedText.length) {
      bufferedText = reply.text;
    }
    maybeQueueSegments(true);

    if (queuedSegments === 0) {
      if (handlingToken !== this.transcriptHandlingToken) {
        return { reply };
      }
      return { reply, playbackDone: this.playAssistantTurn(reply.text) };
    }

    return { reply, playbackDone: this.waitForTtsSegmentQueue() };
  }

  private async answerAndGreet(): Promise<void> {
    try {
      const answerStarted = Date.now();
      if (this.transport.mode === 'pstn' && this.shouldSkipTelnyxAction('answer')) {
        return;
      }
      await this.transport.start();
      const answerDuration = Date.now() - answerStarted;

      if (this.transport.mode === 'pstn') {
        log.info(
          { event: 'telnyx_answer_duration', duration_ms: answerDuration, ...this.logContext },
          'telnyx answer completed',
        );
      }
      log.info({ event: 'call_answered', ...this.logContext }, 'call answered');

      this.onAnswered();

      // Resolve greeting: tenant config > env > default
      const _resolvedGreeting = this._greetingText || env.GREETING_TEXT || 'Hi! Thanks for calling. How can I help you today?';

      if (this.transport.mode === 'webrtc_hd') {
        await this.playText(_resolvedGreeting, 'greeting');
        return;
      }

      const trimmedBaseUrl = env.AUDIO_PUBLIC_BASE_URL.replace(/\/$/, '');
      const greetingUrl = `${trimmedBaseUrl}/greeting.wav`;

      if (this.shouldSkipTelnyxAction('playback_start')) {
        return;
      }
      this.beginPlayback('greeting');
      try {
        const playbackStart = Date.now();
        this.audioCoordinator.onTtsStart(playbackStart, 'greeting_playback_start');
        await this.transport.playback.play({ kind: 'url', url: greetingUrl });
        // For PSTN, wait for Telnyx playback.ended webhook to end playback.
        if (this.transport.mode !== 'pstn') {
          this.onPlaybackEnded();
        }
      } catch (error) {
        if (this.transport.mode === 'pstn') {
          this.endPlaybackAuthoritatively('watchdog');
        } else {
          this.onPlaybackEnded();
        }
        // Fallback: greeting.wav may be missing (XTTS down at startup). Use live TTS.
        log.warn({ err: error, ...this.logContext }, 'greeting URL playback failed, using live TTS');
        await this.playText(_resolvedGreeting, 'greeting');
        return;
      }

      log.info(
        { event: 'call_playback_started', audio_url: greetingUrl, ...this.logContext },
        'playback started',
      );
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call start greeting failed');
    }
  }

  private async playAssistantTurn(text: string): Promise<void> {
    const turnId = `turn-${this.nextTurnId()}`;
    await this.playText(text, turnId);
  }

  private async playText(
    text: string,
    turnId: string,
    options?: { allowWhenEndedForLateFinal?: boolean },
  ): Promise<void> {
    const allowWhenEnded = options?.allowWhenEndedForLateFinal === true;
    if (!allowWhenEnded && (!this.active || this.state === 'ENDED')) {
      return;
    }

    this.beginPlayback(turnId);
    let playbackEndDeferred = false;
    let playbackEndHandled = false;

    try {
      const tenantLabel = this.tenantId ?? 'unknown';
      const endTts = startStageTimer('tts', tenantLabel);

      const spanMeta = {
        callId: this.callControlId,
        tenantId: this.tenantId,
        logContext: { ...this.logContext, tts_id: turnId },
        kind: turnId,
      };
      markAudioSpan('tts_start', spanMeta);
      const ttsStart = Date.now();
      let result: TTSResult;
      try {
        const currentSpeakerWavUrl = this.getCurrentSpeakerWavUrl();
        result = await synthesizeSpeech(
          {
            text,
            voice: this.ttsConfig?.voice,
            format: this.ttsConfig?.format,
            sampleRate: this.ttsConfig?.sampleRate,
            speakerWavUrl: currentSpeakerWavUrl,
          },
          this.ttsConfig,
        );
        if (currentSpeakerWavUrl) {
          log.info(
            {
              event: 'tts_voice_cloning_used',
              voice_mode: this.currentVoiceMode,
              turn_id: turnId,
              ...this.logContext,
            },
            'TTS using cloned voice',
          );
        }
      } catch (error) {
        incStageError('tts', tenantLabel);
        throw error;
      } finally {
        endTts();
      }

      const ttsDuration = Date.now() - ttsStart;
      markAudioSpan('tts_ready', spanMeta);

      log.info(
        {
          event: 'tts_synthesized',
          duration_ms: ttsDuration,
          audio_bytes: result.audio.length,
          ...this.logContext,
        },
        'tts synthesized',
      );

      if (!options?.allowWhenEndedForLateFinal && (!this.active || this.playbackState.interrupted)) {
        return;
      }

      this.logTtsBytesReady(turnId, result.audio, result.contentType);
      let playbackAudio = result.audio;
      const applyPstnPipeline = env.PLAYBACK_PROFILE === 'pstn' && this.transport.mode === 'pstn';
      if (applyPstnPipeline) {
        const endPipeline = startStageTimer('tts_pipeline_ms', tenantLabel);
        const pipelineResult = runPlaybackPipeline(playbackAudio, {
          targetSampleRateHz: env.PLAYBACK_PSTN_SAMPLE_RATE,
          enableHighpass: env.PLAYBACK_ENABLE_HIGHPASS,
          logContext: this.logContext,
        });
        endPipeline();
        playbackAudio = pipelineResult.audio;
      }
      if (applyPstnPipeline) {
        this.logWavInfo('pipeline_output', turnId, playbackAudio);
        const pipelineMeta = getAudioMeta(playbackAudio) ?? {
          format: 'wav' as const,
          logContext: { ...this.logContext, tts_id: turnId },
          lineage: ['pipeline:unknown'],
        };
        probeWav('tts.out.telephonyOptimized', playbackAudio, pipelineMeta);
      }
      result.audio = playbackAudio;

      const playbackInput =
        this.transport.mode === 'pstn'
          ? { kind: 'url' as const, url: await storeWav(this.callControlId, turnId, result.audio) }
          : { kind: 'buffer' as const, audio: result.audio, contentType: result.contentType };

      if (this.playbackState.interrupted) {
        return;
      }

      if (this.transport.mode === 'pstn' && this.shouldSkipTelnyxAction('playback_start')) {
        this.endPlaybackAuthoritatively('watchdog');
        playbackEndHandled = true;
        return;
      }

      // Tier 2: set segment duration for measured listen-after-playback grace
      try {
        const wavInfo = parseWavInfo(playbackAudio);
        this.playbackState.segmentDurationMs = wavInfo.durationMs;
      } catch {
        this.playbackState.segmentDurationMs = undefined;
      }

      // Tier 3: push far-end reference for AEC (decode WAV → 16k frames)
      pushFarEndFrames(this.callControlId, playbackAudio, this.logContext);

      log.info(
        {
          event: 'tts_playback_start',
          turn_id: turnId,
          playback_mode: this.transport.mode,
          audio_url:
            this.transport.mode === 'pstn'
              ? (playbackInput as { kind: 'url'; url: string }).url
              : undefined,
          audio_bytes: this.transport.mode === 'pstn' ? undefined : playbackAudio.length,
          ...this.logContext,
        },
        'tts playback start',
      );

      const playbackStage = this.transport.mode === 'pstn' ? 'telnyx_playback' : 'webrtc_playback_ms';
      const endPlayback = startStageTimer(playbackStage, tenantLabel);

      const playbackStart = Date.now();
      this.audioCoordinator.onTtsStart(playbackStart, 'tts_playback_start');
      try {
        if (this.transport.mode === 'pstn') {
          const txMeta = getAudioMeta(playbackAudio) ?? {
            format: 'wav' as const,
            logContext: { ...this.logContext, tts_id: turnId },
            lineage: ['tx:unknown'],
          };
          probeWav('tx.telnyx.payload', playbackAudio, { ...txMeta, kind: turnId });
        }

        markAudioSpan('tx_sent', spanMeta);
        await this.transport.playback.play(playbackInput);

        if (this.transport.mode === 'pstn') {
          // PSTN playback ends on Telnyx webhook.
          playbackEndDeferred = true;
        } else {
          // ✅ always clear playback state when playback completes (single-turn playback)
          this.onPlaybackEnded();
          playbackEndHandled = true;
        }
      } catch (error) {
        incStageError(playbackStage, tenantLabel);

        // ✅ also clear playback state if playback throws
        if (!playbackEndHandled) {
          if (this.transport.mode === 'pstn') {
            this.endPlaybackAuthoritatively('watchdog');
          } else {
            this.onPlaybackEnded();
          }
          playbackEndHandled = true;
        }


        throw error;
      } finally {
        endPlayback();
      }


      const playbackDuration = Date.now() - playbackStart;



      if (this.transport.mode === 'pstn') {
        log.info(
          {
            event: 'telnyx_playback_duration',
            duration_ms: playbackDuration,
            audio_url: (playbackInput as { kind: 'url'; url: string }).url,
            ...this.logContext,
          },
          'telnyx playback completed',
        );
      }
    } catch (error) {
      log.error({ err: error, ...this.logContext }, 'call session tts playback failed');
    } finally {
      // ✅ Do NOT force LISTENING here.
      // onPlaybackEnded() is the single source of truth for clearing playback + entering LISTENING.
      // But if we returned early (e.g. interrupted) and somehow stayed SPEAKING/active, clean up.
      if (!playbackEndHandled && !playbackEndDeferred && (this.playbackState.active || this.state === 'SPEAKING')) {
        if (this.transport.mode === 'pstn') {
          this.endPlaybackAuthoritatively('watchdog');
        } else {
          this.onPlaybackEnded();
        }
      }
    }
  }


  private queueTtsSegment(segmentText: string, segmentId: string, handlingToken?: number): void {
    if (!segmentText.trim()) {
      return;
    }
    if (!this.active || this.state === 'ENDED') {
      return;
    }
    if (handlingToken !== undefined && handlingToken !== this.transcriptHandlingToken) {
      return;
    }

    if (!this.playbackState.active) {
      this.beginPlayback(segmentId);
    }
    this.ttsSegmentQueueDepth += 1;
    const queueDepth = this.ttsSegmentQueueDepth;

    log.info(
      {
        event: 'tts_segment_queued',
        seg_len: segmentText.length,
        queue_depth: queueDepth,
        segment_id: segmentId,
        ...this.logContext,
      },
      'tts segment queued',
    );

    this.ttsSegmentChain = this.ttsSegmentChain
      .then(async () => {
        await this.playTtsSegment(segmentText, segmentId);
      })
      .catch((error) => {
        log.error({ err: error, ...this.logContext }, 'tts segment playback failed');
      })
      .finally(() => {
        this.ttsSegmentQueueDepth = Math.max(0, this.ttsSegmentQueueDepth - 1);

        // ✅ Playback ends ONCE when all queued segments are done
        if (this.ttsSegmentQueueDepth === 0) {
          if (this.transport.mode === 'pstn') {
            // PSTN: use authoritative path so playback state is properly cleared
            this.endPlaybackAuthoritatively('webhook');
          } else {
            this.onPlaybackEnded();
          }
        }
      });
  }

  private async playTtsSegment(segmentText: string, segmentId: string): Promise<void> {
    const shouldAbort = !this.active || this.state === 'ENDED' || this.playbackState.interrupted;
    if (shouldAbort) {
      return;
    }

    const tenantLabel = this.tenantId ?? 'unknown';
    const endTts = startStageTimer('tts', tenantLabel);

    const spanMeta = {
      callId: this.callControlId,
      tenantId: this.tenantId,
      logContext: { ...this.logContext, tts_id: segmentId },
      kind: segmentId,
    };
    markAudioSpan('tts_start', spanMeta);
    const ttsStart = Date.now();
    let result: TTSResult;
    try {
      const currentSpeakerWavUrl = this.getCurrentSpeakerWavUrl();
      result = await synthesizeSpeech(
        {
          text: segmentText,
          voice: this.ttsConfig?.voice,
          format: this.ttsConfig?.format,
          sampleRate: this.ttsConfig?.sampleRate,
          speakerWavUrl: currentSpeakerWavUrl,
        },
        this.ttsConfig,
      );
      if (currentSpeakerWavUrl) {
        log.info(
          {
            event: 'tts_voice_cloning_used',
            voice_mode: this.currentVoiceMode,
            segment_id: segmentId,
            ...this.logContext,
          },
          'TTS segment using cloned voice',
        );
      }
    } catch (error) {
      incStageError('tts', tenantLabel);
      throw error;
    } finally {
      endTts();
    }
    const ttsDuration = Date.now() - ttsStart;
    markAudioSpan('tts_ready', spanMeta);


    log.info(
      {
        event: 'tts_synthesized',
        duration_ms: ttsDuration,
        audio_bytes: result.audio.length,
        ...this.logContext,
      },
      'tts synthesized',
    );

    if (!this.active || this.state === 'ENDED' || this.playbackState.interrupted) {
      return;
    }

    this.logTtsBytesReady(segmentId, result.audio, result.contentType);
    let playbackAudio = result.audio;
    const applyPstnPipeline = env.PLAYBACK_PROFILE === 'pstn' && this.transport.mode === 'pstn';
    if (applyPstnPipeline) {
      const endPipeline = startStageTimer('tts_pipeline_ms', tenantLabel);
      const pipelineResult = runPlaybackPipeline(playbackAudio, {
        targetSampleRateHz: env.PLAYBACK_PSTN_SAMPLE_RATE,
        enableHighpass: env.PLAYBACK_ENABLE_HIGHPASS,
        logContext: this.logContext,
      });
      endPipeline();
      playbackAudio = pipelineResult.audio;
    }
    if (applyPstnPipeline) {
      this.logWavInfo('pipeline_output', segmentId, playbackAudio);
      const pipelineMeta = getAudioMeta(playbackAudio) ?? {
        format: 'wav' as const,
        logContext: { ...this.logContext, tts_id: segmentId },
        lineage: ['pipeline:unknown'],
      };
      probeWav('tts.out.telephonyOptimized', playbackAudio, pipelineMeta);
    }
    result.audio = playbackAudio;

    const playbackInput =
      this.transport.mode === 'pstn'
        ? { kind: 'url' as const, url: await storeWav(this.callControlId, segmentId, result.audio) }
        : { kind: 'buffer' as const, audio: result.audio, contentType: result.contentType };

    if (this.playbackState.interrupted) {
      return;
    }

    if (this.transport.mode === 'pstn') {
      log.info(
        {
          event: 'tts_segment_play_start',
          seg_len: segmentText.length,
          segment_id: segmentId,
          audio_url: (playbackInput as { kind: 'url'; url: string }).url,
          ...this.logContext,
        },
        'tts segment playback start',
      );
    }

    // Tier 2: set segment duration for measured listen-after-playback grace
    try {
      const wavInfo = parseWavInfo(playbackAudio);
      this.playbackState.segmentDurationMs = wavInfo.durationMs;
    } catch {
      this.playbackState.segmentDurationMs = undefined;
    }

    // Tier 3: push far-end reference for AEC (decode WAV → 16k frames)
    pushFarEndFrames(this.callControlId, playbackAudio, this.logContext);

    const playbackStage = this.transport.mode === 'pstn'
      ? 'telnyx_playback'
      : 'webrtc_playback_ms';
    const endPlayback = startStageTimer(playbackStage, tenantLabel);

    const playbackStart = Date.now();
    this.audioCoordinator.onTtsStart(playbackStart, 'tts_segment_playback_start');
    try {
      if (this.transport.mode === 'pstn') {
        const txMeta = getAudioMeta(playbackAudio) ?? {
          format: 'wav' as const,
          logContext: { ...this.logContext, tts_id: segmentId },
          lineage: ['tx:unknown'],
        };
        probeWav('tx.telnyx.payload', playbackAudio, { ...txMeta, kind: segmentId });
      }

      markAudioSpan('tx_sent', spanMeta);
      await this.transport.playback.play(playbackInput);

      // For PSTN: wait for Telnyx playback.ended webhook before letting the next
      // segment in the chain start. This prevents audio overlap.
      if (this.transport.mode === 'pstn') {
        this.playbackState.segmentId = segmentId; // track for watchdog
        this.armPstnPlaybackWatchdog();
        await new Promise<void>((resolve) => {
          this.pstnSegmentResolve = resolve;
        });
      }

      // ✅ IMPORTANT: do NOT call onPlaybackEnded() here.
      // Streaming playback ends when the segment queue drains.
    } catch (error) {
      incStageError(playbackStage, tenantLabel);

      // If PSTN segment was awaiting webhook, clear it so the chain can proceed
      if (this.pstnSegmentResolve) {
        const resolve = this.pstnSegmentResolve;
        this.pstnSegmentResolve = null;
        resolve();
      }

      throw error;
    } finally {
      endPlayback();
    }


    const playbackDuration = Date.now() - playbackStart;



    if (this.transport.mode === 'pstn') {
      log.info(
        {
          event: 'tts_segment_play_end',
          seg_len: segmentText.length,
          segment_id: segmentId,
          duration_ms: playbackDuration,
          audio_url: (playbackInput as { kind: 'url'; url: string }).url,
          ...this.logContext,
        },
        'tts segment playback end',
      );
    }
  }

  private waitForTtsSegmentQueue(): Promise<void> {
    if (!this.playbackStopSignal) {
      return this.ttsSegmentChain;
    }
    return Promise.race([this.ttsSegmentChain, this.playbackStopSignal.promise]);
  }

  private findSentenceBoundary(text: string): number | null {
    const match = text.match(/[.!?](?=\s|$)/);
    if (!match || match.index === undefined) {
      return null;
    }
    return match.index + 1;
  }

  private selectSegmentEnd(text: string, targetChars: number): number {
    if (text.length <= targetChars) {
      return text.length;
    }
    const slice = text.slice(0, targetChars);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= Math.floor(targetChars * 0.6)) {
      return lastSpace;
    }
    return targetChars;
  }

  private nextTurnId(): number {
    this.turnSequence += 1;
    return this.turnSequence;
  }

  private shouldSkipTelnyxAction(action: string): boolean {
    if (this.transport.mode !== 'pstn') {
      return false;
    }
    if (this.active) {
      return false;
    }
    // Allow playback_start when we're trying to play a response to a late-final transcript.
    if (this.isRespondingToLateFinal && action === 'playback_start') {
      return false;
    }

    const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
    log.warn(
      { event, action, ...this.logContext },
      'skipping telnyx action - call inactive',
    );
    return true;
  }
}

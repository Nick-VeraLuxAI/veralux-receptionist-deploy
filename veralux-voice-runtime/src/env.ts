// src/env.ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ───────────────────────── helpers ─────────────────────────

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const stringToBoolean = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return undefined;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
};

const numberFromEnv = (value: unknown): unknown => {
  // prevent z.coerce.number from treating booleans as 1/0
  if (typeof value === 'boolean') return NaN;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;

    // prevent 'true'/'false' from becoming NaN later in confusing ways
    const normalized = trimmed.toLowerCase();
    if (normalized === 'true' || normalized === 'false') return NaN;

    return trimmed; // allow z.coerce.number to do the conversion
  }

  return value;
};

// Back-compat: STT_RMS_THRESHOLD → STT_SPEECH_RMS_FLOOR
const sttRmsFloorFallback = (value: unknown): unknown => {
  const normalized = emptyToUndefined(value);
  if (normalized !== undefined) return normalized;
  return emptyToUndefined(process.env.STT_RMS_THRESHOLD);
};

// ✅ Back-compat / aliasing for frames-required
// Prefer the actual knob: STT_SPEECH_FRAMES_REQUIRED
// Allow legacy: STT_FRAMES_REQUIRED
const sttFramesRequiredFallback = (value: unknown): unknown => {
  const normalized = numberFromEnv(value);
  if (normalized !== undefined) return normalized;

  const fromSpeech = numberFromEnv(process.env.STT_SPEECH_FRAMES_REQUIRED);
  if (fromSpeech !== undefined) return fromSpeech;

  return numberFromEnv(process.env.STT_FRAMES_REQUIRED);
};

// ✅ Make STT_SILENCE_END_MS default to STT_SILENCE_MS when not set
// (So your CLI `STT_SILENCE_MS=900` actually drives endpointing if END_MS is missing.)
const sttSilenceEndFallback = (value: unknown): unknown => {
  const normalized = numberFromEnv(value);
  if (normalized !== undefined) return normalized;

  const fromEnd = numberFromEnv(process.env.STT_SILENCE_END_MS);
  if (fromEnd !== undefined) return fromEnd;

  return numberFromEnv(process.env.STT_SILENCE_MS);
};

// Back-compat: KOKORO_SAMPLE_RATE → TTS_SAMPLE_RATE
const ttsSampleRateFallback = (value: unknown): unknown => {
  const normalized = emptyToUndefined(value);
  if (normalized !== undefined) return normalized;
  return emptyToUndefined(process.env.KOKORO_SAMPLE_RATE);
};

// ───────────────────────── schema ─────────────────────────

const EnvSchema = z.object({
  /* ───────────────────────── Core ───────────────────────── */
  PORT: z.coerce.number().int().positive(),
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default('development')),
  TRANSPORT_MODE: z.preprocess(emptyToUndefined, z.enum(['pstn', 'webrtc_hd']).default('pstn')),
  WEBRTC_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  WEBRTC_ALLOWED_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),
  AUDIO_DIAGNOSTICS: z.preprocess(stringToBoolean, z.boolean().default(false)),

  /* ───────────────────────── Telnyx ───────────────────────── */
  TELNYX_API_KEY: z.string().min(1),
  TELNYX_PUBLIC_KEY: z.string().min(1),
  TELNYX_STREAM_TRACK: z.enum(['inbound_track', 'outbound_track', 'both_tracks']).default('inbound_track'),
  TELNYX_STREAM_CODEC: z.preprocess(emptyToUndefined, z.string().optional()),
  TELNYX_SKIP_SIGNATURE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  TELNYX_ACCEPT_CODECS: z.preprocess(emptyToUndefined, z.string().default('PCMU')),
  TELNYX_STREAM_RESTART_MAX: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(1)),
  TELNYX_INGEST_HEALTH_GRACE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(1200)),
  TELNYX_INGEST_HEALTH_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  TELNYX_INGEST_HEALTH_RESTART_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  TELNYX_INGEST_POST_PLAYBACK_GRACE_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(1200),
  ),
  TELNYX_INGEST_MIN_AUDIO_MS_SINCE_PLAYBACK_END: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(2000),
  ),
  TELNYX_AMRWB_MIN_DECODED_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(320)),
  TELNYX_INGEST_DECODE_FAILURES_BEFORE_FALLBACK: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(3),
  ),
  TELNYX_TARGET_SAMPLE_RATE: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(16000)),
  TELNYX_OPUS_DECODE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  TELNYX_G722_DECODE: z.preprocess(stringToBoolean, z.boolean().default(false)),
  TELNYX_AMRWB_DECODE: z.preprocess(stringToBoolean, z.boolean().default(false)),

  PUBLIC_BASE_URL: z.string().min(1),
  AUDIO_PUBLIC_BASE_URL: z.string().min(1),

  /* ───────────────────────── Media / Storage ───────────────────────── */
  MEDIA_STREAM_TOKEN: z.string().min(1),
  AUDIO_STORAGE_DIR: z.string().min(1),

  /* ───────────────────────── STT (Whisper) ───────────────────────── */
  WHISPER_URL: z.string().min(1),
  /** Language hint for Whisper (e.g. "en"). Improves accuracy when set. */
  STT_LANGUAGE: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** Optional text to bias Whisper decoding (e.g. "What time do you close. When do you close."). Sent as query param if your server supports it. */
  STT_WHISPER_PROMPT: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  ALLOW_HTTP_WAV_JSON: z.preprocess(stringToBoolean, z.boolean().default(false)),

  STT_CHUNK_MS: z.coerce.number().int().positive(),
  STT_SILENCE_MS: z.coerce.number().int().positive(),

  STT_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.6)),
  STT_SILENCE_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.45)),

  /* Endpointing + gating (used by chunkedSTT.ts) */
  // ✅ default to STT_SILENCE_MS via preprocess fallback
  STT_SILENCE_END_MS: z.preprocess(sttSilenceEndFallback, z.coerce.number().int().positive().default(700)),
  STT_PRE_ROLL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1200)),
  STT_MIN_UTTERANCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(400)),
  STT_MAX_UTTERANCE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(6000)),

  /* Final utterance trimming */
  FINAL_TAIL_CUSHION_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(120)),
  FINAL_MIN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1.0)),
  FINAL_MIN_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),

  /* Speech detection thresholds */
  STT_RMS_FLOOR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.015)),
  STT_PEAK_FLOOR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.05)),
  STT_DISABLE_GATES: z.preprocess(stringToBoolean, z.boolean().default(false)),

  STT_SPEECH_RMS_FLOOR: z.preprocess(sttRmsFloorFallback, z.coerce.number().positive().default(0.03)),
  STT_SPEECH_PEAK_FLOOR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.05)),
  STT_SPEECH_FRAMES_REQUIRED: z.preprocess(
    sttFramesRequiredFallback,
    z.coerce.number().int().positive().optional(),
  ),

  /* Partial transcription */
  STT_PARTIAL_INTERVAL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(250)),
  STT_PARTIAL_MIN_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(600)),

  /* STT input DSP */
  STT_HIGHPASS_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  STT_HIGHPASS_CUTOFF_HZ: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(100)),

  /* Tier 2: measured listen-after-playback grace (300–900ms based on segment length) */
  STT_POST_PLAYBACK_GRACE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  STT_POST_PLAYBACK_GRACE_MIN_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(300)),
  STT_POST_PLAYBACK_GRACE_MAX_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(900)),

  /* STT debug dumps */
  STT_DEBUG_DUMP_WHISPER_WAVS: z.preprocess(stringToBoolean, z.boolean().default(false)),
  STT_DEBUG_DUMP_PCM16: z.preprocess(stringToBoolean, z.boolean().default(false)),
  STT_DEBUG_DUMP_RX_WAV: z.preprocess(stringToBoolean, z.boolean().default(false)),
  STT_DEBUG_DUMP_FAR_END_REF: z.preprocess(stringToBoolean, z.boolean().default(false)),

  /* Tier 4: SpeexDSP AEC (requires libspeexdsp: brew install speex / apt install libspeexdsp-dev) */
  STT_AEC_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(false)),

  /* Tier 5: Auto-calibration (noise floor + adaptive thresholds) */
  STT_NOISE_FLOOR_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  STT_NOISE_FLOOR_ALPHA: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(1).default(0.05)),
  STT_NOISE_FLOOR_MIN_SAMPLES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(30)),
  STT_ADAPTIVE_RMS_MULTIPLIER: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(2.0)),
  STT_ADAPTIVE_PEAK_MULTIPLIER: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(2.5)),
  STT_ADAPTIVE_FLOOR_MIN_RMS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.01)),
  STT_ADAPTIVE_FLOOR_MIN_PEAK: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(0.03)),

  /* Tier 5: Late-final watchdog (force final if speech but no final in X sec) */
  STT_LATE_FINAL_WATCHDOG_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  STT_LATE_FINAL_WATCHDOG_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),
  /** Optional grace ms before late-final watchdog fires (read by callSession when set). */
  STT_LATE_FINAL_GRACE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),

  /* Dead air protection */
  DEAD_AIR_MS: z.coerce.number().int().positive(),
  DEAD_AIR_NO_FRAMES_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1500)),

  /* STT debug dir (optional); when set, runtime ensures it exists at startup */
  STT_DEBUG_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** Optional separate dir for AMR-WB debug artifacts (defaults to STT_DEBUG_DIR when unset). */
  AMRWB_DEBUG_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

  /* ───────────────────────── TTS ───────────────────────── */
  /** TTS backend: kokoro_http (default) or coqui_xtts. Used when no tenant tts config is set. */
  TTS_MODE: z.preprocess(emptyToUndefined, z.enum(['kokoro_http', 'coqui_xtts']).default('kokoro_http')),
  KOKORO_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** Coqui XTTS API base URL (e.g. http://host:7002/tts). Required when TTS_MODE=coqui_xtts. */
  COQUI_XTTS_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** Coqui XTTS voice_id (e.g. "en_sample"). Default "en_sample" when unset; not Kokoro preset names. */
  COQUI_VOICE_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** When true, omit voice_id/speaker in Coqui requests (for single-speaker XTTS models). Default false. */
  COQUI_SINGLE_SPEAKER: z.preprocess(stringToBoolean, z.boolean().default(false)),
  /** XTTS v2 tuning (optional). Sent to your Coqui server if set. */
  COQUI_TEMPERATURE: z.preprocess(emptyToUndefined, z.coerce.number().min(0).optional()),
  COQUI_LENGTH_PENALTY: z.preprocess(emptyToUndefined, z.coerce.number().optional()),
  COQUI_REPETITION_PENALTY: z.preprocess(emptyToUndefined, z.coerce.number().optional()),
  COQUI_TOP_K: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  COQUI_TOP_P: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1).optional()),
  COQUI_SPEED: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  COQUI_SPLIT_SENTENCES: z.preprocess(stringToBoolean, z.boolean().optional()),
  /** Greeting text used to generate greeting.wav at startup and for live-TTS fallback. Default: "Hi! Thanks for calling. How can I help you today?" */
  GREETING_TEXT: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  KOKORO_VOICE_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  TTS_SAMPLE_RATE: z.preprocess(ttsSampleRateFallback, z.coerce.number().int().positive().default(8000)),
  PLAYBACK_PROFILE: z.preprocess(emptyToUndefined, z.enum(['pstn', 'hd']).default('pstn')),
  PLAYBACK_PSTN_SAMPLE_RATE: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),
  PLAYBACK_ENABLE_HIGHPASS: z.preprocess(stringToBoolean, z.boolean().default(true)),

  /* ───────────────────────── Brain / LLM ───────────────────────── */
  /** When true, use local default brain (keyword rules). When false or unset, use BRAIN_URL if set (e.g. GPT-4o API). */
  BRAIN_USE_LOCAL: z.preprocess(stringToBoolean, z.boolean().default(false)),
  BRAIN_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BRAIN_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8000)),
  BRAIN_STREAMING_ENABLED: z.preprocess(stringToBoolean, z.boolean().default(true)),
  BRAIN_STREAM_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default('/reply/stream')),
  BRAIN_STREAM_PING_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(15000)),
  BRAIN_STREAM_FIRST_AUDIO_MAX_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(2000)),
  BRAIN_STREAM_SEGMENT_MIN_CHARS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(120)),
  BRAIN_STREAM_SEGMENT_NEXT_CHARS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(180)),

  /* ───────────────────────── Call transcript / summarizer ───────────────────────── */
  /** When set, write full call transcript (caller + assistant text) to this dir at teardown. No audio. */
  CALL_TRANSCRIPT_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

  /* ───────────────────────── Redis / Capacity ───────────────────────── */
  REDIS_URL: z.string().min(1),

  GLOBAL_CONCURRENCY_CAP: z.coerce.number().int().positive(),
  TENANT_CONCURRENCY_CAP_DEFAULT: z.coerce.number().int().positive(),
  TENANT_CALLS_PER_MIN_CAP_DEFAULT: z.coerce.number().int().positive(),
  CAPACITY_TTL_SECONDS: z.coerce.number().int().positive(),

  TENANTMAP_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('tenantmap')),
  TENANTCFG_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('tenantcfg')),
  CAP_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default('cap')),
}).superRefine((data, ctx) => {
  if (data.TTS_MODE === 'kokoro_http' && (!data.KOKORO_URL || data.KOKORO_URL.trim() === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'KOKORO_URL is required when TTS_MODE=kokoro_http', path: ['KOKORO_URL'] });
  }
  if (data.TTS_MODE === 'coqui_xtts' && (!data.COQUI_XTTS_URL || data.COQUI_XTTS_URL.trim() === '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'COQUI_XTTS_URL is required when TTS_MODE=coqui_xtts', path: ['COQUI_XTTS_URL'] });
  }
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
  throw new Error(`Invalid environment variables: ${issues}`);
}

export const env = parsed.data;

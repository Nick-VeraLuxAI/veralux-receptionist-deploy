/**
 * Thinking Filler — pre-caches short audio phrases that can be played
 * immediately when the system enters THINKING state, masking the
 * STT → LLM → TTS processing latency from the caller.
 *
 * Fillers are synthesized once at startup using the default TTS voice and
 * cached in memory. Both raw (WebRTC) and PSTN-pipeline-processed versions
 * are stored so delivery is instant regardless of transport.
 */

import { env } from '../env';
import { log } from '../log';
import { synthesizeSpeech } from '../tts';
import { runPlaybackPipeline } from './playbackPipeline';

const FILLER_PHRASES = [
  'One moment.',
  'Let me check on that.',
  'Sure, one moment.',
  'One second.',
];

export interface CachedFiller {
  text: string;
  /** Original TTS output (for WebRTC / HD transports). */
  rawAudio: Buffer;
  /** PSTN-pipeline-processed audio (down-sampled, high-passed). */
  pstnAudio: Buffer;
  contentType: string;
}

let fillerCache: CachedFiller[] = [];
let cacheReady = false;
let cachePromise: Promise<void> | undefined;

/**
 * Kick off filler cache warming. Safe to call multiple times (idempotent).
 * The cache builds asynchronously; calls to `getRandomFiller` before
 * completion return `null` (the system simply skips the filler).
 */
export function warmFillerCache(): void {
  if (cachePromise) return;
  cachePromise = doBuildCache();
}

async function doBuildCache(): Promise<void> {
  try {
    const results: CachedFiller[] = [];

    for (const phrase of FILLER_PHRASES) {
      try {
        const ttsResult = await synthesizeSpeech({ text: phrase });

        let pstnAudio = ttsResult.audio;
        try {
          const pipelineResult = runPlaybackPipeline(ttsResult.audio, {
            targetSampleRateHz: env.PLAYBACK_PSTN_SAMPLE_RATE,
            enableHighpass: env.PLAYBACK_ENABLE_HIGHPASS,
            logContext: { source: 'thinking_filler', text: phrase },
          });
          pstnAudio = pipelineResult.audio;
        } catch (pipeErr) {
          log.warn(
            { err: pipeErr, text: phrase },
            'thinking filler PSTN pipeline failed, using raw audio',
          );
        }

        results.push({
          text: phrase,
          rawAudio: ttsResult.audio,
          pstnAudio,
          contentType: ttsResult.contentType,
        });
      } catch (ttsErr) {
        log.warn({ err: ttsErr, text: phrase }, 'thinking filler TTS failed for phrase');
      }
    }

    fillerCache = results;
    cacheReady = results.length > 0;
    log.info(
      { count: fillerCache.length, phrases: fillerCache.map((f) => f.text) },
      'thinking filler cache ready',
    );
  } catch (err) {
    log.warn({ err }, 'failed to build thinking filler cache');
  }
}

/** Pick a random filler from cache. Returns `null` if cache is not ready. */
export function getRandomFiller(): CachedFiller | null {
  if (!cacheReady || fillerCache.length === 0) return null;
  const idx = Math.floor(Math.random() * fillerCache.length);
  return fillerCache[idx] ?? null;
}

/**
 * Return the appropriate audio buffer for the given transport mode.
 * PSTN gets the pipeline-processed version; everything else gets the raw TTS output.
 */
export function getFillerAudio(
  filler: CachedFiller,
  transportMode: string,
): Buffer {
  return transportMode === 'pstn' ? filler.pstnAudio : filler.rawAudio;
}

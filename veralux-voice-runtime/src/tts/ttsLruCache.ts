import { createHash } from 'node:crypto';
import { env } from '../env';
import type { TTSRequest, TTSResult } from './types';

export type TtsLruCacheOptions = {
  maxEntries: number;
  maxTextChars: number;
  maxAudioBytes: number;
};

/**
 * In-process LRU for TTS audio. Bounded by entry count, input text length, and WAV size.
 * Keys are SHA-256 fingerprints of the exact provider request shape (see build*CacheKey).
 */
export type TtsLruCacheStats = {
  enabled: boolean;
  entries: number;
  max_entries: number;
  max_text_chars: number;
  max_audio_bytes: number;
  hits: number;
  misses: number;
};

export class TtsLruCache {
  private readonly maxEntries: number;
  private readonly maxTextChars: number;
  private readonly maxAudioBytes: number;
  private readonly map = new Map<string, { audio: Buffer; contentType: string }>();
  private hits = 0;
  private misses = 0;

  constructor(options: TtsLruCacheOptions) {
    this.maxEntries = options.maxEntries;
    this.maxTextChars = options.maxTextChars;
    this.maxAudioBytes = options.maxAudioBytes;
  }

  get(key: string): TTSResult | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, entry);
    return {
      audio: Buffer.from(entry.audio),
      contentType: entry.contentType,
    };
  }

  recordMiss(): void {
    this.misses += 1;
  }

  getStats(): Omit<TtsLruCacheStats, 'enabled'> {
    return {
      entries: this.map.size,
      max_entries: this.maxEntries,
      max_text_chars: this.maxTextChars,
      max_audio_bytes: this.maxAudioBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }

  set(key: string, textLen: number, result: TTSResult): void {
    if (textLen > this.maxTextChars || result.audio.length > this.maxAudioBytes) {
      return;
    }
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, {
      audio: Buffer.from(result.audio),
      contentType: result.contentType,
    });
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  /** For tests / metrics */
  get size(): number {
    return this.map.size;
  }
}

function hashFingerprint(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Fingerprint must match Coqui request shaping in coquiXtts.ts (including COQUI_SINGLE_SPEAKER).
 */
export function buildCoquiTtsCacheKey(effective: TTSRequest): string {
  const url = effective.coquiXttsUrl ?? '';
  const language = effective.language ?? 'en';
  const parts: Record<string, unknown> = {
    v: 1,
    p: 'coqui_xtts',
    url,
    text: effective.text,
    language,
    coqui_single_speaker: env.COQUI_SINGLE_SPEAKER,
  };
  if (effective.speakerWavUrl) {
    parts.speaker_wav = effective.speakerWavUrl;
  } else if (!env.COQUI_SINGLE_SPEAKER) {
    const speaker = effective.voice ?? 'en_sample';
    parts.voice_id = speaker;
    parts.speaker = speaker;
  }
  if (effective.coquiTemperature != null) parts.temperature = effective.coquiTemperature;
  if (effective.coquiLengthPenalty != null) parts.length_penalty = effective.coquiLengthPenalty;
  if (effective.coquiRepetitionPenalty != null) parts.repetition_penalty = effective.coquiRepetitionPenalty;
  if (effective.coquiTopK != null) parts.top_k = effective.coquiTopK;
  if (effective.coquiTopP != null) parts.top_p = effective.coquiTopP;
  if (effective.coquiSpeed != null) parts.speed = effective.coquiSpeed;
  if (effective.coquiSplitSentences != null) parts.split_sentences = effective.coquiSplitSentences;
  return hashFingerprint(parts);
}

function resolveKokoroRequestUrl(baseUrl: string | undefined): string {
  const base = (baseUrl ?? env.KOKORO_URL ?? '').trim();
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/tts') ? base : `${trimmed}/tts`;
}

/**
 * Fingerprint must match Kokoro JSON body in kokoroTTS.ts (resolved URL, sample rate, format).
 */
export function buildKokoroTtsCacheKey(effective: TTSRequest): string {
  const kokoroUrl = resolveKokoroRequestUrl(effective.kokoroUrl);
  const sampleRate = effective.sampleRate ?? env.TTS_SAMPLE_RATE;
  const format = effective.format ?? 'wav';
  return hashFingerprint({
    v: 1,
    p: 'kokoro_http',
    url: kokoroUrl,
    text: effective.text,
    voice_id: effective.voice ?? null,
    rate: effective.kokoroSpeed ?? null,
    format,
    sampleRate,
  });
}

export function createTtsLruCacheFromEnv(): TtsLruCache | null {
  if (!env.TTS_CACHE_ENABLED) {
    return null;
  }
  return new TtsLruCache({
    maxEntries: env.TTS_CACHE_MAX_ENTRIES,
    maxTextChars: env.TTS_CACHE_MAX_TEXT_CHARS,
    maxAudioBytes: env.TTS_CACHE_MAX_AUDIO_BYTES,
  });
}

/** Process-wide cache instance (null when TTS_CACHE_ENABLED=false). */
export const ttsLruCache = createTtsLruCacheFromEnv();

export function getTtsLruCacheStats(): TtsLruCacheStats {
  if (!ttsLruCache) {
    return {
      enabled: false,
      entries: 0,
      max_entries: env.TTS_CACHE_MAX_ENTRIES,
      max_text_chars: env.TTS_CACHE_MAX_TEXT_CHARS,
      max_audio_bytes: env.TTS_CACHE_MAX_AUDIO_BYTES,
      hits: 0,
      misses: 0,
    };
  }
  return { enabled: true, ...ttsLruCache.getStats() };
}

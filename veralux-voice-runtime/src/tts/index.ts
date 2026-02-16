import { parseWavInfo } from '../audio/wavInfo';
import { env } from '../env';
import { log } from '../log';
import type { RuntimeTenantConfig } from '../tenants/tenantConfig';
import { synthesizeSpeech as synthesizeKokoro } from './kokoroTTS';
import { synthesizeSpeechCoquiXtts } from './coquiXtts';
import type { TTSRequest, TTSResult } from './types';

/** Build TTS config from .env when no tenant config is set. Kokoro and Coqui use separate voice defaults. */
function ttsConfigFromEnv(): RuntimeTenantConfig['tts'] {
  if (env.TTS_MODE === 'coqui_xtts') {
    return {
      mode: 'coqui_xtts',
      coquiXttsUrl: env.COQUI_XTTS_URL!,
      voice: env.COQUI_VOICE_ID ?? 'en_sample',
      language: 'en',
      coquiTemperature: env.COQUI_TEMPERATURE,
      coquiLengthPenalty: env.COQUI_LENGTH_PENALTY,
      coquiRepetitionPenalty: env.COQUI_REPETITION_PENALTY,
      coquiTopK: env.COQUI_TOP_K,
      coquiTopP: env.COQUI_TOP_P,
      coquiSpeed: env.COQUI_SPEED,
      coquiSplitSentences: env.COQUI_SPLIT_SENTENCES,
    };
  }
  return {
    mode: 'kokoro_http',
    kokoroUrl: env.KOKORO_URL!,
    voice: env.KOKORO_VOICE_ID ?? 'af_bella',
    format: 'wav',
    sampleRate: env.TTS_SAMPLE_RATE,
  };
}

/**
 * Normalize text for TTS pronunciation.
 * Converts time formats, ordinals, and common abbreviations so the
 * speech engine reads them naturally instead of digit-by-digit.
 */
function normalizeTTSText(text: string): string {
  let t = text;

  // "9:00am" / "9:00 AM" / "10:00pm" → "9 AM" / "10 PM"
  t = t.replace(/\b(\d{1,2}):00\s*(am|pm|AM|PM|a\.m\.|p\.m\.)\b/gi, (_, h, p) => {
    return `${h} ${p.replace(/\./g, '').toUpperCase()}`;
  });

  // "9:30am" / "9:30 PM" → "9 30 AM" / "9 30 PM"
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*(am|pm|AM|PM|a\.m\.|p\.m\.)\b/gi, (_, h, m, p) => {
    return `${h} ${m} ${p.replace(/\./g, '').toUpperCase()}`;
  });

  // Bare "9:00" / "17:00" (24-hour, no am/pm) → "9" / "5 PM"
  t = t.replace(/\b([01]?\d|2[0-3]):00\b/g, (_, h) => {
    const hour = parseInt(h, 10);
    if (hour === 0) return '12 AM';
    if (hour <= 12) return String(hour);
    return `${hour - 12} PM`;
  });

  // "$4.50" → "4 dollars 50 cents" — helps TTS with prices
  t = t.replace(/\$(\d+)\.(\d{2})\b/g, (_, d, c) => {
    const cents = parseInt(c, 10);
    return cents > 0 ? `${d} dollars and ${cents} cents` : `${d} dollars`;
  });
  t = t.replace(/\$(\d+)\b/g, '$1 dollars');

  return t;
}

/**
 * Synthesize speech using the TTS backend selected by tenant config or .env.
 * When ttsConfig is provided, uses it; otherwise uses TTS_MODE, KOKORO_URL, and COQUI_XTTS_URL from .env.
 */
export async function synthesizeSpeech(
  request: TTSRequest,
  ttsConfig?: RuntimeTenantConfig['tts'] | null,
): Promise<TTSResult> {
  const config = ttsConfig ?? ttsConfigFromEnv();

  // Normalize text for natural TTS pronunciation
  request = { ...request, text: normalizeTTSText(request.text) };

  let result: TTSResult;
  if (config.mode === 'coqui_xtts') {
    result = await synthesizeSpeechCoquiXtts({
      text: request.text,
      voice: request.voice ?? config.voice,
      coquiXttsUrl: config.coquiXttsUrl,
      speakerWavUrl: request.speakerWavUrl ?? config.speakerWavUrl,
      language: request.language ?? config.language,
      format: request.format ?? config.format,
      sampleRate: request.sampleRate ?? config.sampleRate,
      coquiTemperature: request.coquiTemperature ?? config.coquiTemperature,
      coquiLengthPenalty: request.coquiLengthPenalty ?? config.coquiLengthPenalty,
      coquiRepetitionPenalty: request.coquiRepetitionPenalty ?? config.coquiRepetitionPenalty,
      coquiTopK: request.coquiTopK ?? config.coquiTopK,
      coquiTopP: request.coquiTopP ?? config.coquiTopP,
      coquiSpeed: request.coquiSpeed ?? config.coquiSpeed,
      coquiSplitSentences: request.coquiSplitSentences ?? config.coquiSplitSentences,
    });
  } else {
    const kokoroConfig = config.mode === 'kokoro_http' ? config : undefined;
    result = await synthesizeKokoro({
      text: request.text,
      voice: request.voice ?? kokoroConfig?.voice,
      format: request.format ?? kokoroConfig?.format,
      sampleRate: request.sampleRate ?? kokoroConfig?.sampleRate,
      kokoroUrl: kokoroConfig?.kokoroUrl ?? request.kokoroUrl,
      kokoroSpeed: request.kokoroSpeed ?? (kokoroConfig as any)?.kokoroSpeed,
    });
  }

  if (result.contentType?.toLowerCase().includes('wav') && result.audio.length >= 44) {
    try {
      const wavInfo = parseWavInfo(result.audio);
      log.info(
        { event: 'tts_sample_rate', sample_rate_hz: wavInfo.sampleRateHz, provider: config.mode },
        'TTS output sample rate',
      );
    } catch {
      // ignore parse errors; log is best-effort
    }
  }
  return result;
}

export type { TTSRequest, TTSResult } from './types';

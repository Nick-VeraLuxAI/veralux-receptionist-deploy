import { env } from '../env';
import { log } from '../log';
import { withRetry } from '../retry';
import { TTSRequest, TTSResult } from './types';

export async function synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
  const baseUrl = request.kokoroUrl ?? env.KOKORO_URL;
  if (!baseUrl) {
    throw new Error('KOKORO_URL or request.kokoroUrl is required for Kokoro TTS');
  }
  // Ensure the URL includes the /tts endpoint path
  const kokoroUrl = baseUrl.replace(/\/+$/, '').endsWith('/tts') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/tts`;
  const sampleRate = request.sampleRate ?? env.TTS_SAMPLE_RATE;
  const format = request.format ?? 'wav';
  log.info(
    { event: 'tts_request', sample_rate: sampleRate, voice: request.voice, format },
    'tts request',
  );
  const { response, arrayBuffer } = await withRetry(
    async () => {
      const res = await fetch(kokoroUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: request.text,
          voice_id: request.voice,
          rate: request.kokoroSpeed,
          format,
          sampleRate,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text();
        log.error({ status: res.status, body }, 'kokoro tts error');
        throw new Error(`kokoro tts error ${res.status}`);
      }

      return { response: res, arrayBuffer: await res.arrayBuffer() };
    },
    { label: 'kokoro_tts', retries: 1 },
  );
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') ?? 'audio/wav',
  };
}
import { env } from '../env';
import { log } from '../log';
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
  const response = await fetch(kokoroUrl, {
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
  });

  if (!response.ok) {
    const body = await response.text();
    log.error({ status: response.status, body }, 'kokoro tts error');
    throw new Error(`kokoro tts error ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') ?? 'audio/wav',
  };
}
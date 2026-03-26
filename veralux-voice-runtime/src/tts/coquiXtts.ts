import { env } from '../env';
import { log } from '../log';
import { withRetry } from '../retry';
import { TTSRequest, TTSResult } from './types';

/**
 * Coqui XTTS HTTP client. Matches XTTS model API: text + language + speaker_wav (reference for voice cloning).
 * When COQUI_SINGLE_SPEAKER is true, omits voice_id/speaker (for single-speaker models). Otherwise sends them.
 */
export async function synthesizeSpeechCoquiXtts(request: TTSRequest): Promise<TTSResult> {
  const url = request.coquiXttsUrl;
  if (!url) {
    throw new Error('coqui xtts: coquiXttsUrl is required');
  }

  const language = request.language ?? 'en';
  const body: Record<string, string | number | boolean> = {
    text: request.text,
    language,
  };
  if (request.speakerWavUrl) {
    body.speaker_wav = request.speakerWavUrl;
  } else if (!env.COQUI_SINGLE_SPEAKER) {
    // Multi-speaker: send voice_id/speaker. Single-speaker: omit so server uses default.
    const speaker = request.voice ?? 'en_sample';
    body.voice_id = speaker;
    body.speaker = speaker;
  }
  // XTTS v2 tuning: send only if your server accepts them
  if (request.coquiTemperature != null) body.temperature = request.coquiTemperature;
  if (request.coquiLengthPenalty != null) body.length_penalty = request.coquiLengthPenalty;
  if (request.coquiRepetitionPenalty != null) body.repetition_penalty = request.coquiRepetitionPenalty;
  if (request.coquiTopK != null) body.top_k = request.coquiTopK;
  if (request.coquiTopP != null) body.top_p = request.coquiTopP;
  if (request.coquiSpeed != null) body.speed = request.coquiSpeed;
  if (request.coquiSplitSentences != null) body.split_sentences = request.coquiSplitSentences;

  log.info(
    {
      event: 'tts_request',
      provider: 'coqui_xtts',
      language,
      voice_id: body.voice_id ?? null,
      speaker_wav: request.speakerWavUrl ?? null,
      single_speaker: env.COQUI_SINGLE_SPEAKER,
    },
    'coqui xtts request',
  );

  const { contentType, raw } = await withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      const ct = res.headers.get('content-type') ?? '';
      const ab = await res.arrayBuffer();
      const rawBuf = Buffer.from(ab);

      if (!res.ok) {
        const bodyText = rawBuf.toString('utf8');
        log.error({ status: res.status, body: bodyText }, 'coqui xtts error');
        throw new Error(`coqui xtts error ${res.status}`);
      }

      return { contentType: ct, raw: rawBuf };
    },
    { label: 'coqui_xtts', retries: 1 },
  );

  if (contentType.includes('application/json')) {
    let errMsg: string;
    try {
      const json = JSON.parse(raw.toString('utf8')) as { error?: string; detail?: string };
      errMsg = json.error ?? json.detail ?? raw.toString('utf8');
    } catch {
      errMsg = raw.toString('utf8');
    }
    log.error({ body: errMsg }, 'coqui xtts returned JSON instead of WAV');
    throw new Error(`coqui xtts: ${errMsg}`);
  }

  return {
    audio: raw,
    contentType: contentType || 'audio/wav',
  };
}

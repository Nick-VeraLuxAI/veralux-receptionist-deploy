export interface TTSRequest {
  text: string;
  voice?: string;
  format?: string;
  sampleRate?: number;
  /** Kokoro: base URL for the TTS service. */
  kokoroUrl?: string;
  /** Coqui XTTS: base URL for the TTS API (e.g. http://host:7002/api/tts). */
  coquiXttsUrl?: string;
  /** Coqui XTTS: reference audio for voice cloning (URL or path). XTTS uses this, not preset voice IDs. */
  speakerWavUrl?: string;
  /** Coqui XTTS: language code (default "en"). */
  language?: string;
  /** Coqui XTTS v2 tuning (sent to your server if present). */
  coquiTemperature?: number;
  coquiLengthPenalty?: number;
  coquiRepetitionPenalty?: number;
  coquiTopK?: number;
  coquiTopP?: number;
  coquiSpeed?: number;
  coquiSplitSentences?: boolean;
}

export interface TTSResult {
  audio: Buffer;
  contentType: string;
}
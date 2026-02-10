import dotenv from "dotenv";
dotenv.config();

export type LLMProvider = "local" | "openai";

export interface LLMRuntimeConfig {
  provider: LLMProvider;
  localUrl?: string;
  openaiModel?: string;
  openaiApiKey?: string;
}

const DEFAULT_LOCAL_URL = "http://127.0.0.1:8080/completion";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

// STT defaults (env → fallback)
const DEFAULT_WHISPER_URL =
  process.env.WHISPER_URL || "http://127.0.0.1:9000/transcribe";

// TTS defaults (env → fallback)
// 👉 XTTS default; override with XTTS_URL or KOKORO_URL
const DEFAULT_TTS_URL =
  process.env.XTTS_URL ||
  process.env.KOKORO_URL ||
  "http://127.0.0.1:8020/tts";

// voiceId: XTTS uses speaker ref or model voice (e.g. en_sample); Kokoro uses keys like af_alloy
const DEFAULT_TTS_VOICE =
  process.env.XTTS_VOICE_ID ||
  process.env.KOKORO_VOICE_ID ||
  "en_sample";

// ───────────────────────────────────────────────
// Voice tuning + presets (XTTS & Kokoro)
// NOTE: Kokoro servers commonly don’t support “energy/variation” style knobs.
// We are hiding/removing those and keeping only: voiceId, language, rate, preset.
// ───────────────────────────────────────────────

export type VoicePreset = "neutral" | "warm" | "energetic" | "calm";
export type TtsMode = "kokoro_http" | "coqui_xtts";
export type VoiceMode = "preset" | "cloned";

export interface ClonedVoiceConfig {
  speakerWavUrl: string;    // URL to reference WAV file for voice cloning
  label?: string;            // Friendly name (e.g., "Sarah's Voice")
}

export interface TTSConfig {
  xttsUrl: string;           // TTS server URL (XTTS or Kokoro)
  voiceId: string;           // maps to the upstream TTS provider voice key
  language: string;          // XTTS: ISO 639-1 (e.g. en); Kokoro: often "a" / "b"
  rate: number;              // 1.0 = normal speed (we default to 0.95 for phone)
  preset?: VoicePreset;
  
  // Extended fields for XTTS voice cloning
  ttsMode?: TtsMode;                      // kokoro_http or coqui_xtts
  coquiXttsUrl?: string;                  // URL for XTTS server
  kokoroUrl?: string;                     // URL for Kokoro server
  clonedVoice?: ClonedVoiceConfig;        // Cloned voice profile
  defaultVoiceMode?: VoiceMode;           // Default voice mode at call start

  // XTTS tuning parameters
  coquiTemperature?: number;
  coquiSpeed?: number;
  coquiTopP?: number;
  coquiTopK?: number;
  coquiRepetitionPenalty?: number;
  coquiLengthPenalty?: number;
}

// small helper so bad env values don’t wreck things
function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sanitizeUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function getEnvWhisperUrl(): string | undefined {
  return sanitizeUrl(process.env.WHISPER_URL);
}

function getEnvTtsUrl(): string | undefined {
  return sanitizeUrl(process.env.XTTS_URL || process.env.KOKORO_URL);
}

// TTS tuning defaults from env (optional); prefer XTTS_* then KOKORO_*
const DEFAULT_TTS_RATE = clamp(
  parseNumberEnv("XTTS_RATE", parseNumberEnv("KOKORO_RATE", 0.95)),
  0.8,
  1.2
);

// XTTS default: ISO 639-1 (e.g. en, es, fr). Kokoro often uses "a" / "b".
const DEFAULT_TTS_LANG = process.env.XTTS_LANG || process.env.KOKORO_LANG || "en";

const DEFAULT_TTS_PRESET: VoicePreset =
  ((process.env.XTTS_PRESET || process.env.KOKORO_PRESET) as VoicePreset) ||
  "neutral";

// Presets control rate only (since energy/variation are removed)
const VOICE_PRESETS: Record<VoicePreset, Pick<TTSConfig, "rate">> = {
  neutral: { rate: 0.95 },
  warm: { rate: 0.92 },
  energetic: { rate: 1.02 },
  calm: { rate: 0.88 },
};

// ───────────────────────────────────────────────
// Prompts
// ───────────────────────────────────────────────

export interface PromptConfig {
  systemPreamble: string;
  schemaHint: string;
  policyPrompt: string;
  voicePrompt: string;
  /** Custom greeting text for the welcome message when a caller dials in */
  greetingText: string;
}

export interface STTConfig {
  whisperUrl: string;
}

const DEFAULT_SYSTEM_PREAMBLE = [
  "You're a friendly virtual receptionist answering phone calls for a local service business.",
  "Your job is to greet callers warmly, find out what they need, collect their contact info if helpful, and either schedule an appointment or connect them with the right person.",
].join(" ");

const DEFAULT_SCHEMA_HINT = `
You must respond ONLY with a single JSON object and no extra text.
Use this shape:

{
  "replyText": "string - what you say back to the caller",
  "actions": ["optional", "string", "flags"],
  "stage": "optional stage string: greeting|qualifying|scheduling|handoff|closed",
  "leadUpdates": {
    "optional": "fields to merge into the lead record"
  }
}

Keep replyText short and focused, like a real receptionist speaking on the phone.
`.trim();

const DEFAULT_POLICY_PROMPT = [
  "Never promise specific prices, discounts, or guarantees—offer to have someone follow up instead.",
  "Never ask for payment info or passwords.",
  "Don't give legal, medical, or safety advice.",
  "If you're unsure or the service isn't available, offer to take a message or transfer the call.",
].join(" ");

const DEFAULT_VOICE_PROMPT = [
  "Be friendly, confident, and calm.",
  "Keep your responses short and natural, like you're actually on the phone.",
  "Use the caller's name when you know it.",
].join(" ");

export interface SerializedLLMConfig {
  config: LLMRuntimeConfig;
  prompts: PromptConfig;
  stt: STTConfig;
  tts: TTSConfig;
}

export class LLMConfigStore {
  private config: LLMRuntimeConfig;
  private prompts: PromptConfig;
  private stt: STTConfig;
  private tts: TTSConfig;

  constructor(initial?: Partial<SerializedLLMConfig>) {
    const providerEnv = (process.env.LLM_PROVIDER || "").toLowerCase();
    const provider: LLMProvider = providerEnv === "local" ? "local" : "openai";

    this.config = initial?.config || {
      provider,
      localUrl: process.env.LOCAL_LLM_URL || DEFAULT_LOCAL_URL,
      openaiModel: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      openaiApiKey: process.env.OPENAI_API_KEY,
    };

    this.prompts = {
      systemPreamble: DEFAULT_SYSTEM_PREAMBLE,
      schemaHint: DEFAULT_SCHEMA_HINT,
      policyPrompt: DEFAULT_POLICY_PROMPT,
      voicePrompt: DEFAULT_VOICE_PROMPT,
      greetingText: "",
      ...(initial?.prompts || {}),
    };
    // Ensure greetingText exists for configs loaded before this field was added
    if (this.prompts.greetingText === undefined) this.prompts.greetingText = "";

    this.stt = initial?.stt || {
      whisperUrl: DEFAULT_WHISPER_URL,
    };

    // TTS – XTTS/Kokoro config
    this.tts = initial?.tts || {
      xttsUrl: DEFAULT_TTS_URL,
      voiceId: DEFAULT_TTS_VOICE,
      language: DEFAULT_TTS_LANG,
      rate: DEFAULT_TTS_RATE,
      preset: DEFAULT_TTS_PRESET,
    };
  }

  // ── LLM runtime ──────────────────────────────

  get(): LLMRuntimeConfig {
    return this.config;
  }

  set(next: Partial<LLMRuntimeConfig>): LLMRuntimeConfig {
    const provider =
      next.provider ??
      this.config.provider ??
      ((process.env.LLM_PROVIDER || "").toLowerCase() === "local"
        ? "local"
        : "openai");

    const localUrl =
      next.localUrl ??
      this.config.localUrl ??
      process.env.LOCAL_LLM_URL ??
      DEFAULT_LOCAL_URL;

    const openaiModel =
      next.openaiModel ??
      this.config.openaiModel ??
      process.env.OPENAI_MODEL ??
      DEFAULT_OPENAI_MODEL;

    const openaiApiKey =
      typeof next.openaiApiKey === "string" && next.openaiApiKey.trim()
        ? next.openaiApiKey.trim()
        : this.config.openaiApiKey || process.env.OPENAI_API_KEY;

    if (typeof next.openaiApiKey === "string" && next.openaiApiKey.trim()) {
      process.env.OPENAI_API_KEY = next.openaiApiKey
        .trim()
        .replace(/[\r\n]/g, "");
    }
    if (typeof next.openaiModel === "string" && next.openaiModel.trim()) {
      process.env.OPENAI_MODEL = next.openaiModel
        .trim()
        .replace(/[\r\n]/g, "");
    }

    this.config = { provider, localUrl, openaiModel, openaiApiKey };
    return this.config;
  }

  // ── Prompts ──────────────────────────────────

  getPrompts(): PromptConfig {
    return this.prompts;
  }

  setPrompts(next: Partial<PromptConfig>): PromptConfig {
    this.prompts = {
      systemPreamble:
        next.systemPreamble?.trim() || this.prompts.systemPreamble,
      schemaHint: next.schemaHint?.trim() || this.prompts.schemaHint,
      policyPrompt: next.policyPrompt?.trim() || this.prompts.policyPrompt,
      voicePrompt: next.voicePrompt?.trim() || this.prompts.voicePrompt,
      greetingText: next.greetingText !== undefined
        ? next.greetingText.trim()
        : this.prompts.greetingText,
    };
    return this.prompts;
  }

  getSafeConfig(): Omit<LLMRuntimeConfig, "openaiApiKey"> & {
    hasOpenAIApiKey: boolean;
  } {
    return {
      provider: this.config.provider,
      localUrl: this.config.localUrl,
      openaiModel: this.config.openaiModel,
      hasOpenAIApiKey:
        !!this.config.openaiApiKey || !!process.env.OPENAI_API_KEY,
    };
  }

  // ── STT / TTS ─────────────────────────────────

  getSttConfig(): STTConfig {
    const envWhisperUrl = getEnvWhisperUrl();
    return { whisperUrl: envWhisperUrl || this.stt.whisperUrl || DEFAULT_WHISPER_URL };
  }

  getTtsConfig(): TTSConfig {
    const base = this.tts || ({} as TTSConfig);
    const preset = base.preset || DEFAULT_TTS_PRESET;
    const tuned = VOICE_PRESETS[preset] || VOICE_PRESETS.neutral;
    const envTtsUrl = getEnvTtsUrl();

    const config: TTSConfig = {
      xttsUrl: envTtsUrl || base.xttsUrl || DEFAULT_TTS_URL,
      voiceId: base.voiceId || DEFAULT_TTS_VOICE,
      language: base.language || DEFAULT_TTS_LANG,
      // If a preset exists, it can provide a default rate — but explicit rate wins.
      rate: clamp(
        typeof base.rate === "number" ? base.rate : tuned.rate,
        0.8,
        1.2
      ),
      preset,
      // Extended fields - default to coqui_xtts for voice cloning support
      ttsMode: base.ttsMode || "coqui_xtts",
      coquiXttsUrl: base.coquiXttsUrl,
      kokoroUrl: base.kokoroUrl,
      clonedVoice: base.clonedVoice,
      defaultVoiceMode: base.defaultVoiceMode || "preset",
      // XTTS tuning parameters
      coquiTemperature: (base as any).coquiTemperature,
      coquiSpeed: (base as any).coquiSpeed,
      coquiTopP: (base as any).coquiTopP,
      coquiTopK: (base as any).coquiTopK,
      coquiRepetitionPenalty: (base as any).coquiRepetitionPenalty,
      coquiLengthPenalty: (base as any).coquiLengthPenalty,
    };

    return config;
  }

  setTtsConfig(next: Partial<TTSConfig>): TTSConfig {
    const current = this.getTtsConfig();

    const merged: TTSConfig = {
      ...current,
      ...next,
      preset: (next.preset as VoicePreset) ?? current.preset,
      rate: clamp(
        typeof next.rate === "number" ? next.rate : current.rate,
        0.8,
        1.2
      ),
      // Ensure language never becomes empty
      language:
        typeof next.language === "string" && next.language.trim().length
          ? next.language.trim()
          : current.language,
      voiceId:
        typeof next.voiceId === "string" && next.voiceId.trim().length
          ? next.voiceId.trim()
          : current.voiceId,
      xttsUrl:
        typeof next.xttsUrl === "string" && next.xttsUrl.trim().length
          ? next.xttsUrl.trim()
          : current.xttsUrl,
      // Extended fields for voice cloning
      ttsMode: next.ttsMode ?? current.ttsMode,
      coquiXttsUrl:
        typeof next.coquiXttsUrl === "string" && next.coquiXttsUrl.trim().length
          ? next.coquiXttsUrl.trim()
          : next.coquiXttsUrl === undefined
          ? current.coquiXttsUrl
          : undefined,
      kokoroUrl:
        typeof next.kokoroUrl === "string" && next.kokoroUrl.trim().length
          ? next.kokoroUrl.trim()
          : next.kokoroUrl === undefined
          ? current.kokoroUrl
          : undefined,
      defaultVoiceMode: next.defaultVoiceMode ?? current.defaultVoiceMode,
      clonedVoice: next.clonedVoice !== undefined
        ? next.clonedVoice
        : current.clonedVoice,
    };

    this.tts = merged;
    return this.getTtsConfig();
  }

  setTtsVoice(voiceId: string): TTSConfig {
    if (voiceId && voiceId.trim()) {
      this.tts = { ...this.getTtsConfig(), voiceId: voiceId.trim() };
    }
    return this.getTtsConfig();
  }

  setTtsPreset(preset: VoicePreset): TTSConfig {
    if (!VOICE_PRESETS[preset]) return this.getTtsConfig();
    const base = this.getTtsConfig();
    const tuned = VOICE_PRESETS[preset];

    // Apply preset rate (but keep voice/lang/url)
    this.tts = { ...base, ...tuned, preset };
    return this.getTtsConfig();
  }

  getSafeTtsConfig(): TTSConfig {
    return this.getTtsConfig();
  }

  serialize(): SerializedLLMConfig {
    return {
      config: { ...this.config, openaiApiKey: undefined },
      prompts: { ...this.prompts },
      stt: { ...this.stt },
      tts: { ...this.tts },
    };
  }

  hydrate(data: Partial<SerializedLLMConfig>): void {
    if (data.config) this.config = { ...this.config, ...data.config };
    if (data.prompts) this.prompts = { ...this.prompts, ...data.prompts };
    if (data.stt) this.stt = { ...this.stt, ...data.stt };
    if (data.tts) this.tts = { ...this.tts, ...data.tts };
  }
}

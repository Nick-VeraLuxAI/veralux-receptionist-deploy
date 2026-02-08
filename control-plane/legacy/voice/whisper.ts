import type { LLMConfigStore } from "./config";
import { tenants, DEFAULT_TENANT_ID } from "./tenants";

export interface STTResult {
  text: string;
  confidence?: number;
  raw?: unknown;
}

interface WhisperResponse {
  text?: string;
  error?: string;
  confidence?: number;
  [k: string]: unknown;
}

type BaseOpts = {
  tenantId?: string;
  config?: LLMConfigStore;
};

function getConfigStore(opts?: BaseOpts): LLMConfigStore {
  if (opts?.config) return opts.config;
  const tenantId = opts?.tenantId || DEFAULT_TENANT_ID;
  return tenants.getOrCreate(tenantId).config;
}

function resolveWhisperUrl(opts?: BaseOpts): string {
  const { whisperUrl } = getConfigStore(opts).getSttConfig();
  return (
    whisperUrl ||
    process.env.WHISPER_URL ||
    "http://127.0.0.1:9000/transcribe"
  );
}

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

async function postWhisperWithTimeout(
  url: string,
  buf: Buffer,
  timeoutMs: number,
  contentType: string
): Promise<WhisperResponse> {
  const { signal, clear } = withTimeout(timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: buf as unknown as BodyInit,
      signal,
    } as RequestInit);

    const rawText = await res.text().catch(() => "");

    let data: WhisperResponse = {};
    try {
      data = rawText ? (JSON.parse(rawText) as WhisperResponse) : {};
    } catch {
      // leave data empty; we'll use rawText in error
    }

    if (!res.ok) {
      const msg =
        (typeof data.error === "string" && data.error.trim() ? data.error : "") ||
        rawText ||
        `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`Whisper STT error: ${msg}`);
    }

    return data;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Whisper STT timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clear();
  }
}

/**
 * Transcribe raw audio bytes by sending them to the Whisper microservice.
 * Adds timeout, supports contentType override.
 */
export async function transcribeAudioBuffer(
  buf: Buffer,
  opts?: BaseOpts & { timeoutMs?: number; contentType?: string }
): Promise<string> {
  const url = resolveWhisperUrl(opts);
  if (!url) throw new Error("Whisper STT is not configured (missing whisperUrl).");

  const timeoutMs =
    opts?.timeoutMs ?? Number(process.env.WHISPER_TIMEOUT_MS ?? 20_000);

  const contentType = opts?.contentType || "application/octet-stream";

  const data = await postWhisperWithTimeout(url, buf, timeoutMs, contentType);

  if (!data.text || typeof data.text !== "string") {
    if (typeof data.error === "string" && data.error.trim()) {
      throw new Error(`Whisper STT error: ${data.error}`);
    }
    throw new Error(
      `Whisper STT returned no text field. Raw: ${JSON.stringify(data)}`
    );
  }

  return data.text.trim();
}

/**
 * Existing helper — returns richer info (confidence/raw) when present.
 */
export async function transcribeAudio(
  buffer: Buffer,
  opts?: BaseOpts & { timeoutMs?: number; contentType?: string }
): Promise<STTResult> {
  const url = resolveWhisperUrl(opts);
  if (!url) throw new Error("Whisper STT is not configured (missing whisperUrl).");

  const timeoutMs =
    opts?.timeoutMs ?? Number(process.env.WHISPER_TIMEOUT_MS ?? 20_000);

  const contentType = opts?.contentType || "application/octet-stream";

  const raw = await postWhisperWithTimeout(url, buffer, timeoutMs, contentType);
  const text = (raw.text || "").toString().trim();

  return {
    text,
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    raw,
  };
}

/**
 * Download any URL to a Buffer (useful for Telnyx recordings).
 * Supports optional headers (e.g. Authorization).
 */
export async function downloadToBuffer(
  url: string,
  opts?: { headers?: Record<string, string>; timeoutMs?: number }
): Promise<Buffer> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const { signal, clear } = withTimeout(timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: opts?.headers,
      signal,
    } as RequestInit);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Recording download failed: ${res.status} ${res.statusText} ${body}`
      );
    }

    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Recording download timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clear();
  }
}

/**
 * Convenience helper for Telnyx:
 * recordingUrl -> download -> transcribe
 */
export async function transcribeRecordingUrl(
  recordingUrl: string,
  opts?: BaseOpts & {
    headers?: Record<string, string>;
    downloadTimeoutMs?: number;
    transcribeTimeoutMs?: number;
    contentType?: string;
  }
): Promise<STTResult> {
  const audioBuf = await downloadToBuffer(recordingUrl, {
    headers: opts?.headers,
    timeoutMs: opts?.downloadTimeoutMs ?? 15000,
  });

  return transcribeAudio(audioBuf, {
    tenantId: opts?.tenantId,
    config: opts?.config,
    timeoutMs: opts?.transcribeTimeoutMs ?? 20_000,
    contentType: opts?.contentType || "application/octet-stream",
  });
}

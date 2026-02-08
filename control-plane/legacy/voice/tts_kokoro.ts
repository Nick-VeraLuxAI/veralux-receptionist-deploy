import type { LLMConfigStore, TTSConfig } from "./config";
import { tenants, DEFAULT_TENANT_ID } from "./tenants";

/** -------------------------------------------------------
 *  🗣️ Kokoro Voice Shaping Helper
 *  Makes TTS output sound more natural:
 *  - short sentences
 *  - punctuation enforcement
 *  - newline pauses
 * ------------------------------------------------------ */
function shapeTextForKokoro(raw: string): string {
  let text = (raw || "").trim();
  if (!text) return text;

  // Normalize whitespace
  text = text.replace(/\s+/g, " ");

  // Ensure ending punctuation
  if (!/[.!?…]$/.test(text)) {
    text += ".";
  }

  // Sentence splitting
  const maxChunkLength = 140;
  const sentences = text.split(/([.!?…])/).reduce<string[]>((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;

    if (/^[.!?…]$/.test(trimmed) && acc.length > 0) {
      acc[acc.length - 1] = acc[acc.length - 1] + trimmed;
    } else {
      acc.push(trimmed);
    }
    return acc;
  }, []);

  const shaped: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= maxChunkLength) {
      shaped.push(sentence.trim());
      continue;
    }

    // Break long sentences further at commas
    const parts = sentence.split(/,\s*/);
    let current = "";

    for (const part of parts) {
      const candidate = current ? `${current}, ${part}` : part;
      if (candidate.length > maxChunkLength && current) {
        shaped.push(current.trim());
        current = part;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) shaped.push(current.trim());
  }

  // Newlines → natural pauses for TTS
  return shaped.join("\n");
}

/** -------------------------------------------------------
 *  🔧 Internal Kokoro caller
 *  Uses a full TTSConfig object:
 *  - xttsUrl
 *  - voiceId
 *  - rate
 * ------------------------------------------------------ */
async function callKokoro(text: string, cfg: TTSConfig): Promise<Buffer> {
  const spokenText = shapeTextForKokoro(text);

  const { xttsUrl, voiceId, rate, language } = cfg;

  console.log("🔊 TTS synthesizeReply using:", {
    url: xttsUrl,
    voiceId,
    rate,
    language,
  });

  const res = await fetch(xttsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: spokenText,
      voice_id: voiceId, // what the Kokoro server expects
      language,
      rate,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Kokoro TTS failed: ${res.status} ${res.statusText} ${body}`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** -------------------------------------------------------
 *  🔊 Default Kokoro TTS Wrapper (tenant-aware)
 * ------------------------------------------------------ */
export async function synthesizeReply(
  text: string,
  opts?: { tenantId?: string; config?: LLMConfigStore }
): Promise<Buffer> {
  const cfgStore =
    opts?.config ||
    tenants.getOrCreate(opts?.tenantId || DEFAULT_TENANT_ID).config;
  const cfg = cfgStore.getTtsConfig();
  return callKokoro(text, cfg);
}

/** -------------------------------------------------------
 *  🔊 Advanced Kokoro TTS Wrapper
 *  Used for admin "Preview" – accepts an explicit TTSConfig
 *  (voiceId, rate, energy, variation, preset, etc.)
 * ------------------------------------------------------ */
export async function synthesizeReplyWithConfig(
  text: string,
  config: TTSConfig
): Promise<Buffer> {
  return callKokoro(text, config);
}

/**
 * @veralux/shared — Runtime Tenant Config Contract
 *
 * SINGLE SOURCE OF TRUTH for the schema that the control plane publishes
 * to Redis and the voice runtime consumes. Both services depend on this
 * package via npm workspaces.
 *
 * If you need to change the contract, change it HERE and both services
 * will pick up the change automatically.
 */
import { z, type RefinementCtx } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const didSchema = z.string().regex(E164_REGEX, "invalid_e164");

export function normalizeE164(did: string): string {
  const trimmed = did.trim();
  const normalized = trimmed.replace(/\s+/g, "");
  if (!normalized) {
    throw new Error("did_empty");
  }
  if (!E164_REGEX.test(normalized)) {
    throw new Error("invalid_e164");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// LLM Context schemas (forwarding, pricing, prompts)
// ---------------------------------------------------------------------------

const forwardingProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  number: z.string(), // Can be empty if role-only
  role: z.string(),
});

export type RuntimeForwardingProfile = z.infer<typeof forwardingProfileSchema>;

const pricingItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.string(),
  description: z.string().optional(),
});

const pricingInfoSchema = z.object({
  items: z.array(pricingItemSchema),
  notes: z.string().optional(),
});

export type RuntimePricingInfo = z.infer<typeof pricingInfoSchema>;

const promptConfigSchema = z.object({
  systemPreamble: z.string(),
  schemaHint: z.string(),
  policyPrompt: z.string(),
  voicePrompt: z.string(),
});

export type RuntimePromptConfig = z.infer<typeof promptConfigSchema>;

const llmContextSchema = z.object({
  forwardingProfiles: z.array(forwardingProfileSchema),
  pricing: pricingInfoSchema,
  prompts: promptConfigSchema,
});

export type RuntimeLLMContext = z.infer<typeof llmContextSchema>;

// ---------------------------------------------------------------------------
// TTS mode schemas
// ---------------------------------------------------------------------------

/** Cloned voice profile for XTTS voice cloning. */
const clonedVoiceSchema = z.object({
  /** URL to reference WAV file for voice cloning. */
  speakerWavUrl: z.string().min(1),
  /** Friendly name (e.g., "Sarah's Voice"). */
  label: z.string().min(1).optional(),
});

export type RuntimeClonedVoice = z.infer<typeof clonedVoiceSchema>;

/** Voice mode for XTTS: 'preset' uses built-in voice_id, 'cloned' uses reference audio. */
const voiceModeSchema = z.enum(["preset", "cloned"]);

export type RuntimeVoiceMode = z.infer<typeof voiceModeSchema>;

/** Kokoro HTTP TTS config. */
const ttsKokoroSchema = z.object({
  mode: z.literal("kokoro_http"),
  kokoroUrl: z.string().min(1),
  voice: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
  sampleRate: z.number().int().positive().optional(),
});

/** Coqui XTTS config with voice cloning support. */
const ttsCoquiXttsSchema = z.object({
  mode: z.literal("coqui_xtts"),
  coquiXttsUrl: z.string().min(1),
  voice: z.string().min(1).optional(),
  /** Legacy field: use clonedVoice.speakerWavUrl instead. */
  speakerWavUrl: z.string().min(1).optional(),
  clonedVoice: clonedVoiceSchema.optional(),
  /** Default: 'preset'. */
  defaultVoiceMode: voiceModeSchema.optional(),
  language: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
  sampleRate: z.number().int().positive().optional(),
  // XTTS-specific tuning parameters
  coquiTemperature: z.number().min(0).max(2).optional(),
  coquiLengthPenalty: z.number().optional(),
  coquiRepetitionPenalty: z.number().optional(),
  coquiTopK: z.number().int().min(0).optional(),
  coquiTopP: z.number().min(0).max(1).optional(),
  coquiSpeed: z.number().positive().optional(),
  coquiSplitSentences: z.boolean().optional(),
});

export type RuntimeTtsCoquiXtts = z.infer<typeof ttsCoquiXttsSchema>;

/** Combined TTS schema (discriminated union of all modes). */
const ttsSchema = z.discriminatedUnion("mode", [
  ttsKokoroSchema,
  ttsCoquiXttsSchema,
]);

export type RuntimeTtsConfig = z.infer<typeof ttsSchema>;

// ---------------------------------------------------------------------------
// Transfer profiles (LLM call routing)
// ---------------------------------------------------------------------------

const transferProfileSchema = z.object({
  /** Unique id (e.g. "sales") for the LLM to reference. */
  id: z.string().min(1),
  /** Department or position name (e.g. "Sales"). */
  name: z.string().min(1),
  /** Optional: name of the person who holds this role (e.g. "Morgan"). */
  holder: z.string().min(1).optional(),
  /** What this role handles; used by the LLM to match caller intent. */
  responsibilities: z.array(z.string().min(1)).min(1),
  /** E.164 number or SIP URI to transfer to. */
  destination: z.string().min(1),
  /** Optional hold message URL (WAV/MP3) while this transfer destination rings. */
  audioUrl: z.string().url().optional(),
  /** Optional timeout in seconds (5–600) for this destination. */
  timeoutSecs: z.number().int().min(5).max(600).optional(),
});

export type TransferProfile = z.infer<typeof transferProfileSchema>;

// ---------------------------------------------------------------------------
// Call forwarding
// ---------------------------------------------------------------------------

const callForwardingSchema = z.object({
  enabled: z.boolean(),
  /** E.164 number or SIP URI. */
  destination: z.string().min(1),
  /** If true, forward immediately on call.initiated (no AI session). */
  forwardBeforeAnswer: z.boolean().optional(),
  /** WAV/MP3 URL to play while transfer destination rings. */
  audioUrl: z.string().url().optional(),
  /** Timeout in seconds for transfer destination to answer (5–600). */
  timeoutSecs: z.number().int().min(5).max(600).optional(),
});

// ---------------------------------------------------------------------------
// Main RuntimeTenantConfig schema
// ---------------------------------------------------------------------------

const runtimeTenantConfigBaseSchema = z
  .object({
    contractVersion: z.literal("v1"),
    tenantId: z.string().min(1),
    dids: z.array(didSchema).min(1),
    webhookSecretRef: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
    caps: z.object({
      maxConcurrentCallsTenant: z.number().int().positive(),
      maxCallsPerMinuteTenant: z.number().int().positive(),
      maxConcurrentCallsGlobal: z.number().int().positive().optional(),
    }),
    stt: z.object({
      mode: z.enum(["whisper_http", "disabled", "http_wav_json"]),
      whisperUrl: z.string().min(1).optional(),
      chunkMs: z.number().int().positive(),
      language: z.string().min(1).optional(),
      prompt: z.string().optional(),
      config: z
        .object({
          url: z.string().min(1).optional(),
        })
        .optional(),
    }),
    tts: ttsSchema,
    audio: z.object({
      publicBaseUrl: z.string().min(1).optional(),
      storageDir: z.string().min(1).optional(),
      runtimeManaged: z.boolean().optional(),
    }),
    // LLM context: forwarding directory, pricing, and prompts
    llmContext: llmContextSchema.optional(),
    // Call forwarding (bypass AI and transfer immediately)
    callForwarding: callForwardingSchema.optional(),
    // Transfer profiles for LLM routing
    transferProfiles: z.array(transferProfileSchema).optional(),
    /**
     * Freeform context for the assistant (pricing, products, hours, policies, etc.).
     * Keys are section names, values are the text.
     */
    assistantContext: z.record(z.string().min(1)).optional(),
  })
  // passthrough allows the runtime to accept fields added by a newer control plane
  // without breaking validation
  .passthrough();

type RuntimeTenantConfigBase = z.infer<typeof runtimeTenantConfigBaseSchema>;

export const runtimeTenantConfigSchema =
  runtimeTenantConfigBaseSchema.superRefine(
    (val: RuntimeTenantConfigBase, ctx: RefinementCtx) => {
      if (!val.webhookSecretRef && !val.webhookSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "webhookSecretRef or webhookSecret required",
          path: ["webhookSecretRef"],
        });
      }
    }
  );

export type RuntimeTenantConfig = z.infer<typeof runtimeTenantConfigSchema>;

export { runtimeTenantConfigSchema as RuntimeTenantConfigSchema };

export function parseRuntimeTenantConfig(
  input: unknown
): RuntimeTenantConfig {
  return runtimeTenantConfigSchema.parse(input);
}

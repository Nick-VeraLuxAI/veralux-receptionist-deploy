/**
 * Zod validation schemas for API endpoints
 */
import { z } from "zod";

// ────────────────────────────────────────────────
// Common Schemas
// ────────────────────────────────────────────────

export const uuidSchema = z.string().uuid();

export const tenantIdSchema = z.string()
  .min(1, "Tenant ID is required")
  .max(100, "Tenant ID too long")
  .regex(/^[a-zA-Z0-9_-]+$/, "Tenant ID must be alphanumeric with dashes/underscores");

export const phoneNumberSchema = z.string()
  .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164 expected)");

export const urlSchema = z.string().url("Invalid URL format");

export const emailSchema = z.string().email("Invalid email format");

// ────────────────────────────────────────────────
// Tenant Schemas
// ────────────────────────────────────────────────

export const createTenantSchema = z.object({
  id: tenantIdSchema,
  name: z.string().min(1, "Name is required").max(200, "Name too long"),
  numbers: z.array(phoneNumberSchema).optional().default([]),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  numbers: z.array(phoneNumberSchema).optional(),
});

// ────────────────────────────────────────────────
// Config Schemas
// ────────────────────────────────────────────────

export const llmProviderSchema = z.enum(["openai", "local"]);

export const configUpdateSchema = z.object({
  provider: llmProviderSchema.optional(),
  model: z.string().max(100).optional(),
  openaiApiKey: z.string().max(500).optional(),
  localUrl: urlSchema.optional(),
}).passthrough(); // Allow additional fields for backward compatibility

export const promptConfigSchema = z.object({
  systemPreamble: z.string().max(10000).optional(),
  policyPrompt: z.string().max(10000).optional(),
  voicePrompt: z.string().max(5000).optional(),
  schemaHint: z.string().max(5000).optional(),
}).passthrough();

// ────────────────────────────────────────────────
// TTS Config Schemas
// ────────────────────────────────────────────────

export const voicePresetSchema = z.enum(["neutral", "warm", "energetic", "calm"]);

export const ttsModeSchema = z.enum(["kokoro_http", "coqui_xtts"]);

export const voiceModeSchema = z.enum(["preset", "cloned"]);

export const clonedVoiceSchema = z.object({
  speakerWavUrl: urlSchema,
  label: z.string().max(100).optional(),
});

export const ttsConfigSchema = z.object({
  ttsMode: ttsModeSchema.optional(),
  preset: voicePresetSchema.optional(),
  voiceId: z.string().max(100).optional(),
  language: z.string().max(10).optional(),
  rate: z.number().min(0.5).max(2.0).optional(),
  coquiXttsUrl: urlSchema.optional(),
  kokoroUrl: urlSchema.optional(),
  xttsUrl: urlSchema.optional(),
  defaultVoiceMode: voiceModeSchema.optional(),
  clonedVoice: clonedVoiceSchema.optional(),
}).passthrough();

// ────────────────────────────────────────────────
// Forwarding Profile Schemas
// ────────────────────────────────────────────────

export const forwardingProfileSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  number: phoneNumberSchema.optional(),
  role: z.string().max(200).optional(),
});

export const forwardingProfilesSchema = z.object({
  profiles: z.array(forwardingProfileSchema),
});

// ────────────────────────────────────────────────
// Pricing Schemas
// ────────────────────────────────────────────────

export const pricingItemSchema = z.object({
  name: z.string().min(1).max(200),
  price: z.string().max(100),
  description: z.string().max(500).optional(),
});

export const pricingSchema = z.object({
  items: z.array(pricingItemSchema).default([]),
  notes: z.string().max(5000).optional().default(""),
});

// ────────────────────────────────────────────────
// Admin Key Schemas
// ────────────────────────────────────────────────

export const adminRoleSchema = z.enum(["super-admin", "tenant-admin", "tenant-editor", "tenant-viewer"]);

export const createAdminKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  role: adminRoleSchema.optional().default("tenant-viewer"),
  tenantId: tenantIdSchema.optional(),
});

export const revokeAdminKeySchema = z.object({
  keyId: uuidSchema,
});

// ────────────────────────────────────────────────
// Secret Schemas
// ────────────────────────────────────────────────

export const secretSchema = z.object({
  secret: z.string().min(1, "Secret is required").max(1000, "Secret too long"),
});

// ────────────────────────────────────────────────
// Voice Mode Schemas
// ────────────────────────────────────────────────

export const setVoiceModeSchema = z.object({
  mode: voiceModeSchema,
  speakerWavUrl: urlSchema.optional(),
});

// ────────────────────────────────────────────────
// DID Mapping Schemas
// ────────────────────────────────────────────────

export const mapDidSchema = z.object({
  did: phoneNumberSchema,
  tenantId: tenantIdSchema,
});

export const unmapDidSchema = z.object({
  did: phoneNumberSchema,
});

// ────────────────────────────────────────────────
// Pagination Schemas
// ────────────────────────────────────────────────

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ────────────────────────────────────────────────
// Export all schemas for convenience
// ────────────────────────────────────────────────

export const schemas = {
  uuid: uuidSchema,
  tenantId: tenantIdSchema,
  phoneNumber: phoneNumberSchema,
  url: urlSchema,
  email: emailSchema,
  createTenant: createTenantSchema,
  updateTenant: updateTenantSchema,
  configUpdate: configUpdateSchema,
  promptConfig: promptConfigSchema,
  ttsConfig: ttsConfigSchema,
  forwardingProfiles: forwardingProfilesSchema,
  pricing: pricingSchema,
  createAdminKey: createAdminKeySchema,
  revokeAdminKey: revokeAdminKeySchema,
  secret: secretSchema,
  setVoiceMode: setVoiceModeSchema,
  mapDid: mapDidSchema,
  unmapDid: unmapDidSchema,
  pagination: paginationSchema,
};

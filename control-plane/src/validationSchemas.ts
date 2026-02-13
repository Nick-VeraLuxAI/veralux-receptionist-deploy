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
// Workflow Schemas
// ────────────────────────────────────────────────

export const triggerTypeSchema = z.enum([
  "call_ended", "after_hours_call", "keyword_detected", "missed_call", "scheduled",
]);

export const actionTypeSchema = z.enum([
  "send_email", "send_sms", "fire_webhook", "ai_summarize", "ai_extract", "ai_extract_quote", "build_quote", "store_lead",
]);

export const triggerConfigSchema = z.object({
  keywords: z.array(z.string()).optional(),
  cronExpression: z.string().max(100).optional(),
  businessHoursStart: z.string().max(10).optional(),
  businessHoursEnd: z.string().max(10).optional(),
  timezone: z.string().max(50).optional(),
  maxDurationSeconds: z.number().int().min(0).optional(),
  minTurns: z.number().int().min(0).optional(),
}).passthrough();

export const workflowStepSchema = z.object({
  order: z.number().int().min(0),
  action: actionTypeSchema,
  config: z.record(z.any()).default({}),
});

export const createWorkflowSchema = z.object({
  name: z.string().min(1, "Name is required").max(200, "Name too long"),
  triggerType: triggerTypeSchema,
  triggerConfig: triggerConfigSchema.default({}),
  steps: z.array(workflowStepSchema).default([]),
  createdBy: z.string().max(100).optional(),
  adminLocked: z.boolean().default(false),
});

export const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  triggerType: triggerTypeSchema.optional(),
  triggerConfig: triggerConfigSchema.optional(),
  steps: z.array(workflowStepSchema).optional(),
  adminLocked: z.boolean().optional(),
});

export const workflowSettingsSchema = z.object({
  ownerCanEdit: z.boolean().optional(),
});

// ────────────────────────────────────────────────
// Subscription Schemas
// ────────────────────────────────────────────────

export const subscriptionSchema = z.object({
  planId: z.string().min(1).max(100).optional(),
  status: z.enum(["active", "trialing", "past_due", "canceled", "none"]).optional(),
  showBillingPortal: z.boolean().optional(),
  adminNotes: z.string().max(5000).optional(),
}).passthrough();

// ────────────────────────────────────────────────
// Capacity Schemas
// ────────────────────────────────────────────────

export const capacitySchema = z.object({
  maxConcurrentCalls: z.number().int().min(1).max(1000).optional(),
  maxCallDurationMs: z.number().int().min(60000).max(7200000).optional(),
  maxCallsPerHour: z.number().int().min(1).max(10000).optional(),
}).passthrough();

// ────────────────────────────────────────────────
// Telnyx Schemas
// ────────────────────────────────────────────────

export const telnyxProvisionSchema = z.object({
  phone_number: phoneNumberSchema,
  connection_id: z.string().optional(),
});

export const telnyxPurchaseSchema = z.object({
  phone_number: phoneNumberSchema,
  connection_id: z.string().optional(),
});

export const telnyxSearchSchema = z.object({
  country: z.string().length(2).optional().default("US"),
  state: z.string().max(50).optional(),
  city: z.string().max(100).optional(),
  contains: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

// ────────────────────────────────────────────────
// Stripe Checkout Schemas
// ────────────────────────────────────────────────

export const stripeCheckoutSchema = z.object({
  planId: z.string().min(1, "Plan ID is required"),
  successUrl: urlSchema.optional(),
  cancelUrl: urlSchema.optional(),
});

export const stripePlanSchema = z.object({
  name: z.string().min(1).max(200),
  stripePriceId: z.string().min(1).max(200),
  monthlyPrice: z.number().min(0),
  features: z.array(z.string().max(500)).optional().default([]),
  maxCalls: z.number().int().min(0).optional(),
  maxNumbers: z.number().int().min(0).optional(),
});

// ────────────────────────────────────────────────
// Runtime Analytics / Calls Schemas
// ────────────────────────────────────────────────

export const runtimeAnalyticsSchema = z.object({
  tenantId: tenantIdSchema,
  event: z.string().min(1).max(100),
  text: z.string().max(50000).optional(),
  meta: z.record(z.any()).optional(),
});

export const runtimeCallSchema = z.object({
  tenantId: tenantIdSchema,
  callId: z.string().min(1).max(200),
  action: z.string().min(1).max(100),
  callState: z.record(z.any()).optional(),
});

// ────────────────────────────────────────────────
// Cloudflare Token Schema
// ────────────────────────────────────────────────

export const cloudflareTokenSchema = z.object({
  token: z.string().min(1, "Token is required").max(500, "Token too long"),
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
  createWorkflow: createWorkflowSchema,
  updateWorkflow: updateWorkflowSchema,
  workflowSettings: workflowSettingsSchema,
  subscription: subscriptionSchema,
  capacity: capacitySchema,
  telnyxProvision: telnyxProvisionSchema,
  telnyxPurchase: telnyxPurchaseSchema,
  telnyxSearch: telnyxSearchSchema,
  stripeCheckout: stripeCheckoutSchema,
  stripePlan: stripePlanSchema,
  runtimeAnalytics: runtimeAnalyticsSchema,
  runtimeCall: runtimeCallSchema,
  cloudflareToken: cloudflareTokenSchema,
};

/**
 * Re-exports from the shared contract package.
 * All schema definitions live in @veralux/shared — edit there, not here.
 */
export {
  E164_REGEX,
  normalizeE164,
  runtimeTenantConfigSchema,
  RuntimeTenantConfigSchema,
  parseRuntimeTenantConfig,
  type RuntimeTenantConfig,
  type RuntimeForwardingProfile,
  type RuntimePricingInfo,
  type RuntimePromptConfig,
  type RuntimeLLMContext,
  type RuntimeClonedVoice,
  type RuntimeVoiceMode,
  type RuntimeTtsCoquiXtts,
  type RuntimeTtsConfig,
  type TransferProfile,
} from "@veralux/shared";

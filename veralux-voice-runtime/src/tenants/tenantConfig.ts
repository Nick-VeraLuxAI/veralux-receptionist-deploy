/**
 * Tenant configuration for the voice runtime.
 *
 * The schema itself lives in @veralux/shared (single source of truth).
 * This module re-exports the schema types and adds runtime-specific helpers
 * (secret resolution, Redis loading, voice mode helpers).
 */
import { z } from 'zod';
import { env } from '../env';
import { log } from '../log';
import { getRedisClient, RedisClient } from '../redis/client';

// ── Re-export schema & types from shared package ────────────────────────────
export {
  runtimeTenantConfigSchema,
  RuntimeTenantConfigSchema,
  parseRuntimeTenantConfig,
  normalizeE164,
  E164_REGEX,
  type RuntimeTenantConfig,
  type RuntimeTtsConfig,
  type RuntimeTtsCoquiXtts,
  type RuntimeClonedVoice,
  type RuntimeVoiceMode,
  type RuntimeForwardingProfile,
  type RuntimePricingInfo,
  type RuntimePromptConfig,
  type RuntimeLLMContext,
  type TransferProfile,
} from '@veralux/shared';

import type { RuntimeTenantConfig } from '@veralux/shared';
import { RuntimeTenantConfigSchema } from '@veralux/shared';

// ── Voice mode helpers ──────────────────────────────────────────────────────

/** Voice mode for XTTS: 'preset' uses built-in voice_id, 'cloned' uses reference audio. */
export type VoiceMode = 'preset' | 'cloned';

/** Cloned voice profile for XTTS voice cloning. */
export type ClonedVoiceProfile = {
  speakerWavUrl: string;
  label?: string;
};

/**
 * Helper to get the effective speakerWavUrl based on voice mode.
 * Returns undefined for 'preset' mode (uses voice_id), or the cloned voice URL for 'cloned' mode.
 */
export function getEffectiveSpeakerWavUrl(
  ttsConfig: RuntimeTenantConfig['tts'] | undefined,
  voiceMode: VoiceMode,
): string | undefined {
  if (!ttsConfig || ttsConfig.mode !== 'coqui_xtts') {
    return undefined;
  }

  if (voiceMode === 'cloned') {
    // Use cloned voice if available, otherwise fall back to legacy speakerWavUrl
    return ttsConfig.clonedVoice?.speakerWavUrl ?? ttsConfig.speakerWavUrl;
  }

  // preset mode: no speakerWavUrl, use voice_id
  return undefined;
}

// ── Secret resolution ───────────────────────────────────────────────────────

/**
 * Resolve a secret reference to its actual value.
 * Supported formats:
 * - `env:VAR_NAME` — reads from process.env.VAR_NAME
 * - Any other string — returned as-is (assumed to be a literal secret, for backwards compat)
 */
export function resolveSecretRef(ref: string): string | null {
  if (ref.startsWith('env:')) {
    const envVar = ref.slice(4);
    const value = process.env[envVar];
    if (!value || value.trim() === '') {
      log.warn({ ref, envVar }, 'secret ref env var is empty or missing');
      return null;
    }
    return value;
  }
  // Treat as literal secret (backwards compat)
  return ref;
}

/**
 * Get the resolved webhook secret from a tenant config.
 * Prefers webhookSecret (plaintext) if set; otherwise resolves webhookSecretRef.
 */
export function getWebhookSecret(config: RuntimeTenantConfig): string | null {
  if (config.webhookSecret) {
    return config.webhookSecret;
  }
  if (config.webhookSecretRef) {
    return resolveSecretRef(config.webhookSecretRef);
  }
  return null;
}

// ── Redis tenant config loading ─────────────────────────────────────────────

export function buildTenantConfigKey(tenantId: string): string {
  return `${env.TENANTCFG_PREFIX}:${tenantId}`;
}

export async function loadTenantConfig(
  tenantId: string,
  redis: RedisClient = getRedisClient(),
): Promise<RuntimeTenantConfig | null> {
  const key = buildTenantConfigKey(tenantId);
  let raw: string | null;

  try {
    raw = await redis.get(key);
  } catch (error) {
    log.error({ err: error, tenant_id: tenantId, key }, 'tenant config fetch failed');
    return null;
  }

  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.error({ err: error, tenant_id: tenantId, key }, 'tenant config json parse failed');
    return null;
  }

  const result = RuntimeTenantConfigSchema.safeParse(parsed);
  if (!result.success) {
    log.error({ tenant_id: tenantId, key, issues: result.error.issues }, 'tenant config invalid');
    return null;
  }

  return result.data;
}

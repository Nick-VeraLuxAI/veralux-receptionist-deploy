// src/capacityGuard.ts
type TenantId = string;

import { tryAcquireLimit, releaseLimit } from "../redis";

const MAX_ACTIVE_CALLS = Number(process.env.MAX_ACTIVE_CALLS ?? 30);
const TENANT_MAX_CONCURRENT = Number(process.env.TENANT_MAX_CONCURRENT_CALLS ?? 5);
const TENANT_MAX_CALLS_PER_MIN = Number(process.env.TENANT_MAX_CALLS_PER_MINUTE ?? 10);

const callStartTimes = new Map<string, number>();
const callTenantById = new Map<string, TenantId>(); // allows TTL cleanup to release capacity

const CALL_TTL_MS = Number(process.env.CALL_TTL_MS ?? 30 * 60_000);

// Redis keys
const keyGlobal = () => `cap:global`;
const keyTenant = (tenantId: string) => `cap:tenant:${tenantId}`;
const keyTenantMin = (tenantId: string) => `cap:tenant_min:${tenantId}`;

type CapacityFailCode = "system_at_capacity" | "tenant_at_capacity" | "rate_limited";

/**
 * Reserve capacity for a call.
 * NOTE: callId must be the internal UUID (never Telnyx call_control_id).
 * NOTE: async because Redis.
 */
export async function reserveCallCapacity(args: { tenantId: string; callId: string }) {
  const { tenantId, callId } = args;

  const ttlSeconds = Math.max(60, Math.ceil(CALL_TTL_MS / 1000)); // keep counters from leaking forever
  const perMinTtlSeconds = 60;

  // 1) calls/min per tenant (rate limit window)
  const okPerMin = await tryAcquireLimit(keyTenantMin(tenantId), TENANT_MAX_CALLS_PER_MIN, perMinTtlSeconds);
  if (!okPerMin) {
    return { ok: false as const, code: "rate_limited" as const };
  }

  // 2) concurrent per tenant
  const okTenant = await tryAcquireLimit(keyTenant(tenantId), TENANT_MAX_CONCURRENT, ttlSeconds);
  if (!okTenant) {
    // undo per-minute slot so behavior stays fair
    await releaseLimit(keyTenantMin(tenantId));
    return { ok: false as const, code: "tenant_at_capacity" as const };
  }

  // 3) global concurrent
  const okGlobal = await tryAcquireLimit(keyGlobal(), MAX_ACTIVE_CALLS, ttlSeconds);
  if (!okGlobal) {
    // undo previous reservations
    await releaseLimit(keyTenant(tenantId));
    await releaseLimit(keyTenantMin(tenantId));
    return { ok: false as const, code: "system_at_capacity" as const };
  }

  // track for TTL failsafe cleanup
  callTenantById.set(callId, tenantId);

  return { ok: true as const };
}

/**
 * Release capacity for a call.
 * NOTE: async because Redis.
 */
export async function releaseCallCapacity(args: { tenantId: string; callId: string }) {
  const { tenantId, callId } = args;

  // concurrent counters only; per-minute key should expire naturally
  await releaseLimit(keyGlobal());
  await releaseLimit(keyTenant(tenantId));

  callStartTimes.delete(callId);
  callTenantById.delete(callId);
}

// callId must be the internal UUID (never Telnyx call_control_id).
export function markCallStarted(callId: string, tenantId?: string) {
  callStartTimes.set(callId, Date.now());
  if (tenantId) callTenantById.set(callId, tenantId);
}

// TTL failsafe (prevents capacity leaks if "end" never arrives)
setInterval(() => {
  const now = Date.now();
  for (const [callId, startedAt] of callStartTimes.entries()) {
    if (now - startedAt > CALL_TTL_MS) {
      const tenantId = callTenantById.get(callId);

      // Best-effort release if we know tenantId
      if (tenantId) {
        void releaseCallCapacity({ tenantId, callId }).catch(() => {});
      }

      callStartTimes.delete(callId);
      callTenantById.delete(callId);
    }
  }
}, 60_000).unref();

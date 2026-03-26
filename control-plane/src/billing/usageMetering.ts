/**
 * Usage Metering & Subscription Enforcement
 *
 * Tracks per-tenant usage (calls, minutes, API requests) and enforces
 * subscription limits. Usage data is reported to Stripe for metered billing.
 */

import { pool } from "../db";

// ── Types ────────────────────────────────────────────

export interface TenantUsage {
  tenantId: string;
  period: string; // YYYY-MM
  callCount: number;
  callMinutes: number;
  apiRequests: number;
  sttMinutes: number;
  ttsCharacters: number;
  updatedAt: string;
}

export interface UsageLimits {
  maxCallsPerMonth: number;
  maxCallMinutesPerMonth: number;
  maxApiRequestsPerMonth: number;
  maxNumbers: number;
}

export interface SubscriptionStatus {
  status: string;
  planName: string | null;
  usage: TenantUsage | null;
  limits: UsageLimits;
  isActive: boolean;
  isOverLimit: boolean;
  overLimitReasons: string[];
}

// ── Default Limits by Plan ───────────────────────────

const PLAN_LIMITS: Record<string, UsageLimits> = {
  free: {
    maxCallsPerMonth: 50,
    maxCallMinutesPerMonth: 100,
    maxApiRequestsPerMonth: 1000,
    maxNumbers: 1,
  },
  starter: {
    maxCallsPerMonth: 500,
    maxCallMinutesPerMonth: 1000,
    maxApiRequestsPerMonth: 10000,
    maxNumbers: 2,
  },
  professional: {
    maxCallsPerMonth: 5000,
    maxCallMinutesPerMonth: 10000,
    maxApiRequestsPerMonth: 100000,
    maxNumbers: 5,
  },
  enterprise: {
    maxCallsPerMonth: -1, // unlimited
    maxCallMinutesPerMonth: -1,
    maxApiRequestsPerMonth: -1,
    maxNumbers: -1,
  },
  // On-prem / single-tenant = unlimited
  onprem: {
    maxCallsPerMonth: -1,
    maxCallMinutesPerMonth: -1,
    maxApiRequestsPerMonth: -1,
    maxNumbers: -1,
  },
};

const DEFAULT_LIMITS = PLAN_LIMITS.free;

// ── Usage Tracking ───────────────────────────────────

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Increment a usage counter for a tenant.
 */
export async function incrementUsage(
  tenantId: string,
  metric: "call_count" | "call_minutes" | "api_requests" | "stt_minutes" | "tts_characters",
  amount: number = 1
): Promise<void> {
  const period = currentPeriod();
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO tenant_usage (tenant_id, period, ${metric})
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, period)
       DO UPDATE SET ${metric} = tenant_usage.${metric} + $3, updated_at = now()`,
      [tenantId, period, amount]
    );
  } finally {
    client.release();
  }
}

/**
 * Get current usage for a tenant.
 */
export async function getUsage(tenantId: string): Promise<TenantUsage | null> {
  const period = currentPeriod();
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM tenant_usage WHERE tenant_id = $1 AND period = $2",
      [tenantId, period]
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      tenantId: r.tenant_id,
      period: r.period,
      callCount: r.call_count || 0,
      callMinutes: r.call_minutes || 0,
      apiRequests: r.api_requests || 0,
      sttMinutes: r.stt_minutes || 0,
      ttsCharacters: r.tts_characters || 0,
      updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
    };
  } finally {
    client.release();
  }
}

/**
 * Get usage history for a tenant.
 */
export async function getUsageHistory(
  tenantId: string,
  monthsBack: number = 6
): Promise<TenantUsage[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM tenant_usage
       WHERE tenant_id = $1
       ORDER BY period DESC
       LIMIT $2`,
      [tenantId, monthsBack]
    );
    return res.rows.map((r: any) => ({
      tenantId: r.tenant_id,
      period: r.period,
      callCount: r.call_count || 0,
      callMinutes: r.call_minutes || 0,
      apiRequests: r.api_requests || 0,
      sttMinutes: r.stt_minutes || 0,
      ttsCharacters: r.tts_characters || 0,
      updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
    }));
  } finally {
    client.release();
  }
}

// ── Subscription Enforcement ─────────────────────────

/**
 * Get usage limits for a tenant based on their subscription plan.
 */
export async function getLimitsForTenant(tenantId: string): Promise<UsageLimits> {
  const isSaas = (process.env.SAAS_MODE || "false").toLowerCase() === "true";
  if (!isSaas) return PLAN_LIMITS.onprem;

  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT plan_name, status FROM tenant_subscriptions WHERE tenant_id = $1",
      [tenantId]
    );
    if (!res.rows[0]) return DEFAULT_LIMITS;
    const plan = (res.rows[0].plan_name || "free").toLowerCase();
    return PLAN_LIMITS[plan] || DEFAULT_LIMITS;
  } finally {
    client.release();
  }
}

/**
 * Check if a tenant has exceeded their usage limits.
 */
export async function checkUsageLimits(tenantId: string): Promise<SubscriptionStatus> {
  const isSaas = (process.env.SAAS_MODE || "false").toLowerCase() === "true";

  if (!isSaas) {
    return {
      status: "active",
      planName: "on-premise",
      usage: null,
      limits: PLAN_LIMITS.onprem,
      isActive: true,
      isOverLimit: false,
      overLimitReasons: [],
    };
  }

  const client = await pool.connect();
  try {
    // Get subscription
    const subRes = await client.query(
      "SELECT status, plan_name FROM tenant_subscriptions WHERE tenant_id = $1",
      [tenantId]
    );
    const sub = subRes.rows[0];
    const status = sub?.status || "none";
    const planName = sub?.plan_name || "free";
    const isActive = ["active", "trialing", "trial"].includes(status);

    // Get usage
    const usage = await getUsage(tenantId);
    const limits = await getLimitsForTenant(tenantId);

    // Check limits (skip if unlimited = -1)
    const overLimitReasons: string[] = [];
    if (limits.maxCallsPerMonth > 0 && (usage?.callCount || 0) >= limits.maxCallsPerMonth) {
      overLimitReasons.push(`Monthly call limit reached (${limits.maxCallsPerMonth})`);
    }
    if (limits.maxCallMinutesPerMonth > 0 && (usage?.callMinutes || 0) >= limits.maxCallMinutesPerMonth) {
      overLimitReasons.push(`Monthly call minutes limit reached (${limits.maxCallMinutesPerMonth})`);
    }
    if (limits.maxApiRequestsPerMonth > 0 && (usage?.apiRequests || 0) >= limits.maxApiRequestsPerMonth) {
      overLimitReasons.push(`Monthly API request limit reached (${limits.maxApiRequestsPerMonth})`);
    }

    return {
      status,
      planName,
      usage,
      limits,
      isActive,
      isOverLimit: overLimitReasons.length > 0,
      overLimitReasons,
    };
  } finally {
    client.release();
  }
}

/**
 * Middleware-compatible check: can this tenant accept a new call?
 */
export async function canAcceptCall(tenantId: string): Promise<{ allowed: boolean; reason?: string }> {
  const status = await checkUsageLimits(tenantId);

  if (!status.isActive) {
    return { allowed: false, reason: `Subscription is ${status.status}` };
  }

  if (status.isOverLimit) {
    return { allowed: false, reason: status.overLimitReasons[0] };
  }

  return { allowed: true };
}

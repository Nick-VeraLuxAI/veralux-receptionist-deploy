// src/redis.ts
import { createClient } from "redis";

type Json = any;

// Let TypeScript infer the exact client type (avoids RESP2/RESP3 generic mismatches)
type Client = ReturnType<typeof createClient>;

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

// In-memory fallback (used when REDIS_URL is not set)
const mem = new Map<string, { value: string; expiresAt?: number }>();

function nowMs() {
  return Date.now();
}

function memGet(key: string): string | null {
  const item = mem.get(key);
  if (!item) return null;
  if (item.expiresAt && item.expiresAt <= nowMs()) {
    mem.delete(key);
    return null;
  }
  return item.value;
}

function memSet(key: string, value: string, ttlSeconds?: number) {
  const expiresAt =
    ttlSeconds && ttlSeconds > 0 ? nowMs() + ttlSeconds * 1000 : undefined;
  mem.set(key, { value, expiresAt });
}

function memDel(key: string) {
  mem.delete(key);
}

function memIncr(key: string): number {
  const current = memGet(key);
  const n = current ? parseInt(current, 10) : 0;
  const next = Number.isFinite(n) ? n + 1 : 1;
  memSet(key, String(next));
  return next;
}

function memDecr(key: string): number {
  const current = memGet(key);
  const n = current ? parseInt(current, 10) : 0;
  const next = Number.isFinite(n) ? n - 1 : -1;
  memSet(key, String(next));
  return next;
}

function hasRedisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

async function getClient(): Promise<Client> {
  if (!hasRedisEnabled()) {
    throw new Error("Redis disabled (REDIS_URL not set)");
  }
  if (client) return client;
  if (connecting) return connecting;

  const url = process.env.REDIS_URL!;
  const c = createClient({ url });

  connecting = (async () => {
    c.on("error", (err) => {
      // Don't crash process; surface in logs
      console.error("[redis] error", err);
    });
    await c.connect();
    client = c;
    return c;
  })();

  return connecting;
}

// -------------------- Public API --------------------

export async function get(key: string): Promise<string | null> {
  if (!hasRedisEnabled()) return memGet(key);
  const c = await getClient();
  return await c.get(key);
}

export async function set(
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<void> {
  if (!hasRedisEnabled()) {
    memSet(key, value, ttlSeconds);
    return;
  }
  const c = await getClient();
  if (ttlSeconds && ttlSeconds > 0) {
    await c.set(key, value, { EX: ttlSeconds });
  } else {
    await c.set(key, value);
  }
}

export async function del(key: string): Promise<void> {
  if (!hasRedisEnabled()) {
    memDel(key);
    return;
  }
  const c = await getClient();
  await c.del(key);
}

export async function getJSON<T = Json>(key: string): Promise<T | null> {
  const raw = await get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJSON(
  key: string,
  value: Json,
  ttlSeconds?: number
): Promise<void> {
  await set(key, JSON.stringify(value), ttlSeconds);
}

export async function incr(key: string): Promise<number> {
  if (!hasRedisEnabled()) return memIncr(key);
  const c = await getClient();
  return await c.incr(key);
}

export async function decr(key: string): Promise<number> {
  if (!hasRedisEnabled()) return memDecr(key);
  const c = await getClient();
  return await c.decr(key);
}

export interface RateLimitResult {
  acquired: boolean;
  remaining: number;
}

/**
 * Atomic "check then increment" limiter.
 * Returns { acquired: true, remaining: N } if you acquired a slot.
 * Returns { acquired: false, remaining: 0 } if at/over limit.
 * If acquired, you MUST call releaseLimit() later.
 */
export async function tryAcquireLimit(
  key: string,
  limit: number,
  ttlSeconds?: number
): Promise<RateLimitResult> {
  if (limit <= 0) return { acquired: false, remaining: 0 };

  if (!hasRedisEnabled()) {
    const next = memIncr(key);
    if (ttlSeconds && ttlSeconds > 0) {
      const raw = memGet(key);
      if (raw !== null) memSet(key, raw, ttlSeconds);
    }
    if (next > limit) {
      memDecr(key);
      return { acquired: false, remaining: 0 };
    }
    return { acquired: true, remaining: limit - next };
  }

  const c = await getClient();

  // Lua script: increment; if first set TTL; if over limit then decrement and fail
  // Returns [acquired (0/1), current_count]
  const script = `
    local v = redis.call("INCR", KEYS[1])
    if v == 1 and tonumber(ARGV[2]) > 0 then
      redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
    end
    if v > tonumber(ARGV[1]) then
      redis.call("DECR", KEYS[1])
      return {0, v - 1}
    end
    return {1, v}
  `;

  const result = (await c.eval(script, {
    keys: [key],
    arguments: [String(limit), String(ttlSeconds ?? 0)],
  })) as [number, number];

  const [ok, current] = result;
  return { 
    acquired: ok === 1, 
    remaining: Math.max(0, limit - current) 
  };
}

/**
 * Get the remaining rate limit for a key without incrementing
 */
export async function getRemainingLimit(key: string, limit: number): Promise<number> {
  if (!hasRedisEnabled()) {
    const raw = memGet(key);
    const current = raw ? parseInt(raw, 10) : 0;
    return Math.max(0, limit - current);
  }
  const c = await getClient();
  const raw = await c.get(key);
  const current = raw ? parseInt(raw, 10) : 0;
  return Math.max(0, limit - current);
}

export async function releaseLimit(key: string): Promise<void> {
  if (!hasRedisEnabled()) {
    const next = memDecr(key);
    if (next <= 0) memDel(key);
    return;
  }
  const c = await getClient();
  const v = await c.decr(key);
  if (v <= 0) await c.del(key);
}

/**
 * Health check for Redis connectivity
 */
export async function healthcheckRedis(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!hasRedisEnabled()) {
    return { ok: true, latencyMs: 0 }; // In-memory always "healthy"
  }
  
  const start = Date.now();
  try {
    const c = await getClient();
    await c.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { 
      ok: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } finally {
    client = null;
    connecting = null;
  }
}

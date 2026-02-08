import { createClient } from "redis";
import {
  normalizeE164,
  parseRuntimeTenantConfig,
  type RuntimeTenantConfig,
} from "./runtimeContract";

type RedisClient = ReturnType<typeof createClient>;

export type RedisKv = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
  ping?: () => Promise<string>;
};

export type RuntimePublisher = {
  mapDidToTenant: (didE164: string, tenantId: string) => Promise<void>;
  unmapDid: (didE164: string) => Promise<void>;
  publishTenantConfig: (
    tenantId: string,
    config: RuntimeTenantConfig
  ) => Promise<void>;
  getTenantConfig: (tenantId: string) => Promise<RuntimeTenantConfig | null>;
  getTenantForDid: (didE164: string) => Promise<string | null>;
  healthcheckRedis: () => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
};

let client: RedisClient | null = null;
let connecting: Promise<RedisClient> | null = null;
let cachedPublisher: RuntimePublisher | null = null;

function didKey(didE164: string) {
  const normalized = normalizeE164(didE164);
  if (normalized !== didE164) {
    console.debug("[runtime-redis] normalized DID", {
      original: didE164,
      normalized,
    });
  }
  return `tenantmap:did:${normalized}`;
}

function cfgKey(tenantId: string) {
  return `tenantcfg:${tenantId}`;
}

export function assertRuntimeRedisConfigured(): void {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is required for runtime config publishing");
  }
}

async function getClient(): Promise<RedisClient> {
  assertRuntimeRedisConfigured();
  if (client) return client;
  if (connecting) return connecting;

  const url = process.env.REDIS_URL as string;
  const c = createClient({ url });

  connecting = (async () => {
    c.on("error", (err) => {
      console.error("[runtime-redis] error", err);
    });
    await c.connect();
    client = c;
    return c;
  })();

  return connecting;
}

export function createRuntimePublisher(redis: RedisKv): RuntimePublisher {
  return {
    mapDidToTenant: async (didE164, tenantId) => {
      await redis.set(didKey(didE164), tenantId);
    },
    unmapDid: async (didE164) => {
      await redis.del(didKey(didE164));
    },
    publishTenantConfig: async (tenantId, config) => {
      await redis.set(cfgKey(tenantId), JSON.stringify(config));
    },
    getTenantConfig: async (tenantId) => {
      const raw = await redis.get(cfgKey(tenantId));
      if (!raw) return null;
      return parseRuntimeTenantConfig(JSON.parse(raw));
    },
    getTenantForDid: async (didE164) => {
      return await redis.get(didKey(didE164));
    },
    healthcheckRedis: async () => {
      const start = Date.now();
      try {
        if (redis.ping) {
          const resp = await redis.ping();
          return { ok: resp === "PONG" || resp === "OK", latencyMs: Date.now() - start };
        }
        await redis.get("runtime:healthcheck");
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}

async function getPublisher(): Promise<RuntimePublisher> {
  if (cachedPublisher) return cachedPublisher;
  const redis = await getClient();
  cachedPublisher = createRuntimePublisher(redis);
  return cachedPublisher;
}

export async function mapDidToTenant(
  didE164: string,
  tenantId: string
): Promise<void> {
  const publisher = await getPublisher();
  await publisher.mapDidToTenant(didE164, tenantId);
}

export async function unmapDid(didE164: string): Promise<void> {
  const publisher = await getPublisher();
  await publisher.unmapDid(didE164);
}

export async function publishTenantConfig(
  tenantId: string,
  config: RuntimeTenantConfig
): Promise<void> {
  const publisher = await getPublisher();
  await publisher.publishTenantConfig(tenantId, config);
}

export async function getTenantConfig(
  tenantId: string
): Promise<RuntimeTenantConfig | null> {
  const publisher = await getPublisher();
  return await publisher.getTenantConfig(tenantId);
}

export async function getTenantForDid(
  didE164: string
): Promise<string | null> {
  const publisher = await getPublisher();
  return await publisher.getTenantForDid(didE164);
}

export async function healthcheckRedis(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const publisher = await getPublisher();
  return await publisher.healthcheckRedis();
}

export async function closeRuntimeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } finally {
    client = null;
    connecting = null;
    cachedPublisher = null;
  }
}

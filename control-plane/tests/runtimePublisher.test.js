const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimePublisher } = require("../dist/runtime/runtimePublisher");

function createMockRedis() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async del(key) {
      store.delete(key);
    },
    async ping() {
      return "PONG";
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    contractVersion: "v1",
    tenantId: "tenantA",
    dids: ["+15551234567"],
    webhookSecretRef: "secrets/tenantA/telnyx",
    caps: {
      maxConcurrentCallsTenant: 10,
      maxCallsPerMinuteTenant: 60,
    },
    stt: {
      mode: "whisper_http",
      whisperUrl: "http://localhost:9000/transcribe",
      chunkMs: 500,
    },
    tts: {
      mode: "kokoro_http",
      kokoroUrl: "http://localhost:7001/tts",
    },
    audio: {
      publicBaseUrl: "http://localhost:4000/audio",
      runtimeManaged: true,
    },
    ...overrides,
  };
}

test("runtimePublisher maps and unmaps DIDs", async () => {
  const publisher = createRuntimePublisher(createMockRedis());

  await publisher.mapDidToTenant("+15551234567", "tenantA");
  const found = await publisher.getTenantForDid("+15551234567");
  assert.equal(found, "tenantA");

  await publisher.unmapDid("+15551234567");
  const removed = await publisher.getTenantForDid("+15551234567");
  assert.equal(removed, null);
});

test("runtimePublisher normalizes DID keys", async () => {
  const calls = [];
  const redis = {
    async get(key) {
      calls.push({ op: "get", key });
      return null;
    },
    async set(key, value) {
      calls.push({ op: "set", key, value });
    },
    async del(key) {
      calls.push({ op: "del", key });
    },
  };
  const publisher = createRuntimePublisher(redis);

  await publisher.mapDidToTenant("+1 555 123 4567", "tenantA");
  await publisher.unmapDid("+1 555 123 4567");

  const setKey = calls.find((call) => call.op === "set")?.key;
  const delKey = calls.find((call) => call.op === "del")?.key;

  assert.equal(setKey, "tenantmap:did:+15551234567");
  assert.equal(delKey, "tenantmap:did:+15551234567");
  assert.ok(!String(setKey).includes(" "));
  assert.ok(!String(delKey).includes(" "));
});

test("runtimePublisher publishes and reads tenant config", async () => {
  const publisher = createRuntimePublisher(createMockRedis());
  const config = baseConfig();

  await publisher.publishTenantConfig("tenantA", config);
  const loaded = await publisher.getTenantConfig("tenantA");

  assert.deepEqual(loaded, config);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRuntimeTenantConfig, normalizeE164 } = require("../dist/runtime/runtimeContract");

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

test("runtimeContract accepts a valid config", () => {
  const parsed = parseRuntimeTenantConfig(baseConfig());
  assert.equal(parsed.tenantId, "tenantA");
  assert.equal(parsed.contractVersion, "v1");
});

test("runtimeContract rejects missing webhook secret", () => {
  const cfg = baseConfig({ webhookSecretRef: undefined });
  delete cfg.webhookSecretRef;
  assert.throws(() => parseRuntimeTenantConfig(cfg));
});

test("runtimeContract rejects invalid E.164 DID", () => {
  const cfg = baseConfig({ dids: ["12345"] });
  assert.throws(() => parseRuntimeTenantConfig(cfg));
});

test("normalizeE164 accepts valid E.164", () => {
  assert.equal(normalizeE164("+15551234567"), "+15551234567");
  assert.equal(normalizeE164("  +44 20 7946 0958  "), "+442079460958");
});

test("normalizeE164 throws on empty", () => {
  assert.throws(() => normalizeE164(""), /did_empty/);
  assert.throws(() => normalizeE164("   "), /did_empty/);
});

test("normalizeE164 throws on invalid format", () => {
  assert.throws(() => normalizeE164("12345"), /invalid_e164/);
  assert.throws(() => normalizeE164("15551234567"), /invalid_e164/);
});

import crypto from "crypto";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:4000";

/**
 * Admin auth (JWT-only expected)
 */
const ADMIN_BEARER = (process.env.ADMIN_BEARER || "").trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || process.env.ADMIN_API_KEY || "").trim();

/**
 * Telephony secrets (match Stage2 smoke defaults)
 */
const TELE_SECRET_A = (
  process.env.TELE_SECRET_A ||
  process.env.SIGNING_SECRET ||
  "stage2-secret-A"
).trim();

/**
 * Tenant numbers (match Stage2 smoke defaults)
 * IMPORTANT: this number MUST match what you upsert into tenantA.
 */
const TENANT_A_NUMBER = (process.env.TENANT_A_NUMBER || "+15551234567").trim();
const FROM_NUMBER = (process.env.FROM_NUMBER || "+15555550199").trim();

/**
 * Tests
 */
const PARALLEL_STARTS = Number(process.env.PARALLEL_STARTS || 40);
const ONLY = (process.env.ONLY || "all").toLowerCase();
const WAIT_BEFORE_MS = Number(process.env.WAIT_BEFORE_MS || 0);
const START_SPACING_MS = Number(process.env.START_SPACING_MS || 150);

/**
 * Realism knobs
 * - HOLD_CALL_MS: keep calls "active" before ending them so concurrency tests are meaningful
 * - INITIAL_MESSAGE: default empty to avoid kicking off heavy receptionist/LLM work during capacity tests
 */
const HOLD_CALL_MS = Number(process.env.HOLD_CALL_MS || 0);
const INITIAL_MESSAGE = (process.env.INITIAL_MESSAGE || "").toString(); // default: ""

const TENANT_MAX_CONCURRENT_CALLS = Number(process.env.TENANT_MAX_CONCURRENT_CALLS || 5);
const TENANT_MAX_CALLS_PER_MINUTE = Number(process.env.TENANT_MAX_CALLS_PER_MINUTE || 10);
const MAX_ACTIVE_CALLS = Number(process.env.MAX_ACTIVE_CALLS || 30);

const MSG_COUNT = Number(process.env.MSG_COUNT || 50);

/**
 * End-call batch sizing (avoid spiking your own rate limits while ending)
 */
const END_BATCH = Number(process.env.END_BATCH || 10);
const END_BATCH_PAUSE_MS = Number(process.env.END_BATCH_PAUSE_MS || 250);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function applyAdminAuth(headers) {
  if (ADMIN_BEARER) headers["Authorization"] = ADMIN_BEARER;
  else if (ADMIN_KEY) headers["x-admin-key"] = ADMIN_KEY;
  else throw new Error("Missing ADMIN_BEARER (preferred) or ADMIN_KEY");
}

function signRawBody(rawBodyBuf, secret) {
  const h = crypto.createHmac("sha256", secret);
  h.update(rawBodyBuf);
  return h.digest("hex"); // server accepts hex; also accepts "sha256=<hex>"
}

async function post(path, bodyObj, opts = {}) {
  const { admin = false, signSecret = null } = opts;

  // IMPORTANT: we must sign the EXACT bytes we send
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
  const headers = { "content-type": "application/json" };

  if (admin) {
    applyAdminAuth(headers);
  } else if (signSecret) {
    headers["x-signature"] = signRawBody(raw, signSecret);
  }

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: raw,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  } catch (err) {
    return {
      status: 0,
      json: { error: "fetch_failed", message: err?.message || String(err) },
    };
  }
}

async function get(path, opts = {}) {
  const { admin = false } = opts;
  const headers = {};
  if (admin) applyAdminAuth(headers);

  try {
    const res = await fetch(`${BASE_URL}${path}`, { method: "GET", headers });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  } catch (err) {
    return {
      status: 0,
      json: { error: "fetch_failed", message: err?.message || String(err) },
    };
  }
}

function statusCounts(results) {
  return results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
}

function firstNon200(results) {
  return results.find((r) => r.status !== 200);
}

async function endCallsInBatches(callIds) {
  let ended = 0;
  for (let i = 0; i < callIds.length; i += END_BATCH) {
    const batch = callIds.slice(i, i + END_BATCH);
    await Promise.all(batch.map((id) => endCall(id)));
    ended += batch.length;
    if (i + END_BATCH < callIds.length && END_BATCH_PAUSE_MS > 0) {
      await sleep(END_BATCH_PAUSE_MS);
    }
  }
  return ended;
}

/**
 * JWT-only safe: you can only admin-configure the tenant you belong to.
 * So we configure tenantA by:
 * - POST /api/admin/tenants with numbers: [TENANT_A_NUMBER]
 * - POST /api/admin/telephony/secret with TELE_SECRET_A
 */
async function seedTenantA() {
  console.log(`\n=== Seeding tenantA (JWT-only) ===`);

  const up = await post(
    "/api/admin/tenants",
    { id: "tenantA", numbers: [TENANT_A_NUMBER] }, // id here is informational
    { admin: true }
  );
  if (up.status !== 200) {
    console.log("Upsert tenantA numbers failed:", up.status, up.json);
    throw new Error("admin_seed_failed");
  }

  const set = await post("/api/admin/telephony/secret", { secret: TELE_SECRET_A }, { admin: true });
  if (set.status !== 200) {
    console.log("Set tenantA secret failed:", set.status, set.json);
    throw new Error("admin_secret_failed");
  }

  const chk = await get("/api/admin/telephony/secret", { admin: true });
  console.log("Secret check:", chk.status, chk.json);
}

async function startCallTenantA() {
  // Match Stage2: calledNumber + callerId + initialMessage
  // IMPORTANT: INITIAL_MESSAGE defaults to "" to avoid heavy LLM work unless you choose otherwise.
  const body = {
    callerId: FROM_NUMBER,
    calledNumber: TENANT_A_NUMBER,
    initialMessage: INITIAL_MESSAGE,
  };
  return post("/api/calls/start", body, { admin: false, signSecret: TELE_SECRET_A });
}

async function endCall(callId) {
  return post(`/api/calls/${callId}/end`, { reason: "load_test" }, { admin: false, signSecret: TELE_SECRET_A });
}

async function globalCapTest() {
  console.log(
    `\n=== TEST: Global cap (aim: ~${MAX_ACTIVE_CALLS} OK, remainder 429 system_at_capacity) ===`
  );
  console.log(`Pacing: START_SPACING_MS=${START_SPACING_MS}`);
  console.log(`Hold: HOLD_CALL_MS=${HOLD_CALL_MS}`);
  console.log(
    `NOTE: With JWT-only (single tenant), tenant limits can win unless raised for this run.`
  );

  // Fire starts concurrently; optional pacing is achieved by scheduling each start.
  const startPromises = [];
  for (let i = 0; i < PARALLEL_STARTS; i++) {
    if (START_SPACING_MS > 0) {
      startPromises.push(
        (async () => {
          await sleep(i * START_SPACING_MS);
          return startCallTenantA();
        })()
      );
    } else {
      startPromises.push(startCallTenantA());
    }
  }

  const results = await Promise.all(startPromises);

  const counts = statusCounts(results);
  console.log("Status counts:", counts);

  const sample = firstNon200(results);
  if (sample) console.log("Sample non-200:", sample.status, sample.json);

  const okCallIds = results
    .filter((r) => r.status === 200 && r.json?.callId)
    .map((r) => r.json.callId);

  console.log(`200 OK: ${okCallIds.length}`);
  console.log(`429 Too Many: ${results.filter((r) => r.status === 429).length}`);

  // Realism: keep calls "active" before ending them
  if (HOLD_CALL_MS > 0 && okCallIds.length > 0) {
    console.log(`Holding ${okCallIds.length} calls for ${HOLD_CALL_MS}ms...`);
    await sleep(HOLD_CALL_MS);
  }

  console.log(`Ending ${okCallIds.length} calls...`);
  await endCallsInBatches(okCallIds);
}

async function tenantConcurrentTest() {
  console.log("\n=== TEST: Per-tenant concurrent cap ===");
  console.log(`Hold: HOLD_CALL_MS=${HOLD_CALL_MS}`);

  const jobs = Array.from({ length: TENANT_MAX_CONCURRENT_CALLS + 1 }, () => startCallTenantA());
  const results = await Promise.all(jobs);

  const counts = statusCounts(results);
  console.log("Status counts:", counts);

  const sample = firstNon200(results);
  if (sample) console.log("Sample non-200:", sample.status, sample.json);

  const okCallIds = results
    .filter((r) => r.status === 200 && r.json?.callId)
    .map((r) => r.json.callId);

  if (HOLD_CALL_MS > 0 && okCallIds.length > 0) {
    console.log(`Holding ${okCallIds.length} calls for ${HOLD_CALL_MS}ms...`);
    await sleep(HOLD_CALL_MS);
  }

  await endCallsInBatches(okCallIds);
}

async function tenantRateTest() {
  console.log(
    `\n=== TEST: Calls/min cap (expect rate_limited after ~${TENANT_MAX_CALLS_PER_MINUTE}) ===`
  );

  const results = [];
  for (let i = 0; i < TENANT_MAX_CALLS_PER_MINUTE + 2; i++) {
    const r = await startCallTenantA();
    results.push(r);
    // For rate tests, end immediately so we don't mix in concurrency effects.
    if (r.status === 200 && r.json?.callId) await endCall(r.json.callId);
    await sleep(30);
  }

  const counts = statusCounts(results);
  console.log("Status counts:", counts);

  const sample = firstNon200(results);
  if (sample) console.log("Sample non-200:", sample.status, sample.json);
}

async function messageSpamTest() {
  console.log("\n=== TEST: Message spam cap (optional) ===");

  const started = await startCallTenantA();
  if (started.status !== 200 || !started.json?.callId) {
    console.log("Could not start call:", started.status, started.json);
    return;
  }

  const callId = started.json.callId;

  const jobs = Array.from({ length: MSG_COUNT }, (_, i) =>
    post(
      `/api/calls/${callId}/message`,
      { message: `msg ${i}` },
      { admin: false, signSecret: TELE_SECRET_A }
    )
  );

  const results = await Promise.all(jobs);
  const counts = statusCounts(results);
  console.log("Message status counts:", counts);

  await endCall(callId);
}

async function main() {
  console.log("BASE_URL:", BASE_URL);
  console.log("ADMIN_BEARER:", ADMIN_BEARER ? "set" : "(missing)");
  console.log("ADMIN_KEY:", ADMIN_KEY ? "set (legacy)" : "(missing)");
  console.log("TENANT_A_NUMBER:", TENANT_A_NUMBER);
  console.log("TELE_SECRET_A:", TELE_SECRET_A ? "set" : "(missing)");
  console.log("ONLY:", ONLY);
  console.log("WAIT_BEFORE_MS:", WAIT_BEFORE_MS);
  console.log("INITIAL_MESSAGE:", INITIAL_MESSAGE ? "(set)" : "(empty)");
  console.log("HOLD_CALL_MS:", HOLD_CALL_MS);

  if (WAIT_BEFORE_MS > 0) await sleep(WAIT_BEFORE_MS);

  await seedTenantA();

  const runAll = ONLY === "all";
  if (runAll || ONLY.includes("global")) await globalCapTest();
  if (runAll || ONLY.includes("tenant")) await tenantConcurrentTest();
  if (runAll || ONLY.includes("rate")) await tenantRateTest();
  if (runAll || ONLY.includes("spam")) await messageSpamTest();
}

main()
  .then(() => console.log("\n✅ Load test complete"))
  .catch((err) => {
    console.error("Load test runner failed:", err);
    process.exitCode = 1;
  });

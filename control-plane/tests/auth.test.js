"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// Run against built output
const {
  hashToken,
  generateToken,
  authenticateAdminKey,
} = require("../dist/auth.js");

function saveEnv(keys) {
  const saved = {};
  for (const k of keys) {
    if (process.env[k] !== undefined) saved[k] = process.env[k];
  }
  return saved;
}

function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    process.env[k] = saved[k];
  }
  for (const k of ["ADMIN_AUTH_MODE", "ADMIN_API_KEY", "VERALUX_ADMIN_KEY"]) {
    if (!saved[k] && process.env[k] !== undefined) delete process.env[k];
  }
}

test("hashToken returns 64-char hex string", () => {
  const out = hashToken("any-token");
  assert.equal(typeof out, "string");
  assert.equal(out.length, 64);
  assert.match(out, /^[0-9a-f]+$/, "should be hex");
});

test("generateToken returns 64-char hex string", () => {
  const out = generateToken();
  assert.equal(typeof out, "string");
  assert.equal(out.length, 64);
  assert.match(out, /^[0-9a-f]+$/, "should be hex");
});

test("hashToken is deterministic", () => {
  assert.equal(hashToken("x"), hashToken("x"));
  assert.notEqual(hashToken("x"), hashToken("y"));
});

test("master key accepted when ADMIN_API_KEY set (hybrid mode)", async () => {
  const saved = saveEnv(["ADMIN_AUTH_MODE", "ADMIN_API_KEY", "VERALUX_ADMIN_KEY"]);
  process.env.ADMIN_AUTH_MODE = "hybrid";
  process.env.ADMIN_API_KEY = "test-master-key-123";
  try {
    const principal = await authenticateAdminKey("test-master-key-123");
    assert.ok(principal);
    assert.equal(principal.source, "env");
    assert.equal(principal.name, "master-key");
    assert.equal(principal.role, "admin");
  } finally {
    restoreEnv(saved);
  }
});

test("VERALUX_ADMIN_KEY used when ADMIN_API_KEY unset (hybrid)", async () => {
  const saved = saveEnv(["ADMIN_AUTH_MODE", "ADMIN_API_KEY", "VERALUX_ADMIN_KEY"]);
  process.env.ADMIN_AUTH_MODE = "hybrid";
  delete process.env.ADMIN_API_KEY;
  process.env.VERALUX_ADMIN_KEY = "veralux-key-456";
  try {
    const principal = await authenticateAdminKey("veralux-key-456");
    assert.ok(principal);
    assert.equal(principal.source, "env");
    assert.equal(principal.role, "admin");
  } finally {
    restoreEnv(saved);
  }
});

test("wrong master key returns undefined (hits DB when no match)", async () => {
  const saved = saveEnv(["ADMIN_AUTH_MODE", "ADMIN_API_KEY"]);
  process.env.ADMIN_AUTH_MODE = "hybrid";
  process.env.ADMIN_API_KEY = "correct-key";
  try {
    const principal = await authenticateAdminKey("wrong-key");
    assert.strictEqual(principal, undefined);
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "EPERM" || err.name === "AggregateError") {
      return; // Skip when DB not available (e.g. sandbox, no Postgres)
    }
    throw err;
  } finally {
    restoreEnv(saved);
  }
});

test("jwt-only mode rejects master key", async () => {
  const saved = saveEnv(["ADMIN_AUTH_MODE", "ADMIN_API_KEY"]);
  process.env.ADMIN_AUTH_MODE = "jwt-only";
  process.env.ADMIN_API_KEY = "master-key-here";
  try {
    const principal = await authenticateAdminKey("master-key-here");
    assert.strictEqual(principal, undefined);
  } finally {
    restoreEnv(saved);
  }
});

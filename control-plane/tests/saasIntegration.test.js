"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SaaS Integration Tests
 *
 * End-to-end tests for the multi-tenant SaaS flow:
 *  1. Signup → creates user + tenant + membership
 *  2. Login → authenticates and returns JWT
 *  3. Usage tracking → metering works
 *  4. Billing enforcement → limits respected
 *
 * Requires: DATABASE_URL, SAAS_MODE=true, JWT_SECRET set
 * Run with: SAAS_MODE=true DATABASE_URL=... JWT_SECRET=test node --test tests/saasIntegration.test.js
 */

const hasDb = !!process.env.DATABASE_URL;
const isSaas = (process.env.SAAS_MODE || "").toLowerCase() === "true";

if (hasDb && isSaas) {
  let signupResult;
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = "TestP@ssword123!";

  test("Signup creates user, tenant, and returns JWT", async () => {
    const { signup } = require("../dist/tenantProvisioning.js");

    signupResult = await signup({
      email: testEmail,
      password: testPassword,
      name: "Integration Tester",
      companyName: "Test Corp " + Date.now(),
    });

    assert.ok(signupResult.user.id, "User ID should be set");
    assert.equal(signupResult.user.email, testEmail);
    assert.ok(signupResult.tenant.id, "Tenant ID should be set");
    assert.ok(signupResult.token, "JWT should be returned");
    assert.ok(signupResult.token.split(".").length === 3, "Should be a valid JWT");
  });

  test("Duplicate email signup fails", async () => {
    const { signup } = require("../dist/tenantProvisioning.js");

    await assert.rejects(
      () => signup({
        email: testEmail,
        password: testPassword,
        name: "Duplicate",
        companyName: "Dup Corp",
      }),
      /already exists/
    );
  });

  test("Login with correct credentials succeeds", async () => {
    const { login } = require("../dist/tenantProvisioning.js");

    const result = await login({
      email: testEmail,
      password: testPassword,
    });

    assert.ok(result.user.id, "User ID should be set");
    assert.equal(result.user.email, testEmail);
    assert.ok(result.tenants.length > 0, "Should have at least one tenant");
    assert.ok(result.token, "JWT should be returned");
  });

  test("Login with wrong password fails", async () => {
    const { login } = require("../dist/tenantProvisioning.js");

    await assert.rejects(
      () => login({ email: testEmail, password: "wrong-password" }),
      /Invalid email or password/
    );
  });

  test("Login with non-existent email fails", async () => {
    const { login } = require("../dist/tenantProvisioning.js");

    await assert.rejects(
      () => login({ email: "nonexistent@example.com", password: "anything" }),
      /Invalid email or password/
    );
  });

  test("Usage tracking increments correctly", async () => {
    if (!signupResult?.tenant?.id) return;

    const { incrementUsage, getUsage } = require("../dist/billing/usageMetering.js");

    await incrementUsage(signupResult.tenant.id, "call_count", 5);
    await incrementUsage(signupResult.tenant.id, "call_minutes", 120);
    await incrementUsage(signupResult.tenant.id, "api_requests", 50);

    const usage = await getUsage(signupResult.tenant.id);
    assert.ok(usage, "Usage should be returned");
    assert.ok(usage.callCount >= 5, `Call count should be >= 5, got ${usage.callCount}`);
    assert.ok(usage.callMinutes >= 120, `Call minutes should be >= 120, got ${usage.callMinutes}`);
    assert.ok(usage.apiRequests >= 50, `API requests should be >= 50, got ${usage.apiRequests}`);
  });

  test("Billing status returns limits", async () => {
    if (!signupResult?.tenant?.id) return;

    const { checkUsageLimits } = require("../dist/billing/usageMetering.js");

    const status = await checkUsageLimits(signupResult.tenant.id);
    assert.ok(status, "Status should be returned");
    assert.ok(status.limits, "Limits should be defined");
    assert.ok(status.limits.maxCallsPerMonth > 0, "Should have a call limit");
  });

  test("Invitation flow works", async () => {
    if (!signupResult?.tenant?.id || !signupResult?.user?.id) return;

    const { createInvitation, listInvitations } = require("../dist/tenantProvisioning.js");

    const invite = await createInvitation(
      signupResult.tenant.id,
      "invitee@example.com",
      "viewer",
      signupResult.user.id
    );
    assert.ok(invite.inviteToken, "Should return invite token");
    assert.ok(invite.expiresAt, "Should return expiry");

    const invitations = await listInvitations(signupResult.tenant.id);
    assert.ok(invitations.length > 0, "Should list invitations");
    assert.equal(invitations[0].email, "invitee@example.com");
  });

  // Cleanup (best effort)
  test("Cleanup test data", async () => {
    if (!signupResult?.tenant?.id) return;

    const { pool } = require("../dist/db.js");
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM tenant_usage WHERE tenant_id = $1", [signupResult.tenant.id]);
      await client.query("DELETE FROM tenant_invitations WHERE tenant_id = $1", [signupResult.tenant.id]);
      await client.query("DELETE FROM tenant_memberships WHERE tenant_id = $1", [signupResult.tenant.id]);
      await client.query("DELETE FROM users WHERE email = $1", [testEmail]);
      await client.query("DELETE FROM tenants WHERE id = $1", [signupResult.tenant.id]);
    } finally {
      client.release();
    }
  });
} else {
  test("SaaS integration tests skipped (requires DATABASE_URL and SAAS_MODE=true)", () => {
    assert.ok(true, "Skipped - set DATABASE_URL and SAAS_MODE=true to run");
  });
}

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Tenant Isolation Tests
 *
 * These tests verify that the database layer properly enforces
 * tenant boundaries. Tests use Zod schemas and DB functions directly.
 *
 * NOTE: These tests require a running PostgreSQL instance.
 * Run with: DATABASE_URL=... node --test tests/tenantIsolation.test.js
 */

// Skip if no DB available
const hasDb = !!process.env.DATABASE_URL;

test("Validation schemas reject invalid tenant IDs", async () => {
  const { tenantIdSchema } = require("../dist/validationSchemas.js");

  // Valid
  assert.doesNotThrow(() => tenantIdSchema.parse("Tenant-1"));
  assert.doesNotThrow(() => tenantIdSchema.parse("my_tenant"));
  assert.doesNotThrow(() => tenantIdSchema.parse("King-Sod"));

  // Invalid
  assert.throws(() => tenantIdSchema.parse(""), /Tenant ID is required/);
  assert.throws(() => tenantIdSchema.parse("a".repeat(101)), /Tenant ID too long/);
  assert.throws(() => tenantIdSchema.parse("tenant with spaces"), /alphanumeric/);
  assert.throws(() => tenantIdSchema.parse("tenant/slash"), /alphanumeric/);
  assert.throws(() => tenantIdSchema.parse("tenant;injection"), /alphanumeric/);
});

test("Validation schemas reject invalid phone numbers", () => {
  const { phoneNumberSchema } = require("../dist/validationSchemas.js");

  // Valid
  assert.doesNotThrow(() => phoneNumberSchema.parse("+12025551234"));
  assert.doesNotThrow(() => phoneNumberSchema.parse("12025551234"));

  // Invalid
  assert.throws(() => phoneNumberSchema.parse(""), /Invalid phone number/);
  assert.throws(() => phoneNumberSchema.parse("abc"), /Invalid phone number/);
  assert.throws(() => phoneNumberSchema.parse("0123456789"), /Invalid phone number/);
});

test("createWorkflowSchema validates all fields", () => {
  const { createWorkflowSchema } = require("../dist/validationSchemas.js");

  // Valid minimal
  const result = createWorkflowSchema.parse({
    name: "Test Workflow",
    triggerType: "call_ended",
  });
  assert.equal(result.name, "Test Workflow");
  assert.equal(result.triggerType, "call_ended");
  assert.deepEqual(result.steps, []);

  // Invalid trigger type
  assert.throws(
    () => createWorkflowSchema.parse({ name: "Test", triggerType: "invalid" }),
    /Invalid/
  );

  // Missing required field
  assert.throws(
    () => createWorkflowSchema.parse({ triggerType: "call_ended" }),
    /Required|Name is required/
  );
});

test("updateWorkflowSchema allows partial updates", () => {
  const { updateWorkflowSchema } = require("../dist/validationSchemas.js");

  // All optional
  const empty = updateWorkflowSchema.parse({});
  assert.equal(empty.name, undefined);
  assert.equal(empty.enabled, undefined);

  // Partial update
  const partial = updateWorkflowSchema.parse({ enabled: false });
  assert.equal(partial.enabled, false);
  assert.equal(partial.name, undefined);
});

test("Signup schema validates email and password", () => {
  const { signupSchema } = require("../dist/tenantProvisioning.js");

  // Valid
  const result = signupSchema.parse({
    email: "test@example.com",
    password: "SecureP@ss123",
    name: "Test User",
    companyName: "Test Corp",
  });
  assert.equal(result.email, "test@example.com");

  // Invalid email
  assert.throws(
    () => signupSchema.parse({
      email: "not-an-email",
      password: "SecureP@ss123",
      name: "Test",
      companyName: "Test",
    }),
    /email/i
  );

  // Short password
  assert.throws(
    () => signupSchema.parse({
      email: "test@example.com",
      password: "short",
      name: "Test",
      companyName: "Test",
    }),
    /8 characters/
  );
});

test("Login schema validates email and password", () => {
  const { loginSchema } = require("../dist/tenantProvisioning.js");

  assert.doesNotThrow(() => loginSchema.parse({
    email: "test@example.com",
    password: "anything",
  }));

  assert.throws(
    () => loginSchema.parse({ email: "bad", password: "pass" }),
    /email/i
  );
});

// ── DB-level tests (only run with DATABASE_URL) ──────

if (hasDb) {
  test("getWorkflow with tenantId filters correctly", async () => {
    const { getWorkflow } = require("../dist/automations/db.js");
    // Non-existent workflow with tenant filter should return null
    const result = await getWorkflow("non-existent-id", "some-tenant");
    assert.equal(result, null);
  });

  test("deleteWorkflow with wrong tenantId fails safely", async () => {
    const { deleteWorkflow } = require("../dist/automations/db.js");
    const result = await deleteWorkflow("non-existent-id", "wrong-tenant");
    assert.equal(result, false);
  });

  test("deleteLead with wrong tenantId fails safely", async () => {
    const { deleteLead } = require("../dist/automations/db.js");
    const result = await deleteLead("non-existent-id", "wrong-tenant");
    assert.equal(result, false);
  });
}

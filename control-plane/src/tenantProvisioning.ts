/**
 * Tenant Self-Service Provisioning
 *
 * Handles:
 *  - Email/password signup → creates user + tenant + membership + default config
 *  - Email/password login → issues JWT
 *  - Tenant invitation flow
 *  - Onboarding (default workflows, prompts, TTS config)
 */

import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { pool, upsertTenant, upsertConfig, upsertUserBySub, upsertTenantMembership } from "./db";
import { z } from "zod";
import { sendVerificationEmail, sendPasswordResetEmail, sendInvitationEmail } from "./email";

// ── Constants ────────────────────────────────────────

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = "24h";
const REFRESH_EXPIRY = "7d";
const INVITE_EXPIRY_DAYS = 7;
const RESET_EXPIRY_HOURS = 1;
const VERIFY_EXPIRY_HOURS = 24;

// Account lockout settings
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

// ── Zod Schemas ──────────────────────────────────────

export const signupSchema = z.object({
  email: z.string().email("Valid email required"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  name: z.string().min(1, "Name is required").max(200),
  companyName: z.string().min(1, "Company name is required").max(200),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number").optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "viewer"]).default("viewer"),
});

// ── Types ────────────────────────────────────────────

export interface SignupResult {
  user: { id: string; email: string; name: string };
  tenant: { id: string; name: string };
  token: string;
  refreshToken: string;
}

export interface LoginResult {
  user: { id: string; email: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
  token: string;
  refreshToken?: string;
}

// ── Helpers ──────────────────────────────────────────

function slugify(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
}

async function getJose() {
  const importer = new Function("m", "return import(m)") as (m: string) => Promise<any>;
  return (await importer("jose")) as typeof import("jose");
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const jose = await getJose();
  const secret = process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");

  const key = new TextEncoder().encode(secret);
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .setIssuer("veralux")
    .sign(key);
}

// ── Core Functions ───────────────────────────────────

/**
 * Register a new user and create their tenant.
 */
export async function signup(input: z.infer<typeof signupSchema>): Promise<SignupResult> {
  const { email, password, name, companyName, phone } = input;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if email already exists
    const existing = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      throw new Error("An account with this email already exists");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create user
    const userRes = await client.query(
      `INSERT INTO users (email, name, password_hash, idp_sub, email_verified)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, email, name`,
      [email.toLowerCase(), name, passwordHash, `email:${email.toLowerCase()}`]
    );
    const user = userRes.rows[0];

    // Generate tenant ID
    const tenantSlug = slugify(companyName);
    const tenantId = tenantSlug || `tenant-${Date.now()}`;

    // Check for tenant ID collision
    const tenantCheck = await client.query(
      "SELECT id FROM tenants WHERE id = $1",
      [tenantId]
    );
    const finalTenantId = tenantCheck.rows.length > 0
      ? `${tenantId}-${randomBytes(3).toString("hex")}`
      : tenantId;

    // Create tenant
    await client.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [finalTenantId, companyName]
    );

    // Create membership (owner gets admin role)
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'admin'`,
      [finalTenantId, user.id]
    );

    // Create default tenant config
    await client.query(
      `INSERT INTO tenant_configs (tenant_id, config)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [
        finalTenantId,
        JSON.stringify({
          provider: "openai",
          tts: { mode: "kokoro_http" },
          capacity: {
            maxConcurrentCalls: 5,
            maxCallsPerMinute: 30,
          },
        }),
      ]
    );

    await client.query("COMMIT");

    // Issue JWT
    const token = await signJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: "admin",
      tenant_id: finalTenantId,
    });

    // Issue refresh token
    const refreshToken = await issueRefreshToken(user.id);

    // Set up default workflows asynchronously (non-blocking)
    setupDefaultWorkflows(finalTenantId).catch((err) => {
      console.error(`[provisioning] Failed to create default workflows for ${finalTenantId}:`, err.message);
    });

    // Send verification email (non-blocking)
    sendVerification(user.id).catch((err) => {
      console.error(`[provisioning] Failed to send verification email:`, err.message);
    });

    return {
      user: { id: user.id, email: user.email, name: user.name },
      tenant: { id: finalTenantId, name: companyName },
      token,
      refreshToken,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Authenticate with email/password.
 */
export async function login(input: z.infer<typeof loginSchema>): Promise<LoginResult> {
  const { email, password } = input;

  const client = await pool.connect();
  try {
    // Find user (include lockout fields)
    const userRes = await client.query(
      "SELECT id, email, name, password_hash, failed_login_attempts, locked_until FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    if (userRes.rows.length === 0) {
      throw new Error("Invalid email or password");
    }

    const user = userRes.rows[0];

    // ── Account lockout check ────────────────────
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMs = new Date(user.locked_until).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      throw new Error(`Account temporarily locked. Try again in ${remainingMin} minute${remainingMin !== 1 ? "s" : ""}.`);
    }

    // If lockout has expired, reset it
    if (user.locked_until && new Date(user.locked_until) <= new Date()) {
      await client.query(
        "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1",
        [user.id]
      );
      user.failed_login_attempts = 0;
      user.locked_until = null;
    }

    if (!user.password_hash) {
      throw new Error("This account uses SSO login. Please use your identity provider.");
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // ── Increment failed attempts ──────────────
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      if (newAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
        await client.query(
          "UPDATE users SET failed_login_attempts = $2, locked_until = $3 WHERE id = $1",
          [user.id, newAttempts, lockedUntil.toISOString()]
        );
        throw new Error(`Too many failed attempts. Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.`);
      } else {
        await client.query(
          "UPDATE users SET failed_login_attempts = $2 WHERE id = $1",
          [user.id, newAttempts]
        );
      }
      throw new Error("Invalid email or password");
    }

    // ── Successful login: reset failed attempts ──
    if (user.failed_login_attempts > 0) {
      await client.query(
        "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1",
        [user.id]
      );
    }

    // Get tenant memberships
    const memberships = await client.query(
      `SELECT tm.tenant_id, tm.role, t.name as tenant_name
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = $1
       ORDER BY tm.created_at ASC`,
      [user.id]
    );

    const tenants = memberships.rows.map((m: any) => ({
      id: m.tenant_id,
      name: m.tenant_name,
      role: m.role,
    }));

    // Default to first tenant
    const primaryTenant = tenants[0];

    const token = await signJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: primaryTenant?.role || "viewer",
      tenant_id: primaryTenant?.id,
      tenants: tenants.map((t) => t.id),
    });

    // Issue refresh token
    const refreshToken = await issueRefreshToken(user.id);

    return {
      user: { id: user.id, email: user.email, name: user.name },
      tenants,
      token,
      refreshToken,
    };
  } finally {
    client.release();
  }
}

/**
 * Invite a user to a tenant.
 */
export async function createInvitation(
  tenantId: string,
  email: string,
  role: string,
  invitedBy?: string | null
): Promise<{ inviteToken: string; expiresAt: string }> {
  const inviteToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(inviteToken).digest("hex");

  const client = await pool.connect();
  try {
    // Get tenant name for the email
    const tenantRes = await client.query("SELECT name FROM tenants WHERE id = $1", [tenantId]);
    const tenantName = tenantRes.rows[0]?.name || tenantId;

    const res = await client.query(
      `INSERT INTO tenant_invitations (tenant_id, email, role, invited_by, token_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING expires_at`,
      [tenantId, email.toLowerCase(), role, invitedBy, tokenHash]
    );

    // Send invitation email (fire-and-forget)
    sendInvitationEmail(email, inviteToken, tenantName, undefined, role).catch((err) => {
      console.error("[invitation] Failed to send invitation email:", err);
    });

    return {
      inviteToken,
      expiresAt: res.rows[0].expires_at,
    };
  } finally {
    client.release();
  }
}

/**
 * Accept an invitation.
 */
export async function acceptInvitation(
  inviteToken: string,
  userId: string
): Promise<{ tenantId: string; role: string }> {
  const tokenHash = createHash("sha256").update(inviteToken).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inviteRes = await client.query(
      `SELECT id, tenant_id, email, role, accepted_at, expires_at
       FROM tenant_invitations
       WHERE token_hash = $1`,
      [tokenHash]
    );

    if (inviteRes.rows.length === 0) {
      throw new Error("Invalid or expired invitation");
    }

    const invite = inviteRes.rows[0];

    if (invite.accepted_at) {
      throw new Error("Invitation has already been accepted");
    }

    if (new Date(invite.expires_at) < new Date()) {
      throw new Error("Invitation has expired");
    }

    // Create membership
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = $3`,
      [invite.tenant_id, userId, invite.role]
    );

    // Mark invitation as accepted
    await client.query(
      "UPDATE tenant_invitations SET accepted_at = now() WHERE id = $1",
      [invite.id]
    );

    await client.query("COMMIT");

    return { tenantId: invite.tenant_id, role: invite.role };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Set up default workflows for a new tenant.
 */
async function setupDefaultWorkflows(tenantId: string): Promise<void> {
  const client = await pool.connect();
  try {
    // Default lead capture workflow
    await client.query(
      `INSERT INTO workflows (tenant_id, name, trigger_type, trigger_config, steps, created_by, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        "Lead Capture",
        "call_ended",
        JSON.stringify({}),
        JSON.stringify([
          { order: 0, action: "ai_extract", config: { extractFields: ["name", "phone", "email", "issue", "category"] } },
          { order: 1, action: "store_lead", config: {} },
        ]),
        "system",
      ]
    );

    // Default call summary workflow
    await client.query(
      `INSERT INTO workflows (tenant_id, name, trigger_type, trigger_config, steps, created_by, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        "Caller Questions",
        "call_ended",
        JSON.stringify({}),
        JSON.stringify([
          { order: 0, action: "ai_summarize", config: { focus: "questions_asked" } },
          { order: 1, action: "store_lead", config: { category: "question" } },
        ]),
        "system",
      ]
    );

    // Default quote builder workflow
    await client.query(
      `INSERT INTO workflows (tenant_id, name, trigger_type, trigger_config, steps, created_by, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        "Quote Builder",
        "call_ended",
        JSON.stringify({}),
        JSON.stringify([
          { order: 0, action: "ai_extract_quote", config: { taxRate: 0.08 } },
          { order: 1, action: "build_quote", config: { fromStep: 0, taxRate: 0.08 } },
          { order: 2, action: "store_lead", config: { fromStep: 1, category: "quote" } },
          {
            order: 3,
            action: "send_email",
            config: {
              to: "{{extracted.customerEmail}}",
              subject: "Your Quote from VeraLux",
              body: "Thank you for your inquiry. Your quote {{step.1.quote.quoteNumber}} for ${{step.1.quote.grandTotal}} is attached. Please contact us with any questions.",
            },
          },
          {
            order: 4,
            action: "send_email",
            config: {
              to: "staff@veralux.ai",
              subject: "New Quote Generated",
              body: "A new quote {{step.1.quote.quoteNumber}} has been created.\n\nCustomer: {{step.1.quote.customerName}}\nTotal: ${{step.1.quote.grandTotal}}\n\nLog in to the owner panel to review.",
            },
          },
        ]),
        "system",
      ]
    );

    console.log(`[provisioning] Default workflows created for tenant: ${tenantId}`);
  } finally {
    client.release();
  }
}

/**
 * List pending invitations for a tenant.
 */
export async function listInvitations(tenantId: string): Promise<any[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id, email, role, accepted_at, expires_at, created_at
       FROM tenant_invitations
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenantId]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * Get user profile.
 */
export async function getUserProfile(userId: string): Promise<any> {
  const client = await pool.connect();
  try {
    const userRes = await client.query(
      "SELECT id, email, name, email_verified, created_at FROM users WHERE id = $1",
      [userId]
    );
    if (userRes.rows.length === 0) return null;

    const memberships = await client.query(
      `SELECT tm.tenant_id, tm.role, t.name as tenant_name
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = $1
       ORDER BY tm.created_at ASC`,
      [userId]
    );

    return {
      ...userRes.rows[0],
      tenants: memberships.rows.map((m: any) => ({
        id: m.tenant_id,
        name: m.tenant_name,
        role: m.role,
      })),
    };
  } finally {
    client.release();
  }
}

// ── Zod Schemas (additional) ─────────────────────────

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token required"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

// ── Password Reset ───────────────────────────────────

/**
 * Request a password reset. Sends an email with a reset link.
 * Always returns success (even if email not found) to prevent enumeration.
 */
export async function forgotPassword(email: string): Promise<void> {
  const client = await pool.connect();
  try {
    const userRes = await client.query(
      "SELECT id, email, name FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    if (userRes.rows.length === 0) {
      // Don't reveal whether the email exists
      return;
    }

    const user = userRes.rows[0];
    const resetToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(resetToken).digest("hex");
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);

    // Store reset token (reuse tenant_invitations or a dedicated table)
    // Using a simple approach: store in users table as a JSON column or separate table
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET token_hash = $2, expires_at = $3, created_at = now()`,
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    // Send reset email (fire-and-forget)
    sendPasswordResetEmail(user.email, resetToken, user.name).catch((err) => {
      console.error("[auth] Failed to send password reset email:", err);
    });
  } finally {
    client.release();
  }
}

/**
 * Reset password using a valid token.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      `SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (res.rows.length === 0) {
      throw new Error("Invalid or expired reset token");
    }

    const { user_id, expires_at } = res.rows[0];

    if (new Date(expires_at) < new Date()) {
      throw new Error("Reset token has expired");
    }

    // Update password
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await client.query(
      "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
      [user_id, passwordHash]
    );

    // Delete the used token
    await client.query(
      "DELETE FROM password_reset_tokens WHERE user_id = $1",
      [user_id]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Email Verification ───────────────────────────────

/**
 * Verify an email address using the verification token.
 */
export async function verifyEmail(token: string): Promise<{ email: string }> {
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      `SELECT user_id, expires_at FROM email_verification_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (res.rows.length === 0) {
      throw new Error("Invalid or expired verification token");
    }

    const { user_id, expires_at } = res.rows[0];

    if (new Date(expires_at) < new Date()) {
      throw new Error("Verification link has expired");
    }

    // Mark email as verified
    const userRes = await client.query(
      "UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1 RETURNING email",
      [user_id]
    );

    // Delete used token
    await client.query(
      "DELETE FROM email_verification_tokens WHERE user_id = $1",
      [user_id]
    );

    await client.query("COMMIT");
    return { email: userRes.rows[0]?.email };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create and send a verification email for a user.
 */
export async function sendVerification(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const userRes = await client.query(
      "SELECT id, email, name, email_verified FROM users WHERE id = $1",
      [userId]
    );
    if (!userRes.rows[0]) return;
    const user = userRes.rows[0];
    if (user.email_verified) return; // Already verified

    const verifyToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(verifyToken).digest("hex");
    const expiresAt = new Date(Date.now() + VERIFY_EXPIRY_HOURS * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET token_hash = $2, expires_at = $3, created_at = now()`,
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    sendVerificationEmail(user.email, verifyToken, user.name).catch((err) => {
      console.error("[auth] Failed to send verification email:", err);
    });
  } finally {
    client.release();
  }
}

// ── JWT Refresh Tokens ───────────────────────────────

/**
 * Issue a refresh token alongside the access token.
 */
export async function issueRefreshToken(userId: string): Promise<string> {
  const refreshToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt.toISOString()]
    );
    return refreshToken;
  } finally {
    client.release();
  }
}

/**
 * Use a refresh token to get a new access token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<LoginResult> {
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      `SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (res.rows.length === 0) {
      throw new Error("Invalid refresh token");
    }

    const { user_id, expires_at } = res.rows[0];

    if (new Date(expires_at) < new Date()) {
      // Delete expired token
      await client.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
      await client.query("COMMIT");
      throw new Error("Refresh token has expired");
    }

    // Rotate: delete old, issue new
    await client.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);

    const userRes = await client.query(
      "SELECT id, email, name FROM users WHERE id = $1",
      [user_id]
    );
    if (!userRes.rows[0]) {
      throw new Error("User not found");
    }
    const user = userRes.rows[0];

    // Get memberships
    const memberships = await client.query(
      `SELECT tm.tenant_id, tm.role, t.name as tenant_name
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = $1
       ORDER BY tm.created_at ASC`,
      [user.id]
    );

    const tenants = memberships.rows.map((m: any) => ({
      id: m.tenant_id,
      name: m.tenant_name,
      role: m.role,
    }));

    const primaryTenant = tenants[0];

    // Issue new access token
    const accessToken = await signJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: primaryTenant?.role || "viewer",
      tenant_id: primaryTenant?.id,
      tenants: tenants.map((t) => t.id),
    });

    // Issue new refresh token
    const newRefresh = randomBytes(32).toString("hex");
    const newHash = createHash("sha256").update(newRefresh).digest("hex");
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, newHash, newExpiry.toISOString()]
    );

    await client.query("COMMIT");

    return {
      user: { id: user.id, email: user.email, name: user.name },
      tenants,
      token: accessToken,
      refreshToken: newRefresh,
    } as LoginResult & { refreshToken: string };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

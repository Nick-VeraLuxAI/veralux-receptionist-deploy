/**
 * Transactional email service for auth flows.
 *
 * Sends:
 *  - Email verification after signup
 *  - Password reset links
 *  - Tenant invitation emails
 *
 * Uses nodemailer with SMTP config from environment.
 */

let nodemailer: any;

async function getNodemailer() {
  if (nodemailer) return nodemailer;
  try {
    nodemailer = await import("nodemailer");
    return nodemailer;
  } catch {
    console.warn("[email] nodemailer not installed — emails will be logged only");
    return null;
  }
}

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT || "587"),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "noreply@veralux.ai",
  };
}

function isSmtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER);
}

async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  const smtp = getSmtpConfig();
  const nm = await getNodemailer();

  if (!nm || !isSmtpConfigured()) {
    console.log(`[email] (no SMTP) To: ${to} | Subject: ${subject}`);
    console.log(`[email] Body: ${html.replace(/<[^>]+>/g, "").slice(0, 200)}`);
    return false;
  }

  try {
    const transporter = nm.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });

    await transporter.sendMail({
      from: smtp.from,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error(`[email] Failed to send to ${to}:`, (err as Error).message);
    return false;
  }
}

// ── Templates ────────────────────────────────────────

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";

export async function sendVerificationEmail(
  email: string,
  verifyToken: string,
  userName?: string
): Promise<boolean> {
  const link = `${BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #C8A951;">Welcome to VeraLux AI</h2>
      <p>Hi ${userName || "there"},</p>
      <p>Please verify your email address by clicking the link below:</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="background: #C8A951; color: #1a1a2e; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Verify Email
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Or copy this link: <a href="${link}">${link}</a>
      </p>
      <p style="color: #666; font-size: 12px;">This link expires in 24 hours.</p>
    </div>
  `;
  return sendMail(email, "Verify your VeraLux AI account", html);
}

export async function sendPasswordResetEmail(
  email: string,
  resetToken: string,
  userName?: string
): Promise<boolean> {
  const link = `${BASE_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #C8A951;">Password Reset</h2>
      <p>Hi ${userName || "there"},</p>
      <p>We received a request to reset your password. Click below to set a new one:</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="background: #C8A951; color: #1a1a2e; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Reset Password
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Or copy this link: <a href="${link}">${link}</a>
      </p>
      <p style="color: #666; font-size: 12px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    </div>
  `;
  return sendMail(email, "Reset your VeraLux AI password", html);
}

export async function sendInvitationEmail(
  email: string,
  inviteToken: string,
  tenantName: string,
  inviterName?: string,
  role?: string
): Promise<boolean> {
  const link = `${BASE_URL}/accept-invite?token=${encodeURIComponent(inviteToken)}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #C8A951;">You're Invited!</h2>
      <p>Hi,</p>
      <p>${inviterName || "Someone"} has invited you to join <strong>${tenantName}</strong> on VeraLux AI as a <strong>${role || "viewer"}</strong>.</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="background: #C8A951; color: #1a1a2e; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Accept Invitation
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Or copy this link: <a href="${link}">${link}</a>
      </p>
      <p style="color: #666; font-size: 12px;">This invitation expires in 7 days.</p>
    </div>
  `;
  return sendMail(email, `You're invited to ${tenantName} on VeraLux AI`, html);
}

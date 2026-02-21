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

export interface EmailBranding {
  companyName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  logoUrl?: string;
}

export async function sendQuoteEmail(
  to: string,
  quoteData: {
    quoteNumber: string;
    customerName?: string;
    lineItems: Array<{ description: string; type: string; quantity: number; unitPrice: number; unit: string; total: number }>;
    subtotal: number;
    tax: number;
    grandTotal: number;
    notes?: string;
  },
  companyName: string = "VeraLux AI",
  branding?: EmailBranding
): Promise<boolean> {
  const brand = branding || {};
  const displayName = brand.companyName || companyName;
  const primaryClr = brand.primaryColor || "#C8A951";
  const secondaryClr = brand.secondaryColor || "#1a1a2e";
  const logoHtml = brand.logoUrl
    ? `<img src="${BASE_URL}${brand.logoUrl}" alt="${displayName}" style="max-height: 48px; max-width: 180px; margin-bottom: 8px;" /><br/>`
    : "";

  const itemRows = quoteData.lineItems.map(item =>
    `<tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${item.description}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-transform: capitalize;">${item.type}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity} ${item.unit}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">$${item.unitPrice.toFixed(2)}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right; font-weight: 600;">$${item.total.toFixed(2)}</td>
    </tr>`
  ).join("");

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333;">
      <div style="background: ${secondaryClr}; padding: 24px 32px; border-radius: 8px 8px 0 0;">
        ${logoHtml}
        <h1 style="color: ${primaryClr}; margin: 0; font-size: 22px;">${displayName}</h1>
        <p style="color: #ccc; margin: 4px 0 0; font-size: 14px;">Quote ${quoteData.quoteNumber}</p>
      </div>
      <div style="border: 1px solid #e0e0e0; border-top: none; padding: 24px 32px; border-radius: 0 0 8px 8px;">
        <p>Hi ${quoteData.customerName || "there"},</p>
        <p>Thank you for your inquiry. Please find your quote details below:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
          <thead>
            <tr style="background: #f8f8f8;">
              <th style="padding: 10px 12px; text-align: left; border-bottom: 2px solid ${primaryClr};">Item</th>
              <th style="padding: 10px 12px; text-align: left; border-bottom: 2px solid ${primaryClr};">Type</th>
              <th style="padding: 10px 12px; text-align: center; border-bottom: 2px solid ${primaryClr};">Qty</th>
              <th style="padding: 10px 12px; text-align: right; border-bottom: 2px solid ${primaryClr};">Unit Price</th>
              <th style="padding: 10px 12px; text-align: right; border-bottom: 2px solid ${primaryClr};">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            <tr>
              <td colspan="4" style="padding: 8px 12px; text-align: right; font-weight: 600;">Subtotal:</td>
              <td style="padding: 8px 12px; text-align: right;">$${quoteData.subtotal.toFixed(2)}</td>
            </tr>
            ${quoteData.tax > 0 ? `<tr>
              <td colspan="4" style="padding: 8px 12px; text-align: right; font-weight: 600;">Tax:</td>
              <td style="padding: 8px 12px; text-align: right;">$${quoteData.tax.toFixed(2)}</td>
            </tr>` : ""}
            <tr style="background: #f8f8f8;">
              <td colspan="4" style="padding: 10px 12px; text-align: right; font-weight: 700; font-size: 16px;">Total:</td>
              <td style="padding: 10px 12px; text-align: right; font-weight: 700; font-size: 16px; color: ${primaryClr};">$${quoteData.grandTotal.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
        ${quoteData.notes ? `<p style="background: #f9f9f9; padding: 12px; border-radius: 6px; font-size: 13px; color: #666;"><strong>Notes:</strong> ${quoteData.notes}</p>` : ""}
        <p style="color: #666; font-size: 13px; margin-top: 24px;">This quote is valid for 30 days. For questions, please call us or reply to this email.</p>
        <p style="color: #999; font-size: 12px; margin-top: 16px;">Generated by ${displayName}</p>
      </div>
    </div>
  `;
  return sendMail(to, `Quote ${quoteData.quoteNumber} from ${displayName}`, html);
}

export async function sendQuoteNotificationEmail(
  to: string,
  quoteData: {
    quoteNumber: string;
    customerName?: string;
    customerPhone?: string;
    grandTotal: number;
    lineItems: Array<{ description: string; total: number }>;
  },
  companyName: string = "VeraLux AI",
  branding?: EmailBranding
): Promise<boolean> {
  const brand = branding || {};
  const displayName = brand.companyName || companyName;
  const primaryClr = brand.primaryColor || "#C8A951";

  const itemList = quoteData.lineItems.map(i => `<li>${i.description} — $${i.total.toFixed(2)}</li>`).join("");
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: ${primaryClr};">New Quote Generated</h2>
      <p>A new quote has been created from a phone call:</p>
      <table style="font-size: 14px; margin: 16px 0;">
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Quote #:</td><td>${quoteData.quoteNumber}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Customer:</td><td>${quoteData.customerName || "Unknown"}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Phone:</td><td>${quoteData.customerPhone || "N/A"}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Total:</td><td style="font-weight: 700; color: ${primaryClr};">$${quoteData.grandTotal.toFixed(2)}</td></tr>
      </table>
      <p><strong>Items:</strong></p>
      <ul style="font-size: 14px;">${itemList}</ul>
      <p style="color: #666; font-size: 13px;">Log in to the ${displayName} owner panel to review, edit, or send this quote.</p>
    </div>
  `;
  return sendMail(to, `New Quote ${quoteData.quoteNumber} — $${quoteData.grandTotal.toFixed(2)}`, html);
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

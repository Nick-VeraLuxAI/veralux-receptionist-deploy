/**
 * CSRF Protection Middleware
 *
 * Uses the double-submit cookie pattern:
 *  - A CSRF token is set in a cookie and must be sent back in a header
 *  - API endpoints that use JSON bodies and Bearer auth are exempt
 *    (browser SOP prevents cross-origin JSON requests with custom headers)
 *  - Form submissions and cookie-based auth require the CSRF token
 *
 * Strategy:
 *  - Requests with `X-Admin-Key` or `Authorization: Bearer` headers are exempt
 *    (these already prove the request is not a simple cross-origin form)
 *  - GET/HEAD/OPTIONS are always exempt (safe methods)
 *  - Other requests from browser sessions require X-CSRF-Token header
 */

import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";

const CSRF_COOKIE = "veralux_csrf";
const CSRF_HEADER = "x-csrf-token";
const TOKEN_LENGTH = 32;

/**
 * Generate a CSRF token and set it as a cookie if not already present.
 */
function ensureCsrfCookie(req: Request, res: Response): string {
  // Check if token already exists in cookie
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing && typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  // Generate new token
  const token = randomBytes(TOKEN_LENGTH).toString("hex");
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // Must be readable by JS to send in header
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
  return token;
}

/**
 * Check if the request is exempt from CSRF validation.
 */
function isExempt(req: Request): boolean {
  // Safe methods don't need CSRF protection
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;

  // API key auth — not cookie-based, so no CSRF risk
  if (req.headers["x-admin-key"]) return true;

  // Bearer token auth — custom header proves it's not a simple form
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return true;

  // Webhook endpoints — signed by external services
  if (req.path.startsWith("/webhooks/") || req.path === "/api/stripe/webhook") return true;

  // Runtime-to-control-plane endpoints — internal, use API key
  if (req.path.startsWith("/api/runtime/")) return true;

  // Public auth endpoints (signup, login, etc.) — no session cookie yet
  if (req.path.startsWith("/api/auth/")) return true;

  // Test/dev tool endpoints — not cookie-based
  if (req.path.startsWith("/api/test-pipeline") || req.path.startsWith("/api/test-recordings")) return true;
  if (req.path === "/api/chat") return true;

  return false;
}

/**
 * CSRF protection middleware.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // Always ensure a CSRF cookie is set
  const cookieToken = ensureCsrfCookie(req, res);

  // Skip validation for exempt requests
  if (isExempt(req)) {
    return next();
  }

  // Validate: X-CSRF-Token header must match the cookie
  const headerToken = req.headers[CSRF_HEADER] as string | undefined;
  if (!headerToken || headerToken !== cookieToken) {
    res.status(403).json({ error: "csrf_token_invalid", message: "CSRF token missing or invalid" });
    return;
  }

  next();
}

/**
 * Endpoint to get a fresh CSRF token (useful for SPAs).
 */
export function getCsrfToken(req: Request, res: Response): void {
  const token = ensureCsrfCookie(req, res);
  res.json({ csrfToken: token });
}

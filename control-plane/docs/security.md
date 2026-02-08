# Security

This repo is the control plane and does not process live calls. It manages admin access, tenant configuration, and secrets that the voice runtime consumes.

## High-level model
- Admin APIs require an API key or JWT.
- Secrets are stored via a secret manager (Postgres, env, or AWS).
- Telephony HMAC secrets are configured per tenant and used by the voice runtime.

## Recommended production posture
- `ADMIN_AUTH_MODE=jwt-only`
- `ALLOW_ADMIN_API_KEY_IN_PROD=false`
- `ADMIN_ALLOWED_ORIGINS=<your-admin-origin>`
- Use HTTPS (terminate TLS at the reverse proxy)
- Restrict admin UI to trusted networks or SSO

## Admin tokens
- The admin UI uses `X-Admin-Key` by default.
- In strict JWT-only environments, send `Authorization: Bearer <jwt>`.

## Secrets
- If using `SECRET_MANAGER=db`, set and protect `SECRET_ENCRYPTION_KEY`.
- Prefer an external secret manager in production.
- Never commit `.env` or secrets to git.

## Configuration and .env
The application does not write to `.env`. All configuration is loaded at startup from environment variables (and optionally from a local `.env` file via `dotenv`). Tenant-specific secrets are stored in the secret manager (db, env, or AWS), not in `.env`.

## Audit logging
- Admin actions are recorded in `admin_audit_logs`.
- Review audit logs regularly and set retention policies.

## Data handling
Treat tenant configs, prompts, and secrets as sensitive. Avoid logging raw request bodies in production unless required.

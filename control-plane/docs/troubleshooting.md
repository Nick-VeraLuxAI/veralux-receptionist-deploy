# Troubleshooting

## Common issues

### `voice_runtime_moved`
Meaning: you are calling legacy voice endpoints on the control plane.
Fix: call the voice runtime service for `/api/calls/*`, `/api/telnyx/*`, and `/api/tts/preview`.

### `runtime_admin_disabled`
Meaning: runtime publishing endpoints are disabled.
Fix: set `ENABLE_RUNTIME_ADMIN=true` and restart.

### `runtime_publish_failed` / `runtime_map_failed`
Meaning: Redis publish failed.
Fix: verify `REDIS_URL`, connectivity, and credentials.

### `runtime_config_not_found`
Meaning: no runtime config in Redis for the tenant.
Fix: publish config via `POST /api/admin/runtime/tenants/:tenantId/config`.

### `invalid_did_e164`
Meaning: DID did not normalize to a valid E.164 number.
Fix: use a `+`-prefixed E.164 number (spaces are allowed but removed).

### `admin_auth_required` / `admin_auth_invalid`
Meaning: missing or invalid admin token.
Fix: send `X-Admin-Key` or `Authorization: Bearer <jwt>` and verify `ADMIN_AUTH_MODE`.

### Startup exits in production
Meaning: missing required prod guardrails.
Fix: set `ADMIN_JWT_SECRET` (or `JWT_SECRET`), `ADMIN_ALLOWED_ORIGINS`, and ensure Redis is configured if runtime admin is enabled.

## Debugging tips
- Use `/api/admin/health` for control-plane diagnostics.
- Use `/api/admin/runtime/health` for Redis connectivity.
- Confirm Postgres connectivity and migrations first if startup fails.

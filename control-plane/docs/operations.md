# Operations Runbook

This runbook covers the control plane service. Live call operations are handled by the voice runtime.

## Health checks
- `GET /health`: liveness — process is running (always 200 when the server is up).
- `GET /ready`: readiness — DB (and Redis when runtime admin is enabled) are reachable. Returns 200 when ready, 503 with `{ status: "not_ready", checks: { db?, redis? } }` when a dependency is down. Use for orchestrator readiness probes.
- `GET /api/admin/health`: admin diagnostics (auth required).
- `GET /api/admin/runtime/health`: Redis health for runtime publishing.

## Startup guardrails
In production the server exits if:
- `ADMIN_JWT_SECRET` (or `JWT_SECRET`) is missing/weak
- `ADMIN_ALLOWED_ORIGINS` is not set
- `ENABLE_RUNTIME_ADMIN=true` but `REDIS_URL` is missing

## Runtime integration checks
- Ensure Redis is reachable from control plane and voice runtime.
- Publish a runtime config and DID mapping after any tenant changes.
- Use `npm run report:runtime` and `npm run check:contract` during upgrades.

## Logs and audit
- Admin actions are recorded in `admin_audit_logs`.
- Capture stdout/stderr to your logging system.

## Backups
- Postgres is the source of truth for tenants, configs, secrets, audit logs, and analytics.
- Perform regular backups and test restore procedures.

## Secret rotation
Rotate on schedule or on incident:
- Admin keys
- Tenant telephony HMAC secrets
- OpenAI API keys
- `SECRET_ENCRYPTION_KEY` (plan for re-encryption if using `db` provider)

## Capacity and rate limiting
Admin rate limits are in-memory per process by default. Set `ADMIN_RATE_USE_REDIS=true` (with `REDIS_URL`) to share limits across instances. Otherwise limits reset on restart and are not shared; for multi-instance without Redis, use a gateway or load balancer with rate limiting.

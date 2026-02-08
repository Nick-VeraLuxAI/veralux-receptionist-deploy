# API Overview

Base URL: `http(s)://<host>:<port>`
All JSON endpoints expect `Content-Type: application/json` unless noted.

This repo exposes control-plane APIs (admin + provisioning). Live call APIs are handled by the voice runtime and return `voice_runtime_moved` here.

## Authentication

### Admin APIs
Admin endpoints require an admin token:
- API key via `X-Admin-Key: <token>`
- JWT via `Authorization: Bearer <jwt>`

Admin auth mode is controlled by `ADMIN_AUTH_MODE`:
- `hybrid` (dev friendly): API key or JWT
- `jwt-only` (recommended prod): JWT required; API key can be disallowed

### Tenant selection (admin)
- Superadmin can select a tenant with `X-Tenant-ID: <tenantId>` or `?tenantId=`.
- OIDC/JWT users are scoped by DB memberships. Multi-tenant users can use `X-Active-Tenant: <tenantId>`.

## Admin UI
- `GET /` redirects to `/admin`
- `GET /admin` serves the static admin UI

## Admin APIs (high level)

### Health and diagnostics
- `GET /health`: liveness (basic process health; 200 when server is up)
- `GET /ready`: readiness (DB and, when runtime admin enabled, Redis); 200 when ready, 503 when a dependency is down; body includes `checks: { db?, redis? }`
- `GET /api/admin/health`: admin diagnostics (requires auth)

### Tenant registry and secrets
- `GET /api/admin/tenants`: list tenants and inbound numbers
- `POST /api/admin/tenants`: create/update tenant metadata and numbers
- `GET /api/admin/telephony/secret`: check if telephony secret exists
- `POST /api/admin/telephony/secret`: set telephony HMAC secret

### Config and prompts
- `GET /api/admin/config`: read tenant LLM config
- `POST /api/admin/config`: update tenant LLM config
- `GET /api/admin/prompts`: read prompt config
- `POST /api/admin/prompts`: update prompt config

### LLM context (forwarding & pricing)
Data the receptionist can use when talking to callers (transfer targets and pricing).
- `GET /api/admin/forwarding-profiles`: list call-forwarding profiles (name, number, role) for the tenant
- `POST /api/admin/forwarding-profiles`: replace profiles; body `{ profiles: [{ id?, name, number, role }] }`
- `GET /api/admin/pricing`: get pricing info; response `{ items: [{ id?, name, price, description? }], notes? }`
- `POST /api/admin/pricing`: replace pricing; body same shape. The voice runtime (or prompt builder) should include this in the LLM system context when handling calls.
- `GET /api/tts/config`: read tenant TTS config
- `POST /api/tts/config`: update tenant TTS config

### Analytics and calls (control plane)
- `GET /api/admin/analytics`: basic analytics summary
- `GET /api/admin/calls`: in-memory call snapshots (legacy/diagnostic)

### Admin keys and audit logs
- `GET /api/admin/auth/keys`: list admin keys
- `POST /api/admin/auth/keys`: create admin key
- `DELETE /api/admin/auth/keys/:id`: revoke admin key
- `GET /api/admin/audit`: admin audit log

## Runtime provisioning APIs (Redis publish)
These endpoints publish DID mappings and runtime config for the voice runtime. They require `ENABLE_RUNTIME_ADMIN=true` and a valid `REDIS_URL`.

- `POST /api/admin/runtime/tenants/:tenantId/config`: publish runtime config
- `GET /api/admin/runtime/tenants/:tenantId/config`: read runtime config from Redis
- `POST /api/admin/runtime/dids/map`: map DID to tenant
- `POST /api/admin/runtime/dids/unmap`: remove DID mapping
- `GET /api/admin/runtime/dids/:didE164`: lookup DID mapping
- `GET /api/admin/runtime/health`: Redis health check

See `docs/runtime_integration_report.md` for the exact runtime config shape and Redis key formats.

## OAuth endpoints (optional)
- `GET /oauth/login`: redirect to Cognito login
- `GET /oauth/callback`: exchanges authorization code for tokens (MVP flow)

## Legacy endpoints (moved to voice runtime)
The following endpoints return `410 { "error": "voice_runtime_moved" }` from this repo:
- `/api/calls/*`
- `/api/telnyx/*`
- `/api/tts/preview`
- `/api/dev/*`

Use the voice runtime service for live call handling and telephony webhooks.

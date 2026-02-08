# Configuration

Configuration is done via environment variables. The server loads `.env` on startup (via `dotenv`), so you can keep a local `.env` for development and use environment variables in production. **The application never writes to `.env`**; all config is read at startup and tenant secrets live in the secret manager.

Use `.env.example` as the base template.

## Core settings (most deployments)
- `NODE_ENV`: `development` or `production`
- `PORT`: preferred listen port (default `4000`)
- `DATABASE_URL`: Postgres connection string

## Admin access
- `ADMIN_AUTH_MODE`: `hybrid` (dev) or `jwt-only` (recommended prod)
- `ALLOW_ADMIN_API_KEY_IN_PROD`: allow `X-Admin-Key` in prod (default `false`)
- `ADMIN_ALLOWED_ORIGINS`: comma-separated allowlist for admin UI origin (required in prod)
- `ADMIN_API_KEY` / `VERALUX_ADMIN_KEY`: bootstrap admin key (dev only)

### JWT / OIDC (optional)
- `ADMIN_JWKS_URL`, `ADMIN_JWT_ISSUER`, `ADMIN_JWT_AUDIENCE`
- `ADMIN_JWT_SECRET` or legacy `JWT_SECRET` (HS256 dev)

### Cognito OAuth (optional)
- `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, `COGNITO_REDIRECT_URI`

## Secret storage
- `SECRET_MANAGER`: `db` (default), `env`, or `aws`
- `SECRET_ENCRYPTION_KEY`: required when `SECRET_MANAGER=db`; must be **at least 32 bytes** (UTF-8). Use a cryptographically random value (e.g. 32+ character string or base64). The server fails at startup if the key is missing or too short.
- `SECRET_ENV_PREFIX`: prefix for `env` provider (default `TENANT_`)
- `SECRET_AWS_REGION` / `AWS_REGION`
- `SECRET_AWS_PREFIX`: secret name prefix (default `veralux/`)

## Runtime integration (Redis publish)
The control plane publishes runtime config and DID mappings to Redis for the voice runtime.
- `REDIS_URL`: Redis connection string
- `ENABLE_RUNTIME_ADMIN`: enable runtime admin endpoints (default `true`)
- `ALLOW_RUNTIME_SECRET_READ`: allow `?includeSecrets=1` on runtime config reads (default false in prod)

## LLM and prompt configuration (control plane)
These settings are stored per tenant and are used for config management. The voice runtime consumes the runtime config published to Redis.
- `LLM_PROVIDER`: `local` or `openai`
- `LOCAL_LLM_URL`
- `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`

When LLM config is updated via the admin API (`POST /api/admin/config`), the control plane also writes `OPENAI_API_KEY` and `OPENAI_MODEL` to `process.env` for compatibility with code that reads these env vars. Tenant-specific values remain in the in-memory config store and secret manager.

## Rate limiting and runtime safety
- `ADMIN_RATE_MAX`, `ADMIN_RATE_WINDOW_MS`
- `ADMIN_RATE_USE_REDIS`: when `true`, use Redis (requires `REDIS_URL`) for admin rate limiting so limits are shared across instances; default `false` (in-memory per process).
- `MAX_ACTIVE_CALLS`, `TENANT_MAX_CONCURRENT_CALLS`, `TENANT_MAX_CALLS_PER_MINUTE`
- `CALL_TTL_MS`, `CALL_SWEEP_MS`, `MSG_RATE_MAX`, `MSG_RATE_WINDOW_MS`, `CALL_START_IP_RATE_MAX`

## Telnyx phone number provisioning
The control plane can automatically provision Telnyx phone numbers from the owner dashboard.

- `TELNYX_API_KEY`: Your Telnyx API v2 key (get from https://portal.telnyx.com/#/app/api-keys)
- `TELNYX_CONNECTION_ID`: Optional. The Telnyx Call Control Application ID that has your webhook URL configured. If not set, one will be created automatically when `VERALUX_WEBHOOK_URL` is set.
- `VERALUX_WEBHOOK_URL`: Your public webhook URL for voice calls (e.g., `https://your-server.example.com/api/telnyx/call-control`). Required for auto-provisioning.

### How it works
1. When a user provisions a number from the owner dashboard, the control plane assigns it to the configured Telnyx Connection (Call Control Application).
2. The Connection has the webhook URL configured, so incoming calls to that number are routed to your voice runtime.
3. Users can also search and purchase new numbers directly from the dashboard.

## Not used in this repo
Live telephony, STT, and TTS settings are owned by the voice runtime service. Control-plane call handling endpoints return `voice_runtime_moved`.

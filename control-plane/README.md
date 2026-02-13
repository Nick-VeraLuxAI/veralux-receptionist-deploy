# VeraLux Receptionist Control Plane

This repo is the VeraLux control plane (admin + onboarding + config). The low-latency voice runtime lives in a separate repo and owns the real-time call loop (Telnyx webhooks/media, STT/TTS, audio storage/serving, and hot-path capacity enforcement).

## Documentation
- Docs index: `docs/README.md`
- API reference: `docs/api.md`
- Configuration: `docs/configuration.md`
- Deployment: `docs/deployment.md`
- Operations: `docs/operations.md`
- Security: `docs/security.md`
- Limitations: `docs/limitations.md`
- Dev guide: `docs/development.md`

## Responsibilities
- Tenant onboarding and metadata
- DID -> tenant routing and runtime config publishing
- Admin auth, audit logs, and monitoring
- LLM prompt/config management (per-tenant)

## Runtime integration (Redis contract)
- DID mapping: `tenantmap:did:<E164>` => `<tenantId>`
- Tenant config: `tenantcfg:<tenantId>` => `RuntimeTenantConfig` JSON (`src/runtime/runtimeContract.ts`)

## Provisioning flow
1) Create tenant (`POST /api/admin/tenants`).
2) Publish runtime config (`POST /api/admin/runtime/tenants/:tenantId/config`).
3) Map DIDs to tenant (`POST /api/admin/runtime/dids/map`).
4) Voice runtime reads Redis and handles calls.

## LLM provider selection
- Default: local llama.cpp-style endpoint at `LOCAL_LLM_URL` (defaults to `http://127.0.0.1:8080/completion`).
- To use an OpenAI-compatible API, set `LLM_PROVIDER=openai` and provide `OPENAI_API_KEY`; optionally set `OPENAI_MODEL` and `OPENAI_BASE_URL` (defaults to `llama3.2:3b` via local Ollama).

## Runtime STT/TTS config
- STT/TTS settings live in `RuntimeTenantConfig` and are consumed by the voice runtime.
- This control plane does not call Whisper/Kokoro or handle Telnyx media.

## Telnyx phone number provisioning
The owner dashboard can automatically provision Telnyx phone numbers:
- **List existing numbers** from your Telnyx account
- **Provision numbers** — assigns them to your VeraLux webhook
- **Search and purchase new numbers** directly from the dashboard

### Setup
1. Get your API key from https://portal.telnyx.com/#/app/api-keys
2. Set environment variables:
   ```
   TELNYX_API_KEY=your-api-key
   VERALUX_WEBHOOK_URL=https://your-server.example.com/api/telnyx/call-control
   ```
3. Open the owner dashboard (`/owner`) and use the "Your business line" section

When you provision or purchase a number, the control plane:
1. Creates a Telnyx Call Control Application (if needed) with your webhook URL
2. Assigns the number to that application
3. Adds the number to your tenant's routing table

See `docs/configuration.md` for more details.

## Admin panel (dashboard)
- The server listens on **port 4000** by default (override with `PORT`).
- **Admin UI:** Open **http://127.0.0.1:4000/admin** (or `http://localhost:4000/admin`) to:
  - Manage tenants, prompts, and LLM config.
  - Publish runtime config + DID mappings for the voice runtime.
  - View health, calls, and basic analytics.
- **Owner dashboard:** Open **http://127.0.0.1:4000/owner** for a simplified, single-business view: set your phone number(s), who to transfer calls to, and services/pricing. Uses the same admin token; no tenant switching or multi-agent setup. Includes automatic Telnyx number provisioning when `TELNYX_API_KEY` is set.
- **Dev console:** Open **http://127.0.0.1:4000/dev-console.html** to test the voice flow (mic → Whisper → receptionist → TTS) when using the legacy voice loop or a local voice runtime.

## Multi-tenant model
- **Admin endpoints** are tenant-scoped by membership. Superadmins can select a tenant with `X-Tenant-ID`/`tenantId`.
- DID routing for the voice runtime is stored in Redis via `/api/admin/runtime/dids/map`.

## Persistence and admin auth
- Tenants, configs, calls, and analytics persist to Postgres. Set `DATABASE_URL` (defaults to `postgres://veralux:veralux@localhost:5432/veralux`).
- A local Postgres for dev is available via `docker-compose up -d db`.
- Admin auth supports:
  - Bootstrap env key: `ADMIN_API_KEY`/`VERALUX_ADMIN_KEY`.
  - DB-backed keys (created via `/api/admin/auth/keys`, roles admin/viewer), sent as `X-Admin-Key` or `Authorization: Bearer <token>`.
  - OIDC/JWT: set `ADMIN_JWKS_URL` (or `ADMIN_JWT_SECRET` for HS256), plus optional `ADMIN_JWT_AUDIENCE`/`ADMIN_JWT_ISSUER`; Bearer tokens are verified against JWKS/secret.
- Admin rate limiting (default 100 requests / 5 minutes) is applied to `/api/admin` and `/api/tts`; tune via `ADMIN_RATE_MAX` and `ADMIN_RATE_WINDOW_MS` (ms).
- Secrets: tenant secrets (OpenAI keys, webhook secrets, etc) are stored encrypted in Postgres (set `SECRET_ENCRYPTION_KEY`, 32 bytes recommended). Secrets are never written to `.env` or returned to clients. Providers:
  - `SECRET_MANAGER=db` (default): AES-256-GCM encrypted in Postgres.
  - `SECRET_MANAGER=env`: read-only from env vars (`<PREFIX><TENANT>_<KEY>`, default `SECRET_ENV_PREFIX=TENANT_`).
  - `SECRET_MANAGER=aws`: AWS Secrets Manager (`SECRET_AWS_REGION`, optional `SECRET_AWS_PREFIX`, default `veralux/<tenantId>/<key>`).
  Choose one per environment; for prod, prefer a cloud secret manager and disable the master admin key (`ADMIN_AUTH_MODE=jwt-only` to enforce IdP-only admin).

## Local dev quickstart
**One-shot (services + server + dashboard):** `./scripts/run_services_and_dashboard.sh` — starts Postgres, runs migrations, starts the server, and opens the **admin** UI in your browser. Use `ADMIN_API_KEY=yourkey` before the script if you use the bootstrap key.
**Owner dashboard (one-shot):** `./scripts/run_services_and_owner_dashboard.sh` — same as above but opens the **owner** dashboard (`/owner`) instead of the full admin.

**Run the whole stack in Docker:** `docker compose up -d` builds and runs the app, Postgres, and Redis. Open **http://localhost:4000/admin** or **http://localhost:4000/owner**. Set `ADMIN_API_KEY` and `SECRET_ENCRYPTION_KEY` via a `.env` file or `export` before `docker compose up`. See the [Docker](#docker) section below.

Otherwise, step by step:
1. **Start Postgres:** `docker-compose up -d db`
2. **Optional – Redis:** Start Redis if you want runtime admin routes (`REDIS_URL=redis://127.0.0.1:6379`), or set `ENABLE_RUNTIME_ADMIN=false` to skip Redis in local dev.
3. **Install and run:** `npm install` then start the server:
   - **Full dev (recommended):** `npm run dev` — starts the Node server (and optionally Whisper/Kokoro if `AUDIO_REPO` is set). Default port: **4000**.
   - **Server only:** `npm run dev:server` — Node server only, no auxiliary services.
4. **Admin auth** (pick one):
   - Superadmin bootstrap key: `ADMIN_API_KEY=yourkey npm run dev`
   - Dev JWT (HS256): `ADMIN_AUTH_MODE=jwt-only ADMIN_JWT_SECRET=change-me npm run dev`
5. **Optional:** If storing secrets in Postgres (`SECRET_MANAGER=db`), set `SECRET_ENCRYPTION_KEY=change-me` before saving any secrets.
6. **Optional – legacy voice loop:** Run `ENABLE_LEGACY_VOICE_LOOP=1 npm run dev` if you need in-repo STT/TTS (not recommended; voice runtime is preferred).
7. **Open the dashboard:** Go to **http://127.0.0.1:4000/admin**, enter the admin key when prompted, and manage tenants/configs.
8. **Migrations:** `npm run db:migrate` (up), `npm run db:rollback` (down one step), `npm run db:status` (list applied/pending).
9. **Tests:** `npm run test:runtime` for runtime contract tests; `npm run test` for full test suite.

## Docker
The repo is containerized. **Requirements:** Docker and Docker Compose.

- **Run full stack (app + Postgres + Redis):**  
  `docker compose up -d`  
  The app waits for the database, runs migrations, then starts. Dashboards: **http://localhost:4000/admin** and **http://localhost:4000/owner**.

- **Environment:** Create a `.env` in the project root (or export variables) and set at least:
  - `ADMIN_API_KEY` — admin access (bootstrap key).
  - `SECRET_ENCRYPTION_KEY` — at least 32 bytes when using `SECRET_MANAGER=db` (default in compose).
  Optionally: `ADMIN_ALLOWED_ORIGINS` (e.g. `https://your-domain.com`).

- **Build image only:** `docker build -t veralux-control-plane .`

- **Compose services:** `db` (Postgres 15), `redis` (Redis 7), `app` (Node 20, control plane). The `app` service depends on healthy `db` and `redis`.

## Obsolete in control plane
- Telnyx webhook/media env vars (`TELNYX_*`), STT/TTS env vars (`WHISPER_URL`, `KOKORO_URL`, `XTTS_*`): moved to the voice runtime repo.

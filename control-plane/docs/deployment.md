# Deployment Guide

This repo is the control plane. It can run independently for admin workflows, but live call handling requires the separate voice runtime service.

## Docker (recommended for single-node)

The repo includes a `Dockerfile` and `docker-compose.yml`. To run the full stack (app + Postgres + Redis):

```bash
# Optional: set secrets in .env (ADMIN_API_KEY, SECRET_ENCRYPTION_KEY)
docker compose up -d
```

- **app** listens on port 4000; open `/admin` or `/owner`.
- **db** (Postgres) and **redis** are used by the app; the app waits for DB, runs migrations, then starts.
- Override env via `.env` or `environment` in compose.

## Typical production topology
- Reverse proxy (TLS termination)
- Control plane service (this repo)
- Postgres (managed or self-hosted)
- Redis (required for runtime config publishing)
- Voice runtime service (separate deployment)

## Build and run
1. Install dependencies: `npm ci`
2. Build: `npm run build`
3. Run: `NODE_ENV=production node dist/server.js`

Migrations run on startup. Ensure your DB user can create extensions (e.g., `pgcrypto`).

## Environment setup
Start from `.env.example` and configure:
- `DATABASE_URL`
- `SECRET_MANAGER` and required secret-store settings
- `ADMIN_AUTH_MODE` and `ADMIN_ALLOWED_ORIGINS`
- `REDIS_URL` and `ENABLE_RUNTIME_ADMIN` for runtime publishing

## Reverse proxy notes
- Serve `/admin` from the same origin as the API for simpler CORS.
- Set `ADMIN_ALLOWED_ORIGINS` to the admin UI origin in production.

## Production checklist
- `NODE_ENV=production`
- `ADMIN_AUTH_MODE=jwt-only`
- `ADMIN_ALLOWED_ORIGINS` set
- `ALLOW_ADMIN_API_KEY_IN_PROD=false`
- `SECRET_MANAGER` configured and secrets rotated
- `REDIS_URL` reachable (runtime publishing)
- Voice runtime deployed and connected to Redis

## Health endpoints
- `GET /health`
- `GET /api/admin/health`
- `GET /api/admin/runtime/health`

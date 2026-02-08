# Architecture Overview

This repo hosts the VeraLux control plane. It is responsible for tenant onboarding, admin workflows, configuration, and publishing runtime configuration to Redis. The voice runtime that handles live calls, telephony webhooks, STT/TTS, and media is a separate service.

## System boundaries
- Control plane (this repo): Admin UI + JSON APIs, tenant registry, config/prompts, secrets, audit logs, runtime config publishing.
- Voice runtime (separate repo): Real-time call loop, telephony integration, speech services, audio storage, capacity enforcement.

## Core components
- **API server (Node + Express)**: Serves admin APIs and the admin UI at `/admin`.
- **Admin UI (static)**: Browser interface for tenant management and runtime provisioning.
- **Postgres**: Source of truth for tenants, configs, prompts, audit logs, memberships, and analytics.
- **Secret manager**: Pluggable secret storage (`db`, `env`, or `aws`).
- **Redis (runtime publishing)**: Stores DID -> tenant mappings and runtime tenant config for the voice runtime.
- **Auth providers**: Admin API key and JWT/OIDC support (Cognito is optional).

## Data model (high level)
- Tenants and inbound number mappings
- Per-tenant config and prompts
- Admin users, keys, and audit logs
- Analytics snapshots (for control plane visibility)

## Key flows

### Provisioning flow
1. Create or update tenant metadata and inbound numbers.
2. Store secrets (telephony HMAC, OpenAI key, etc) via the chosen secret manager.
3. Publish runtime tenant config to Redis.
4. Map DIDs to tenant IDs in Redis for runtime lookup.

### Admin access flow
1. Admin UI or API authenticates via API key or JWT.
2. Tenant scope is resolved from membership or `X-Tenant-ID` (superadmin).
3. Admin APIs read/update config, prompts, and audit logs.

## State and scaling notes
- Control plane state is primarily in Postgres; in-memory state is used only for legacy/diagnostic features.
- Redis is required to publish runtime config; if Redis is down, runtime provisioning endpoints fail.
- The control plane can be scaled horizontally, but admin rate limiting is per-instance.

## Legacy endpoints
Public call endpoints (`/api/calls/*`) and telephony endpoints are disabled in this repo and return `voice_runtime_moved` to point callers to the voice runtime service.

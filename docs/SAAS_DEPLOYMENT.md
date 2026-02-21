# VeraLux Receptionist — SaaS Multi-Tenant Deployment Guide

## Overview

This guide covers deploying VeraLux Receptionist as a multi-tenant SaaS platform.
The system supports both on-premise (single-tenant) and SaaS (multi-tenant) modes
using the same codebase, gated by environment variables.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │         Internet / CDN              │
                    └────────────┬────────────────────────┘
                                 │
                    ┌────────────▼────────────────────────┐
                    │    Nginx (TLS termination)          │
                    │    - SSL/TLS (Let's Encrypt)        │
                    │    - Rate limiting (edge)           │
                    │    - WebSocket upgrade              │
                    └──┬────────────────┬────────────────┘
                       │                │
          ┌────────────▼──────┐  ┌──────▼──────────────┐
          │  Control Plane    │  │  Voice Runtime       │
          │  (×2 replicas)    │  │  (×2 replicas)       │
          │  - Admin API      │  │  - WebSocket/media   │
          │  - Billing        │  │  - STT/TTS pipeline  │
          │  - Provisioning   │  │  - Call control      │
          └──┬─────────┬──────┘  └──────┬──────────────┘
             │         │                │
    ┌────────▼──┐  ┌───▼────────┐  ┌───▼────────────────┐
    │ PostgreSQL │  │   Redis    │  │ AI Services         │
    │ (primary)  │  │ (shared)   │  │ Brain, Whisper,     │
    │            │  │            │  │ Kokoro/XTTS         │
    └────────────┘  └────────────┘  └────────────────────┘
```

## Deployment Modes

### On-Premise (Single Tenant)
```bash
# Standard deployment — no changes needed
docker compose -p veralux up -d
```

### SaaS (Multi-Tenant)
```bash
# SaaS mode with TLS, replicas, and billing
docker compose -p veralux \
  -f docker-compose.yml \
  -f docker-compose.saas.yml \
  --profile gpu \
  up -d
```

## Environment Variables

### Required for SaaS Mode

| Variable | Description |
|----------|-------------|
| `SAAS_MODE=true` | Enables self-service signup, billing enforcement |
| `JWT_SECRET` | Secret for signing user JWTs (min 32 chars) |
| `STRIPE_SECRET_KEY` | Stripe API key for billing |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `ADMIN_ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins |

### Scaling Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROL_REPLICAS` | 2 | Number of control plane replicas |
| `RUNTIME_REPLICAS` | 2 | Number of runtime replicas |
| `ADMIN_RATE_MAX` | 200 | API rate limit per window |
| `ADMIN_RATE_WINDOW_MS` | 300000 | Rate limit window (5 min) |

## TLS Setup

### Option 1: Self-Signed (Development)
```bash
./scripts/init-ssl.sh self-signed
```

### Option 2: Let's Encrypt (Production)
```bash
# Start nginx first
docker compose -p veralux --profile tls up -d nginx

# Request certificate
./scripts/init-ssl.sh letsencrypt api.veraluxclients.com
```

Auto-renewal is configured via cron (daily at 3 AM).

## Tenant Provisioning Flow

### Self-Service Signup
```
POST /api/auth/signup
{
  "email": "user@example.com",
  "password": "SecureP@ss123",
  "name": "Jane Smith",
  "companyName": "Acme Corp"
}
```

Returns: `{ user, tenant, token }`

This automatically:
1. Creates a user account
2. Creates a tenant (ID from company name)
3. Creates admin membership
4. Sets up default config (TTS, capacity)
5. Creates default workflows (Lead Capture, Caller Questions)
6. Issues a JWT for immediate use

### Phone Number Assignment
After signup, assign a Telnyx number:
```
POST /api/admin/telnyx/purchase   → buys a number
POST /api/admin/runtime/dids/map  → maps number to tenant
```

### Billing Setup
```
POST /api/admin/stripe/checkout   → creates Stripe checkout session
GET  /api/admin/billing/status    → checks subscription + usage
GET  /api/admin/usage             → current month usage
GET  /api/admin/usage/history     → historical usage
```

## Usage Metering

The system automatically tracks per-tenant usage:
- **call_count**: Total calls received
- **call_minutes**: Total call duration
- **api_requests**: API calls made
- **stt_minutes**: Speech-to-text minutes used
- **tts_characters**: Text-to-speech characters generated

Usage is stored monthly (YYYY-MM period) and checked against plan limits.

### Plan Limits

| Plan | Calls/mo | Minutes/mo | API Req/mo | Numbers |
|------|----------|------------|------------|---------|
| Free | 50 | 100 | 1,000 | 1 |
| Starter | 500 | 1,000 | 10,000 | 2 |
| Professional | 5,000 | 10,000 | 100,000 | 5 |
| Enterprise | Unlimited | Unlimited | Unlimited | Unlimited |
| On-Prem | Unlimited | Unlimited | Unlimited | Unlimited |

## Monitoring

### Prometheus Metrics
```
GET /metrics → Prometheus text format
```

Exposes:
- `veralux_tenants_total` — total registered tenants
- `veralux_subscriptions{status}` — subscriptions by status
- `veralux_tenant_calls_total{tenant}` — calls per tenant
- `veralux_tenant_call_minutes{tenant}` — minutes per tenant
- `veralux_db_pool_total/idle/waiting` — DB connection pool
- `veralux_process_heap_bytes` / `veralux_process_rss_bytes`
- `veralux_process_uptime_seconds`

### System Health
```
GET /api/admin/system/health
```

Returns status, uptime, memory, database stats, tenant counts.

### Health Checks
- `GET /health` — liveness probe
- `GET /ready` — readiness probe (checks DB, Redis)
- `GET /nginx-health` — nginx edge health

## Multi-Region Strategy

For multi-region deployment, the recommended approach:

### Phase 1: Active-Passive (Recommended Start)
1. **Primary Region**: Full stack (all services)
2. **DR Region**: Hot standby with read replica
3. **DNS**: CloudFlare DNS with health-check failover
4. **Database**: PostgreSQL streaming replication
5. **Redis**: Redis Sentinel for failover

### Phase 2: Active-Active
1. **Both regions**: Full control plane + runtime
2. **Database**: CockroachDB or Citus for multi-region Postgres
3. **Redis**: Redis Cluster across regions
4. **Routing**: Geo-DNS routes callers to nearest region
5. **Telnyx**: Configure Telnyx routing for geo-proximity

### Phase 3: Edge Deployment
1. **Edge nodes**: Runtime only (STT/TTS/brain) at edge
2. **Central**: Control plane, billing, auth
3. **Media**: WebSocket connections terminate at nearest edge
4. **Latency**: Sub-100ms voice latency globally

### Implementation Notes

```yaml
# Example: Active-Passive with pg_basebackup
# Primary (us-east)
postgres-primary:
  image: postgres:16
  command: |
    postgres
    -c wal_level=replica
    -c max_wal_senders=5
    -c max_replication_slots=5

# Secondary (eu-west)
postgres-secondary:
  image: postgres:16
  command: |
    pg_basebackup -h primary -D /var/lib/postgresql/data -U replicator -X stream -S secondary
```

## Security Checklist

- [x] Input validation (Zod schemas on all endpoints)
- [x] Tenant isolation (DB queries scoped by tenant_id)
- [x] TLS termination (nginx + Let's Encrypt)
- [x] Rate limiting (Redis-backed, per-IP)
- [x] CORS hardening (origin allowlist)
- [x] Secrets management (rotated, not in git)
- [x] Telnyx signature verification
- [x] JWT-based auth (HS256 / JWKS)
- [x] Password hashing (bcrypt, 12 rounds)
- [x] Graceful shutdown (SIGTERM handling)
- [x] Automated backups (Postgres + Redis, daily)
- [x] Internal service isolation (no exposed ports)

## Running Tests

```bash
# Unit tests (no DB required)
npm test

# Tenant isolation tests
npm run test:isolation

# Full SaaS integration tests (requires DB)
SAAS_MODE=true DATABASE_URL=... JWT_SECRET=... npm run test:saas
```

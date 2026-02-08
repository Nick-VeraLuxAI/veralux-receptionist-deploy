# Codebase Audit Report

**Date:** 2025-01-31  
**Scope:** VeraLux Receptionist control plane (admin, onboarding, config, runtime provisioning).

---

## 1. Executive Summary

The codebase is a well-structured TypeScript/Express control plane with clear separation from the voice runtime, solid use of parameterized SQL, and production-oriented auth/CORS options. The audit identified no critical SQL injection or auth-bypass issues. Findings are mostly hardening (secret key strength, input validation, XSS prevention), dead code, and operational notes (rate limit storage, env mutation).

---

## 2. Architecture & Design

| Area | Assessment |
|------|------------|
| **Structure** | Clear split: `src/` (server, auth, db, tenants, config, runtime, workflows), `public/` (admin UI), `migrations/`, `scripts/`. Runtime contract lives in `src/runtime/runtimeContract.ts` and is consumed by Redis publisher. |
| **Stack** | Express, TypeScript, Postgres (pg), Redis, Zod, jose (JWT). Dependencies are current and minimal. |
| **Multi-tenancy** | Tenant registry in memory with Postgres persistence; tenant resolution for admin (X-Tenant-ID / membership) vs public (DID → number mapping). |
| **Runtime integration** | DID mapping and tenant config published to Redis (`tenantmap:did:<E164>`, `tenantcfg:<tenantId>`); voice runtime consumes these. |

**Recommendation:** No change required. Docs (`docs/architecture.md`, `docs/README.md`) align with the implementation.

---

## 3. Security

### 3.1 Authentication & Authorization

- **Admin auth:** Supports master key (`ADMIN_API_KEY` / `VERALUX_ADMIN_KEY`), DB-backed API keys (hashed with SHA-256), and OIDC/JWT (JWKS or HS256). `ADMIN_AUTH_MODE=jwt-only` and prod defaults (e.g. `isStrongSecret` for JWT, `ADMIN_ALLOWED_ORIGINS` required) are sensible.
- **Tenant scoping:** Superadmins can set tenant via `X-Tenant-ID`/`tenantId`; OIDC users are restricted by `tenant_memberships` and `X-Active-Tenant` when multiple.
- **CORS:** `adminCorsGuard` enforces allowlist in production; no `Origin` allows server-to-server.

**Finding (low):** Admin key delete uses `req.params.id` in `DELETE /api/admin/auth/keys/:id`. The query is parameterized (`where id = $1`), so no SQL injection. The `admin_api_keys.id` column is UUID; non-UUID values simply match no row (204/404 behavior). **Recommendation:** Validate `id` as UUID and return `400` for invalid format so behavior is explicit and logs are cleaner.

### 3.2 Secrets

- **Storage:** `SECRET_MANAGER` supports `db` (AES-256-GCM in Postgres), `env`, and `aws`. Secrets are not echoed to clients or written to `.env` by current code.
- **Encryption key (`secretStore.ts`):** Key is derived as `Buffer.from(ENC_KEY.padEnd(32, "0").slice(0, 32))`. Short or weak `SECRET_ENCRYPTION_KEY` produces a weak key (repeated/truncated bytes). **Recommendation:** When `SECRET_MANAGER=db`, require `SECRET_ENCRYPTION_KEY` to be at least 32 bytes and reject startup or first use if not; avoid padding with a fixed character.

### 3.3 OAuth / Cookies

- **Cognito callback:** Sets `admin_jwt` cookie with `httpOnly`, `sameSite: "lax"`, `secure: false`. **Recommendation:** In production (or when behind HTTPS), set `secure: true` (e.g. from `NODE_ENV === "production"` or an explicit env flag).

### 3.4 Input Validation & Injection

- **SQL:** All queries in `db.ts` use parameterized placeholders (`$1`, `$2`, etc.). No string concatenation of user input into SQL. Dynamic `INSERT` in `setTenantNumbers` builds only the value placeholders; arguments come from the `[tenantId, ...cleaned]` array. **Verdict:** No SQL injection found.
- **Runtime config:** `parseRuntimeTenantConfig` uses Zod; invalid body returns 400 with details.
- **IDs (tenant, DID):** Tenant id length capped (e.g. 64) in POST tenants; DIDs normalized via `normalizeE164` and rejected when invalid.

### 3.5 XSS (Admin UI)

- **admin.html** uses `innerHTML` with data from the API: e.g. analytics `q.text` (line ~1035), call list `c.id`, `c.stage`, `c.callerId`, `c.lead`, `lastMessage.from`, `lastMessage.message` (lines ~1065–1076). If any of these ever contain user-controlled or caller-derived HTML/script, they could be executed. **Recommendation:** Prefer `textContent` or a small escape helper for any user- or caller-derived string before assigning to `innerHTML`, or use a safe templating approach.

### 3.6 Other

- **Rate limiting:** Implemented in-memory in `rateLimit.ts`. Resets on process restart; not shared across instances. **Recommendation:** For multi-instance production, consider a shared store (e.g. Redis) and document current behavior.
- **`persistEnvKey` (server.ts):** Function that writes keys to `.env` exists but is **never called** in the codebase. If re-enabled, it would write server-side env from API input (high risk). **Recommendation:** Remove it or keep it disabled and document that `.env` must not be written by the app.

---

## 4. Database

- **Migrations:** Stored in `migrations/*.sql` with up/down; applied via `scripts/migrate.js`. Schema is consistent (tenants, configs, numbers, calls, analytics, admin keys, audit, secrets, users, memberships).
- **Connections:** Single pool in `db.ts` (max 10). Queries use `pool.connect()` and `client.release()` in `finally`.
- **Transactions:** Used where needed (e.g. `setTenantNumbers`, `upsertCalls`); rollback on error.
- **Deadlock:** `withDeadlockRetry` in migrations handles `40P01` with backoff.

No issues found; parameterization is consistent.

---

## 5. Configuration & Environment

- **Loading:** `dotenv.config()` in `env.ts` and again in `server.ts`; `env.ts` is imported first in `server.ts`.
- **Config store (`config.ts`):** `LLMConfigStore.set()` mutates `process.env.OPENAI_API_KEY` and `process.env.OPENAI_MODEL` when those values are set via API. This is a process-wide side effect and can surprise other code that reads these env vars. **Recommendation:** Document this behavior or avoid mutating `process.env`; keep API/config values only in the in-memory store and tenant DB.
- **Production guards:** Startup checks for strong JWT secret and `ADMIN_ALLOWED_ORIGINS` when `NODE_ENV === "production"`; Redis required when `ENABLE_RUNTIME_ADMIN=true`. Good.

---

## 6. Error Handling & Resilience

- **Global handlers:** `unhandledRejection` and `uncaughtException` log and continue (no exit). Shutdown uses `SIGTERM`/`SIGINT` with server close and 8s timeout.
- **Routes:** Critical paths use try/catch and return appropriate status codes; some log and return 500.
- **Audit:** `recordAudit` is invoked with `void` (fire-and-forget). Failures do not affect the HTTP response; consider at least logging audit write failures.

---

## 7. Code Quality & Maintainability

- **TypeScript:** Used throughout; types for DB rows, config, and runtime contract. Some `(req as any)` / `(payload as any)` in server and auth; could be tightened with explicit types.
- **Validation:** Zod for runtime config; ad-hoc checks for body/query (e.g. provider, OpenAI key format).
- **Dead code:** `persistEnvKey` is never called.
- **Duplication:** `normalizePhoneNumber` and similar helpers appear in both `server.ts` and `tenants.ts`; could live in a shared util.

---

## 8. Testing & Scripts

- **Tests:** `npm run test:runtime` runs Node test runner for runtime contract and publisher. Smoke scripts: `stage1_smoke_test.sh`, `stage2_smoke_test.sh`. No unit tests for server routes, auth, or db in the repo.
- **Scripts:** Migrate, seed, JWT generation, contract check, load test. Appropriate for a control plane.

**Recommendation:** Add unit tests for auth (e.g. JWT vs key, tenant resolution) and for critical db functions (e.g. tenant upsert, secret row access) to guard against regressions.

---

## 9. Documentation

- **README and docs/** cover responsibilities, provisioning flow, env vars, auth modes, and security. Matches the code (e.g. Redis contract, admin auth, secret managers).
- **.env.example** lists main variables; no secrets committed.

---

## 10. Summary of Recommendations

| Priority | Item | Action |
|----------|------|--------|
| High | XSS in admin UI | Escape or use `textContent` for user/caller-derived data in `admin.html` (e.g. `q.text`, call fields). |
| High | Secret encryption key | Enforce min length (e.g. 32 bytes) for `SECRET_ENCRYPTION_KEY` when using DB secrets; avoid naive padding. |
| Medium | OAuth cookie | Set `secure: true` for `admin_jwt` in production (HTTPS). |
| Medium | Rate limit storage | Document in-memory behavior; consider Redis for multi-instance. |
| Medium | process.env mutation | Document or remove mutation of `OPENAI_API_KEY` / `OPENAI_MODEL` in `config.ts`. |
| Low | Admin key ID | Validate UUID for `DELETE /api/admin/auth/keys/:id` and return 400 when invalid. |
| Low | Dead code | Remove or clearly disable `persistEnvKey` and do not re-enable .env writing from API. |
| Low | Tests | Add unit tests for auth and critical db/tenant paths. |

---

*End of audit.*

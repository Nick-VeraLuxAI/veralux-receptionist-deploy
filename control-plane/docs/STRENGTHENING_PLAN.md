# Codebase Strengthening Plan

This plan turns the [CODEBASE_AUDIT](CODEBASE_AUDIT.md) findings into a prioritized, actionable roadmap. Work is grouped into phases so you can tackle security first, then reliability and maintainability.

---

## Phase 1: Quick Wins (1–2 days)

Low-risk, high-value changes that close gaps and reduce confusion.

### 1.1 Remove dead code and document .env policy

| Task | Where | Action |
|------|--------|--------|
| Remove `persistEnvKey` | `src/server.ts` | Delete the function and its body (lines ~429–455). It is never called and writing `.env` from the API would be a security risk. |
| Document .env policy | `docs/configuration.md` or `docs/security.md` | Add a short note: "The application must not write to `.env`. All config is loaded at startup; tenant secrets live in the secret manager." |

**Acceptance:** No references to `persistEnvKey`; docs state that the app does not write `.env`.

---

### 1.2 Harden OAuth cookie in production

| Task | Where | Action |
|------|--------|--------|
| Set `secure: true` when appropriate | `src/server.ts` (OAuth callback) | When setting the `admin_jwt` cookie, use `secure: process.env.NODE_ENV === "production"` (or a dedicated env like `COOKIE_SECURE=true`) so the cookie is only sent over HTTPS in prod. |

**Acceptance:** In production, the cookie is set with `secure: true`; local dev still works with `secure: false`.

---

### 1.3 Validate admin key ID on delete

| Task | Where | Action |
|------|--------|--------|
| Validate UUID for `DELETE /api/admin/auth/keys/:id` | `src/server.ts` | Before calling `revokeAdminKey(id)`, check that `id` matches a UUID regex (e.g. same pattern as in `db.ts`: `isUuid`). If not, return `400` with `error: "invalid_id"`. |

**Acceptance:** Non-UUID `id` returns 400; valid UUID continues to current behavior (delete or 200).

---

### 1.4 Document rate-limit and env-mutation behavior

| Task | Where | Action |
|------|--------|--------|
| Rate limit | `docs/operations.md` or `docs/limitations.md` | Add: "Admin rate limiting is in-memory per process. Limits reset on restart and are not shared across instances. For multi-instance deployments, consider a Redis-backed limiter." |
| process.env mutation | `docs/configuration.md` or `src/config.ts` (JSDoc) | State that when LLM config is updated via API, `OPENAI_API_KEY` and `OPENAI_MODEL` are also written to `process.env` for compatibility with code that reads env; tenant-specific values are stored in the config store and secret manager. |

**Acceptance:** Operators and developers can find and understand both behaviors.

---

## Phase 2: Security Hardening (2–3 days)

Addresses XSS, secret key strength, and optional input validation.

### 2.1 Prevent XSS in admin UI

| Task | Where | Action |
|------|--------|--------|
| Escape or use text for API-derived data | `public/admin.html` | Introduce a small `escapeHtml(str)` (or use `textContent` where you build elements). Use it for: `q.text` (analytics), and in the call list for `c.id`, `c.stage`, `c.callerId`, `c.lead`, `lastMessage.from`, `lastMessage.message`. Prefer building DOM with `createElement` + `textContent` for text, and only set `innerHTML` for static markup. |
| Audit other innerHTML uses | `public/admin.html` | For any remaining `innerHTML` that includes API data (tenant names, keys, etc.), ensure the dynamic parts are escaped or rendered as text. |

**Acceptance:** No user- or caller-derived string is inserted into `innerHTML` without escaping; manual test with a payload like `&lt;script&gt;alert(1)&lt;/script&gt;` in analytics or call data does not execute script.

---

### 2.2 Enforce secret encryption key strength

| Task | Where | Action |
|------|--------|--------|
| Reject weak key when using DB secrets | `src/secretStore.ts` | When `SECRET_MANAGER=db` (or when constructing `EncryptedDbSecretProvider`), require `SECRET_ENCRYPTION_KEY` to be at least 32 bytes (e.g. 32 UTF-8 bytes). If missing or too short, throw at module load or on first use with a clear message (e.g. "SECRET_ENCRYPTION_KEY must be at least 32 bytes when SECRET_MANAGER=db"). Do not use `padEnd(32, "0")` for short keys. Optionally allow a dedicated env (e.g. base64) for binary keys. |
| Document key requirements | `docs/configuration.md` / `.env.example` | State that for `SECRET_MANAGER=db`, `SECRET_ENCRYPTION_KEY` must be at least 32 characters (or 32 bytes); recommend a cryptographically random value. |

**Acceptance:** With `SECRET_MANAGER=db` and key &lt; 32 bytes, the app fails fast with a clear error; with ≥32 bytes, behavior is unchanged.

---

### 2.3 (Optional) Centralize request body validation

| Task | Where | Action |
|------|--------|--------|
| Use Zod for admin request bodies | `src/server.ts` (and optionally a small `src/schemas.ts`) | For key routes (e.g. POST config, POST tenants, POST auth/keys), define Zod schemas and parse `req.body` through them. Return 400 with `err.issues` (or a sanitized message) on failure. Reuse or align with `runtimeContract` patterns. |

**Acceptance:** Invalid bodies get consistent 400 responses and error shape; types stay in sync with validation.

---

## Phase 3: Reliability & Operations (2–4 days)

Makes the system easier to run in production and across multiple instances.

### 3.1 Redis-backed rate limiter (optional)

| Task | Where | Action |
|------|--------|--------|
| Add optional Redis backend for rate limit | `src/rateLimit.ts` (and possibly `src/redis.ts`) | If `REDIS_URL` is set, use Redis (e.g. INCR + EXPIRE or a small Lua script) for the admin rate-limit key; otherwise keep current in-memory behavior. Key could be `ratelimit:admin:<keyFn(req)>`. Document in operations/configuration. |
| Config flag | `src/server.ts` / env | Optional: `ADMIN_RATE_USE_REDIS=true` to switch to Redis; default false to avoid changing behavior. |

**Acceptance:** With Redis enabled, rate limits are shared across instances; without Redis, behavior is unchanged.

---

### 3.2 Graceful shutdown and connection cleanup

| Task | Where | Action |
|------|--------|--------|
| Close DB pool on shutdown | `src/server.ts` | In the shutdown handler (SIGTERM/SIGINT), after closing the HTTP server, call `closePool()` from `db.ts` so Postgres connections are closed cleanly. |
| Close Redis on shutdown (if used) | `src/server.ts`, `src/redis.ts`, `src/runtime/runtimePublisher.ts` | If the app opens Redis (runtime publisher or rate limit), call the relevant `close`/`quit` on shutdown so connections are released. |

**Acceptance:** On SIGTERM/SIGINT, the process closes HTTP, then DB pool, then Redis (if any), and exits without leaving dangling connections.

---

### 3.3 Health endpoint and readiness

| Task | Where | Action |
|------|--------|--------|
| Differentiate liveness vs readiness | `src/server.ts` | Keep `GET /health` as a simple liveness check (e.g. 200 + `{ status: "ok" }`). Optionally add `GET /ready` that checks DB (e.g. `SELECT 1`) and, if `ENABLE_RUNTIME_ADMIN` and Redis are used, Redis. Return 503 if any dependency is down. Document in `docs/api.md` and deployment. |

**Acceptance:** Orchestrators can use `/health` for liveness and `/ready` (if added) for readiness; docs describe the difference.

---

## Phase 4: Maintainability & Testing (ongoing)

Improves long-term safety and refactorability.

### 4.1 Unit tests for auth and tenant resolution

| Task | Where | Action |
|------|--------|--------|
| Auth tests | `tests/auth.test.ts` (or similar) | Tests for: master key accepted/rejected, DB key by hash accepted/rejected, JWT (e.g. HS256) accepted with valid signature and rejected with bad signature or wrong secret, `ADMIN_AUTH_MODE=jwt-only` blocks API key when configured. Mock DB and env as needed. |
| Tenant resolution tests | `tests/tenants.test.ts` or `tests/server.test.ts` | Tests for: `resolveTenant` / `resolveTenantForAdmin` with dialed number, X-Tenant-ID, default tenant; `ensureTenantAccess` for superadmin vs tenant-admin. Can use in-memory or mocked registry. |

**Acceptance:** `npm run test` (or a dedicated test script) runs these tests; they pass and are stable (no flake from shared state).

---

### 4.2 Unit tests for critical DB and secret paths

| Task | Where | Action |
|------|--------|--------|
| DB tests | `tests/db.test.ts` | With a test DB or transactions that roll back: upsert tenant, set tenant numbers (including conflict case), get/upsert secret row, admin key by hash. Ensures parameterization and constraints behave as expected. |
| Secret store tests | `tests/secretStore.test.ts` | For `SECRET_MANAGER=db`: encrypt/decrypt round-trip; reject when key too short (if you added Phase 2.2). Can use an in-memory or test DB. |

**Acceptance:** Critical DB and secret flows are covered; tests run in CI or locally with minimal setup.

---

### 4.3 Shared utilities and types

| Task | Where | Action |
|------|--------|--------|
| Shared helpers | `src/utils/` (e.g. `src/utils/validation.ts`, `src/utils/phone.ts`) | Move `normalizePhoneNumber` (and any UUID check) into a small util used by `server.ts` and `tenants.ts`. Add a single `escapeHtml` for the admin UI (or put it in a tiny `public/js/util.js`). |
| Reduce `any` in server/auth | `src/server.ts`, `src/auth.ts` | Replace `(req as any).rawBody`, `(payload as any).role` etc. with proper types (e.g. `AuthedRequest` extending Request with `rawBody?`, or a small JWT payload type). |

**Acceptance:** No duplicated normalization logic; fewer `any` casts; admin XSS helper is reusable.

---

## Suggested order of execution

1. **Phase 1** – Do all of it first (quick wins, no breaking changes).
2. **Phase 2.1 and 2.2** – XSS and secret key strength (highest security impact).
3. **Phase 2.3** – Optional; do when you touch those routes for other reasons.
4. **Phase 3** – Pick 3.2 (shutdown) and 3.3 (health/ready) before scaling out; 3.1 (Redis rate limit) when you run multiple instances.
5. **Phase 4** – Add tests and refactors incrementally; start with 4.1 (auth) and 4.2 (db/secrets), then 4.3.

---

## Checklist (copy and track)

- [ ] 1.1 Remove `persistEnvKey`; document .env policy  
- [ ] 1.2 OAuth cookie `secure` in production  
- [ ] 1.3 Validate admin key ID (UUID) on delete  
- [ ] 1.4 Document rate limit and process.env mutation  
- [ ] 2.1 Escape API-derived data in admin UI (XSS)  
- [ ] 2.2 Enforce SECRET_ENCRYPTION_KEY length for DB secrets  
- [ ] 2.3 (Optional) Zod for admin request bodies  
- [ ] 3.1 (Optional) Redis-backed rate limiter  
- [ ] 3.2 Graceful shutdown (DB pool, Redis)  
- [ ] 3.3 Liveness vs readiness (e.g. /ready)  
- [x] 4.1 Auth and tenant-resolution tests (auth + normalizeE164; tenant resolution left for integration)
- [ ] 4.2 DB and secret store tests (optional; add when test DB or mocks available)
- [x] 4.3 Shared utils (normalizePhoneNumber in utils/phone, isUuid in utils/validation; reduced duplication)  

---

*This plan is derived from [CODEBASE_AUDIT.md](CODEBASE_AUDIT.md). Update both when you complete items or discover new requirements.*

# Known Limitations

- This repo does not handle live calls; voice runtime is separate and required for telephony.
- Runtime provisioning depends on Redis availability; publish/read endpoints fail if Redis is down.
- The admin UI sends tokens via `X-Admin-Key`; in strict JWT-only mode you may need to use `Authorization: Bearer <jwt>` or update the UI.
- There is no built-in UI for managing OIDC tenant memberships; seed `tenant_memberships` in Postgres.
- Analytics and call snapshots in the control plane are lightweight and not a full call history system.
- Admin rate limiting is in-memory per process; limits reset on restart and are not shared across instances. Multi-instance deployments need external (e.g. gateway) or Redis-backed rate limiting for strict consistency.

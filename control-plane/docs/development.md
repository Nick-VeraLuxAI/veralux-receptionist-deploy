# Development

This guide focuses on local control-plane development. Live call handling is in the voice runtime repo.

## Local setup
1. Start Postgres: `docker-compose up -d db`
2. (Optional) Start Redis for runtime publishing.
3. Install dependencies: `npm install`
4. Run the server: `npm run dev`
5. Visit: `http://127.0.0.1:4000/admin`

## Admin auth in dev
Pick one of the following:
- Bootstrap key: `ADMIN_API_KEY=devkey npm run dev`
- Dev JWT (HS256):
  ```bash
  ADMIN_JWT_SECRET=change-me node scripts/gen_dev_jwt.js user-1 admin user1@test.com
  ```

## Runtime integration checks
- Generate the control-plane runtime report: `npm run report:runtime`
- Verify compatibility against runtime report: `npm run check:contract`

## Testing
- **Unit tests:** `npm run test` — builds and runs auth, validation, runtime contract, and runtime publisher tests (Node built-in test runner).
- **Runtime-only:** `npm run test:runtime` — same as above but only runtime contract and publisher.
- One auth test hits the DB when the master key is wrong; if Postgres is unreachable (e.g. sandbox), that test skips the assertion and passes.

## Notes
- Public call endpoints in this repo return `voice_runtime_moved`.
- The admin UI is static and uses the admin APIs in this repo.

#!/usr/bin/env bash
# Start backing services (Postgres), run migrations, start the Node server, and open the admin dashboard.
# Usage: ./scripts/run_services_and_dashboard.sh
# Optional: ADMIN_API_KEY=yourkey ./scripts/run_services_and_dashboard.sh
# For Redis (runtime admin): start Redis (e.g. docker run -d -p 6379:6379 redis) or set REDIS_URL before running.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4000}"
DASHBOARD_URL="http://127.0.0.1:${PORT}/admin"

echo "[run] Starting Docker services (Postgres)…"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d db
else
  docker-compose up -d db
fi

echo "[run] Waiting for Postgres on :5432…"
postgres_ready() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h 127.0.0.1 -p 5432 -U veralux -q 2>/dev/null
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 5432 2>/dev/null
  else
    (echo >/dev/tcp/127.0.0.1/5432) 2>/dev/null
  fi
}
for i in $(seq 1 30); do
  if postgres_ready; then break; fi
  if [ "$i" -eq 30 ]; then
    echo "[run] ERROR: Postgres did not become ready in time."
    exit 1
  fi
  sleep 1
done
echo "[run] Postgres is ready."

if [ -f "package.json" ] && grep -q '"db:migrate"' package.json 2>/dev/null; then
  echo "[run] Running migrations…"
  npm run -s db:migrate 2>/dev/null || true
fi

# Point the server at the Postgres we just started (so it works even if .env uses another port)
export DATABASE_URL="postgres://veralux:veralux@127.0.0.1:5432/veralux"

echo "[run] Opening dashboard in 3s: $DASHBOARD_URL"
( sleep 3 && (open "$DASHBOARD_URL" 2>/dev/null || xdg-open "$DASHBOARD_URL" 2>/dev/null || true) ) &

echo "[run] Starting VeraLux server on port $PORT (Ctrl+C to stop)."
exec npm run -s dev:server

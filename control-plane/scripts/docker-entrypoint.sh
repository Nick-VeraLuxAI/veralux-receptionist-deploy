#!/bin/sh
set -e

# Require ADMIN_API_KEY in production — refuse to start with a default
if [ -z "$ADMIN_API_KEY" ]; then
  if [ "$NODE_ENV" = "production" ]; then
    echo "[entrypoint] FATAL: ADMIN_API_KEY is required in production."
    echo "[entrypoint] Set ADMIN_API_KEY in your .env file or environment."
    exit 1
  fi
  # Dev/test only: generate a random key so the app can start
  export ADMIN_API_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "[entrypoint] WARNING: Generated random ADMIN_API_KEY for development."
  echo "[entrypoint] ADMIN_API_KEY=$ADMIN_API_KEY"
fi

# Allow x-admin-key auth in production (needed for admin dashboard)
if [ -z "$ALLOW_ADMIN_API_KEY_IN_PROD" ]; then
  export ALLOW_ADMIN_API_KEY_IN_PROD="true"
fi

# Owner portal JWT: fall back to JWT_SECRET if ADMIN_JWT_SECRET not set
if [ -z "$ADMIN_JWT_SECRET" ] && [ -n "$JWT_SECRET" ]; then
  export ADMIN_JWT_SECRET="$JWT_SECRET"
fi

echo "[entrypoint] Waiting for Postgres..."
node scripts/wait-for-db.js
echo "[entrypoint] Running migrations..."
node scripts/migrate.js up
echo "[entrypoint] Starting server..."
exec node dist/server.js

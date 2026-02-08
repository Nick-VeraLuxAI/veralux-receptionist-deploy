#Run All Tests: ./scripts/run_all_tests.sh
#Run Stage Tests: PARTS=stage ./scripts/run_all_tests.sh
#Run Only Load Tests: PARTS=load ./scripts/run_all_tests.sh
#Run Only One Load Test: PARTS=load LOAD_ONLY=global ./scripts/run_all_tests.sh



#!/usr/bin/env bash
set -euo pipefail

#############################################
# Config
#############################################

# Server base URL
export BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"

# Capacity + abuse limits (so global cap is the main limiter when desired)
export TENANT_MAX_CONCURRENT_CALLS="${TENANT_MAX_CONCURRENT_CALLS:-100}"
export TENANT_MAX_CALLS_PER_MINUTE="${TENANT_MAX_CALLS_PER_MINUTE:-10000}"
export CALL_START_IP_RATE_MAX="${CALL_START_IP_RATE_MAX:-10000}"
export MAX_ACTIVE_CALLS="${MAX_ACTIVE_CALLS:-30}"

# Admin auth: DEV JWT-only for test harness
export ADMIN_AUTH_MODE="jwt-only"
export ADMIN_JWT_SECRET="${ADMIN_JWT_SECRET:-dev-jwt-secret-change-me}"

# Disable IdP validation explicitly for devtest mode
export ADMIN_JWKS_URL=""
export ADMIN_JWT_ISSUER=""
export ADMIN_JWT_AUDIENCE=""

# Load test knobs
export HOLD_CALL_MS="${HOLD_CALL_MS:-20000}"
export START_SPACING_MS="${START_SPACING_MS:-150}"
export PARALLEL_STARTS="${PARALLEL_STARTS:-40}"

# If you want to run only some parts:
#   PARTS=stage|load|all
PARTS="${PARTS:-all}"

# If you want only certain load tests:
#   LOAD_ONLY=global|tenant|rate|spam|all
LOAD_ONLY="${LOAD_ONLY:-all}"

#############################################
# Helpers
#############################################

wait_for_server () {
  echo "⏳ Waiting for server at ${BASE_URL} ..."
  for i in {1..60}; do
    # Prefer /health if present, otherwise just check server responds at /
    if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
      echo "✅ Server ready (/health)"
      return
    fi
    if curl -sf "${BASE_URL}/" >/dev/null 2>&1; then
      echo "✅ Server ready (/)"
      return
    fi
    sleep 1
  done
  echo "❌ Server did not become ready in time"
  exit 1
}

cleanup () {
  echo ""
  echo "🧹 Shutting down dev server..."
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

run_stage_tests () {
  echo ""
  echo "=============================="
  echo "✅ Running Stage 1"
  echo "=============================="
  BASE_URL="${BASE_URL}" ADMIN_JWT_SECRET="${ADMIN_JWT_SECRET}" npm run test:stage1

  echo ""
  echo "=============================="
  echo "✅ Running Stage 2"
  echo "=============================="
  BASE_URL="${BASE_URL}" ADMIN_JWT_SECRET="${ADMIN_JWT_SECRET}" npm run test:stage2
}

gen_admin_bearer () {
  echo ""
  echo "🔐 Generating ADMIN_BEARER (dev JWT)..."
  # gen_dev_jwt.js requires args: <sub> [role] [email]
  export ADMIN_BEARER="Bearer $(ADMIN_JWT_SECRET="${ADMIN_JWT_SECRET}" node scripts/gen_dev_jwt.js user-1 admin u1@test.com)"
  echo "✅ ADMIN_BEARER set"
}

run_load_tests () {
  LEGACY_STATUS=$(curl -sS -o /tmp/load_legacy_check -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -X POST "$BASE_URL/api/calls/start" \
    --data "{}" || true)
  if [[ "$LEGACY_STATUS" == "410" ]]; then
    echo "Legacy voice endpoints disabled (control plane mode); skipping load tests."
    return
  fi

  gen_admin_bearer

  # Your load_test_calls.mjs already supports ONLY=...
  # We'll run multiple passes if requested.
  echo ""
  echo "=============================="
  echo "🔥 Running Load Tests (${LOAD_ONLY})"
  echo "=============================="

  if [[ "${LOAD_ONLY}" == "all" ]]; then
    ONLY=all \
      BASE_URL="${BASE_URL}" \
      ADMIN_BEARER="${ADMIN_BEARER}" \
      HOLD_CALL_MS="${HOLD_CALL_MS}" \
      START_SPACING_MS="${START_SPACING_MS}" \
      PARALLEL_STARTS="${PARALLEL_STARTS}" \
      node scripts/load_test_calls.mjs
    return
  fi

  ONLY="${LOAD_ONLY}" \
    BASE_URL="${BASE_URL}" \
    ADMIN_BEARER="${ADMIN_BEARER}" \
    HOLD_CALL_MS="${HOLD_CALL_MS}" \
    START_SPACING_MS="${START_SPACING_MS}" \
    PARALLEL_STARTS="${PARALLEL_STARTS}" \
    node scripts/load_test_calls.mjs
}

#############################################
# Start server
#############################################

echo "🚀 Starting server in DEVTEST posture..."
npm run dev &
SERVER_PID=$!

wait_for_server

#############################################
# Run requested parts
#############################################

case "${PARTS}" in
  stage)
    run_stage_tests
    ;;
  load)
    run_load_tests
    ;;
  all)
    run_stage_tests
    run_load_tests
    ;;
  *)
    echo "❌ Unknown PARTS=${PARTS}. Use PARTS=stage|load|all"
    exit 1
    ;;
esac

echo ""
echo "✅ All requested tests completed."

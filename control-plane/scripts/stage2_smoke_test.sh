#!/usr/bin/env bash

# Load .env if present, but don't clobber explicit env overrides (e.g. ADMIN_JWT_SECRET passed on the CLI)
if [ -f .env ]; then
  _user_BASE_URL="${BASE_URL-}"
  _user_ADMIN_JWT_SECRET="${ADMIN_JWT_SECRET-}"
  _user_ADMIN_JWT_ISSUER="${ADMIN_JWT_ISSUER-}"
  _user_ADMIN_JWT_AUDIENCE="${ADMIN_JWT_AUDIENCE-}"
  _user_TELE_SECRET_A="${TELE_SECRET_A-}"
  _user_TELE_SECRET_B="${TELE_SECRET_B-}"
  _user_TENANT_A_NUMBER="${TENANT_A_NUMBER-}"

  set -a
  . ./.env
  set +a

  [ -n "${_user_BASE_URL}" ] && BASE_URL="$_user_BASE_URL"
  [ -n "${_user_ADMIN_JWT_SECRET}" ] && ADMIN_JWT_SECRET="$_user_ADMIN_JWT_SECRET"
  [ -n "${_user_ADMIN_JWT_ISSUER}" ] && ADMIN_JWT_ISSUER="$_user_ADMIN_JWT_ISSUER"
  [ -n "${_user_ADMIN_JWT_AUDIENCE}" ] && ADMIN_JWT_AUDIENCE="$_user_ADMIN_JWT_AUDIENCE"
  [ -n "${_user_TELE_SECRET_A}" ] && TELE_SECRET_A="$_user_TELE_SECRET_A"
  [ -n "${_user_TELE_SECRET_B}" ] && TELE_SECRET_B="$_user_TELE_SECRET_B"
  [ -n "${_user_TENANT_A_NUMBER}" ] && TENANT_A_NUMBER="$_user_TENANT_A_NUMBER"
fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
JWT_SECRET="${ADMIN_JWT_SECRET:-}"
JWT_ISSUER="${ADMIN_JWT_ISSUER:-local}"
JWT_AUDIENCE="${ADMIN_JWT_AUDIENCE:-local}"
TELE_SECRET_A="${TELE_SECRET_A:-stage2-secret-A}"
TELE_SECRET_B="${TELE_SECRET_B:-stage2-secret-B}"
TENANT_A_NUMBER="${TENANT_A_NUMBER:-+15551234567}"

if [ -z "$JWT_SECRET" ]; then
  echo "ADMIN_JWT_SECRET is required in env for the Stage 2 smoke test."
  exit 1
fi

LEGACY_STATUS=$(curl -sS -o /tmp/stage2_legacy_check -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/calls/start" \
  --data "{}" || true)
if [ "$LEGACY_STATUS" = "410" ]; then
  echo "Legacy voice endpoints disabled (control plane mode); skipping Stage 2 tests."
  exit 0
fi

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

sign_body() {
  local body_file="$1" secret="$2"
  node - <<'NODE' "$body_file" "$secret"
const fs = require("fs");
const crypto = require("crypto");
const bodyPath = process.argv[2];
const secret = process.argv[3];
const raw = fs.readFileSync(bodyPath);
const h = crypto.createHmac("sha256", secret);
h.update(raw);
process.stdout.write(h.digest("hex"));
NODE
}

decode_payload() {
  local token="$1"
  node -e 'const t=process.argv[1]; const p=t.split(".")[1]; console.log(JSON.parse(Buffer.from(p,"base64url").toString()));' "$token" || true
}

# Seed DB
node "$ROOT/scripts/seed_stage1_test.js"

# Generate JWTs
USER1_JWT=$(
  ADMIN_JWT_SECRET="$JWT_SECRET" ADMIN_JWT_ISSUER="$JWT_ISSUER" ADMIN_JWT_AUDIENCE="$JWT_AUDIENCE" \
  node "$ROOT/scripts/gen_dev_jwt.js" user-1 admin u1@test.com
)
USER2_JWT=$(
  ADMIN_JWT_SECRET="$JWT_SECRET" ADMIN_JWT_ISSUER="$JWT_ISSUER" ADMIN_JWT_AUDIENCE="$JWT_AUDIENCE" \
  node "$ROOT/scripts/gen_dev_jwt.js" user-2 admin u2@test.com
)

for v in USER1_JWT USER2_JWT; do
  tok="${!v}"
  [ -n "$tok" ] || fail "$v is empty"
done

# Ensure tenantA has a number mapping and secrets set
STATUS=$(curl -sS -o /tmp/stage2_tenants -w "%{http_code}" \
  -H "Authorization: Bearer $USER1_JWT" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/admin/tenants" \
  --data "{\"id\":\"tenantA\",\"numbers\":[\"$TENANT_A_NUMBER\"]}")
[ "$STATUS" = "200" ] || fail "Failed to upsert tenantA numbers (status $STATUS)"

STATUS=$(curl -sS -o /tmp/stage2_secretA -w "%{http_code}" \
  -H "Authorization: Bearer $USER1_JWT" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/admin/telephony/secret" \
  --data "{\"secret\":\"$TELE_SECRET_A\"}")
[ "$STATUS" = "200" ] || fail "Failed to set tenantA telephony secret (status $STATUS)"

STATUS=$(curl -sS -o /tmp/stage2_secretB -w "%{http_code}" \
  -H "Authorization: Bearer $USER2_JWT" \
  -H "X-Active-Tenant: tenantB" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/admin/telephony/secret" \
  --data "{\"secret\":\"$TELE_SECRET_B\"}")
[ "$STATUS" = "200" ] || fail "Failed to set tenantB telephony secret (status $STATUS)"

# ---------- Test data
START_BODY="$tmpdir/start.json"
printf '{"callerId":"demo","calledNumber":"%s","initialMessage":"Hello"}' "$TENANT_A_NUMBER" >"$START_BODY"

MSG_BODY="$tmpdir/msg.json"
printf '{"message":"Follow up"}' >"$MSG_BODY"

VALID_SIG_START=$(sign_body "$START_BODY" "$TELE_SECRET_A")
WRONG_SIG_START=$(sign_body "$START_BODY" "badsecret")
VALID_SIG_MSG=$(sign_body "$MSG_BODY" "$TELE_SECRET_A")
WRONG_SIG_MSG=$(sign_body "$MSG_BODY" "badsecret")
TENANTB_SIG_START=$(sign_body "$START_BODY" "$TELE_SECRET_B")

# ----- 1a: start without signature -> 401
RES=$(curl -sS -o /tmp/res1a -w "%{http_code}" -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/calls/start" --data-binary @"$START_BODY")
if [ "$RES" = "401" ] && grep -q "invalid_signature" /tmp/res1a; then
  pass "1a start without signature rejected"
else
  echo "DEBUG 1a response: $(cat /tmp/res1a)"
  fail "1a expected 401 invalid_signature, got $RES"
fi

# ----- 1b: start with valid signature -> 200 + callId
START_RES=$(curl -sS -o /tmp/res1b_body -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $VALID_SIG_START" \
  -X POST "$BASE_URL/api/calls/start" --data-binary @"$START_BODY")
if [ "$START_RES" != "200" ]; then
  echo "DEBUG 1b response: $(cat /tmp/res1b_body)"
  fail "1b expected 200 from start with valid signature, got $START_RES"
fi
CALL_ID=$(node -e "const d=require('fs').readFileSync('/tmp/res1b_body','utf8'); try{const j=JSON.parse(d); console.log(j.callId||'');}catch{console.log('');}")
if [ -z "$CALL_ID" ]; then
  echo "DEBUG 1b body: $(cat /tmp/res1b_body)"
  fail "1b missing callId"
fi
pass "1b start with valid signature succeeded (callId=$CALL_ID)"

# ----- 2a: message with wrong signature -> 401
RES=$(curl -sS -o /tmp/res2a -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $WRONG_SIG_MSG" \
  -X POST "$BASE_URL/api/calls/$CALL_ID/message" --data-binary @"$MSG_BODY")
if [ "$RES" = "401" ]; then
  pass "2a message with wrong signature rejected"
else
  echo "DEBUG 2a response: $(cat /tmp/res2a)"
  fail "2a expected 401 for wrong signature, got $RES"
fi

# ----- 2b: message with valid signature -> 200
RES=$(curl -sS -o /tmp/res2b -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $VALID_SIG_MSG" \
  -X POST "$BASE_URL/api/calls/$CALL_ID/message" --data-binary @"$MSG_BODY")
if [ "$RES" = "200" ]; then
  pass "2b message with valid signature succeeded"
else
  echo "DEBUG 2b response: $(cat /tmp/res2b)"
  fail "2b expected 200 for valid signature, got $RES"
fi

# ----- 3a: tenant override attempt with header + tenantB signature -> must fail
RES=$(curl -sS -o /tmp/res3a -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: tenantB" \
  -H "X-Signature: $TENANTB_SIG_START" \
  -X POST "$BASE_URL/api/calls/start" --data-binary @"$START_BODY")
if [ "$RES" = "401" ]; then
  pass "3a tenant override with tenantB signature rejected"
else
  echo "DEBUG 3a response: $(cat /tmp/res3a)"
  fail "3a expected 401 when using tenantB signature + override header, got $RES"
fi

# ----- 3b: tenant override with correct tenantA signature still succeeds (header ignored)
RES=$(curl -sS -o /tmp/res3b_body -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: tenantB" \
  -H "X-Signature: $VALID_SIG_START" \
  -X POST "$BASE_URL/api/calls/start" --data-binary @"$START_BODY")
if [ "$RES" = "200" ]; then
  pass "3b override header ignored; valid tenantA signature still works"
else
  echo "DEBUG 3b response: $(cat /tmp/res3b_body)"
  fail "3b expected 200 with tenantA signature even when override header present, got $RES"
fi

echo "✅ Stage 2 ingress security smoke tests passed."

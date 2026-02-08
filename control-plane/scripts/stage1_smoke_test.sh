#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
JWT_SECRET="${ADMIN_JWT_SECRET:-}"
JWT_ISSUER="${ADMIN_JWT_ISSUER:-local}"
JWT_AUDIENCE="${ADMIN_JWT_AUDIENCE:-local}"

if [ -z "$JWT_SECRET" ]; then
  echo "ADMIN_JWT_SECRET is required in env for the smoke test."
  exit 1
fi

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

decode_payload() {
  local token="$1"
  node -e 'const t=process.argv[1]; const p=t.split(".")[1]; console.log(JSON.parse(Buffer.from(p,"base64url").toString()));' "$token" || true
}

# Seed DB
node "$ROOT/scripts/seed_stage1_test.js"
echo "Seed complete for Stage 1 test."

# Generate JWTs
USER1_JWT=$(
  ADMIN_JWT_SECRET="$JWT_SECRET" ADMIN_JWT_ISSUER="$JWT_ISSUER" ADMIN_JWT_AUDIENCE="$JWT_AUDIENCE" \
  node "$ROOT/scripts/gen_dev_jwt.js" user-1 admin u1@test.com
)
USER2_JWT=$(
  ADMIN_JWT_SECRET="$JWT_SECRET" ADMIN_JWT_ISSUER="$JWT_ISSUER" ADMIN_JWT_AUDIENCE="$JWT_AUDIENCE" \
  node "$ROOT/scripts/gen_dev_jwt.js" user-2 admin u2@test.com
)
USER3_JWT=$(
  ADMIN_JWT_SECRET="$JWT_SECRET" ADMIN_JWT_ISSUER="$JWT_ISSUER" ADMIN_JWT_AUDIENCE="$JWT_AUDIENCE" \
  node "$ROOT/scripts/gen_dev_jwt.js" user-3 admin u3@test.com
)

# Sanity
for v in USER1_JWT USER2_JWT USER3_JWT; do
  tok="${!v}"
  [ -n "$tok" ] || fail "$v is empty"
  parts="$(echo "$tok" | awk -F. '{print NF}')"
  [ "$parts" = "3" ] || fail "$v does not look like a JWT"
done

# ----- Test A: user-3 no membership -> 403
RES=$(curl -sS -o /tmp/resA -w "%{http_code}" -H "Authorization: Bearer $USER3_JWT" "$BASE_URL/api/admin/tenants")
if [ "$RES" = "403" ] && grep -q "No tenant membership" /tmp/resA; then
  pass "A user-3 forbidden as expected"
else
  echo "DEBUG A response: $(cat /tmp/resA)"
  echo "DEBUG A jwt payload:"
  decode_payload "$USER3_JWT"
  fail "A expected 403 No tenant membership, got $RES"
fi

# ----- Test B: user-1 single membership -> 200
RES=$(curl -sS -o /tmp/resB -w "%{http_code}" -H "Authorization: Bearer $USER1_JWT" "$BASE_URL/api/admin/config")
if [ "$RES" = "200" ]; then
  pass "B user-1 single membership succeeded"
else
  echo "DEBUG B response: $(cat /tmp/resB)"
  echo "DEBUG B jwt payload:"
  decode_payload "$USER1_JWT"
  fail "B expected 200 for user-1, got $RES"
fi

# ----- Test C: user-1 tries tenant hop -> still 200
RES=$(curl -sS -o /tmp/resC -w "%{http_code}" -H "Authorization: Bearer $USER1_JWT" -H "X-Tenant-ID: tenantB" "$BASE_URL/api/admin/config")
if [ "$RES" = "200" ]; then
  pass "C user-1 cannot hop tenants (still served as tenantA)"
else
  echo "DEBUG C response: $(cat /tmp/resC)"
  echo "DEBUG C jwt payload:"
  decode_payload "$USER1_JWT"
  fail "C expected 200 for user-1 with attempted hop, got $RES"
fi

# ----- Test D: user-2 multi membership without X-Active-Tenant -> 400
RES=$(curl -sS -o /tmp/resD -w "%{http_code}" -H "Authorization: Bearer $USER2_JWT" "$BASE_URL/api/admin/config")
if [ "$RES" = "400" ] && grep -q "Ambiguous tenant" /tmp/resD; then
  pass "D user-2 ambiguity enforced"
else
  echo "DEBUG D response: $(cat /tmp/resD)"
  echo "DEBUG D jwt payload:"
  decode_payload "$USER2_JWT"
  fail "D expected 400 ambiguous, got $RES"
fi

# ----- Test E: user-2 with X-Active-Tenant=tenantB -> 200
RES=$(curl -sS -o /tmp/resE -w "%{http_code}" -H "Authorization: Bearer $USER2_JWT" -H "X-Active-Tenant: tenantB" "$BASE_URL/api/admin/config")
if [ "$RES" = "200" ]; then
  pass "E user-2 with active tenantB succeeded"
else
  echo "DEBUG E response: $(cat /tmp/resE)"
  echo "DEBUG E jwt payload:"
  decode_payload "$USER2_JWT"
  fail "E expected 200 for user-2 with tenantB, got $RES"
fi

echo "✅ All Stage 1 tests passed."

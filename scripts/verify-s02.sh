#!/usr/bin/env bash
# verify-s02.sh — E2E verification for S02 (download flow & expiry enforcement)
# Run from the project root: bash scripts/verify-s02.sh
# Assumes the dev server is already running on port 3000.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PASS=0
FAIL=0

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); exit 1; }

echo ""
echo "==> verify-s02: Download flow & expiry enforcement"
echo "    Server: $BASE_URL"
echo ""

# ── Step 1: create test file ────────────────────────────────────────────────
echo "[ 1/7 ] Create test file"
echo "s02-verify-$(date +%s)" > /tmp/s02test.txt
pass "Test file created at /tmp/s02test.txt"

# ── Step 2: upload and capture url+token ────────────────────────────────────
echo "[ 2/7 ] Upload file → parse url and token"
UPLOAD_RESP=$(curl -sf -X POST "${BASE_URL}/api/upload" \
  -F "file=@/tmp/s02test.txt" \
  -F "expires_at=2099-01-01T00:00:00Z")
echo "    response: $UPLOAD_RESP"

URL=$(echo "$UPLOAD_RESP"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")
TOKEN=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])")
MD5=$(echo "$URL" | sed 's|^/||')

echo "    md5=$MD5"
echo "    token=${TOKEN:0:8}... (truncated)"
pass "Upload succeeded, url and token parsed"

# ── Step 3: download via ?token= query param ─────────────────────────────────
echo "[ 3/7 ] Download via ?token= query param"
HTTP_STATUS=$(curl -s -o /tmp/s02downloaded1.txt -w "%{http_code}" \
  "${BASE_URL}/api/download/${MD5}?token=${TOKEN}")
if [ "$HTTP_STATUS" != "200" ]; then
  fail "Expected 200, got $HTTP_STATUS"
fi
if ! diff -q /tmp/s02test.txt /tmp/s02downloaded1.txt > /dev/null 2>&1; then
  fail "Downloaded file content does not match original"
fi
pass "Downloaded via query param — content matches original"

# ── Step 4: download via Authorization: Bearer header ────────────────────────
echo "[ 4/7 ] Download via Authorization: Bearer header"
# Re-upload to get a fresh token (each upload issues a new token for the same MD5)
UPLOAD_RESP2=$(curl -sf -X POST "${BASE_URL}/api/upload" \
  -F "file=@/tmp/s02test.txt" \
  -F "expires_at=2099-01-01T00:00:00Z")
TOKEN2=$(echo "$UPLOAD_RESP2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])")

HTTP_STATUS2=$(curl -s -o /tmp/s02downloaded2.txt -w "%{http_code}" \
  -H "Authorization: Bearer ${TOKEN2}" \
  "${BASE_URL}/api/download/${MD5}")
if [ "$HTTP_STATUS2" != "200" ]; then
  fail "Expected 200 with Bearer header, got $HTTP_STATUS2"
fi
if ! diff -q /tmp/s02test.txt /tmp/s02downloaded2.txt > /dev/null 2>&1; then
  fail "Downloaded file (Bearer) content does not match original"
fi
pass "Downloaded via Authorization: Bearer header — content matches original"

# ── Step 5: wrong token → expect 401 ────────────────────────────────────────
echo "[ 5/7 ] Wrong token → expect HTTP 401"
HTTP_WRONG=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BASE_URL}/api/download/${MD5}?token=wrong-token-value")
if [ "$HTTP_WRONG" != "401" ]; then
  fail "Expected 401 for wrong token, got $HTTP_WRONG"
fi
pass "Wrong token returned 401"

# ── Step 6: expired file → expect 410 ───────────────────────────────────────
echo "[ 6/7 ] Expired file → expect HTTP 410"
echo "s02-expire-test-$(date +%s)" > /tmp/s02expire.txt
EXPIRE_RESP=$(curl -sf -X POST "${BASE_URL}/api/upload" \
  -F "file=@/tmp/s02expire.txt" \
  -F "expires_at=2020-01-01T00:00:00Z")
EXPIRE_TOKEN=$(echo "$EXPIRE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])")
EXPIRE_URL=$(echo "$EXPIRE_RESP"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")
EXPIRE_MD5=$(echo "$EXPIRE_URL" | sed 's|^/||')

HTTP_EXPIRED=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BASE_URL}/api/download/${EXPIRE_MD5}?token=${EXPIRE_TOKEN}")
if [ "$HTTP_EXPIRED" != "410" ]; then
  fail "Expected 410 for expired file, got $HTTP_EXPIRED"
fi
pass "Expired file returned 410"

# ── Step 7: download_logs has at least 1 row ─────────────────────────────────
echo "[ 7/7 ] Check download_logs has >= 1 row"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${SCRIPT_DIR}/../data/fileshare.db"
LOG_COUNT=$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM download_logs;')
if [ "$LOG_COUNT" -lt 1 ]; then
  fail "download_logs has $LOG_COUNT rows, expected >= 1"
fi
pass "download_logs has $LOG_COUNT row(s)"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "✅ verify-s02 passed ($PASS/7 checks)"

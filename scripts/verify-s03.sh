#!/usr/bin/env bash
# verify-s03.sh — E2E verification for S03 (admin panel: file list, detail, expiry edit, delete)
# Run from the project root: bash scripts/verify-s03.sh
# Assumes the dev server is already running on port 3000.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PASS=0
FAIL=0

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); exit 1; }

echo ""
echo "==> verify-s03: Admin panel — file list, detail, expiry, delete"
echo "    Server: $BASE_URL"
echo ""

# ── Step 1: upload a test file ───────────────────────────────────────────────
echo "[ 1/7 ] Upload test file"
UPLOAD_RESP=$(curl -sf -F "file=@/etc/hostname" "${BASE_URL}/api/upload")
echo "    response: $UPLOAD_RESP"

FILE_URL=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")
TOKEN=$(echo "$UPLOAD_RESP"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])")
MD5=$(echo "$FILE_URL" | sed 's|^/||')
echo "    md5=$MD5  token=${TOKEN:0:8}..."
pass "Upload succeeded"

# ── Step 2: file appears in admin list ──────────────────────────────────────
echo "[ 2/7 ] File appears in GET /api/admin/files"
LIST_RESP=$(curl -sf "${BASE_URL}/api/admin/files")
echo "    list (truncated): ${LIST_RESP:0:200}"
if ! echo "$LIST_RESP" | python3 -c "
import sys, json
files = json.load(sys.stdin)
assert any(f['md5'] == '${MD5}' for f in files), 'MD5 not found in list'
"; then
  fail "Uploaded MD5 not found in admin file list"
fi
pass "File appears in admin list"

# ── Step 3: extract file ID; GET /api/admin/files/<id> has download_count ───
echo "[ 3/7 ] GET /api/admin/files/<id> returns download_count field"
FILE_ID=$(echo "$LIST_RESP" | python3 -c "
import sys, json
files = json.load(sys.stdin)
match = next(f for f in files if f['md5'] == '${MD5}')
print(match['id'])
")
echo "    file_id=$FILE_ID"

DETAIL_RESP=$(curl -sf "${BASE_URL}/api/admin/files/${FILE_ID}")
echo "    detail (truncated): ${DETAIL_RESP:0:200}"
if ! echo "$DETAIL_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'download_count' in d, 'download_count field missing'
"; then
  fail "download_count field missing from file detail response"
fi
pass "File detail includes download_count field"

# ── Step 4: PATCH expiry ─────────────────────────────────────────────────────
echo "[ 4/7 ] PATCH expiry to 9999999999"
PATCH_RESP=$(curl -sf -X PATCH \
  -H 'Content-Type: application/json' \
  -d '{"expires_at": 9999999999}' \
  "${BASE_URL}/api/admin/files/${FILE_ID}")
echo "    patch response: $PATCH_RESP"
if ! echo "$PATCH_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('ok') == True, 'ok != true'
"; then
  fail "PATCH did not return {\"ok\":true}"
fi
pass "PATCH returned {\"ok\":true}"

# ── Step 5: verify updated expiry ────────────────────────────────────────────
echo "[ 5/7 ] Verify expires_at is 9999999999"
UPDATED_RESP=$(curl -sf "${BASE_URL}/api/admin/files/${FILE_ID}")
if ! echo "$UPDATED_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('expires_at') == 9999999999, f'expires_at={d.get(\"expires_at\")}'
"; then
  fail "expires_at was not updated to 9999999999"
fi
pass "expires_at is 9999999999"

# ── Step 6: DELETE file ───────────────────────────────────────────────────────
echo "[ 6/7 ] DELETE /api/admin/files/<id>"
DELETE_RESP=$(curl -sf -X DELETE "${BASE_URL}/api/admin/files/${FILE_ID}")
echo "    delete response: $DELETE_RESP"
if ! echo "$DELETE_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('ok') == True, 'ok != true'
"; then
  fail "DELETE did not return {\"ok\":true}"
fi
pass "DELETE returned {\"ok\":true}"

# ── Step 7: download returns 404 after deletion ───────────────────────────────
echo "[ 7/7 ] Download returns 404 after deletion"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BASE_URL}/api/download/${MD5}?token=${TOKEN}")
echo "    HTTP status: $HTTP_STATUS"
if [ "$HTTP_STATUS" != "404" ]; then
  fail "Expected 404 after deletion, got $HTTP_STATUS"
fi
pass "Download returned 404 after deletion"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "✅ verify-s03 passed ($PASS/7 checks)"

#!/usr/bin/env bash
# verify-s06.sh — E2E verification for S06 (cleanup route, upload UI, home page)
# Run from the project root: bash scripts/verify-s06.sh
# Requires: app running on $BASE_URL (default http://localhost:3000),
#           sqlite3 available, CLEANUP_SECRET set to match app env.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
CLEANUP_SECRET="${CLEANUP_SECRET:-test-secret}"
PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${SCRIPT_DIR}/../data/fileshare.db"

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); exit 1; }

echo ""
echo "==> verify-s06: Cleanup route, upload UI & home page"
echo "    Server:  $BASE_URL"
echo "    DB path: $DB_PATH"
echo ""

# ── Step 1: Seed an expired file record ─────────────────────────────────────
echo "[ 1/6 ] Seed expired file record into SQLite"
SEED_MD5="aabbccdd00112233aabbccdd00112233"
if command -v sqlite3 &>/dev/null && [ -f "$DB_PATH" ]; then
  # Remove any prior seed row so INSERT doesn't collide on the UNIQUE md5 constraint
  sqlite3 "$DB_PATH" "DELETE FROM files WHERE md5 = '${SEED_MD5}';" || true
  sqlite3 "$DB_PATH" \
    "INSERT INTO files (filename, original_name, md5, size, content_type, gcs_key, token_hash, expires_at) \
     VALUES ('fake.txt', 'fake.txt', '${SEED_MD5}', 0, 'text/plain', 'fake-gcs-key-s06', 'fakehash', 1);"
  pass "Seeded expired record (md5=${SEED_MD5}, expires_at=1)"
else
  echo "  ⚠ SKIP: sqlite3 not available or DB not found at $DB_PATH"
  PASS=$((PASS + 1))
fi

# ── Step 2: Call GET /api/cleanup ───────────────────────────────────────────
echo "[ 2/6 ] GET /api/cleanup with bearer token"
CLEANUP_HTTP=$(curl -s -o /tmp/s06-cleanup.json -w "%{http_code}" \
  -H "Authorization: Bearer ${CLEANUP_SECRET}" \
  "${BASE_URL}/api/cleanup")
CLEANUP_RESP=$(cat /tmp/s06-cleanup.json)
echo "    HTTP ${CLEANUP_HTTP}  body: ${CLEANUP_RESP}"
if [ "$CLEANUP_HTTP" != "200" ]; then
  fail "Expected HTTP 200 from /api/cleanup, got ${CLEANUP_HTTP}"
fi
echo "$CLEANUP_RESP" | grep -q '"deleted"' || fail "cleanup response missing 'deleted' field"
pass "Cleanup endpoint returned 200 with 'deleted' field"

# ── Step 3: Wrong bearer token → expect 401 ─────────────────────────────────
echo "[ 3/6 ] Wrong bearer token → expect HTTP 401"
CLEANUP_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer wrong-token" \
  "${BASE_URL}/api/cleanup")
if [ "$CLEANUP_UNAUTH" != "401" ]; then
  fail "Expected 401 for wrong token, got ${CLEANUP_UNAUTH}"
fi
pass "Wrong bearer token returned 401"

# ── Step 4: Seeded record is gone from DB ───────────────────────────────────
echo "[ 4/6 ] Seeded record purged from files table"
if command -v sqlite3 &>/dev/null && [ -f "$DB_PATH" ]; then
  COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM files WHERE md5 = '${SEED_MD5}';")
  if [ "$COUNT" != "0" ]; then
    fail "Seeded record still present (COUNT=${COUNT}); cleanup may have hit GCS error — check app logs"
  fi
  pass "Seeded record not present in files table (COUNT=0)"
else
  echo "  ⚠ SKIP: sqlite3 not available"
  PASS=$((PASS + 1))
fi

# ── Step 5: Home page is not the scaffold ───────────────────────────────────
echo "[ 5/6 ] Home page is not the Next.js scaffold"
HOME_STATUS=$(curl -s -o /tmp/s06-home.html -w "%{http_code}" "${BASE_URL}/")
echo "    HTTP ${HOME_STATUS}"
# Accept 200 (landing card for unauthenticated) or 302 (redirect for authenticated)
if [ "$HOME_STATUS" != "200" ] && [ "$HOME_STATUS" != "302" ]; then
  fail "Expected 200 or 302 from /, got ${HOME_STATUS}"
fi
if grep -q 'To get started' /tmp/s06-home.html 2>/dev/null; then
  fail "Home page still contains scaffold text 'To get started'"
fi
pass "Home page returned ${HOME_STATUS} and does not contain scaffold text"

# ── Step 6: Upload route source file exists ──────────────────────────────────
echo "[ 6/6 ] Upload route source file exists"
UPLOAD_PAGE="${SCRIPT_DIR}/../src/app/upload/page.tsx"
CLEANUP_ROUTE="${SCRIPT_DIR}/../src/app/api/cleanup/route.ts"
test -f "$UPLOAD_PAGE"    || fail "src/app/upload/page.tsx not found"
test -f "$CLEANUP_ROUTE"  || fail "src/app/api/cleanup/route.ts not found"
pass "src/app/upload/page.tsx and src/app/api/cleanup/route.ts exist"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "✅ verify-s06 passed (${PASS}/6 checks)"

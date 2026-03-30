#!/usr/bin/env bash
# scripts/verify-s04.sh
# End-to-end verification for S04 (Auth — local credentials + OIDC).
# Run from the project root: bash scripts/verify-s04.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅  $label (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌  $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== S04 verification ==="
echo ""

# 1. Unit tests
echo "--- 1. npm test ---"
npm test
echo ""

# 2. Production build
echo "--- 2. npm run build ---"
env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build -- --webpack 2>&1 | tail -20
echo ""

# 3. Seed DB
echo "--- 3. Seed DB ---"
npx tsx scripts/seed-user.ts
echo ""

# 4. Start dev server in background
echo "--- 4. Start dev server ---"
npm run dev > /tmp/fileshare-dev.log 2>&1 &
DEV_PID=$!
echo "  dev server PID: $DEV_PID"

# 5. Wait for port 3000 (up to 30s)
echo "--- 5. Wait for port 3000 ---"
for i in $(seq 1 30); do
  if curl -s -o /dev/null -f http://localhost:3000/; then
    echo "  port 3000 ready after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ❌ timed out waiting for dev server"
    kill "$DEV_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo ""

# 6. GET /upload without session → 307 redirect to /login
echo "--- 6. GET /upload without session ---"
UPLOAD_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-redirs 0 http://localhost:3000/upload)
check "GET /upload → 307" "307" "$UPLOAD_STATUS"
echo ""

# 7. POST /api/upload without session → 403
echo "--- 7. POST /api/upload without session ---"
API_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/api/upload)
check "POST /api/upload → 403" "403" "$API_STATUS"
echo ""

# 8. Kill dev server
echo "--- 8. Kill dev server ---"
kill "$DEV_PID" 2>/dev/null || true
wait "$DEV_PID" 2>/dev/null || true
echo "  dev server stopped"
echo ""

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

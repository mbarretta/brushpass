#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

# Create a test file with unique content so re-runs don't always hit the collision path
echo "S01 verification test file $(date)" > /tmp/s01-test.txt

echo "==> Uploading test file..."
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/upload" \
  -F "file=@/tmp/s01-test.txt" \
  -F "expires_at=2099-01-01T00:00:00Z")

echo "Response: $RESPONSE"

# Validate response has required fields
URL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")
TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])")
EXPIRES=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['expires_at'])")

echo "==> url: $URL"
echo "==> token: ${TOKEN:0:8}... (truncated for security)"
echo "==> expires_at: $EXPIRES"

# Verify DB record
MD5=$(echo "$URL" | sed 's|/||')
echo "==> Checking SQLite record for md5=$MD5..."
sqlite3 data/fileshare.db "SELECT id, md5, original_name, size FROM files WHERE md5='$MD5';"

echo ""
echo "==> Testing MD5 collision idempotency (upload same file again)..."
RESPONSE2=$(curl -s -X POST "${BASE_URL}/api/upload" \
  -F "file=@/tmp/s01-test.txt" \
  -F "expires_at=2099-01-01T00:00:00Z")

URL2=$(echo "$RESPONSE2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")
if [ "$URL" = "$URL2" ]; then
  echo "==> ✅ Collision idempotency: same URL returned for duplicate file"
else
  echo "==> ❌ Collision idempotency FAILED: got $URL2, expected $URL"
  exit 1
fi

echo ""
echo "✅ S01 verification passed"

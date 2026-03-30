#!/usr/bin/env bash
# verify-s01-m002.sh
# Integration smoke-test for M002/S01: Content-Disposition header with spaces.
#
# Requires a running app at http://localhost:3000.
# Exits 0 on success, 1 on failure.

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
TMPFILE="$(mktemp /tmp/my_report_2026_XXXXXX.pdf)"
echo "Fileshare integration test content" > "$TMPFILE"

echo "[verify-s01-m002] Uploading file with spaces in name..."
UPLOAD_RESP=$(curl -s -X POST "${BASE_URL}/api/upload" \
  -F "file=@${TMPFILE};filename=my report 2026.pdf")

MD5=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['md5'])" 2>/dev/null || true)
TOKEN=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token'])" 2>/dev/null || true)

if [[ -z "$MD5" || -z "$TOKEN" ]]; then
  echo "[verify-s01-m002] FAIL: Upload did not return md5/token. Response:"
  echo "$UPLOAD_RESP"
  rm -f "$TMPFILE"
  exit 1
fi

echo "[verify-s01-m002] Uploaded. md5=${MD5}"
echo "[verify-s01-m002] Downloading and checking Content-Disposition header..."

HEADERS=$(curl -s -D - -o /dev/null "${BASE_URL}/api/download/${MD5}?token=${TOKEN}")
CD_HEADER=$(echo "$HEADERS" | grep -i "^content-disposition:" | tr -d '\r\n')

echo "[verify-s01-m002] Content-Disposition: ${CD_HEADER}"

# Assert both filename= and filename*= parameters are present with percent-encoded spaces
if echo "$CD_HEADER" | grep -q 'filename="my%20report%202026.pdf"' && \
   echo "$CD_HEADER" | grep -q "filename\*=UTF-8''my%20report%202026.pdf"; then
  echo "[verify-s01-m002] PASS: Content-Disposition header is RFC 6266 compliant."
  rm -f "$TMPFILE"
  exit 0
else
  echo "[verify-s01-m002] FAIL: Content-Disposition header does not match expected RFC 6266 form."
  echo "  Expected to find: filename=\"my%20report%202026.pdf\"; filename*=UTF-8''my%20report%202026.pdf"
  echo "  Got: ${CD_HEADER}"
  rm -f "$TMPFILE"
  exit 1
fi

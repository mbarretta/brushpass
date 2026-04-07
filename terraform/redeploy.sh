#!/usr/bin/env bash
# Rebuilds and pushes the Docker image, then updates the Cloud Run service.
# Use this for code-only changes — no Terraform apply, no bootstrap job.
#
# Usage:
#   ./redeploy.sh

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=common.sh
source ./common.sh

load_config

echo "==> Project : $PROJECT_ID"
echo "==> Region  : $REGION"
echo "==> Image   : $IMAGE"
echo ""

COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
echo "==> Commit    : $COMMIT_SHA"
echo "==> Building and pushing image (linux/amd64)..."
cd ..
docker buildx build --platform linux/amd64 -t "$IMAGE" --build-arg COMMIT_SHA="$COMMIT_SHA" --push .
cd terraform

echo "==> Updating Cloud Run service..."
gcloud run services update "$CR_SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --quiet

echo ""
echo "==> Done. $(gcloud run services describe "$CR_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"

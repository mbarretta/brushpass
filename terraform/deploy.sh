#!/usr/bin/env bash
# Builds the Docker image, pushes to Artifact Registry, and deploys the full
# Fileshare GCP environment via Terraform.
#
# Auth_URL and the bootstrap admin job are handled automatically by Terraform
# post-apply. Bootstrap secret cleanup must be done manually after verifying
# that admin login works — instructions are printed at the end.
#
# Usage:
#   ./deploy.sh           # full deploy
#   ./deploy.sh --plan    # plan only, no apply

set -euo pipefail

cd "$(dirname "$0")"

PLAN_ONLY=false
for arg in "$@"; do
  [[ "$arg" == "--plan" ]] && PLAN_ONLY=true
done

# ── Read config from tfvars ────────────────────────────────────────────────────

tfvar() {
  awk -F'"' "/^${1}[[:space:]]*=/{print \$2; exit}" terraform.tfvars
}

PROJECT_ID=$(tfvar project_id)
REGION=$(tfvar region)
AR_REPO=$(tfvar artifact_registry_repo)
AR_REPO=${AR_REPO:-cloud-run-source-deploy}
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/fileshare:latest"

echo "==> Project : $PROJECT_ID"
echo "==> Region  : $REGION"
echo "==> Image   : $IMAGE"
echo ""

# ── Configure Docker for Artifact Registry ────────────────────────────────────

echo "==> Configuring Docker auth for Artifact Registry..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── Terraform init ────────────────────────────────────────────────────────────

echo "==> Initializing Terraform..."
terraform init -upgrade

# ── Import Artifact Registry repo if it already exists ────────────────────────
# gcloud run deploy --source creates this repo automatically on a first deploy;
# without importing it, Terraform would try (and fail) to create a duplicate.

AR_RESOURCE="google_artifact_registry_repository.cloud_run_source_deploy"
if ! terraform state show "$AR_RESOURCE" &>/dev/null; then
  if gcloud artifacts repositories describe "$AR_REPO" \
       --location="$REGION" --project="$PROJECT_ID" &>/dev/null 2>&1; then
    echo "==> Artifact Registry repo already exists — importing into state..."
    terraform import "$AR_RESOURCE" \
      "projects/${PROJECT_ID}/locations/${REGION}/repositories/${AR_REPO}"
  fi
fi

# ── Build and push image ──────────────────────────────────────────────────────

echo "==> Building and pushing image (linux/amd64)..."
cd ..
docker buildx build --platform linux/amd64 -t "$IMAGE" --push .
cd terraform

# ── Plan / Apply ──────────────────────────────────────────────────────────────

if "$PLAN_ONLY"; then
  echo "==> Running terraform plan..."
  terraform plan
  exit 0
fi

echo "==> Applying Terraform..."
terraform apply -auto-approve

# ── Set AUTH_URL ──────────────────────────────────────────────────────────────
# AUTH_URL can't be set inside the Terraform service resource (circular self-
# reference), so we patch it here after every apply. This is idempotent.

SERVICE_URL=$(terraform output -raw service_url)
CR_SERVICE=$(tfvar cloud_run_service_name)
CR_SERVICE=${CR_SERVICE:-fileshare}

echo "==> Setting AUTH_URL on Cloud Run service..."
gcloud run services update "$CR_SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --update-env-vars="AUTH_URL=${SERVICE_URL}" \
  --quiet

# ── Post-deploy summary ───────────────────────────────────────────────────────

echo ""
echo "==> Deploy complete."
echo "    Service URL: $SERVICE_URL"
echo ""
echo "==> Bootstrap secrets cleanup (run after verifying admin login works):"
echo "    gcloud secrets delete fileshare-admin-user --project=${PROJECT_ID} --quiet"
echo "    gcloud secrets delete fileshare-admin-pass --project=${PROJECT_ID} --quiet"
echo "    terraform state rm google_secret_manager_secret.admin_user"
echo "    terraform state rm google_secret_manager_secret_version.admin_user"
echo "    terraform state rm google_secret_manager_secret.admin_pass"
echo "    terraform state rm google_secret_manager_secret_version.admin_pass"
echo "    Then remove the admin_user/admin_pass blocks from secrets.tf and cloudrun.tf."

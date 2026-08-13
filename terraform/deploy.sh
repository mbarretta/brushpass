#!/usr/bin/env bash
# Builds the Docker image, pushes to Artifact Registry, and deploys the full
# Fileshare GCP environment via Terraform.
#
# AUTH_URL is a Terraform-managed variable (see variables.tf) — this script no
# longer patches it on with a separate `gcloud run services update` call after
# apply. On a brand-new service, leave auth_url unset for the first apply, then
# follow the bootstrap sequence documented on var.auth_url in variables.tf.
#
# The Terraform plan is written to a file in a fresh mktemp directory, never
# into the repo: a saved plan contains the same plaintext secret values that
# terraform.tfstate does, and the repo is not an acceptable place for that.
# The plan is shown for review and requires confirmation before it is applied.
#
# Usage:
#   ./deploy.sh                # full deploy: build+push image, plan, confirm, apply
#   ./deploy.sh --plan         # plan only, no build/push, no apply
#   ./deploy.sh --yes          # skip the interactive confirmation (CI / non-interactive use)

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=common.sh
source ./common.sh

PLAN_ONLY=false
AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    --plan) PLAN_ONLY=true ;;
    --yes | -y | --auto-approve) AUTO_YES=true ;;
  esac
done

load_config
check_gcloud_auth
load_env_tfvars

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

# ── Plan (written to a mktemp directory — never the repo) ────────────────────

PLAN_DIR=$(mktemp -d)
PLAN_FILE="${PLAN_DIR}/deploy.tfplan"
trap 'rm -rf "$PLAN_DIR"' EXIT

echo "==> Running terraform plan..."
terraform plan -out="$PLAN_FILE"

if "$PLAN_ONLY"; then
  exit 0
fi

echo ""
echo "==> Reviewing plan:"
terraform show "$PLAN_FILE"

if ! "$AUTO_YES"; then
  echo ""
  read -r -p "==> Apply this plan? Type 'yes' to continue: " confirm
  [[ "$confirm" != "yes" ]] && { echo "Aborted — no changes applied."; exit 1; }
fi

echo "==> Applying Terraform..."
terraform apply "$PLAN_FILE"

# ── Post-deploy summary ───────────────────────────────────────────────────────

SERVICE_URL=$(terraform output -raw service_url)

echo ""
echo "==> Deploy complete."
echo "    Service URL: $SERVICE_URL"
echo ""
if [[ -z "$(tfvar auth_url 2>/dev/null || true)" ]]; then
  echo "==> auth_url is not set in terraform.tfvars yet. If this was the FIRST apply"
  echo "    for this service, set auth_url=\"$SERVICE_URL\" in terraform.tfvars and"
  echo "    re-run ./deploy.sh (or ./apply.sh) to wire up AUTH_URL. See the bootstrap"
  echo "    sequence documented on var.auth_url in variables.tf."
  echo ""
fi
echo "==> Bootstrap secrets cleanup (run after verifying admin login works):"
echo "    gcloud secrets delete fileshare-admin-user --project=${PROJECT_ID} --quiet"
echo "    gcloud secrets delete fileshare-admin-pass --project=${PROJECT_ID} --quiet"
echo "    terraform state rm google_secret_manager_secret.admin_user"
echo "    terraform state rm google_secret_manager_secret_version.admin_user"
echo "    terraform state rm google_secret_manager_secret.admin_pass"
echo "    terraform state rm google_secret_manager_secret_version.admin_pass"
echo "    Then remove the admin_user/admin_pass blocks from secrets.tf and cloudrun.tf."

#!/usr/bin/env bash
# Destroys the Fileshare GCP environment.
#
# Default: destroys all resources EXCEPT storage buckets.
#          The buckets and their contents are preserved.
#
# --include-buckets: full teardown including GCS bucket deletion.
#
# Usage:
#   ./destroy.sh                   # tear down env, keep buckets
#   ./destroy.sh --include-buckets # tear down everything

set -euo pipefail

cd "$(dirname "$0")"

INCLUDE_BUCKETS=false
for arg in "$@"; do
  [[ "$arg" == "--include-buckets" ]] && INCLUDE_BUCKETS=true
done

if "$INCLUDE_BUCKETS"; then
  echo "==> Full teardown including storage buckets"
  echo "    WARNING: This permanently deletes all bucket contents."
  echo ""
  read -r -p "    Type 'yes' to confirm: " confirm
  [[ "$confirm" != "yes" ]] && { echo "Aborted."; exit 1; }

  # Capture bucket names before untracking them
  FILE_BUCKET=$(terraform output -raw file_bucket_name 2>/dev/null || true)
  DB_BUCKET=$(terraform output -raw db_bucket_name 2>/dev/null || true)

  # Remove bucket resources from Terraform state so prevent_destroy doesn't
  # block the plan. This does NOT delete the actual GCS buckets.
  terraform state list 2>/dev/null \
    | grep '^google_storage_bucket\.' \
    | while read -r res; do
        echo "  Untracking $res from state..."
        terraform state rm "$res"
      done

  # Destroy all remaining tracked resources
  terraform destroy

  # Now physically delete the GCS buckets (state rm only removes tracking)
  for bucket in "$FILE_BUCKET" "$DB_BUCKET"; do
    if [[ -n "$bucket" ]]; then
      echo "  Deleting gs://$bucket ..."
      gcloud storage rm -r "gs://$bucket" --quiet \
        || echo "  Warning: could not delete gs://$bucket (may already be gone)"
    fi
  done

else
  echo "==> Destroying Fileshare environment (storage buckets preserved)"

  # Build -target flags for all managed resources except storage buckets.
  # Excludes data sources (read-only, nothing to destroy).
  TARGETS=$(terraform state list 2>/dev/null \
    | grep -v '^google_storage_bucket\.' \
    | grep -v '^data\.' \
    | sed 's/^/-target=/' \
    | paste -sd ' ' -)

  if [[ -z "${TARGETS// /}" ]]; then
    echo "  Nothing to destroy (no non-bucket resources in state)."
    exit 0
  fi

  # shellcheck disable=SC2086
  terraform destroy $TARGETS
fi

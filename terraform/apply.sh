#!/usr/bin/env bash
#
# apply.sh — run Terraform with the agent device-grant secrets sourced from the
# repo-root .env (via common.sh's load_env_tfvars), without rebuilding/pushing
# the image. Use this for infra-only changes (env vars, secrets, IAM, DNS);
# use ./deploy.sh when application code changed and the image must be rebuilt.
#
# Secrets (agent_oidc_client_id/secret, agent_key_secret) come from .env and are
# kept OUT of terraform.tfvars. The non-secret oidc_issuer / oidc_admin_domain
# belong in terraform.tfvars (it takes precedence); .env is a fallback. See the
# precedence note in common.sh -> load_env_tfvars.
#
# Usage:
#   ./apply.sh              # -> terraform apply
#   ./apply.sh plan         # -> terraform plan
#   ./apply.sh plan -out=p  # -> terraform plan -out=p (any args pass through)
#
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=common.sh
source ./common.sh

load_env_tfvars

if [[ $# -eq 0 ]]; then
  terraform apply
else
  terraform "$@"
fi

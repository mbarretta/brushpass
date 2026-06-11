#!/usr/bin/env bash
#
# apply.sh — run Terraform with the agent OAuth credentials sourced from the
# repo-root .env, so the secrets live in exactly one place (.env) instead of
# being duplicated into terraform.tfvars.
#
# Terraform automatically reads any variable named TF_VAR_<varname>, so this
# wrapper loads .env and maps the app's env-var names onto the Terraform
# variable names declared in variables.tf. TF_VAR_* is the lowest-precedence
# variable source, so do NOT also set these in terraform.tfvars (a tfvars value
# would override what we export here).
#
# Usage:
#   ./apply.sh              # -> terraform apply
#   ./apply.sh plan         # -> terraform plan
#   ./apply.sh plan -out=p  # -> terraform plan -out=p (any args pass through)
#
set -euo pipefail

# Resolve paths relative to this script so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — create it from .env.example first" >&2
  exit 1
fi

# Load .env into the environment (export everything it defines).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Required: fail fast with a clear message if the agent creds are absent.
: "${AGENT_OIDC_CLIENT_ID:?AGENT_OIDC_CLIENT_ID missing in .env}"
: "${AGENT_OIDC_CLIENT_SECRET:?AGENT_OIDC_CLIENT_SECRET missing in .env}"

# Map app env-var names -> Terraform variable names (TF_VAR_<name>).
export TF_VAR_agent_oidc_client_id="$AGENT_OIDC_CLIENT_ID"
export TF_VAR_agent_oidc_client_secret="$AGENT_OIDC_CLIENT_SECRET"
export TF_VAR_agent_key_ttl_seconds="${AGENT_KEY_TTL_SECONDS:-900}"

# Optional dedicated signing secret; only export when set, otherwise the app
# (and Terraform's optional variable) falls back to AUTH_SECRET.
if [[ -n "${AGENT_KEY_SECRET:-}" ]]; then
  export TF_VAR_agent_key_secret="$AGENT_KEY_SECRET"
fi

# OIDC issuer + admin domain (non-secret). The agent device-grant flow needs
# AUTH_OIDC_ISSUER for endpoint discovery and AUTH_OIDC_ADMIN_DOMAIN for
# permission resolution; map them through so a deploy from .env is reproducible.
# Only exported when set, so they don't clobber an existing tfvars value.
if [[ -n "${AUTH_OIDC_ISSUER:-}" ]]; then
  export TF_VAR_oidc_issuer="$AUTH_OIDC_ISSUER"
fi
if [[ -n "${AUTH_OIDC_ADMIN_DOMAIN:-}" ]]; then
  export TF_VAR_oidc_admin_domain="$AUTH_OIDC_ADMIN_DOMAIN"
fi

cd "$SCRIPT_DIR"
if [[ $# -eq 0 ]]; then
  terraform apply
else
  terraform "$@"
fi

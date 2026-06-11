#!/usr/bin/env bash
# Shared config helpers for deploy.sh and redeploy.sh.
# Source this file after cd-ing to the terraform directory.

tfvar() {
  awk -F'"' "/^${1}[[:space:]]*=/{print \$2; exit}" terraform.tfvars
}

load_config() {
  PROJECT_ID=$(tfvar project_id)
  REGION=$(tfvar region)
  AR_REPO=$(tfvar artifact_registry_repo)
  AR_REPO=${AR_REPO:-cloud-run-source-deploy}
  CR_SERVICE=$(tfvar cloud_run_service_name)
  CR_SERVICE=${CR_SERVICE:-fileshare}
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/fileshare:latest"
}

# Source the repo-root .env (if present) and map app env-var names onto the
# Terraform variable names (TF_VAR_<name>) the deploy needs. This lets a deploy
# read the agent device-grant secrets from .env instead of terraform.tfvars, so
# the client secret lives in exactly one (git-ignored) place.
#
# Precedence note: TF_VAR_* is Terraform's LOWEST-priority variable source, so
# any value also present in terraform.tfvars wins over what we export here.
#   - Agent secrets (agent_oidc_client_id/secret, agent_key_secret): keep these
#     OUT of terraform.tfvars so the .env values below take effect.
#   - Non-secret oidc_issuer / oidc_admin_domain: may live in .env (exported
#     below) OR in terraform.tfvars. Do not put them in terraform.tfvars as
#     empty strings — "" is a real value that overrides these exports; omit the
#     keys there if you want .env to supply them.
#
# Called by deploy.sh and apply.sh. Safe to call when .env is missing or when
# the agent feature is intentionally disabled (no agent creds) — it just exports
# whatever it finds and prints whether the agent feature will be enabled.
load_env_tfvars() {
  local env_file
  env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"

  if [[ ! -f "$env_file" ]]; then
    echo "==> No .env found at $env_file — skipping .env -> TF_VAR mapping."
    echo "    (Agent device-grant feature stays disabled unless agent_oidc_* is set in terraform.tfvars.)"
    return 0
  fi

  echo "==> Loading deploy vars from $env_file"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  # Agent device-grant secrets — sourced from .env, never from terraform.tfvars.
  [[ -n "${AGENT_OIDC_CLIENT_ID:-}" ]]     && export TF_VAR_agent_oidc_client_id="$AGENT_OIDC_CLIENT_ID"
  [[ -n "${AGENT_OIDC_CLIENT_SECRET:-}" ]] && export TF_VAR_agent_oidc_client_secret="$AGENT_OIDC_CLIENT_SECRET"
  [[ -n "${AGENT_KEY_TTL_SECONDS:-}" ]]    && export TF_VAR_agent_key_ttl_seconds="$AGENT_KEY_TTL_SECONDS"
  [[ -n "${AGENT_KEY_SECRET:-}" ]]         && export TF_VAR_agent_key_secret="$AGENT_KEY_SECRET"

  # Non-secret OIDC issuer + admin domain — convenience fallback (terraform.tfvars wins).
  [[ -n "${AUTH_OIDC_ISSUER:-}" ]]         && export TF_VAR_oidc_issuer="$AUTH_OIDC_ISSUER"
  [[ -n "${AUTH_OIDC_ADMIN_DOMAIN:-}" ]]   && export TF_VAR_oidc_admin_domain="$AUTH_OIDC_ADMIN_DOMAIN"

  if [[ -n "${AGENT_OIDC_CLIENT_ID:-}" && -n "${AGENT_OIDC_CLIENT_SECRET:-}" ]]; then
    echo "    Agent device-grant: ENABLED (agent_oidc_client_id/secret sourced from .env)"
  else
    echo "    Agent device-grant: disabled (set AGENT_OIDC_CLIENT_ID + AGENT_OIDC_CLIENT_SECRET in .env to enable)"
  fi
}

# Verify gcloud credentials are present and not stale.
# If the active account is missing or its token can't be refreshed, runs
# 'gcloud auth login' so the user can reauthenticate before the script proceeds.
check_gcloud_auth() {
  local account
  account=$(gcloud auth list --filter="status=ACTIVE" --format="value(account)" 2>/dev/null | head -1)

  if [[ -z "$account" ]]; then
    echo "==> No active gcloud account found. Starting login..."
    gcloud auth login
    return
  fi

  if ! gcloud auth print-access-token --quiet >/dev/null 2>&1; then
    echo "==> gcloud credentials for $account are stale. Starting login..."
    gcloud auth login
  else
    echo "==> Auth OK ($account)"
  fi
}

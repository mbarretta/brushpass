# ── Auto-generated secrets ────────────────────────────────────────────────────
# random_password generates values that are stored as sensitive in Terraform
# state. Ensure the state backend (GCS bucket) has appropriate access controls.

resource "random_password" "auth_secret" {
  length  = 32
  special = false
}

# AUTH_SECRET

resource "google_secret_manager_secret" "auth_secret" {
  project   = var.project_id
  secret_id = "fileshare-auth-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "auth_secret" {
  secret      = google_secret_manager_secret.auth_secret.id
  secret_data = random_password.auth_secret.result
}

# CLEANUP_SECRET: removed from production 2026-08-14 (owner decision, task 4's
# proposal from the fix-security-remediation cycle). The cleanup route
# authenticates the Cloud Scheduler job via OIDC (scheduler.tf) — the static
# bearer credential on a publicly-reachable route served no remaining purpose.
# The route still honors a CLEANUP_SECRET env var when one is set (local dev /
# manual curl testing via .env); with it unset the handler is OIDC-only and
# fails closed.

# ── Bootstrap admin credentials: removed 2026-08-14 ───────────────────────────
# The one-time bootstrap flow is fully retired. The owner changed the admin
# password in-app (so the fileshare-admin-user / fileshare-admin-pass secrets
# held only the dead initial value); the apply that removed these blocks
# destroyed both secrets, their versions, and their per-secret IAM grants
# (iam.tf). The fileshare-bootstrap Cloud Run job — created outside Terraform
# by the former terraform_data.bootstrap local-exec in cloudrun.tf — was
# deleted with `gcloud run jobs delete`. The job and its trigger had to go
# with the secrets: it re-executed on every container_image change and would
# have silently RESET the admin password to the stale secret value.
# scripts/bootstrap-admin.js survives for local/first-time provisioning.

# ── OIDC secrets (conditional) ────────────────────────────────────────────────
# Created only when all three OIDC variables are non-empty. Setting any one of
# them back to "" and re-applying will destroy the secrets and remove the OIDC
# env vars from the Cloud Run service.

locals {
  oidc_enabled = (
    var.oidc_issuer != "" &&
    var.oidc_client_id != "" &&
    var.oidc_client_secret != ""
  )
  # Agent device-grant client: both id and secret must be set together.
  agent_oidc_enabled = (
    var.agent_oidc_client_id != "" &&
    var.agent_oidc_client_secret != ""
  )

  # AUTH_OIDC_ISSUER and AUTH_OIDC_ADMIN_DOMAIN are non-sensitive plain env vars
  # that BOTH the interactive OIDC login and the agent device-grant flow need
  # (the agent flow reuses the issuer for endpoint discovery and the admin
  # domain for permission resolution). They are therefore emitted whenever
  # either client is enabled — decoupled from the interactive-client secrets,
  # which stay gated on local.oidc_enabled below. Without this, enabling only
  # the agent client would leave AUTH_OIDC_ISSUER unset and the device-grant
  # endpoints would fail discovery.
  oidc_issuer_set       = (local.oidc_enabled || local.agent_oidc_enabled) && var.oidc_issuer != ""
  oidc_admin_domain_set = (local.oidc_enabled || local.agent_oidc_enabled) && var.oidc_admin_domain != ""
  # Optional dedicated agent key-signing secret; empty falls back to AUTH_SECRET.
  agent_key_secret_set = var.agent_key_secret != ""
}

resource "google_secret_manager_secret" "oidc_client_id" {
  count     = local.oidc_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "fileshare-oidc-client-id"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "oidc_client_id" {
  count       = local.oidc_enabled ? 1 : 0
  secret      = google_secret_manager_secret.oidc_client_id[0].id
  secret_data = var.oidc_client_id
}

resource "google_secret_manager_secret" "oidc_client_secret" {
  count     = local.oidc_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "fileshare-oidc-client-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "oidc_client_secret" {
  count       = local.oidc_enabled ? 1 : 0
  secret      = google_secret_manager_secret.oidc_client_secret[0].id
  secret_data = var.oidc_client_secret
}

# ── Agent device-grant OIDC secrets (conditional) ─────────────────────────────
# Created only when both agent_oidc_client_id and agent_oidc_client_secret are
# non-empty. Setting either back to "" and re-applying destroys the secrets and
# removes the agent OIDC env vars from the Cloud Run service.

resource "google_secret_manager_secret" "agent_oidc_client_id" {
  count     = local.agent_oidc_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "fileshare-agent-oidc-client-id"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "agent_oidc_client_id" {
  count       = local.agent_oidc_enabled ? 1 : 0
  secret      = google_secret_manager_secret.agent_oidc_client_id[0].id
  secret_data = var.agent_oidc_client_id
}

resource "google_secret_manager_secret" "agent_oidc_client_secret" {
  count     = local.agent_oidc_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "fileshare-agent-oidc-client-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "agent_oidc_client_secret" {
  count       = local.agent_oidc_enabled ? 1 : 0
  secret      = google_secret_manager_secret.agent_oidc_client_secret[0].id
  secret_data = var.agent_oidc_client_secret
}

# ── Agent key-signing secret (optional) ───────────────────────────────────────
# Created only when agent_key_secret is non-empty. When unset, the app signs
# agent upload keys with AUTH_SECRET, so no env var is wired below.

resource "google_secret_manager_secret" "agent_key_secret" {
  count     = local.agent_key_secret_set ? 1 : 0
  project   = var.project_id
  secret_id = "fileshare-agent-key-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "agent_key_secret" {
  count       = local.agent_key_secret_set ? 1 : 0
  secret      = google_secret_manager_secret.agent_key_secret[0].id
  secret_data = var.agent_key_secret
}

# ── Auto-generated secrets ────────────────────────────────────────────────────
# random_password generates values that are stored as sensitive in Terraform
# state. Ensure the state backend (GCS bucket) has appropriate access controls.

resource "random_password" "auth_secret" {
  length  = 32
  special = false
}

resource "random_password" "cleanup_secret" {
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

# CLEANUP_SECRET

resource "google_secret_manager_secret" "cleanup_secret" {
  project   = var.project_id
  secret_id = "fileshare-cleanup-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "cleanup_secret" {
  secret      = google_secret_manager_secret.cleanup_secret.id
  secret_data = random_password.cleanup_secret.result
}

# ── Bootstrap admin credentials (temporary) ───────────────────────────────────
# These secrets exist so the bootstrap Cloud Run Job can receive ADMIN_USER and
# ADMIN_PASS via Secret Manager without plaintext env vars.
#
# After running the bootstrap job and verifying login, delete them:
#   gcloud secrets delete fileshare-admin-user --project=PROJECT_ID --quiet
#   gcloud secrets delete fileshare-admin-pass --project=PROJECT_ID --quiet
#   terraform state rm google_secret_manager_secret.admin_user
#   terraform state rm google_secret_manager_secret_version.admin_user
#   terraform state rm google_secret_manager_secret.admin_pass
#   terraform state rm google_secret_manager_secret_version.admin_pass
# Then remove bootstrap_admin_user and bootstrap_admin_pass from terraform.tfvars.

resource "google_secret_manager_secret" "admin_user" {
  project   = var.project_id
  secret_id = "fileshare-admin-user"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "admin_user" {
  secret      = google_secret_manager_secret.admin_user.id
  secret_data = var.bootstrap_admin_user

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret" "admin_pass" {
  project   = var.project_id
  secret_id = "fileshare-admin-pass"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "admin_pass" {
  secret      = google_secret_manager_secret.admin_pass.id
  secret_data = var.bootstrap_admin_pass

  lifecycle {
    ignore_changes = [secret_data]
  }
}

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

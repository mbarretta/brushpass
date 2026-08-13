# ── Project ───────────────────────────────────────────────────────────────────

variable "project_id" {
  type        = string
  description = "GCP project ID where all resources will be deployed."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP region for Cloud Run, Artifact Registry, and Cloud Scheduler."
}

# ── CI/CD ─────────────────────────────────────────────────────────────────────

variable "github_repository" {
  type        = string
  default     = "mbarretta/brushpass"
  description = "owner/repo allowed to federate via Workload Identity and deploy."
}

# ── Image ─────────────────────────────────────────────────────────────────────

variable "container_image" {
  type        = string
  description = "Full Artifact Registry image URI including tag, e.g. us-central1-docker.pkg.dev/PROJECT/cloud-run-source-deploy/fileshare:latest. Build and push before applying."
}

# ── Buckets ───────────────────────────────────────────────────────────────────

variable "create_file_bucket" {
  type        = bool
  default     = false
  description = "Set to true to create the file-storage GCS bucket. Set to false if the bucket already exists (Terraform will read it as a data source)."
}

variable "file_bucket_name" {
  type        = string
  description = "Name of the GCS bucket used for uploaded files (e.g. pubsec-fileshare)."
}

variable "db_bucket_name" {
  type        = string
  description = "Name of the GCS bucket used for the SQLite FUSE volume (e.g. pubsec-fileshare-db). Always created by Terraform."
}

variable "allow_dev_cors_origin" {
  type        = bool
  default     = false
  description = "Set to true to add http://localhost:3000 to the production file bucket's CORS allowed origins, for testing signed-URL uploads against production GCS from a local dev server. Defaults to false — the production bucket should not permanently trust a localhost origin."
}

# ── Cloud Run ─────────────────────────────────────────────────────────────────

variable "cloud_run_service_name" {
  type        = string
  default     = "fileshare"
  description = "Name of the Cloud Run service."
}

variable "cloud_run_job_name" {
  type        = string
  default     = "fileshare-bootstrap"
  description = "Name of the Cloud Run Job used for first-time admin bootstrapping."
}

variable "cloud_run_memory" {
  type        = string
  default     = "512Mi"
  description = "Memory limit for the Cloud Run service container."
}

variable "cloud_run_cpu" {
  type        = string
  default     = "1"
  description = "CPU limit for the Cloud Run service container."
}

variable "cloud_run_max_instance_count" {
  type        = number
  default     = 1
  description = "Cloud Run max instance count. MUST stay 1: the SQLite DB lives on a GCS FUSE volume, which is not safe for concurrent multi-writer access, and the app's rate limiter keeps its counters in per-instance memory (a second instance would double every limit)."

  validation {
    condition     = var.cloud_run_max_instance_count == 1
    error_message = "cloud_run_max_instance_count must stay 1: SQLite over GCS FUSE is not multi-writer safe, and the in-memory rate limiter is per-instance — a second instance silently breaks both."
  }
}

# ── AUTH_URL (self-referential; see cloudrun.tf) ──────────────────────────────

variable "auth_url" {
  type        = string
  default     = ""
  description = <<-EOT
    The Cloud Run service's own public HTTPS URL (e.g. https://fileshare-abc123-uc.a.run.app),
    emitted as the AUTH_URL env var for NextAuth's trust-host origin and used as the
    default OIDC audience the cleanup route checks incoming scheduler tokens against
    (see CLEANUP_AUDIENCE below). Cloud Run v2 service URLs contain a hash that cannot
    be derived from any other variable, so this cannot be interpolated — it must be
    supplied here once the service exists.

    Bootstrap sequence for a brand-new service (leave this "" for the very first apply):
      1. First apply with auth_url = "" (the default). AUTH_URL/CLEANUP_AUDIENCE are not
         emitted yet; the postcondition in cloudrun.tf is skipped while auth_url is "".
      2. Run `terraform output -raw service_url` to read the real URL.
      3. Set auth_url to that exact value in terraform.tfvars.
      4. Re-apply. AUTH_URL/CLEANUP_AUDIENCE are now emitted and the postcondition
         starts enforcing that they match the service's live uri on every future apply
         — so if the service is ever recreated (new URL hash), the apply fails loudly
         instead of silently shipping a stale audience to NextAuth and the cleanup route.
  EOT
}

variable "cleanup_audience" {
  type        = string
  default     = ""
  description = "Optional independent pin for the cleanup route's OIDC audience check (CLEANUP_AUDIENCE env var), decoupled from AUTH_URL. Leave \"\" to let the app fall back to AUTH_URL (process.env.CLEANUP_AUDIENCE ?? process.env.AUTH_URL) — the default and normally sufficient once auth_url above is set correctly. Set this only if you want the cleanup audience to survive a future change to how/whether AUTH_URL itself is set, independent of the Cloud Scheduler job's own oidc_token audience in scheduler.tf (which stays pinned to the service's live uri)."
}

# ── OIDC (optional) ───────────────────────────────────────────────────────────

variable "oidc_issuer" {
  type        = string
  default     = ""
  description = "OIDC issuer URL (e.g. https://accounts.google.com). Used by both interactive OIDC login and the agent device-grant flow (for endpoint discovery), so set it whenever either the interactive OIDC client or the agent client is configured. The interactive client additionally requires oidc_client_id + oidc_client_secret; the agent flow does not."
}

variable "oidc_client_id" {
  type        = string
  default     = ""
  sensitive   = true
  description = "OIDC client ID."
}

variable "oidc_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "OIDC client secret."
}

variable "oidc_admin_domain" {
  type        = string
  default     = ""
  description = "Email domain whose users automatically receive upload+admin permissions on first OIDC sign-in (e.g. \"example.com\"). Leave empty to disable auto-promotion — all OIDC users start with no permissions."
}

# ── Agent device-grant OIDC + key minting (optional) ──────────────────────────
# A second Google OAuth client of type "TVs and Limited Input devices" drives the
# brokered Device Authorization Grant used to mint short-lived agent upload keys.
# Register it manually (see AGENTS.md) and populate the two values below. Both
# must be set together to enable the agent device-grant endpoints.

variable "agent_oidc_client_id" {
  type        = string
  default     = ""
  sensitive   = true
  description = "OAuth client ID for the agent device-grant client (\"TVs and Limited Input devices\" type). Leave empty to disable the agent device-grant endpoints. Must be set together with agent_oidc_client_secret."
}

variable "agent_oidc_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "OAuth client secret for the agent device-grant client. Must be set together with agent_oidc_client_id."
}

variable "agent_key_ttl_seconds" {
  type        = number
  default     = 900
  description = "Lifetime in seconds of a minted agent upload key (aud:\"upload\" JWT). Defaults to 900 (15 minutes); clamped to a sane maximum by the app."
}

variable "agent_key_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional dedicated signing secret for agent upload keys. Leave empty to fall back to AUTH_SECRET (the app default)."
}

# ── Secret Manager IAM migration (project-level -> per-secret) ───────────────
# See the two-apply runbook comment above google_secret_manager_secret_iam_member
# in iam.tf. Do NOT flip this to true in the same apply that first introduces the
# per-secret bindings.

variable "revoke_project_secret_accessor" {
  type        = bool
  default     = false
  description = "Set true only after (1) the per-secret secretmanager.secretAccessor bindings below have been applied, (2) a new Cloud Run revision has rolled out under them, and (3) that revision has been confirmed to start and read its secrets successfully. Flipping this on the same apply that adds the per-secret bindings removes the project-wide grant before the new bindings are proven to work — see the runbook comment in iam.tf."
}

# ── Bootstrap admin credentials ───────────────────────────────────────────────

variable "bootstrap_admin_user" {
  type        = string
  default     = "admin"
  sensitive   = true
  description = "Username for the initial admin account created by the bootstrap job."
}

variable "bootstrap_admin_pass" {
  type        = string
  sensitive   = true
  description = "Password for the initial admin account. Set before the first apply. Delete the Terraform-managed secrets after bootstrap is verified."
}

# ── Custom domain ─────────────────────────────────────────────────────────────

variable "custom_domain" {
  type        = string
  default     = ""
  description = "Custom domain hostname (e.g. fileshare.cgr-pubsec.dev). When set, added to GCS CORS allowed origins alongside the run.app URI. Set in terraform.tfvars."
}

# ── Artifact Registry ─────────────────────────────────────────────────────────

variable "artifact_registry_repo" {
  type        = string
  default     = "cloud-run-source-deploy"
  description = "Name of the Artifact Registry Docker repository."
}

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

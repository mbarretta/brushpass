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
  description = "OIDC issuer URL (e.g. https://accounts.google.com). Leave empty to disable OIDC. All three OIDC variables must be set together."
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

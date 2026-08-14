# ── Service account ───────────────────────────────────────────────────────────

resource "google_service_account" "fileshare_app" {
  project      = var.project_id
  account_id   = "fileshare-app"
  display_name = "Fileshare App"
  description  = "Service account used by the fileshare Cloud Run service and jobs."
}

# ── File-storage bucket IAM ───────────────────────────────────────────────────
# Exactly one of these two resources is created depending on create_file_bucket.
#
# objectUser (not objectAdmin): the app only ever creates/reads/deletes objects
# via the API (upload completion, download, cleanup) — it never needs to read
# or set a bucket/object IAM policy, which is the delta objectAdmin adds over
# objectUser. Signed-URL *signing* comes from the separate serviceAccountTokenCreator
# (signBlob) grant below, not from a storage role, so narrowing this does not
# affect uploads or downloads. Defense in depth only: this does NOT by itself
# contain the object-key injection bug (task 1 fixes that at the app layer) —
# an app-layer bug that lets a caller write/read an arbitrary key still works
# under objectUser, since objectUser still grants full object CRUD.
resource "google_storage_bucket_iam_member" "fileshare_app_files_created" {
  count  = var.create_file_bucket ? 1 : 0
  bucket = google_storage_bucket.fileshare_files[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.fileshare_app.email}"
}

resource "google_storage_bucket_iam_member" "fileshare_app_files_existing" {
  count  = var.create_file_bucket ? 0 : 1
  bucket = data.google_storage_bucket.fileshare_files_existing[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.fileshare_app.email}"
}

# ── SQLite volume bucket IAM ──────────────────────────────────────────────────
# Same objectAdmin -> objectUser narrowing as above: the GCS FUSE read-write
# mount only needs object CRUD (Google's own Cloud Run + GCS FUSE docs call for
# objectUser for a read-write mount), never bucket/object IAM management.

resource "google_storage_bucket_iam_member" "fileshare_app_db" {
  bucket = google_storage_bucket.fileshare_db.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.fileshare_app.email}"
}

# ── Token creator (self) — required for GCS signed URL generation ─────────────
# signBlob is needed to sign upload URLs; granted on the SA itself.

resource "google_service_account_iam_member" "fileshare_app_token_creator" {
  service_account_id = google_service_account.fileshare_app.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.fileshare_app.email}"
}

# ── Secret Manager IAM ────────────────────────────────────────────────────────
# This project is shared with other applications' secrets. A project-level
# secretmanager.secretAccessor binding gives the app SA read access to every
# secret in the project — not just its own — so access is scoped per-secret
# instead.
#
# MIGRATION RUNBOOK — this must be applied as TWO separate `terraform apply`
# runs, not one:
#
#   Apply 1 (default state, revoke_project_secret_accessor = false):
#     - Adds the google_secret_manager_secret_iam_member bindings below.
#     - Leaves the project-level google_project_iam_member binding in place, so
#       the app SA has BOTH grants simultaneously — no access is lost or
#       interrupted for the currently running revision.
#     - After applying, roll a new revision (e.g. `gcloud run services update
#       --region=$REGION $CR_SERVICE --revision-suffix=$(date +%s)` or any
#       change that forces a new revision) and confirm it starts successfully
#       and can read its secrets (check `gcloud run revisions describe` /
#       Cloud Logging for the new revision, or just hit the service and
#       confirm login/upload work). The per-secret bindings are what the new
#       revision's secret reads actually exercise.
#
#   Apply 2 (only after Apply 1's new revision is confirmed healthy):
#     - Set revoke_project_secret_accessor = true in terraform.tfvars.
#     - Re-apply. This removes the project-level binding, leaving only the
#       narrower per-secret grants.
#
# Never set revoke_project_secret_accessor = true on the SAME apply that first
# introduces the per-secret bindings — that removes the project-wide grant
# before any revision has proven the narrower bindings actually work, and a
# failure would leave the app SA unable to read its own secrets.

resource "google_project_iam_member" "fileshare_app_secret_accessor" {
  count   = var.revoke_project_secret_accessor ? 0 : 1
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.fileshare_app.email}"
}

locals {
  # Every secret the fileshare app SA needs to read, gated by the same
  # enablement locals secrets.tf uses to create the secrets in the first place.
  fileshare_app_secret_ids = concat(
    [
      google_secret_manager_secret.auth_secret.secret_id,
      google_secret_manager_secret.cleanup_secret.secret_id,
      google_secret_manager_secret.admin_user.secret_id,
      google_secret_manager_secret.admin_pass.secret_id,
    ],
    local.oidc_enabled ? [
      google_secret_manager_secret.oidc_client_id[0].secret_id,
      google_secret_manager_secret.oidc_client_secret[0].secret_id,
    ] : [],
    local.agent_oidc_enabled ? [
      google_secret_manager_secret.agent_oidc_client_id[0].secret_id,
      google_secret_manager_secret.agent_oidc_client_secret[0].secret_id,
    ] : [],
    local.agent_key_secret_set ? [
      google_secret_manager_secret.agent_key_secret[0].secret_id,
    ] : [],
  )
}

resource "google_secret_manager_secret_iam_member" "fileshare_app_secret_accessor" {
  # nonsensitive(): the list inherits sensitivity from the enablement locals'
  # conditions on sensitive vars (agent_oidc_client_secret etc.), which count
  # tolerates but for_each rejects — keys become state addresses. The values
  # themselves are secret RESOURCE NAMES (e.g. "fileshare-auth-secret"), not
  # secret material, so exposing them as for_each keys is safe by design.
  for_each  = toset(nonsensitive(local.fileshare_app_secret_ids))
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.fileshare_app.email}"
}

# ── Artifact Registry ─────────────────────────────────────────────────────────
# If this repo already exists (auto-created by a prior gcloud run deploy --source),
# import it before applying:
#   terraform import \
#     google_artifact_registry_repository.cloud_run_source_deploy \
#     "projects/PROJECT/locations/REGION/repositories/cloud-run-source-deploy"

resource "google_artifact_registry_repository" "cloud_run_source_deploy" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repo
  description   = "Docker images for Cloud Run deployments"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]

  lifecycle {
    prevent_destroy = true
  }
}

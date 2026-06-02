# ── Workload Identity Federation for GitHub Actions deploys ───────────────────
# Lets the deploy-on-push-to-main workflow authenticate to GCP with no service
# account key: it federates the GitHub Actions OIDC token and impersonates the
# github-deployer SA, scoped to this repository only.

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  description               = "WIF pool for GitHub Actions deploys"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    # Combined repo@ref so the IAM binding can pin both at once.
    "attribute.repo_ref" = "assertion.repository + \"@\" + assertion.ref"
  }

  # Only main-branch tokens from this repository may federate through this provider.
  attribute_condition = "assertion.repository == \"${var.github_repository}\" && assertion.ref == \"refs/heads/main\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ── Deployer service account ──────────────────────────────────────────────────

resource "google_service_account" "github_deployer" {
  project      = var.project_id
  account_id   = "github-deployer"
  display_name = "GitHub Actions Deployer"
  description  = "Assumed via WIF by the deploy workflow to build/push images and deploy Cloud Run."
}

# Allow only this repo's main branch to impersonate the deployer SA via the
# WIF pool. Binding on the combined repo_ref attribute (not just repository)
# ensures PR/feature-branch workflows cannot assume the deploy identity.
resource "google_service_account_iam_member" "github_deployer_wif" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repo_ref/${var.github_repository}@refs/heads/main"
}

# ── Deployer permissions (least privilege) ────────────────────────────────────

# Push images to the Artifact Registry repo.
resource "google_artifact_registry_repository_iam_member" "github_deployer_ar_writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.cloud_run_source_deploy.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Deploy new revisions of the fileshare service (scoped to the service, not project-wide).
resource "google_cloud_run_v2_service_iam_member" "github_deployer_run" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.fileshare.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

# Deploy a service that runs as the fileshare-app runtime SA (actAs).
resource "google_service_account_iam_member" "github_deployer_actas_runtime" {
  service_account_id = google_service_account.fileshare_app.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}

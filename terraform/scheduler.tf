# ── Cloud Scheduler — hourly file cleanup ─────────────────────────────────────
# Calls GET /api/cleanup on the Cloud Run service once per hour.
# Auth uses GCP OIDC: the scheduler attaches a short-lived token signed by
# the fileshare_scheduler SA. The cleanup route verifies the token against
# Google's public keys — no shared secret required.

resource "google_service_account" "fileshare_scheduler" {
  project      = var.project_id
  account_id   = "fileshare-scheduler"
  display_name = "Fileshare Scheduler"
  description  = "Service account used by Cloud Scheduler to invoke the cleanup route."
}

# Grant the scheduler SA permission to invoke the Cloud Run service.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.fileshare.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.fileshare_scheduler.email}"
}

resource "google_cloud_scheduler_job" "cleanup" {
  project  = var.project_id
  region   = var.region
  name     = "fileshare-cleanup"
  schedule = "0 * * * *"

  http_target {
    http_method = "GET"
    uri         = "${google_cloud_run_v2_service.fileshare.uri}/api/cleanup"

    oidc_token {
      service_account_email = google_service_account.fileshare_scheduler.email
      audience              = google_cloud_run_v2_service.fileshare.uri
    }
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_service.fileshare,
    google_cloud_run_v2_service_iam_member.scheduler_invoker,
  ]
}

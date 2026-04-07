# ── File-storage bucket ───────────────────────────────────────────────────────
# Either create it (create_file_bucket = true) or read the pre-existing bucket
# as a data source (create_file_bucket = false, the default for pubsec-se where
# gs://pubsec-fileshare already exists).

resource "google_storage_bucket" "fileshare_files" {
  count = var.create_file_bucket ? 1 : 0

  name                        = var.file_bucket_name
  project                     = var.project_id
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true

  lifecycle {
    prevent_destroy = true
  }
}

data "google_storage_bucket" "fileshare_files_existing" {
  count = var.create_file_bucket ? 0 : 1
  name  = var.file_bucket_name
}

# ── File bucket CORS ──────────────────────────────────────────────────────────
# Allows browsers to PUT directly to GCS via signed upload URLs.
# Works for both created and pre-existing file buckets.
# Re-applies if the service URI changes (i.e. service is replaced).

resource "terraform_data" "file_bucket_cors" {
  triggers_replace = [google_cloud_run_v2_service.fileshare.uri, var.custom_domain]

  provisioner "local-exec" {
    command = <<-EOT
      TMP=$(mktemp)
      ORIGINS="\"${google_cloud_run_v2_service.fileshare.uri}\""
      if [ -n "${var.custom_domain}" ]; then
        ORIGINS="$ORIGINS,\"https://${var.custom_domain}\""
      fi
      printf '[{"origin":[%s,"http://localhost:3000"],"method":["PUT"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]' \
        "$ORIGINS" > "$TMP"
      gcloud storage buckets update gs://${var.file_bucket_name} --cors-file="$TMP" --quiet
      rm -f "$TMP"
    EOT
  }

  depends_on = [google_cloud_run_v2_service.fileshare]
}

# ── SQLite volume bucket ──────────────────────────────────────────────────────
# Always created by Terraform. Must be STANDARD — NEARLINE and COLDLINE carry a
# 30-day minimum storage duration that creates unexpected costs if the DB object
# is ever deleted and recreated within that window.

resource "google_storage_bucket" "fileshare_db" {
  name                        = var.db_bucket_name
  project                     = var.project_id
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true

  lifecycle {
    prevent_destroy = true
  }
}

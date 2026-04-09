# ── Cloud Run Service ─────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "fileshare" {
  project  = var.project_id
  name     = var.cloud_run_service_name
  location = var.region

  template {
    service_account = google_service_account.fileshare_app.email

    scaling {
      # min=1: keep the instance warm; GCS FUSE re-initializes on cold start
      # max=1: hard requirement — SQLite WAL locking is not safe across concurrent FUSE writers
      min_instance_count = 1
      max_instance_count = 1
    }

    # GCS FUSE volume — mounts the SQLite DB bucket at /data
    volumes {
      name = "db"
      gcs {
        bucket    = google_storage_bucket.fileshare_db.name
        read_only = false
      }
    }

    containers {
      image = var.container_image

      resources {
        limits = {
          cpu    = var.cloud_run_cpu
          memory = var.cloud_run_memory
        }
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "db"
        mount_path = "/data"
      }

      # ── Static environment variables ────────────────────────────────────────
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "DATABASE_PATH"
        value = "/data/fileshare.db"
      }
      env {
        name  = "AUTH_TRUST_HOST"
        value = "true"
      }
      env {
        name  = "GCS_BUCKET"
        value = var.file_bucket_name
      }

      # OIDC issuer and admin domain are not sensitive — set as plain env vars
      dynamic "env" {
        for_each = local.oidc_enabled ? [var.oidc_issuer] : []
        content {
          name  = "AUTH_OIDC_ISSUER"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.oidc_admin_domain_set ? [var.oidc_admin_domain] : []
        content {
          name  = "AUTH_OIDC_ADMIN_DOMAIN"
          value = env.value
        }
      }

      # ── Secret-sourced environment variables ────────────────────────────────
      env {
        name = "AUTH_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.auth_secret.secret_id
            version = "latest"
          }
        }
      }

      # CLEANUP_SECRET retained for local development / manual curl testing.
      # Production cleanup is authenticated via OIDC (see scheduler.tf).
      env {
        name = "CLEANUP_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cleanup_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "CLEANUP_SCHEDULER_SA"
        value = google_service_account.fileshare_scheduler.email
      }

      dynamic "env" {
        for_each = local.oidc_enabled ? [1] : []
        content {
          name = "AUTH_OIDC_CLIENT_ID"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.oidc_client_id[0].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = local.oidc_enabled ? [1] : []
        content {
          name = "AUTH_OIDC_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.oidc_client_secret[0].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.auth_secret,
    google_secret_manager_secret_version.cleanup_secret,
    google_project_iam_member.fileshare_app_secret_accessor,
  ]
}

# ── Allow unauthenticated invocations ─────────────────────────────────────────
# Cloud Run IAM is left open; the app handles its own authentication via Auth.js.

resource "google_cloud_run_v2_service_iam_member" "allow_unauthenticated" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.fileshare.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Bootstrap job: create and execute once ────────────────────────────────────
# google_cloud_run_v2_job does not support GCS volume mounts in provider v5.x,
# so we create and execute the job entirely via gcloud CLI.
# Trigger on container_image so it re-runs if the image changes.

resource "terraform_data" "bootstrap" {
  triggers_replace = [var.container_image]

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      if gcloud run jobs describe ${var.cloud_run_job_name} \
           --region=${var.region} --project=${var.project_id} &>/dev/null 2>&1; then
        echo "Bootstrap job already exists, skipping create"
      else
        gcloud run jobs create ${var.cloud_run_job_name} \
          --image=${var.container_image} \
          --region=${var.region} \
          --project=${var.project_id} \
          --service-account=${google_service_account.fileshare_app.email} \
          --execution-environment=gen2 \
          --add-volume=name=db,type=cloud-storage,bucket=${google_storage_bucket.fileshare_db.name} \
          --add-volume-mount=volume=db,mount-path=/data \
          --set-env-vars=DATABASE_PATH=/data/fileshare.db \
          --set-secrets=ADMIN_USER=fileshare-admin-user:latest,ADMIN_PASS=fileshare-admin-pass:latest \
          --command=node \
          --args=scripts/bootstrap-admin.js \
          --quiet
      fi
      gcloud run jobs execute ${var.cloud_run_job_name} \
        --region=${var.region} --project=${var.project_id} --wait
    EOT
  }

  depends_on = [
    google_cloud_run_v2_service.fileshare,
    google_project_service.apis,
    google_secret_manager_secret_version.admin_user,
    google_secret_manager_secret_version.admin_pass,
    google_project_iam_member.fileshare_app_secret_accessor,
  ]
}

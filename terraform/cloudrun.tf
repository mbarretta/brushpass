# ── Cloud Run Service ─────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "fileshare" {
  project  = var.project_id
  name     = var.cloud_run_service_name
  location = var.region

  template {
    service_account = google_service_account.fileshare_app.email

    scaling {
      # min=1: keep the instance warm; GCS FUSE re-initializes on cold start
      # max=1: hard requirement — SQLite WAL locking is not safe across concurrent FUSE
      # writers AND the in-memory rate limiter is per-instance. See the validation
      # block on var.cloud_run_max_instance_count in variables.tf.
      min_instance_count = 1
      max_instance_count = var.cloud_run_max_instance_count
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

      # OIDC issuer and admin domain are not sensitive — set as plain env vars.
      # Gated on oidc_issuer_set / oidc_admin_domain_set (see secrets.tf locals)
      # so they are emitted for the agent device-grant flow even when the
      # interactive OIDC login client is not configured.
      dynamic "env" {
        for_each = local.oidc_issuer_set ? [var.oidc_issuer] : []
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

      # Agent key TTL is not sensitive — set as a plain env var whenever the
      # agent device-grant client is enabled.
      dynamic "env" {
        for_each = local.agent_oidc_enabled ? [var.agent_key_ttl_seconds] : []
        content {
          name  = "AGENT_KEY_TTL_SECONDS"
          value = tostring(env.value)
        }
      }

      # AUTH_URL / CLEANUP_AUDIENCE: see the bootstrap sequence documented on
      # var.auth_url in variables.tf and the postcondition below. Both stay
      # unset (env vars omitted entirely) until auth_url is set post-bootstrap.
      dynamic "env" {
        for_each = var.auth_url != "" ? [var.auth_url] : []
        content {
          name  = "AUTH_URL"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.cleanup_audience != "" ? [var.cleanup_audience] : []
        content {
          name  = "CLEANUP_AUDIENCE"
          value = env.value
        }
      }

      # ── Secret-sourced environment variables ────────────────────────────────
      # Every secret below pins an explicit secret_manager_secret_version
      # resource's `version` (a numeric string, e.g. "1") rather than "latest".
      # With min_instance_count = 1, a warm instance never re-reads "latest" on
      # its own; pinning the version means a rotation (which creates a new
      # secret_manager_secret_version resource here) changes this env value and
      # rolls a new revision atomically in the same apply.
      env {
        name = "AUTH_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.auth_secret.secret_id
            version = google_secret_manager_secret_version.auth_secret.version
          }
        }
      }

      # CLEANUP_SECRET is deliberately NOT set in production (removed
      # 2026-08-14): the cleanup route authenticates the scheduler via OIDC
      # and fails closed with the var unset. Local dev can still set it in
      # .env for manual curl testing.

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
              version = google_secret_manager_secret_version.oidc_client_id[0].version
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
              version = google_secret_manager_secret_version.oidc_client_secret[0].version
            }
          }
        }
      }

      dynamic "env" {
        for_each = local.agent_oidc_enabled ? [1] : []
        content {
          name = "AGENT_OIDC_CLIENT_ID"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.agent_oidc_client_id[0].secret_id
              version = google_secret_manager_secret_version.agent_oidc_client_id[0].version
            }
          }
        }
      }

      dynamic "env" {
        for_each = local.agent_oidc_enabled ? [1] : []
        content {
          name = "AGENT_OIDC_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.agent_oidc_client_secret[0].secret_id
              version = google_secret_manager_secret_version.agent_oidc_client_secret[0].version
            }
          }
        }
      }

      # Optional dedicated agent key-signing secret; when unset the app falls
      # back to AUTH_SECRET, so no env var is wired.
      dynamic "env" {
        for_each = local.agent_key_secret_set ? [1] : []
        content {
          name = "AGENT_KEY_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.agent_key_secret[0].secret_id
              version = google_secret_manager_secret_version.agent_key_secret[0].version
            }
          }
        }
      }
    }
  }

  lifecycle {
    # CI owns the image (pushed by deploy.sh's docker build + a workflow, tagged
    # by commit SHA); Terraform owns everything else about the service template.
    # Without this, the next `terraform apply` after a manual SHA-tagged rollback
    # (e.g. `gcloud run services update --image=...:sha-xxxx`) would silently
    # revert the running image back to var.container_image.
    ignore_changes = [template[0].containers[0].image]

    # AUTH_URL is a genuine self-reference: the Cloud Run v2 URL contains a hash
    # that cannot be derived from any other variable, so it cannot be
    # interpolated into this resource — only asserted against after the fact.
    # Skipped entirely while auth_url is unset (first-apply bootstrap; see
    # variables.tf). Once set, any apply where the live uri no longer matches
    # (e.g. the service was replaced and got a new hash) fails loudly instead of
    # silently shipping a stale AUTH_URL/CLEANUP_AUDIENCE to NextAuth and the
    # cleanup route's audience check.
    postcondition {
      condition     = var.auth_url == "" || self.uri == var.auth_url
      error_message = "google_cloud_run_v2_service.fileshare.uri (${self.uri}) no longer matches var.auth_url (${var.auth_url}) — the service was likely recreated with a new URL. Update auth_url (and cleanup_audience, if set) in terraform.tfvars to the new uri and re-apply before this service is used; the previous AUTH_URL is now stale."
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.auth_secret,
    google_project_iam_member.fileshare_app_secret_accessor,
    google_secret_manager_secret_iam_member.fileshare_app_secret_accessor,
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
    google_secret_manager_secret_iam_member.fileshare_app_secret_accessor,
  ]
}

output "service_url" {
  description = "Public URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.fileshare.uri
}

output "service_account_email" {
  description = "Email of the service account used by Cloud Run."
  value       = google_service_account.fileshare_app.email
}

output "file_bucket_name" {
  description = "Name of the GCS bucket used for uploaded files."
  value       = var.file_bucket_name
}

output "db_bucket_name" {
  description = "Name of the GCS bucket used for the SQLite FUSE volume."
  value       = google_storage_bucket.fileshare_db.name
}

output "artifact_registry_url" {
  description = "Base URL for pushing images to Artifact Registry."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repo}"
}

output "docker_push_command" {
  description = "Example docker buildx command for building and pushing the image."
  value       = "docker buildx build --platform linux/amd64 -t ${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repo}/fileshare:latest --push ."
}

output "bootstrap_job_name" {
  description = "Name of the Cloud Run bootstrap job (created and executed automatically on first apply)."
  value       = var.cloud_run_job_name
}

output "custom_domain_url" {
  description = "Custom domain URL for the fileshare service."
  value       = "https://fileshare.cgr-pubsec.dev"
}

output "cloud_dns_nameservers" {
  description = "Google Cloud DNS nameservers — set these at your domain registrar."
  value       = google_dns_managed_zone.cgr_pubsec_dev.name_servers
}

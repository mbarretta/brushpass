# ── Cloud DNS managed zone ────────────────────────────────────────────────────
# Zone was created manually via gcloud before Terraform was aware of it.
# Import with:
#   terraform import google_dns_managed_zone.cgr_pubsec_dev cgr-pubsec-dev

resource "google_dns_managed_zone" "cgr_pubsec_dev" {
  project     = var.project_id
  name        = "cgr-pubsec-dev"
  dns_name    = "cgr-pubsec.dev."
  description = "Public zone for cgr-pubsec.dev"
  visibility  = "public"
}

# ── CNAME: fileshare.cgr-pubsec.dev → ghs.googlehosted.com ──────────────────
resource "google_dns_record_set" "fileshare_cname" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.cgr_pubsec_dev.name
  name         = "fileshare.cgr-pubsec.dev."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["ghs.googlehosted.com."]
}

# ── Cloud Run domain mapping ───────────────────────────────────────────────────
# Requires domain ownership verified in Google Search Console before applying.

resource "google_cloud_run_domain_mapping" "fileshare" {
  project  = var.project_id
  location = var.region
  name     = "fileshare.cgr-pubsec.dev"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.fileshare.name
  }
}

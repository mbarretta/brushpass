# ── Custom domain (optional) ──────────────────────────────────────────────────
# Everything here is created only when var.custom_domain is set. The Cloud DNS
# zone is for the custom domain's parent (e.g. fileshare.example.com → zone
# example.com); point your registrar at the cloud_dns_nameservers output.
# The domain mapping requires domain ownership verified in Google Search
# Console before applying.

locals {
  custom_domain_enabled = var.custom_domain != ""
  dns_zone_domain       = join(".", slice(split(".", var.custom_domain), 1, length(split(".", var.custom_domain))))
}

resource "google_dns_managed_zone" "custom_domain" {
  count       = local.custom_domain_enabled ? 1 : 0
  project     = var.project_id
  name        = replace(local.dns_zone_domain, ".", "-")
  dns_name    = "${local.dns_zone_domain}."
  description = "Public zone for ${local.dns_zone_domain}"
  visibility  = "public"
}

# ── CNAME: custom domain → ghs.googlehosted.com ───────────────────────────────
resource "google_dns_record_set" "fileshare_cname" {
  count        = local.custom_domain_enabled ? 1 : 0
  project      = var.project_id
  managed_zone = google_dns_managed_zone.custom_domain[0].name
  name         = "${var.custom_domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["ghs.googlehosted.com."]
}

# ── Cloud Run domain mapping ──────────────────────────────────────────────────
resource "google_cloud_run_domain_mapping" "fileshare" {
  count    = local.custom_domain_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = var.custom_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.fileshare.name
  }
}

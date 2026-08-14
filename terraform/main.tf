terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in GCS, not locally: plaintext production secrets (AUTH_SECRET,
  # the OIDC client secrets, the agent key-signing secret) flow through every
  # resource in this state, and a local backend has no access control, locking,
  # or durability. The bucket is created by hand with gcloud (README.md
  # "Deploy to GCP with Terraform" Step 0; history in
  # docs/runbooks/tfstate-migration.md) — Terraform never manages its own
  # backend bucket, since that would be a bootstrap cycle.
  backend "gcs" {
    bucket = "pubsec-fileshare-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Required APIs ─────────────────────────────────────────────────────────────

locals {
  required_apis = [
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "sts.googleapis.com",            # WIF token exchange
    "iamcredentials.googleapis.com", # SA impersonation via WIF
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.required_apis)

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

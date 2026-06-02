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

  # Phase 1: local state.
  # Phase 2: after creating the state bucket manually, uncomment the gcs block,
  # comment out the local block, and run: terraform init -migrate-state
  #
  backend "local" {}

  # backend "gcs" {
  #   bucket = "pubsec-fileshare-tfstate"   # create this bucket manually first
  #   prefix = "terraform/state"
  # }
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

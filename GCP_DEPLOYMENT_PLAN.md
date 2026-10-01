# GCP Deployment: Cloud Run + GCS FUSE (SQLite) — Manual Reference

> **Note:** The preferred deployment method is now `terraform/deploy.sh`, which automates all of the steps below including `AUTH_URL` configuration and admin bootstrapping. See the [README's Terraform section](README.md#deploy-to-gcp-with-terraform). This document is kept as a reference for understanding the architecture or performing manual operations.

## Architecture

Deploys the app to **Cloud Run (gen2)** in GCP. SQLite is persisted by mounting a dedicated GCS bucket as a FUSE volume at `/data`. Files are stored in a separate GCS bucket as usual.

**Key constraint:** `--max-instances=1` is required. GCS FUSE does not support POSIX mandatory file locking — concurrent SQLite writers from multiple instances would corrupt the database. For a deployment that needs to scale horizontally, migrate the database layer (`src/lib/db.ts`) to Cloud SQL (PostgreSQL).

**SQLite on GCS FUSE — what to expect:**
- Startup: the FUSE mount is ready before your container process begins; no init step needed.
- WAL mode writes non-sequentially, so GCSFuse logs `OutOfOrderWrite` warnings for `fileshare.db-shm` and `fileshare.db-journal`. These are benign — the writes succeed and the warnings can be ignored.
- If you ever need to inspect or repair the DB directly, download it with `gcloud storage cp gs://YOUR_DB_BUCKET/fileshare.db .`

---

## Prerequisites

- `gcloud` CLI authenticated with an account that has `roles/owner` or equivalent on the project
- Docker with `buildx` support (for cross-platform builds on Apple Silicon)
- Docker able to pull the public `cgr.dev/chainguard/node` images (no credentials needed; the build runs locally, not in Cloud Build — see [Build notes](#build-notes))
- Two GCS buckets: one for uploaded files (can be pre-existing), one new one for the SQLite volume

---

## Step 1 — Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  --project=YOUR_PROJECT
```

> `cloudbuild.googleapis.com` is not needed — we build locally.

---

## Step 2 — Create the SQLite Volume Bucket

Keep this separate from the file-storage bucket. Mixing them causes confusion and FUSE mount issues.

```bash
gcloud storage buckets create gs://YOUR_PROJECT-fileshare-db \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --project=YOUR_PROJECT
```

> **Storage class note:** Use STANDARD (the default). NEARLINE has a 30-day minimum storage duration — if you ever need to delete or recreate the DB object, you'll pay for the full 30 days regardless.

---

## Step 3 — Create Service Account and IAM Bindings

```bash
gcloud iam service-accounts create fileshare-app \
  --display-name="Fileshare App" \
  --project=YOUR_PROJECT

# Access to uploaded file storage
gcloud storage buckets add-iam-policy-binding gs://YOUR_FILESHARE_BUCKET \
  --member="serviceAccount:fileshare-app@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Access to SQLite volume bucket
gcloud storage buckets add-iam-policy-binding gs://YOUR_PROJECT-fileshare-db \
  --member="serviceAccount:fileshare-app@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Read secrets at runtime
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:fileshare-app@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Step 4 — Create Secrets

```bash
echo -n "$(openssl rand -base64 32)" | \
  gcloud secrets create fileshare-auth-secret --data-file=- --project=YOUR_PROJECT

echo -n "$(openssl rand -base64 32)" | \
  gcloud secrets create fileshare-cleanup-secret --data-file=- --project=YOUR_PROJECT
```

---

## Step 5 — Build and Push the Image

### Build notes

**Build locally, not via Cloud Build.** `gcloud run deploy --source .` submits source to Cloud Build, which runs on Google's infrastructure and is not the project's supported build path. The public `cgr.dev/chainguard/node` images need no credentials; build locally with Docker, then push the result.

**Apple Silicon (ARM64) → Cloud Run (AMD64).** Building on an M-series Mac produces an ARM64 image by default. Cloud Run requires AMD64. Use `docker buildx build --platform linux/amd64`.

**`GCS_BUCKET` must be set at build time.** `src/lib/gcs.ts` throws at module import if the env var is missing. Next.js executes route handlers during `next build` to collect page data, which triggers that import. Set a placeholder value in the builder stage — it is only used during the build phase, never at runtime.

**Chainguard runtime images have no shell.** The `cgr.dev/chainguard/node:latest` runner image does not include `/bin/sh`. Use `CMD ["./node_modules/next/dist/bin/next", "start"]` to invoke Node directly via the image's built-in entrypoint. A shell-based `ENTRYPOINT ["/bin/sh", "..."]` will fail silently at container startup.

```bash
IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT/cloud-run-source-deploy/fileshare:latest

# Authenticate local Docker to Artifact Registry (one-time)
gcloud auth configure-docker us-central1-docker.pkg.dev

# Build for linux/amd64 and push in one step
docker buildx build \
  --platform linux/amd64 \
  -t $IMAGE \
  --push \
  .
```

> The `cloud-run-source-deploy` Artifact Registry repository is created automatically the first time you deploy to Cloud Run. If it doesn't exist yet, create it first:
> ```bash
> gcloud artifacts repositories create cloud-run-source-deploy \
>   --repository-format=docker \
>   --location=us-central1 \
>   --project=YOUR_PROJECT
> ```

---

## Step 6 — Deploy to Cloud Run

```bash
IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT/cloud-run-source-deploy/fileshare:latest

gcloud run deploy fileshare \
  --image=$IMAGE \
  --region=us-central1 \
  --execution-environment=gen2 \
  --add-volume=name=db,type=cloud-storage,bucket=YOUR_PROJECT-fileshare-db \
  --add-volume-mount=volume=db,mount-path=/data \
  --service-account=fileshare-app@YOUR_PROJECT.iam.gserviceaccount.com \
  --set-env-vars=GCS_BUCKET=YOUR_FILESHARE_BUCKET,AUTH_TRUST_HOST=true,DATABASE_PATH=/data/fileshare.db \
  --set-secrets=AUTH_SECRET=fileshare-auth-secret:latest,CLEANUP_SECRET=fileshare-cleanup-secret:latest \
  --min-instances=1 \
  --max-instances=1 \
  --memory=512Mi \
  --allow-unauthenticated \
  --project=YOUR_PROJECT
```

**Flag notes:**
- `--execution-environment=gen2` — required for Cloud Storage volume mounts
- `--max-instances=1` — required; SQLite cannot handle concurrent writers via FUSE
- `--min-instances=1` — keeps the instance warm; avoids cold starts where the FUSE mount re-initializes
- `AUTH_TRUST_HOST=true` — required because Cloud Run terminates TLS and proxies plain HTTP to the container; without this, Auth.js rejects requests with untrusted host errors

---

## Step 7 — Set AUTH_URL

`AUTH_URL` must match the service's public URL. Retrieve it after the first deploy:

```bash
CLOUD_RUN_URL=$(gcloud run services describe fileshare \
  --region=us-central1 --project=YOUR_PROJECT \
  --format="value(status.url)")

gcloud run services update fileshare \
  --region=us-central1 \
  --update-env-vars=AUTH_URL=$CLOUD_RUN_URL \
  --project=YOUR_PROJECT
```

---

## Step 8 — Bootstrap the First Admin User

Cloud Run containers have no persistent shell access, so the `sqlite3` CLI approach in the README doesn't apply. Instead, run a one-time Cloud Run Job using the same image and volume mount.

```bash
IMAGE=$(gcloud run services describe fileshare \
  --region=us-central1 --project=YOUR_PROJECT \
  --format="value(spec.template.spec.containers[0].image)")

# Store credentials as short-lived secrets
echo -n "admin" | \
  gcloud secrets create fileshare-admin-user --data-file=- --project=YOUR_PROJECT
echo -n "YOUR_ADMIN_PASSWORD" | \
  gcloud secrets create fileshare-admin-pass --data-file=- --project=YOUR_PROJECT

gcloud run jobs create fileshare-bootstrap \
  --image=$IMAGE \
  --region=us-central1 \
  --execution-environment=gen2 \
  --service-account=fileshare-app@YOUR_PROJECT.iam.gserviceaccount.com \
  --add-volume=name=db,type=cloud-storage,bucket=YOUR_PROJECT-fileshare-db \
  --add-volume-mount=volume=db,mount-path=/data \
  --set-env-vars=DATABASE_PATH=/data/fileshare.db \
  --set-secrets=ADMIN_USER=fileshare-admin-user:latest,ADMIN_PASS=fileshare-admin-pass:latest \
  --command=node \
  --args=scripts/bootstrap-admin.js \
  --project=YOUR_PROJECT

gcloud run jobs execute fileshare-bootstrap \
  --region=us-central1 --wait --project=YOUR_PROJECT

# Delete bootstrap secrets once login is confirmed
gcloud secrets delete fileshare-admin-user --project=YOUR_PROJECT --quiet
gcloud secrets delete fileshare-admin-pass --project=YOUR_PROJECT --quiet
```

The `scripts/bootstrap-admin.js` script creates the schema if the database is new, checks whether the username already exists, and inserts the admin user with `["admin","upload"]` permissions. It is safe to re-run.

---

## Step 9 — Cloud Scheduler for Cleanup

```bash
CLOUD_RUN_URL=$(gcloud run services describe fileshare \
  --region=us-central1 --project=YOUR_PROJECT \
  --format="value(status.url)")

CLEANUP_SECRET=$(gcloud secrets versions access latest \
  --secret=fileshare-cleanup-secret --project=YOUR_PROJECT)

gcloud scheduler jobs create http fileshare-cleanup \
  --schedule="0 * * * *" \
  --http-method=GET \
  --uri="${CLOUD_RUN_URL}/api/cleanup" \
  --update-headers="Authorization=Bearer ${CLEANUP_SECRET}" \
  --location=us-central1 \
  --project=YOUR_PROJECT
```

> `--http-method=GET` is required. Cloud Scheduler defaults to POST, but the cleanup endpoint only accepts GET.

---

## Optional: OIDC with Google

OIDC login creates a session but does not automatically grant permissions. An OIDC-authenticated user can access download pages but cannot upload or access the admin panel. To grant permissions, create a matching local user in `/admin/users` using the user's Google email as the username.

### Create OAuth credentials (GCP Console)

There is no CLI equivalent for this step:

1. GCP Console → APIs & Services → Credentials → **Create Credentials** → OAuth 2.0 Client ID
2. Application type: **Web application**
3. Authorized redirect URI: `{CLOUD_RUN_URL}/api/auth/callback/oidc`
4. Copy the Client ID and Client Secret

### Apply OIDC configuration

```bash
echo -n "YOUR_CLIENT_ID" | \
  gcloud secrets create fileshare-oidc-client-id --data-file=- --project=YOUR_PROJECT
echo -n "YOUR_CLIENT_SECRET" | \
  gcloud secrets create fileshare-oidc-client-secret --data-file=- --project=YOUR_PROJECT

gcloud run services update fileshare \
  --region=us-central1 \
  --update-env-vars=AUTH_OIDC_ISSUER=https://accounts.google.com \
  --update-secrets=AUTH_OIDC_CLIENT_ID=fileshare-oidc-client-id:latest,AUTH_OIDC_CLIENT_SECRET=fileshare-oidc-client-secret:latest \
  --project=YOUR_PROJECT
```

The login page will show a "Sign in with SSO" button after the next revision deploys.

---

## Redeployment

After code changes, rebuild and update the service:

```bash
IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT/cloud-run-source-deploy/fileshare:latest

docker buildx build --platform linux/amd64 -t $IMAGE --push .

gcloud run services update fileshare \
  --image=$IMAGE \
  --region=us-central1 \
  --project=YOUR_PROJECT
```

---

## Verification

```bash
CLOUD_RUN_URL=$(gcloud run services describe fileshare \
  --region=us-central1 --project=YOUR_PROJECT \
  --format="value(status.url)")

CLEANUP_SECRET=$(gcloud secrets versions access latest \
  --secret=fileshare-cleanup-secret --project=YOUR_PROJECT)
```

1. Visit `$CLOUD_RUN_URL` — should redirect to `/login`
2. Log in with the admin credentials from step 8
3. Navigate to `/admin` — file list and user management should load
4. Upload a test file — verify it appears in `gs://YOUR_FILESHARE_BUCKET`
5. Verify SQLite: `gcloud storage ls gs://YOUR_PROJECT-fileshare-db/` — should show `fileshare.db`
6. Test cleanup: `curl -H "Authorization: Bearer $CLEANUP_SECRET" $CLOUD_RUN_URL/api/cleanup` → `{"deleted":0,"errors":[]}`
7. *(If OIDC configured)* Login page shows "Sign in with SSO"; Google login flow completes

---

## Scaling Beyond Single Instance

`--max-instances=1` is the hard limit for this SQLite-on-FUSE architecture. If you need horizontal scaling, the migration path is:

1. Replace `src/lib/db.ts` with a PostgreSQL-compatible implementation (`pg` or Prisma)
2. Provision a Cloud SQL PostgreSQL instance
3. Connect via the Cloud SQL Auth Proxy (built into Cloud Run gen2 via `--add-cloudsql-instances`)
4. Remove the GCS FUSE volume mount and `--max-instances` constraint

The SQL dialect differences between SQLite and PostgreSQL in this codebase are minor (timestamp functions, JSON operators).

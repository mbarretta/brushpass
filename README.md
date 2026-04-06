# Secure File Share

A self-hosted secure file sharing application. Authenticated users upload files to GCP Cloud Storage and receive a shareable URL plus a one-time-shown download token. Anyone with the URL and token can download the file — no account required. Files can have optional TTLs with active cleanup. An admin panel provides file management, expiration control, download metrics, and user management.

## Contents

- [Requirements](#requirements)
- [Quick start (local dev)](#quick-start-local-dev)
- [Configuration reference](#configuration-reference)
- [GCS setup](#gcs-setup)
- [OIDC / SSO setup](#oidc--sso-setup)
- [First admin user](#first-admin-user)
- [Running in production](#running-in-production)
- [Deploy to GCP with Terraform](#deploy-to-gcp-with-terraform)
- [Scheduled cleanup](#scheduled-cleanup)
- [User management API](#user-management-api)

---

## Requirements

- **Node.js 18+** (tested on 20 LTS and 22)
- **npm** (comes with Node)
- A **GCP project** with a Cloud Storage bucket
- GCS credentials — either Application Default Credentials (ADC) or a service account JSON key

---

## Quick start (local dev)

```bash
# 1. Install dependencies (run from the repo root)
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# edit .env — see Configuration reference below

# 3. Run the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You will be redirected to `/login`.

> **Note:** The dev server uses Turbopack by default. If you hit eval() errors running inside a GSD or similar agent environment, use `npm run start` after a production build instead — the production server does not use eval().

---

## Configuration reference

All configuration is via environment variables. Copy `.env.example` to `.env` for local development. In production, set these in your process environment or secrets manager — do not commit `.env` to version control.

### Required

| Variable | Description |
|---|---|
| `GCS_BUCKET` | Name of the GCS bucket where uploaded files are stored. **Required at startup** — the server will not start without it. |
| `AUTH_SECRET` | Secret used to sign Auth.js JWT session tokens. Generate with `openssl rand -base64 32`. Must be the same across all instances if you run multiple. |
| `AUTH_URL` | The canonical base URL of your deployment, e.g. `https://files.example.com`. Used by Auth.js v5 to construct redirect URLs and validate origins. Required in production. |
| `DATABASE_PATH` | Path to the SQLite database file, e.g. `./data/fileshare.db`. The directory is created automatically. Defaults to `./data/fileshare.db` if unset. |
| `CLEANUP_SECRET` | Bearer token that protects `GET /api/cleanup`. Generate with `openssl rand -base64 32`. Keep this secret — anyone with it can trigger bulk deletion. |

### GCS credentials

The app uses the Google Cloud Node.js client which supports two credential modes:

| Variable | Description |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service account JSON key file, e.g. `/etc/secrets/sa.json`. If set, this takes precedence over ADC. |
| *(none)* | If `GOOGLE_APPLICATION_CREDENTIALS` is not set, the client uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials). On GCE/GKE/Cloud Run this is the instance service account. Locally, run `gcloud auth application-default login`. |

### OIDC / SSO (optional)

All three variables must be set together. Setting only some of them disables OIDC and logs a warning at startup.

| Variable | Description |
|---|---|
| `AUTH_OIDC_ISSUER` | OIDC issuer URL, e.g. `https://accounts.google.com` or `https://your-org.okta.com`. Must expose a `/.well-known/openid-configuration` endpoint. |
| `AUTH_OIDC_CLIENT_ID` | Client ID from your IdP application registration. |
| `AUTH_OIDC_CLIENT_SECRET` | Client secret from your IdP application registration. |

### Legacy / compatibility

| Variable | Description |
|---|---|
| `NEXTAUTH_URL` | Older Auth.js v4 name for `AUTH_URL`. Accepted for compatibility. Prefer `AUTH_URL` in new deployments. |

---

## GCS setup

### 1. Create a bucket

```bash
gcloud storage buckets create gs://YOUR_BUCKET_NAME \
  --location=US \
  --uniform-bucket-level-access
```

The bucket should **not** be public. The app streams files server-side — clients never access GCS directly.

### 2. IAM permissions

The identity running the app needs the following role on the bucket:

```
roles/storage.objectAdmin
```

This covers read, write, delete, and rename (copy + delete) operations. If you prefer least-privilege:

| Permission | Used for |
|---|---|
| `storage.objects.create` | Upload |
| `storage.objects.get` | Download streaming |
| `storage.objects.delete` | Admin delete, cleanup job, rename |
| `storage.objects.update` | Rename (rewrite metadata) |

### 3. Authentication options

**Option A — Application Default Credentials (recommended for GCP-hosted deployments)**

On GCE, GKE, or Cloud Run, attach a service account to the instance/pod/service with the permissions above. No credential file needed — the client library picks them up automatically.

For local development:
```bash
gcloud auth application-default login
# or
gcloud auth application-default login --impersonate-service-account=sa@project.iam.gserviceaccount.com
```

**Option B — Service account key file**

```bash
# Create a service account
gcloud iam service-accounts create fileshare \
  --display-name="Fileshare app"

# Grant bucket access
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET_NAME \
  --member="serviceAccount:fileshare@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Create and download a key
gcloud iam service-accounts keys create sa.json \
  --iam-account=fileshare@YOUR_PROJECT.iam.gserviceaccount.com
```

Then set in your environment:
```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
```

### 4. Changing the bucket

Update `GCS_BUCKET` in your environment and restart. Files already in the old bucket are **not** migrated automatically — they remain in the old bucket and downloads will fail for those files. If you need to migrate, copy the objects with `gcloud storage cp` before switching.

---

## OIDC / SSO setup

The app uses a generic OIDC provider — any IdP that exposes an OpenID Connect discovery document at `{issuer}/.well-known/openid-configuration` will work. Tested with Google, Okta, and Keycloak. Should work with any compliant IdP (Azure AD, Auth0, Dex, etc.).

### 1. Register a callback URL with your IdP

The redirect URI to register is:

```
{AUTH_URL}/api/auth/callback/oidc
```

For example: `https://files.example.com/api/auth/callback/oidc`

### 2. Set the three env vars

```bash
AUTH_OIDC_ISSUER=https://accounts.google.com     # or your IdP's issuer URL
AUTH_OIDC_CLIENT_ID=your-client-id
AUTH_OIDC_CLIENT_SECRET=your-client-secret
```

When all three are set, the login page shows a **"Sign in with SSO"** button below the username/password form.

### 3. How OIDC users get permissions

OIDC login creates an Auth.js session, but **does not create a user record in the SQLite database**. OIDC users authenticate successfully but receive no `upload` or `admin` permissions — they can access the download pages and the home page, but not upload or admin routes.

This is intentional: the app's permission model is credentials-based. If you need OIDC users to have permissions, the current path is to also create a matching local user account with the same username and assign permissions there. A future milestone may add OIDC claim-to-permission mapping.

### 4. IdP-specific notes

**Google:**
- Issuer: `https://accounts.google.com`
- Configure an OAuth 2.0 Web Application credential in Google Cloud Console
- Add the callback URL to "Authorized redirect URIs"

**Okta:**
- Issuer: `https://your-org.okta.com` (or a custom authorization server URL)
- Create an OIDC Web Application
- Add the callback URL to "Sign-in redirect URIs"
- Enable "Client Credentials" or "Authorization Code" grant type

**Keycloak:**
- Issuer: `https://your-keycloak/realms/your-realm`
- Create a Client with "openid-connect" protocol
- Set Access Type to "confidential"
- Add the callback URL to "Valid Redirect URIs"

**Partial config warning:** If only 1 or 2 of the three OIDC vars are set, the server logs a warning at startup and disables the OIDC button entirely. It does not fail to start.

---

## First admin user

There is no seed script. The first admin user must be created via the API before any user can log in to the admin UI.

**Bootstrap the first admin user:**

```bash
# Generate a bcrypt hash of your chosen password
node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('your-password', 10).then(h => console.log(h));
"

# Insert directly into SQLite
sqlite3 /path/to/your/fileshare.db \
  "INSERT INTO users (username, password_hash, permissions) VALUES ('admin', '<paste-hash>', '[\"admin\",\"upload\"]');"
```

After that, log in at `/login` and use the admin UI at `/admin/users` to create additional users.

**Alternatively, use the API directly** (if you can authenticate somehow — e.g. via a temporary user created in the DB):

```bash
curl -X POST https://files.example.com/api/admin/users \
  -H "Content-Type: application/json" \
  -b "session-cookie=..." \
  -d '{
    "username": "alice",
    "password": "her-password",
    "permissions": ["upload"]
  }'
```

**Permission values:**
- `"upload"` — can upload files
- `"admin"` — full admin access (implies upload access)

Users can have both: `["admin", "upload"]`.

---

## Running in production

### Build

```bash
npm run build
```

This produces an optimized Next.js build in `.next/`. The build uses webpack (Turbopack is disabled for production builds to avoid path-resolution issues in certain hosting environments).

### Start

```bash
npm run start
```

This starts the Next.js production server on port 3000 by default.

To use a different port:
```bash
PORT=8080 npm run start
```

### Required env vars at runtime

At minimum, set these before starting:

```bash
export GCS_BUCKET=your-bucket-name
export AUTH_SECRET=$(openssl rand -base64 32)
export AUTH_URL=https://files.example.com
export DATABASE_PATH=/var/lib/fileshare/fileshare.db
export CLEANUP_SECRET=$(openssl rand -base64 32)
# If using a service account key:
export GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/sa.json
```

### Process supervision with systemd

Create `/etc/systemd/system/fileshare.service`:

```ini
[Unit]
Description=Secure File Share
After=network.target

[Service]
Type=simple
User=fileshare
WorkingDirectory=/opt/fileshare
ExecStart=/usr/bin/node_modules/.bin/next start --webpack
Restart=on-failure
RestartSec=5

Environment=NODE_ENV=production
Environment=PORT=3000
Environment=GCS_BUCKET=your-bucket-name
Environment=AUTH_SECRET=your-auth-secret
Environment=AUTH_URL=https://files.example.com
Environment=DATABASE_PATH=/var/lib/fileshare/fileshare.db
Environment=CLEANUP_SECRET=your-cleanup-secret
Environment=GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/sa.json

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable fileshare
systemctl start fileshare
journalctl -fu fileshare
```

### Process supervision with pm2

```bash
npm install -g pm2

pm2 start npm --name fileshare -- run start
pm2 save
pm2 startup  # follow the printed instructions to enable on boot
```

Or with an ecosystem file (`ecosystem.config.js`):

```js
module.exports = {
  apps: [{
    name: 'fileshare',
    script: 'npm',
    args: 'run start',
    cwd: '/opt/fileshare',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      GCS_BUCKET: 'your-bucket-name',
      AUTH_SECRET: 'your-auth-secret',
      AUTH_URL: 'https://files.example.com',
      DATABASE_PATH: '/var/lib/fileshare/fileshare.db',
      CLEANUP_SECRET: 'your-cleanup-secret',
    },
  }],
};
```

```bash
pm2 start ecosystem.config.js
```

### Reverse proxy with nginx

The app listens on HTTP. Put nginx in front for TLS termination:

```nginx
server {
    listen 443 ssl;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    # Increase for large file uploads — adjust to your needs
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for streaming downloads — disable buffering
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}
```

> **`AUTH_TRUST_HOST`:** If Auth.js logs warnings about untrusted hosts behind the proxy, set `AUTH_TRUST_HOST=true` in your environment. This tells Auth.js to trust the `X-Forwarded-Host` header from the proxy.

### SQLite data directory

The SQLite database file must persist across restarts. Ensure the directory exists and is writable by the process user:

```bash
mkdir -p /var/lib/fileshare
chown fileshare:fileshare /var/lib/fileshare
```

The app creates the database file and runs schema migrations automatically on first start.

---

## Deploy to GCP with Terraform

The `terraform/` directory contains the complete infrastructure definition for deploying to GCP Cloud Run. It provisions GCS buckets, a service account, Secret Manager secrets, the Cloud Run service and bootstrap job, and a Cloud Scheduler cleanup cron — all from a single `terraform apply`.

### Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.6
- `gcloud` CLI authenticated: `gcloud auth application-default login`
- Docker with `buildx` support (for cross-platform ARM → AMD64 builds)
- Docker authenticated to Artifact Registry: `gcloud auth configure-docker us-central1-docker.pkg.dev`

### Step 1 — Build and push the image

```bash
IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT/cloud-run-source-deploy/fileshare:latest
docker buildx build --platform linux/amd64 -t $IMAGE --push .
```

### Step 2 — Configure and first apply

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in project_id, container_image, bucket names,
# and bootstrap_admin_pass. Leave auth_url = "" for now.

terraform init
terraform plan
terraform apply
```

This creates ~20 resources: API enablement, GCS buckets, service account + IAM, Secret Manager secrets, the Cloud Run service (without `AUTH_URL`), the bootstrap job, and the Cloud Scheduler cleanup trigger.

### Step 3 — Set AUTH_URL and re-apply

Auth.js requires the service's public URL, which isn't known until after the first apply.

```bash
terraform output service_url
# Copy the URL, add it to terraform.tfvars:
#   auth_url = "https://fileshare-abc123-uc.a.run.app"

terraform apply   # updates only the Cloud Run service
```

### Step 4 — Bootstrap the first admin user

```bash
gcloud run jobs execute fileshare-bootstrap \
  --region=us-central1 --project=YOUR_PROJECT --wait
```

Or copy the exact command from `terraform output bootstrap_job_execute_command`.

### Step 5 — Delete bootstrap secrets

After verifying you can log in, remove the temporary admin credentials:

```bash
gcloud secrets delete fileshare-admin-user --project=YOUR_PROJECT --quiet
gcloud secrets delete fileshare-admin-pass --project=YOUR_PROJECT --quiet
terraform state rm google_secret_manager_secret.admin_user
terraform state rm google_secret_manager_secret_version.admin_user
terraform state rm google_secret_manager_secret.admin_pass
terraform state rm google_secret_manager_secret_version.admin_pass
```

Also remove the corresponding resource blocks from `terraform/secrets.tf` and the `ADMIN_USER`/`ADMIN_PASS` env blocks from the bootstrap job in `terraform/cloudrun.tf`.

### Redeployments

Build and push a new image, update `container_image` in `terraform.tfvars`, then `terraform apply`. Using a specific image tag (e.g. `fileshare:git-abc1234`) instead of `:latest` makes `terraform plan` show the exact change being deployed.

### Importing pre-existing resources

If you ran the manual deployment from `GCP_DEPLOYMENT_PLAN.md` first, import existing resources before applying:

```bash
# Artifact Registry repo
terraform import \
  google_artifact_registry_repository.cloud_run_source_deploy \
  "projects/PROJECT/locations/REGION/repositories/cloud-run-source-deploy"

# Existing Secret Manager secrets
terraform import google_secret_manager_secret.auth_secret \
  "projects/PROJECT/secrets/fileshare-auth-secret"
terraform import google_secret_manager_secret.cleanup_secret \
  "projects/PROJECT/secrets/fileshare-cleanup-secret"

# Service account
terraform import google_service_account.fileshare_app \
  "projects/PROJECT/serviceAccounts/fileshare-app@PROJECT.iam.gserviceaccount.com"
```

### Notes

- **`max-instances=1`** is enforced at the Terraform level. SQLite on GCS FUSE does not support concurrent writers — do not increase this unless you migrate to Cloud SQL.
- **Terraform state** contains sensitive values (generated secrets). The default backend is local; switch to a GCS backend for team use (instructions in `terraform/main.tf`).
- **OIDC:** set `oidc_issuer`, `oidc_client_id`, and `oidc_client_secret` in `terraform.tfvars` and re-apply. All three must be non-empty to enable. Register `{service_url}/api/auth/callback/oidc` as the redirect URI with your IdP first.

---

## Scheduled cleanup

The cleanup job deletes expired files from GCS and removes their records from SQLite. It does not run automatically — you must call it on a schedule.

**Endpoint:** `GET /api/cleanup`
**Auth:** `Authorization: Bearer {CLEANUP_SECRET}`

```bash
curl -H "Authorization: Bearer $CLEANUP_SECRET" https://files.example.com/api/cleanup
# Response: {"deleted": 3, "errors": []}
```

**Schedule with cron:**

```cron
# Run cleanup every hour
0 * * * * curl -sf -H "Authorization: Bearer YOUR_SECRET" https://files.example.com/api/cleanup >> /var/log/fileshare-cleanup.log 2>&1
```

**Schedule with systemd timer:**

`/etc/systemd/system/fileshare-cleanup.service`:
```ini
[Unit]
Description=Fileshare cleanup job

[Service]
Type=oneshot
ExecStart=curl -sf -H "Authorization: Bearer YOUR_SECRET" https://files.example.com/api/cleanup
```

`/etc/systemd/system/fileshare-cleanup.timer`:
```ini
[Unit]
Description=Run fileshare cleanup hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now fileshare-cleanup.timer
```

The cleanup job is idempotent — running it more frequently than necessary is safe. Errors deleting individual files (e.g. already-deleted GCS objects) are logged but do not abort the job; the response body includes an `errors` array with per-file failures.

---

## User management API

The admin UI at `/admin/users` covers most user management needs. For scripting or bootstrapping, the REST API is available to any session with `admin` permission.

### List users

```bash
GET /api/admin/users
```

### Create user

```bash
curl -X POST https://files.example.com/api/admin/users \
  -H "Content-Type: application/json" \
  -b "your-session-cookie" \
  -d '{
    "username": "alice",
    "password": "secure-password",
    "permissions": ["upload"]
  }'
```

Permissions: `["upload"]`, `["admin"]`, or `["admin", "upload"]`.
Returns 409 if the username already exists.

### Update user

```bash
PATCH /api/admin/users/{id}
# Body: { "username"?: string, "password"?: string, "permissions"?: string[] }
```

### Delete user

```bash
DELETE /api/admin/users/{id}
```

Returns 409 if you attempt to delete your own account.

---

## Changing configuration

### Change the GCS bucket

1. Update `GCS_BUCKET` in your environment.
2. Restart the server.
3. Note: files uploaded to the old bucket are not migrated. Their download links will break until the objects are manually copied to the new bucket with the same key names.

### Change AUTH_SECRET

Changing `AUTH_SECRET` invalidates all existing sessions — every logged-in user will be signed out on their next request. Rotate it like any session signing key: update the value and restart.

### Change CLEANUP_SECRET

Update the value in your environment and restart. Update any cron jobs or timers that use the old value.

### Change DATABASE_PATH

1. Stop the server.
2. Copy the existing database file to the new path: `cp old/fileshare.db new/fileshare.db`
3. Update `DATABASE_PATH` and restart.

Moving the database without copying it will start fresh with an empty database — all file records and users will be lost (the GCS objects remain, but there will be no metadata to serve them).

### Add or remove OIDC

To enable: set all three `AUTH_OIDC_*` vars and restart. The SSO button appears on the login page automatically.

To disable: unset (or leave empty) any one of the three vars and restart. The SSO button disappears. Existing sessions created via OIDC remain valid until they expire.


<img width="500" alt="brushpass-logo-horizontal" src="https://github.com/user-attachments/assets/f2602517-020f-467d-93f3-0d99dbbfd723" />

# Brushpass

Brushpass is a self-hosted secure file transfer tool. Authenticated users upload files to GCP Cloud Storage and receive a shareable URL plus a one-time-shown download token. Anyone with the URL and token can download the file — no account required. Files can have optional TTLs with active cleanup. An admin panel provides file management, expiration control, download metrics, and user management.

## Chainguard security stack

Brushpass uses Chainguard throughout the container and dependency supply chain.

### Base images

The Docker build uses two Chainguard Container images:

```dockerfile
FROM cgr.dev/barretta/node:26-dev AS builder   # build stage — includes gcc, make, python3 for native addons
FROM cgr.dev/barretta/node:26-slim AS runner   # runtime stage — minimal, distroless-style
```

Both images are rebuilt nightly from source with zero known CVEs at release time and ship with Sigstore signatures and SBOMs. The multi-stage build means the final runtime image contains only the Node.js runtime and application files — no compiler toolchain, no package manager, no shell.

### npm dependencies (Chainguard Libraries for JavaScript)

The production npm dependencies in [`package.json`](./package.json) are available in the [Chainguard Libraries for JavaScript](https://edu.chainguard.dev/chainguard/libraries/javascript/overview/) registry at their exact pinned versions. This list is intentionally not duplicated here as a version table — `package.json`'s `dependencies` field is the single source of truth for what's installed and at what version, and a hand-maintained copy goes stale the moment a dependency is bumped (as happened here: this section previously pinned `next` and `next-auth` versions several releases behind what was actually installed).

Chainguard Libraries rebuilds every package from its original source repository in a hardened SLSA L2 build environment rather than downloading pre-compiled artifacts from the public npm registry. Each package ships with Sigstore signatures and SLSA provenance attestations. This eliminates the class of supply-chain attacks where malware is injected into a registry artifact after the legitimate source code was written — [~99% of known malicious npm packages by that vector](https://www.chainguard.dev/unchained/mitigating-malware-in-the-npm-ecosystem-with-chainguard-libraries).

You can verify any installed package with `chainctl libraries verify $(npm config get cache)` — note that this repo's `.npmrc` pins installs to the public npm registry (see [Dependency security scanning](#dependency-security-scanning)) so CI never depends on Chainguard registry credentials it doesn't have; to populate the cache from Chainguard Libraries instead for local verification, use `npm ci --registry=https://libraries.cgr.dev/javascript/` — `npm ci` fills the cache without rewriting `package-lock.json`'s resolved URLs, which is exactly the hazard the repo `.npmrc` exists to prevent (`npm install --registry=...` would rewrite them).

---

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
- [Dependency security scanning](#dependency-security-scanning)
- [User management API](#user-management-api)

---

## Requirements

- **Node.js 20+** for local development (CI tests on 22 LTS; the production container runs Node 26)
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
| `AUTH_URL` | The canonical base URL of your deployment, e.g. `https://files.example.com`. Used by Auth.js v5 to construct redirect URLs and validate origins. Required in production. Must be the URL users actually browse to (your custom domain, if you have one) — the whole OAuth/SSO flow anchors to it, and a mismatched value breaks the token exchange. |
| `DATABASE_PATH` | Path to the SQLite database file, e.g. `./data/fileshare.db`. The directory is created automatically. Defaults to `./data/fileshare.db` if unset. |

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
| `AUTH_OIDC_ADMIN_DOMAIN` | Email domain whose users automatically receive `["upload", "admin"]` on first OIDC sign-in (e.g. `example.com`). Optional — leave unset to require manual permission grants. |

### Cleanup auth (self-hosted only)

| Variable | Description |
|---|---|
| `CLEANUP_SECRET` | Bearer token that protects `GET /api/cleanup` when you drive cleanup yourself (cron, systemd timer). Generate with `openssl rand -base64 32` — anyone with it can trigger bulk deletion. **Not used on the Terraform/Cloud Run deployment**, which authenticates Cloud Scheduler via OIDC instead; leave it unset there and the route fails closed to everything but valid scheduler tokens. |

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

OIDC sign-in upserts a user record in SQLite (`auth_provider='oidc'`, no password hash). By default new OIDC users receive **no permissions** — they can access download pages but not upload or admin routes.

Two ways to grant permissions:

**Option A — Domain auto-promotion (recommended for internal deployments)**

Set `AUTH_OIDC_ADMIN_DOMAIN` to your organization's email domain:

```bash
AUTH_OIDC_ADMIN_DOMAIN=example.com
```

Users whose email matches that domain automatically receive `["upload", "admin"]` on their **first** OIDC sign-in. Subsequent logins do not change permissions — so permissions can be downgraded manually without being re-granted on next login.

**Option B — Manual grant via admin UI**

Leave `AUTH_OIDC_ADMIN_DOMAIN` unset. After the user signs in once (creating their record), go to `/admin/users`, find the user, and assign permissions.

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

> **Terraform/Cloud Run deployment:** use Step 4 of [Deploy to GCP with Terraform](#deploy-to-gcp-with-terraform) instead — either the SSO admin-domain path (no bootstrap credentials at all) or the one-off bootstrap job. The instructions below are for self-hosted deployments with direct filesystem access to the SQLite database.

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
Description=Brushpass
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

The `terraform/` directory contains the complete infrastructure definition for deploying to GCP Cloud Run: the service (SQLite on a GCS FUSE volume), Secret Manager wiring with per-secret IAM and version-pinned references, an hourly Cloud Scheduler cleanup job authenticated via OIDC (no shared secret), Workload Identity Federation for keyless GitHub Actions deploys, and an optional custom domain (Cloud DNS + domain mapping).

### Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.6
- `gcloud` CLI authenticated: `gcloud auth application-default login`
- Docker with `buildx` support (for cross-platform ARM → AMD64 builds)
- A GCP project with billing enabled (APIs are enabled by Terraform)

### Step 0 — One-time setup for a new environment

Skip this step if you are working in an environment that has already been deployed.

**a. Create the state bucket.** State lives in GCS (it contains plaintext secrets and needs locking, access control, and durability). Terraform never manages its own backend bucket, so create it by hand:

```bash
gcloud storage buckets create gs://YOUR-TFSTATE-BUCKET \
  --project=YOUR_PROJECT --location=YOUR_REGION \
  --uniform-bucket-level-access --pap
gcloud storage buckets update gs://YOUR-TFSTATE-BUCKET --versioning
```

Then point the backend at it in `terraform/main.tf` (`backend "gcs" { bucket = ... }`).

**b. Adapt the environment-specific files.** This repo carries its home environment's values; a new environment must change:

| File | What to change |
|---|---|
| `terraform/main.tf` | Backend bucket name (from **a**). |
| `terraform/dns.tf` | The zone and hostname are literal (`cgr-pubsec.dev`). Edit them for your domain — or delete the file if you don't want a custom domain. The domain mapping requires domain ownership verified in Google Search Console first. |
| `terraform/terraform.tfvars` | Everything in Step 1, including `github_repository` and `custom_domain` if applicable. |
| `.github/workflows/deploy.yml` | `PROJECT_ID`, `REGION`, `IMAGE`, `workload_identity_provider`, `service_account` — the last two come from the `workload_identity_provider` and `deployer_service_account_email` Terraform outputs after the first apply. |

**c. Register OAuth clients** (Google Cloud Console → Credentials; skip what you don't use):

- **Interactive SSO login** — a **Web application** client. Authorized redirect URI: `{public URL}/api/auth/callback/oidc` (with a custom domain you know this upfront; otherwise add it after the first apply — it's printed as the `oidc_callback_url` output). Client ID/secret go in `terraform.tfvars` (Step 1).
- **Agent device-grant flow** (optional) — a **TVs and Limited Input devices** client. Its credentials go in the repo-root `.env`, **not** tfvars — see [AGENTS.md](./AGENTS.md) for the full setup and the `.env`↔tfvars precedence rules.

### Step 1 — Configure

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Fill in: project_id, region, container_image, bucket names,
# oidc_* values, custom_domain / github_repository if applicable.
# Leave auth_url and cleanup_audience unset for the very first apply.
```

Secrets split by home: the interactive OIDC client ID/secret live in `terraform.tfvars`; agent-flow secrets (`AGENT_OIDC_CLIENT_ID/SECRET`, `AGENT_KEY_SECRET`) live in `.env` and are mapped to `TF_VAR_*` by the deploy scripts. Commit neither file.

> **Fresh environment shortcut:** `revoke_project_secret_accessor = true` can be set from the very first apply — the two-apply migration sequence documented in `iam.tf` only matters when narrowing IAM under an already-running service.

### Step 2 — First apply

```bash
./deploy.sh
```

The script configures Docker auth for Artifact Registry, imports the AR repo into state if it already exists, builds and pushes the image (`linux/amd64`), then plans, shows the plan, and asks for confirmation before applying. Flags: `--plan` (plan only, no build/push, no apply), `--yes` (skip confirmation for CI).

Note: Terraform deliberately ignores the service's image field after creation (`lifecycle ignore_changes` — CI owns the image), so later `deploy.sh` runs do not roll new code. Use `./redeploy.sh` to ship an image.

### Step 3 — Anchor the URLs and re-apply

Cloud Run URLs contain a hash that can't be known before the service exists, so this is always a second apply:

```bash
terraform output -raw service_url    # → https://fileshare-HASH-REGION.a.run.app
```

In `terraform.tfvars`, set:

- `cleanup_audience` — the run.app URL, exactly as printed. This is the OIDC audience the cleanup route verifies scheduler tokens against; a lifecycle postcondition fails future applies loudly if the service is ever recreated with a new URL.
- `auth_url` — the **public browser-facing URL**: your custom domain if you mapped one, otherwise the same run.app URL. This is required for SSO to work — Auth.js anchors the entire OAuth flow (redirect URIs, token exchange, error redirects) to it; without it the OAuth legs disagree about the app's origin and Google rejects the token exchange with `redirect_uri_mismatch`.

```bash
./apply.sh apply    # Terraform only, no image rebuild
```

### Step 4 — First admin

Two paths, pick one:

- **SSO admin domain (recommended).** Set `oidc_admin_domain` in tfvars — the first user from that email domain to sign in with SSO automatically receives `["upload", "admin"]`. No bootstrap credentials ever exist.
- **One-off bootstrap job (credentials login).** The Terraform-managed bootstrap job was retired 2026-08-14; run it manually instead. The password is a plaintext env var here, which is acceptable only because you change it in the UI immediately after first login:

  ```bash
  gcloud run jobs create fileshare-bootstrap \
    --image=REGION-docker.pkg.dev/PROJECT/cloud-run-source-deploy/fileshare:latest \
    --region=REGION --project=PROJECT \
    --service-account=fileshare-app@PROJECT.iam.gserviceaccount.com \
    --execution-environment=gen2 \
    --add-volume=name=db,type=cloud-storage,bucket=YOUR_DB_BUCKET \
    --add-volume-mount=volume=db,mount-path=/data \
    --set-env-vars=DATABASE_PATH=/data/fileshare.db,ADMIN_USER=admin,ADMIN_PASS=TEMP_PASSWORD \
    --command=node --args=scripts/bootstrap-admin.js
  gcloud run jobs execute fileshare-bootstrap --region=REGION --project=PROJECT --wait
  # Log in, change the password at /admin, then remove the job:
  gcloud run jobs delete fileshare-bootstrap --region=REGION --project=PROJECT --quiet
  ```

### Step 5 — Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-PUBLIC-URL/login      # 200
gcloud scheduler jobs run fileshare-cleanup --project=PROJECT --location=REGION
# then check the request log shows GET /api/cleanup → 200
```

If SSO is configured, sign in via the login page's SSO button. If the agent flow is configured, an unauthenticated `POST /api/agent/device/start` should return `200` with `verification_uri`, `user_code`, and `poll_token`.

### CI deploys (GitHub Actions via WIF)

Pushes to `main` deploy automatically through `deploy.yml`: the workflow federates its GitHub OIDC token through the WIF provider (no service-account key anywhere) and is pinned three ways — repository, `refs/heads/main`, and `job_workflow_ref` (only `deploy.yml` itself may deploy, not any other workflow with `id-token: write`). After changing `github_repository` or the workflow values (Step 0b), verify with one manual `gh workflow run deploy.yml --ref main`. See `docs/runbooks/wif-claim-pinning.md` before ever touching `wif.tf` — replacing the provider carries a 30-day soft-delete lockout — and `docs/runbooks/branch-protection.md` for the required-checks setup.

### Redeployments

- `./redeploy.sh` — code-only changes: build + push + roll the image, no Terraform.
- `./apply.sh [plan|apply ...]` — infrastructure/secret changes: Terraform only, no image rebuild.
- `./deploy.sh` — both (stages the image and applies infrastructure).

### Notes

- **`max-instances=1`** is enforced at the Terraform level. SQLite on GCS FUSE does not support concurrent writers — do not increase this unless you migrate to Cloud SQL.
- **Terraform state** contains sensitive values (generated secrets) and lives in the GCS backend from Step 0. Never keep local state copies; `terraform.tfvars` and `.env` hold secrets and must never be committed.
- **Secret rotation:** every secret is wired to the service by a *pinned* secret version, so rotating a value is always a `./apply.sh` (adding a version in the Secret Manager console alone changes nothing). Order and procedures: `docs/runbooks/secret-rotation.md`.
- **OIDC:** set `oidc_issuer`, `oidc_client_id`, and `oidc_client_secret` in `terraform.tfvars` and re-apply. All three must be non-empty to enable. The exact redirect URI to register with your IdP is printed as the `oidc_callback_url` output after apply. Optionally set `oidc_admin_domain` to auto-grant upload+admin to users from that email domain on first sign-in.
- **Cleanup auth:** the deployed cleanup route authenticates Cloud Scheduler via OIDC token verification and fails closed — `CLEANUP_SECRET` is not set in this deployment (it remains a local-dev/self-hosted mechanism only).

---

## Scheduled cleanup

> **Terraform/Cloud Run deployment:** cleanup is provisioned automatically — a Cloud Scheduler job calls `GET /api/cleanup` hourly with an OIDC token the route verifies against Google's public keys (audience = `CLEANUP_AUDIENCE`). No `CLEANUP_SECRET` is involved. The instructions below are for self-hosted deployments.

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

## Dependency security scanning

[`.github/dependabot.yml`](.github/dependabot.yml) opens a weekly PR for outdated `npm` dependencies (patch/minor bumps grouped into one PR; majors and security updates opened individually) and for outdated GitHub Actions — the latter matters because this repo pins Actions to a commit SHA, which without Dependabot's `github-actions` ecosystem would mean silently freezing on whatever version was pinned at the time.

**Owner action required — not performed by this repo's automation:** Dependabot *security updates* (auto-opening a PR the moment an alert fires, independent of the weekly schedule) are a separate, per-repo GitHub setting and must be enabled by a repo admin:

```bash
gh api -X PUT repos/{owner}/{repo}/automated-security-fixes
```

or via the UI: **Settings → Code security → Dependabot → Security updates**. This is a mutating GitHub API/settings call, so it is intentionally left to the owner rather than scripted here.

**Manual verification after a `next` / `next-auth` upgrade:** because the advisories these upgrades clear cluster on proxy/middleware and session handling, confirm both of the following against a production build (`GCS_BUCKET=build-placeholder npm run build && npm run start`) before merging:

1. An unauthenticated request to a protected path (e.g. `GET /admin`) still gets a `307` redirect to `/login` — the proxy's auth gate is unaffected by the upgrade.
2. `POST /api/agent/device/start` is still reachable **unauthenticated** — i.e. it is not redirected to `/login` by the proxy — and returns its own handler response. With `AGENT_OIDC_CLIENT_ID` (and the other `AGENT_OIDC_*`/`AUTH_OIDC_*` vars — see [Agent upload-key minting](./AGENTS.md)) configured, that response is `200` with `verification_uri`, `user_code`, and `poll_token` (never the raw `device_code`); without them it fails closed with a `503 Agent device grant not configured`, which is the same fail-closed behavior confirmed at Step 1 above — either way the proxy never turns it into a login redirect.

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

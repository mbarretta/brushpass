<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent upload-key minting (setup)

The agent device-grant flow mints short-lived, upload-scoped keys so an
autonomous agent can drive the upload API. It uses a **second** Google OAuth
client, separate from the interactive-login OIDC client (`AUTH_OIDC_*`).

## Step 1 — Register the agent OAuth client (one-time, Google Cloud Console)

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type** → **TVs and Limited Input devices** (this is the client
   type that exposes the RFC 8628 device-authorization endpoint).
3. Create it, then copy the **Client ID** and **Client secret** for Step 2.
   (No redirect URI is needed for this client type.)

## Step 2 — Where each setting goes

The agent flow reuses the interactive client's **issuer** for endpoint discovery
and its **admin domain** for permission resolution, so both must be present even
if interactive SSO login is not configured. Settings split into two homes by
sensitivity:

| Setting | Home | Why |
|---|---|---|
| `AGENT_OIDC_CLIENT_ID` | `.env` | Secret. Sourced from `.env` by the deploy scripts (below) and passed to Terraform as `TF_VAR_agent_oidc_client_id`. **Keep it out of `terraform.tfvars`.** |
| `AGENT_OIDC_CLIENT_SECRET` | `.env` | Secret. Same as above. |
| `AGENT_KEY_TTL_SECONDS` | `.env` (optional) | Minted-key lifetime; default `900`. |
| `AGENT_KEY_SECRET` | `.env` (optional) | Dedicated signing secret; falls back to `AUTH_SECRET` when unset. |
| `oidc_issuer` | `.env` (`AUTH_OIDC_ISSUER`) **or** `terraform.tfvars` | **Non-secret** (e.g. `https://accounts.google.com`). Emitted as `AUTH_OIDC_ISSUER`. **Required** for the agent flow — without it discovery fails with `AUTH_OIDC_ISSUER is not configured`. |
| `oidc_admin_domain` | `.env` (`AUTH_OIDC_ADMIN_DOMAIN`) **or** `terraform.tfvars` | **Non-secret** (e.g. `example.com`). Emitted as `AUTH_OIDC_ADMIN_DOMAIN`; the minted key gets `upload`/`admin` only for accounts in this domain. |

**Why the split — Terraform variable precedence:** `TF_VAR_*` env vars are
Terraform's *lowest*-priority source, so any value **present** in
`terraform.tfvars` overrides them — **including an empty string `""`**, which
Terraform treats as a real value, not as "unset". So:

- Agent **secrets** stay in `.env` and must be **absent** from `terraform.tfvars`.
- `oidc_issuer` / `oidc_admin_domain` may come from **either** `.env` or
  `terraform.tfvars`. If you keep them in `.env`, make sure they are **not**
  present as empty strings in `terraform.tfvars` (omit the keys entirely) —
  otherwise the `""` silently wins and the agent flow loses its issuer.

For local dev, set all of the above `.env` vars **plus** `AUTH_OIDC_ISSUER` and
`AUTH_OIDC_ADMIN_DOMAIN` in `.env` (locally there is no Terraform; the app reads
them directly). See `.env.example` and `terraform/terraform.tfvars.example`.

## Step 3 — Deploy

The Terraform helper scripts in `terraform/` automatically source `.env` and map
the secrets onto `TF_VAR_*` (via `common.sh`'s `load_env_tfvars`), so you do not
hand-edit `terraform.tfvars` for secrets:

- `./deploy.sh` — build + push the image, then `terraform apply` (full deploy).
- `./apply.sh [plan|apply ...]` — Terraform only, no image rebuild (infra/secret
  changes; e.g. `./apply.sh plan`).
- `./redeploy.sh` — image-only (no Terraform); does **not** touch agent config.

After a deploy, verify with an unauthenticated `POST /api/agent/device/start` —
it should return `200` with a `verification_uri`, `user_code`, and `poll_token`
(not a redirect to `/login`, and never the raw `device_code`).

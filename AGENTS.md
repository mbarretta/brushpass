<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent upload-key minting (manual setup)

The agent device-grant flow mints short-lived, upload-scoped keys so an
autonomous agent can drive the upload API. It uses a **second** Google OAuth
client, separate from the interactive-login OIDC client (`AUTH_OIDC_*`).

Manual step (Google Cloud Console, one-time):

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Set **Application type** to **TVs and Limited Input devices**.
3. Create the client, then copy its **Client ID** and **Client secret** into the
   `AGENT_OIDC_CLIENT_ID` and `AGENT_OIDC_CLIENT_SECRET` settings
   (`.env` for local dev; `agent_oidc_client_id` / `agent_oidc_client_secret`
   in `terraform/terraform.tfvars` for Cloud Run — both are wired through Secret
   Manager exactly like the `AUTH_OIDC_*` client).

Related settings: `AGENT_KEY_TTL_SECONDS` (minted-key lifetime, default `900`)
and the optional `AGENT_KEY_SECRET` (dedicated signing secret; falls back to
`AUTH_SECRET` when unset). See `.env.example` and
`terraform/terraform.tfvars.example`.

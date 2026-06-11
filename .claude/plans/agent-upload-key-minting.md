# Design: Short-lived upload keys for agents via a brokered device grant

**Status:** Proposal · **Date:** 2026-06-11 · **Mode:** design (no code in this doc)

## Goal & constraints

Let an autonomous agent obtain a **short-lived** credential to drive the existing upload API,
with a **human-in-the-loop Google sign-in** and **no long-lived keys**. The Google OIDC client is
*confidential* (the app holds `AUTH_OIDC_CLIENT_SECRET`), so **the agent must never see that
secret** — the app brokers the OAuth exchange on the agent's behalf.

Non-goals: changing the file-bytes path (already agent-friendly — bytes go straight to GCS via a
signed PUT), adding a general-purpose public API, or replacing the cookie/UI login.

## Why this is feasible (verified)

Google's `https://accounts.google.com/.well-known/openid-configuration` exposes:

- `device_authorization_endpoint`: `https://oauth2.googleapis.com/device/code`
- `token_endpoint`: `https://oauth2.googleapis.com/token`
- `jwks_uri`: `https://www.googleapis.com/oauth2/v3/certs`
- `grant_types_supported` includes `urn:ietf:params:oauth:grant-type:device_code`

So the **OAuth 2.0 Device Authorization Grant (RFC 8628)** — the headless-client flow used by
`gcloud`, `gh`, `aws sso` — is available. **Caveat:** Google only honors the device endpoint for an
OAuth client of type **"TVs and Limited Input devices"**. The existing "Web application" client
(used for UI login) cannot be reused here; a **second** Google client is required for the agent
flow (see §5).

## 1. Brokered device-grant flow (end to end)

```
 agent                         brushpass app                       Google
   │                                │                                 │
   │ POST /api/agent/device/start   │                                 │
   ├───────────────────────────────►│ POST /device/code               │
   │                                ├────────────────────────────────►│
   │                                │◄────────────────────────────────┤
   │  { verification_uri,           │  device_code, user_code,         │
   │    verification_uri_complete,  │  verification_url, interval,     │
   │    user_code, interval,        │  expires_in                      │
   │    expires_in, poll_token }    │                                  │
   │◄───────────────────────────────┤  (stores device_code server-side, keyed by poll_token)
   │                                │                                 │
   │  [prints: "Open <uri> and enter <user_code>"]                    │
   │                                │   ┌─── human opens browser ──────┤
   │                                │   │    signs in to Google,       │
   │                                │   │    consents                  │
   │                                │   └──────────────────────────────┤
   │ POST /api/agent/device/token   │                                 │
   │  { poll_token }                │ POST /token (grant=device_code) │
   ├───────────────────────────────►├────────────────────────────────►│
   │  202 {status:"pending"}        │◄──── authorization_pending ──────┤
   │◄───────────────────────────────┤                                 │
   │        … waits `interval`s …   │                                 │
   │ POST /api/agent/device/token   │ POST /token                     │
   ├───────────────────────────────►├────────────────────────────────►│
   │                                │◄──── id_token + access_token ────┤
   │                                │ verify id_token vs jwks_uri,     │
   │                                │ aud, iss, exp, hd/email          │
   │                                │ upsert user + resolve perms (DB) │
   │                                │ MINT scoped short-lived JWT      │
   │  200 { api_key, token_type,    │                                 │
   │        expires_at, perms }     │                                 │
   │◄───────────────────────────────┤                                 │
   │                                                                  │
   │ POST /api/upload  Authorization: Bearer <api_key>                │
   │ PUT <signed GCS url>                                             │
   │ POST /api/upload/complete  Authorization: Bearer <api_key>       │
```

**Steps:**

1. **start** — `POST /api/agent/device/start`. App calls Google's `device_authorization_endpoint`
   with the agent client_id + scope (`openid email profile`). App stores `device_code` server-side
   keyed by an opaque `poll_token` it returns to the agent (so the agent never holds the raw
   `device_code` and we can rate-limit/track polling per session). Returns `verification_uri`,
   `verification_uri_complete`, `user_code`, `interval`, `expires_in`, `poll_token`.
2. **human** — agent prints the URL + `user_code`; a human opens it, authenticates with Google,
   consents. (`verification_uri_complete` embeds the code for one-click.)
3. **poll** — `POST /api/agent/device/token { poll_token }`. App exchanges the stored `device_code`
   at Google's `token_endpoint` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`).
   - `authorization_pending` → app returns `202 {status:"pending"}`.
   - `slow_down` → app increases the stored interval and returns `202 {status:"slow_down", interval}`.
   - `expired_token` / `access_denied` → app returns `400/403 {status:"expired"|"denied"}` and drops the session.
4. **mint** — on success, app **verifies the Google ID token** (signature against `jwks_uri`,
   `iss`, `aud` = agent client_id, `exp`, and `hd`/email domain), then resolves the app user and
   permissions exactly as UI login does, and mints a **short-lived scoped key** (§2). Returns
   `{ api_key, token_type:"Bearer", expires_at, permissions }`.
5. **use** — agent sends `Authorization: Bearer <api_key>` on `/api/upload` and
   `/api/upload/complete`. Bytes still PUT directly to the GCS signed URL.

## 2. Short-lived key representation — **Recommend: scoped JWT**

Mint a compact JWT signed by the app (HS256 with `AUTH_SECRET`, or a dedicated
`AGENT_KEY_SECRET`). Claims:

```jsonc
{
  "sub": "<app user id>",
  "username": "<email>",
  "permissions": ["upload"],   // resolved from DB at mint time
  "aud": "upload",             // SCOPE — see below
  "iss": "brushpass",
  "iat": <now>,
  "exp": <now + 5..15 min>,
  "jti": "<random>"            // enables optional denylist revocation
}
```

**Why JWT over an opaque DB token:**

| | **Scoped JWT (recommended)** | Opaque DB token |
|---|---|---|
| Storage | None — stateless, verify by signature | Hashed row (reuses `generateToken`/`hashToken` in `src/lib/token.ts`) |
| Revoke before expiry | Only via short TTL or a small `jti` denylist | Yes — delete the row |
| Per-request cost | Signature verify (cheap, no I/O) | DB lookup + bcrypt compare |
| Fit with codebase | Matches existing JWT session strategy (`session: { strategy: 'jwt' }`) | Matches existing download-token pattern |

Short TTL is the primary control; the JWT's statelessness suits a fleet of ephemeral agents. If
hard revocation becomes a requirement, add a `jti` denylist table checked only on the upload path
(small, TTL-pruned) — keeps the common case I/O-free.

**`aud: "upload"` scoping (important):** the upload Bearer-verification accepts a token **only if
`aud === "upload"`**. An admin user's agent key therefore *cannot* be replayed against
`/api/admin/*` even though `permissions` includes `admin` — admin routes don't accept this audience
at all. This decouples "who the user is" from "what this particular key may do," and is why we
don't simply reissue the full UI session JWT to the agent.

## 3. Code touch points (grounded in current files)

- **New routes:**
  - `src/app/api/agent/device/start/route.ts` — calls Google device endpoint, stores `device_code` by `poll_token`, returns user-facing fields. `runtime = 'nodejs'`.
  - `src/app/api/agent/device/token/route.ts` — polls Google `token_endpoint`, maps RFC 8628 statuses, verifies ID token, mints the scoped JWT.
  - Server-side device-session store: a small SQLite table (`agent_device_sessions`: `poll_token_hash`, `device_code`, `interval`, `expires_at`, `created_at`) via `src/lib/db.ts`, TTL-pruned by the existing cleanup path.
- **Accept `Authorization: Bearer` alongside the cookie** in:
  - `src/app/api/upload/route.ts` and `src/app/api/upload/complete/route.ts` — both currently do `const session = await auth(); const permissions = session?.user?.permissions ?? []`. Add: if a Bearer token is present and verifies (signature + `aud:"upload"` + `exp`), synthesize the same `{ user: { username, permissions } }` shape so downstream logic is unchanged.
  - `src/proxy.ts` — `requiresUpload()` gate (line ~146) is cookie-only via `req.auth`. Add a Bearer branch *before* the redirect-to-`/login` so an unauthenticated-cookie-but-valid-Bearer request is allowed for `/api/upload*`. Keep admin routes cookie-only (Bearer audience is `upload`, so they'd reject anyway — but don't even invite it).
  - Extract a small `resolveAuth(request)` helper (cookie-or-Bearer → `{ permissions, username }`) so the two upload routes and proxy share one implementation.
- **Reuse permission resolution at mint time:** `src/auth.ts` `jwtCallback` already does the canonical OIDC user handling — `upsertOidcUser(email, name, autoPermissions)` plus domain auto-promote (`AUTH_OIDC_ADMIN_DOMAIN` → `['upload','admin']`). Factor that block into a reusable `resolveOidcUserPermissions(idTokenClaims)` and call it both from `jwtCallback` and from the mint step, so an agent gets *exactly* the permissions it would get logging into the UI. No second source of truth.

## 4. Second Google client + config; PKCE fallback

**Second OAuth client.** Register a Google OAuth client of type **"TVs and Limited Input devices"**
for the agent flow. Keep the existing "Web application" client for UI login untouched. New env /
terraform vars (mirroring the existing `AUTH_OIDC_*` plumbing in `terraform/cloudrun.tf` /
`secrets.tf`):

- `AGENT_OIDC_CLIENT_ID` — limited-input device client id.
- `AGENT_OIDC_CLIENT_SECRET` — its secret (device clients still get one; stays server-side).
- `AGENT_KEY_TTL_SECONDS` — default `900` (15 min); clamp to a sane max.
- *(optional)* `AGENT_KEY_SECRET` — dedicated signing secret; defaults to `AUTH_SECRET`.

Reuse `AUTH_OIDC_ISSUER` (`https://accounts.google.com`) and discovery for the device/token/jwks
endpoints — don't hardcode the URLs; read them from the discovery document so a non-Google IdP
works unchanged if it advertises `device_authorization_endpoint`.

**PKCE-loopback fallback.** If the device endpoint is ever unavailable (IdP without device support,
or a Google policy change), fall back to **Authorization Code + PKCE with a loopback redirect**: the
agent opens `http://127.0.0.1:<port>/callback`, launches the browser to the app's authorize URL,
catches `?code=`, and the app exchanges it and mints the same scoped JWT. More universal IdP
support, but requires the agent to open a local browser + bind a port — strictly less general than
the device flow, so it's the fallback, not the default.

## 5. Security considerations

- **Short TTL is the primary control.** 5–15 min; agent re-runs the device flow on expiry. No
  refresh token is handed to the agent by default.
- **Audience scoping.** `aud:"upload"` is mandatory on the upload Bearer path; admin routes never
  accept it. Verify `iss`, `exp`, signature on every request.
- **ID-token verification at mint.** Validate Google's ID token against `jwks_uri` with `aud` =
  agent client_id, correct `iss`, unexpired, and enforce the email-domain check
  (`AUTH_OIDC_ADMIN_DOMAIN` / allowed domains) — don't trust `email_verified` alone.
- **Rate limiting.** Add `device_start` and `device_token` to the existing rate-limit categories in
  `src/proxy.ts` (it already rate-limits by IP). `device_token` especially — agents poll it in a
  loop; cap per `poll_token` and per IP.
- **Honor RFC 8628 polling semantics.** Respect Google's `interval`; on `slow_down`, increase it and
  tell the agent; treat `authorization_pending` as non-terminal; stop on `expired_token` /
  `access_denied`. Never poll Google faster than the advertised interval (the app enforces this even
  if a misbehaving agent polls the app aggressively).
- **`device_code` expiry & one-time use.** Drop the server-side device session on success, denial,
  or `expires_in`. Store only a hash of `poll_token`; never log `device_code`, `user_code`, or the
  minted `api_key`.
- **No refresh-to-agent (default).** If long agent sessions are needed, the *guarded* option is a
  refresh kept **server-side** keyed to the `poll_token` session, with the agent re-calling
  `/api/agent/device/token` to get a fresh short-lived key — the refresh token never leaves the app.
- **Revocation story.** Default: rely on short TTL. Optional hard kill: a `jti` denylist table
  checked on the upload path, plus "revoke all agent keys for user X" = bump a per-user
  `key_epoch` claim/counter so previously minted keys fail verification.
- **Logging parity.** Mirror the existing `[upload] phase=…` and `[auth] action=…` structured logs
  for `device-start`, `device-poll`, and `mint` (result + username, never secrets).

## Decision summary

1. **Use the brokered Device Authorization Grant** — app holds the secret, agent never does. ✅ verified supported.
2. **Mint a scoped JWT** (`aud:"upload"`, 5–15 min), not an opaque DB token — stateless, matches the existing JWT session model; add a `jti` denylist only if hard revocation is required.
3. **Add a shared `resolveAuth` (cookie-or-Bearer) helper**; touch the two upload routes + `proxy.ts` only; reuse `jwtCallback`'s permission logic for minting.
4. **Register a second Google "limited input" client**; read endpoints from discovery; keep PKCE-loopback as the documented fallback.
5. **Short TTL + audience scope + rate-limited polling** are the load-bearing security controls; no refresh token reaches the agent by default.

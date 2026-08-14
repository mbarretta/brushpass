# Brushpass Security Review — 2026-08-12

Full-project security review of the file-transfer app (Next.js 16 + GCS + SQLite on Cloud Run).
Goal framing: *highly secure and simple file transfer*.

Method: five parallel focused reviews (auth/session, upload-download data path, admin/API
authorization, infra/CI-CD, dependencies/config), each required to quote code. Findings below were
then re-verified directly — several against the **live production service** and the local
Terraform state. Test baseline at review time: 284 tests / 26 files, all passing.

Verification legend: **[live]** reproduced against the deployed service, **[code]** confirmed by
reading the implementation, **[local]** reproduced against a local dev instance by a reviewer.

---

## Critical

### C1. `/api/upload/complete` stores a client-supplied `gcsKey`, enabling arbitrary object reads from the bucket
`src/app/api/upload/complete/route.ts:31-63` **[code]**

`gcsKey` arrives in the request body and is checked only for presence, then written straight to
`gcs_key`:

```ts
const { sha256, gcsKey, filename, contentType, size, ... } = body;
if (!gcsKey || !filename || !contentType || size == null) { ... }   // presence only
const record = insertFile({ filename: gcsKey, ..., gcs_key: gcsKey, token_hash: tokenHash, ... });
```

`src/app/api/download/[sha256]/route.ts:71-75` later signs `record.gcs_key` with no validation, and
the app service account holds `roles/storage.objectAdmin` on the entire file bucket
(`terraform/iam.tf:13-25`). A reviewer reproduced the full path locally with a minted agent key:
posting `{"gcsKey":"../../other/secret.pdf","sha256":"cccc…"}` returned `200` with a download token,
and the download route walked all the way to signing that attacker-chosen object.

Anyone with `upload` permission — including a 15-minute agent key — can register any object name in
the bucket under a digest of their choosing and then download it with their own token. The
`gcs_key UNIQUE` constraint only blocks keys already tracked in the database, so every untracked
object is reachable. The same request also demonstrated that `contentType` gets no validation here
(unlike prepare) and `size` accepts negative values.

**Fix:** never accept `gcsKey` from the client. Re-derive it server-side as `${sha256}.${ext}` with a
whitelisted extension, or have `/api/upload` return an HMAC over `{sha256, gcsKey, contentType, size}`
that `complete` must present back. Also validate `contentType`/`size` at complete, and confirm the
object exists via `getMetadata()` before inserting.

### C2. Public group pages leak bcrypt token hashes and the full file inventory to anonymous visitors
`src/app/g/[slug]/page.tsx:23,45`, `src/app/g/[slug]/GroupPage.tsx:22-27`, `src/lib/db.ts:696-711` **[code]** **[local]**

`getGroupWithFiles` uses `SELECT * FROM file_groups` and `SELECT f.* FROM files f`, so the returned
object carries `token_hash` for the group and for every member file (both are declared fields on
`FileGroup` and `FileRecord` in `src/types.ts:11,46`), plus `gcs_key`, `original_name`, `size` and
`uploaded_by`. That whole object is handed to `GroupPage`, which is a `'use client'` component, so
Next serializes it into the RSC flight payload embedded in the HTML. `/g/*` is public by design
(`src/proxy.ts:97`).

Two reviewers independently confirmed this, one by seeding a throwaway group locally and curling the
page with no cookie and no token: the group's `token_hash`, the file's `token_hash`, `gcs_key`,
`original_name`, `size` and `uploaded_by` all appeared in the initial HTML.

Compounding it, the token gate is client-side only — `handleSubmit` calls `setSubmitted(true)`
without ever verifying the token server-side, so the listing was never actually protected. Group
slugs are slugified from human-chosen names (`AdminGroupNew.tsx:16-18`) and `/g/*` has no
rate-limit category, so the namespace is enumerable.

Note the codebase already knows this rule — `src/app/admin/files/[id]/page.tsx:78` carries the
comment `// Destructure token_hash out — never render it`. The public page is the one place it wasn't
applied.

**Fix:** give `getGroupWithFiles` an explicit column list (as `listFiles` at `db.ts:278-294` already
does) and map to a public DTO before rendering. Make the gate real: POST the token to a route that
bcrypt-compares it and only then returns the listing.

---

## High

### H1. The hourly cleanup job has never run; expired files are never deleted
`src/proxy.ts:71-101,153-167`, `src/app/api/cleanup/route.ts`, `terraform/scheduler.tf:31` **[live]**

`/api/cleanup` is absent from `isPublicRoute`, and `bearerAllowedPath` permits only `/api/upload*`,
so a request with no cookie session is redirected before the route's own authentication runs. Cloud
Scheduler calls exactly that path with an OIDC bearer token and no cookie. Verified against
production:

```
curl -H "Authorization: Bearer …" https://…/api/cleanup
→ 307  Location: /login?callbackUrl=%2Fapi%2Fcleanup
```

The Cloud Scheduler job confirms it: `gcloud scheduler jobs describe fileshare-cleanup` reports
`lastAttemptTime 2026-08-12T15:00:24Z` with `code=5`. The route's careful OIDC verification and
`timingSafeEqual` secret comparison are unreachable code.

Consequence: every file with an `expires_at` stays in GCS and in SQLite forever. Downloads are still
blocked by the expiry check at `download/[sha256]/route.ts:39-42`, so this is a retention and
blast-radius failure rather than direct exposure — but the app tells users data is deleted on expiry
and it is not, and C1/H4 both widen the reach of retained objects.

**Fix:** let `/api/cleanup` reach its handler (it authenticates itself), or run cleanup as a Cloud Run
job with no HTTP surface. Two related defects in the same route: the SA identity check fails **open**
(`if (SCHEDULER_SA && payload.email !== SCHEDULER_SA)` — an unset variable disables it), and a GCS
404 throws, so the row is retried hourly forever. Also wire in `getExpiredDeviceSessions`, which
exists in `db.ts` but has no production caller.

### H2. Admin access is never revalidated, so demotion and deletion do not revoke it
`src/auth.ts:129,154`, `src/lib/admin-auth.ts:7-10` **[code]**

`permissions` is written into the JWT once at sign-in; the refresh path is `if (!user && !account)
return token`. No `session.maxAge` is set, so the Auth.js default of 30 days applies, and the proxy
re-issues the cookie on every request it handles, making it a rolling window that never closes for an
active holder. `getIsAdmin()` reads the claim, not the database. `deleteUser` and `updateUser` touch
only the database.

So an admin who is demoted or whose account is deleted keeps full admin — listing users, deleting
files, minting signed download URLs for any file — for up to 30 days. The app acknowledges the
symptom rather than the cause: the approve endpoint returns *"Sign out and back in to activate new
permissions"* (`approve/route.ts:39`). The inconsistency is visible in-repo — `/api/account/route.ts:18-22`
does re-load the user and 404s when the row is gone; no admin route does.

**Fix:** make `getIsAdmin` (and the upload equivalent) authoritative against the database: load the
user by `session.user.id`, treat a missing row as unauthenticated, and read permissions from the row.
Add a `token_version` column bumped on permission change, password change and delete, compared in the
JWT callback. Set an explicit short `session.maxAge`.

### H3. Password brute-force is effectively unlimited — the login rate limit guards a path the login never uses
`src/proxy.ts:51`, `src/app/login/actions.ts:14`, `node_modules/next-auth/lib/actions.js` **[code]**

The only brute-force control is `if (pathname === '/api/auth/callback/credentials') return 'login'`.
But the UI login is a server action calling `signIn('credentials', …)`, and next-auth executes that
in-process — verified in the installed source:

```js
const req = new Request(url, { method: "POST", headers, body });
const res = await Auth(req, { ...config, raw, skipCSRFCheck });
```

That synthetic `Request` never touches the network, so the proxy only ever sees `POST /login`, which
`isPublicRoute` waves through with no rate-limit category. The 10/min cap is dead code for the real
login path, and `authorize()` has no lockout or backoff of its own. Two reviewers found this
independently.

**Fix:** enforce failed-attempt throttling inside `authorize()` in `src/auth.ts`, keyed on username
and IP — the one place every credential path passes through — so it holds regardless of transport.

### H4. Every rate limit is bypassable by spoofing `X-Forwarded-For`
`src/proxy.ts:24-30` **[local]**

The limiter keys on the leftmost XFF entry, which is client-supplied — Google's front end *appends*
the real client IP rather than replacing the header. A reviewer confirmed empirically: 12 rapid
credential POSTs with a rotating `X-Forwarded-For` produced twelve `302`s and no throttling, while
the same 12 with a fixed value produced `429` on the 11th.

This defeats all five categories (`login`, `download`, `account`, `device_start`, `device_token`) and
also lets an attacker grow `rateLimitStore` without bound between sweeps. Three reviewers flagged it.

**Fix:** count back from the right-hand side of XFF by the known number of trusted proxy hops rather
than taking `[0]`, and cap distinct keys per window.

### H5. OIDC auto-promotes to admin on an unverified email claim, parsed incorrectly
`src/auth.ts:92-96` **[code]**

```ts
const email = claims.email ?? '';
const domain = email.split('@')[1] ?? '';
const autoPromote = adminDomain !== '' && domain === adminDomain;
const autoPermissions: Permission[] = autoPromote ? ['upload', 'admin'] : [];
```

Two defects. There is no `email_verified` check and no use of Google's `hd` hosted-domain claim, so
any IdP that emits a self-asserted email grants `['upload','admin']` on first login. And
`split('@')[1]` takes the *second* field rather than the text after the last `@`, so an email claim of
`victim@example.com@attacker.io` resolves to `example.com` and auto-promotes.

The device-grant route already gets this right — `device/token/route.ts:278` requires
`email_verified === true` and `:284` accepts `hd` — and its comment claims it "Mirrors the UI-login
trust boundary." In reality the UI boundary is the weaker of the two.

**Fix:** require `email_verified === true`, derive the domain with `lastIndexOf('@')`, prefer the `hd`
claim for Google, and pass the full verified claim set into the shared helper so both callers use one
gate. Consider auto-granting only `upload`.

### H6. Terraform state is local and holds every production secret in plaintext
`terraform/main.tf:19` **[code]**

The backend is `local` with the GCS backend commented out, and `terraform/secrets.tf:1-3` explicitly
assumes a GCS backend exists. Five state files sit on the laptop. Inspecting `terraform.tfstate`
confirmed plaintext values present for `AUTH_SECRET` (32 chars), `CLEANUP_SECRET` (32),
`agent_oidc_client_secret` (35), `agent_oidc_client_id`, and the bootstrap `admin_pass` (22) —
both as `random_password.result` and as `google_secret_manager_secret_version.secret_data`.

**Fix:** create the state bucket with UBLA, versioning and tight IAM; enable the `gcs` backend;
`terraform init -migrate-state`; shred the local files; rotate everything that passed through them.

### H7. A public repo, no required reviews, and an over-broad octo-sts policy let any main-branch workflow ship to production
`.github/chainguard/digestabot.sts.yaml:5-10`, `terraform/wif.tf:28` **[live]**

Verified: `mbarretta/brushpass` is **PUBLIC**, and `main` requires only the `docker-build` status
check — `required_pull_request_reviews: null`, `enforce_admins: false`.

The octo-sts policy grants `contents: write` and `pull_requests: write` to
`subject: repo:mbarretta/brushpass:ref:refs/heads/main` with no `workflow_ref` restriction, so it
matches the OIDC token of *every* workflow at that ref — including `claude.yml`, which holds
`id-token: write`, is triggered by issue and PR comments containing `@claude`, and feeds untrusted
text into an LLM. The GCP side has the same gap: `wif.tf:28` conditions only on repository and ref,
so any main-ref workflow can impersonate `github-deployer` (Artifact Registry writer, `run.developer`,
`actAs` on the runtime SA).

Chain: compromise or prompt-inject any main-ref workflow, mint a repo-scoped token, open and merge a
PR (no review required), and the deploy workflow ships arbitrary code to Cloud Run. Or skip GitHub
entirely and push an image via WIF.

Aggravating: `claude.yml:29,35` and `claude-code-review.yml:30,36,42` use floating `@v1`/`@v4` tags
and an unpinned plugin marketplace, while `deploy.yml`, `ci.yml` and `update-digests.yml` correctly
pin every action to a full SHA. These two are precisely the workflows holding
`secrets.ANTHROPIC_API_KEY` and `id-token: write`.

**Fix:** add a `claim_pattern` pinning `workflow_ref` to `update-digests.yml@refs/heads/main`; extend
the WIF `attribute_condition` to require `deploy.yml@refs/heads/main`; require PR reviews on `main`;
pin the Claude actions to SHAs and add an explicit `author_association` actor guard.

---

## Medium

### M1. Appending `.png` to any path skips the proxy entirely
`src/proxy.ts:196-207` **[live]**

The matcher's negative lookahead excludes anything ending in an image extension, and the route
handlers coerce ids with `parseInt`, so `parseInt('1.png', 10) === 1`. Verified in production:

```
/api/admin/files/1      → 307 → /login          (proxy ran)
/api/admin/files/1.png  → 403 Forbidden          (proxy skipped; handler answered)
```

The bypassed path returns **none** of the four security headers, while `/download` returns all four.
Blast radius is contained today only because every admin handler re-checks `getIsAdmin()` — the loss
is the rate limiter, the header hardening and the whole proxy control. Any future route that trusts
the proxy alone would be open.

**Fix:** narrow the lookahead to real static prefixes (`/_next/…`, `/favicon.ico`), and validate ids
with `/^\d+$/` before `Number(id)` so `1.png` is a 400.

### M2. The permission-request flow lets requesters choose their own grant
`src/app/api/permission-requests/route.ts:22-29`, `admin/permission-requests/[id]/approve/route.ts:35-36` **[code]**

Any authenticated session may request `admin`, and the approve endpoint takes no body — it reads the
requester-controlled row and applies it verbatim with `UPDATE users SET permissions = ?`. Since
`resolveOidcUserPermissions` self-provisions any authenticated identity with no allowlist, any SSO
account can submit `{"permissions":["admin"]}`, appear as an ordinary pending row, and become admin on
one mis-click. The overwrite also cuts the other way: approving a request for `["upload"]` against an
existing admin silently strips `admin`.

**Fix:** have approve take an explicit admin-supplied permissions array, merge rather than replace,
require a distinct confirmation for `admin`, and log the approver.

### M3. The SHA-256 address is never verified server-side
`src/lib/sha256.ts:14`, `src/app/api/upload/route.ts:35-75` **[code]**

The hash is computed in the browser and taken on faith. `computeSHA256AndStream` — the only
server-side hashing helper — has zero callers (confirmed by grep across `src/`, `tests/`, `scripts/`),
and `busboy` is a declared production dependency with no imports at all. Nothing compares stored
bytes to the claimed digest, and nothing verifies the object was ever uploaded.

So an uploader can PUT content *X* and register it under the digest of trusted artifact *Y*, or skip
the PUT entirely (C1 created a record with no upload). Since `/<sha256>` is the app's central premise,
this makes content-addressability an unenforced client assertion. It also lets an attacker reserve a
digest they don't hold, poisoning future dedup for it.

**Fix:** verify the object at complete via `getMetadata()` and compare GCS's stored digest, or bind
integrity into the signed URL as an extension header. If you'd rather not enforce it, delete the dead
helper and `busboy` and stop presenting the digest as integrity.

### M4. The signed upload URL enforces no size limit
`src/app/api/upload/route.ts:41-44`, `src/lib/gcs.ts:71-83` **[code]**

The 10 GB cap is validated against the *claimed* size, then the signed PUT URL is issued with no
`x-goog-content-length-range`. An uploader declares `size: 1024` and writes terabytes; `complete`
never checks the real size. `/api/upload` also has no rate-limit category, so signed URLs can be
minted in a loop. Unbounded storage cost on the owner's bill, and admin quota views are
attacker-authored.

**Fix:** pass `extensionHeaders: { 'x-goog-content-length-range': '0,<max>' }`, require the client to
send the matching header, add a rate-limit category for `/api/upload`, and verify real size at complete.

### M5. Group downloads ignore per-file expiry
`src/app/api/groups/[slug]/files/[sha256]/route.ts:38-60` **[local]**

The route checks `group.expires_at` but never consults `file.expires_at`. A reviewer confirmed: with
file expiry one hour in the past and no group expiry, the group route reached signing while
`/api/download/<sha>` correctly returned 410. A 24-hour file added to a long-lived group stays
downloadable indefinitely — and H1 guarantees the object still exists.

**Fix:** apply the same per-file expiry check after the membership lookup.

### M6. The group download route is unthrottled and does a bcrypt compare per request
`src/proxy.ts:50-57`, `groups/[slug]/files/[sha256]/route.ts:44`, `terraform/cloudrun.tf:13-16` **[code]**

`/api/groups/*` is public but has no rate-limit category, and each request costs a pure-JS bcryptjs
comparison at cost 10 on a service pinned to `min = max = 1` instance. That is both unlimited online
guessing of the group token and a cheap CPU-exhaustion DoS that starves logins and uploads. C2 hands
an attacker the slug and hash to work with.

**Fix:** add a category for `/api/groups/`; for high-volume capability checks prefer a SHA-256 +
`timingSafeEqual` lookup over bcrypt (bcrypt buys nothing against 256-bit random tokens, and
`verifyPassword` is currently a bare alias of `verifyToken`, so the two cannot be tuned separately).

### M7. Download tokens travel in query strings and land in Cloud Logging
`src/app/[sha256]/page.tsx:22-24` **[code]**

The page redirects to `/api/download/<sha>?token=…`. Cloud Run and GFE access logs record the full
`requestUrl`, so every file capability token is written in cleartext to Cloud Logging, retained per
project policy and readable by anyone with `logging.viewer` — plus browser history. The group route's
own comment (`route.ts:21-22`) says the header form exists precisely to avoid this, but the
single-file path still uses the query string.

**Fix:** POST the token and set a short-lived path-scoped cookie, or return the signed URL to `fetch`.

### M8. No Content-Security-Policy and no HSTS anywhere; headers missing on error paths
`src/proxy.ts:137-142` **[live]**

A repo-wide search found only four security headers, all set in the proxy. `next.config.ts` has no
`headers()` block, Terraform sets none, and there is no external HTTPS load balancer. Next 16's own
guide expects CSP to be added in `proxy.ts` — the file the app already owns. The headers are also
attached only to the three `NextResponse.next()` paths, so the `/login` redirect, both 403s and the
429 ship bare (confirmed live on the `.png` path above).

**Fix:** build the header set once and apply it to every response including redirects and errors; add
HSTS and a CSP (report-only first, given Next's inline bootstrap). Also set `poweredByHeader: false`
and `experimental: { proxyClientMaxBodySize: '64kb' }` — because `proxy.ts` exists, Next buffers every
request body with a 10 MB default.

### M9. Over-broad GCP IAM on the app service account
`terraform/iam.tf:46-50` **[code]**

`roles/secretmanager.secretAccessor` is bound at **project** level in `pubsec-se`, a shared project,
rather than per-secret. Any app-level RCE reads every secret in the project, including ones teammates
add later. The same file grants `objectAdmin` on the whole file bucket, which is what gives C1 its
reach.

**Fix:** replace with per-secret `google_secret_manager_secret_iam_member` bindings on the seven
`fileshare-*` secrets.

### M10. Pre-authentication existence and expiry oracle
`src/app/api/download/[sha256]/route.ts:32-48` **[local]**

The route answers `404 db-lookup` for unknown digests, `410 expiry-check` for expired ones, and only
then `401 token-extract` — all with no credential, and with a machine-readable `phase` discriminator.
An attacker who can hash a candidate document confirms whether this organization ever transferred that
exact file and whether the link is live.

**Fix:** return an indistinguishable 404 for missing, expired and bad-token, and drop `phase` from
unauthenticated responses.

### M11. Upload routes return raw internal error messages
`src/app/api/upload/route.ts:84-88`, `upload/complete/route.ts:73-77` **[code]**

`{ error: message }` echoes the exception, unlike every admin route which returns a constant. This
surfaces GCS signer details, service-account emails, IAM denials and SQLite constraint text
(`UNIQUE constraint failed: files.sha256`) to any upload-capable actor. Prepare-to-complete is also
not atomic, so concurrent completes for the same digest give the loser a raw SQLite error instead of
the collision response.

**Fix:** log the message, return a fixed string, and handle the unique-constraint case as a collision.

### M12. Weak password handling on admin-managed accounts
`src/app/api/admin/users/route.ts:43-62`, `users/[id]/route.ts:69-82`, `src/lib/token.ts:8-20` **[code]**

The admin create and reset paths validate only `typeof password === 'string'`, so a one-character
admin password is accepted — while self-service `/api/account:54` requires 8. bcrypt cost is 10
(below current guidance of 12–13) and inputs are silently truncated at 72 bytes. No bounds on
`username`, no email format validation. Separately, admin PATCH will set a local password on an `oidc`
account, creating a credential that bypasses the IdP and its MFA and deprovisioning — and which the
user cannot rotate, because `/api/account` refuses password changes for non-credentials accounts.

**Fix:** one shared validator across all three routes (min 12, max 128, bounded username, validated
email); raise password cost to ≥12; reject `password` in PATCH when `auth_provider !== 'credentials'`.

### M13. Admin group endpoints return bcrypt token hashes
`admin/groups/route.ts:18-21`, `admin/groups/[slug]/route.ts:21-27` **[code]**

`return Response.json({ ...group, files })` includes `token_hash` for the group and every file. Every
sibling route strips it deliberately (`const { token_hash: _th, ...safe }`). Same defect class as C2,
one authorization level up.

**Fix:** strip secrets in the data-access layer so no caller can leak them.

### M14. CI does not run the tests, and the only required check is a Docker build
`.github/workflows/ci.yml` **[code]**

The workflow's single substantive step is `docker build -t brushpass:ci .`. The 284-test vitest suite —
which includes the authorization tests — and `npm run lint` never gate a PR, and `docker-build` is the
sole required status check on `main`. Combined with H7 (no required reviews), nothing verifies
behavior before code reaches production.

**Fix:** add `npm test` and `npm run lint` as required checks.

### M15. Dependency posture
**[live]**

`npm audit` cannot run against the configured Chainguard Libraries registry (`Unable to authenticate`),
so there is no working advisory check in-tree. Against the public registry: **16 vulnerabilities
(2 critical, 8 high)**. The relevant ones:

| Package | Installed | Issue |
|---|---|---|
| `@auth/core` (via `next-auth`) | ≤0.41.2 | **Critical** — OAuth state/nonce/PKCE cookies not bound to the issuing provider; `getToken()` uncaught exception on malformed Bearer headers; homoglyph `@` bypass in email normalization |
| `next` | 16.2.5 | **High** — proxy/middleware bypass via segment-prefetch routes; SSRF in Server Actions; cache confusion on request bodies; unauthenticated disclosure of internal Server Function endpoints |
| `@google-cloud/storage` | — | Moderate, transitive `uuid` bounds check |

The middleware-bypass advisory is directly relevant given M1. Also: `next-auth` is declared as
`^5.0.0-beta.30`, a caret on a pre-release, so any future beta is accepted — and the lock has already
drifted to `5.0.0-beta.31` while `README.md:32` still advertises beta.30 as an exact pinned version.
`google-auth-library` is imported by `/api/cleanup` but **not declared** in `package.json`; it resolves
only transitively through `@google-cloud/storage`, which itself sits on a caret range. That makes the
authorization gate of a bulk-deletion endpoint dependent on another package's transitive tree.

**Fix:** upgrade `next-auth` and `next`; pin `next-auth` exactly; declare `google-auth-library`;
correct the README table; run `npm audit` against the public registry (or Grype on the built image) on
a schedule.

### M16. `AUTH_URL` is patched outside Terraform, and any `apply.sh` run silently weakens cleanup auth
`terraform/deploy.sh:79-86`, `src/app/api/cleanup/route.ts:10` **[code]**

`AUTH_URL` is set by a post-apply `gcloud run services update` and is absent from `cloudrun.tf`, so an
infra-only `./apply.sh` deploys a revision without it. `OIDC_AUDIENCE` then falls back to `''`, and
`google-auth-library` skips audience validation on a falsy value — so a routine apply breaks login
callbacks and quietly downgrades the cleanup endpoint's authentication.

**Fix:** declare `AUTH_URL` in `cloudrun.tf` (or use the custom domain), and make the cleanup route
refuse to start with an empty audience.

---

## Low

- **`GET /logout` mutates state** (`logout/route.ts:3-5`). Any cross-site top-level navigation or
  link-scanning bot ends a user's session; Lax cookies are sent on top-level navigations. Make it POST.
- **No CSRF defense on JSON route handlers.** Next's Origin/Host check applies to Server Actions only;
  these cookie-authenticated routes rely entirely on the Auth.js `sameSite: "lax"` default, which is
  never asserted in `src/auth.ts`. Add an explicit `assertSameOrigin` to every non-GET handler.
- **`foreign_keys` pragma is off** in `getDb()` (`db.ts:181-199`), so `ON DELETE CASCADE` never fires
  and `deleteFile` orphans `download_logs` and `file_group_members` rows.
- **`isValidSha256` is case-insensitive but SQLite lookups are not** (`sha256.ts:4-6`), so an uppercase
  digest misses the dedup check and creates a second object and token for identical content. Lowercase
  after validation.
- **Malformed expiry input is silently coerced, not rejected** (`admin/groups/[slug]/route.ts:76-78`).
  `{"expires_at":"2027-01-01"}` returns `{"ok":true}` while *clearing* the expiry — a link meant to
  lapse now lives forever, with positive confirmation to the operator.
- **`PATCH /api/admin/users/[id]` returns `{ok:true}` for nonexistent users** and has no last-admin or
  self-demotion guard, so an admin can lock the deployment out of `/admin` irrecoverably.
- **OIDC `username` comes from the IdP display name** (`db.ts:490-505`). A collision with an existing
  local username makes `INSERT OR IGNORE` a no-op and the subsequent lookup throws, permanently 500ing
  that user's login. Derive `username` from `email`.
- **`scripts/seed-user.ts:24-37` hardcodes `admin/adminpass`** and its `ON CONFLICT` clause *overwrites*
  an existing admin's password rather than skipping (unlike `bootstrap-admin.js`, which correctly
  skips). One run against a real `DATABASE_PATH` installs known credentials. Gate on `NODE_ENV` and use
  `DO NOTHING`.
- **Group downloads are not audit-logged** — only `/api/download/[sha256]` calls `logDownload`, so
  `download_count` under-reports group traffic during an incident review.
- **Group route returns GCS error bodies as file content** — `gcsRes.ok` is never checked, so a 403/404
  XML error is delivered as a `200` download under the real filename.
- **No entropy floor on `AGENT_KEY_SECRET`** (`agent-key.ts:74-80`); only non-emptiness is checked, and
  jose will sign HS256 with a 3-byte key. The `AUTH_SECRET` fallback is *not* a key-confusion flaw
  (next-auth HKDF-derives its JWE key with a salt) but does couple rotation of the two surfaces.
  Reject secrets under 32 bytes at startup.
- **Runtime image ships devDependencies and sets no explicit `USER`.** The Dockerfile's builder stage
  sets `USER 65532`, but the runner stage (lines 17-29) has no `USER` directive and relies on the
  Chainguard base image's default. `npm ci` installs dev deps and line 20 copies the whole
  `node_modules`, so vitest/eslint/typescript ship to production. Add `USER 65532` and use
  `output: "standalone"` or a prod-deps-only stage. `docker-entrypoint.sh` is dead code — `CMD` never
  invokes it.
- **Production bucket CORS permanently allows `http://localhost:3000`** (`storage.tf:40`).
- **Digest bumps auto-merge and auto-deploy** (`update-digests.yml:47`) with only `docker-build` as the
  gate — a new base-image digest reaches production with no human review.
- **Terraform pins the service to mutable `:latest`** while CI deploys immutable SHA tags, so the next
  `terraform apply` resets the service to whatever `:latest` last was.
- **`common.sh:47-49` blanket-exports every `.env` variable** into the environment of terraform, gcloud
  and docker buildx via `set -a; source`. Export only the six keys that are needed. (Positively: no
  `set -x` and no `echo` of secret values anywhere.)
- **`deploy.sh:73` runs `terraform apply -auto-approve`** with no plan review.
- **Rate-limit state lives in module globals**, which the Next 16 proxy docs explicitly warn against.
  It works only because `max_instance_count = 1`; that coupling is enforced by a comment. Tie it to the
  Terraform setting explicitly.
- **`/api/agent/device/start` is world-reachable**, so anyone can mint a live device-authorization
  request and phish an admin-domain employee into approving it, then poll for the upload key. Rows in
  `agent_device_sessions` are also never pruned (`getExpiredDeviceSessions` has no production caller).
  Consider a bootstrap credential on start.
- **`scripts/recover-orphaned-files.ts:53-85` registers every untracked object** in the (possibly
  shared) bucket with a fresh download token and derives `sha256` from the filename rather than the
  content. Restrict to `^[a-f0-9]{64}\.[a-z0-9]+$` and verify by streaming.
- **The login page's SSO button can appear when SSO cannot work.** `login/page.tsx:16` checks only
  `AUTH_OIDC_ISSUER`, while `auth.ts:46` requires all three variables. In the documented
  agent-key-only deployment the button renders but no provider is registered. Export the authoritative
  flag from `src/auth.ts`.

---

## What is genuinely well built

Worth preserving through any remediation:

1. **The agent upload-key design is tight.** `src/lib/agent-key.ts` pins `algorithms: ['HS256']` (no
   alg confusion), pins issuer *and* `audience: 'upload'`, then re-checks `aud`/`sub`/`username`/
   `permissions`/`iat`/`exp`/`jti` shapes after verification; TTL is clamped to `[60, 900]`; `jti` uses
   `crypto.getRandomValues`; a missing secret returns `null` rather than 500ing. Because
   `bearerAllowedPath` confines Bearer auth to `/api/upload*`, an agent key carrying `admin` still
   cannot touch any admin route. The audience scoping is real, not decorative.
2. **The device grant verifies before it trusts.** The `device_code` never leaves the server — the agent
   gets a 256-bit opaque `poll_token` stored as a SHA-256. The ID token is verified against the
   *discovered* JWKS with issuer and audience pinned before any claim is read, `email_verified` is
   required, the session is deleted on every terminal path so a poll token cannot mint twice, and all
   four RFC 8628 statuses are handled with server-side interval enforcement. No secret, key or device
   code is logged in either route.
3. **Authorization is defense-in-depth, not proxy-dependent.** All 15 admin handler methods open with
   `if (!(await getIsAdmin())) return 403`, and the admin layout and each page repeat the check —
   verified by enumerating every route file. This is exactly why M1 is a hardening loss rather than an
   authz bypass.
4. **No SQL injection anywhere.** Every query in `db.ts` is a parameterized prepared statement, and the
   two dynamic UPDATE builders assemble fragments from hardcoded column literals while binding all
   values. `permissions` is validated against a whitelist before serialization.
5. **Signed download URLs neutralize the stored-XSS class.** `gcs.ts:55-61` forces
   `responseDisposition: attachment` with a percent-encoded filename plus `filename*=UTF-8''…` and a
   900-second TTL — so even though `original_name` and `content_type` are attacker-controlled, there is
   no CRLF header injection and no in-browser rendering of HTML payloads.
6. **Repo hygiene and secret plumbing.** All secrets reach Cloud Run through
   `value_source.secret_key_ref`, never as literal env values. Base images are digest-pinned. A
   full-history scan for `GOCSPX-`, API keys, private keys and GitHub/Slack/Anthropic tokens came back
   empty, and `.env`, `terraform.tfvars`, `terraform.tfstate*` and `data/*.db` are all untracked. Both
   buckets have UBLA and `prevent_destroy` with no public IAM binding. `ci.yml` uses `pull_request`,
   not `pull_request_target`.
7. **No dangerous primitives.** Zero `dangerouslySetInnerHTML`, `eval`, `new Function`,
   `child_process`, `Math.random` for security, or disabled TLS checks across `src/`. The three crypto
   libraries each have a distinct justification (`@noble/hashes` for incremental client-side hashing,
   `node:crypto` server-side, `jose` for the proxy runtime). `cleanup/route.ts:38-43` does the length
   check *before* `timingSafeEqual`, which is the correct order.

---

## Suggested order

**Now (exposure):** C1 (server-derive `gcsKey`), C2 (column projection + server-side group gate).
Both are small, contained diffs.

**This week:** H1 (cleanup unreachable — data is being retained against policy right now), H2
(DB-authoritative admin checks), H3+H4 (move throttling into `authorize()`, fix the client IP), H5
(`email_verified` + domain parsing), H6 (state to GCS, rotate), H7 (octo-sts and WIF claim pinning,
required reviews, pin the Claude actions).

**Then:** M1 (matcher), M2 (approval policy), M3/M4 (integrity and size enforcement), M14/M15 (tests
in CI, dependency upgrades — the `@auth/core` advisories are critical and the `next` proxy-bypass
advisory compounds M1), then the remaining mediums.

**Simplification opportunities**, since simplicity is a stated goal — each of these is dead code that
currently reads as a security control: `computeSHA256AndStream` and the `busboy` dependency (M3),
`streamToGCS`/`getGCSReadStream`/`renameInGCS`, `docker-entrypoint.sh`, `resolveExpiry` in
`upload/route.ts:50-55` (silently ignores `expires_in`), the unreachable OIDC verification in
`/api/cleanup` (H1), the `login` rate-limit category (H3), and `getExpiredDeviceSessions`. Deleting
them shrinks the reviewable surface and removes the false impression that these protections are active.

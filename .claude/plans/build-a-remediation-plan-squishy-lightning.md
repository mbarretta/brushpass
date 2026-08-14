# Brushpass Security Remediation Plan

## Context

A full security review (`.claude/plans/security-review-2026-08-12.md`) found 2 critical, 7 high and
16 medium issues in this file-transfer app. Two are live exposure: any `upload`-capable actor can
read arbitrary objects from the GCS bucket, and any anonymous visitor to a `/g/<slug>` page receives
the bcrypt token hashes for the group and every file in it. Two controls that look active are in fact
dead: the hourly cleanup job has never run (verified in production — the Cloud Scheduler job fails
with `code=5` and the endpoint 307s to `/login`), and the login rate limiter guards a URL the login
flow never requests. Every production secret currently sits in plaintext in local Terraform state.

**Outcome:** close the exposure, make the dead controls real, move state and rotate secrets, and
narrow the CI/CD trust boundary — while preserving the things the review found genuinely well built
(the audience-scoped agent key design, the self-verifying device grant, handler-level admin checks,
parameterized SQL, attachment-forcing signed URLs).

**Decisions taken by the owner:** one comprehensive branch; migrate state then rotate all secrets;
upgrade both `next` and `next-auth`; the pre-token group page shows the group name only.

### Two corrections to the review, verified during planning

1. **Next.js needs 16.2.11, not 16.3.0.** The GitHub Advisory DB gives `firstPatchedVersion: 16.2.11`
   for every open `next` advisory (`npm audit`'s 16.3.0 suggestion was its resolver, not the minimum).
   Take **16.2.12** — a same-minor patch, so `AGENTS.md`'s "this is not the Next.js you know" warning
   barely applies and `eslint-config-next` stays in lockstep. Also verified: the
   middleware/proxy-bypass advisory (GHSA-6gpp-xcg3-4w24) requires a Turbopack build with exactly one
   `i18n` locale; this app builds with `--webpack` and sets no `i18n`, so it is **not** exposed today.
2. **Do NOT enable required PR reviews.** `mbarretta` is the sole collaborator and GitHub forbids
   self-approval, so requiring one approval would permanently block both the owner and digestabot's
   auto-merge. Use `enforce_admins: true` plus required status checks instead.

Also confirmed while planning: Dependabot is already enabled and reporting **39 open alerts** that
nobody is reading, while `automated-security-fixes` is `{"enabled": false}`. The durable fix for
dependency scanning is to turn on what already exists, not to build an `npm audit` workflow.

---

## Approach

One branch, `security/remediation`, with the phases below as separate commits so a regression is
bisectable. Phases 1–6 are code and land together. Phases 7–10 are operational (Terraform, GitHub,
Google Cloud Console) and are executed in order after the code merges.

Three new modules absorb duplication that already exists ≥3× and is itself the bug; no new
dependencies, and **no DB migration is required** by anything here.

| New file | Purpose |
|---|---|
| `src/lib/upload-meta.ts` | `deriveGcsKey`, `validateUploadMeta`, `sanitizeOriginalName`, `MAX_FILE_SIZE` — one validation rule shared by prepare and complete |
| `src/lib/throttle.ts` | The sliding window moved out of `src/proxy.ts`, plus an exported `getClientIp` and failure-counter helpers |
| `src/lib/http.ts` | `parseId`, `readJson`, `extractBearerToken` — replaces 9 copies of the id guard, 9 of the JSON guard, and 3 divergent Bearer parsers |
| `src/app/api/groups/[slug]/access/route.ts` | Server-side group token gate |

---

## Phase 1 — C1: eliminate the client-controlled `gcsKey`

**Files:** `src/app/api/upload/complete/route.ts`, `src/app/api/upload/route.ts`,
`src/lib/upload-meta.ts` (new), `src/lib/gcs.ts`, `src/lib/sha256.ts`,
`src/app/upload/UploadForm.tsx`, `src/app/admin/groups/[slug]/GroupUpload.tsx`.

`/api/upload` already derives the key correctly at `route.ts:70-73`, so the fix is to make complete do
the same and stop reading the body field.

- `deriveGcsKey(sha256, filename)` returns `` `${sha256}.${ext}` `` where `ext` is
  `path.extname(filename).slice(1).toLowerCase()` gated by `/^[a-z0-9]{1,8}$/`, falling back to `bin`.
  A closed charset allowlist rather than an enumerated extension list — deny-by-default with no
  maintenance, and the sha256 half is already regex-gated. `../../etc/passwd` yields `<sha>.bin`.
- In `complete`, **do not destructure `body.gcsKey`** — ignore it rather than reject it, so any
  external agent still posting it keeps working. Derive the key, then cross-check against reality with
  a new `statObject(gcsKey)` in `src/lib/gcs.ts` (`getMetadata()`, returns `null` on 404, rethrows
  otherwise): a missing object is a 400, and `size`/`content_type` are persisted **from GCS**, not from
  the client. That makes the 10 GB cap real without adding `x-goog-content-length-range` to the signed
  URL, which would need a matching header on every uploader including external agents.
- Reject the HMAC-handshake alternative: the key is a pure function of two inputs the server already
  validates, so an HMAC would re-transmit recomputable data and still couldn't prove the object exists.
- `validateUploadMeta` applies prepare's rules in both routes, and **anchors the content-type regex**
  (`upload/route.ts:46` is unanchored at the end, so `text/plain\r\nX-Injected: 1` passes today and
  flows into `generateSignedDownloadUrl`'s `responseType` and a raw header at
  `groups/[slug]/files/[sha256]/route.ts:71`).
- Add `normalizeSha256()` to `src/lib/sha256.ts` — validates **and lowercases**. Fixes the dedup
  bypass, since SQLite comparisons are BINARY and an uppercase digest currently misses the row.
- A duplicate sha256 at complete returns 409 instead of throwing a raw `UNIQUE constraint failed` into
  a 500 body; both upload routes return the constant `{ error: 'Internal server error', phase }` and
  log the real message, matching `api/admin/files/route.ts:34-35`.
- Delete dead code: `computeSHA256AndStream` (`sha256.ts:14`, zero callers), `streamToGCS`,
  `getGCSReadStream`, `renameInGCS`, and the `busboy`/`@types/busboy` dependencies.

**Deliberate non-goal:** server-side SHA-256 verification. GCS returns only `crc32c`/`md5Hash`, so
real verification means streaming 10 GB back through Cloud Run — the exact cost the redirect design
avoids. Document `sha256` as a client-asserted content address and accept the residual (an
`upload`-role actor can poison dedup for a later uploader via the collision branch at
`upload/route.ts:60-68`).

## Phase 2 — C2a: stop secrets leaving the data-access layer

**Files:** `src/types.ts`, `src/lib/db.ts`, plus call-site retypes. **Isolated commit, no behavior
change bundled in** — this is the widest blast radius in the plan (12 getters, ~20 call sites).

The secret-stripping idiom (`const { token_hash: _th, ...safe }`) already appears at 8 call sites and
still missed 4. A per-call-site rule that fails a third of the time is not a control. Project in SQL
so the secret is *absent* rather than *removed*, and let the type system make a missed strip a compile
error. This is the same pattern `listFiles` (`db.ts:278-294`) already uses — extended to every getter
and given honest types.

- Add to `src/types.ts`: `SafeFileRecord = Omit<FileRecord,'token_hash'>`, `SafeFileGroup`,
  `SafeUser = Omit<User,'password_hash'>`, `SafeFileGroupWithFiles`, and `PublicGroupFile`
  (`sha256`, `original_name`, `size`, `content_type` — exactly what the group page renders). The
  existing interfaces are unchanged, so nothing that constructs a full record breaks.
- One `FILE_COLUMNS` constant reused by every file query. Getters return safe types by default; the
  three that genuinely need a secret become explicitly named `*ForAuth`:
  `getFileBySha256ForAuth` (download route), `getGroupBySlugForAuth` (group download + new access
  route), `getUserByUsernameForAuth` (`auth.ts:180`), `getUserByIdForAuth` (`account/route.ts:19`).
- **Correction to the review:** `getGroupBySlug` has no production caller needing `token_hash` — the
  group download route uses `getGroupWithFiles` (`groups/[slug]/files/[sha256]/route.ts:33,44`). That
  route changes to `getGroupBySlugForAuth` → verify token → *then* `listGroupFiles`, which is better
  ordering anyway: today it loads every file row before proving anything.
- Delete the now-redundant strips at `api/admin/files/route.ts:22,29`, `files/[id]/route.ts:35`,
  `admin/files/[id]/page.tsx:78`, `api/admin/users/route.ts:18,74`, `users/[id]/route.ts:32`; retype
  `src/app/admin/AdminFilesClient.tsx:5,7`. This also fixes the admin group endpoints returning
  `token_hash` and `src/app/admin/page.tsx:13-24` serializing group hashes into a client component.

## Phase 3 — C2b: make the group token gate real

**Files:** `src/app/api/groups/[slug]/access/route.ts` (new), `src/app/g/[slug]/page.tsx`,
`src/app/g/[slug]/GroupPage.tsx`, `src/app/api/groups/[slug]/files/[sha256]/route.ts`.

`GroupPage.tsx:22-28` currently gates on `setSubmitted(true)` with no server call. Add a real route
rather than a server action: a route has a stable path the proxy can rate-limit, whereas a server
action POSTs to `/g/[slug]` — exactly the transport-invisibility that caused the login-throttle bug.

`POST /api/groups/[slug]/access` with `{ token }`:
1. `isValidSlug` shape check;
2. `getGroupBySlugForAuth(slug)`, then **always** one `verifySecret(token, group?.token_hash ?? null)`
   so an unknown slug and a wrong token are indistinguishable in both body and timing;
3. byte-identical `401 { error: 'Invalid token', phase: 'token-verify' }` for either failure;
4. only then the 410 expiry answer;
5. return `{ name, expires_at, files }` where files are `PublicGroupFile` and per-file `expires_at` is
   filtered — which also closes the medium where group downloads ignore file expiry. Apply the same
   check in the download route after token verification.

**Per the owner's decision, the pre-token page shows the group name only** — no file list, no count,
no expiry. `page.tsx` fetches just the name (a dedicated `getGroupNameBySlug` projection) and renders
`<GroupPage slug={slug} name={name} />`; `notFound()` for an invalid slug shape. `GroupPage` holds the
returned manifest in state. Note the residual this leaves: the page still distinguishes a real slug
from a fake one. Accepted for link-recognizability.

`handleDownload` (`GroupPage.tsx:30-47`) keeps its `Authorization: Bearer` header and switches to the
`{ url }` JSON pattern from Phase 6, which removes the byte-proxying at
`groups/[slug]/files/[sha256]/route.ts:67-75` and its 32 MB Cloud Run response cap.

## Phase 4 — H1: make cleanup reachable and correct

**Files:** `src/proxy.ts`, `src/app/api/cleanup/route.ts`.

Replace `bearerAllowedPath` (`proxy.ts:116-118`) with an exact-path allowlist of routes that
authenticate their own callers, preserving deny-by-default:

```ts
export function selfAuthenticatingRoute(pathname: string): 'agent-key' | 'route' | null {
  if (pathname.startsWith('/api/upload')) return 'agent-key';  // proxy verifies the aud:"upload" key
  if (pathname === '/api/cleanup')        return 'route';      // handler verifies Google OIDC
  return null;
}
```

`'route'` requires only that a Bearer header be present before `NextResponse.next()`; the handler does
the real work. Add a `cleanup: { max: 5, windowMs: 60_000 }` category so unauthenticated hammering
can't drive `verifyIdToken`'s fetch to Google's certs.

In the route: **fail closed** — return false when `OIDC_AUDIENCE` or `SCHEDULER_SA` is unset
(`route.ts:21` currently skips the identity check when the env var is missing); flip precedence to
`CLEANUP_AUDIENCE ?? AUTH_URL` so the scheduler audience is pinnable independently; replace
`require('crypto')` (`:43`) with a top-level import; treat a GCS 404 as success so a missing object
stops being retried hourly forever; and give `getExpiredDeviceSessions` (`db.ts:374-381`) its first
production caller so device sessions are finally pruned.

Consider also removing `CLEANUP_SECRET` from production entirely (`cloudrun.tf:104-112`) — production
authenticates via OIDC, and with the var unset the `secret.length > 0` check at `route.ts:41` simply
falls through. One less static credential on a publicly-invokable route.

## Phase 5 — H2/H3/H4/H5: authentication and authorization

**Files:** `src/lib/admin-auth.ts`, `src/auth.ts`, `src/lib/throttle.ts` (new), `src/lib/token.ts`,
`src/lib/upload-auth.ts`, `src/proxy.ts`.

**H2 — DB-authoritative authorization.** `getIsAdmin()` re-loads the user by `session.user.id` rather
than trusting the JWT claim. `src/app/api/account/route.ts:18-22` already does exactly this;
better-sqlite3 is synchronous and local, so the cost is microseconds. A deleted user returns `null` →
immediate revocation with no invalidation bookkeeping. Reject the `token_version` alternative: it
needs a migration, still costs a read per request, and only revokes when someone remembers to bump it.
Add `getCurrentActor()` and hoist `VALID_PERMISSIONS` (declared inline 3×) here. Set
`session: { strategy: 'jwt', maxAge: 8 * 60 * 60 }` at `auth.ts:154`. Re-resolve permissions in
`resolveUploadActor` too; agent keys are ≤15 min so they stay as-is. Add a comment above
`requiresAdmin` (`proxy.ts:103`) recording that the proxy is deliberately optimistic — it runs on Edge
and cannot import better-sqlite3, which is why the handler check is the real one.

**H3 — throttle where every transport converges.** Move the sliding window from `proxy.ts:9-67` into
`src/lib/throttle.ts` and add `isLockedOut`/`recordFailure`/`clearFailures`. Export
`authorizeCredentials` from `src/auth.ts` (mirroring the existing "exported for unit tests"
`jwtCallback`) and throttle **inside** it on `login_user` (5 / 15 min) and `login_ip` (20 / 15 min).
`authorize(credentials, request)` does receive the request in v5, and `next-auth/lib/actions.js`
copies incoming headers into its synthetic `Request`, so the IP key works on the server-action path
too. Also add `/login` + POST to `getRateLimitCategory` as a second layer. Note in a comment that the
Edge proxy and Node `authorize()` hold *separate* map instances — they are independent layers, and the
in-`authorize` one is authoritative.

Fix the timing oracle with one helper in `src/lib/token.ts`: `verifySecret(candidate, hash | null)`
always performs exactly one bcrypt compare against a fixed dummy hash when the record is absent. Use
it in `authorizeCredentials` (covering both the unknown user at `auth.ts:182-186` and the OIDC user
with a null hash), the new access route, the group download route, and `download/[sha256]:52`.

**H4 — trust the right proxy hop.** `getClientIp` moves to `throttle.ts`, is exported (so it becomes
testable), and reads from the **right** end of `x-forwarded-for` with a `TRUSTED_PROXY_HOPS`
environment override defaulting to 0. Correct for this deployment: there is no global load balancer,
only a Cloud Run domain mapping, so Google's front end appends the real client IP last.

**H5 — verify the OIDC claim.** `email_verified` and `hd` live on the **`profile` argument** to the
`jwt` callback, not on `user` — for a `type: 'oidc'` provider, `@auth/core` passes the validated
ID-token claims (`lib/actions/callback/oauth/callback.js:167-169`), while the default profile mapper
keeps only `id/name/email/image` (`lib/utils/providers.js:78-85`). So thread `profile` into
`jwtCallback` rather than adding a custom `profile()` to the provider, which would force
security-critical optional fields onto the augmented `User` that the credentials path can never
populate.

In `resolveOidcUserPermissions` — the single gate both the UI and agent paths call — require
`email_verified === true`, and replace `email.split('@')[1]` with an `emailDomain()` helper returning
`null` unless there is exactly one `@` with text on both sides (this is what kills
`victim@example.com@attacker.io`). Accept `hd` as an alternative domain source, matching
`device/token/route.ts:284`. Add a `signIn` callback as the outer gate so an unverified account never
gets a session. Take `email` from `user`, not `profile`: Auth.js has already lowercased it, and
`users.email UNIQUE` is BINARY in SQLite, so reading the raw claim could create a duplicate row that
makes `upsertOidcUser` throw.

## Phase 6 — mediums that touch the same code

| Item | Change |
|---|---|
| `.png` proxy bypass (`proxy.ts:196-207`) | Two-entry matcher: `['/api/:path*', '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg\|png\|jpg\|jpeg\|gif\|webp\|ico)$).*)']`. Every `/api` path is proxied regardless of a fake extension; `/brushpass-logo.png` still bypasses. |
| `parseInt('1.png') === 1` (9×) | `parseId()` in `src/lib/http.ts` using `/^\d+$/`. |
| JSON guard (9×), 3 divergent Bearer parsers | `readJson()` and `extractBearerToken()` in `http.ts` — move the correct regex out of `agent-key.ts:191`; `agent-key` imports it. |
| Headers at 3 of 6 return points; no CSP/HSTS | Static baseline into `next.config.ts` `headers()` (checked before the filesystem, so it covers paths outside the matcher); `withSecurityHeaders(res)` at **every** proxy return including the 429 and both 403s. CSP `connect-src` **must** include `https://storage.googleapis.com` or the direct-to-GCS PUT breaks. Ship as `Content-Security-Policy-Report-Only` for one deploy. A nonce-based strict CSP forces dynamic rendering everywhere — deliberate follow-up, not now. |
| `/api/groups/*` unthrottled bcrypt on a single instance | New `group` rate-limit category. |
| Download token in query string → Cloud Logging | Add `POST /api/download/[sha256]` returning `{ url }`; the page POSTs and does `location.assign(url)`. Keep the `?token=` GET for already-shared links; update `DownloadForm.tsx:17-20`. |
| Pre-auth existence/expiry oracle (`download/[sha256]:32-48`) | Reorder to look up → `verifySecret` → constant 401 → *then* the 410, which only a valid token holder sees. |
| No password policy on admin create/reset | `MIN_PASSWORD_LENGTH = 12` in `token.ts`, enforced in all three routes; admin PATCH refuses `password` when `auth_provider !== 'credentials'`, mirroring `account/route.ts:24-29`. |
| Permission requests self-selected and overwriting | Approve route takes `{ permissions }` from the **admin's** body (validated), and `approvePermissionRequest` writes the **union** inside its existing transaction. |
| `foreign_keys` never set (`db.ts:181-199`) | `db.pragma('foreign_keys = ON')`. Verify against a copy of the production DB first — check no `file_group_members` row references a missing file. |

## Phase 7 — Terraform state migration *(operational, must precede rotation)*

1. Create the bucket with `gcloud`, not Terraform (self-managing a backend is a bootstrap cycle):
   `gs://pubsec-fileshare-tfstate`, UBLA, public-access-prevention, versioning, 30-day soft delete.
   The name must match what `terraform/main.tf:22` already expects.
2. Grant **only** the human operator `objectAdmin`. Neither `github-deployer@` nor `fileshare-app@`
   needs state access — `deploy.yml` never runs Terraform. Keep it that way.
3. Enable the `gcs` backend (`main.tf:19-24`), `terraform init -migrate-state`, copy the local state
   out of the repo first.
4. **Verify before deleting anything:** `terraform state list | wc -l` is 40, 12 secret-manager
   resources, then `terraform plan`.
5. **The plan will show pre-existing drift — do not apply yet.** Verified: state records no `AUTH_URL`
   while the live revision has one, and state pins `:latest` while the live revision runs a SHA tag.
   Applying now would ship the M16 regression and revert the image. Land Phase 9's `AUTH_URL` and
   `ignore_changes` items first.
6. `rm -P` the five local state files, then treat the values as compromised regardless (Phase 10).
   Check Time Machine and any editor backup directory too.
7. Commit `.terraform.lock.hcl` — currently ignored at `.gitignore:64`, so provider hash pinning is a
   supply-chain control that is switched off.

## Phase 8 — CI gates and the supply-chain trust boundary *(operational)*

**Order matters: contexts must exist before they are required, or every PR hangs on "Expected".**

1. **octo-sts first** — zero risk, highest severity closed. Add to
   `.github/chainguard/digestabot.sts.yaml` (values are anchored regexes, so escape the dots):
   `claim_pattern: {job_workflow_ref: mbarretta/brushpass/\.github/workflows/update-digests\.yml@refs/heads/main}`.
   Use `job_workflow_ref`, not `workflow_ref` — it names the workflow whose code actually runs and
   can't be spoofed by a caller. The policy is read from the default branch, so a PR can't alter it
   and a wrong value just fails digestabot, fixable with a push.
2. **Pin the Claude workflows**: `actions/checkout` to the SHA the other three workflows already use,
   `anthropics/claude-code-action` to a resolved SHA, add an actor allowlist
   (`contains(fromJSON('["mbarretta"]'), github.actor)`) so an internet comment can't start the job,
   and drop the unpinned `plugin_marketplaces` git URL from `claude-code-review.yml:42` — it is the
   only unpinnable remote-code fetch in the repo and it runs in a job holding `ANTHROPIC_API_KEY`.
3. **Add `test` and `lint` jobs to `ci.yml`** as separate parallel jobs, not steps inside
   `docker-build` (which is slow and gated on `secrets.CHAINCTL_IDENTITY`). Tests need no GCS
   credentials — every test whose route reaches `src/lib/gcs.ts` declares a `vi.mock` factory, which
   prevents the real module from evaluating — but set `GCS_BUCKET: ci-placeholder` anyway so a future
   test that forgets the mock fails on an assertion instead of a module-load throw. Fold
   `next typegen && tsc --noEmit` into `lint` rather than adding a fourth required context. If `npm ci`
   can't find a `better-sqlite3` prebuild for Node 24, drop to Node 22.
4. **Then** set branch protection: required contexts `docker-build`, `test`, `lint`, `CodeQL`;
   `enforce_admins: true`; `required_pull_request_reviews: null` (see the correction above);
   `strict: false` so digestabot's auto-merge doesn't deadlock. Re-open any in-flight digestabot PR so
   the new checks attach.
5. **WIF last, and carefully.** Add a temporary `workflow_dispatch` job that prints only the claim
   *fields* (never the token) to confirm the exact `job_workflow_ref`, then pin it in `wif.tf:28` as a
   CEL string equality (no escaping — unlike octo-sts). Leave `attribute_mapping` and the
   `principalSet` binding untouched.

## Phase 9 — Terraform correctness *(operational, before the first post-migration apply)*

- **`AUTH_URL` into Terraform.** Add `variable "auth_url"`, set it in `terraform.tfvars` to the live
  value, emit it in `cloudrun.tf`, guard it with a `lifecycle { postcondition }` asserting
  `var.auth_url == self.uri` so a recreated service fails loudly instead of shipping a stale audience,
  and delete `deploy.sh:79-86`. The app-side fix (fail closed on an empty audience) is Phase 4 and
  kills the class independently.
- **Stop Terraform and CI fighting over the image:** `lifecycle { ignore_changes = [template[0].containers[0].image] }`.
  CI owns the image, Terraform owns everything else.
- **Pin secret versions** — every secret env var uses `version = "latest"`, which Cloud Run resolves at
  instance start; with `min_instance_count = 1` a warm instance never picks up a new version. Point
  each at `google_secret_manager_secret_version.<name>.version` so rotation and revision roll happen
  atomically in one apply.
- **Per-secret IAM**, replacing the project-level `secretmanager.secretAccessor` at `iam.tf:46-50`.
  `fileshare-app@` is currently the only principal with project-wide access in `pubsec-se`, which also
  holds `github-token`, `google-oauth-client-*` and `status-board-session-secret`. **Do it as two
  applies** — add per-secret bindings, roll a revision, confirm it starts, *then* remove the
  project-level one. Narrow the bucket role from `objectAdmin` to `objectUser` (signing comes from the
  separate `signBlob` grant at `iam.tf:38-42`, not a storage role).
- Smaller items: drop `-auto-approve` from `deploy.sh:73` (writing any saved plan to `mktemp -d`, never
  the repo — a plan file contains the same plaintext secrets as state); replace `common.sh:47-49`'s
  `set -a; source` with a targeted parser for the six keys it maps; remove `http://localhost:3000` from
  the production bucket CORS; add a `validation` block tying `max_instance_count = 1` to the SQLite and
  rate-limiter assumptions; add `USER 65532` and `npm prune --omit=dev` to the Dockerfile runner stage
  (verify the pruned image boots — `next start` loads a TypeScript config and `typescript` is a
  devDependency); delete the dead `docker-entrypoint.sh`; add `poweredByHeader: false` and
  `experimental.proxyClientMaxBodySize` (note an over-limit body is **silently truncated**, not
  rejected, so set it comfortably above the largest legitimate payload).

## Phase 10 — Secret rotation *(operational, strictly after Phase 7)*

Two prerequisites: pin secret versions (Phase 9), and set `AGENT_KEY_SECRET` in `.env` so agent keys
stop depending on the `AUTH_SECRET` fallback at `agent-key.ts:74`. Then rotate least-disruptive first.

| # | Secret | How | Impact |
|---|---|---|---|
| 1 | `CLEANUP_SECRET` | `terraform apply -replace=random_password.cleanup_secret` | None in production — the scheduler uses OIDC |
| 2 | Agent OIDC client secret | **Console:** create a *second* "TVs and Limited Input devices" client, put it in `.env`, `./apply.sh`, verify, then delete the old one | In-flight device authorizations only; minted keys unaffected |
| 3 | `AUTH_SECRET` | `terraform apply -replace=random_password.auth_secret` | **Every session** — all users re-login. Do it in a quiet window |
| 4 | Bootstrap admin | **Delete, don't rotate** — change the password in-app via `/api/account`, then execute the teardown `secrets.tf:55-62` already documents | None; the bootstrap already happened |

Make-before-break on #2 rather than an in-place reset, which would leave a window where the deployed
revision holds a dead secret. Note that every revision roll briefly overlaps two instances on the same
GCS-FUSE SQLite file — enable object versioning on `gs://pubsec-fileshare-db` first as cheap insurance.

## Phase 11 — Dependencies *(three separate PRs off the branch, so a regression is a revert)*

1. `next` and `eslint-config-next` → **16.2.12** (clears all 16 open `next` alerts).
2. `next-auth` → **exact `5.0.0-beta.32`**, dropping the caret — a caret on a pre-release accepts any
   future beta of the library that signs your sessions. This transitively pins `@auth/core@0.41.3`,
   clearing the critical advisories.
3. Declare `google-auth-library: 9.15.1` (imported by `cleanup/route.ts:4` but resolved only
   transitively today), bump the `postcss` override to `^8.5.23`, correct the stale versions in
   `README.md:29,32`.

Durable scanning: `gh api -X PUT repos/mbarretta/brushpass/automated-security-fixes` plus a
`.github/dependabot.yml` covering `npm` **and `github-actions`** — without the latter, SHA-pinning
actions means silently freezing on old versions forever. Also add a repo `.npmrc` pinning
`registry=https://registry.npmjs.org/`: the Chainguard Libraries registry is configured globally in
`~/.npmrc`, and the next local `npm install` would rewrite the lockfile's `resolved` URLs to a registry
CI has no credentials for, breaking `docker-build`. (`.gitignore:16` currently ignores `.npmrc`.)

---

## Verification

**Automated.** Baseline is 284 tests / 26 files. New test files under `/tests/unit/` (the live
directory; `/src/tests/unit/` is a 3-file fossil from a repo restructure), following the existing
conventions exactly — handlers imported and called with a plain WHATWG `Request` cast `as never`,
dynamic params as `{ params: Promise.resolve({...}) }`, `@/lib/gcs` always mocked, `next-auth` mocked
when importing `@/auth` or `@/proxy`:

| File | Key security assertions |
|---|---|
| `upload-meta.test.ts` | `deriveGcsKey(sha,'../../etc/passwd')` has no slash; `.PDF`→`.pdf`; content-type with `\r\n` rejected |
| `group-access-route.test.ts` | Unknown slug and wrong token give **byte-identical** 401s and both call `verifySecret` exactly once; a valid response contains no `$2b$`, `token_hash` or `gcs_key`; expired member files absent |
| `group-page-leak.test.ts` | The page element's props contain no `$2b$`/`token_hash`/`gcs_key` — the literal C2 regression test |
| `admin-auth.test.ts` | JWT says `['admin']` but the DB says `[]` → `getIsAdmin()` is **false**; deleted user → false |
| `throttle.test.ts` | `x-forwarded-for: '1.2.3.4, 9.9.9.9'` yields `9.9.9.9`; rotating the leftmost entry 100× does not reset the counter |
| `login-throttle.test.ts` | 5 failures then a **correct** password still returns null; unknown user and wrong password both do exactly one bcrypt compare |
| `cleanup-route.test.ts` | Valid OIDC token but `CLEANUP_SCHEDULER_SA` unset → 401 (fail-closed regression); GCS 404 still deletes the row |

Extend `upload-route.test.ts` (a caller-supplied `gcsKey` is ignored and `insertFile` receives the
derived key), `proxy.test.ts` (`selfAuthenticatingRoute('/api/cleanup')`, matcher includes
`/api/:path*`), `groups-db.test.ts` and `users.test.ts` (projections return `undefined` for the secret
columns), `download-route.test.ts` (unknown sha256 now 401, not 404), `oidc.test.ts`
(`email_verified: false` rejected; `victim@a.com@evil.io` does not auto-promote),
`admin-permission-requests.test.ts` (union, not replacement). Expect mechanical updates to
`groups-db.test.ts:214-234` and the `/8 characters/` assertion at `account-route.test.ts:132`.

**Manual, against a deployed revision** — the exposure fixes need proof outside unit tests:

1. `curl -s https://<service>/g/<real-slug> | grep -c '\$2b\$'` → **0** (it is non-zero today).
2. Mint an agent key, `POST /api/upload/complete` with `"gcsKey": "some/other/object.json"`, confirm
   the response URL and the DB row both use `<sha256>.<ext>`.
3. `curl -H "Authorization: Bearer x" https://<service>/api/cleanup` → **401**, not a 307 to `/login`
   (it is a 307 today). Then confirm the next hourly Cloud Scheduler run succeeds:
   `gcloud scheduler jobs describe fileshare-cleanup --location=us-central1 --project=pubsec-se`
   should stop reporting `code=5`, and expired files should disappear from the bucket.
4. `curl -s -D- -o/dev/null https://<service>/api/admin/files/1.png` → security headers present and the
   proxy gate applied (today: no headers, proxy skipped).
5. 6 failed logins for one username → the 6th fails even with the correct password; repeat with a
   rotating `X-Forwarded-For` and confirm it still throttles.
6. Full happy path unbroken: SSO login, browser upload (direct-to-GCS PUT — watch for CSP
   `connect-src` breakage), download by token, group access with a valid token, and
   `POST /api/agent/device/start` returning 200 with `verification_uri`/`user_code`/`poll_token`.

---

## Risk register

| Risk | Severity | Guard |
|---|---|---|
| **WIF provider replacement** — a `-/+` plan soft-deletes provider `github-oidc` for ~30 days and the ID can't be reused, while `deploy.yml:44` hardcodes it → deploys broken for a month | Highest | Read the plan; require `~ update in-place`. Recovery via `gcloud iam workload-identity-pools providers update-oidc`, which doesn't depend on the pipeline |
| **Required PR reviews on a solo repo** | High | Do not enable. Use `enforce_admins` + required checks |
| **Required context with no producing workflow** | Medium | Merge `ci.yml` before editing branch protection |
| **`terraform apply` before Phase 9** | Medium (silent) | Land `AUTH_URL` and `ignore_changes` first; drop `-auto-approve` |
| **Lockfile rewritten to `libraries.cgr.dev`** → `npm ci` fails in CI | Medium | Repo `.npmrc` |
| **Requiring `email_verified` locks out SSO** if the IdP omits it | Medium | The agent path already requires it in production, so if agent minting works, the IdP issues it |
| **CSP omitting `storage.googleapis.com`** silently breaks uploads | Medium | Ship report-only for one deploy |
| **`foreign_keys = ON`** changes delete semantics | Medium | Verify against a copy of the production DB first |
| **Phase 2's DAL projection** touches ~20 call sites | Medium | Isolated commit, suite run before and after. The `Omit<>` types do **not** break existing fixtures (they're returned from untyped `vi.fn()` mocks); expect ~5 `tsc` spots, mainly `AdminFilesClient.tsx` |
| **`AUTH_SECRET` rotation without `AGENT_KEY_SECRET`** invalidates agent keys too | Low (self-heals ≤15 min) | Set `AGENT_KEY_SECRET` first |

Nothing here can lock the owner out of GCP: every recovery path runs through the owner's own `gcloud`
credentials, independent of WIF, and every GitHub recovery is a push or a single `gh api` call.

## Open question to settle during implementation

Whether to delete `/src/tests/unit/` (3 fossil files, ~25 tests, already diverged from their
`/tests/unit/` namesakes). It halves fixture maintenance for Phase 2, but drops the baseline from 284
to ~259 — agree the new number before doing it rather than discovering it in CI.

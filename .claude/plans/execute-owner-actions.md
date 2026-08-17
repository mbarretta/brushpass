# Execute the owner-action sequence (post fix-security-remediation)

## Status (2026-08-14)

**UPDATE (late 2026-08-14): Phases 3–4 complete; SSO live.** Applies 1+2 done (per-secret IAM sole access path, proven by fresh revision 00117). CLEANUP_SECRET removed from production entirely (PR #84; route is OIDC-only, fails closed; hourly cleanup verified 200). Agent OAuth client rotated make-before-break; `AGENT_KEY_SECRET` set; AUTH_SECRET rotated to v3. Interactive SSO wired for the first time in prod: new web-type OAuth client → `fileshare-oidc-client-id/secret` secrets + pinned versions + per-secret IAM. First SSO attempt failed with `redirect_uri_mismatch` at the token exchange — next-auth's route-handler leg anchors to the container's internal origin (`localhost:8080`) when AUTH_URL is unset, while the server-action leg uses forwarded headers, so the two OAuth legs disagreed. Fixed by PR #85 (postcondition retargeted `auth_url`→`cleanup_audience`) + `auth_url = "https://fileshare.cgr-pubsec.dev"` in tfvars. Revision `fileshare-00122-b2d`: **owner confirmed SSO login works** — closes 5d (`email_verified` end-to-end). **Rotation Step 4 COMPLETE (2026-08-14):** owner changed the admin password in-app; PR #86 (`d083d2d`) tore down the bootstrap wiring (secrets, versions, per-secret IAM, `terraform_data.bootstrap`, variables, output, deploy.sh reminder); apply destroyed all 7 as planned; secret list verified — only the expected six `fileshare-*` secrets remain. Owner deleted the `fileshare-bootstrap` job and removed the stale `bootstrap_admin_*` tfvars lines; post-cleanup plan shows "No changes" with zero warnings — Step 4 fully closed. **WIF post-verify COMPLETE (2026-08-14):** owner-triggered `workflow_dispatch` run 31835338784 succeeded — first live pass of the pinned `job_workflow_ref` condition; pipeline deployed revision `fileshare-00123-v9m` (Ready, 100% traffic, login 200). **Phase 5 SHRED COMPLETE (2026-08-14, owner-confirmed):** all 5 local tfstate files and `~/tfstate-migration-backup-fileshare/` deleted with `rm -P`/`rm -rP` (best-effort overwrite on APFS; every secret they contained was already rotated or destroyed). GCS backend verified intact afterward (49 state entries readable). **SEQUENCE COMPLETE.** Remaining owner-only: Time Machine/cloud-backup sweep for old state-file copies; optional: delete the old device-type OAuth client in the Cloud Console. Optional agent follow-up: retarget the stale `oidc_callback_url` output to the custom domain.

---

**Phases 0–2 COMPLETE.** Cycle merged+pushed (`0927ff5`); production is serving the remediated image. Done: deploy verified, Dependabot auto-fixes on, branch protection live (`test`+`lint`, `enforce_admins`, no reviews), prod-DB `foreign_key_check` clean (4 inert orphaned `download_logs` rows, CASCADE now enforced), Chainguard registry line verified (no EINTEGRITY), **state migrated to `gs://pubsec-fileshare-tfstate`** (46/46 instances, versioned, ownership-asserted; local backups in `~/tfstate-migration-backup-fileshare/`), read-only post-migration plan passed both gates (**WIF `~ update in-place`**, AUTH_URL drift visible).

**Two bugs found + fixed, staged on local branch `fix/iam-sensitive-foreach` (committed, NOT pushed — needs owner OK):**
1. `terraform/iam.tf` per-secret IAM `for_each` tripped Terraform's sensitive-value rejection (invisible to `validate`; only a live plan catches it). Fixed with `nonsensitive()`. After the fix, `./apply.sh plan` exits 0 with **9 add / 2 change / 3 destroy**.
2. `tfstate-migration.md` ownership assertion used `--format='value(projectNumber)'` which prints empty on gcloud SDK 571+; fixed to `--raw` with a list-based fallback.

**AUTH_URL decision (owner, 2026-08-14) — SUPERSEDED by the update above (custom domain required for SSO; run.app value moved to `cleanup_audience`):** use the **run.app URL** `https://fileshare-r2smbcsxpq-uc.a.run.app`, NOT the custom domain `fileshare.cgr-pubsec.dev`. Rationale: `AUTH_TRUST_HOST=true` means NextAuth uses the request Host for callbacks, so the custom domain works via the domain mapping regardless; `AUTH_URL`'s only code consumer is the cleanup audience fallback, which must equal the scheduler's `self.uri` audience (the run.app URL). No terraform change; postcondition holds; `cleanup_audience` stays unset.

**BLOCKERS before Phase 3:** (a) gcloud re-authed ✅; (b) fix branch merged to main via PR #83 (`aa1dd1a`), local main synced ✅; (c) the two file edits below — **owner-performed**: the settings.json deny on `.env`/`terraform.tfvars` is mechanical (survives in-chat authorization), and appending to `.env` via the Edit tool would read live production secrets into the agent context — the exact exposure the deny (and this cycle's sec-batch flag) protects against. Not worth reversing for two lines. Edits handed to the owner instead.

**The two edits (owner):**
- `terraform/terraform.tfvars`: `auth_url = "https://fileshare-r2smbcsxpq-uc.a.run.app"`
- `.env`: append `AGENT_KEY_SECRET=` + a fresh value from `openssl rand -base64 48` (run it yourself so the secret never enters the agent transcript).

## Context

The security-remediation cycle is merged and pushed (`0927ff5`); `deploy.yml` is shipping the new image to Cloud Run now. What remains is the operational sequence the cycle deliberately staged as config + runbooks: state migration, the first terraform apply of task 11's corrections, secret rotation, and the GitHub hardening toggles. The owner has delegated execution of as much as possible to the agent, with per-phase gates.

**Credentials verified:** gcloud as michael.barretta@chainguard.dev on `pubsec-se`; gh as mbarretta with repo+workflow scopes. Live service: `https://fileshare-r2smbcsxpq-uc.a.run.app`. Five local tfstate files present.

**Hard boundaries (stay with the owner):**
- `.env` and `terraform.tfvars` edits — permission-denied to the agent by design (verified live). Two one-line edits are needed at Phase 3.
- Google Cloud Console OAuth-client creation/deletion (device-type clients have no CLI path) — Phase 4b.
- In-app bootstrap password change, SSO login test, AUTH_SECRET quiet-window timing, Time Machine/cloud-backup sweep of old state files.

**Standing risk gates (from the runbooks, non-negotiable):**
1. No terraform plan/apply before the state migration completes (deploy scripts fail closed until then).
2. `auth_url` must be set in tfvars before the first apply, or the empty default strips `AUTH_URL` from the running service.
3. Any WIF plan line for `github-oidc` must read `~ update in-place`; `-/+ must be replaced` = STOP (30-day lockout).
4. Bucket-create 409 = STOP; ownership assertion must pass before migrate.
5. State files are shredded only after every verification passes, never before.

## Phase 0 — verify the push deploy (read-only; agent)

- Watch `gh run` for the main-branch CI (test, lint, docker-build) and Deploy runs to complete green. This also makes the new required-status contexts exist for Phase 1b.
- Probe production: unauthenticated `/admin` → 307 to `/login`; `POST /api/agent/device/start` → 200 with `verification_uri`/`user_code`/`poll_token`; response carries the new security headers (CSP-Report-Only, HSTS).

## Phase 1 — GitHub + local quick wins (agent; no terraform)

- 1a. Enable Dependabot security updates: `gh api -X PUT /repos/mbarretta/brushpass/automated-security-fixes`.
- 1b. Branch protection PUT exactly per `docs/runbooks/branch-protection.md` (contexts: docker-build, test, lint, `Analyze (actions)`, `Analyze (javascript-typescript)`; `enforce_admins: true`; `required_pull_request_reviews: null`). Precondition per the runbook: lint AND typecheck green at HEAD (Phase 0 confirms).
- 1c. `foreign_key_check` on the prod DB: `gcloud storage cp` the SQLite file from the DB bucket to /tmp (read-only), run `PRAGMA foreign_key_check` locally, delete the copy.
- 1d. Test the README's Chainguard-verification line once: `npm ci --registry=https://libraries.cgr.dev/javascript/` in a scratch checkout (int2 evaluator flagged possible EINTEGRITY; docs-only follow-up if it fails).

## Phase 2 — tfstate migration (agent, per `docs/runbooks/tfstate-migration.md`)

- 2a. Copy all five state files to `~/tfstate-backup-$(date)/` outside the repo.
- 2b. Create `gs://pubsec-fileshare-tfstate` per the runbook flags (UBLA, PAP, soft-delete, versioning). **409 = hard stop.**
- 2c. Ownership assertion: project numbers must match between `gcloud projects describe pubsec-se` and `buckets describe`.
- 2d. IAM: objectAdmin for michael.barretta@chainguard.dev only.
- 2e. `terraform init -migrate-state`; verify 46 instances / 14 secret resources / remote object listing.
- 2f. `./apply.sh plan` — read only: expected diff is task 11's new/changed resources plus the known AUTH_URL and image drift, with the WIF gate (risk gate 3) checked. **No apply in this phase.**

## Phase 3 — first apply: task 11's corrections (agent executes; owner gates)

- **Owner pre-step (two one-line edits + gcloud re-auth):**
  - `gcloud auth login` — the session token expired during Phase 2.
  - `terraform.tfvars`: `auth_url = "https://fileshare-r2smbcsxpq-uc.a.run.app"` (the run.app URL, per the decision above — NOT the custom domain; leave `cleanup_audience` unset so it falls back to AUTH_URL = the scheduler audience).
  - `.env`: `AGENT_KEY_SECRET=<openssl rand -base64 48>` — the rotation prerequisite that decouples agent keys from AUTH_SECRET; the apply creates its Secret Manager wiring.
  - Push + merge `fix/iam-sensitive-foreach` first (the plan does not cleanly apply without its `nonsensitive()` fix).
- 3a. Enable object versioning on the SQLite DB bucket first (rotation-runbook recommendation before deliberate revision rolls) if not already managed by storage.tf.
- 3b. `./apply.sh plan` → agent posts a plan summary → **owner approves** → apply. This rolls a revision (pinned secret versions, AUTH_URL var + postcondition, per-secret IAM apply-1, image ignore_changes, objectUser narrowing, CORS gate).
- 3c. Verify: service healthy, device/start 200, AUTH_URL postcondition passed, scheduler's next cleanup run returns 200 (or trigger via `gcloud scheduler jobs run`).
- 3d. IAM apply-2: owner flips `revoke_project_secret_accessor = true` in tfvars → plan → apply → confirm a fresh revision still starts (per-secret bindings now sole access path).

## Phase 4 — rotations (mixed, per `docs/runbooks/secret-rotation.md`)

- 4a. CLEANUP_SECRET — **owner decision**: remove from production entirely (task 4's standing proposal; small terraform change the agent can make and apply) or rotate per the runbook. Recommend removal.
- 4b. Agent OIDC client (make-before-break): **owner** creates a second device-type OAuth client in the console and updates `.env` → agent applies → verify device/start → **owner** deletes the old client.
- 4c. AUTH_SECRET: **owner picks the quiet window**; agent executes the rotation + apply (signs out all sessions; agent keys survive thanks to 3's AGENT_KEY_SECRET).
- 4d. Bootstrap admin credential: **owner** changes the password in-app; agent executes the documented teardown (delete both secrets, `state rm`, remove the blocks + job wiring, apply).

## Phase 5 — close-out (agent + owner)

- 5a. Full production smoke: login redirect, group access flow, download (POST `{url}` flow), agent device mint end-to-end if feasible.
- 5b. WIF post-verify: `workflow_dispatch` deploy.yml once — proves the pinned `job_workflow_ref` condition still admits the deployer; watch the next scheduled digestabot run for octo-sts.
- 5c. Shred the five local state files (`rm -P`), then **owner** sweeps Time Machine / cloud-synced copies.
- 5d. **Owner**: one SSO login to confirm `email_verified` flows (a refusal now shows the new banner rather than a silent bounce).
- 5e. Optional hardening follow-up PR: drop `id-token: write` from the two Claude workflows (task 9's belt-and-braces note).

## Verification

Each phase ends with its own listed checks; the sequence ends with the Phase 5 smoke plus: `gh api /repos/mbarretta/brushpass/branches/main/protection` showing the five contexts, `automated-security-fixes` enabled:true, remote state object listed and versioned, all rotated secrets on pinned versions, and zero local plaintext state.

## Rollback notes

- Migration: local backups from 2a remain until 5c; `terraform init -migrate-state` back to local is the escape hatch.
- Apply: the image is ignore_changes'd, so a bad revision rolls back via `gcloud run services update-traffic` / redeploy.sh, not terraform.
- Branch protection: one-command DELETE escape hatch in the runbook.
- WIF: recovery runs through the owner's own gcloud credentials (independent of WIF), documented in wif-claim-pinning.md.

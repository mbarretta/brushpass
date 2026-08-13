# Secret rotation runbook

**Status: this is a runbook for the OWNER to execute by hand. No secret is
rotated, no Secret Manager version is created, no Cloud Run job is deleted,
and no `terraform apply` has been run as part of producing this document.**
Every command below is something the owner runs themselves, in the order
given; this task's own diff is this file plus `.env.example` and `AGENTS.md`.

## Why this exists

`terraform/terraform.tfstate` held `AUTH_SECRET`, `CLEANUP_SECRET`, the agent
OIDC client secret, and the bootstrap admin username/password in plaintext for
four months (see `docs/runbooks/tfstate-migration.md`). Moving the state
backend stops new exposure; it does not undo it. Every value that ever
appeared in that file must be treated as compromised and rotated — but
rotating them in the wrong order, or all at once, creates its own outage:
rotating `AUTH_SECRET` while agent keys still fall back to it invalidates
every session **and** every outstanding agent key in the same stroke, and
resetting the agent OAuth client secret in place (rather than
make-before-break) leaves a window where the deployed revision holds a dead
secret and every agent poll fails until the next deploy. This runbook orders
every rotation least-disruptive-first and calls out, per step, which owner
action is required and whether it forces a Cloud Run revision roll.

## Prerequisites — do not rotate anything until all of these are true

1. **Secret versions are pinned in Terraform (task 11).** Every
   secret-sourced `env` block in `terraform/cloudrun.tf` — `AUTH_SECRET`,
   `CLEANUP_SECRET`, the agent OIDC client id/secret, and (once Prerequisite 3
   below is applied) `AGENT_KEY_SECRET` — must reference an explicit
   `google_secret_manager_secret_version.*.version` value, never `"latest"`.
   Confirm with `grep -n 'version = google_secret_manager_secret_version'
   terraform/cloudrun.tf` before proceeding. This is the mechanism behind
   every "forces a revision roll" claim in this runbook: with
   `cloud_run_max_instance_count` pinned to `1`, a warm instance never
   re-reads `"latest"` on its own, so if any of these env blocks still pointed
   at `"latest"` instead of a pinned version, rotating the secret in Secret
   Manager would create a new version but the already-running instance would
   keep serving the old value indefinitely — no error, no revision roll, just
   a rotation that silently never took effect. This is already true on `main`
   as of task 11 (merged before this runbook exists); if you are running this
   runbook against an older checkout that predates task 11, land that first.
2. **The state migration is complete and verified.** Follow
   `docs/runbooks/tfstate-migration.md` end to end first, including its own
   Step 5 verification and Step 6 cleanup. Rotating a secret before the
   backend has moved writes the new value straight back into the same local
   plaintext `terraform.tfstate` this whole exercise exists to get away from —
   this runbook does not repeat that migration's steps, only depends on it.
3. **`AGENT_KEY_SECRET` is set**, decoupling agent-key signing from the
   `AUTH_SECRET` fallback. `src/lib/agent-key.ts` signs every minted agent
   upload key with `process.env.AGENT_KEY_SECRET ?? process.env.AUTH_SECRET`
   — until `AGENT_KEY_SECRET` is set, every live agent key is cryptographically
   tied to the current `AUTH_SECRET` value, so rotating `AUTH_SECRET` (Step 3
   below) would silently invalidate every outstanding agent key at the exact
   moment it signs out every session, collapsing two independent blast radii
   into one. Set it now, independently of the rest of this runbook:

   ```bash
   # In the repo root .env (never in terraform.tfvars — see AGENTS.md):
   AGENT_KEY_SECRET=$(openssl rand -base64 32)
   ```

   Then apply from `terraform/`:

   ```bash
   ./apply.sh plan   # confirm: one new google_secret_manager_secret
                      # ("fileshare-agent-key-secret") + its version + a
                      # matching google_secret_manager_secret_iam_member
                      # binding (gated by the agent_key_secret_set local,
                      # defined in terraform/secrets.tf and consumed by
                      # terraform/iam.tf's fileshare_app_secret_ids), plus
                      # AGENT_KEY_SECRET added to the Cloud Run service's
                      # env — no other resource changes.
   ./apply.sh         # confirm 'yes' when applying
   ```

   **This forces a Cloud Run revision roll** (a new env var is added to the
   service template). See "Every rotation below forces a revision roll" for
   what that means operationally before you run it.

All three of the above are prerequisites for **every** step below, not just
for `AUTH_SECRET`'s step — a rotation attempted before secret versions are
pinned may not take effect on the running service at all, one attempted
before the backend migration lands the new secret in the same exposed local
state file, and one attempted before `AGENT_KEY_SECRET` is set risks the
agent-key blast radius on whichever rotation touches `AUTH_SECRET`.

## Rotation order — least-disruptive first

| Order | Secret | Production blast radius | Owner action | Forces revision roll? |
|---|---|---|---|---|
| 1 | `CLEANUP_SECRET` | **None.** The Cloud Scheduler caller authenticates via OIDC (`verifyOidcToken` / `CLEANUP_SCHEDULER_SA`) — `CLEANUP_SECRET` is a manual/local-dev fallback the route checks first (`src/app/api/cleanup/route.ts`'s `secretMatch` branch), not something production traffic depends on. | `./apply.sh apply -replace=random_password.cleanup_secret` (rotate) or a small `.tf` edit (remove entirely — see below) | Yes |
| 2 | Agent OIDC client secret | Breaks only the agent device-grant token exchange (`POST /api/agent/device/token`) for in-flight polls once the *old* client is deleted; does not touch interactive login (separate `AUTH_OIDC_*` client) or any active session. | Console (new client) + `.env` edit + `./apply.sh` + verify + Console (delete old client) | Yes |
| 3 | `AUTH_SECRET` | **Every** session and (if Prerequisite 3 above was skipped) every agent key. Do this in a quiet window. | `./apply.sh apply -replace=random_password.auth_secret` | Yes |
| — | Bootstrap admin credential | N/A — **delete, don't rotate** (see its own section) | In-app password change + `gcloud`/`terraform state rm` + `.tf` edits | Yes (removes env/secret wiring) |

## Every rotation below forces a revision roll — the GCS-FUSE SQLite risk

`terraform/variables.tf`'s `cloud_run_max_instance_count` validation block is
explicit: SQLite over GCS FUSE is not multi-writer-safe, which is why that
variable is pinned to `1`. A Cloud Run revision roll is the one place that
guarantee briefly does not hold — Cloud Run's rollout warms up the new
revision and shifts traffic to it while the old revision is still draining,
so for a short window two instances can have the same GCS-FUSE-mounted
`fileshare.db` open for read-write at once. Every step in this runbook changes
a secret-backed env var, so every step forces exactly this window.

Mitigate before rotating anything on purpose:

```bash
gcloud storage buckets update gs://pubsec-fileshare-db --versioning
```

(matching the same `--versioning` flag `docs/runbooks/tfstate-migration.md`
Step 2 already applies to the tfstate bucket — replace the bucket name if
your `db_bucket_name` differs from the `terraform.tfvars.example` default).
This does not prevent the overlap, but it means a SQLite file corrupted by a
racing write during rollout has a recovery path: an earlier object
generation. **This is a recommendation, not something this task or any prior
task has applied** — object versioning is not currently enabled on the DB
bucket (`terraform/storage.tf`'s `google_storage_bucket.fileshare_db` has no
`versioning` block). Also prefer rotating during low-traffic windows, and
treat `AUTH_SECRET` (Step 3) as the one to schedule most deliberately, since
it also signs every user out.

## Step 1 — `CLEANUP_SECRET`

No production traffic depends on this value (see the blast-radius table
above), so it is the safe one to start with and a reasonable place to
rehearse the mechanics of a Terraform-side rotation before Step 3.

**Option A — rotate in place:**

```bash
cd terraform
./apply.sh plan -replace=random_password.cleanup_secret
./apply.sh apply -replace=random_password.cleanup_secret   # confirm 'yes' when applying
```

Use `./apply.sh`, not a bare `terraform apply` — `./apply.sh` sources
`common.sh`'s `load_env_tfvars`, which is the only thing that exports
`TF_VAR_agent_oidc_client_id`, `TF_VAR_agent_oidc_client_secret`, and
`TF_VAR_agent_key_secret` from `.env` (per `AGENTS.md`'s "Step 2 — Where each
setting goes" and `terraform/terraform.tfvars.example`, these must stay out of
`terraform.tfvars`). A bare `terraform apply` sees none of those `TF_VAR_*`
values, so they fall back to their `""` defaults in `terraform/variables.tf`,
which flips `local.agent_oidc_enabled` and `local.agent_key_secret_set` to
`false` in `terraform/secrets.tf` and plans a **destroy** of the agent OIDC
secrets, the `AGENT_KEY_SECRET` secret, their IAM bindings, and the
corresponding Cloud Run env blocks — silently re-merging the agent-key blast
radius this runbook exists to keep separate from `CLEANUP_SECRET`'s.

This regenerates `random_password.cleanup_secret`, which creates a new
`google_secret_manager_secret_version.cleanup_secret`, which changes the
pinned `version` reference `terraform/cloudrun.tf:136` wires into the Cloud
Run service's `CLEANUP_SECRET` env var — **forces a revision roll.**

**Option B — remove it from production entirely (recommended; folds in the
standing proposal from task 4's notes):** with `CLEANUP_SECRET` unset, the
route's `secret.length > 0` check (`src/app/api/cleanup/route.ts`) falls
through to the OIDC check unconditionally — production already authenticates
the scheduler via OIDC, so this removes a static credential from a
publicly-invokable route with no functional loss in production. This is a
`.tf` edit beyond what any prior task has merged (removing the
`google_secret_manager_secret`/`_version.cleanup_secret` and
`random_password.cleanup_secret` resources from `terraform/secrets.tf`, the
`CLEANUP_SECRET` env block from `terraform/cloudrun.tf:129-139`, and its
`secret_id` from `terraform/iam.tf`'s `fileshare_app_secret_ids` list) — scope
it as its own small follow-on change, not bundled into a routine rotation.
**Keep `CLEANUP_SECRET` in `.env.example` and `AGENTS.md` regardless** — it
stays useful as the manual/local-dev fallback for a developer without OIDC
configured; only the production wiring is what Option B removes.

## Step 2 — Agent OIDC client secret (make-before-break)

**Blast radius:** limited to the agent device-grant flow (`POST
/api/agent/device/start` and `/token`); does not affect the interactive
`AUTH_OIDC_*` client or any signed-in user.

Google's OAuth client console offers an in-place "reset secret" action for an
existing client — **do not use it.** An in-place reset invalidates the old
secret the instant you click it, but the currently-deployed Cloud Run
revision keeps running with the old (now-dead) secret baked into its pinned
Secret Manager version until the next `apply` rolls a new revision — every
agent poll fails for that entire window. Do this make-before-break instead:

1. **Console:** register a *second* OAuth client, same steps as `AGENTS.md`
   Step 1 (**APIs & Services → Credentials → Create credentials → OAuth
   client ID**, type **"TVs and Limited Input devices"**). Leave the existing
   client running untouched.
2. **`.env`:** point `AGENT_OIDC_CLIENT_ID` / `AGENT_OIDC_CLIENT_SECRET` at
   the **new** client's values.
3. **CLI:** from `terraform/`, run `./apply.sh plan` then `./apply.sh`. This
   updates the pinned `google_secret_manager_secret_version.agent_oidc_client_id`
   / `.agent_oidc_client_secret` references in `terraform/cloudrun.tf` —
   **forces a revision roll.**
4. **Verify on the new revision**, per `AGENTS.md`'s own post-deploy check:
   an unauthenticated `POST /api/agent/device/start` returns `200` with a
   `verification_uri`, `user_code`, and `poll_token` (never a redirect to
   `/login`, never the raw `device_code`). Also run one real device-grant
   poll end to end if you can, to exercise the token exchange against the new
   client before deleting the old one.
5. **Only after Step 4 passes: Console:** delete the *old* OAuth client. This
   is the deliberate "break" step, taken last, once nothing depends on the
   old secret anymore.

## Step 3 — `AUTH_SECRET`

**Confirm the Prerequisites section above is done — `AGENT_KEY_SECRET` must
already be set — before you run this step.** If it is not, stop here and go
set it first; otherwise this rotation also invalidates every live agent key.

**Blast radius:** every active session, immediately, on the rolled revision.
Do this in a quiet window and tell any active users to expect to log back in.

```bash
cd terraform
./apply.sh plan -replace=random_password.auth_secret
./apply.sh apply -replace=random_password.auth_secret   # confirm 'yes' when applying
```

Use `./apply.sh`, not a bare `terraform apply` — see the explanation in Step 1
above: without `./apply.sh` sourcing `.env` via `load_env_tfvars`, the agent
OIDC and `AGENT_KEY_SECRET` `TF_VAR_*` values fall back to `""` and this apply
would destroy the very `AGENT_KEY_SECRET` secret that Prerequisite 3 just
created, in the same apply that rotates `AUTH_SECRET`.

This regenerates `random_password.auth_secret` → a new
`google_secret_manager_secret_version.auth_secret` → the pinned `version`
reference at `terraform/cloudrun.tf:124` changes → **forces a revision
roll**, and every NextAuth session token signed with the old secret stops
verifying the moment the new revision takes traffic. After the roll,
confirm interactive login (and OIDC login, if configured) both work against
the new revision before considering the rotation complete.

## Step 4 — Bootstrap admin credential: DELETE, don't rotate

**Do not rotate `fileshare-admin-user`/`fileshare-admin-pass` through Secret
Manager or Terraform.** `scripts/bootstrap-admin.js` — the only consumer of
those two secrets — checks `SELECT COUNT(*) ... WHERE username = ?` and exits
without touching the row if the username already exists (lines 51–56). Once
the admin user has been created once, changing `ADMIN_PASS` in Secret Manager
and re-running the bootstrap job is a no-op against the live password: the
job sees the existing row and skips it. "Rotating" this credential the same
way as the others would silently do nothing while looking like it worked.

The correct remediation is to change the password through the app itself,
then delete the bootstrap credential apparatus outright — there is no reason
to keep a standing Secret-Manager-backed username/password once the one-time
bootstrap it existed for has already run.

1. **In-app (owner action, browser):** log in as the bootstrap admin (or any
   admin account) and change the password via the existing self-service flow
   — `PATCH /api/account` with `currentPassword` + `newPassword`
   (`src/app/api/account/route.ts`). Confirm you can log back in with the new
   password. This step needs no `gcloud`/`terraform` access at all.
2. **`gcloud` (owner action):**
   ```bash
   gcloud secrets delete fileshare-admin-user --project=PROJECT_ID --quiet
   gcloud secrets delete fileshare-admin-pass --project=PROJECT_ID --quiet
   ```
   (substitute your `project_id` from `terraform.tfvars`)
3. **`terraform state rm` (owner action, from `terraform/`):**
   ```bash
   terraform state rm google_secret_manager_secret.admin_user
   terraform state rm google_secret_manager_secret_version.admin_user
   terraform state rm google_secret_manager_secret.admin_pass
   terraform state rm google_secret_manager_secret_version.admin_pass
   ```
4. **Remove the `.tf` blocks — all three files, in the same change, or the
   next `terraform plan` breaks:**
   - `terraform/secrets.tf`: delete the `google_secret_manager_secret.admin_user`,
     `google_secret_manager_secret_version.admin_user`,
     `google_secret_manager_secret.admin_pass`, and
     `google_secret_manager_secret_version.admin_pass` resource blocks.
   - `terraform/iam.tf`: remove `google_secret_manager_secret.admin_user.secret_id`
     and `google_secret_manager_secret.admin_pass.secret_id` from the
     `fileshare_app_secret_ids` local (lines 102–103). **This one is easy to
     miss** — neither `terraform/secrets.tf`'s own teardown comment nor
     `deploy.sh`'s printed post-deploy summary mentions it, but it is an
     unconditional reference (not gated by any `count`/`for_each`), so leaving
     it in place after deleting the blocks above fails `terraform plan` with
     "Reference to undeclared resource."
   - `terraform/cloudrun.tf`: delete the entire `terraform_data "bootstrap"`
     resource — this is the "bootstrap job's secret wiring" the AC for this
     step calls out. It's not enough to edit its `--set-secrets=ADMIN_USER=
     fileshare-admin-user:latest,ADMIN_PASS=fileshare-admin-pass:latest` line:
     the resource's own `depends_on` list also references
     `google_secret_manager_secret_version.admin_user` and `.admin_pass`
     directly — the same "undeclared resource" failure as above, and this one
     is **certain on the very next `terraform plan`**, independent of whether
     the resource's `local-exec` ever runs again. (It likely won't run again
     soon on its own: `triggers_replace = [var.container_image]` only fires
     when that variable's literal value changes, and per
     `terraform.tfvars.example` / `common.sh`'s `IMAGE` construction it stays
     a static `:latest`-tagged string across every `./deploy.sh` run — only
     the digest behind the tag changes, which a plain string variable can't
     observe. But it is still a landmine: if `container_image` is ever pinned
     to a digest, or the resource is force-replaced with `terraform apply
     -replace=terraform_data.bootstrap`, its local-exec's final
     `gcloud run jobs execute ... --wait` line — which runs unconditionally,
     outside the create/skip check — would fail against a job whose secret
     bindings point at secrets that no longer exist.) Removing the whole
     resource avoids both the immediate and the deferred failure: the job it
     managed was one-time by design and has already done its job.
   - Also delete the live job object so nothing in GCP still points at the
     deleted secrets: `gcloud run jobs delete fileshare-bootstrap
     --region=REGION --project=PROJECT_ID --quiet` (substitute your
     `cloud_run_job_name` if you overrode the default).
   - Optional cleanup: remove `bootstrap_admin_user` / `bootstrap_admin_pass`
     from `terraform.tfvars` (per `terraform/secrets.tf`'s own comment) and,
     if you don't intend to ever re-bootstrap a fresh environment from this
     checkout, the `bootstrap_admin_user`/`bootstrap_admin_pass` variable
     declarations in `terraform/variables.tf` too.
5. **`./apply.sh plan`** — expect only destroys/removals for the four secret
   resources (already gone from state, so likely no-op) and the
   `terraform_data.bootstrap` resource (already deleted from GCP by hand, so
   also likely no-op); confirm no unrelated diff appears, then `./apply.sh`.
   **Forces a revision roll only if the main service's env changed** — it
   normally does not, since `ADMIN_USER`/`ADMIN_PASS` were only ever wired
   into the one-time job, not the live Cloud Run service; verify this by
   reading the plan output rather than assuming it.

## Related runbooks

- `docs/runbooks/tfstate-migration.md` — must be complete before any step
  above; also the place `AUTH_SECRET`/`CLEANUP_SECRET`'s exposure history is
  documented in full.
- `terraform/iam.tf` — carries the two-apply `revoke_project_secret_accessor`
  sequence for the per-secret Secret Manager IAM migration; unrelated to
  rotation itself but relevant if you are touching `iam.tf` for Step 4 above
  in the same sitting.
- `AGENTS.md` — the agent device-grant setup this runbook's Step 2 rotates;
  see its "Rotation" section for the pinned-secret-version mechanics that
  apply to every step here.

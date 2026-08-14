# Terraform state migration: local file -> GCS backend

**Status: this is a runbook for the OWNER to execute by hand. No `terraform
init`, no `terraform init -migrate-state`, no `terraform apply`, and no
`gcloud storage buckets create` have been run as part of producing this
document or the accompanying `terraform/main.tf` change.** The GCS backend
block in `main.tf` is live in the Terraform config, but Terraform has not
been pointed at it yet — that only happens when you run Step 4 below.

> **⚠ Interim state — the deploy scripts are blocked until you finish this
> runbook.** From the moment the `main.tf` backend change merged, any
> `./deploy.sh` run aborts at `terraform init` with "Backend configuration
> changed" and any `./apply.sh` run aborts with "Backend initialization
> required". That is deliberate fail-closed behavior, not breakage to route
> around: do NOT run `terraform init -migrate-state` casually to make the
> error go away — that is Step 4 of this runbook and must happen only after
> Steps 1–3 (state backup, bucket creation, IAM grant). Complete the
> migration before the next deploy.

## Why this exists

`terraform/terraform.tfstate` (plus its automatic backup copies) has held
every production secret in plaintext for months: `AUTH_SECRET`,
`CLEANUP_SECRET`, the agent OIDC client secret, and the bootstrap admin
username/password all appear in the resource attributes of `random_password`
and `google_secret_manager_secret_version`. A local state file has no access
control, no locking (two concurrent `terraform apply` runs can corrupt it),
and no durability (it is one `rm -rf` or one dead laptop away from gone). A
GCS backend fixes all three: bucket IAM controls who can read it, GCS
provides native state locking, and versioning + soft delete give you a
recovery window.

As of this writing, `random_password.auth_secret` and
`random_password.cleanup_secret` show the **same value across every state
serial since creation** — neither has ever been rotated. Migrating the
backend does not rotate anything by itself; **Step 6 below hands off to the
separate secret-rotation runbook** (`docs/runbooks/secret-rotation.md`,
task 13) that actually rotates those values. Treat this migration as
"stop the bleeding" (secrets stop living in an uncontrolled plaintext file
going forward), not as "the compromise is resolved."

## Before you start

- You need your own `gcloud` user credentials (not a service account key) with
  permission to create a bucket and set IAM on it in the `pubsec-se` project.
  Application Default Credentials (`gcloud auth application-default login`)
  is what the `google` Terraform provider and the GCS backend both use.
- Terraform >= 1.6 is already required by `terraform/main.tf`; the native
  `gcs` backend type needs no additional provider or plugin.
- Do this from a machine and directory you are not about to reformat. Step 1
  below makes an out-of-repo copy of the current state *before* anything else
  happens, specifically so that a botched `-migrate-state` has a recovery
  path.
- Confirm you are on a checkout that includes task 11's Terraform correctness
  fixes (`terraform/cloudrun.tf`'s `AUTH_URL` variable, the container image
  `ignore_changes` lifecycle block, pinned secret versions, per-secret IAM) —
  merged at commit `1657f07` on `main`. Verify with
  `git merge-base --is-ancestor 1657f07 HEAD && echo ok` — it must print `ok`.
  (Don't gate on `git log -1 -- terraform/cloudrun.tf`: history simplification
  makes a path query print the task's work commit, not the merge commit, so a
  literal comparison misleads.) **If it does not print `ok`, stop and update
  your checkout before continuing** — see the DO NOT APPLY warning in Step 5.

## Step 1 — copy the current state OUTSIDE the repo, before touching anything

This is the only step in this whole procedure that can lose state if it goes
wrong (`-migrate-state` rewrites where Terraform reads from). Make a
throwaway safety copy first, somewhere outside the git working tree (state
files are already gitignored and untracked, but "not in git" is not the same
as "backed up"):

```bash
mkdir -p ~/tfstate-migration-backup-fileshare
cp -a terraform/terraform.tfstate* ~/tfstate-migration-backup-fileshare/
```

This backup directory contains the same plaintext secrets the live state
does — handle it exactly as sensitively as the files you just copied, and
delete it (Step 6) once the migration is verified.

## Step 2 — create the bucket by hand with `gcloud`, NOT Terraform

Terraform cannot create the bucket that will hold its own state — that is a
bootstrap cycle (the backend config would need the bucket to exist before
`terraform init` can even parse it). Create it with `gcloud`:

```bash
gcloud storage buckets create gs://pubsec-fileshare-tfstate \
  --project=pubsec-se \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --soft-delete-duration=7d

gcloud storage buckets update gs://pubsec-fileshare-tfstate --versioning
```

- `--uniform-bucket-level-access` (UBLA) means access is governed entirely by
  bucket-level IAM, not a mix of IAM and legacy per-object ACLs.
- `--public-access-prevention` sets it to `enforced` (the flag is a boolean;
  there is no `=enforced` form — `--pap` is the short alias), making it
  impossible for any future IAM binding on this bucket to grant public
  access, even by mistake.
- `--soft-delete-duration=7d` plus `--versioning` together mean an accidental
  `terraform state rm`-style overwrite or object deletion is recoverable for
  a week, and every prior state version is retained as a separate object
  generation.
- The bucket name (`pubsec-fileshare-tfstate`) matches the `bucket` value
  already in `terraform/main.tf`'s `backend "gcs"` block — if you rename the
  bucket, update `main.tf` first, before Step 3.

> **⚠ If the create returns `409` ("bucket name is not available"), STOP —
> that is a hard failure, not "I must have created it earlier."** GCS bucket
> names are globally unique and this one has been visible in a public repo
> for months; a 409 means someone else may own it, and running Step 4's
> migration against a bucket you do not own would hand every production
> secret to whoever does.

**Ownership assertion (mandatory before Step 4).** Step 5's listing check
succeeds against any bucket you can read, so this is the only step that
actually proves the bucket lives in *your* project. Both commands must print
the same project number — if they differ or the second errors, STOP:

```bash
gcloud projects describe pubsec-se --format='value(projectNumber)'
gcloud storage buckets describe gs://pubsec-fileshare-tfstate --raw --format='value(projectNumber)'
```

(`--raw` is required — without it, gcloud SDK 571+'s default describe output
omits the project field entirely and the second command prints an empty
string, which reads as a false mismatch. Equivalent assertion if `--raw`
misbehaves on your SDK: `gcloud storage buckets list --project=pubsec-se
--format='value(name)' | grep -x pubsec-fileshare-tfstate` — the bucket
appearing in *your* project's own bucket list proves ownership.)

## Step 3 — grant access: ONLY the human operator, nobody else

```bash
gcloud storage buckets add-iam-policy-binding gs://pubsec-fileshare-tfstate \
  --member="user:YOUR_EMAIL@example.com" \
  --role="roles/storage.objectAdmin"
```

Replace `YOUR_EMAIL@example.com` with your own Google account. Grant this to
**yourself as an individual user**, not a group, not a service account.

**Neither the deploy service account (`github-deployer`) nor the app service
account (`fileshare-app`) gets any role on this bucket, and neither should
ever need one.** `.github/workflows/deploy.yml` — the only automated
pipeline that touches this repo's GCP resources — explicitly ignores pushes
that change anything under `terraform/**` (see its `paths-ignore`) and its
steps are `docker build`, `docker push`, and `gcloud run services update`;
it never invokes `terraform` in any form. Terraform only ever runs locally,
by a human, via `./deploy.sh` or `./apply.sh`. If you ever see a CI workflow
grow a `terraform apply`/`terraform plan` step, that is the point at which
this bucket's IAM would need revisiting — not before.

## Step 4 — `terraform init -migrate-state`

```bash
cd terraform
terraform init -migrate-state
```

Terraform will detect that `main.tf`'s backend block changed from `local` to
`gcs` and prompt:

```
Do you want to copy existing state to the new backend?
  ...
  Enter a value: yes
```

Answer `yes`. This copies (not moves) your current local state into the
bucket object `terraform/state/default.tfstate`; the local files are left on
disk untouched until you shred them in Step 6.

## Step 5 — verify BEFORE deleting anything

Do every one of these checks before Step 6. If any of them looks wrong, stop
and do not shred the local files — you still have them as a fallback.

**5a. State resource count matches.**

```bash
terraform state list | wc -l
```

As of this writing `terraform state list | wc -l` reports **46** against the
pre-migration local state (40 resource *blocks* — one of which,
`google_project_service.apis`, is a 7-way `for_each` over the required API
list and so alone accounts for 7 of the 46 lines, because `state list` prints
one line per *instance*, not per block). The migrate step is a byte-for-byte copy, so the
count after migration must be identical. (Treat "identical to what you had
before you started" as the invariant that matters, not the literal number
46 — recompute it yourself against your own pre-migration `terraform state
list` output if you want a belt-and-suspenders comparison.)

**5b. Secret-bearing resources are all still present.**

```bash
terraform state list | grep -E '^(google_secret_manager_secret\.|google_secret_manager_secret_version\.|random_password\.)'
```

As of this writing this should print **14 lines**: 6 `google_secret_manager_secret`
resources (`admin_pass`, `admin_user`, `agent_oidc_client_id`,
`agent_oidc_client_secret`, `auth_secret`, `cleanup_secret`), their 6
matching `google_secret_manager_secret_version` resources, and the 2
`random_password` resources (`auth_secret`, `cleanup_secret`) that generate
the actual `AUTH_SECRET`/`CLEANUP_SECRET` values. No interactive-OIDC client
secret (`oidc_client_secret`) appears here — that secret is not configured in
this project's state, so it is correctly absent from this list.

**5c. The remote object actually exists.**

```bash
gcloud storage ls gs://pubsec-fileshare-tfstate/terraform/state/
```

Expect one object, `default.tfstate` (or more, once versioning has
accumulated history from later applies).

**5d. `terraform plan` — read-only, and DO NOT APPLY.**

Live state has never been applied against task 11's Terraform correctness
fixes (`AUTH_URL`/`CLEANUP_AUDIENCE` variables, the container-image
`ignore_changes` lifecycle block, pinned secret versions, per-secret Secret
Manager IAM, the `objectAdmin` -> `objectUser` bucket-role narrowing) — those
landed on `main` at commit `1657f07` but the state you just migrated
predates all of it. Running `terraform plan` now will therefore show a real,
expected diff, not an empty one. Before running it:

1. **Set `auth_url` in `terraform.tfvars` to the service's real live URL
   first.** `auth_url` defaults to `""`, and with that default a plan (and
   any apply) would try to **remove `AUTH_URL`/`CLEANUP_AUDIENCE` from the
   running service** — the exact regression this task exists to avoid
   shipping. The migrated state already has the service's real URL recorded
   from a prior apply that predates task 11 (the `service_url` output has
   existed since before this migration), so read it straight from Terraform
   rather than a separate `gcloud` call — the same command `terraform/variables.tf`'s
   own `auth_url` bootstrap-sequence comment documents for a brand-new
   service:
   ```bash
   terraform output -raw service_url
   ```
   Put that exact value into `terraform.tfvars` as `auth_url = "https://..."`
   before proceeding.
2. Run the plan:
   ```bash
   terraform plan
   ```

**Expected diff shape** (this is the "known pre-existing AUTH_URL and image
drift" plus every task-11 change state has not seen yet):

- `AUTH_URL` and `CLEANUP_AUDIENCE` env vars being **added** to the Cloud Run
  service template — this is the AUTH_URL drift: the running revision has
  always had a real `AUTH_URL` value (NextAuth needs it to function at all),
  but state never recorded it because the variable didn't exist until task
  11. This is expected and correct, *provided* you set `auth_url` in Step
  5d.1 to match reality — if you skipped that, this line will instead show
  `AUTH_URL` being removed, which is the regression, not the fix.
- New `google_secret_manager_secret_iam_member` resources being created (the
  per-secret IAM bindings), with the existing project-level
  `google_project_iam_member.fileshare_app_secret_accessor` binding
  **unchanged** (it is only removed once you separately set
  `revoke_project_secret_accessor = true` in a *later*, deliberate apply —
  see the two-apply sequence documented as comments in `terraform/iam.tf`;
  this runbook does not repeat it).
- The file bucket and DB bucket's `google_storage_bucket_iam_member` role
  changing from `roles/storage.objectAdmin` to `roles/storage.objectUser`.
- Secret env var references switching from `"latest"` to an explicit
  `google_secret_manager_secret_version` version number.
- The Cloud Run service's container **image field should show NO diff**.
  Task 11 added a `lifecycle { ignore_changes = [...] }` block on exactly
  that field, so Terraform stops trying to reconcile it against whatever
  `container_image` currently resolves to. If you instead see Terraform
  trying to revert the image to an older tag, task 11's `ignore_changes`
  block is missing from your checkout — that is the "image drift" this AC
  warns about, and it means you are not actually on commit `1657f07` or
  later. **STOP. Do not apply.** Re-check the "Before you start" section
  above.
- `cloud_run_max_instance_count`'s new validation block, `allow_dev_cors_origin`'s new
  variable, and similar additions from task 11 showing as no-op or
  informational.
- Expect **exactly one kind of `-/+ forces replacement`**: the two
  `google_storage_bucket_iam_member` resources for the file bucket and the
  DB bucket. `role` is part of this resource's identity (the API has no
  "update a binding's role" operation — Terraform must remove the old
  grant and add the new one), so a replace here is the intended
  `objectAdmin` -> `objectUser` narrowing landing, not a red flag. Do **not**
  expect a replace anywhere else — most importantly not on
  `google_cloud_run_v2_service.fileshare` itself (a service replace means a
  new URL hash, which is exactly what `auth_url`'s lifecycle postcondition
  exists to catch) or on anything in `wif.tf` (unrelated to this diff, but
  see `docs/runbooks/wif-claim-pinning.md` for why replacing that resource
  is dangerous). If you see a `-/+` on anything other than the two bucket
  IAM member resources, stop and understand why before going any further.

**Do not run `terraform apply` from this runbook, under any circumstances,
against this plan.** Applying is a deliberate, separate action for the
owner to take once satisfied with the plan above, on their own schedule —
this task's job ends at producing a verified, unapplied backend migration.

## Step 6 — shred the local state files, then check backups elsewhere

Only after Step 5 fully checks out. There are **five** local state files to
destroy: `terraform.tfstate`, `terraform.tfstate.backup`, and any
`terraform.tfstate.<epoch>.backup` files (Terraform writes these numbered
backups on `-migrate-state` runs and destructive operations). The following
glob covers all of them:

```bash
cd terraform
# macOS does not ship GNU shred. Install it via coreutils, or fall back to rm.
brew install coreutils   # provides gshred
gshred -vzu -n 3 terraform.tfstate*
```

If you don't want to install coreutils, `rm -f terraform.tfstate*` is the
fallback — but be aware of the caveat below.

**Shredding is best-effort hygiene, not a security boundary, and does not
change what you do next.** On an SSD (which is what most modern laptops and
Cloud Build/Cloud Run-adjacent workstations use), wear-leveling means the
filesystem can relocate blocks silently, so an overwrite-based tool like
`shred`/`gshred` has no guarantee of actually overwriting the original
physical blocks — this has been true of macOS's own `rm -P` for years, which
is exactly why it isn't recommended here. Delete the local `.tfstate` files
for hygiene and to stop editors/backup tools from continuing to pick them
up, but:

- **Treat every value that ever appeared in these files as compromised,
  regardless of how thoroughly you shred them.** `AUTH_SECRET`,
  `CLEANUP_SECRET`, the agent OIDC client secret, and the bootstrap admin
  password all need to go through `docs/runbooks/secret-rotation.md`
  (task 13) — shredding the file is cleanup, not remediation.
- Also check, and clear if present, every other place these files could have
  been copied to without your having typed a command for it:
  - **Time Machine** — if Time Machine has been running on this machine,
    every historical local backup snapshot may still hold a copy of
    `terraform.tfstate*`. Either exclude the repo directory from Time
    Machine going forward, or accept that pre-migration snapshots retain
    the plaintext secrets until they age out (same "treat as compromised"
    conclusion above).
  - **Cloud-synced directories** — if this repository, or any parent
    directory, lives inside Dropbox, Google Drive, iCloud Drive, or a
    similar sync client, check that service's own version history / trash
    for retained copies of the `.tfstate` files, and remove them there too.
  - **Editor backups and swap files** — Vim swap files (`.terraform.tfstate.swp`),
    JetBrains IDE local history, and VS Code's local backup/history storage
    can all have captured a copy of an open `.tfstate` file's contents.
    Search your editor's local history/undo storage for `terraform.tfstate`
    and purge any hits.
- Finally, delete the out-of-repo safety copy from Step 1:
  ```bash
  rm -rf ~/tfstate-migration-backup-fileshare
  ```

## Provider lock file (`.terraform.lock.hcl`)

`terraform/.terraform.lock.hcl` is now tracked in git (it is no longer listed
in `.gitignore`) — provider version and hash pinning is switched on. This is
independent of the backend migration above; it just means `terraform init`
on a fresh checkout resolves and verifies the exact provider versions and
hashes already recorded, instead of silently re-resolving to whatever the
latest matching version happens to be at the time. If you ever intentionally
bump a provider version, do it with `terraform init -upgrade` and commit the
resulting diff to this file deliberately — don't delete it to "fix" a lock
mismatch.

## Related runbooks

- `terraform/iam.tf` carries the two-apply sequence for the per-secret
  Secret Manager IAM migration (`revoke_project_secret_accessor`) as inline
  comments — this document cross-references it rather than repeating it.
- `docs/runbooks/secret-rotation.md` (task 13) is the follow-on: once this
  backend migration is complete and verified, every secret that ever lived
  in the local state files gets rotated there, in a specific
  least-disruptive-first order.

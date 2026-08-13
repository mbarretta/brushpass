# WIF / octo-sts claim-pinning runbook

**Status: octo-sts change is live-safe and can ship freely; the Terraform (WIF)
change is staged only.** No `terraform apply`, no `terraform init
-migrate-state`, and no GitHub API write have been executed by the task that
produced this document — every `gh api` and `gcloud` call used while drafting
it was a read (`git refs/tags`, `git tags`, `providers --help`), and the diff
in `terraform/wif.tf` sits unapplied for the owner to `terraform plan` and
apply by hand.

## Why this exists

Both the octo-sts trust policy for `update-digests.yml` and the GCP Workload
Identity Federation (WIF) condition for `deploy.yml` matched any GitHub
Actions token minted for **this repository on `refs/heads/main`** — not the
specific workflow file the token was supposed to be for. This repo is public
with no required reviews, and `.github/workflows/claude.yml` also runs on
`main`-adjacent events with `id-token: write`. Without a workflow-level pin,
any main-branch workflow's OIDC token could satisfy either trust policy,
including one an attacker triggers by injecting a comment into `claude.yml`'s
`issue_comment` trigger. Both policies now additionally require the OIDC
token's `job_workflow_ref` claim (or, for the GCP CEL condition,
`assertion.job_workflow_ref`) to equal the exact workflow file that is
supposed to hold that privilege — `update-digests.yml` for octo-sts,
`deploy.yml` for WIF. `job_workflow_ref`, not `workflow_ref`, is the claim that
names the code that actually executes; only it cannot be spoofed by a caller
workflow.

## Two changes, two very different risk profiles

| Change | File | Risk if wrong | Why |
|---|---|---|---|
| octo-sts claim pattern | `.github/chainguard/digestabot.sts.yaml` | Low — fixable with a push | octo-sts reads its trust policy from the repository's **default branch**. A pull request cannot alter it, so an attacker cannot use a malicious PR to loosen this file, and if the owner's own edit has a typo the only symptom is `update-digests.yml` failing to federate a token on its next scheduled run — annoying, not a lockout. |
| WIF `attribute_condition` | `terraform/wif.tf` | **High — up to ~30 days of broken deploys** | See the next section. This is the one that needs the procedure below, in order, before `terraform apply`. |

Apply the octo-sts change first and independently. It does not depend on the
Terraform change and carries none of its risk.

## THE LOCKOUT RISK — read this before running `terraform apply` on wif.tf

`google_iam_workload_identity_pool_provider.github`'s provider ID is
hardcoded as `github-oidc`, and `.github/workflows/deploy.yml` hardcodes the
full resource path
(`projects/759231903324/locations/global/workloadIdentityPools/github-pool/providers/github-oidc`)
in its `google-github-actions/auth` step. If a Terraform update to this
resource is expressed as a **replace** instead of an **in-place update** —
shown in `terraform plan` output as `-/+ must be replaced` rather than
`~ update in-place` — Terraform destroys the existing provider and recreates
it. GCP does not delete a workload identity pool provider immediately: it
**soft-deletes** it for approximately **30 days**, during which the provider
ID `github-oidc` is held and cannot be reused to create a new provider with
the same name. Because `deploy.yml` hardcodes that exact ID, this is not a
brief blip — it is roughly a month where every push to `main` fails to
federate and nothing deploys, until either the soft-delete window expires or
the owner manually intervenes (see the recovery path below).

Adding a `&&`-ed clause to an *existing* `attribute_condition` string is not
expected to trigger a replace — `attribute_condition` is not one of this
resource's `ForceNew` fields, and the Google provider's update path includes
`attributeCondition` in the resource's update mask, meaning the API supports
patching it in place. That said, **do not take this document's word for it**.
The three-step procedure below is the actual gate; treat the reasoning above
as motivation for following it, not as a substitute for it.

### Step 1 — confirm the exact `job_workflow_ref` claim value before writing Terraform

Before trusting the literal string baked into `terraform/wif.tf`
(`${var.github_repository}/.github/workflows/deploy.yml@refs/heads/main`),
confirm GitHub actually issues that exact value for a real run of
`deploy.yml`. Add a **temporary** workflow, trigger it once by hand, read the
result, then delete it. It must print only the individual claim **fields** —
never the raw ID token itself, which is a bearer credential for the duration
of the run.

```yaml
# .github/workflows/tmp-confirm-oidc-claims.yml — TEMPORARY, delete after use.
name: TEMP - confirm OIDC claims
on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  print-claims:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch the ID token and print selected claim fields only
        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7
        with:
          script: |
            const token = await core.getIDToken(
              'https://iam.googleapis.com/projects/759231903324/locations/global/workloadIdentityPools/github-pool/providers/github-oidc'
            );
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
            // Print only these four fields. Never log `token` itself — it is
            // a live bearer credential for the GCP audience above.
            core.info(`job_workflow_ref: ${payload.job_workflow_ref}`);
            core.info(`repository:       ${payload.repository}`);
            core.info(`ref:              ${payload.ref}`);
            core.info(`sub:              ${payload.sub}`);
```

Trigger it via `workflow_dispatch` on `main` (a `workflow_dispatch` run is not
a write this document performs — it is the *owner's* action, run by hand).
Confirm the printed `job_workflow_ref` reads exactly
`mbarretta/brushpass/.github/workflows/deploy.yml@refs/heads/main`. If it
doesn't match what's in `terraform/wif.tf`, fix the Terraform string to match
reality before proceeding — do not fix reality to match a guess. Delete the
temporary workflow file once confirmed; it has no purpose after this step and
its `id-token: write` permission is otherwise unused attack surface.

### Step 2 — `terraform plan`, read it, and require in-place update

```bash
cd terraform
terraform plan
```

Find `google_iam_workload_identity_pool_provider.github` in the plan output.

- **`~ update in-place`** — safe. Proceed to `terraform apply`.
- **`-/+ must be replaced`** (or `-` then `+` as two separate actions) —
  **stop. Do not apply.** This is the lockout scenario described above. Do
  not proceed until you understand *why* it wants to replace rather than
  update (an unrelated field also changed? a provider version bump altered
  the resource schema?) and have resolved that cause, or have accepted the
  ~30-day outage window and prepared for it.

This read-and-confirm step is not optional and not a formality — it is the
one gate standing between "safe in-place update" and "deploy.yml is broken
for a month."

### Step 3 — if it goes wrong anyway: gcloud recovery, independent of WIF

If the provider is deleted (accidentally applied a replace, or a manual
`gcloud`/console deletion), recovery does **not** depend on WIF or on
`deploy.yml`'s own federated credentials — it runs through the owner's own
`gcloud` user credentials, authenticated independently of the broken pool.
Within the ~30-day soft-delete window:

```bash
gcloud iam workload-identity-pools providers undelete github-oidc \
  --workload-identity-pool="github-pool" \
  --location="global" \
  --project="pubsec-se"
```

This restores the provider under its original resource name (including the
hardcoded `github-oidc` ID `deploy.yml` expects), with its configuration as of
just before deletion. After undeleting, re-run `terraform plan` to confirm
Terraform's state and GCP's live state agree again before trusting deploys to
resume automatically — the soft-deleted-then-undeleted provider is the same
resource GCP-side, but Terraform state may need reconciling if `apply` had
already tried to create a *replacement* resource under the same logical
address.

If the 30-day window has already lapsed and the provider is permanently
gone, there is no `gcloud` recovery — the fallback is creating a new
provider (a new `terraform apply` under a new `workload_identity_pool_provider_id`,
since the old ID cannot be reused until the original soft-delete window
fully expires) and updating the hardcoded resource path in `deploy.yml`
accordingly. This is the scenario Step 2 exists to prevent; it is significant
enough manual work that it should not be reached in practice.

## After ac1 and ac2 are live and verified

Per the parent task's notes: once the octo-sts pin and the WIF condition are
both applied and confirmed working (a real `update-digests.yml` run federates
successfully; a real `deploy.yml` push-to-main run federates and deploys),
consider removing `id-token: write` from `.github/workflows/claude.yml` and
`.github/workflows/claude-code-review.yml` entirely — they don't federate to
any external OIDC-trusting service today, so the permission is currently
unused surface. The claim pins in this document are the real control either
way; that follow-up is belt-and-braces and deliberately **not** part of this
change, since it depends on ac1/ac2 having been observed working in
production first, which this task cannot do (see the operational boundary
above).

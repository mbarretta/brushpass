# Branch protection runbook

**Status: not yet applied.** This document is the deliverable of the CI-hardening
task that added the `test` and `lint` jobs to `.github/workflows/ci.yml`. No
implementer has run any of the commands below — every `gh api` call in this repo
is read-only until the owner executes this runbook by hand.

## Precondition — contexts must exist before they're required

GitHub's branch protection can only require a status *context* (a check-run
name) that has already reported at least once against the repository. Require a
context that has never run and every PR hangs forever on "Expected — waiting for
status to be reported," with no way to merge.

So the order is:

1. Merge the PR that adds the `test` and `lint` jobs (this task) **first**, on
   its own, with no protection change bundled in.
2. Let that PR's own CI run report all three contexts — `docker-build`, `test`,
   `lint` — at least once (its own `pull_request` run satisfies this).
3. Confirm CodeQL has reported too (see below — it already runs on a schedule
   independent of this PR).
4. Only then run the `gh api` call in this runbook.

If a digestabot PR is open at the moment you apply the change, it was opened
before the new required contexts existed and will stall waiting for `test` and
`lint` to report on its head commit. Close it — the next scheduled
`update-digests` run reopens it against the current required-check set — or push
an empty commit to its branch to force GitHub to re-evaluate.

## Correction to the source plan: there is no single "CodeQL" context today

The remediation plan that produced this task assumed a stable aggregate
`CodeQL` context, distinct from per-language `Analyze (...)` names. That
assumption was checked against this repo's live state on 2026-08-13 (read-only
`gh api repos/mbarretta/brushpass/commits/main/check-runs`) and does not hold
here: code scanning is on GitHub's **default setup** (not a checked-in
`codeql.yml` workflow), and default setup reports one check run **per
language**, not one umbrella run. That live query returned two CodeQL check
runs — `Analyze (actions)` and `Analyze (javascript-typescript)` — plus
`deploy` (`deploy.yml` runs on push to `main`, unlike `docker-build`, which only
runs on `pull_request` and so never shows up on `main`'s own commits at all).
The `docker-build`, `test` and `lint` names don't need a live query to confirm —
they're exactly the `name:` value of their job in `ci.yml`, self-evident from
the workflow file. Only the CodeQL names came from live state:

```
Analyze (actions)                (CodeQL default setup, confirmed live)
Analyze (javascript-typescript)  (CodeQL default setup, confirmed live)
```

The plan's own caution — "don't require the per-language names, they change if
the language set changes" — is real risk, but there is no alternative name to
require *without* also moving code scanning off default setup and onto a
checked-in workflow with one non-matrixed job (out of scope for this task: it
touches security-scanning configuration, not CI wiring, and deserves its own
review). Given that, this runbook requires the two names that exist **today**,
and calls out the residual risk explicitly below rather than silently requiring
a name that doesn't exist.

**Before running the command below**, re-verify the current names — the
language set may have changed since this was written:

```
gh api repos/mbarretta/brushpass/commits/main/check-runs \
  --jq '.check_runs[].name'
```

Update the `contexts` array in the call below to match whatever that prints.

**Residual risk, accepted for now:** if GitHub adds or removes a CodeQL
language for this repo, the `Analyze (<language>)` context names change and the
branch protection rule silently stops enforcing on the old name (GitHub does not
error — it just never reports a check with that name again, so the requirement
sits permanently unsatisfied... which manifests as every future PR blocking, not
silently passing). Re-run the check-runs query above after any change to the
repo's language mix or to `.github/workflows/*.yml` that could affect what
CodeQL analyzes, and update the protection rule to match.

## The exact call

```bash
gh api \
  --method PUT \
  repos/mbarretta/brushpass/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "docker-build",
      "test",
      "lint",
      "Analyze (actions)",
      "Analyze (javascript-typescript)"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Notes on the fields:

- `strict: false` — "require branches to be up to date before merging" is left
  off. This is a single-collaborator repo with a solo human maintainer plus
  digestabot; turning `strict` on would force a rebase-and-rerun cycle on every
  PR whenever anything else lands first, for no safety benefit here. Turn it on
  later if a second human collaborator joins and PR concurrency actually
  happens.
- `contexts` — see the correction above; re-verify the CodeQL names before
  running this.
- `enforce_admins: true` — the repo owner is also the only admin, so without
  this the whole protection rule is advisory for the one person it exists to
  protect against fat-fingering a direct push.
- **`required_pull_request_reviews: null` is deliberate, not an oversight.**
  This repo has exactly one human collaborator. GitHub does not allow a PR
  author to approve their own pull request, so enabling required reviews with
  one collaborator makes every one of that collaborator's own PRs permanently
  unmergeable — and it equally blocks digestabot's PRs, which rely on
  auto-merge with no human review step at all (`.github/workflows/update-digests.yml`).
  Turning this on would be a full self-lockout, not a hardening measure. If a
  second trusted human collaborator is ever added, revisit this field then —
  not before.
- `restrictions: null` — no push restrictions; the human owner and the
  octo-sts-scoped digestabot token both need to be able to push/merge.

## The one-command escape hatch

If required contexts get stuck (a context renamed, a workflow deleted, a
digestabot PR wedged) and `main` needs to be unblocked immediately:

```bash
gh api --method DELETE repos/mbarretta/brushpass/branches/main/protection
```

This removes branch protection entirely in one call — no confirmation prompt,
no partial state. Re-apply the call above once the underlying issue (a renamed
context, a fixed workflow) is resolved.

## Verifying after apply (read-only, safe to run anytime)

```bash
gh api repos/mbarretta/brushpass/branches/main/protection
```

Confirm: `required_status_checks.contexts` lists the fixed three —
`docker-build`, `test`, `lint` — plus however many `Analyze (<language>)`
entries CodeQL's language matrix currently produces (two, as of this writing).
Also confirm `enforce_admins.enabled` is `true`, and that there is no
`required_pull_request_reviews` key in the response (its absence is what "null"
looks like on read-back).

## Do not require `claude-review`

`.github/workflows/claude-code-review.yml` runs an LLM review and is
intentionally **not** in the required-contexts list. An LLM call is the least
deterministic step in this repository's CI; making it a required check converts
an occasional flaky API response or rate limit into a fully blocked repository.
Treat it as informational only.

## No write performed by this task

Every `gh api` invocation used while drafting this runbook was a **read**
(`GET .../protection`, `GET .../check-runs`, `GET .../code-scanning/default-setup`)
to verify the exact current state before writing this document. No
`branches/main/protection` `PUT`, no `DELETE`, and no other `gh api` write was
executed by this task. The owner runs the command in "The exact call" above
by hand, after re-verifying the CodeQL context names as instructed.

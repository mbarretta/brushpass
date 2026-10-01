# Move base images to the `barretta.dev` Chainguard org on `latest`, drop digestabot

## Context

Chainguard is moving to a new org, `barretta.dev`, on a free account. Free accounts can't pin image digests, so base images must float on `latest`. That makes the digest-pinning automation (digestabot) pointless. Separately, Dependabot PRs (#151, #105, #106) fail `docker-build` because `setup-chainctl` can't assume `CHAINCTL_IDENTITY` (`wanted auth.chainguard.dev`); the identity is org-scoped, so the new org needs a new identity, and that fix folds into this work.

Decisions already made: `git pull --ff-only` (local `main` is 48 commits behind), remove digestabot, runner image is `node:latest`, image path is `cgr.dev/barretta.dev/node:<tag>`.

## Approach

Work on a branch off the freshly pulled `main`, e.g. `chore/chainguard-org-latest`. One commit, one line, conventional-commits, no attribution (per CLAUDE.md). PR to `main`. All paths below are current `origin/main`.

### 1. Sync
`git pull --ff-only` (tree is clean), then create the branch.

### 2. Dockerfile (`Dockerfile:1-4,35`)
- Builder: `FROM cgr.dev/barretta.dev/node:latest-dev AS builder` (drop `@sha256`).
- Runner: `FROM cgr.dev/barretta.dev/node:latest AS runner` (was `26-slim`; free tier has no `-slim`).
- Replace the "digests pinned 2026-04-09 / refresh with imagetools" header with a note that images float on `latest` because the free tier can't pin.
- Keep the existing native-module smoke test (`RUN node -e "new (require('better-sqlite3'))..."`), which is the main guard against a floating base breaking `npm ci`. Note the Dockerfile relies on Node >= 26 / npm 12 `allowScripts` behaviour, so `latest` must stay >= 26.

### 3. Remove digestabot
Delete:
- `.github/workflows/update-digests.yml`
- `.github/chainguard/digestabot.sts.yaml`

Edit references only:
- `.github/workflows/claude-code-review.yml:38-40`: drop the `allowed_bots: 'octo-sts[bot]'` line and its comment. Dependabot is already allowed, so leave the rest alone.
- `.github/workflows/ci.yml:34`: reword the `docker-build` comment, since it no longer gates digestabot PRs.
- `terraform/wif.tf:36`: comment-only mention of `digestabot.sts.yaml`; reword. No resource change, and the WIF condition already pins to `deploy.yml`, so no `terraform apply` is needed.
- `docs/runbooks/branch-protection.md` (lines ~25-28, 171, 184-190, 195) and `docs/runbooks/wif-claim-pinning.md` (octo-sts rows ~13-36, 175-176): remove or trim the octo-sts/digestabot sections and rows. Keep the WIF guidance.

### 4. Org path and wording
- `README.md:17-18`: image refs to `cgr.dev/barretta.dev/node:latest-dev` and `:latest`.
- `.github/workflows/ci.yml:22,27-28` and `.github/workflows/deploy.yml:36`: comments say "barretta/node base images pinned in the Dockerfile"; reword to `barretta.dev/node`, unpinned.
- `GCP_DEPLOYMENT_PLAN.md:22,97`: doc mentions of `cgr.dev` credentials; update org wording if it names `barretta`.
- Leave alone: `.npmrc:3` and `README.md:29` (`libraries.cgr.dev` is a host, not org-scoped), `.claude/plans/*` (historical), and the `chainguard.dev` email fixtures in `tests/`.

### 5. Out-of-repo steps (I can't do these; you do them)
- In the `barretta.dev` Chainguard org, create or confirm an identity for GitHub Actions that trusts `https://token.actions.githubusercontent.com` for `mbarretta/brushpass`, including pull-request runs and Dependabot's `sub`, with pull access to `cgr.dev/barretta.dev/node`.
- Update `CHAINCTL_IDENTITY` in both stores:
  - `gh secret set CHAINCTL_IDENTITY` (Actions)
  - `gh secret set CHAINCTL_IDENTITY --app dependabot`
- Confirm `cgr.dev/barretta.dev/node:latest` and `:latest-dev` exist and work with `USER 65532`.
- Delete the now-unused octo-sts / digestabot GitHub App install if desired.

## Verification
1. `docker login` to `cgr.dev` for the new org locally, then `docker build -t brushpass:local .`. This checks `npm ci`, `next build`, and the native-module smoke test on the new base.
2. `docker run` the image and hit `/` to confirm `next start` serves.
3. `npm run lint`, `npm run typecheck`, `npm test` (510 tests) still pass.
4. `git grep -nE "cgr\.dev/barretta/|sha256:|digestabot|octo-sts|update-digests"` on the branch shows no stale hits outside `.claude/plans/`.
5. Open the PR; `docker-build` should now go green. Then `@dependabot recreate` on #151, #105 and #106 and confirm their `docker-build` passes, then merge them.
6. After merge, confirm the Deploy workflow succeeds on `main` (it builds with the same Dockerfile).

## Risks
- `latest` can jump Node majors; the smoke test catches native-module breakage but not runtime behaviour changes. Rollback path is the Cloud Run `:${GITHUB_SHA}` tags deploy.yml already pushes.
- Deploy on merge (`paths-ignore` skips `.github/**` and `*.md`, but the Dockerfile change does trigger it), so the merge itself deploys the new base to production.

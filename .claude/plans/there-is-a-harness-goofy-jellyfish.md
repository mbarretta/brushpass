# Run `fix-security-remediation` via ultracode-orchestrated waves

## Context

The harness plan `.claude/plans/fix-security-remediation.json` is fully planned: 13 tasks across 9 waves (waves 1, 2, 6 are multi-task; the other six are single-task by verified file-conflict analysis), ending with a security audit and quality review over the consolidated diff. The user wants to run it with ultracode (the Workflow tool) doing the dispatch, with work routed to appropriately capable models — e.g. Sonnet for implementation, Opus for evaluation-style roles.

Two mechanisms compose here:

1. **The harness's native `plan.model_overrides`** (per-role: `task_runner`, `implementer`, `evaluator`, `security_auditor`, `quality_reviewer`; family aliases `"opus"|"sonnet"|"haiku"`). The runner passes `implementer`/`evaluator` aliases through its prompt to its nested Agent calls. Plugin recommendations (`references/model-routing.md`): implementer Sonnet, evaluator Sonnet (Opus when stakes are high), security_auditor Opus, quality_reviewer Sonnet. Nested-inheritance hazard: if `task_runner` is routed, pin `implementer` and `evaluator` explicitly or they silently inherit the runner's model.
2. **Workflow `agent()` per-call `model` option**, which additionally enables **per-task** routing (the plugin is per-role only and lists per-task routing as a future enhancement) — each runner's prompt is composed by the script, so task 5 (auth core) can get an Opus implementer while task 13 (runbook) gets Sonnet.

## Owner decisions (2026-08-13)

- **Evaluator model: Opus** — 58/100 critical ACs, each mapping to a live exposure.
- **Re-wave first** — recompute `parallel_plan` to overlap the code / CI / terraform chains before dispatching wave 1.
- **Execution shape: hybrid per-wave** — one Workflow per wave (single-task waves included, via runners), orchestrator validates/merges/transcribes between waves.

## Execution shape: hybrid, one Workflow per wave

The main session stays the harness orchestrator (Fable) and keeps everything requiring judgment: pre-flight, worktree creation, TASKREPORT validation + verdict transcription into the plan JSON, wave merges/consolidation, retry-escalation and gap-capture decisions, security-finding triage. Workflow invocations handle dispatch only.

Per wave:
1. Orchestrator pre-flight per `references/parallel-protocol.md` (clean tree, signing detection, staleness check), creates one worktree per task (`git worktree add ../fix-security-remediation-task-{id} -b harness/fix-security-remediation/task-{id}`), flips tasks to `in_progress`.
2. One `Workflow` call: `parallel()` over `agent(runnerPrompt, { agentType: 'mab-harness:harness-task-runner', model: <per-task alias>, schema: TASKREPORT_SCHEMA })` — runner prompts built from the template in `parallel-protocol.md` (plan path, worktree, base branch, verification cmd, signing flag, namespaced subagent types, per-task implementer/evaluator aliases). The runner owns the implement → evaluate → ≤2-retry loop internally.
3. Orchestrator validates each TASKREPORT (consistency table, verdict parse, `final_commit_sha` git cross-check), transcribes verdicts, merges per phase 7, updates plan JSON, proceeds to next wave.
4. Single-task waves: dispatch through a runner as well (one-agent workflow or direct Agent call) rather than the harness's inline default — keeps the main context clean across a 9-wave cycle and keeps model routing uniform. Deviation from session-protocol inline flow is deliberate; note it in the plan log.
5. End of cycle: `harness-security-auditor` (Opus) per phase 7.5, then `harness-quality-reviewer` per phase 7.6 (sequential per protocol), triage in main session, then plan completion + `_index.json` update.

Ultracode benefits captured: journaled resume (`resumeFromRunId` replays completed waves from cache if a run dies), shared token-budget accounting, schema-validated TASKREPORTs, per-task model routing, deterministic dispatch.

## Model routing (decided)

Set in `plan.model_overrides` (role baseline) + per-task aliases in the wave scripts:

| Role | Alias | Note |
|---|---|---|
| task_runner | sonnet | children pinned explicitly below (inheritance hazard) |
| implementer | sonnet | **per-task bump to opus for tasks 5 and 6** (auth core / transport hardening, subtle Auth.js + proxy semantics), routed via the runner prompt in the wave script |
| evaluator | **opus** | owner decision — 58/100 ACs critical |
| security_auditor | opus | plugin's firm recommendation; runs once |
| quality_reviewer | sonnet | bump to opus if consolidated diff > ~2000 lines (likely here — revisit at phase 7.6) |

## Step 0 — Re-wave (before any dispatch)

Owner chose to recompute `parallel_plan` first. Run the harness's phase-4.5 conflict analysis again with the goal of overlapping the three semi-independent chains — code (1,2,4 → 3,7 → 5 → 6), CI/deps (8 → 9,10), terraform/runbooks (11 → 12 → 13). Expected compression: ~9 waves → ~4–5. Hard constraints to preserve in the recompute:

- `.gitignore` is shared by tasks 10, 11, 12 — they can never co-wave.
- `package.json`: task 8 before task 10 (task 8 vacates the scripts block).
- Dependency edges unchanged: 3,5,7←2; 6←5; 9,10←8; 12←11; 13←12.
- Parallelism cap 4 per wave (plan `parallelism: "auto"`); if a round would hold 5 (e.g. 1,2,4,8,11), split by the cap, largest-blast-radius tasks first.
- Terraform module still treated as a shared unit (11 and 12 serial).
- Append a `log` entry recording the recompute and update `waves.total` in `_index.json`.

## Risk to verify first

Runners need nested-subagent support from inside a workflow agent context. Probe with the first re-waved round: if runners return `outcome: runner_degraded`, fall back to the harness's native same-turn Agent dispatch (legacy evaluator wave) — nothing lost.

## Execution order

1. Re-wave: recompute `parallel_plan` per Step 0; get owner eyes on the new lattice before dispatch.
2. Set `plan.model_overrides`: `{"task_runner": "sonnet", "implementer": "sonnet", "evaluator": "opus", "security_auditor": "opus", "quality_reviewer": null}` (quality reviewer decided at 7.6 based on diff size).
3. Dispatch waves per the hybrid shape above, one Workflow per wave, per-task implementer bumps for tasks 5/6.
4. Consolidate per harness phase 7 between waves; run phase 7.5 security audit (Opus) and phase 7.6 quality review after the last wave; triage; mark plan complete and update `_index.json`.

## Verification

- Per task: evaluator VERDICT PASS against acceptance criteria; `npm run lint && npm test && npm run build` (plan verification command) per wave consolidation.
- Cycle end: security audit clean (or findings triaged to remediation tasks), 284-test baseline green, plan status flipped with `_index.json` updated.
- Operational boundary preserved: tasks 11–13 (+ branch-protection/WIF/Dependabot steps) produce runbooks only — critical ACs already enforce no `terraform apply`/`init -migrate-state`/secret rotation/`gh`/`gcloud` writes by any agent.

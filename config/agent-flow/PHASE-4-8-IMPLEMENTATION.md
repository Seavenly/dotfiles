# Phase 4-8 repository implementation evidence

Date: 2026-07-16

Status: local implementation complete; live rollout evidence pending

This record separates completed repository behavior from evidence that can
only be collected through model-backed workers, a real forge, and live operator
UI. Phases 4 through 8 are implemented locally. Their live rollout portions and
the Phase 9 real-run prerequisite remain incomplete in this restricted
environment.

## Phase 4 - feature flow

Implemented:

- A versioned feature graph with approved-slice materialization and a bounded
  planner fallback.
- One launcher-owned branch and worktree for every tester, builder, retry,
  completeness fix, critique fix, and command gate.
- Deterministic controller transitions for semantic retries, completeness
  fixes, critique fixes, cap exhaustion, and `RE_PLAN` blocking.
- Final verification against a clean committed head, authoritative review
  evidence, local-review manifest creation, and registry insertion.
- Terminal Hermes producer and validator attempts are rebound at finalization,
  and review manifests consume immutable validator-owned artifact snapshots.
- Shared `agent-flow-feature` skill exposure for every supported harness
  without colliding with Claude's legacy command.

Local evidence covers worktree pinning, serialized dependencies, retry
exhaustion, non-testable gates, incomplete acceptance, missing critic verdicts,
resume/tamper rejection, final manifest SHAs, registry creation, and production
controller measurements derived from terminal-attempt evidence or sealed gate
outputs without controller-authored intermediary files.

Command-gate outputs are named and hashed by the terminal Hermes attempt. A
behavioral gate failure completes as controller input instead of blocking the
retry controller. Feature launch uses the shared external-root ownership
boundary, rejects terminal relaunch, and reconstructs transition counters from
the materialized Hermes topology rather than trusting controller JSON.

## Phase 5 - spike flow

Implemented:

- Quick research and synthesis without a product worktree.
- Deep parallel research angles, a gap critic, named bounded revisions,
  retained evidence, residual gaps, and final synthesis.
- An optional prototype path that creates exactly one worktree and reuses the
  serialized feature slice chain under an experiment path.
- Terminal synthesis evidence is rebound to Hermes attempts and the final
  result consumes the validator-owned report snapshot.
- Shared `agent-flow-spike` skill exposure without a Claude command collision.

Local evidence covers parallel joins, bounded gap-specific revision, cap
behavior, evidence retention, residual-gap synthesis, the absence of a
research-only worktree, prototype path containment, command-result-derived
prototype retry, and visible root/controller blocking at retry exhaustion.

Resume audits recovered dynamic cards against stage authority, sealed
instructions, role, workspace, retry limit, dependency parents, tenant, and
terminal-attempt state. Prototype worktrees are rebound to the originating Git
common directory, and transition counts reconstruct from materialization.

## Phase 6 - epic flow

Implemented:

- Epic dependency validation, bounded ready-wave planning, source and target
  pinning, one source worktree, and shared feature launcher reuse.
- Serialized feature integration through a temporary verification worktree,
  source-refresh merges, changed-head re-review, optional human review
  preservation, atomic source ref advancement, and recoverable integration
  receipts.
- Target checkpoints that create a new stack generation requirement on drift.
- A normative `agent-flow.run/v1` bundle, sealed epic graph, roles, skills and
  gates, plus an audited Hermes epic root and tenant.
- Executable bounded source-refresh transitions materialized into Hermes on
  target drift, with promotion bound to passed sealed command results and a
  terminal passed semantic review.
- Child feature manifests bound to the epic by `parent_run_id`, with ready-set
  projection reconstructed from child run authority, Hermes lifecycle, Git,
  and integration receipts before each wave.
- One-comment external progress projection.
- Shared `agent-flow-epic` skill exposure without a Claude command collision.

Local evidence covers dependency cycles, wave caps, duplicate resume, source
movement, review invalidation after head movement, integration receipt
recovery, target drift generation, and progress-comment idempotency.

`epic-state.json` remains a durable projection for feature identifiers and
receipt paths, not a scheduler. Before wave admission, lifecycle and integrated
status reconstruct from sealed child manifests, Hermes attempts, Git ancestry,
and receipts. The local restart tests cover this authority boundary; a stopped
and resumed model-backed epic is still required as rollout evidence.

## Phase 7 - stacks

Implemented:

- The upstream `split` skill remains unchanged. The derivative
  `agent-flow-stacks` skill
  records its upstream revision and semantic differences in `LINEAGE.md`.
- Deterministic hunk analysis, exact assignment validation, stable plan
  fingerprints, and explicit human approval bound to one generation.
- True linear branches built in temporary worktrees, exact per-layer ownership,
  exact final-tree proof, durable partial failure receipts, and non-destructive
  rollback instructions.
- Suffix restacking into new generation refs without rewriting an approved
  prefix or force-pushing, after a separate human approval fingerprints the
  changed head, owning layer, and next generation.
- Promotion of a verified restack into the active generation consumed by
  publication and delivery, with exact hunk-ownership checks for review edits.
- Idempotent remote branch/PR operations with source and target reconciliation.
- A sealed forge coordinate reconciled before publication.
- Proof that both the active GitHub selection and Git `origin` resolve to that
  sealed forge coordinate before any remote mutation.
- Replay selected as the delivery assembly policy in ADR 0005 after local
  merge, squash, and replay prototypes.

Local disposable repositories cover three-layer plans, early/middle/final
review edits, source preservation, exact ancestry and trees, target movement
before branch creation, between PR creation, and during suffix restacking.
Intermediate PR bodies are proven not to contain external completion keys.

The opt-in prototype against a non-production remote with the work
repository's actual protection and merge policy was not run because external
network and service mutation were unavailable. This is rollout evidence, not a
remaining local implementation path.

## Phase 8 - delivery

Implemented:

- Delivery initialization from an approved stack generation only after exact
  source-tree proof and current source/target reconciliation.
- Replay of approved reviewed layers, durable partial assembly receipts, and
  retargeting of the next layer PR.
- Source, target, and delivery-ref reconciliation before mutations.
- Exact source/delivery tree equality and full verification in a detached
  temporary worktree.
- One idempotent completion PR only after both gates, with an explicit draft
  checkpoint when current-base and required-check policy cannot be proven.
- Canonical per-layer review registration. Delivery seals each approved review
  path and digest, requires its unique tuicr registry entry and intact event
  evidence, and rejects caller-selected or mutated substitutes.
- An explicit checkpoint-approval operation that reruns current target, exact
  tree, and full verification before making an unsafe-policy draft ready.
- Target drift while open returns the PR to a non-completing posture.
- Every remote delivery operation rechecks repository identity, and merge
  observation rejects a completion merged from any base other than the exact
  approved target SHA.
- External completion only after the observed merge tree equals verified
  delivery and the merge commit is present on the target.

Local fault injection covers partial assembly, failed
retarget, stale review, changed source, target drift before and during delivery,
target drift while the completion PR is open, equal-size unequal trees, failed
full verification, intermediate issue-key suppression, completion PR
idempotency, and merge observation.

All versioned derivative artifacts now have registered JSON contracts:
`spike-result`, `epic-state`, `stack-state`, and `delivery-state`. Persistence
and resume paths reject structurally malformed state. Stack publication and
delivery completion additionally reconstruct topology, refs, exact trees, and
sealed verification commands instead of treating a schema-valid status as
authority. Epic readiness and feature/spike transition counts reconstruct from
sealed materialization, Hermes lifecycle, Git, and receipts.

## Verification record

- `npm test` in `config/agent-flow`: 214 passing tests after the final authority,
  state-reconstruction, and controller hardening. The two finalizer tests also
  passed five consecutive isolated repetitions after canonical-path review.
- `./dotfiles check`: passed Bash and Zsh syntax, behavior tests, isolated-home
  convergence, JSON, TOML, shellcheck, credentials, lock, and source checks.
- `git diff --check`: passed.
- `node --check config/agent-flow/src/cli-command.mjs`: passed.
- Real Hermes v0.18.2 profile loading passes in the isolated integration test.
- A disposable Hermes full backup produced a valid ZIP; disposable Kanban GC
  completed with no live-state mutation.

## Rollout evidence still required

- Real model-backed review, feature, spike, and epic runs on a sacrificial
  board after the final implementation revision is installed.
- The non-production remote stack and delivery prototype.
- A fresh detailed visual inspection of the Kanban dashboard and tuicr picker.
  The in-app browser had no available runtime backend in this environment.
- A live Hermes backup before rollout. The sandbox could read live Hermes
  state but could not create Hermes' snapshot under `~/.hermes`.
- A non-destructive active-run prune/rollback rehearsal. No run is deleted as
  part of this implementation record.

Independent review findings around terminal evidence, generic status and
cancellation, dynamic resume,
external-root ownership, controller counters, native epic ownership,
source-refresh execution, restack approval and promotion, exact hunk ownership,
canonical layer reviews, draft-checkpoint advancement, stale-base merge
observation, and forge identity are closed locally.
The remaining limits are environmental evidence: model quality, live restart,
actual forge policy, rendered UI, and live backup/rollback. Stack and delivery
human checkpoints are durable and explicit but still rely on the invoking OS
user identity rather than an external approval service. Claude remains the
authoritative fallback until Phase 9's real-run comparison and separate user
decision.

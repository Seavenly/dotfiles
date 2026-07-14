# Hermes agent-flow implementation plan

Status: approved on 2026-07-13. Phase 1 is complete; Phase 2 awaits explicit
approval after review of this foundation.

This plan sequences small, reversible tracer bullets. Each phase ends with a
reviewable commit and must satisfy its exit criteria before the next phase
starts. The existing Claude flows stay operational throughout.

## Phase 0 - approve the contracts

Scope:

- Review this design, the ADR, graph definitions, profile inventory, and JSON
  Schemas.
- Resolve only contradictions that would change an interface or invariant.
- Record approval before creating profiles, commands, graphs, registry
  migrations, or Git refs.

Exit criteria:

- The six-profile inventory, native routing overlay, graph transitions, local
  review lifecycle, and one-completion-PR model are accepted.
- The review tracer is confirmed as the first executable slice.

Rollback: documentation-only edits can be revised without runtime migration.

## Phase 1 - converge profiles and machine-local routing

Depends on: Phase 0.

Repository changes:

- Add `CONTRACT.md`, `hermes/SOUL.md`, `hermes/config.yaml`, and
  `hermes/distribution.yaml` for the six profiles under
  `config/agents/profiles/`.
- Add a model-neutral routing example under `config/agent-flow/` and create
  `~/.config/dotfiles/hermes-routing.yaml` as a secure empty skeleton when it
  is missing.
- Add a Node-based native YAML renderer under `config/agent-flow/`.
  Use the locked `yaml` package, deep-merge maps, replace arrays and scalars,
  reject unknown profiles and secret-like keys, validate native config shape,
  and atomically render regular files with mode `0600`.
- Extend the bootstrap finalizer to install locked Node dependencies before
  rendering profiles. Preserve every Hermes-owned state file and unmanaged
  profile.
- Converge profile homes at `~/.hermes/profiles/<name>/` and target them as
  `hermes -p <name>`. Do not add six generic global command aliases. Never
  replace `.env`, `auth.json`, memory, sessions, logs, board databases, or
  workspaces.
- Add the minimal `bin/agent-flow` interface with only `doctor profiles`.
  Doctor checks an explicitly validated Hermes release, initially v0.18.2,
  complete routing, credentials available to each selected provider, exactly
  one dispatch-owning gateway, and the effective worker tool schemas.

Tests:

- Unit-test merge precedence, array replacement, atomic failure, file mode,
  missing and partial overlays, unknown profiles, and secret-key rejection.
- Run convergence twice in an isolated home and prove idempotency.
- Seed colliding and differently named unmanaged profiles plus Hermes runtime
  files and prove preservation unless force takeover is explicit.
- Run collision detection before mise creates profile links, and migrate the
  pre-marker managed layout without requiring force.
- Spawn or inspect each profile through Hermes and assert the actual tools:
  controller only Kanban; analyst and critic bundled file tools with a reported
  non-enforceable read-only contract; builder code tools; artifact file tools
  with declared-path contracts; gate terminal with no direct file edit tools.
- Prove only the flow-controller gateway dispatches and built-in decomposition
  is disabled.
- Run an offline integration test against every installed, explicitly
  supported Hermes release; skip clearly when no supported release is present.

Exit criteria:

- All six stable profile names resolve on both personal and work-style fixture
  overlays without tracked model names.
- The critic route uses a provider distinct from the builder route.
- `agent-flow doctor profiles` can explain every unavailable lane before a run
  is launched.

Rollback:

- Stop the flow-controller gateway, remove only managed aliases, ownership
  markers, and rendered config files, and restore the previous convergence
  revision.
- Keep credentials, profile state, and Kanban data untouched.

## Phase 2 - build the CLI seam and local review tracer

Depends on: Phase 1.

Repository changes:

- Expand `bin/agent-flow`, already containing profile doctoring, as a thin
  launcher for the Node ESM module under `config/agent-flow/`.
- Use locked `ajv` for the published schemas and the locked `yaml` package for
  native configuration and gate specs. Do not add a database.
- Implement internal modules for input loading, schema validation, board
  resolution, graph construction, idempotency keys, Hermes CLI JSON calls,
  root materialization, status projection, and deterministic gate execution.
  The Hermes adapter is the only seam that shells out to `hermes kanban`.
- Implement only `doctor profiles`, `launch review`, `gate`, and `status` in
  this phase.
- Add `agent-flow.graph/v1` review graph data and gate specs for deterministic
  finding caps and rendering.
- Create a disposable repository fixture and a sacrificial named Kanban board
  for the real tracer.

Tests:

- Unit-test graph output and the CLI through a fake Hermes adapter at the same
  interface used by production.
- Test duplicate launch, interrupted materialization, missing profile,
  malformed handoff, semantic failure, operational retry, and partial graph
  recovery.
- Prove the root is never runnable before every required link exists.
- Run the real local review tracer and demonstrate profile routing, parallel
  lens join, orientation and diagram side work, urgency floors, comment caps,
  gateway restart recovery, dependency block/unblock, human block/unblock, a
  visible protocol violation, and dashboard readability without raw logs.

Exit criteria:

- Re-running the same launch returns the same card IDs and does not duplicate
  work.
- `agent-flow status` explains complete, running, blocked, retrying, and broken
  runs using board state and artifact pointers only.
- A restart resumes native Hermes attempts without launcher polling.

Review gate: inspect the tracer and its dashboard before broadening the CLI.

Rollback:

- Stop dispatch, archive the sacrificial board, and remove the new command
  link. Preserve the board and run directory until the tracer review finishes.

## Phase 3 - make the review manifest and registry durable

Depends on: the Phase 2 review gate.

Repository changes:

- Implement `agent-flow review transition` and
  `agent-flow review record-comments` with atomic manifest writes and explicit
  transition validation.
- Change `tuicr-reviews add --manifest <review.json>` to store a manifest path
  plus projection metadata. The manifest remains review truth.
- Preserve the legacy `tuicr-reviews add --repo ...` interface used by the
  Claude feature flow. Mark legacy entries explicitly rather than breaking or
  silently migrating them.
- Preserve the first seven columns of the current `list` TSV interface and
  append lifecycle and health columns. Add `list --json` for new callers.
- Update `tmux-tuicr-reviews` to display lifecycle and health, retain missing
  worktrees as broken entries, distinguish run identity from session slug, and
  open the immutable base-SHA to head-SHA range.
- Read tuicr comments by stable ID, record them only after durable disposition,
  and invalidate approval when the head changes.

Tests:

- Cover idempotent add, legacy add, every legal and illegal transition,
  approved head binding, stale approval, branch drift, missing worktree,
  immutable picker revsets, comment consumption, duplicate comments, and
  terminal pruning.
- Prove a registry rebuild from manifests yields the same picker projection.
- Re-run current tmux and Claude feature-flow compatibility tests.

Exit criteria:

- A moving branch cannot make an old approval look current.
- A vanished worktree remains visible and blocks integration.
- Starting tuicr is always an explicit interactive action.

Rollback:

- Continue reading the append-only compatible registry format with the old
  picker fields. Do not delete manifests or legacy entries.

## Phase 4 - implement the feature graph

Depends on: Phase 3.

Repository changes:

- Add the locally authored shared `feature-flow` skill under
  `config/agents/skills/`. It needs no `LINEAGE.md` unless upstream material is
  incorporated. Expose it to Hermes and the agent-neutral scope, but not to
  Claude while the same-named Claude command exists. Update portfolio tests to
  encode this deliberate harness exposure matrix.
- Implement approved-slice static materialization and the planner fallback.
- Implement tester -> builder -> gate -> controller chains, capped semantic
  retries, completeness checks, independent critique, capped fix slices,
  `RE_PLAN` human blocking, `review-summary.md`, final verification, review
  manifest generation, and registry insertion.
- Make one launcher-created worktree and branch the only feature write target.
- Keep push and PR creation outside the flow.

Tests:

- Prove every builder, tester, retry, and fix card receives the same absolute
  worktree.
- Prove dependencies prevent concurrent feature writes across a long graph.
- Cover missing tests, non-testable verification specs, failing gates, retry
  exhaustion, uncovered acceptance, critic failure, non-blocking deferral,
  `RE_PLAN`, restart recovery, clean commit behavior, and manifest SHAs.
- Run an end-to-end feature in a disposable repository and review it through
  the Phase 3 picker.

Exit criteria:

- A clean run ends at a verified local review candidate with no remote
  mutation.
- Every incomplete or capped condition is visible on the root and in the
  review summary.

Rollback: disable the shared skill and archive its board tenant. The existing
Claude feature command remains unchanged.

## Phase 5 - implement spike graphs

Depends on: Phase 2 for research-only spikes and Phase 4 for prototypes.

Repository changes:

- Add the shared `spike-flow` skill without creating a Claude command
  collision.
- Implement quick research -> synthesis and deep parallel angles -> gap critic
  -> capped angle revision -> synthesis.
- Reuse the feature slice module for an optional dedicated prototype worktree.

Tests:

- Cover quick and deep graphs, parallel joins, gap-specific revisions, cap
  exhaustion, evidence retention across revision, synthesis with residual
  gaps, and prototype path restrictions.

Exit criteria: research-only spikes create no product worktree, while prototype
spikes create exactly one and surface every stuck slice in the report.

Rollback: disable the skill and preserve reports and prototype branches.

## Phase 6 - implement epic control and source integration

Depends on: Phases 3 and 4.

Repository changes:

- Add the shared `epic-flow` skill and its external-root adapter.
- Validate the feature dependency graph and materialize only bounded ready
  waves. Reuse the feature graph instead of embedding feature implementation.
- Give each feature one worktree, require automated review, honor any started
  human review, and serialize integration into `epic/source`.
- Before integration, merge the latest source into the feature branch, resolve
  conflicts through a builder revision card, rerun verification, and require
  re-review when the reviewed diff materially changes.
- Have the interactive skill update one external progress comment from
  `agent-flow status --json` at launch, resume, and human checkpoints. Do not
  build two-way synchronization or one external issue per feature.

Tests:

- Cover dependency cycles, ready-wave caps, duplicate resume, independent
  concurrency, serial integration, blocked features, optional human review,
  stale approval, source movement, conflict revision, unrelated-feature
  progress, and one-comment idempotency.

Exit criteria:

- The epic can restart and reconstruct its ready set from Kanban and Git.
- All integrated features exist on `epic/source`, but no completion PR exists.

Rollback: stop creating new waves, leave active feature reviews available, and
preserve `epic/source`. The external issue remains In Progress.

## Phase 7 - derive stacks and prove Git topology

Depends on: Phase 6 source output. This phase begins with disposable prototypes,
not production branch mutation.

Repository changes:

- Preserve the upstream `split` mirror unchanged.
- Create a derivative `stacks` skill with lineage pointing to `split` and
  documenting every local semantic change.
- Add deterministic helpers for hunk plans, true linear branch construction in
  a temporary worktree, exact tree checks, durable stack manifests, PR
  creation and retargeting, owning-layer review changes, suffix restacking, and
  partial-failure reporting.
- Require a human-approved layer plan before creating refs or PRs.

Prototype matrix:

- Prove local merge-commit, squash-merge, and replay assembly in disposable
  repositories with edits to early, middle, and final layers.
- Prove each PR diff contains only its review layer, later branches descend
  from earlier branches, source is never checked out or mutated, and the final
  layer tree exactly equals source.
- After local proof, run an opt-in remote prototype against a non-production
  repository configured with the target work repository's actual merge policy.

Exit criteria:

- Select and document one assembly policy that survives review edits and
  restacking without force-pushing a reviewed prefix.
- Demonstrate rollback instructions after failures at every mutation point.

Review gate: approve the proven merge policy before delivery automation.

Rollback: close only prototype PRs when authorized, retain the stack manifest,
and delete no branches automatically.

## Phase 8 - assemble delivery and enforce external completion

Depends on: the Phase 7 merge-policy gate.

Repository changes:

- Create `epic/delivery` from the configured target and assemble reviewed stack
  layers only into that branch.
- Retarget each next stack PR as its parent layer enters delivery.
- Add an exact Git tree equality gate for source and delivery, followed by the
  full delivery verification suite.
- Open the single completion PR from delivery to target only after both gates
  pass. Put the external issue key only where tracker automation is intended.
- Observe the completion PR merge before allowing the external issue to become
  Done.

Tests:

- Cover partial layer assembly, failed retarget, stale review, changed source,
  unequal trees despite equal stats, failed full verification, intermediate PR
  issue-key suppression, final PR idempotency, and merge observation.

Exit criteria: one final PR merge is the only event that reports the external
outcome complete.

Rollback: stop assembly, keep source immutable, and preserve delivery and stack
refs for inspection. Never force-push the target.

## Phase 9 - coexistence review and optional retirement

Depends on: successful real runs of review, feature, spike, epic, stacks, and
delivery flows.

Work:

- Compare Hermes results, failure visibility, artifacts, caps, and human gates
  with `config/claude/AGENT-TEAMS.md`.
- Run `dotfiles check`, isolated-home convergence tests, UI inspection of the
  Kanban dashboard and tuicr picker, restart recovery, backup, GC, and rollback
  rehearsals.
- Record retrospectives and make only evidence-backed contract changes.
- Present a separate retirement proposal. Do not remove Claude commands or
  workflows as an implied cleanup step.

Exit criteria:

- Parity gaps are either closed or explicitly accepted.
- The user separately approves whether Claude autonomous workflows remain,
  become compatibility adapters over Hermes, or retire.

Rollback: keep the Claude implementation authoritative and disable Hermes flow
skills. All durable Hermes and Git artifacts remain inspectable.

## Cross-phase release checks

Every implementation phase must also pass:

- `dotfiles check` and the relevant isolated-home convergence tests.
- Shellcheck and formatting for changed scripts.
- JSON Schema validation for all fixture and produced manifests.
- No tracked credentials, model names from local routing, raw logs, or generated
  runtime state.
- No changes to the public Claude command behavior unless that phase explicitly
  declares and tests a compatibility adapter.
- Rendered dashboard, review picker, and review artifacts inspected at the same
  quality bar as functional behavior.

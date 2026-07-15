# Versioned flow graphs

These graphs define `agent-flow.graph/v1`. They are normative stage and
dependency specifications for the first implementation. Hermes Kanban remains
the runtime state machine.

## Notation and common rules

```text
stage-key [profile; workspace; card-pinned skill]
```

An arrow `a -> b` means card `a` is a parent dependency of card `b`. A join
lists every required parent. Optional side cards become parents only when the
approved input enables them.

Every graph follows these rules:

1. The launcher validates and seals the immutable `agent-flow.run/v1`
   manifest before creating cards. Cards receive only paths and digests from
   that manifest; a resume with incompatible contracts or changed content
   blocks before dispatch. Standalone schema validation is not sufficient:
   launch and resume load the sealed graph and inputs, verify their hashes, and
   recompute the manifest's compatibility fingerprints.
2. The launcher creates the root blocked, creates cards with idempotency keys,
   links the terminal cards as root parents, validates the complete executable
   topology, and unblocks the root. The root is a required terminal
   flow-controller, every stage reaches it, and stage keys are globally unique
   across static stages and transition templates.
3. A controller that needs defined follow-up work verifies the run is active,
   the requested transition is declared, and its recorded run-wide limits
   remain available. It creates the chain with native Kanban tools and
   idempotency keys, links its terminal card as a parent of itself, calls
   `kanban_block(kind="dependency")`, and returns to `todo`. Hermes promotes it
   when the new parent completes. Status and resume independently audit these
   cooperative checks; they are visible policy, not a technical tool boundary.
4. A card ends with `kanban_complete` or `kanban_block`. Normal process exit
   without a lifecycle call is a protocol violation.
5. Operational failures use native worker retries. Semantic failures complete
   with a handoff containing `passed: false`; a controller applies the defined
   cap and transition.
6. A controller may instantiate only the transitions in this document. New
   stage shapes require a graph-version change. Every declared transition
   stage has a dependency path back to the transition's controller.
7. Every arrow from a non-gate worker to a machine consumer expands to
   `producer -> validate-handoff:<producer> [gate; run-dir] -> consumer`. The
   validator reads the completed attempt through the Hermes adapter and checks
   `agent-flow.handoff/v1`, run and stage identity, any optional worker attempt
   assertion, and the required `passed` value. It checks file-artifact
   containment and recorded hashes. For inline JSON or text, it owns stable
   serialization, enforces a 256 KiB aggregate serialized-content cap, and owns
   hashing. Approved roots come from the sealed run manifest,
   never from worker metadata or a supplied validation envelope. Invalid
   handoff metadata blocks at the validator and
   never releases the consumer. Verified bytes are snapshotted beneath the
   run's `validated/` directory; consumers never reopen the mutable source
   path. Diagrams omit these repeated validation cards for readability.
   The sealed gate names the producer stage, but not a task ID or attempt
   ordinal. After Hermes assigns card IDs, launcher-created task authority binds
   the validator to the concrete producer task without rewriting the sealed
   gate or run manifest. At execution, the validator derives the terminal
   completed attempt from Hermes and records that authoritative ordinal. If the
   handoff also declares an ordinal, the validator checks it against Hermes, so
   native retries do not invalidate the sealed gate. It writes exactly one
   declared `agent-flow.validation/v1` evidence file. Producer and validator
   authorities must pin the same run-manifest path and digest before artifacts
   are read. Invalid metadata and a failed required measurement persist evidence
   but fail the validator card. Timeout aborts validation as an operational
   failure so Hermes may retry the same card.
8. File artifact paths are absolute and live beneath an artifact root recorded
   in the run manifest. Inline artifacts have no worker path; the validator
   writes their stable bytes beneath the run's `validated/` directory. Phase 2
   write roots are contained by the canonical run `artifacts/` directory and
   are disjoint from sealed authority. Candidate worktrees are gate read roots,
   not artifact write roots.
9. Cancellation and supersession are terminal run operations. A controller
   must not create another transition after the root becomes terminal.
   Cancellation repeatedly sweeps cards that race the request, and status
   reports any survivor. The audited request is an append-only root comment;
   each tenant-scoped sweep reclaims observed running cards, archives
   nonterminal cards with the root last, and retries only while the survivor
   set is shrinking. Launch and cancellation share the host-local run mutation
   lock, and cancellation binds every receipt-selected card to its sealed task
   authority before mutation. External ownership is serialized by canonical
   repository and tracker-root identity. A successor names exactly one durable
   terminal ownership head in its immutable manifest. No archived card may be
   silently recreated under a new run ID.

## Review flow

The first tracer reviews a local `agent-flow.local-review/v1` manifest. A
remote PR adapter may later prepare the same manifest without changing this
graph.

```text
review-root [flow-controller; run-dir; review-flow-controller]

required lenses [analyst; candidate-worktree; review-lens]
  -> critic [critic; candidate-worktree; review-critic] -------------+
optional lenses [analyst; candidate-worktree; review-lens] ----------+
orientation [analyst; candidate-worktree; review-orientation] -------+-->
diagram [artifact; candidate-worktree; review-diagram] --------------+   finalize
                                                                        [gate; run-dir;
                                                                         review-finalizer]

finalize -> review-root
```

Dependency rules:

- Selected lens cards run in parallel.
- Critic depends only on required lens cards. It does not wait for orientation
  or diagramming.
- Finalize depends on critic and every enabled side artifact.
- `urgency: hotfix` omits orientation, diagramming, and every optional lens.
- `urgency: fast` and `urgency: standard` enable both optional lenses,
  orientation, and diagramming. Optional lens evidence joins at finalization;
  it is rendered with its semantic measurement, durable path, and digest rather
  than bypassing the critic to become a review comment. A blocking optional
  lens raises a merge-ready critic posture to merge-after-fixes.
- The finalize gate applies urgency floors, comment caps, finding identifiers,
  schema validation, and rendering deterministically.
- Finalize consumes sealed paths to handoff-validation evidence, never mutable
  worker artifacts. Launcher task authority binds each input path to the
  validator task that produced it; finalize rechecks the terminal validator and
  producer attempts through the Hermes adapter. Its typed operation payload
  binds critic and optional side inputs plus the structured result, Markdown,
  HTML, and unsubmitted draft outputs. The total cap is applied after urgency
  and per-tier caps.
- The root summary names findings, artifacts, omitted optional stages, and any
  protocol or recovery events. It never embeds raw worker logs.

Tracer acceptance requires demonstrated profile routing, a parallel join,
deterministic caps, gateway restart recovery, dependency and human
block/unblock, protocol-violation visibility, and a useful dashboard using only
card summaries and artifact links.

## Feature flow

### Planning fallback

When the approved plan already contains slices, planning cards are omitted and
the complete static slice graph is created at launch. Otherwise:

```text
planner [analyst; run-dir; feature planner]
  -> plan-controller [flow-controller; run-dir; feature plan controller]
  -> first tester
```

The plan controller validates the plan and materializes the static slice graph.
If plan approval is required, it blocks itself with `needs_input` and names the
plan path and approval question. It resumes the same card after a durable
comment. It does not ask a planner to invent arbitrary new stage types.

### Sequential slice chain

For approved slices `1..N`:

```text
tester:1 [builder; feature-worktree; tdd]
  -> builder:1 [builder; feature-worktree; implement]
  -> gate:1 [gate; feature-worktree]
  -> slice-controller:1 [flow-controller; run-dir; slice controller]
  -> tester:2
  -> builder:2
  -> gate:2
  -> slice-controller:2
  -> ...
  -> tester:N
  -> builder:N
  -> gate:N
  -> slice-controller:N
```

Every card in every slice points to the same absolute feature worktree. The
dependency chain prevents concurrent writes. The gate runs a checked-in gate
spec, captures commands, exit codes, output paths, and Git state, and commits
only when all required checks pass.

If a gate completes with `passed: false`, its slice controller may create:

```text
failed gate
  -> builder-retry:<slice>:<ordinal> [builder; same worktree]
  -> gate-retry:<slice>:<ordinal> [gate; same worktree]
  -> same slice-controller
```

The ordinal may not exceed `max_slice_retries`. Exhaustion blocks the same
controller with `needs_input` and names the verification artifact. A retry
never creates another worktree.

### Completeness, critique, and review candidate

```text
last slice-controller
  -> completeness [critic; feature-worktree; acceptance completeness]
  -> completeness-controller [flow-controller; run-dir; completeness controller]
  -> independent-critic [critic; feature-worktree; code review]
  -> critique-controller [flow-controller; run-dir; critique controller]
  -> review-summary [artifact; run-dir; synthesizer]
  -> final-verification [gate; feature-worktree]
  -> local-review-manifest [gate; run-dir]
  -> feature-root [flow-controller; run-dir; feature root]
```

The two controllers interpret their respective semantic measurements:

- The completeness controller turns uncovered acceptance criteria into capped
  fix slices using the same
  tester -> builder -> gate -> controller pattern, followed by a fresh
  completeness card.
- The critique controller turns only blocking independent-critic findings into
  capped fix slices, followed by a fresh independent critic. Non-blocking findings go to
  `review-summary.md` as deliberate follow-ups.
- `RE_PLAN` blocks the controller with `needs_input`; it never auto-replans.

The final verification gate requires a clean, committed candidate and writes
verification evidence. The manifest gate writes and validates
`review.json`, then registers it with `tuicr-reviews add --manifest`. Feature
flow does not push, open a PR, or move an external issue to Done.

## Local review lifecycle

Local review is a manifest state machine plus explicit Kanban revision cards,
not a hidden autonomous graph:

```text
review_ready -> reviewing -> changes_requested -> review_ready
             -> approved -> integrated -> archived

review_ready -> integrated
  only when human review is optional, no tuicr session was started,
  no human issue comment exists, and automated review passed
```

Derived health can be `current`, `approval_stale`, `head_mismatch`, or
`missing_worktree`. Health never silently changes the persisted lifecycle
state. Any health other than `current` blocks integration and is displayed by
the registry and `agent-flow status`.

Tuicr interaction proceeds as follows:

```text
review.json
  -> human starts tuicr explicitly
  -> session slug recorded
  -> new comments read by immutable comment id
  -> issue comments create review-revision-controller:<generation>
  -> revision tester cards
  -> builder -> gate -> independent critic
  -> manifest head SHA updated
  -> prior approval invalidated
  -> review_ready
```

`suggestion` comments require implementation or a recorded disposition.
`note` comments require an answer or acknowledgement. `praise` comments require
no action. Comment IDs are appended to `consumed_comment_ids` only after their
required Kanban cards or dispositions are durable.

Each review revision generation is an idempotent subgraph in the original
feature tenant and uses the original feature worktree. It never reopens a done
feature root or writes concurrently with another generation.

Approval records the current head SHA. Any head mismatch is stale approval,
including a head created by merging the latest `epic/source`; verification and
review run again before integration. Review transitions use an expected
manifest generation, and integration records a validated
`agent-flow.integration-receipt/v1` before the lifecycle advances.

## Spike flow

Quick mode:

```text
research [analyst; run-dir or read target; researcher]
  -> synthesis [artifact; run-dir; spike synthesizer]
  -> spike-root
```

Deep mode:

```text
angle:<name>... [analyst; run-dir or read target; researcher] --+
                                                               +-> gap-critic [critic; run-dir; gap analysis]
                                                               +-> revision-controller [flow-controller; run-dir]
                                                               +-> synthesis [artifact; run-dir]
                                                               +-> spike-root
```

When the gap critic reports `passed: false`, the revision controller creates
only angle-specific revision cards named by the critic. A reviser receives the
original findings and the gap, retains evidence that still holds, and repairs
the missing analysis. The configured revision cap is explicit in the card.

An optional prototype adds one dedicated prototype worktree after research and
before synthesis:

```text
prototype-planner [analyst; run-dir; prototype]
  -> sequential tester -> builder -> gate -> slice-controller chains
  -> synthesis
```

Prototype product writes remain under the approved experiment path. The
prototype never shares a worktree with another spike or feature.

## Epic flow

One external tracker outcome maps to the epic root. Internal feature streams
are Kanban cards unless exceptional external expansion criteria are met.

```text
epic-plan [analyst; run-dir; epic planner]
  -> epic-controller [flow-controller; run-dir; epic controller]

epic-controller
  -> bounded ready wave of feature-root:<feature> cards
       each feature root owns one feature graph and one worktree
  -> automated review for each review candidate
  -> optional local human review
  -> source-integration:<feature> [gate; integration worktree]
  -> epic-controller
  -> next ready wave

all features integrated
  -> source-verification [gate; epic/source worktree]
  -> stack-plan-checkpoint [flow-controller; run-dir; needs_input]
  -> epic-root
```

The epic controller creates only dependency-ready feature streams and never
exceeds the approved concurrency cap. Feature streams reuse the versioned
feature graph. Integration into `epic/source` is one gate card at a time. The
gate merges the latest source into the reviewed feature branch, resolves only
through an explicit builder revision card when needed, reruns verification,
requires re-review for every resulting head change, and then integrates without
force-push. The integration gate writes a receipt binding the reviewed head,
source ref, resulting commit, and resulting tree before the review manifest can
advance to `integrated`.

External progress is one updated comment with aggregate complete, running,
blocked, and review counts. `agent-flow status --json` derives the data from
Kanban and the interactive epic skill updates the external comment at launch,
resume, and human checkpoints. This does not add tracker authority to a worker
profile or create external stories for internal feature streams. The epic root
is not externally complete after source verification.

Before stack planning, the epic compares the configured target with the target
SHA recorded at launch. When it moved, the controller instantiates the declared
source-refresh transition:

```text
target-drift
  -> source-refresh-builder [builder; epic/source worktree]
  -> source-refresh-gate [gate; epic/source worktree]
  -> source-refresh-review [critic; epic/source worktree]
  -> source-verification [gate; epic/source worktree]
  -> stack-plan-checkpoint
```

The refreshed target SHA and new immutable source commit become a new approved
stack generation. They do not rewrite the original run manifest or reuse prior
stack approval.

## Stacks and delivery

The user-facing `stacks` skill proposes coherent review layers from a fixed
source commit and fixed target SHA and blocks for approval before any branch or
PR mutation.
Deterministic helpers then construct and validate the stack in a temporary
worktree.

```text
approved source commit + target SHA
  -> stack plan
  -> human approval
  -> layer-1 branch from delivery base
  -> layer-2 branch from layer-1
  -> ...
  -> layer-N branch from layer-(N-1)
  -> exact final-layer tree == source tree
  -> stack PR creation
```

The first stack PR targets `epic/delivery`; each later PR initially targets the
previous layer. No stack PR targets the configured completion target. When a
review change lands in layer K, the helper applies it to that layer and
restacks the unmerged suffix while preserving already-reviewed prefix state.

Reviewed layers assemble serially:

```text
reviewed layer 1 -> merge or apply to epic/delivery -> retarget layer 2
reviewed layer 2 -> merge or apply to epic/delivery -> retarget layer 3
...
reviewed layer N -> merge or apply to epic/delivery
  -> exact-tree gate: tree(epic/source) == tree(epic/delivery)
  -> full delivery verification
  -> completion PR: epic/delivery -> target
  -> completion PR merge
  -> external issue Done
```

The owning repository's merge policy determines whether a reviewed layer is
merged, squash-merged, or deterministically replayed into delivery. That policy
must first pass the disposable topology prototype in the implementation plan.
The invariant is exact final tree equivalence, not commit identity. Partial
failure leaves source unchanged, records created refs and PRs in the stack
manifest, and prints explicit rollback actions without deleting them.

Every remote mutation first verifies the stack generation's source commit and
target SHA. Target movement marks the stack and delivery stale and blocks
creation, retargeting, assembly, and completion. Recovery returns to the epic
source-refresh transition, produces a new stack generation, and requires new
human approval; it never restacks against a moving target implicitly.

For a standalone feature, the approved feature branch plays the source role
and a dedicated delivery branch plays the delivery role. The same fixed-target
and target-drift rules apply. Intermediate PRs omit an external issue key if it
could trigger premature automation. The completion PR is the only PR allowed to
mark the external outcome complete, and the remote repository must enforce a
current target base plus required checks or require an equivalent explicit merge
checkpoint.

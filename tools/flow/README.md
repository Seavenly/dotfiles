# Flow transition contracts

This directory contains the public transition contracts and the dark,
harness-neutral `flow` replacement. The replacement launch policy remains
disabled, so this API does not authorize normal replacement launches.

## Dynamic checkpoint runtime

`src/flow-runtime.mjs` exports `createFlowRuntime()`. The returned
`flow.runtime/v1` Interface exposes exactly five operations:

- `prepare(proposal)` compiles a complete `flow.dynamic-plan-proposal/v1` from
  caller-supplied facts. It creates no run and returns a deeply immutable,
  content-addressed `flow.prepared-run/v1` plus the complete confirmation view.
  Optional `flow.plan-revision-template/v1` values are part of that confirmed
  identity. Each template is bound to a typed card block and declares its
  complete card, edge, supersession, capability, resource, and limit changes.
  `explicit_facts.time_facts` carries the typed wall-clock,
  suspend-excluding-monotonic, boot, and clock-source readings, while
  `explicit_facts.subject_generations` carries exact generation fingerprints;
  both arrays are canonicalized into the prepared bundle.
  A block is admitted only from digest-bound
  `flow.card-block-observation/v1` evidence naming the registered Adapter and
  validator contracts. Revision templates declare their own application cap,
  while the proposal declares card, per-revision card, revision, capability,
  resource, and elapsed-time caps. In this slice, `elapsed_seconds` is an
  explicit preparation fact: revision admission checks a template's resulting
  cap against that bound value and does not observe ambient wall-clock time.
  Catalog v15 adds Jira parity through the provider-neutral tracker progress
  Adapter contract while preserving the authority-bound GitHub mechanism.
  Catalog v14 adds declared managed-agent reuse, exact-attempt independent
  fallback, caller-identified ordered steering, and recoverable delegate
  cancellation settlement. Catalog v15 adds typed reboot admission with exact
  contract, route, resource, subject-generation, and unresolved-effect
  revalidation plus uncertainty-safe elapsed limits. Catalog v16 binds the
  current revision resource and limit facts and permits exact positive
  one-shot adoption while retaining fail-closed absence and uncertainty.
  Each unresolved effect must have a typed
  `flow.reboot-effect-recheck/v1` record with exact identity, current
  non-indeterminate evidence, and the recovery classification declared by its
  effect policy. Exact present or absent evidence is allowed for safe
  non-one-shot classes; one-shot uncertain effects require exact present
  evidence and never retry on absence. Catalog
  v13 adds disposable, exactly watermarked
  Kanban, graph, timeline, trust, and operator projections rebuilt from
  `RunAuthority`, plus independently authoritative child-run creation,
  deterministic lineage, exact adoption, reconciled parent cancellation, and
  late-unclaimed output quarantine. Catalog v12 adds
  authority-bound GitHub tracker progress, exact workspace
  writer claims, durable taint dispositions, human-bound destructive authority,
  and cleanup previews to the workspace, artifact, and resource handoff
  interfaces introduced in v11, alongside the delegate-attempt execution
  introduced in v10. Delegate contracts
  include independently validated delegate
  evidence, distinct correlated `flow.delegate-quarantine/v1` records and
  blocks, a single Flow-owned Drovr feature baseline, and the exact working-turn
  cancellation proof required before a retryable delegate handoff. Catalog v9
  introduced irreversible cancellation, abandoned-attempt, late-effect
  quarantine, and observation-only cancelled settlement behavior. The exact v1
  requirements introduced in v7 for
  `explicit_facts.block_observations` on dynamic proposals and
  `revision_templates` on prepared runs remain required. Callers must prepare a
  fresh bundle rather than launch a pre-v12 envelope.
  This slice accepts the registered `flow.checkpoint/confirmation/v1`
  executor with `flow.validator/checkpoint-decision/v1`, one or more
  independently ready operation cards, one or more ordered
  `flow.delegated-agent-port/v1` delegate cards, or one
  `flow.subrun/create-and-observe/v1` child card.
  A one-shot uncertain operation must be bound only to an exact fresh
  checkpoint; safer effect classes may instead project an exact
  `operation_execute` command without adding human approval. The operation names a registered Adapter,
  declares its effect class, and binds its input, route, claims, validator, and
  attempt limit in the confirmed graph. A delegate card binds a compatible
  Drovr description, immutable route, prompt, bounded wait, validator
  contracts, and attempt limit in the same confirmed graph. A subrun card binds
  an exact confirmed child launch and immutable lineage inputs.
  External card-block acquisition by a live Adapter remains deferred; this runtime
  validates exact caller-supplied block observations before they can become
  authoritative.
- `launch({ prepared, confirmation, closed_facts })` accepts an explicit
  `flow.dynamic-plan-confirmation-decision/v1` and a separately supplied
  `flow.closed-fact-observation/v1`. It verifies both are bound to the prepared
  bundle, then atomically creates or adopts the content-derived run. Declining
  confirmation returns a typed rejection and creates no run. Repeating an
  accepted launch returns the same run identity and records no second launch
  event. Launch never invokes the plan compiler or refreshes identity-bearing
  facts; the caller supplies the closed observation.
  Invalid prepared bundles, confirmation decisions, and changed closed facts
  return typed launch rejections rather than escaping as transport errors.
  Launch also rejects operation cards with
  `unregistered_operation_contract`, `incomplete_operation_registration`, or
  `invalid_effect_classification` before any run or effect intent is created.
  Preparation rejects `unsafe_publication_effect_class` when a one-shot
  uncertain operation attempts to publish a resource handoff.
  Recovery performs the same registration check before mutating authority, so
  a replacement runtime cannot accept an effect it is unable to dispatch.
  Delegate launch also rejects an unavailable port, an incomplete Drovr
  feature baseline, or an unregistered output validator with a typed
  compatibility rejection before creating the run. The required-feature
  baseline is snapshotted when the runtime is constructed so one runtime cannot
  observe mutable launch policy; repairing it requires constructing a fresh
  runtime. Unreadable, invalid, and digest-mismatched baselines remain distinct
  typed compatibility failures.
- Backup and restore use the same five-operation Interface. A
  `command({ type: "backup_create" })` obtains one injected host observation
  and records an exact host operation intent before sending its canonical
  `flow.backup-manifest/v1` bytes to the backup Adapter. The manifest
  deterministically covers replacement authority, artifact manifests and
  bytes, legacy roots, external pointers, and Drovr obligations. The
  resulting identity-bound receipt is projected through the host watermark
  and can be queried with
  `query({ schema: "flow.query/v1", query: "backup" })`. A lost receipt keeps
  the intent in `reconciling` with an exact `backup_reconcile` action; a retry
  is legal only after the Adapter returns a
  `flow.backup-reconciliation-observation/v1` bound to the exact operation,
  manifest, and provider proof, proving the backup present or proving safe
  absence.
  `command({ type: "restore", manifest })` first records a host-wide
  `flow.restore-barrier-projection/v1`; launch, lifecycle commands, effects,
  and Work-domain mutations then return `host_reconciliation_required` until
  every legal `restore_reconcile` action proves the six evidence domains:
  database streams, artifact state, Git state, filesystem state, external
  effects, and Drovr obligations. Missing, corrupt, mismatched, or
  receipt-less observations remain failed at the named component and never
  produce a receipt. Stream suffixes must be valid digest identities, and
  replacement authority must include database streams, exact Git
  commit/tree/clean state, and filesystem state before any backup write or
  restore barrier entry. The legacy `git` and `filesystem` aliases are invalid.
  external-effect and Drovr obligations require receipts bound to their exact
  effect or turn identity. A Drovr turn may instead carry the strict named
  durable-holder handoff receipt. Only the exact watermarked `restore_admit` action
  clears the barrier. Use `watch({ host: true })` or
  `query({ schema: "flow.query/v1", query: "restore" })` for the disposable,
  authority-derived barrier projection.
- Catalog v19 publishes this host-recovery vocabulary as the source contract:
  exactly the five host commands above, the `backup` and `restore` registered
  queries, the host watch and barrier projections, and the intent, receipt,
  provider-observation, and reconciliation schemas, including named Drovr
  handoff receipts. RunAuthority remains the lifecycle authority;
  reconciliation is Adapter-only, intent precedes every host effect, and
  admission requires fresh exact evidence with unresolved effects closed.
- `command(command)` accepts the exact legal approve or decline checkpoint
  command projected by authority. A ready operation that does not require a
  checkpoint projects an exact `operation_execute` command. A
  `flow.card-block/v1` may instead project an
  exact `capability_grant` or `revision_decision`. Capability grants append the
  confirmed capability, named card binding, and trigger to accepted history;
  they do not grant that capability to unrelated cards. Revision decisions
  cite the current plan fingerprint and validated trigger. Accepting admits
  the template's complete change set in one authority event; declining records
  the negative outcome while leaving the blocked run active and its capacity
  reserved. A capped or otherwise
  inadmissible revision withholds acceptance but retains that exact decline
  action, so an active checkpoint-only run is never stranded without a legal
  operator action. When an accepted revision leaves every card completed or
  superseded and no effect unresolved, revision history, successful terminality,
  and capacity release commit atomically. A revision may
  supersede only its blocked card and pending dependent closure; completed
  cards, accepted checkpoint evidence, routes, grants, and earlier revisions
  remain unchanged, and no active card may depend on superseded work. Any
  changed field, stale watermark, stale base
  fingerprint, undeclared trigger, template or flow limit violation, or attempt
  to reach upstream work is rejected without mutation. Generic setters, force
  unlock, generic unblock, and timer-based takeover return typed
  `flow.rejection/v1` results without mutation.
  Approving an operation-bound checkpoint records the decision, operation
  attempt, exact effect intent, idempotency identity, route, claims, and
  relevant prepared facts before the registered Adapter can run. An unresolved
  effect projects one exact `recovery` command. Read-only and caller-idempotent
  recovery repeat the committed identity. Reconcilable recovery observes first
  and invokes only after affirmative provider evidence of absence; positive
  exact causation is adopted
  without reinvocation. One-shot uncertain recovery observes but never retries,
  and its initial invocation requires the fresh operation-bound checkpoint.
  While any effect is unresolved, completion-changing checkpoint, revision, and
  operation commands are serialized behind settlement; capability grants and
  exact recovery remain available. Adapter failures leave the effect unresolved
  for recovery and are not separately classified in the current projection.
  A confirmed plan that requests `cancel` authority projects one exact
  watermarked cancellation action. Cancellation commits a terminal fence,
  abandons every incomplete attempt and card, releases host admission, and can
  never be reversed. An intent not yet admitted to its Adapter is fenced before
  invocation. Completed effects remain accepted evidence; abandoned,
  outstanding, and late effects retain their real status with a `quarantined`
  evidence disposition and cannot flush deferred completion or satisfy
  dependencies. Cancelled
  reconcilable and one-shot effects may expose only `settle_cancelled`, which
  observes and may adopt exact positive causation but never invokes replacement
  work.
  The cancellation transaction records every prepared resource claim as
  `released` when its work is settled or its intent was fenced before Adapter
  invocation, and `quarantined` when an invoked unresolved effect may still
  touch it. Effect dispositions describe evidence usability; resource
  dispositions describe whether a resource may have been touched. Both are
  immutable evidence, and late settlement does not silently release a
  quarantined claim.
  A ready delegate projects one exact `delegate_execute` command. RunAuthority
  reserves the attempt and immutable route in the effect intent before the
  port is called. The caller key is derived only from run, card, and reserved
  attempt. Initial execution and recovery both discover that key before any
  dispatch. Proven presence adopts the same turn; proven absence dispatches
  with the same identity; unproven absence leaves the attempt unresolved.
  Completion requires exact launch and ordered-input settlement proof plus
  every registered independent validator. Only then is the output recorded as
  `flow.delegate-evidence/v1` and allowed to advance the run. Late,
  incompatible, empty, or validator-rejected output remains correlated to its
  attempt, is quarantined, and cannot satisfy the card. A retry is projected
  only while the confirmed attempt cap has capacity, and it keeps the same
  immutable route under a new reserved attempt identity. A non-destructive
  bounded wait leaves the current attempt unresolved, so recovery discovers
  and waits on that same live turn without cancellation or redispatch. A
  terminally quarantined attempt with retry capacity records an explicit
  handoff to the named Drovr registry holder. If its turn is still working,
  the adapter first requires an exact Drovr cancellation proof; an unproven
  cancellation leaves the attempt unresolved for same-attempt recovery.
  Accepted or exhausted work
  requires an exact agent-retirement receipt. Exhausting the cap projects one
  typed `terminal_disposition` decline action instead of stranding an active
  run.
  A ready subrun card projects `subrun_execute`. Its reconcilable Adapter
  creates or adopts a child ID derived from the parent run, immutable card
  digest, and revision ordinal. The exact confirmed child launch is embedded
  in the parent plan, so child creation never recompiles or refreshes it.
  Parent and child reserve separate host admission and retain separate limits,
  attempts, watermarks, legal actions, and terminal decisions. The child
  advances only through commands against its own run authority. Successful
  child admission is recorded in the parent stream before its projection can
  report the child as active. Exact absence after cancellation settles as
  `not_created`; a pre-invocation cancellation derives the same disposition
  without inventing a child record. Same-boot recovery verifies exact child
  lineage and repairs a missing parent admission record if interruption occurs
  between those commits. Parent
  cancellation first records a terminal request, then the mechanism Adapter
  reconciles it through the child's exact cancellation action. Late child
  output remains correlated by child ID and watermark with
  `late_unclaimed`/`quarantined` dispositions and cannot complete the parent.
  Multiple cards may reuse one agent only through an identical
  `flow.managed-agent-binding/v1` that names the complete ordered card set and
  terminal card under one immutable route. A revision is rejected when its
  required pending dependent closure would supersede any card inside that
  binding, including when the revision block is upstream of the binding.
  Earlier cards hand the agent to the named run holder; the terminal card
  retires it. An exact
  `flow.delegate-route-fallback/v1` may bind the final retry only when it was
  accepted with the plan, uses a different harness, and preserves the exact
  effective-authority comparison key. Ordered
  `flow.delegate-steering-input/v1` values derive stable attempt-bound caller
  keys and must all appear in settlement proof. Ambiguous discovery remains
  reconciling. Cancellation is itself a recorded, recoverable effect that
  closes the discovered exact turn and hands the agent back to the durable
  registry before quarantined delegate retirement settlement. If cancellation
  occurs between declared managed cards, the recorded cancellation effect
  retires the agent held by the run. A checkpoint decline or terminal
  disposition also retires every managed agent held by the run before the
  deferred `run_declined` event commits. If exact discovery proves the held
  turn absent, cleanup is handed conservatively to the Drovr registry instead
  of issuing an invalid retirement request without a turn identity.
- `query({ run_id })` rebuilds an immutable run projection from authority. With
  no request it returns the host run index. Registered `flow.query/v1`
  contracts dispatch through this same operation; the Stage 0 legacy inventory
  and delegated-agent description are registered queries. Run projections
  include the exact current
  revision and graph-only plan fingerprint, active plan, typed blocks,
  append-only revision and card-bound grant history, effective capabilities,
  resources, limits, operation attempts, effect classifications, receipts,
  reconciliation observations, and only the legal actions at that watermark.
  Delegate projections add reserved, accepted, and quarantined attempts, exact
  route bindings, validated evidence, quarantine reasons, and bounded retry
  actions derived from the same run watermark.
  Child-run projections add immutable lineage. A terminal child watermark is
  copied into the parent's settled receipt, so a parent projection never
  changes while retaining the same parent watermark.
  Every run projection also contains `views` with
  `flow.kanban-projection/v1`, `flow.graph-projection/v1`,
  `flow.timeline-projection/v1`, `flow.trust-projection/v1`, and
  `flow.operator-projection/v1`. These immutable views expose the exact run
  watermark and the operator-facing lifecycle, admission, revision, readiness,
  route, capability, checkpoint, attempt, effect, resource, handoff, and legal
  action facts relevant to each form. During reboot admission they also expose
  the exact `flow.reboot-revalidation/v1` record. They are derived on every
  query or watch observation, are never persisted as lifecycle authority, and may be deleted
  and rebuilt without losing or inventing run state.
  Timeline entry kinds are `lifecycle`, `checkpoint`, `readiness`,
  `capability`, `revision`, `effect`, `attempt`, `handoff`, and the
  `authority_change` fallback for authority events without a more specific
  operator category.
- `watch({ run_id })` returns an async iterator whose first item is the current
  projection and whose later items carry new authority watermarks. Watching an
  unknown run returns a one-shot iterator containing one typed rejection and
  then completes.

Every `flow.rejection/v1` has the same fields. `operation`, `code`, and optional
`reason` identify the rejected request; `command_type`, `run_id`, and
`bundle_digest` are null when they do not apply. `authority_watermark_domain`
states how to interpret `authority_watermark`: `run` covers one run's lifecycle
stream generation plus the current authority epoch and boot, while `host`
covers host run-index, host-admission, and authority-schema state. The host
watermark
changes on authority acquisition, capacity reservation or release, and run
registration; an unrelated run lifecycle event does not change it.
`authority_watermark` may be null only when the authority could not be observed.
`legal_actions` is always derived from the represented authority, or empty when
no authority watermark is available.

## Workspace, artifact, and resource handoff authority

`src/work-authority.mjs` exports distinct `getWorkspaceAuthority()`,
`getArtifactAuthority()`, and `getResourceHandoffAuthority()` accessors. Their
versioned Interfaces register canonical workspace subjects through
`work.workspace/v1`, immutable artifact subjects through `work.artifact/v1`,
and query retained `flow.resource-handoff/v1` subjects.
Workspace projections bind registration and subject generation, mutation
epoch, independently observed exact commit, tree, ref, clean state, and
disposition. An exclusive writer claim cites the exact generation and Git
fingerprint; competing claims, stale generations, and changed fingerprints fail
closed. Uncertain subject state is durably tainted across process termination
and reboot. Only published evidence-backed dispositions clear taint. Risk
acceptance leaves taint intact, and both risk acceptance and destructive reset
require a fresh RunAuthority-owned checkpoint bound to the exact subject,
command, action payload, and watermark. Taint dispositions also require an
owning-authority validation from the registered evidence Adapter. Artifact
projections bind digest, schema, size, producer and validator provenance,
classification, retention, pins, and retained-byte availability. Paths never
establish artifact identity. Registration commands carry durable idempotency
identities, so an exact retry adopts its original receipt while a payload
conflict fails closed.

A registered operation may carry an exact
`flow.resource-handoff-publication/v1`. The operation receipt must bind the
publication digest and an exact `flow.git-retention-receipt/v1`. RunAuthority
asks WorkspaceAuthority and ArtifactAuthority
to validate their transitions, then commits workspace promotion, artifact pin
transfer, workspace disposition, `flow.resource-handoff/v1` activation, the
effect receipt, and producer run finalization in one SQLite transaction. A
failure before commit leaves all of those authorities unchanged.
The publication operation attests to and retains an already-existing promoted
workspace state; it does not produce that state. WorkspaceAuthority
independently observes the promoted commit, tree, ref, and clean state before
Adapter invocation and rechecks authority before the transaction can commit.

A later run prepares with an exact handoff resource claim naming the digest and
allowed operations. Launch validates that accepted claim and pins the handoff
and artifacts atomically with run creation. Immediately before a bound
registered operation reaches its Adapter, the owning authorities recheck the
workspace generation and fingerprint, retained Git commit and tree, artifact
generations and bytes, intended consumer, operation scope, and authority
watermark. The resulting
`flow.resource-handoff-mutation-authorization/v1` is bound to that exact effect
and recorded before invocation. Content-addressed bytes, the Git retention ref,
and authority streams remain valid after the producer process, harness, branch,
or workspace disappears.

Mutating consumers acquire the handoff's sole mutation lease and the associated
WorkspaceAuthority claim atomically with launch. Competing writers fail closed,
uncertain effects retain the lease, and successful exact receipts release the
workspace lease, consumer pin, and artifact pins atomically. Each allowed
consumer operation publishes an explicit `read_only` or `mutation` authority
classification; names never imply mutation safety. Pins and claims remain held
until the consuming run succeeds. Cancellation releases work that was never
invoked and quarantines claims whose effects remain uncertain.

Workspace cleanup, artifact collection, and resource handoff cleanup expose
authority-derived previews with exact effects, observation watermarks, refusal
reasons, and legal actions. Active claims, dirty or changed Git facts, taint,
missing bytes, pins, retention, active handoffs, and cleanup obligations suppress
destructive actions. Eligible cleanup executes only as the registered
`flow.operation/resource-cleanup/v1` operation, preserving intent-before-effect
and exact receipt settlement. An evidence-validated handoff retirement discharges
its cleanup obligations and changes retention to collectable only after consumer
pins are gone. Retirement evidence and its owning-Adapter validation bind the
exact obligation list being discharged. Cleanup then releases Git retention,
handoff artifact pins, and only the exact matching workspace generation before
recording the handoff receipt. An uncertain cleanup remains bound to its original
effect and can only retry after independent absence evidence or settle through
exact presence evidence. Resource selection is
always by exact handoff identity and digest; `latest` is rejected.

The public launch contract is host-idempotent. Production-shaped conformance
uses `createDurableRunAuthority()` with the replacement authority root beneath
the host state directory. The Adapter stores run, host-index, and host-admission
authority as append-only SQLite streams in WAL mode with foreign keys and full
durability. Every write updates a replay-verifiable transactional fold in the
same transaction. Query and watch rebuild from the streams and compare the
result with the fold before returning a projection.

Catalog v8 advances the replacement authority store to schema version 2. The
transition is bound to exact release `flow-runtime-authority-schema/v2` and an
append-only `flow.authority-schema-transition/v1` receipt. A version-1 store is
advanced in one SQLite transaction before a new authority epoch is acquired.
A process ending before commit leaves the version-1 store valid; ending after
commit leaves the version-2 store replay-valid. Existing run streams are not
rewritten and replay to the same lifecycle facts.

The host run-index projection includes
`flow.authority-schema-compatibility/v1`, its exact schema watermark, and only
the legal schema action. A read-only runtime inspecting version 1 projects
an exact `recovery` command for `authority_schema_transition`. A mutating
runtime consumes that watermarked command through `FlowRuntime.command` before
acquiring an authority epoch. Run projections expose no run-scoped legal action
while that host transition is pending, and their temporary watermark binds both
the run authority and the pending authority schema so watchers observe recovery.
Other commands return
`authority_schema_transition_required` with the exact host recovery action;
only a mismatched schema-transition recovery command returns
`stale_authority_schema_transition`. Transition commit hooks receive the
published `flow.authority-schema-transition-boundary/v1` payload in both commit
phases. Unknown store contracts, future versions, altered transition history,
and release mismatches expose schema-valid `incompatible` compatibility with no
legal action. `launch` and `command` then return the typed
`authority_schema_incompatible` rejection without recording an authority epoch
or mutating a run. An incompatible runtime releases the mutation lock after
classification so a runtime supporting the store can acquire it.

Exactly one mutating runtime holds a SQLite-backed operating-system advisory
lock. Acquiring it appends a boot-bound monotonic authority epoch. A competing
runtime falls back to inspection and returns `mutation_authority_unavailable`
for launch or command. Lock-file timestamps, process age, and heartbeat age are
not takeover inputs. Production boot identity comes from a host Adapter backed
by the operating system, rather than a caller assertion. An effect reaches its
Adapter only when its full intent and idempotency key were durably recorded by
the lifecycle decision; the lock and epoch are checked again immediately before
the call, asynchronous provider settlement is awaited, and only successful
completion appends a durable receipt. Effect-bearing decisions cannot record a
terminal run transition before that receipt. Cancellation is the narrow
exception: its decision atomically records `run_cancelled` and exact
`delegate_cancellation` intents so admission closes immediately, then only
those intents may close live turns before quarantined delegate settlement.
Same-boot recovery adopts the
exact outstanding intent under the new epoch without changing its idempotency
identity.
RunAuthority records each initial provider invocation start and validates
reconciliation observations itself. Cancelled delegate settlement reuses that
original invocation identity because a post-cancellation invocation marker
would incorrectly describe new work; its separate cancellation effect records
its own invocation start. Reconcilable reinvocation requires a latest durable,
affirmative absence observation; one-shot uncertain effects may adopt exact
presence but never invoke again. While an effect remains unresolved, terminal
checkpoint and revision declines are withheld and constructed checkpoint
declines are rejected.
Before cancellation, an effect that cannot be settled keeps the run active and
its host capacity reserved. Cancellation abandons the attempt without claiming
that the external effect did not occur. The terminal run releases host capacity
while retaining unresolved, uncertain, abandoned, and late evidence truthfully.
`invokeEffect`, `recordEffectObservation`, `pendingSameBootRecoveryRunIds`, and
`completeSameBootRecovery` are internal effect-coordination mechanism seams on
the dark durable authority Adapter, not additional public `FlowRuntime`
operations. They therefore signal mechanism fencing failures to their internal
caller rather than extending the five-operation public rejection catalog. A
registered Adapter must declare one of `read_only`,
`caller_idempotent`, `reconcilable`, or `one_shot_uncertain`, expose `invoke`,
and expose `observe` for the latter two classes. Only a positive, identity-bound
`flow.effect-receipt/v1` completes an operation. Missing, malformed, or negative
receipts leave the exact effect unresolved and never prove absence.
Observations are rebuilt as exact canonical records before persistence. Claims
of presence or absence without affirmative provider evidence normalize to
indeterminate and cannot authorize adoption or invocation; indeterminate
provider diagnostics are retained while causation is cleared.

Same-boot process replacement increments the epoch, replays every active run,
and automatically dispatches each exact outstanding recovery action before
considering new work on that run. Read-only and caller-idempotent effects repeat
their committed identity. After reboot admission, those two classes may repeat
that same identity in the current epoch and boot. Reconcilable and one-shot
effects observe first;
only affirmative exact absence permits a declared reconcilable invocation,
while uncertain absence remains reconciling. A boot identity change instead
projects `suspended_after_reboot`; the sole lifecycle action is the exact typed
  `reboot_admission` command. That action binds the catalog, routes, capability
  envelopes, operation and validator contracts, current revision resource and
  limit facts, time facts, subject generations, unresolved effects, stream
  generation, boot, and epoch.
Fresh Adapter observations are not part of the authority watermark; a changed
observation refreshes the bound action and rejects an older action by its exact
revalidation while preserving the stream watermark.
An active run whose authority cannot be projected or whose registered operation
cannot be dispatched retains its pending recovery without blocking independent
runs; a later compatible Interface may resume that exact run.
The mechanism Adapter refreshes those observations at admission. Its
revalidation record keeps authoritative current facts under `expected`, current
Adapter facts under `observed`, and records `observed: null` when no exact
current observation is available; any drift rejects the command. Wall-clock, suspend-excluding
monotonic, boot, and clock-source identity enter policy only as typed
`flow.time-fact/v1` values. Stable contracts, routes, resources, and exact
`flow.subject-generation/v1` values compare exactly. When an elapsed limit is
declared, lower and upper elapsed bounds are evaluated deterministically;
uncertainty that could cross the accepted limit blocks admission rather than
guessing. Durable construction fails reboot admission closed until that
current-observation Adapter is configured. An unresolved effect from a prior
boot remains deliberately fenced, keeps its capacity reservation, and requires
an exact typed current recheck or settlement before admission;
indeterminate or unrechecked effects remain blocked. Parent and child run
records expose and accept only their own reboot action. The shipped
`LifecycleKernel` emits effect intents only for registered operation cards.
Each run is admitted independently. Run
watermarks bind the run stream generation and current authority epoch, while host
watermarks bind both host-index and host-admission streams. Reordering,
omission, duplication, digest conflict, unknown contracts, corrupt JSON,
stale generations, fold drift, corrupt or unavailable stores, and missing run
launch events return `authority_integrity_failure` with no legal action. Their
machine reasons include `reordering`, `omission`, `duplication`,
`digest_conflict`, `unknown_contract`, `corrupt_json`, `stale_generation`,
`fold_mismatch`, `corrupt_store`, `store_unavailable`, and
`missing_launch_event`.

The no-argument in-memory authority remains available only for isolated pure
contract tests. Durable construction is explicit so a read-only command never
creates replacement authority as a side effect. Direct construction of this
dark Interface is a conformance seam, not a converged public launcher; the
launch policy still selects the legacy implementation.
`PlanCompiler` and `LifecycleKernel` are pure Modules: their decisions depend
only on their explicit arguments.

## Tracker progress

`createGitHubTrackerProgressOperation()` and
`createJiraTrackerProgressOperation()` register the same reconcilable,
versioned `flow.operation/tracker-progress/v1` Adapter contract. Provider
identity is carried by the confirmed `flow.tracker-binding/v1` (`github` uses
owner/repository/issue number and Jira uses project/issue number), while the
FlowRuntime plan, ownership, effect, and reconciliation policy is shared. A
runtime registers the returned
`createTrackerProgressRegistrationBundle({ github: { driver }, jira: { driver } })`
value as `registeredOperations`; the bundle installs both the
provider-neutral Adapter and the cataloged
`flow.operation/tracker-progress-github/v1` compatibility Adapter. Provider
selection comes only from the confirmed tracker binding, existing v14 GitHub
plans continue to dispatch and reconcile, and new plans use the provider-neutral
contract. A
confirmed dynamic plan may use it only with a confirmed tracker binding for a
feature or epic. `RunAuthority` records whether launch created a top-level or
child run, rejects tracker operations for authority-known children, and binds
that ownership observation into every tracker intent. The Adapter never trusts
caller-supplied top-level scope.

Each provider has a narrow injected comment driver. `listComments` returns
`{ comments, complete: true }` only after exhausting every provider page;
missing or false completeness fails closed. `createComment` and
`updateComment` return the stored comment with a byte-exact body. An incomplete
listing or altered write receipt cannot authorize or settle a mutation. Jira's
issue status, transitions, labels, and unrelated comments are provider state,
not Flow lifecycle authority.

Each update is bounded and writes one `flow.tracker-progress/v1` marker-bound
comment. Later updates from the same run edit that comment in place. Duplicate
markers or a marker owned by another run fail closed. The marker records the
run, exact effect identity, caller idempotency key, and authority watermark, so
receipt recovery can adopt the exact provider mutation without reposting.
Tracker-scoped mutation fencing serializes the observe-and-upsert boundary, so
concurrent first writes cannot both create a comment under the sole runtime.
Tracker progress operations must be graph leaves; their receipts cannot make
another card ready. GitHub issue state, Jira issue status, and unrelated
comment content are never read as lifecycle, scheduling, checkpoint, or
acceptance authority.

Run `query` and `watch` expose the current
`flow.tracker-progress-projection/v1`, including the exact run-authority
watermark, projected watermark, status, desired bounded update, and only the
tracker operation's legal next actions at that watermark.

The focused public contract suite is:

```sh
node --test tools/flow/test/runtime-interface.test.mjs \
  tools/flow/test/durable-authority.test.mjs \
  tools/flow/test/delegate-card.test.mjs \
  tools/flow/test/registered-operation.test.mjs \
  tools/flow/test/cancellation.test.mjs \
  tools/flow/test/purity-contracts.test.mjs
```

## Delegated-agent preparation

`createDrovrDelegatedAgentPort()` is the non-authoritative preparation seam for
Drovr. Its `describe` operation resolves a non-mutating
`drovr.delegated-agent-description/v1`, independently checks every required
feature contract and description binding, and returns a
`flow.delegated-agent-description-projection/v1`. Compatible projections expose
only `bind_exact_launch_description` and refresh; incompatible, contradictory,
or unavailable descriptions expose closed repair or retry actions and never
invent a watermark.

The same port exposes `dispatch`, `discover`, `send`, `observe`, `wait`,
`cancel`, `reconcile`, and `retire`. Each operation returns a
`flow.delegated-agent-lifecycle-projection/v1` derived from Drovr's registry
authority. Dispatch binds the exact compatible description, discovery proves
presence or absence at an exact registry watermark, and later inputs use an
independent caller input key. Conflict projections fail closed and expose only
actions that preserve the existing turn identity, except that an agent with a
missing or stale immutable launch binding must be retired after registry
discovery confirms its exact identity. Reconciliation names an exact turn and a
bounded timeout; it recovers the bound agent when necessary, then correlates the
durable ordered inputs without replaying an unproven delivery.

Flow owns its required baseline in the versioned
`config/flow/contracts/drovr-required-features.v1.json` contract and pins its
exact bytes in the public catalog. Drovr independently owns and advertises its
implemented contracts and exact availability. The port compares those separate
authorities. The current runtime supports the complete lifecycle baseline, so
a conforming projection exposes exact bind and refresh actions. Missing,
weakened, or contradictory contracts still fail closed with repair and refresh
actions.
Invalid launch selectors produce an `invalid_description_request` block with no
retry action. Malformed adapter output is sanitized to a schema-valid closed
projection rather than being presented as authoritative description evidence.
Missing Flow contract bytes or validation dependencies produce a
`delegated_agent_port_unavailable` block with only the local
`repair_delegated_agent_port` action.
If registry discovery cannot produce the exact conflict projection, the port
returns `delegated_runtime_projection_unavailable` with only
`repair_delegated_runtime_registry`; it never recommends retirement without an
exact delegation identity and registry watermark.
An invalid Drovr configuration produces a `description_unavailable` block with
repair and refresh actions, while a transient description failure exposes only
`retry_delegated_runtime_description`.

Operators can inspect the same projection through the five-operation runtime:

```sh
flow query delegated-agent \
  --harness codex \
  --role reviewer \
  --capability read-only \
  --caller-metadata '{"run_id":"run:example","card_id":"review"}' \
  --json
```

This query creates no run and no Drovr resource. Plan compilation binds the
exact description and comparison keys before using the lifecycle operations;
it does not refresh them implicitly.

When a confirmed delegate card executes, Drovr remains a mechanism authority
only. It may create and observe its delegation group, task, managed agent, and
logical turn, but it cannot schedule a Flow card, make another card ready,
accept output evidence, or advance the run. Flow reconstructs evidence from
the narrow lifecycle projection and ignores any lifecycle or scheduling claims
outside the port contract. The authority-boundary negative suite exercises
that rule with attempted Drovr-authored cards and terminal events.

The managed sources under `config/flow/` are:

- `contracts/catalog.v1.json` - public contract names, the five
  `FlowRuntime` operations, authority ownership, and the reboot-admission
  typed-fact and uncertainty policy. Any future import registration must name
  both an adapter contract and validation-receipt contract. Its receipt must bind the exact imported
  bytes by digest, pass every required validation, and select only the catalog's
  positive `artifact_bytes` subject.
- `schemas/flow.time-fact.v1.schema.json`,
  `schemas/flow.subject-generation.v1.schema.json`,
  `schemas/flow.reboot-effect-recheck.v1.schema.json`, and
  `schemas/flow.reboot-revalidation.v1.schema.json` - typed reboot facts,
  unresolved-effect evidence, and the exact revalidation record.
- `schemas/flow.delegated-agent-lifecycle-projection.v1.schema.json` - the
  public lifecycle result shape, including authority and discovery watermarks,
  delegation identity, turn evidence, and legal next actions.
- `launch-policy.v1.json` - the converged selector policy. Its default is
  `legacy-claude/v1`; `flow-runtime/v1` is disabled.
- `legacy-baselines.v1.json` - content-addressed Git trees for both frozen
  legacy implementations and their permitted change policy.
- `transition-ledger.v1.json` - release, environment, evidence digests,
  statuses, defects, exceptions, decisions, and timestamps.

Stage 0 treats exception entries as unresolved deviations: they fail closed by
withholding launch actions. Approved choices are recorded as decisions instead.

Each ledger binds one release to one exact target environment. Evidence for a
different host class or transition stage belongs in a distinct ledger rather
than being aggregated into an environment-neutral pass.

Convergence links the complete directory to `~/.config/flow`. Applying
convergence repeatedly therefore reapplies the same declared selector instead
of deriving authority from which implementations happen to be installed.

Inspect the authority-derived projection from a repository checkout with:

```sh
npm --silent --prefix tools/flow run status
```

The JSON result includes the exact ledger and policy watermarks, selected
implementation, resolved authority root, frozen-baseline audit, evidence status
counts, defects, exceptions, decision, and closed legal next actions. Querying
is read-only. A baseline drift, digest mismatch, inconsistent or nested
authority root, unknown contract, or evidence path outside the managed
transition root fails closed.

Frozen-baseline diagnostics use stable codes:

- `frozen_legacy_baseline_audit_failed` means committed content no longer
  matches the recorded Git objects. Restore the frozen content or record an
  explicitly evidenced critical repair before launching.
- `frozen_legacy_worktree_dirty` means a frozen path has uncommitted or
  untracked changes. Inspect and resolve those changes before launching.
- `unresolved_git_object` means the recorded commit or current checkout cannot
  resolve a frozen path. Verify the inventory commit, path, and repository.
- `unavailable_worktree_status` means Git could not inspect the path's working
  tree state. Verify that Git is available and the repository root is valid.

Validation receipts record `issued_at`, but Stage 0 registers no import adapter
and establishes no receipt-expiration policy. An adapter requiring freshness
must declare that policy before registration rather than inheriting an implicit
time window.

Run the deterministic contract and projection suite with:

```sh
npm --prefix tools/flow test
```

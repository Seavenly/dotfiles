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
  A block is admitted only from digest-bound
  `flow.card-block-observation/v1` evidence naming the registered Adapter and
  validator contracts. Revision templates declare their own application cap,
  while the proposal declares card, per-revision card, revision, capability,
  resource, and elapsed-time caps. In this slice, `elapsed_seconds` is an
  explicit preparation fact: revision admission checks a template's resulting
  cap against that bound value and does not observe ambient wall-clock time.
  Catalog v9 extends the v8 contracts with irreversible cancellation,
  abandoned-attempt, late-effect quarantine, and observation-only cancelled
  settlement behavior. Catalog v8 extends the exact v1 requirements introduced in v7 for
  `explicit_facts.block_observations` on dynamic proposals and
  `revision_templates` on prepared runs, and publishes registered operation
  intent, observation, receipt, validation, effect-class, and recovery
  contracts together with authority-schema compatibility and transition
  contracts. Callers must prepare a fresh bundle rather than launch a pre-v8
  envelope.
  This slice accepts the registered `flow.checkpoint/confirmation/v1`
  executor with `flow.validator/checkpoint-decision/v1` and one operation card.
  A one-shot uncertain operation must be bound only to an exact fresh
  checkpoint; safer effect classes may instead project an exact
  `operation_execute` command without adding human approval. The operation names a registered Adapter,
  declares its effect class, and binds its input, route, claims, validator, and
  attempt limit in the confirmed graph. Delegate and subrun executors remain
  unavailable until their owning runtime contracts are implemented. External
  card-block acquisition by a live Adapter remains deferred; this runtime
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
  Recovery performs the same registration check before mutating authority, so
  a replacement runtime cannot accept an effect it is unable to dispatch.
- `command(command)` accepts the exact legal approve or decline checkpoint
  command projected by authority. A ready operation that does not require a
  checkpoint projects an exact `operation_execute` command. A
  `flow.card-block/v1` may instead project an
  exact `capability_grant` or `revision_decision`. Capability grants append the
  confirmed capability, named card binding, and trigger to accepted history;
  they do not grant that capability to unrelated cards. Revision decisions
  cite the current plan fingerprint and validated trigger. Accepting admits
  the template's complete change set in one authority event; declining records
  the negative outcome and terminates the run. A capped or otherwise
  inadmissible revision withholds acceptance but retains that exact decline
  action, so an active checkpoint-only run is never stranded without a legal
  operator action. A revision may
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
  invocation. Completed effects remain accepted evidence; outstanding and late
  effects retain their observed status with a `quarantined` disposition and
  cannot flush deferred completion or satisfy dependencies. Cancelled
  reconcilable and one-shot effects may expose only `settle_cancelled`, which
  observes and may adopt exact positive causation but never invokes replacement
  work.
  The cancellation transaction records every prepared resource claim as
  `released` when its work is settled or `quarantined` when an unresolved
  effect still touches it. Those dispositions are immutable evidence and late
  settlement does not silently release a quarantined claim.
- `query({ run_id })` rebuilds an immutable run projection from authority. With
  no request it returns the host run index. Registered `flow.query/v1`
  contracts dispatch through this same operation; the Stage 0 legacy inventory
  and delegated-agent description are registered queries. Run projections
  include the exact current
  revision and graph-only plan fingerprint, active plan, typed blocks,
  append-only revision and card-bound grant history, effective capabilities,
  resources, limits, operation attempts, effect classifications, receipts,
  reconciliation observations, and only the legal actions at that watermark.
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
terminal run transition before that receipt. Same-boot recovery adopts the
exact outstanding intent under the new epoch without changing its idempotency
identity.
RunAuthority records each provider invocation start and validates reconciliation
observations itself. Reconcilable reinvocation requires a latest durable,
affirmative absence observation; one-shot uncertain effects may adopt exact
presence but never invoke again. While an effect remains unresolved, terminal
checkpoint and revision declines are withheld and constructed checkpoint
declines are rejected.
Before cancellation, an effect that cannot be settled keeps the run active and
its host capacity reserved. Cancellation abandons the attempt without claiming
that the external effect did not occur. The terminal run releases host capacity
while retaining unresolved, uncertain, abandoned, and late evidence truthfully.
`invokeEffect` and `recordEffectObservation` are internal effect-coordination
mechanism seams on the dark durable authority Adapter, not additional public
`FlowRuntime` operations. They therefore signal mechanism fencing failures to
their internal caller rather than extending the five-operation public
rejection catalog. A registered Adapter must declare one of `read_only`,
`caller_idempotent`, `reconcilable`, or `one_shot_uncertain`, expose `invoke`,
and expose `observe` for the latter two classes. Only a positive, identity-bound
`flow.effect-receipt/v1` completes an operation. Missing, malformed, or negative
receipts leave the exact effect unresolved and never prove absence.
Observations are rebuilt as exact canonical records before persistence. Claims
of presence or absence without affirmative provider evidence normalize to
indeterminate and cannot authorize adoption or invocation; indeterminate
provider diagnostics are retained while causation is cleared.

Same-boot process replacement increments the epoch and resumes from replayed
authority. A boot identity change instead projects
`suspended_after_reboot`; the sole lifecycle action is the exact typed
`reboot_admission` command. That action binds the catalog, routes, capability
envelopes, operation and validator contracts, resource claims, time facts,
subject generations, unresolved effects, stream generation, boot, and epoch.
The mechanism Adapter refreshes those observations at admission. Its
revalidation record keeps prepared facts under `expected`, current facts under
`observed`, and records `observed: null` when no exact current observation is
available; any drift rejects the command. The checkpoint and operation tracer has no
applicable time facts or subject generations, so its exact prepared binding for
both categories is the empty list. Durable construction fails reboot admission
closed until that
current-observation Adapter is configured. An unresolved effect from a prior
boot remains deliberately fenced, keeps its capacity reservation, and requires
explicit admission before cancellation or reconciliation. The shipped
`LifecycleKernel` emits effect intents only for the single registered-operation
tracer. Each run is admitted independently. Run
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

The focused public contract suite is:

```sh
node --test tools/flow/test/runtime-interface.test.mjs \
  tools/flow/test/durable-authority.test.mjs \
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
`cancel`, and `reconcile`. Each operation returns a
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

The managed sources under `config/flow/` are:

- `contracts/catalog.v1.json` - public contract names, the five
  `FlowRuntime` operations, authority ownership, and the initial no-import
  decision. Any future import registration must name both an adapter contract
  and validation-receipt contract. Its receipt must bind the exact imported
  bytes by digest, pass every required validation, and select only the catalog's
  positive `artifact_bytes` subject.
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

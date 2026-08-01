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
  resource, and elapsed-time caps.
  This slice accepts only the registered `flow.checkpoint/confirmation/v1`
  executor with `flow.validator/checkpoint-decision/v1`; other checkpoint
  contracts and later executor kinds fail preparation until their owning
  runtime contracts are implemented. External acquisition by a live Adapter
  remains deferred; this runtime validates the exact caller-supplied Adapter
  observation before it can become authoritative.
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
- `command(command)` accepts the exact legal approve or decline checkpoint
  command projected by authority. A `flow.card-block/v1` may instead project an
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
- `query({ run_id })` rebuilds an immutable run projection from authority. With
  no request it returns the host run index. Registered `flow.query/v1`
  contracts dispatch through this same operation; the Stage 0 legacy inventory
  and delegated-agent description are registered queries. Run projections
  include the exact current
  revision and graph-only plan fingerprint, active plan, typed blocks,
  append-only revision and card-bound grant history, effective capabilities,
  resources, limits, and only the legal actions at that watermark.
- `watch({ run_id })` returns an async iterator whose first item is the current
  projection and whose later items carry new authority watermarks. Watching an
  unknown run returns a one-shot iterator containing one typed rejection and
  then completes.

Every `flow.rejection/v1` has the same fields. `operation`, `code`, and optional
`reason` identify the rejected request; `command_type`, `run_id`, and
`bundle_digest` are null when they do not apply. `authority_watermark_domain`
states how to interpret `authority_watermark`: `run` covers one run's lifecycle
stream generation plus the current authority epoch and boot, while `host`
covers both host run-index and host-admission streams. The host watermark
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
`invokeEffect` is an internal effect-runner mechanism seam on the dark durable
authority Adapter, not a sixth public `FlowRuntime` operation. It therefore
signals mechanism fencing failures to its internal caller rather than extending
the five-operation public rejection catalog.

Same-boot process replacement increments the epoch and resumes from replayed
authority. A boot identity change instead projects
`suspended_after_reboot`; the sole lifecycle action is the exact typed
`reboot_admission` command. That action binds the catalog, routes, capability
envelopes, operation and validator contracts, resource claims, time facts,
subject generations, unresolved effects, stream generation, boot, and epoch.
The mechanism Adapter refreshes those observations at admission. Its
revalidation record keeps prepared facts under `expected`, current facts under
`observed`, and records `observed: null` when no exact current observation is
available; any drift rejects the command. The checkpoint tracer has no
applicable time facts or subject generations, so its exact prepared binding for
both categories is the empty list. Durable construction fails reboot admission
closed until that
current-observation Adapter is configured. An unresolved effect from a prior
boot remains deliberately fenced, keeps its capacity reservation, and requires
a future explicit cancellation or reconciliation mechanism; this ticket does
not infer effect completion or release capacity automatically. The shipped
`LifecycleKernel` does not yet emit effect intents, so this recovery dead end is
reachable only through the internal custom-kernel conformance seam until that
future mechanism exists. Each run is admitted independently. Run
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

Flow owns its required baseline in the versioned
`config/flow/contracts/drovr-required-features.v1.json` contract and pins its
exact bytes in the public catalog. Drovr independently owns and advertises its
implemented contracts and exact availability. The port compares those separate
authorities. The current runtime is intentionally blocked because six
lifecycle contracts remain unavailable; the projection exposes repair and
refresh, but no bind action.
Invalid launch selectors produce an `invalid_description_request` block with no
retry action. Malformed adapter output is sanitized to a schema-valid closed
projection rather than being presented as authoritative description evidence.
Missing Flow contract bytes or validation dependencies produce a
`delegated_agent_port_unavailable` block with only the local
`repair_delegated_agent_port` action.

Operators can inspect the same projection through the five-operation runtime:

```sh
flow query delegated-agent \
  --harness codex \
  --role reviewer \
  --capability read-only \
  --caller-metadata '{"run_id":"run:example","card_id":"review"}' \
  --json
```

This query creates no run and no Drovr resource. Future plan compilation binds
the exact description and comparison keys; it does not refresh them implicitly.

The managed sources under `config/flow/` are:

- `contracts/catalog.v1.json` - public contract names, the five
  `FlowRuntime` operations, authority ownership, and the initial no-import
  decision. Any future import registration must name both an adapter contract
  and validation-receipt contract. Its receipt must bind the exact imported
  bytes by digest, pass every required validation, and select only the catalog's
  positive `artifact_bytes` subject.
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

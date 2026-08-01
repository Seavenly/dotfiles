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
  This slice accepts only the registered `flow.checkpoint/confirmation/v1`
  executor with `flow.validator/checkpoint-decision/v1`; other checkpoint
  contracts and later executor kinds fail preparation until their owning
  runtime contracts are implemented.
- `launch({ prepared, confirmation, closed_facts })` accepts an explicit
  `flow.dynamic-plan-confirmation-decision/v1` and a separately supplied
  `flow.closed-fact-observation/v1`. It verifies both are bound to the prepared
  bundle, then atomically creates or adopts the content-derived run. Declining
  confirmation returns a typed rejection and creates no run. Repeating an
  accepted launch returns the same run identity and records no second launch
  event. Launch never invokes the plan compiler or refreshes identity-bearing
  facts; the caller supplies the closed observation. A live observation adapter
  is intentionally deferred to the mechanism work that owns external fact
  acquisition.
  Invalid prepared bundles, confirmation decisions, and changed closed facts
  return typed launch rejections rather than escaping as transport errors.
- `command(command)` accepts the exact legal approve or decline checkpoint
  command projected by authority. Generic setters, force unlock, generic
  unblock, and timer-based takeover return typed `flow.rejection/v1` results
  without mutation.
- `query({ run_id })` rebuilds an immutable run projection from authority. With
  no request it returns the host run index. Registered `flow.query/v1`
  contracts dispatch through this same operation; the Stage 0 legacy inventory
  and delegated-agent description are registered queries.
- `watch({ run_id })` returns an async iterator whose first item is the current
  projection and whose later items carry new authority watermarks. Watching an
  unknown run returns a one-shot iterator containing one typed rejection and
  then completes.

Every `flow.rejection/v1` has the same fields. `operation`, `code`, and optional
`reason` identify the rejected request; `command_type`, `run_id`, and
`bundle_digest` are null when they do not apply. `authority_watermark_domain`
states how to interpret `authority_watermark`: `run` covers one run's lifecycle
event stream, while `host` covers host run-index membership. The current host
watermark changes when a run is first added, not when an existing run advances.
`authority_watermark` may be null only when the authority could not be observed.
`legal_actions` is always derived from the represented authority, or empty when
no authority watermark is available.

The public launch contract is host-idempotent. Its current in-memory conformance
mechanism is deliberately process-local: all default runtime Interfaces in that
process share one host authority, so duplicate launches adopt the same run.
Durable SQLite streams, cross-process enforcement and fencing, and restart
recovery belong to the next runtime ticket. This first slice proves the complete
public checkpoint path without claiming those later mechanism guarantees.
Direct construction of this dark Interface is a conformance seam, not a
converged public launcher; the launch policy still selects the legacy
implementation.
`PlanCompiler` and `LifecycleKernel` are pure Modules: their decisions depend
only on their explicit arguments.

The focused public contract suite is:

```sh
node --test tools/flow/test/runtime-interface.test.mjs \
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

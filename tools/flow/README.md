# Flow transition contracts

This directory contains the public transition contracts and the dark,
harness-neutral `flow` replacement. The replacement launch policy remains
disabled, so this API does not authorize normal replacement launches.

## Release capability and qualification

`config/flow/release-manifest.v1.json` is the versioned capability manifest.
Its `flow.dark-opt-in/v1` value is request-local authority for only feature
`verify` and local review. The public `config/flow` runtime gates both
`prepare` and `launch` through the same selector; missing opt-in is a typed
`disabled` rejection, while every unlisted or unavailable adapter is a typed
`unsupported` rejection. Claude remains the default implementation, and the
gate never authorizes normal use, remote mutation, publication, merge, push,
tracker/forge work, GitHub review, spikes, epics, or mixed/test feature modes.

The transition ledger binds the exact environment, prerequisite commits,
catalog, policy, manifest, release-content digest, legacy inventory, and
qualification records. `config/flow/evidence/release-content.v1.json` binds
an exact candidate Git tree and complete file/mode/digest listing under the
governed include/exclude model in `src/release-content-contract.mjs`. It
includes this runtime and its public host, the issue-supported Drovr
implementation, `config/flow/`, the relevant host/CLI/transition tests, and
the governing ADRs. Transition evidence and the ledger are explicitly excluded
to avoid a digest cycle. Git-ignored untracked files under governed prefixes,
including generated dependencies and platform metadata such as `.DS_Store`,
are outside the projection; tracked files remain governed. The
candidate Git tree ID is derived exactly from governed paths, modes, and blob
identities using Git tree hashing rules, without requiring the synthesized
object to exist in the repository. Validation checks the derived ID, complete
governed listing, every regular-file byte, regular-file modes, and realpath
containment.

Qualification uses two separately hashed phases. Phase one binds the immutable
base commit name (not a claim that the candidate is committed), candidate
tree, release-content digest, deterministic recipe, and TAP receipts from
passing core commands and host-fault/reboot commands on the registered-
operation test runtime. Phase two
runs production feature verify, public local-review process cases, and a real
Drovr finding-schema case through the production public runtime. Its record
binds phase one, the release tree, recipe, and actual TAP receipts; both phases
are required for admission. Regenerate the content tree before qualification
evidence with
`node config/flow/scripts/generate-release-content.mjs` followed by
`node config/flow/scripts/generate-qualification-evidence.mjs`. The projection
exposes `dark_opt_in.available` only when all required evidence records are
passed and every receipt remains bound. Later sacrificial issues and deferred
scenarios remain explicitly `not_run`; the manifest is not a production-run
adapter or synthetic pass mechanism.

## Evidence safety contract

`src/evidence-safety.mjs` is a pure, non-authoritative validator for canonical
evidence crossing a Flow boundary. Its exact policy identity is
`flow.evidence-safety-policy/v1`, and catalog v34 binds it to
`flow.contract-catalog/v1@34`. The request shape is
`flow.evidence-safety-request/v1` with exactly `schema`, `policy_id`,
`catalog_id`, `classification`, `allowed_use`, `input_digest`, and `input`.
`input_digest` is the SHA-256 digest of the canonical JSON input bytes; key
ordering is canonicalized, while arrays retain their declared order.

Accepted requests return one `flow.evidence-safety-receipt/v1` containing the
classification, normalized allowed-use set, input digest, and self-bound
receipt digest. The same receipt may be bound, without gaining authority, to
`delegate_transfer`, `artifact_acceptance`, and
`resource_handoff_publication` through
`flow.evidence-safety-binding/v1`. These binders do not create lifecycle state,
publish resources, mutate work, or grant capabilities. A rejected request
returns `flow.evidence-safety-rejection/v1`; its reason is a stable code and
never includes rejected input bytes, fragments, paths, or secret material.

The recursive policy inspects object keys and values, arrays, nested structured
strings, bounded percent/base64 encodings, and normalization boundaries. It
rejects actual credentials, capability references or envelopes, ambient POSIX,
Windows, UNC, URI, cwd, traversal, or encoded paths, authority-bearing
capability material, and ambiguous or malformed encodings. Conceptual research
prose and immutable public source URIs remain valid. The validator performs no
filesystem, environment, process, transcript, cwd, or credential reads.

## Result binding and feature capture

The public catalog publishes `flow.result-binding/v1` declarations for every
explicit producer and consumer evidence relationship. A declaration names the
producer card, output contract, and expected schema; dependency edges order
execution and never transfer data. Accepted active successful settlements are
recorded by RunAuthority as immutable
`flow.result-binding-record/v1` values with
`flow.result-provenance/v1`, attempt, generation, mutation-epoch, content, and
result identities. Consumer effect intents bind those exact result identities
and content digests before Adapter invocation. Recovery and replay adopt the
same records, while missing, ambiguous, stale, or superseded records fail
closed.

Feature preparation binds the starting workspace, permitted transformations,
validation and retention policy, and exact result declarations. It does not
bind a future commit, tree, artifact digest, or patch bytes. After launch, the
registered `flow.operation/feature-capture/v1` observes the post-mutation
workspace and returns `work.feature-capture-receipt/v1`, including exact clean
Git identities and artifact byte digest and size evidence. The resulting
`flow.feature-candidate-view/v1` is the sole candidate input for verification,
critique, and `flow.feature-finalization-binding/v1`. Late or cancelled capture
outputs remain quarantined evidence.

Plan revisions carry an explicit `flow.result-binding-delta/v1` in
`result_binding_changes`. The delta is applied atomically with graph changes
and supersession, preserving unaffected declarations and append-only result
history. New capture results are required for replacement evidence. Prepared
bundles with result declarations must satisfy this catalog exactly and are
rejected when incompatible. Plans and recorded runs without result bindings
retain the supported legacy replay path.

## Public host owner and transport

The public host composition lives under `config/flow/`. It exposes exactly
the five `flow.runtime/v1` operations through a versioned newline-delimited
JSON transport: `prepare`, `launch`, `command`, `query`, and `watch`. Request
and response frames carry one bounded correlation identity, reject multiple or
oversized frames, and preserve watch watermarks. The transport is a mechanism
Adapter; it cannot acquire the durable lifecycle authority on behalf of a
client.

One host owner holds the fenced durable `RunAuthority` and runs the autonomous
projection driver. The owner endpoint records a process identity and the
runtime status projection reports separate delegate and operation capacity.
Both capacities default to one and may be set to positive values through 64
with `FLOW_RUNNER_DELEGATE_CAPACITY` and
`FLOW_RUNNER_OPERATION_CAPACITY`, or through the explicit production
`runnerOptions` fields. `flow status --json` reports active counts and a
bounded sanitized error summary; detached owners retain the same safe
diagnostics in their private `owner-errors.json` sink.

Clients may exit, reconnect, query, or watch while the owner continues an
accepted run. Owner restart is same-boot recovery; a changed boot requires
the per-run `reboot_admission` command. Host-manager sources and their
explicit opt-in procedures are maintained in
[`config/flow/host/README.md`](../../config/flow/host/README.md). The ordinary
dotfiles convergence exposes those sources but intentionally does not enable
the replacement launch path.

## Delegate input envelope

Every dynamic delegate card and shipped delegated role uses the versioned
`flow.delegate-input-envelope/v1` contract. Feature apply and critique cards,
including serialized slices, local or GitHub review lenses and critic cards,
and quick-spike researcher and synthesizer cards select the same five input
areas:

- `instructions` - the role-specific bounded request;
- `task_inputs` - minimal role context such as the feature brief, review
  target and lens, or confirmed spike question;
- `resource_references` - exact execution resources, selected at plan time by
  `flow.delegate-execution-resource-selection/v1` using only a subject fact
  and `authority_binding_id`, then resolved at dispatch to
  `flow.delegate-execution-resource-reference/v1` by RunAuthority through the
  prepared required-authority binding. Workspace and artifact references are
  resolved by `WorkspaceAuthority` and `ArtifactAuthority`, respectively;
- `predecessor_evidence` - only when the card declares an upstream join, the
  exact RunAuthority-materialized evidence selected by that join; and
- `output_requirements` - canonical JSON schemas and independent validator
  contracts. The card's `outputs` and `validators` arrays are authoritative;
  when this selection is present, it must equal those declarations exactly and
  is never an independent caller override.

Execution resource references are access facts, not transferable evidence.
They never contain a workspace path, credential, capability secret, prepared
bundle, or ambient transcript. Transferable predecessor evidence retains the
issue-79 evidence-safety receipt and binding, and is kept distinct from the
authority facts that grant execution access.

For a delegate card, `card.inputs.prompt` is the sole canonical source for the
initial envelope's `instructions` value. `card.inputs.instructions` is not a
supported alias or override: plan preparation rejects it, and the runtime
materializer fails closed if it appears in a persisted intent. Steering keeps
its separate prompt-only contract and cannot replace the initial prompt.

Callers select the card's canonical prompt, minimal task-input IDs and facts,
resource-selection IDs, and output requirements. RunAuthority derives the
transmitted execution authority from the immutable route's exact
effective-authority digest plus its accepted capability facts, and injects predecessor evidence
only from its exact declared join. A baseline `read-only` route is bound by
that effective-authority digest and needs no bearer capability grant. Other
Drovr launch postures use the documented Flow grant mapping (`on-approve` to
`scope:approve`, `workspace-write` and `auto` to `repository:write`); the
mapped grant must be accepted for the specific card and only that Flow grant
ID is transmitted. `unrestricted` has no finite Flow mapping and is rejected.
Resource `access: read_only` is descriptive and cannot downgrade a mutating
effective route or exempt it from workspace holder, generation,
mutation-epoch, fingerprint, or taint fencing. RunAuthority grants the
read-only exemption only for the exact baseline Drovr `read-only` posture when
the card has no mutating Flow capability grant; a `workspace-write`, `auto`,
contradictory, or malformed authority declaration remains fenced.
The
delegated port sends the canonical JSON UTF-8 bytes themselves and records
their SHA-256 payload digest. Initial input and ordered steering use the same
envelope and correlation fields (`attempt_id`, `input_key`, `sequence`, and
`input_kind`), so discovery, retry, and settlement cannot reuse a caller key
with different bytes. The prepared bundle and live mixed-harness qualification
remain out of scope; the latter is tracked by issue #44.

GitHub review lenses and the critic select their exact remote pull-request
snapshot and send no local workspace resource reference. They never inherit an
ambient workspace path; local review targets alone receive a read-only
`WorkspaceAuthority` execution reference resolved by RunAuthority.

## FlowRuntime

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
  explicit preparation fact used only to validate a revision template's
  resulting cap; revision admission does not observe ambient wall-clock time.
  Runtime wall and active execution deadlines are a separate authority policy:
  bounded runs refresh typed execution-time facts at launch, effect admission,
  and settlement boundaries. A missing, invalid, or uncertain time Adapter
  fails closed with `execution_time_unavailable` or
  `execution_deadline_uncertain` and does not admit new work.
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
  `operation_execute` command without adding human approval. A registered
  operation is either bound to its exact checkpoint or belongs to a serialized
  dependency chain authorized by `operation_execute`. The operation names a registered Adapter,
  declares its effect class, and binds its input, route, claims, validator, and
  attempt limit in the confirmed graph. A delegate card binds a compatible
  Drovr description, immutable route, prompt, delegate input envelope
  selections, bounded wait, validator contracts, and attempt limit in the same
  confirmed graph. A subrun card binds
  an exact confirmed child launch and immutable lineage inputs.
  External card-block acquisition by a live Adapter remains deferred; this runtime
  validates exact caller-supplied block observations before they can become
  authoritative.
- `launch({ prepared, confirmation, closed_facts })` accepts an explicit
  `flow.dynamic-plan-confirmation-decision/v1` or
  `flow.predefined-flow-confirmation-decision/v1`, plus a separately supplied
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
  Preparation rejects a validator missing from its operation Adapter with
  `incomplete_provider_receipt_validator` and a validator contract absent from
  the prepared facts with `unsupported_provider_receipt_validator`; launch
  rechecks the Adapter registration and rejects it with
  `incomplete_provider_receipt_validator`.
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
  for recovery and are separately classified as typed operation failures with
  sanitized diagnostics; provider outages retain their distinct provider
  unavailable classification.
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
  Deterministic envelope/materialization failures use the strict
  `flow.delegate-failure-observation/v1` operator observation, which preserves
  only the stable `code`, `stage`, and boolean `retryable` fields through
  durable persistence, replay, and public projections. The observation is
  cataloged source contract data; malformed or unknown fields are rejected
  rather than copied into diagnostics.
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

### Predefined flow selection

`createFlowRuntime({ predefinedDefinitions })` snapshots a registry of trusted,
versioned definitions at construction. Each registry key must equal the
definition's exact versioned `id` (for example `example/v1`), and each
registration has exactly these fields: `schema` set to
`flow.predefined-definition/v1`, non-empty `contract`, one pure `compile`
function, `promised_outcomes` and `negative_outcomes` arrays, and a
`trust_posture` record. A definition may also declare
`required_authorities`, each bound to one exact
`flow.required-authority/v1` identity and immutable observation input. The
runtime resolves those declarations only from the trusted
`registeredAuthorities` catalog; the prepared run records
`flow.required-authority-binding/v1` observations plus the exact registered
provider identity and never embeds the Adapter callbacks. Each registered
authority uses a `flow.registered-authority/v1` provider identity with an
immutable adapter id and version, so a same-contract adapter substitution is
rejected even when its observation has not drifted. A `RunAuthority` accepts
one exact authority catalog identity: reattaching that identity is idempotent,
while a conflicting provider or definition catalog is rejected rather than
overwriting the first runtime's semantics. The shipped `feature/v1` and
`review/v1` definitions require caller-injected registered generic route,
resource, contract, and subject-generation providers; FlowRuntime does not
synthesize providers from a prepared bundle. The compiler receives the
selected `inputs` and
`explicit_facts` and returns one dynamic plan proposal. Callers select a
registered definition with `prepare({ schema: "flow.predefined-flow-selection/v1",
definition, inputs, explicit_facts })`. The selection carries no graph,
executor contract, route, authority, or confirmation metadata; those values
come from the registered definition and its explicit selection inputs.

Preparation remains non-authoritative. It returns a deeply immutable,
content-addressed `flow.prepared-run/v1` with `kind: "predefined"`, the exact
derived graph, selected definition, explicit facts, revision templates, and a
single `flow.predefined-flow-confirmation/v1` view. That view covers inputs,
promised and negative outcomes, requested authority and mutations, routes,
capabilities, limits, trust posture, required authority bindings, and revision
templates. The confirmation
routes cover routed cards in both the base graph and revision templates. The
confirmation view deliberately does not repeat the complete graph.

Launch accepts the exact `flow.predefined-flow-confirmation-decision/v1` bound
to the prepared bundle and confirmation digests, together with the exact
closed-fact observation. Launch validates the prepared identity directly and
does not invoke a definition compiler, consult mutable registration, or
refresh facts. An exact existing run is adopted idempotently before authority
rechecks; an absent run rechecks every required authority from the registered
catalog before its fenced creation transaction. Reboot admission repeats those
rechecks alongside route, resource, generation, time, and unresolved-effect
facts and emits the closed `authority_bindings` projection. Missing, stale,
unavailable, contradictory, or uncertain observations
remain typed rejections with provider identity, provider watermark or
generation, and closed legal actions in `authority_fact`. The rejection's
top-level `authority_watermark` remains the owning host or run watermark used
for stale retry. Every observation must include the exact binding
`observation_input`; JSON Schema cannot express the cross-object digest
equality, so runtime validation rejects missing, augmented, or substituted
input.
Dynamic proposals retain their separate complete-graph
confirmation contract.

### Bounded quick spike

The cataloged `spike/v1` predefined definition is a quick-only research
tracer. Its required `flow.spike-delegation-bindings/v1` selection input binds
one confirmed `flow.spike-question/v1`, immutable
HTTPS source references with content digests, and two independently declared
read-only Drovr routes: `spike-research` followed by `spike-synthesis`.
The researcher returns canonical, source-cited
`flow.spike-research-evidence/v1` with lower assurance; semantic residual gaps
remain valid evidence.

RunAuthority accepts researcher evidence only after the registered validator
and shared evidence-safety policy succeed. It then materializes the accepted
delegate evidence as a digest-bound
`flow.authority-materialized-evidence/v1` envelope and delivers that
exact envelope through the `flow.delegate-input-envelope/v1` prompt boundary.
The synthesizer validator receives no ambient transcript or sibling data and
requires immutable source citations, the exact researcher evidence digest,
lower assurance, and nonempty residual gaps in one canonical
`flow.spike-report/v1`.

Unsafe or uncertain evidence is quarantined through the existing delegate
settlement behavior. The quick tracer has no operation cards, mutation or
publication authority, prototype or revision loop, tracker action, review or
approval behavior, or implicit cross-run transfer. Any later resource
publication remains an explicit handoff outside this flow.

### Verified feature candidate

The trusted `feature/v1` predefined definition turns one accepted
`flow.feature-brief/v1` into one local review candidate. A selection may use
`verify`, `test`, or `mixed` mode. `test` and `mixed` selections carry a
non-empty ordered `slices` array. Each slice has schema
`flow.feature-slice/v1`, a stable `id`, `mode` (`test` or `verify`), and its
explicit acceptance criteria. Across serialized slices, every brief acceptance
criterion must be owned by exactly one slice - omitted, duplicated, or
out-of-brief criteria are rejected. A test slice also carries one
`flow.feature-test-request/v1` with an intended failure and a healthy,
identity-bound `environment_fingerprint`. An environment failure or unrelated
failure is not slice evidence. Verify mode retains its safe baseline or
explicit non-destructive compensating assertion. In serialized slices, a safe
baseline used by a verify slice is valid only when there is exactly one verify
slice, that slice is first, and the baseline fingerprint equals the selected
workspace fingerprint. Other serialized verify arrangements require the
aggregate compensating assertion. Test-only slices may retain a safe baseline
for the aggregate verification receipt.

An identity-free selection may provide a versioned `capture_policy` using
`flow.feature-capture-policy/v1`. It binds the selected starting workspace and
clean Git facts, permitted transformations, receipt validator, retention and
workspace disposition, plus the exact publication subject, consumer authority,
cleanup obligations, and intended consumer. It contains no candidate, promoted
commit or tree, artifact, or patch identity. A legacy selection with an
explicit `flow.feature-finalization-binding/v1` keeps its publication policy;
the identity-free policy input is rejected when both are supplied.

The compiler carries test intent in a `test_selection` shaped as
`flow.feature-test-selection/v1`; this is selection identity, not a registered
test receipt. Registered test operations must independently return
`work.feature-test-receipt/v1` evidence for every test slice. Their cards
declare `flow.validator/feature-test-receipt/v1`; the registered adapter must
advertise that exact validator and validate the receipt before RunAuthority
records effect success. The validator binds the operation, effect, attempt,
idempotency key, authority watermark, intended failure, healthy environment,
and current pre-slice workspace snapshot.

An optional `flow.feature-setup/v1` selection is a one-time setup operation
with its own identity and fingerprint; setup is valid only with explicit
serialized slices. It is serialized before the slices and
its receipt is never selected as slice evidence. Every slice then runs in
order: a test slice first records its expected pre-implementation failure,
one exact workspace writer applies that slice, and a registered verification
operation records the post-implementation result. The writer card is bound to
an immutable managed-agent sequence when the route is reused. This keeps every
mutation attributed to its registered card while one workspace generation and
mutation epoch fence the complete sequence.

Each slice verification advances the clean Git snapshot used by the next
slice. Stale, skipped, reordered, or future final snapshots are rejected, and
the last slice must equal the promoted Git snapshot exactly.

The final aggregate verification and seal remain registered operations. Their
authority-materialized inputs select only the exact current slice receipts and
delegate observations by card identity; setup receipts and stale operation
receipts cannot be reused. A mutation-epoch change therefore invalidates all
verification evidence bound to the prior operation sequence. The workspace
claim recheck fences generation, mutation epoch, and Git fingerprint
immediately before every Adapter invocation. Independent apply and critique
delegate routes and one exact finalization publication remain required.

Each serialized feature path uses the sequence apply, capture, verify, critique,
and seal. A test slice captures the post-mutation snapshot before its slice
verification; mixed paths use one exact capture for each mutation slice and one
terminal capture for aggregate verification and critique when that snapshot is
the same candidate. Bounded repairs add a fresh capture card and explicitly
rebind downstream declarations to it. Verification and critique therefore
consume the actual captured candidate rather than a dependency edge or a
caller-provided latest value.

The seal operation receives only authority-materialized evidence selected by
card identity. Success requires exact acceptance coverage with passed verdicts,
the selected discriminating evidence, a clean post-mutation Git observation,
fresh workspace and operation identities, and no blocking critique finding.
Safe-baseline evidence must identify a distinct post-mutation fingerprint;
compensating evidence must carry a self-bound receipt that the explicitly
non-destructive assertion was satisfied. Every full workspace resource claim
is rechecked immediately before its Adapter invocation against the current
generation, mutation epoch, Git fingerprint, sole holder, and card scope.
RunAuthority validates those receipts before atomically sealing
`work.review/v1`, promoting the workspace generation and mutation epoch,
transferring artifact pins, retaining Git, publishing the exact handoff, and
finishing the run. Any missing, stale, dirty, unresolved, or blocking evidence
leaves the run without a review candidate or handoff. The terminal projection
contains the sealed candidate identity and ReviewAuthority watermark, with no
review, integration, push, pull-request, cleanup, or tracker action.

#### Feature repairs and revision projections

A feature repair replaces the blocked card and its pending dependent closure.
Every replacement must carry the explicit `replaces_card_id` identity; tuple
matching by phase and executor is not accepted. The replacement preserves the
original executor, route, limits, recovery, evidence, and authority-bearing
inputs, including `description`, `prompt`, and `managed_agent`. Any managed-agent
binding is rebound to replacement card IDs before the revised `active_plan` is
stored, so superseded IDs do not remain executable authority.

Revision projections distinguish effective state from pending reservations.
`capability_bindings`, `resource_claims`, and `limits` contain effective base
and approved revisions. A gated revision exposes pending capability and resource
consumption in `admission_capability_bindings`, `admission_resource_claims`, and
`revision_reservations`; its unapproved limit raise is not effective admission
capacity. `max_cards` counts active cards only - superseded historical cards do
not consume that active-card cap.

Checkpoint-bound revisions expose `effect_state` with `applied`, `gated`, and
`voided` branches. In every branch, `card_ids` means cards added by the
revision, while `superseded_card_ids` separately names replaced cards. Declined
gated additions have card status `voided`; the outcome is
`expansion_declined` with an authority watermark and no legal actions. Structural
admission failures project as `structurally_rejected`; closed capacity failures
project as `cap_exhausted`. Recorded outcomes are retained chronologically and
deduplicated only when their complete outcome identity is identical.

Feature repair and replan inputs are optional and remain part of the prepared
selection identity. Each `flow.feature-repair/v1` entry names one blocked card,
one closed repair kind, the exact acceptance criteria it repairs, and its
remaining scope. Its bound `flow.plan-revision-template/v1` is admitted only
when the caller also supplies the matching digest-bound card-block observation.
The template's complete card, edge, supersession, capability, resource, and
limit changes are accepted as one append-only revision or rejected as one unit.
Expansion is derived from those changes, not from a caller flag, and must name
an exact checkpoint card in that same template; no repair may silently widen
the confirmed feature authority. Revision commands and their decline or
cap-exhaustion outcomes are projected with the current run watermark, repair
metadata, and legal next actions, while accepted history remains immutable.

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

### Automated local review

The registered `review/v1` definition reviews exactly one complete
`work.review-candidate/v1` verified local candidate. The target binds the
candidate fingerprint separately from the review lifecycle generation and
from the owning candidate-seal authority watermark. Launch re-reads the
sealed candidate projection and rejects missing, stale, or mismatched
candidate identity before creating a run. Its selected security, correctness, tests,
style, and observability lenses each use an isolated delegated route; one
fresh critic depends on every enabled lens and receives their accepted
authority evidence. A registered review operation appends one immutable
`work.review/v1` record to ReviewAuthority with the candidate fingerprint and
lifecycle generation bound independently. The ReviewAuthority-owned operation
registration is reserved and cannot be replaced by caller code.

The derived candidate-currency projection reports `sealed`, `stale`, or
`blocked`. It rechecks the exact workspace mutation epoch and fingerprint,
clean/taint state, retained artifact bytes, Git retention, and the exact
artifact-pinned active handoff. Any movement or uncertainty keeps the original
candidate and review evidence historical but removes authorization. Its
`blocking_reasons` and authority watermarks identify the exact observed
workspace, artifacts, Git retention, and handoff; candidate and review
projections expose no recovery action because replacement and recovery belong
to their owning authorities. GitHub review projections remain provider-owned
and are not fenced by a local workspace observation.
Terminal candidate lifecycles (`superseded` and `abandoned`) remain historical
and are never re-derived as `sealed`; their derived currency is stale with a
terminal lifecycle blocking reason and no legal actions.

ReviewAuthority projections and `FlowRuntime` review queries/watchers expose
the exact review watermark, append-only evidence, stable findings, posture,
cap reasons, and deterministic JSON, Markdown, and HTML artifacts. Artifacts
carry candidate, lifecycle, candidate-seal, source-authority, and exact
registered-operation provenance. Recorded artifact bytes, format digests, and
provenance are immutable: later invalidation, refresh, projection rebuild, and
restart change only the ReviewAuthority projection watermark and status. They
never re-render or re-stamp the recorded artifact object.
The selected urgency preset is deterministic: `hotfix` selects the `critical`
floor, `fast` selects the `high` floor, and `standard` selects the `info` floor.
The floor filters selected semantic and rendered findings; it never rewrites
the native urgency or stable identity in authority-retained delegate evidence.
Findings below the floor are retained in each canonical lens or critic result
and produce an explicit `urgency_floor` cap reason with their omitted count and
urgency tiers. Critical and high findings therefore cannot be hidden by a
lower-priority floor. A rendered finding cap is applied after urgency
selection, while uncapped semantic findings and deterministic cap reasons are
retained.
Each selected lens and the critic records a terminal coverage disposition of
`produced`, `degraded`, or `unavailable`. Any degraded or unavailable
disposition projects `review_incomplete` and never produces merge eligibility,
even when findings are otherwise empty. Optional orientation markdown and
bounded Mermaid diagrams are human-facing supplements only: they may be
reproduced from the bound review request and appear in review artifacts, but
are excluded from lens and critic inputs, automated evidence, finding identity,
urgency, and cap decisions.
RunAuthority materializes the terminal disposition for every selected lens and
critic. Delegate self-report may make a participant less complete, but it can
never upgrade an authority-materialized `degraded` or `unavailable` result to
`produced`; a non-produced participant must retain a non-empty reason. Runtime
timeouts, unavailable ports, invalid output, and incompatible dispatch identity
produce a safe review-incomplete participant with no untrusted findings while
their distinct quarantine reason remains in the operator/run audit.
Public run projections, including operator and trust views, omit raw operation
inputs. Authority-owned review recording reads its settled effect intent through
a private, read-only RunAuthority attachment instead of exposing delegated
evidence through those projections.
Review watchers are one-shot snapshots because an accepted review record is
immutable; callers watching an unknown review receive that exact rejection and
must start a later watch after the record exists.
ReviewAuthority re-reads the sealed candidate projection on every review-record
command, so a self-consistent forged candidate or stale candidate-seal watermark
cannot create a review event. The first record requires its canonical command
identity; later non-replay writes reject with `idempotency_conflict` and cannot
append another event. Review completion is automated evidence only: approval,
integration, merge, tracker completion, and remote review submission remain
unauthorized and have no legal actions in the projection.
If the observed candidate fingerprint or lifecycle generation changes, the
exact `work.review-target-invalidation-command/v1` may append one target-moved
event bound to the prior review identity, prior facts, observed facts, and
expected review watermark. Either fact may change independently; rejecting
only when neither changes preserves legitimate lifecycle-only and
fingerprint-only movement. Invalidation preserves the complete prior review
history and evidence but marks it stale and closes approval, submission,
integration, merge, and tracker-completion eligibility. Its only recovery is
the projected `work.review-target-refresh-command/v1`, which is submitted
through `FlowRuntime.command` with the exact watermark and acknowledges the
observed facts without making stale evidence current or launching a review.
A refresh is idempotent, append-only, and leaves no further action; callers
must prepare and launch a separate fresh review for the observed target.
The movement observation is authority-derived, never a caller assertion. A
durable RunAuthority must be constructed with a named
`reviewTargetObservationAdapter` that declares and supports all three movement
shapes - `fingerprint_only`, `generation_only`, and `combined`. Its observation
must be a typed `flow.review-target-observation/v1` record containing the exact
subject, observed candidate facts, authority evidence watermark, and named
observation source. A partial adapter is rejected at construction; an absent
adapter fails closed at the invalidation command with
`review_target_observation_unavailable`. In-memory authorities use the same
authority observation contract. Refresh reuses the recorded observation and
does not grant lifecycle authority to the caller.

### Local human review through a replaceable tuicr consumer

The local human-review surface is a projection-only consumer seam, not a
second authority or an executable adapter. `tuicr` (or another review UI)
reads the disposable inbox projection from `ReviewAuthority` through the
public five-operation `FlowRuntime` interface and submits only the projected
commands back through `FlowRuntime.command`. The inbox keeps no state and
cannot schedule work, approve or integrate a flow run, advance lifecycle, or
mutate Git. ReviewAuthority remains the sole owner of the review subject and
its append-only human events, so a replacement consumer can be built without
changing authority storage or registering a new operation.

Start or reconnect to the public owner, then inspect the complete inbox or a
one-shot watermarked snapshot:

```sh
flow start --json
flow query --input '{"schema":"flow.query/v1","query":"review_inbox"}' --json
flow watch --input '{"schema":"flow.watch/v1","query":"review_inbox"}' --json
```

`flow.review-inbox-projection/v1` contains the exact `ReviewAuthority`
`watermark` (also published as `authority_watermark`) and an ordered `items`
array. Each item carries the candidate fingerprint and candidate-seal
watermark, lifecycle generation, review authority watermark, candidate and
review inspection projections, and only the legal human-review actions for
that item. The `subject_watermarks` field is the canonical stream snapshot
declared by `flow.review-inbox-watermark/v1`: candidate and review stream
identities are ordered by exact `stream_id`, and each entry carries that
stream's exact watermark. `projection_digest` is the digest of the complete
canonical visible item snapshot, including fresh workspace, artifact,
retention, and handoff observations. The inbox `watermark` binds both that
digest and the ordered source-watermark set; it is not a mutable inbox cursor
or a timestamp. `watch` returns
one such snapshot and does not create a subscription or a new authority
stream.

Each `legal_actions` entry is a complete
`work.review-human-command/v1` template. It repeats the exact
`review_id`, `target_fingerprint`, `candidate_fingerprint`, candidate
authority watermark, lifecycle generation, `expected_watermark`, and
`expected_generation` needed by the authority. An entry with
`operator_input` is a materialization template: collect the named required
fields, remove `operator_input`, and add those fields before sending the
command. For example, after selecting the session-start action, a consumer
materializes and sends:

```json
{
  "schema": "work.review-human-command/v1",
  "type": "review_session_start",
  "contract": "work.review/v1",
  "command_id": "review-session-start:review:<candidate>:1",
  "subject_id": "review:<candidate>:1",
  "review_id": "review:<candidate>:1",
  "target_fingerprint": "sha256:<64 hex characters>",
  "candidate_fingerprint": "sha256:<64 hex characters>",
  "candidate_authority_watermark": "sha256:<64 hex characters>",
  "lifecycle_generation": 1,
  "expected_watermark": "sha256:<64 hex characters>",
  "expected_generation": 0,
  "session_id": "tuicr:<session identity>"
}
```

The same materialization rule applies to `review_comment` (a `comment_id`
and `body`), `review_disposition` (one of `accept`, `request_changes`,
`dismiss`, or `defer`, with an optional `finding_id`),
`review_supersession` (a replacement candidate fingerprint and lifecycle
generation), and `review_integration` (typed evidence matching the candidate
fingerprint and lifecycle generation). The approval action is already a
concrete command with `decision: "approve"` or `"revoke"`. Submit a concrete
command with the normal public command operation:

```sh
flow command --input '<materialized work.review-human-command/v1 JSON>' --json
```

A disposition with `finding_id` is valid only when that ID names a finding
currently surfaced by the review projection. Omit `finding_id` for one overall
review disposition. Each finding can receive one disposition for the life of
the review; a repeated disposition is rejected, and projection rebuilds retain
the recorded per-finding disposition. An unknown or no-longer-surfaced finding
is rejected with the stable `review_finding_not_surfaced` code. A supersession
that repeats the current target fingerprint and lifecycle generation is
rejected without append with the stable `review_self_supersession` code.

Every accepted command appends one ReviewAuthority event and advances both
the review generation and review watermark. A command copied from an older
inbox snapshot is rejected with a typed stale-generation or stale-watermark
result and does not append history. Target fingerprint, candidate-seal
watermark, lifecycle generation, session identity, and action-specific
identity are checked together. Re-query the inbox or review subject after
each receipt and use the newly projected legal action, rather than reusing a
prior action. Once supersession is accepted, the review projection is
terminal for human review (`human_status: "superseded"`, `current: false`,
stale evidence, and no legal actions); a previously projected follow-up is
therefore rejected.

The review subject and events survive owner close/reopen. Discarding a local
inbox snapshot and querying again rebuilds the exact same projection from
ReviewAuthority - it loses and invents no items or actions. Candidate and
review watermarks remain distinct: the candidate watermark fences the sealed
producer output, while the review watermark fences each human event. The
`review_integration` command records supplied evidence and integration
authorization only; it never runs Git integration or changes the repository.
There is no public tuicr command for scheduling, approval outside the review
action vocabulary, lifecycle control, or Git mutation.

### Immutable GitHub pull-request review snapshots

The same `review/v1` semantic graph may target one exact open GitHub pull
request snapshot through `flow.review-github-pull-request/v1`. Preparation
binds the repository, pull-request number, base and head commits, diff digest,
snapshot fingerprint, lifecycle generation, and target-authority watermark.
Launch structurally validates the declared exact snapshot. The Forge Adapter
observes and revalidates the provider snapshot, including an explicitly
observed `state: "open"`, immediately before any remote mutation. A moved
target blocks with zero creation calls.

The optional `flow.operation/github-review-pending/v1` is a one-shot uncertain
operation behind the `FlowRuntime` five-operation Interface. Accepting its
fresh checkpoint can create exactly one `flow.github-pending-review-draft/v1`
as an unsubmitted pending review. The provider receipt must echo the exact
target fingerprint and watermark, draft digest, flow marker, repository,
pull-request number, head commit, review ID, and pending/unsubmitted state.
The Adapter never submits, approves, requests changes, deletes, or reposts a
review. Declining the checkpoint completes locally without Forge mutation.
The request must be exactly `pending_review: { schema:
"flow.github-pending-review-request/v1", mode: "create_pending_unsubmitted" }`;
legacy booleans and aliases are rejected. If the target moves, the retained
review history is projected as invalidated with only recovery or cancellation
actions available.

An approved operation-bound checkpoint also carries the typed
`flow.checkpoint-binding/v1` draft and digest into the durable RunAuthority
effect intent. A runtime restart therefore recovers the same exact draft rather
than relying on process-local approval state.

After invocation, zero or multiple exact provider matches remain indeterminate;
the authority retains the one-shot intent and exposes only exact recovery or
cancel actions. An unrelated provider pending review is preserved and cannot
serve as causation. The semantic GitHub review record, command receipt,
watermark, artifacts, and closed legal-action projection are owned by the
durable Work-domain `ReviewAuthority` and survive FlowRuntime close/reopen.

## Workspace, artifact, and resource handoff authority

`src/work-authority.mjs` exports distinct `getWorkspaceAuthority()`,
`getArtifactAuthority()`, `getReviewAuthority()`, and
`getResourceHandoffAuthority()` accessors. Their
versioned Interfaces register canonical workspace subjects through
`work.workspace/v1`, immutable artifact subjects through `work.artifact/v1`,
query immutable local candidates sealed only by RunAuthority's atomic
finalization through `work.review/v1`, and query retained
`flow.resource-handoff/v1` subjects.
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

Receipt-shaped provider observations use the same versioned receipt policy as
durable provider receipts. Their observation-derived evidence is limited to
`found`, `complete`, `proof`, `rejection_code`, `matching_review_count`, and
`pending_review_count`; unknown fields and secret-shaped values are redacted or
reject the write. The exact sanitized observation is reused for adoption,
absence settlement, durable receipt writing, and historical replay.

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
  tools/flow/test/purity-contracts.test.mjs \
  tools/flow/test/predefined-flow.test.mjs \
  tools/flow/test/feature-flow.test.mjs
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
Drovr registry-lock outcomes are projected as blocked lifecycle results only
when their full registry watermark and closed legal actions validate. A bare
lock may carry its hashed `lock_entry` with `abandon_bare_registry_lock` so an
operator can act on the exact subject. Held-lock proven-absence release remains
operator-only: the port does not accept `release_absent_registry_lock` and
collapses that disposition to `repair_delegated_runtime_registry`. Unknown,
malformed, or internal recovery actions are likewise never exposed as Flow
authority.
Detected ownership loss during lock release is projected as a typed blocked
result with the exact registry watermark and inspection-only actions; Flow
never treats the protected mutation as successful.
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

The logical route `agent_id` is a planning identity, not a Drovr registry ID.
After the existing delegated-agent port proves that no turn exists, Flow uses
the separate deep `flow.delegated-agent-resource-port/v1` seam. Its only
operations are `ensure` and `retire`: the production Adapter derives a
run-scoped resource key from the run/card or managed binding, exact workspace
claim, and launch binding; resolves the canonical cwd through
WorkspaceAuthority; and invokes only public Drovr `openTask`/`startAgent`
resource commands. The projection returns actual group/task/agent IDs, a
binding digest, exact managed pane/process evidence digest, and a registry
watermark. Before the first prompt its native session is null; Drovr binds the
native session during that first logical turn. Dispatch validates the
provisional binding and uses the returned agent ID. Recovery, cancellation,
and terminal disposition
may adopt, retire, or hand off only that exact owned resource. Collisions,
workspace/configuration drift, launch/native identity drift, and uncertain
provisioning or retirement are typed blocks with closed legal actions; an
identity-free `reconciling` projection cannot advance the run. The adapter
seam is injected in production and deterministic tests, so ordered steering,
independent fallback, and declared managed-agent reuse remain Flow policies.

The managed sources under `config/flow/` are:

- `contracts/catalog.v1.json` - public contract names, result-binding and
  feature-capture identities, the five `FlowRuntime` operations, authority
  ownership, the execution-time accounting contract, and the reboot-admission
  typed-fact and uncertainty policy. The current catalog identity is
  `flow.contract-catalog/v1@34`; a catalog change must update this managed
  source and the source constants/tests that validate its exact contents. Any
  future import registration must name
  both an adapter contract and validation-receipt contract. Its receipt must bind the exact imported
  bytes by digest, pass every required validation, and select only the catalog's
  positive `artifact_bytes` subject.
- `schemas/flow.delegate-input-envelope.v1.schema.json` and its
  `flow.delegate-task-inputs`, `flow.delegate-execution-resource-selection`,
  `flow.delegate-execution-resource-reference`,
  `flow.delegate-execution-authority`, `flow.delegate-predecessor-evidence`,
  `flow.delegate-failure-observation`, and `flow.delegate-output-requirements`
  companion schemas - the shared
  canonical input contract used by feature, review, and quick-spike delegates.
- `schemas/flow.transport-request.v1.schema.json`,
  `schemas/flow.transport-response.v1.schema.json`,
  `schemas/flow.transport-error.v1.schema.json`,
  `schemas/flow.owner-endpoint.v1.schema.json`,
  `schemas/flow.owner-status.v1.schema.json`,
  `schemas/flow.runtime-runner-status.v1.schema.json`,
  `schemas/flow.feature-preparation-request.v1.schema.json`, and
  `schemas/flow.feature-candidate-archive.v1.schema.json` - the public host
  and ordinary-preparation payload contracts.
- `schemas/flow.time-fact.v1.schema.json`,
  `schemas/flow.execution-time-accounting.v1.schema.json`,
  `schemas/flow.execution-time-projection.v1.schema.json`,
  `schemas/flow.subject-generation.v1.schema.json`,
  `schemas/flow.reboot-effect-recheck.v1.schema.json`, and
  `schemas/flow.reboot-revalidation.v1.schema.json` - typed reboot facts,
  unresolved-effect evidence, and the exact revalidation record.
- `schemas/flow.delegated-agent-lifecycle-projection.v1.schema.json` - the
  public lifecycle result shape, including authority and discovery watermarks,
  delegation identity, turn evidence, and legal next actions.
- `schemas/flow.delegated-agent-resource-ensure-request.v1.schema.json`,
  `schemas/flow.delegated-agent-resource-retire-request.v1.schema.json`, and
  `schemas/flow.delegated-agent-resource-projection.v1.schema.json` - the
  exact resource-binding requests and closed provisioning/retirement
  projection for the separate resource port.
- `launch-policy.v1.json` - the converged selector policy. Its default is
  `legacy-claude/v1`; `flow-runtime/v1` is disabled.
- `legacy-baselines.v1.json` - content-addressed Git trees for both frozen
  legacy implementations and their permitted change policy.
- `transition-ledger.v1.json` - release, environment, evidence digests,
  statuses, defects, exceptions, decisions, and timestamps.

When `catalog.v1.json` changes, refresh its SHA-256 in the source transition
ledger and set the ledger `recorded_at` and `public_contract_catalog` evidence
timestamp together to the UTC audit instant. The transition query rejects a
catalog evidence timestamp that does not match the ledger timestamp; generated
projections must be refreshed through their documented source process rather
than edited by hand.

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

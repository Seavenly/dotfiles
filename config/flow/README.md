# Flow compatibility inventory

`flow query legacy-inventory --json` is the read-only Stage 0 inventory for
the frozen Claude-only and Hermes-backed flow implementations. It calls the
`FlowRuntime.query` Interface and returns
`flow.legacy-compatibility-inventory/v1`.

The filesystem Adapter observes these retained authority roots:

- `~/.agent-teams/runs` for Claude-only runs;
- `$XDG_STATE_HOME/agent-flow/runs` for Hermes-backed runs and stack records
  retained beneath them.

Agent Flow stack plans and state may also live at operator-supplied absolute
paths. The retained implementation has no global stack registry, so the default
projection marks that authority uncertain instead of inventing a directory.
Callers embedding `FlowRuntime` may provide an explicit `hermesStacks` root
when they have authoritative local configuration for one.

The inventory records runs, reviews, stacks, artifact bytes, transcript
pointers, active ownership claims, and unresolved effects. Evidence is
classified as:

- `verified` - the observed bytes or known record are present and digestible;
- `missing` - an authority root or referenced file is absent;
- `unreadable` - bytes cannot be read as the expected evidence form;
- `uncertain` - retained bytes or expected authority cannot prove the claimed
  lifecycle fact, cannot be enumerated or linked, or use an unknown contract.

`watermark.content_sha256` is the SHA-256 of the canonical `inventory` object.
It excludes presentation and legal actions, so repeated queries over unchanged
inputs produce the same ledger-ready digest. Host-absolute source paths are not
emitted as projected path fields, while exact retained bytes remain bound by
their content hashes. Ordering uses raw string comparison rather than host
locale. The query never creates a legacy root, follows a symlink, repairs
evidence, or imports legacy lifecycle state into replacement authority.
References outside retained roots are not opened or fingerprinted; they remain
explicit uncertain coverage boundaries. Because operator-supplied stack paths
have no retained registry, the default CLI projection keeps
`inspect_legacy_evidence` legal until that authority gap is recorded or resolved.

`flow query delegated-agent ... --json` is the read-only
`DelegatedAgentPort` preparation projection. It reads the tracked Drovr catalog,
resolves one exact launch, verifies the complete flow-required feature baseline,
and exposes the Drovr configuration watermark and closed legal next actions.
It does not create a replacement run or mutate Drovr delegated work. Until all
required lifecycle features advertise `supported`, the projection is a typed
compatibility block with repair and refresh as its only legal actions.

## Qualified release gate

`release-manifest.v1.json` is the capability manifest for the bounded
dark-sacrificial release. The request-local `dark_opt_in` field is accepted by
the feature preparation schema and by the public runtime gate; it must match
the manifest release ID and purpose. The gate is applied at both public
`prepare` and `launch`, before production preparation or run admission, so a
caller cannot bypass it with a predefined bundle or dynamic graph. Legacy
Claude remains the default policy selection.

Only feature `verify` and local review are production-supported routes. The
manifest records feature test/mixed, spike, epic, GitHub review,
tracker/forge, publication, merge, push, and remote mutation as typed
disabled or unsupported outcomes. Missing registered feature adapters also
produce a typed unsupported rejection. The public rejection schema and the
launch rejection schema are kept separate: runtime callers receive
`flow.rejection/v1` with an optional `outcome`, while selector callers receive
`flow.launch-rejection/v1` with the exact route and legal actions.

`transition-ledger.v1.json` binds catalog v33, policy, manifest, release
content, environment, prerequisite commits, legacy inventory, and evidence.
`evidence/release-content.v1.json` binds an exact candidate Git tree ID,
its declared qualification-base commit, and every regular-file byte in the
governed release surface. The governance prefixes include the public host,
`config/flow/`, `tools/flow/`, the supported Drovr implementation and contract
tests, the CLI/transition tests, and the relevant ADRs. Transition evidence
and the ledger are explicitly excluded to avoid a digest cycle. Git-ignored
untracked files under governed prefixes, including generated `node_modules`
and platform metadata such as `.DS_Store`, are outside the projection;
tracked files remain governed. The exact candidate tree ID is derived
from sorted paths, modes, and blob identities with Git tree hashing rules.
Validation checks that derived identity, complete governed listing, every
worktree blob/mode, and realpath containment; it does not depend on the
synthesized Git object being present.

Qualification has two required evidence phases. Phase one binds the immutable
base commit, candidate tree, release-content digest, deterministic recipe, and
TAP receipts from passing core commands and host-fault/reboot commands on the
registered-operation test runtime. Phase two runs production feature verify,
public local-review
process cases, and the real Drovr finding-schema case through the production
public runtime. Its separately hashed record binds phase one, the release tree,
recipe, and TAP receipts. Admission requires both phases; a failed or
incomplete phase keeps it withheld. Regenerate release content first, then
qualification evidence with:

```sh
node config/flow/scripts/generate-release-content.mjs
node config/flow/scripts/generate-qualification-evidence.mjs
```

These artifacts make no claim that the current candidate is committed and do
not record real runs for deferred issue 84/44/46 or remote actions. The
projection withholds `dark_opt_in.available` whenever any required evidence
record is failed, blocked, or not run.

## Public host runtime

The supported public surface is one versioned `flow.runtime/v1` Interface with
exactly five operations: `prepare`, `launch`, `command`, `query`, and `watch`.
The CLI sends each operation through the same bounded newline-delimited JSON
transport. `flow start`, `flow status`, and `flow stop` manage the host owner;
they are lifecycle commands around the five-operation Interface, not additional
FlowRuntime operations.

The default production composition opens one durable `RunAuthority` under
`$XDG_STATE_HOME/flow` (or `~/.local/state/flow`), registers the shipped
feature and review definitions, real Git/workspace and artifact operations,
strict output validators, authority observers, and the configured
`DelegatedAgentPort`. The autonomous runner consumes only current authority
projections. It keeps delegate and operation capacities separate, defaults
each to one slot, and accepts positive bounds from 1 through 64 using
`FLOW_RUNNER_DELEGATE_CAPACITY` / `FLOW_RUNNER_OPERATION_CAPACITY` or the
explicit `runnerOptions` production constructor fields. It does not count
passive child-run observation against operation capacity, and never auto-
admits a checkpoint, capability expansion, uncertain effect, or terminal
disposition.

`flow status --json` includes the live runner status with capacity, active
counts, and bounded sanitized error summaries. A detached owner also retains
sanitized runner and transport diagnostics in the private `owner-errors.json`
file under its authority directory; raw provider payloads and error messages
are never written there.

Clients do not own the authority lock. The host owner is fenced by its exact
endpoint identity and survives client exit; competing clients can query and
watch through the private Unix socket. Same-boot owner restart replays the
durable authority and reconciles outstanding effects. Reboot admission remains
an explicit per-run command. For platform-manager templates and the explicit
opt-in procedure, see [`host/README.md`](host/README.md).

## Delegate input compatibility

Since catalog v32, one versioned input contract is published for every dynamic delegate
card and shipped delegated role: feature apply and critique (including serialized slices), local
and GitHub review lenses and critic, and quick-spike researcher and synthesizer
all send `flow.delegate-input-envelope/v1`. Each envelope selects bounded
`instructions`, minimal `task_inputs`, exact `resource_references`, any
declared `predecessor_evidence`, and `output_requirements`.

`resource_references` are execution access facts resolved through the owning
authority. A prepared card carries the plan-time
`flow.delegate-execution-resource-selection/v1` shape: an exact subject fact
and `authority_binding_id`, with no inline binding. RunAuthority resolves that
selection through its immutable `required_authority_bindings` and transmits
only the resolved `flow.delegate-execution-resource-reference/v1` shape with
the exact inline owning-authority binding. Workspace references use
`WorkspaceAuthority`, and artifact references use `ArtifactAuthority`. A
`resource_handoff` is not a delegate resource kind; handoff publication remains
an explicit Work operation outside the delegate input envelope. These execution
access facts are not transferable evidence and do not carry paths, credentials,
capability secrets, the prepared bundle, or ambient transcripts.
When a predecessor join is declared, `predecessor_evidence` is the exact
RunAuthority-materialized, issue-79-compatible evidence receipt and binding;
the evidence-safety catalog identity is
`flow.contract-catalog/v1@33`.

Callers select instructions, minimal task-input IDs and facts, resource
selection IDs, and output requirements. RunAuthority derives execution
authority from the immutable exact route description's effective-authority
digest and accepted capability facts, and derives predecessor evidence from
the declared lifecycle join. The baseline `read-only` route is bound by the
exact route effective-authority digest without a separate capability grant;
other Drovr postures map to Flow grants (`on-approve` to `scope:approve`,
`workspace-write` and `auto` to `repository:write`) and require that grant
for the specific card; `unrestricted` has no finite Flow mapping and is
rejected. The port
transmits canonical JSON UTF-8 bytes and their SHA-256 digest. Initial input
and ordered steering share the same attempt/input-key/sequence correlation,
so retries and discovery cannot reuse a caller key for different bytes. Local
review targets receive only their approved read-only `WorkspaceAuthority`
reference. GitHub review targets select their exact remote snapshot and are
resource-free with no ambient local workspace. Live mixed-harness
qualification remains out of scope here and belongs to issue #44.

The same configured port is the mechanism Adapter for confirmed delegate
cards. A caller embedding `FlowRuntime` supplies the durable `RunAuthority` and
registered independent output validators. Flow reserves the exact attempt and
route before it asks Drovr to discover or dispatch, and recovery always
discovers the derived caller key first. Only exact settled output accepted by
every bound validator becomes run evidence. Late or incompatible output is
retained as correlated quarantine and cannot advance the run. Drovr owns its
delegated resources only; it cannot schedule cards or author Flow lifecycle
events. Flow records a named durable handoff while a bounded retry remains and
requires an exact Drovr cancellation proof before handing off an agent whose
turn is still working. An unproven cancellation leaves that same attempt
unresolved for recovery. Flow requires a Drovr retirement receipt before
accepted or exhausted delegated work can settle. A non-destructive bounded
wait preserves the current attempt for same-turn recovery rather than
consuming retry capacity.

Declared managed-agent reuse binds a complete ordered card set to one exact
launch and names the terminal card that must retire it; duplicate agent routes
without that binding fail preparation. A revision also fails preparation when
its pending dependent closure would supersede a card inside the binding,
including from an upstream block. A pre-approved fallback binds one exact
retry to a different harness with the same effective-authority comparison key,
so retry cannot widen capability. Steering inputs carry stable caller
identities and become part of ordered settlement proof. Ambiguous dispatch
stays reconciling. Run cancellation records a fenced cancellation effect,
closes the exact live turn, hands its agent back to the durable registry, and
then permits quarantined delegate retirement settlement. A run terminating
between declared managed cards retires its held agent before cancellation or
decline completes; proven-absent turns hand cleanup to the durable registry.

The public host payload contracts are maintained beside this inventory:

- `schemas/flow.transport-request.v1.schema.json`,
  `schemas/flow.transport-response.v1.schema.json`, and
  `schemas/flow.transport-error.v1.schema.json` define the bounded five-
  operation transport frames;
- `schemas/flow.owner-endpoint.v1.schema.json`,
  `schemas/flow.owner-status.v1.schema.json`, and
  `schemas/flow.runtime-runner-status.v1.schema.json` define host identity and
  autonomous capacity projections; and
- `schemas/flow.feature-preparation-request.v1.schema.json` and
  `schemas/flow.feature-candidate-archive.v1.schema.json` define the ordinary
  feature preparation and captured archive descriptors.

Host-manager definitions remain explicit opt-in sources under `host/`. Their
installation and lifecycle procedure is documented in
[`host/README.md`](host/README.md); normal dotfiles convergence does not load
or enable them.

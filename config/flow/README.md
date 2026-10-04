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
optional Drovr `DelegatedAgentPort` preparation projection. With
`FLOW_EXECUTION_BACKEND=drovr`, it reads the tracked Drovr catalog,
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

In the default `flow-release-1.0-dark/v1` configuration, only feature `verify`
and local review are production-supported routes. The
manifest records feature test/mixed, spike, epic, GitHub review,
tracker/forge, publication, merge, push, and remote mutation as typed
disabled or unsupported outcomes. Missing registered feature adapters also
produce a typed unsupported rejection. The public rejection schema and the
launch rejection schema are kept separate: runtime callers receive
`flow.rejection/v1` with an optional `outcome`, while selector callers receive
`flow.launch-rejection/v1` with the exact route and legal actions.

`transition-ledger.v1.json` binds catalog v38, policy, manifest, release
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
incomplete phase keeps it withheld. The generator's temporary running phase is
available only to its child process through an inherited descriptor; it is not
a public constructor, request, or environment capability. Both phases must
also match the admitting host's exact OS, architecture, Node, npm, and Git
versions, so evidence from another supported host class fails closed until
that host is qualified separately. Regenerate release content first, then
qualification evidence with:

```sh
node config/flow/scripts/generate-release-content.mjs
node config/flow/scripts/generate-qualification-evidence.mjs
```

Both generators accept `--config-directory PATH` and `--repository-root PATH`
independently; omitting them preserves the root release. Generate the separate
test release content with `--config-directory config/flow/releases/1.1-dark-test
--repository-root .`. Its initializer copies the shared catalog, required
features, legacy inventory and historical host evidence as contained regular
files. Source qualification and conformance remain `not_run`.

For deterministic fixture bootstrap only, the content generator accepts
`--feature-test-fixture-receipt PATH` for the retained pre-D public fixture TAP
with SHA-256 `3e001e0924fa8b3466c02488029bcbaabf74a48140966e372ac986a82c23e050`.
It copies those actual historical bytes into the test release's excluded
`evidence/receipts/public-production-feature-test.tap`. The copied fixture
helper may reuse them inside a disposable authority. This historical receipt
does not qualify changed source or a native provider; a fresh public test and
separate native qualification remain required. Content generation does not run
the qualification generator or grant its bootstrap mode authority.

These phase-one and phase-two artifacts make no claim that the current
candidate is committed and do not record real runs for deferred issue 84/44
or remote actions. First-release host recovery is qualified separately by the
issue-46 catalog and external raw receipts documented in
`qualification/README.md`; actual reboot and expanded macOS visuals remain
deferred to issue 47. The projection withholds `dark_opt_in.available`
whenever any required evidence record is failed, blocked, or not run.

### Separate feature-test pilot

`releases/1.1-dark-test/` declares `flow-release-1.1-dark-test/v1`. Select it
explicitly with `FLOW_CONFIG_DIRECTORY` and set
`FLOW_QUALIFICATION_REPOSITORY_ROOT` to the repository containing the governed
runtime sources. The root configuration and its disabled test/mixed routes are
unchanged. Both selections require their own exact manifest and qualification;
historical evidence copied into the new configuration does not qualify native
test execution. Native test qualification remains **NOT_RUN**. The public
request and configuration example are in the
[operator guide](../../docs/flow/operator-guide.md#separate-feature-test-pilot).

Trusted owner composition injects one `featureTestCheck` through the production
`createFlowRuntime` constructor. There is no public request or CLI loader for
this private configuration. Missing or invalid configuration keeps the test
operation unavailable while preserving verify and review construction. This
pilot supports one direct Linux Codex test slice; mixed mode stays disabled.

The check configuration pins a Node 22 executable and version, workspace-relative
committed acceptance and positive health files with one named `node:test` case
each, any additional pinned files, the exact ordered brief criteria, an expected
`ERR_ASSERTION`/`strictEqual` failure, a fixed PATH, timeout and output bounds.
The selected slice owns every brief criterion exactly once. The fingerprint
also binds the reporter, operation/check implementation, Python supervisor and
fixed bubblewrap sandbox. Implementation files that the writer must change are
not check inputs to pin. Preparation and prelaunch comparison run no probes;
`environment_status:"healthy"` in the selection is a requirement, not health
evidence. Changed configuration, check bytes or runner identity refuses launch
before run creation or workspace claims.

The registered operation observes positive health and the exact intended RED
before the single writer. The fixed `/usr/bin/bwrap` runner (bubblewrap 0.11.1)
uses a read-only workspace, isolated network, no host home/auth mounts, private effect scratch,
and bounded output/time. It requires the supported Linux sandbox, subreaper and
pidfd capabilities; unavailable containment fails closed. This is a limited
Node check runner, not an arbitrary command service. Registered direct commit,
capture, slice GREEN verification, aggregate capture, independent critique,
aggregate verification and seal then produce the local candidate. GREEN reruns
the unchanged health and acceptance checks and requires the retained exact RED
receipt.

The durable check worker owns its descendants independently of a disposable
client or Flow owner. Same-boot owner restart may adopt the exact retained
terminal evidence when the worker has positively retired before the new owner
observes it. A pending checker remains indeterminate and is never blindly
replayed. That observation consumes no fresh attempt, but later terminal
retirement does not automatically reopen exhausted recovery. Preserve its
claims and evidence and use the actions actually returned by the runtime,
currently cancel. Deterministic public success/restart fixtures do not qualify
native Codex startup or permission enforcement, actual reboot or manager
shutdown.

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

### Isolated production backup and restore

Production backup and restore are composed only when the owner is given an
explicit absolute `FLOW_BACKUP_DIRECTORY` and an explicit absolute
`FLOW_REPOSITORY_ROOT`. The provider directory must be outside the resolved
authority directory; it is created owner-private and stores canonical,
manifest-digest-addressed records. The equivalent constructor options are
`authorityOptions.backupRestoreDirectory` and
`authorityOptions.backupRestoreRepositoryRoot`.

Without those explicit isolated paths, or when they are invalid, the runtime
keeps the fail-closed null backup adapter and reports a typed unavailable
observation. Default legacy compatibility roots and the ambient current
working directory are never inferred as backup sources. Callers that need
legacy files in an isolated backup must pass those roots explicitly through
the `legacyRoots` constructor field.

Production qualification also requires an absolute isolated `XDG_STATE_HOME`
for the resolved Flow authority and an isolated absolute `DROVR_CONFIG_DIR`
with its effective configuration/session bound to that same disposable
environment. Ambient HOME/XDG/Drovr defaults and shared state are not valid
isolation prerequisites and must remain fail-closed or qualification
unavailable.

`backup_create` observes the durable authority, Git identity, artifact bytes,
and any explicitly supplied legacy roots before recording its intent. The
provider then writes an atomic idempotent record containing the canonical
manifest and contained snapshots. `restore` copies only those manifest-bound
files and imports exact retained authority streams while preserving the fresh
host admission fence. The public restore barrier still requires fresh
reconciliation of all six evidence domains and an exact `restore_admit` action;
provider failure or changed evidence remains a typed block.

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
`flow.contract-catalog/v1@38`.

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

The route `agent_id` is a planning identity, never a Drovr registry ID. After
turn discovery proves exact absence, Flow's separate
`flow.delegated-agent-resource-port/v1` performs the two-operation
`ensure`/`retire` lifecycle: it resolves the canonical cwd through
WorkspaceAuthority, opens or adopts only the deterministic run-scoped task and
agent key through public Drovr resource commands, and returns the actual
registry IDs with a binding digest and watermark. Dispatch and recovery use
that returned identity; collisions, workspace/configuration drift,
launch/native drift, and uncertain resource actions block with closed legal
actions instead of making identity-free progress. Declared managed-agent
reuse, ordered steering, and independent fallback remain the existing Flow
policies.

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
  feature preparation and captured archive descriptors; and
- `schemas/flow.review-preparation-facts.v1.schema.json` defines the
  authority-derived, digest-bound local-review preparation envelope.

Host-manager definitions remain explicit opt-in sources under `host/`. Their
installation and lifecycle procedure is documented in
[`host/README.md`](host/README.md); normal dotfiles convergence does not load
or enable them.

## Direct CLI execution and optional Drovr

The approved scope for issue #92 is a Linux Codex-first dark pilot. This scope
decision does not qualify native execution: current release qualification remains
`not_run`, and public admission remains `qualification_withheld`. Issue #84 must
qualify real Codex startup and permission enforcement against the exact pilot
release before native pilot use. The later full release under parent #2 still
requires both official harnesses. Claude remains blocked by
`claude_native_policy_unproven`; macOS direct execution is unsupported. Sole owner
authority, conservative recovery and independent review remain mandatory. This
pilot does not authorize normal use, legacy-default cutover or remote mutation.

The replacement Flow runtime selects the `direct` execution backend by default.
This is separate from the public launcher policy, whose legacy default remains
unchanged. Set `FLOW_EXECUTION_BACKEND=drovr` before starting an isolated owner
to select the optional historical Drovr adapter. Backend selection never
rebinds existing attempts. `FLOW_CODEX_EXECUTABLE` selects an absolute official
Codex executable; the adapter pins its resolved path, bytes and exact version
(`codex-cli 0.160.0`). An explicit unavailable executable never falls back.

Direct descriptions use `flow.execution-description/v1` and advertise only
implemented initial-input/structured-output semantics. `workspace-write-denied`
requires the card's `repository:write` grant and denies escalation, approvals
and delegate tool network. Direct tasks reject the old human/automatic-review
postures, steering, session continuation and backend switching. `read-only`
uses no mutation grant. Unknown ambient project/managed hooks, plugins or
configuration block; argv alone is not permission qualification. The only writable roots are the exact workspace and owned task scratch;
ambient `/tmp` and `$TMPDIR` grants are excluded. Provider transport and native
saved authentication remain the official CLI's concern.

The provider-local Claude argv/parser is implemented against Claude Code 2.1.287,
but native admission always returns `claude_native_policy_unproven`: managed
hooks and additive roots cannot yet be proven before startup. It advertises no
usable Claude route. Generic effort selection remains Codex-shaped until that
blocker is resolved, so Claude `max` is not admitted by the shared port.

Linux direct tasks require `/usr/bin/python3` with subreaper and pidfd support.
The resolved interpreter and worker bytes are pinned; Python starts with
`-I -S`, and cancellation signals verified ancestry through exact process handles. Flow
owns a private immutable descriptor, exact input/schema bytes, raw output and
atomic terminal receipt under its authority directory. The detached task worker
has no scheduling authority. It retains escaped descendants until positively
reaped; PID age, parent death, missing output or empty process group never prove
retirement. Missing or conflicting receipts remain blocked without blind replay.
macOS direct mutation is unsupported before spawn; use the optional Drovr path
until equivalent containment is implemented and qualified.

Direct feature delegates edit files without access to protected `.git` state.
The prepared `flow.operation/feature-direct-commit/v1` records a local Git
mutation explicitly, reserves exact old/new commit evidence before ref CAS,
and then leaves existing capture, independent critique, operation verification,
sealing, retention and handoff gates in force. No future candidate identity is
supplied by the preparation caller. No push, separate review, remote mutation
or normal-use permission follows from task success.

Implementation fixtures are deterministic subprocess evidence. Native direct
startup/permission, both harnesses, public host recovery and supported-host
qualification remain pending. Changed source/catalog identity withholds public
admission; release content must be regenerated by the documented generator,
and older Drovr qualification cannot be relabeled. See
[ADR-0010](../../docs/adr/0010-use-direct-cli-tasks-as-primary-flow-execution.md) for
the execution decision and limits.

# Dotfiles convergence

This repository describes and converges a personal development environment on
supported hosts while preserving machine-local identity, secrets, and state.

## Language

**Convergence**:
Applying the repository until every managed resource matches its declared state.
_Avoid_: Setup, provisioning

**Host**:
A supported macOS workstation or Ubuntu server receiving the managed environment.
_Avoid_: Machine, target

**Managed resource**:
A tool, package, repository, preference, configuration link, or cache whose desired state is declared here.
_Avoid_: Dotfile when referring to non-file state

**Machine-local configuration**:
Host-specific identity, paths, aliases, and secrets stored outside the repository.
_Avoid_: Private dotfiles, overrides

**Migration**:
An ordered, idempotent transition from a previously managed layout to the current one.
_Avoid_: Bootstrap step, cleanup

**Bootstrap lifecycle**:
The ordered phases that validate a host, apply managed resources, run migrations, and warm derived state.
_Avoid_: Install script

**Recorder**:
The optional macOS recording and transcription environment managed separately from the default convergence path.
_Avoid_: Recording stack

**Flow**:
A named, repeatable agent strategy for producing and reviewing a software outcome.
_Avoid_: Workflow when referring to both interactive preparation and automated execution

**Flow run**:
One durable execution of a flow, including its approved inputs, internal execution history, and resulting artifacts.
_Avoid_: Job, session

**Run ownership**:
The authority-recorded relationship that identifies a flow run as top-level or
as a child of one exact parent run.
_Avoid_: Caller-declared scope, tracker ownership

**Tracker binding**:
The confirmed tracker identity and flow kind that a top-level run may use for
an external progress projection.
_Avoid_: Tracker authority, scheduling source

**Workspace subject**:
A generation-fenced managed repository workspace identified canonically and
bound to exact Git facts, mutation epoch, and disposition by WorkspaceAuthority.
_Avoid_: Worktree path, branch name

**Workspace claim**:
The sole durable mutation lease for one exact workspace generation and Git
fingerprint, held by one run for explicitly named operations.
_Avoid_: Lock file, assumed ownership

**Workspace taint**:
Durable uncertainty about a workspace mutation or destructive effect that
survives process termination and reboot until exact evidence disposes it.
_Avoid_: Warning flag, best-effort cleanup state

**Artifact subject**:
Immutable content identified by digest and governed with schema, provenance,
classification, retention, pins, and byte availability by ArtifactAuthority.
_Avoid_: Artifact path, latest artifact

**Resource handoff**:
An immutable generation-bound transfer that binds an exact workspace subject,
artifact subjects, producer evidence, consumer authority, and retention duties.
_Avoid_: Producer workspace, latest result

**Resource disposition**:
An evidence-backed authority decision that retires a resource only after its
pins and cleanup obligations are discharged, making exact cleanup eligible.
_Avoid_: Delete request, garbage-collection hint

**Authority schema transition**:
An atomic, versioned change to replacement authority storage, bound to one
exact runtime release and preserving replay of compatible records.
_Avoid_: Flow implementation transition, host convergence

**Flow card**:
One immutable executable node in an accepted finite flow run plan. Dependency
edges determine readiness but never imply ambient data transfer.
_Avoid_: Kanban card when discussing replacement authority

**Prepared run**:
One immutable, content-addressed run bundle produced from a complete proposed
plan and explicit identity-bearing facts without creating authoritative run
state.
_Avoid_: Draft run, pending run

**Plan fingerprint**:
The content digest of the canonical finite run-plan graph. It identifies the
graph but not the wider prepared bundle or its explicit facts.
_Avoid_: Run ID, version number

**Dynamic plan confirmation**:
The complete operator-visible view bound to a prepared dynamic plan, followed
by an explicit accept or decline decision bound to that exact view and bundle.
_Avoid_: Boolean flag, implicit approval

**Predefined flow definition**:
A registered, versioned flow contract whose trusted compiler derives one exact
plan from explicit selection inputs and identity-bearing facts. The definition
supplies the promised outcomes, negative outcomes, and trust posture that
accompany its plan.
_Avoid_: Caller-supplied graph, flow alias

**Predefined flow confirmation**:
The operator-visible view for one selected predefined flow definition, covering
its inputs, outcomes, authority, routes, limits, trust posture, and revision
templates before one explicit accept or decline decision. It is distinct from
dynamic plan confirmation and does not require repeating the complete graph.
_Avoid_: Implicit approval, graph ceremony

**Feature brief**:
One accepted, identity-bearing feature request whose acceptance criteria must
all receive registered-operation verification verdicts before a local review
candidate can be sealed.
_Avoid_: Delegate prompt, issue snapshot

**Safe baseline**:
A non-mutating pre-change observation whose fingerprint must differ from the
verified clean post-mutation workspace fingerprint.
_Avoid_: Assumed prior behavior, prose-only expectation

**Compensating assertion**:
An explicitly non-destructive invariant used when obtaining a safe baseline is
not practical; its registered receipt must bind the selected assertion and
prove it remained satisfied after the change.
_Avoid_: Destructive probe, unverified claim

**Discriminating evidence**:
Registered-operation evidence that binds either a safe baseline to a distinct
post-mutation state or a compensating assertion to its satisfied receipt.
_Avoid_: Delegate self-report, selected fingerprint alone

**Feature finalization binding**:
The selected candidate identity and exact handoff publication that cross-bind
the workspace generation, mutation epoch, clean Git transition, artifacts, and
retention before execution begins.
_Avoid_: Latest workspace, publication assembled after verification

**Feature verification receipt**:
The registered verification operation's self-digest-bound verdicts and
discriminating evidence for every acceptance criterion in one feature brief.
_Avoid_: Delegate output, partial verdict list

**Feature critique receipt**:
The sealed operation receipt that binds independent critique evidence and its
non-blocking findings to the exact candidate finalization effect.
_Avoid_: Unbound review prose, ignored blocking finding

**Checkpoint decision**:
A typed approve or decline command for one currently actionable checkpoint,
bound to the exact authority watermark from which it was offered.
_Avoid_: Setter, unlock

**Card block**:
A typed inability to advance one named flow card, admitted into run authority
only from a validated, digest-bound Adapter observation. Its resolution is a
closed capability grant or plan revision rather than a generic unblock.
_Avoid_: Pause flag, lock

**Capability grant**:
An append-only authority decision that expands a confirmed capability envelope
for named flow cards at one exact plan fingerprint, trigger, and authority
watermark.
_Avoid_: Global permission, toggle

**Revision trigger**:
The validated typed observation that binds one card block to the exact plan
revision templates authority may offer.
_Avoid_: Free-form reason, retry condition

**Plan revision**:
An append-only, exact-base change set that may add cards, edges, card-bound
capabilities, resources, and limits while superseding only blocked pending work
and its pending dependent closure. It never rewrites accepted upstream history.
_Avoid_: In-place plan edit, restart

**Reboot admission**:
The exact public command that rechecks one suspended run against its current
authoritative contracts, routes, capabilities, revision facts, typed time and
subject facts, and unresolved-effect evidence before restoring admission. It
admits only that run; child runs require their own admission.
_Avoid_: Automatic resume, process restart

**Restore barrier**:
The host-wide RunAuthority state entered before restored authority or host
resources may mutate. It remains active until exact database-stream, artifact,
Git, filesystem, external-effect, and Drovr-obligation observations reconcile
to one deterministic backup manifest.
_Avoid_: Run pause, rollback, best-effort restore

**Time fact**:
An exact typed observation of wall-clock time, suspend-excluding monotonic time,
boot identity, or clock-source identity. Time facts carry their uncertainty and
enter lifecycle policy only through deterministic lower and upper bounds.
_Avoid_: Ambient clock read, elapsed-time guess

**Subject generation**:
The exact durable generation and fingerprint of a resource or authority subject
that a prepared run binds and reboot admission rechecks. A changed or uncertain
generation blocks admission until the current subject matches the bound fact.
_Avoid_: Latest version, ambient resource state

**Run authority**:
The sole fenced authority that accepts a flow plan and owns readiness,
admission, attempts, checkpoints, blocks, revisions, cancellation, and flow-run
finalization.
_Avoid_: Controller, scheduler, projection

**Child run identity**:
The deterministic run identity derived from one parent run, immutable subrun
card identity, and revision ordinal. Replays adopt this exact identity rather
than allocating replacement work.
_Avoid_: Nested task ID, generated child ID

**Child run lineage**:
The immutable parent run, subrun card, card identity, and revision ordinal
binding stored with an independently authoritative child run.
_Avoid_: Parent pointer, execution context

**Registered operation**:
A versioned operation contract paired with an Adapter that declares one effect
classification and implements the invocation and any required reconciliation
observation.
_Avoid_: Arbitrary callback, executor plugin

**Effect intent**:
The durable, authority-committed identity and complete invocation facts for one
operation attempt. It must exist before an external effect is invoked.
_Avoid_: Request log, retry token

**Effect observation**:
Typed reconciliation evidence about the presence, absence, or uncertainty of
one exact effect intent. Presence requires exact causation, while absence
requires affirmative provider evidence.
_Avoid_: Missing receipt, provider lookup result

**Effect receipt**:
Positive, identity-bound provider evidence that settles one effect intent and
allows its deferred operation completion to become authoritative.
_Avoid_: Return value, successful process exit

**Evidence safety receipt**:
The deterministic, self-digest-bound result of validating canonical evidence
against the exact versioned policy and catalog identity before a delegate
transfer, artifact acceptance, or resource-handoff publication. It carries no
lifecycle, publication, mutation, or capability authority.
_Avoid_: Delegate output, artifact authority, lifecycle receipt

**Evidence safety rejection**:
A typed, redacted failure from the evidence safety validator whose stable code
never reproduces rejected input bytes or fragments.
_Avoid_: Sanitized transcript, secret-bearing error

**Effect classification**:
The declared recovery semantics for a registered operation: read-only,
caller-idempotent, reconcilable, or one-shot uncertain.
_Avoid_: Retry count, implementation hint

**Flow implementation transition**:
The staged change in which implementation accepts future flow launches while
each existing run remains owned by the implementation that created it.
_Avoid_: Host convergence, state migration

**Launch policy**:
The converged, versioned selector that names which flow implementation accepts
new launches. Installed code and existing state never select an implementation.
_Avoid_: Feature flag, auto-detection

**Frozen legacy baseline**:
A content-addressed legacy flow implementation that may change only for a
critical correctness or security repair with explicit legacy evidence.
_Avoid_: Deprecated code, migration source

**Transition ledger**:
The machine-readable evidence record for a flow implementation release and
environment, including evidence digests, status, defects, exceptions,
decisions, and timestamps.
During Stage 0, exception entries represent unresolved deviations and fail
closed by withholding launch actions. Approved choices belong in decisions.
_Avoid_: Checklist, progress view

**Authority watermark**:
An exact version or digest identifying the authoritative state from which a
projection was derived.
_Avoid_: Updated time, cache version

**Delegated agent runtime**:
A host-local execution substrate that launches and observes durable agent harnesses without owning flow policy or scheduling.
_Avoid_: Orchestrator, workflow engine

**Drovr qualification catalog**:
The versioned source of known production-incident scenarios and the contracts
used to qualify Drovr for supervised reusable-agent review cycles.
_Avoid_: Test list, issue-history index

**Qualification scenario**:
One named Drovr incident contract that binds public commands, preconditions,
typed outcomes, safety invariants, execution class, evidence, and cleanup duties.
_Avoid_: Test case, reproduction note

**Qualification evidence**:
The version-bound result of executing one qualification scenario, including
public invocations, typed observations, assertions, limits, and cleanup receipt.
_Avoid_: Test log, transcript dump

**Qualification cleanup receipt**:
The evidence-backed disposition of every resource created by one qualification
scenario, including proof that prohibited mutations and caller-owned workspace
changes did not occur.
_Avoid_: Teardown log, cleanup success flag

**Qualification soak**:
A bounded, version-bound promotion run that evaluates consecutive live
qualification cycles and required deterministic, live-conformance, and fault
verification at one exact Drovr source commit.
_Avoid_: Test batch, retry loop

**Soak cycle**:
One isolated live qualification scenario execution within a qualification
soak, with exact managed-agent and native-session reuse, measurements, policy
proof, and a qualification cleanup receipt.
_Avoid_: Agent attempt, test case

**Soak binding**:
The exact Drovr commit, source cleanliness, Herdr and native integration
versions, executable versions, model and reasoning configuration, configuration
digest, and qualification-catalog identity required for one soak decision.
_Avoid_: Environment snapshot, compatibility hint

**Soak decision**:
The immutable promote or unqualified result derived from every recorded soak
cycle, required coverage, consecutive streak, verification result, binding,
and residual limitation.
_Avoid_: Promotion flag, test summary

**Delegated agent port**:
The non-authoritative Flow interface that requests an exact delegated-runtime
description and independently checks it before plan preparation may bind it.
_Avoid_: Runtime controller, scheduler

**Exact launch description**:
A non-mutating, identity-bearing resolution of one delegated launch, including
its native settings, effective authority, capacity, credential-reference
identity, caller metadata, feature advertisement, and comparison keys.
_Avoid_: Launch request, agent reservation

**Feature advertisement**:
The delegated runtime's versioned statement of each Flow-required contract and
whether that contract is currently supported or unavailable.
_Avoid_: Version check, best-effort capability list

**Effective authority**:
The normalized multidimensional approvals, filesystem, and network envelope
resolved for an exact launch capability.
_Avoid_: Scalar privilege level, sandbox flag

**Delegated capacity**:
The delegated runtime's declared concurrency and managed-agent limits, exposed
as planning facts while admission remains owned by the caller.
_Avoid_: Scheduler quota, available worker count

**Comparison key**:
A deterministic digest for one identity-bearing description component, used to
compare exact launch, authority, credential-reference, and catalog bindings.
_Avoid_: Display hash, timestamp

**Delegation group**:
A named collection of related delegated tasks that share one runtime workspace.
_Avoid_: Epic, project

**Delegated task**:
One independently delegated body of work with its own runtime tab, cwd, and managed agents.
_Avoid_: Kanban card, flow run

**Managed agent**:
A durable harness conversation assigned to one delegated task and retained across logical turns until explicitly retired.
_Avoid_: Worker attempt, pane

**Logical turn**:
One request to a managed agent, including any ordered steering inputs and the final settled assistant result.
_Avoid_: Native harness turn, prompt

**Durable registry lock**:
An atomically published, owner-checked authority record for one resource key,
binding the owning operation, process authority, and exact registry watermark at
acquisition. It is released only by its owner token and is never taken over by
age or a timer.
_Avoid_: Lease, stale-directory cleanup, force unlock

**Registry operation identity**:
The stable kind and resource identity for one Drovr mutation, bound to a
canonical digest of its exact invocation payload so retries can prove they are
continuing the same operation.
_Avoid_: Caller key alone, retry UUID, lock age

**Process identity**:
The validated schema, positive process ID, boot identity, and start token used
to distinguish one owning process from PID reuse. Missing or malformed facts are
unproven rather than proof of absence.
_Avoid_: PID alone, liveness guess

**Recovery decision**:
A typed, watermark-bound adoption, proven-absence, or bare-lock abandonment
decision derived from current registry and process evidence. Its legal actions
are closed and operation-specific; operator disposition does not claim an
operation is absent. Bare-lock abandonment has the closed types
`owner_terminated`, `operation_failed`, `operation_cancelled`, and
`operator_disposition`. Both public operator dispositions persist the decision
receipt. Releasing a held absent-owner lock additionally binds the exact lock
ID.
_Avoid_: Timer expiry, generic unlock, caller assertion

**Semantic harness**:
The internal Drovr interface that delivers and observes logical turns, ordered input, identity, interruption, staged input, and recovery evidence without exposing Herdr commands, native prompt keys, polling, or transcript parsing to callers.
_Avoid_: Herdr client wrapper, harness controller

**Identity evidence**:
Typed proof that the expected managed agent, pane, native session, staged snapshot, or ownership relationship is present, absent, changed, or uncertain.
_Avoid_: Boolean health check, latest observation

**Managed runtime identity**:
The versioned binding of a managed agent to its exact pane, executable, managed
PATH, native session, and foreground process, used to prove that later runtime
operations still target the same execution.
_Avoid_: Runtime health, process snapshot

**Tracker issue**:
An externally visible GitHub or Jira commitment that owns intent and acceptance criteria.
_Avoid_: Kanban task, card

**Legacy Kanban card**:
An authoritative internal executable stage in the frozen Hermes-backed flow
baseline. In the replacement, Kanban is only a rebuildable projection of flow
cards.
_Avoid_: Flow card, tracker issue

**Worker attempt**:
One execution of a flow card or legacy Kanban card, including a retry or
recovery execution of the same card.
_Avoid_: Card, task

**Review candidate**:
A verified local branch plus immutable comparison points and review artifacts, ready for agent or human review but not yet delivered.
_Avoid_: Pull request, review session

**Review manifest**:
The durable identity, lifecycle generation, evidence history, and immutable Git
comparison points for one review candidate.
_Avoid_: Registry entry, tuicr session

**Review projection**:
A rebuildable, derived view of a review manifest for discovery and display.
_Avoid_: Review state, approval record

**Integration receipt**:
Durable evidence binding a reviewed head to the exact target ref, resulting
commit, and resulting tree after Git integration.
_Avoid_: Merge flag, approval

**Completion PR**:
The single pull request whose merge delivers the complete external outcome and permits its tracker issue to become Done.
_Avoid_: Stack PR, feature PR

**Stack plan**:
A human-approved review-layer topology bound to one immutable source commit,
target SHA, and forge coordinate.
_Avoid_: Split session, mutable stack

**Active stack generation**:
The exact verified chain of reviewed layer heads currently authorized for
publication and delivery, derived from one stack plan without rewriting it.
_Avoid_: Restack receipt, mutable stack

**Delivery assembly**:
The ordered replay of reviewed stack layers into the dedicated delivery branch,
followed by exact-tree and full-verification gates.
_Avoid_: Stack merge, completion PR

**Compatibility inventory**:
A read-only, content-addressed projection of retained legacy authority and
evidence used to qualify an implementation transition without importing legacy
lifecycle state into replacement authority.
_Avoid_: Migration record, replacement run

## Relationships

- **Convergence** applies **managed resources** to exactly one **host**.
- A **host** owns exactly one set of **machine-local configuration**.
- The **bootstrap lifecycle** runs pending **migrations** before warming derived state.
- The **recorder** extends **convergence** only when explicitly enabled.
- A replacement **flow run** executes **flow cards**, each of which may have
  multiple **worker attempts**.
- **Run ownership** is recorded by **run authority** at launch; a child run
  cannot acquire a top-level **tracker binding**.
- A **tracker binding** permits only a rebuildable progress projection and
  never grants tracker state lifecycle or acceptance authority.
- A **resource handoff** binds one exact generation of a **workspace subject**
  and its retained **artifact subjects** for a later flow run.
- A **registered operation** creates one **effect intent** under **run
  authority**; an **effect receipt** settles it, while an **effect observation**
  supports recovery according to its **effect classification**.
- An **authority schema transition** changes only the replacement authority
  store contract; it does not migrate legacy authority or select a launcher.
- A frozen Hermes-backed flow run executes **legacy Kanban cards** under its
  original authority.
- The **launch policy** selects an implementation only for future runs; it does
  not transfer existing run authority.
- A **transition ledger** supplies evidence to authority-derived transition
  views, which expose an exact **authority watermark**.
- A **flow** may use a **delegated agent runtime**, but that runtime never owns
  the flow's scheduling or policy.
- A **delegated agent port** checks an **exact launch description**, including
  its **effective authority**, **delegated capacity**, **feature
  advertisement**, and **comparison keys**, without launching delegated work.
- A **delegation group** contains **delegated tasks**; each delegated task owns
  **managed agents**, and each managed agent processes **logical turns**.
- A **qualification soak** evaluates **soak cycles** against one **soak
  binding**; its **soak decision** promotes only when the required streaks,
  coverage, policy, cleanup, and verification evidence all pass.
- A **tracker issue** may own one **flow run** without exposing its internal
  **flow cards** or **legacy Kanban cards**.
- **ReviewAuthority** seals one immutable local **review candidate** only after
  registered verification receipts cover the accepted brief and bind the exact
  clean workspace generation, mutation epoch, Git retention, artifacts, and
  handoff.
- A **review candidate** becomes externally complete only through its
  **completion PR**.
- A **review projection** derives from one **review manifest** and never owns
  approval or lifecycle state.
- An **integration receipt** proves where a **review candidate** entered Git
  history before its **review manifest** advances to integrated.
- An **active stack generation** derives from one **stack plan** and supplies
  the canonical reviewed layers for **delivery assembly**.

## Example dialogue

> **Dev:** "Should this Git identity be another managed resource?"
> **Domain expert:** "No. Identity is machine-local configuration; convergence creates its file but never supplies its value."

## Flagged ambiguities

- "Bootstrap" previously referred both to the full lifecycle and individual
  helper scripts; use **bootstrap lifecycle** for the whole operation and name
  individual phases by their responsibility.

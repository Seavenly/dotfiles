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

**Artifact subject**:
Immutable content identified by digest and governed with schema, provenance,
classification, retention, pins, and byte availability by ArtifactAuthority.
_Avoid_: Artifact path, latest artifact

**Resource handoff**:
An immutable generation-bound transfer that binds an exact workspace subject,
artifact subjects, producer evidence, consumer authority, and retention duties.
_Avoid_: Producer workspace, latest result

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
- A **tracker issue** may own one **flow run** without exposing its internal
  **flow cards** or **legacy Kanban cards**.
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

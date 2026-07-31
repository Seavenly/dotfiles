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

**Run authority**:
The sole fenced authority that accepts a flow plan and owns readiness,
admission, attempts, checkpoints, blocks, revisions, cancellation, and flow-run
finalization.
_Avoid_: Controller, scheduler, projection

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

## Relationships

- **Convergence** applies **managed resources** to exactly one **host**.
- A **host** owns exactly one set of **machine-local configuration**.
- The **bootstrap lifecycle** runs pending **migrations** before warming derived state.
- The **recorder** extends **convergence** only when explicitly enabled.
- A replacement **flow run** executes **flow cards**, each of which may have
  multiple **worker attempts**.
- A frozen Hermes-backed flow run executes **legacy Kanban cards** under its
  original authority.
- The **launch policy** selects an implementation only for future runs; it does
  not transfer existing run authority.
- A **transition ledger** supplies evidence to authority-derived transition
  views, which expose an exact **authority watermark**.
- A **flow** may use a **delegated agent runtime**, but that runtime never owns
  the flow's scheduling or policy.
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

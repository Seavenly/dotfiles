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

**Tracker issue**:
An externally visible GitHub or Jira commitment that owns intent and acceptance criteria.
_Avoid_: Kanban task, card

**Kanban card**:
An internal executable stage used by an agent to fulfill a tracker issue or a Kanban-only outcome.
_Avoid_: Story, issue

**Worker attempt**:
One execution of a Kanban card, including a retry or recovery execution of the same card.
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
- A **flow run** executes **Kanban cards**, each of which may have multiple
  **worker attempts**.
- A **tracker issue** may own one **flow run** without exposing its internal
  **Kanban cards**.
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

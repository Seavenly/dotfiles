---
name: to-epic
description: Turn a finished design (an updated GLOSSARY.md, ADRs, and an implementation plan doc) into a Jira epic of reviewable vertical-slice stories wired for /epic-flow, or add stories to an existing epic. Use when a grill-with-docs or design session is done and the plan needs breaking into agent-auto, human-gate, and human-only stories with dependency links, ready to hand to /epic-flow. Jira workflow.
---

# To Epic

Bridge a completed design into stories `/epic-flow` can run: each one a change
the owner can review in one sitting, with acceptance criteria an agent can
prove and a reviewer can check.

Uses the Atlassian MCP (Jira) and `git`. Defaults: assignee = the current
user. Ask which Jira site and project to use if the context doesn't say.

## Process

### 1. Gather the design
Work from the conversation and the design artifacts: `GLOSSARY.md` (and
`GLOSSARY-MAP.md` in a multi-context repo), ADRs under `docs/adr/`, and the
implementation plan doc. Read them if they aren't in context. The plan's
structure is the starting breakdown. Ask whether this is a
new epic or stories for an existing one.

### 2. Design docs go to main first
Commit the design docs on a local branch from the target (`design/<slug>`),
run the repo's formatter over them (the repo formatter script, not a scoped
call), and tell the owner to open the PR to main for team review. Do not push
it or open the PR yourself. Stories land on `main` directly, so there is no
epic branch to seed, and the build need not wait for the design PR: the epic's
Landing note points builders at `design/<slug>` until it merges. Ask the owner
for the PR number once it is open; until then, the note names the branch alone.

### 3. The epic
New epic: create a fresh **Epic** (never convert a Story; Jira promotion is
lossy and often blocked). Summary = the feature name. Description, in order:

- `## Goal`.
- `## Links`: the requirement doc, the plan, the ADRs, the glossary terms, the
  design PR and the story that tracks it, and `Integration branch: main`.
- `## Landing`, as below.
- `## Constraints`: the rules every story inherits, always including "each
  story is safe to merge on its own" (for example also "additive only:
  existing stacks keep working").

```md
## Landing
There's no epic branch. The integration branch is `main`: epic-flow builds
from `origin/main` with `--stack` and never runs `--integrate`. Each story
lands as its own PR to `main`, in dependency order.

**Until #<PR> merges**, read the plan, ADR <NNNN> and the glossary terms from
branch `design/<slug>`; they aren't on `main` yet. Once it merges, this note
is obsolete.
```

Name a separate integration branch (`Integration branch: epic/<key>`, with no
Landing section) only when the stories cannot each be safe to merge on their
own; `/epic-flow` then integrates them into it and refreshes it from main.

Parent the originating story to the epic as a `human-only` story that tracks
the design PR. It blocks nothing: the Landing note covers the docs until the
PR merges.

### 4. Draft the stories
Slice by behavior, not by layer:
- One demoable behavior per story, a change the owner can review in one
  sitting. Merge slices too small to review on their own; mechanical work with
  a deterministic check (a codemod, a rename) may be bigger.
- Keep code and its live proof apart. A story whose criteria need a live
  environment, credentials, or a person tapping something splits: the code
  story proves what tests and diffs can and stays `agent-auto`, and the live
  proof is its own `human-only` story, blocked by the code and blocking
  nothing.
- Label each story with exactly one of:
  - `agent-auto`: the flow builds it, and it lands after the owner's review.
    The default for code stories.
  - `human-gate`: the flow builds it, but landing it carries a human action
    its dependents need done first (a deploy they read from, a cross-team
    handshake). Name the action in the story. Its dependents wait until the
    owner marks it Done, even in a stacked run, so a mid-chain `human-gate`
    stalls everything after it; use it only when that wait is real.
  - `human-only`: a person does it (a live apply or destroy, a certification, a
    spike run by hand, the design PR). The flow never builds it.
- Blocked by: which stories must land first. Keep the graph acyclic, and add a
  blocker only for a real dependency.

### 5. Review with the owner
Present a numbered breakdown: title, label, blocked by, and the one behavior
each story delivers. Then list every risk you see (a criterion an agent cannot
prove, an assumed external contract, a story too large to review, a live step
inside a code story, a `human-gate` story with dependents, a story that is not
safe to merge alone) with a proposed disposition for each. The owner answers
the risk list along with the breakdown; do not take a blanket approval while a
listed risk has no answer. Iterate until approved.

### 6. Create the stories in dependency order
Create each story under the epic (`parent` = the epic key) with its label and
the body below, blockers first, then add "Blocks" links. Skip story points and
sprint.

### 7. Hand off
Report the epic key, the stories with labels and blockers, the first ready set
(stories with no open blockers that are not `human-only`), and the design PR
to open. Next step: `/epic-flow <EPIC-KEY> --stack`, which can start before the
design PR merges.

## Story body

```md
## What to build
The end-to-end behavior of this slice, not a layer-by-layer plan. Avoid file
paths and code (they go stale); inline a snippet only when it encodes a
decision (a schema, a state machine, a type shape).

## Acceptance
- [ ] [test] <one observable behavior>
- [ ] [ci:<job name>] <one observable behavior a named CI job proves>
- [ ] [live] <a behavior only a live environment shows; label the story for it>

## Constraints
- <what must not change: other environments, public interfaces, neighbors>

## Out of scope
- <what a builder might reasonably add but must not>

## Assumptions
<Each unresolved cross-team unknown, assumed and marked "follow-up story if
wrong". An assumed external API contract cites its source (a doc, a sibling
consumer) or depends on a spike story.>

## Reference
Plan §X; ADR-00NN.

Verify: <a story-specific check that modifies nothing>
Verify: <one command per line, each with its own prefix>
```

Acceptance: one observable behavior per line, split from compound statements,
each tagged `test`, `diff`, `docs`, `ci:<job>`, or `live`. Write a property
("the path comes from the supervisor, never the caller") as the invariant plus
the check that would show it false ("a request naming another path is
refused"); review has passed properties that did not hold. "Lint, typecheck,
and tests pass" is not a criterion: the flow's gate runs the repo's checks on
every story. `Verify:` lines are for checks beyond those, such as a preview
wrapper that fails on a replace; never a fixer like `lint:fix`.

## Notes

- `parent` is the epic link for child stories in a company-managed project.
- Dependencies are Jira "Blocks" links (`is blocked by` / `blocks`), which
  `/epic-flow` reads.
- Jira descriptions may name sibling keys; anything that reaches GitHub (PR
  titles, bodies, commits) carries only its own story's key, because the
  GitHub-Jira link can transition every key it finds.
- Cross-team unknowns are assumptions, not blockers.
- Do not modify or close the requirement doc; the epic and the design PR are
  the new home for the "how".

---
name: agent-flow-review
description: Prepare, launch, resume, and inspect a durable Hermes automated review of an immutable local candidate without opening a PR or starting tuicr implicitly. Use when the user asks to review a local branch or worktree through agent-flow, resume an automated review run, inspect findings, or prepare its result for explicit human review.
---

# Agent Flow Review

Create or resume one automated review run from an
`agent-flow.local-review/v1` manifest. The candidate is an immutable local
base-to-head SHA range; a remote PR adapter is not part of this skill.

## Prepare

- Read `config/agent-flow/README.md`, `FLOW-GRAPHS.md`, and the local-review
  schema before authoring or changing a manifest.
- Resolve the canonical repository and worktree to absolute paths. Pin full
  base and head SHAs and require the worktree HEAD to equal the pinned head.
- Preserve real upstream Kanban provenance when one exists. Never fabricate a
  task, external tracker root, verification result, or artifact path.
- Select `hotfix`, `fast`, or `standard` urgency and explicit total and
  per-tier comment caps. Hotfix runs only required lenses; fast and standard
  also produce optional lenses, orientation, and a diagram.
- Require `automated_review.status: pending` for a new automated review.
  Existing Agent Flow feature manifests whose automated review already passed are
  human-review candidates and must not be relaunched through this graph.

## Launch and resume

Launch with the checked-in CLI and an absolute manifest path. Repeat the exact
command to resume the same run; do not change the run ID to evade an
incompatible contract, cancellation, ownership conflict, or failed gate.

```bash
agent-flow doctor profiles
agent-flow launch review --manifest <absolute-review.json>
agent-flow status --run <run-id> --json
```

Report blocked cards, retry or limit exhaustion, validation failures, and
absolute artifact paths from status. Do not poll workers or advance Hermes
cards outside their declared controller transitions. Use `agent-flow cancel`
only when the user asks to stop the run.

## Hand off for human review

When the run completes, report the Markdown, HTML, structured result, and
unsubmitted draft paths plus the pinned base and head SHAs. Use the `tuicr`
skill to start or inspect an explicit interactive session. Use the
`tuicr-reviews` skill for durable comment dispositions, approval, integration
receipts, and cleanup.

Never push, open or modify a PR, post a pending review, start a hidden tuicr
session, submit comments, or treat rendered findings as human approval.

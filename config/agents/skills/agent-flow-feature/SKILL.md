---
name: agent-flow-feature
description: Turn an approved brief or user request into a durable Hermes feature run that produces a verified local review candidate without pushing or opening a PR. Use when the user asks to implement a feature through agent-flow, resume a feature run, inspect capped retries or completeness findings, or prepare local work for tuicr review.
---

# Agent Flow Feature

Create or resume one feature run. Keep every implementation writer in the one
launcher-created worktree and leave remote mutation to a later explicit flow.

## Prepare

- Read `config/agent-flow/README.md`, `FLOW-GRAPHS.md`, and the feature manifest
  schema before authoring inputs.
- Copy user-approved slices into the manifest. If slices are not approved,
  leave them empty so the durable planner fallback runs.
- Make acceptance criteria and verification commands observable. Reject a
  criterion that cannot name evidence instead of inventing a passing check.
- Set bounded slice retry, completeness-fix, and critique-fix limits.

## Launch and resume

Launch with the checked-in CLI and an absolute manifest path. Repeat the same
command to resume the same run; never create a replacement run to bypass a
blocked controller.

```bash
agent-flow launch feature --manifest <absolute-feature.json>
agent-flow status --run <run-id> --json
```

If a controller reports `needs_input`, show the exact artifact and question to
the user. `RE_PLAN` always blocks; do not silently rewrite the approved plan.
Retry exhaustion, uncovered acceptance, critic failure, and non-blocking
deferrals remain visible in `review-summary.md` and root status.

## Review candidate

Require final verification evidence for a clean committed candidate. The
manifest stage records immutable base and head SHAs and registers the review
with `tuicr-reviews add --manifest`. Report the absolute worktree, review
manifest, summary, verification, and journal paths.

Never push, open a PR, modify an external issue, delete the worktree, or bypass
an incomplete gate unless the user separately authorizes that action.

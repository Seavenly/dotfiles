---
name: agent-flow-epic
description: Coordinate a bounded dependency graph of local feature flows into an immutable epic/source branch while preserving review, target-drift, receipt, and external-progress authority. Use when the user asks to implement or resume a multi-feature epic, inspect ready waves, refresh source against a moving target, or prepare stack planning without opening the completion PR.
---

# Agent Flow Epic

Validate the feature dependency DAG before mutation. Materialize only the
bounded ready wave and reuse `agent-flow-feature` for each child; never embed a second
feature implementation protocol.

Give every feature one worktree. Independent features may run concurrently,
but serialize every integration into `epic/source`. Before integration, merge
the latest source into the feature, route conflicts through a builder and gate,
rerun full verification, and invalidate review whenever the head changes.
Record an integration receipt before advancing the review manifest.

At launch, resume, and human checkpoints, update the one external progress
comment from `agent-flow status --json`. Do not create one external issue per
feature and do not report the root Done.

Immediately before stack planning, compare the live target with the recorded
target SHA. Drift creates a new source-refresh and stack generation requiring
builder, gate, automated review, and full source verification. Never hide drift
inside an implicit rebase or reuse an earlier approval.

Stop after every integrated feature exists on `epic/source` and the source plus
target identities are sealed for stack planning. Do not create stack branches,
push, open PRs, or complete the external issue in this skill.

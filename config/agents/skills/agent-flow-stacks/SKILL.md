---
name: agent-flow-stacks
description: Plan, approve, construct, review, and restack immutable Git review layers from a fixed source commit and target SHA without mutating the source or force-pushing a reviewed prefix. Use when a completed epic or feature needs a review stack, hunk-level layer planning, safe suffix restacking, PR retargeting, or stack drift diagnosis.
---

# Agent Flow Stacks

Analyze the exact target-to-source diff with `agent-flow stacks analyze`. Propose
coherent layers that assign every file or hunk exactly once and preserve
dependency order. Record the fixed source commit, source ref, target ref, target
SHA, layer branches, messages, and verification commands in the stack plan.
Seal the forge owner/repository coordinate as part of the same plan.

Stop before branch or PR mutation until the user explicitly approves that exact
plan with `agent-flow stacks approve`. Approval is bound to the plan digest and
generation. A moved source ref or target ref makes the generation stale and
requires a new plan and approval.

After approval, use `agent-flow stacks build`. The helper constructs true linear
branches in a temporary worktree, checks every layer delta, proves the final
tree exactly equals the source tree, and never checks out or changes the source
ref. Preserve its manifest after partial failure and report its rollback
commands. Never delete refs automatically.

Review changes belong to the earliest owning layer. Validate that scope, then
approve the exact changed head, owning-layer index, and next generation with
`agent-flow stacks approve-restack`, then run `agent-flow stacks restack`.
Restack only the unmerged suffix into new generation refs. Preserve reviewed
prefix refs and never force-push them. Reconcile source and target identity
before each ref, push, PR creation, or retarget operation.

After each layer reaches an approved local-review state, register its canonical
manifest with `agent-flow stacks review`. Delivery consumes only those sealed
paths and digests. A successful suffix restack reruns full verification and
promotes its exact reviewed chain as the active generation used by publication
and delivery.

The selected assembly policy is deterministic replay of each reviewed layer
delta into delivery after suffix restacking. Intermediate PRs never carry a
completion issue key. This skill stops after review-stack operation and does not
open or merge the completion PR.

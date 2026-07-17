---
schema_version: 1
kind: derivative
sources:
  - id: local-split-mirror
    relationship: base
    repository: https://github.com/Iron-Ham/split.git
    path: skills/split
    revision: 5eec1a6d6cac27cb512ed9b5040d3c3c4b9c3d78
---

# Lineage intent

Derived from the unchanged local `split` mirror. `split` remains an upstream
mirror and is not edited by this derivative.

## Semantic changes

- Bind planning and execution to immutable source and target SHAs.
- Store hunk assignments and approval as a durable generation manifest.
- Require explicit approval before any branch or PR mutation.
- Construct branches in a temporary worktree and prove exact final-tree
  equality with the source.
- Reconcile identities before every mutation and mark drift stale.
- Record partial failure and rollback actions without automatic deletion.
- Apply review changes to their owning layer and restack only the suffix into
  new refs after a distinct exact-generation human approval, preserving
  reviewed prefix refs without force-push.
- Promote verified restacks into the active generation, enforce exact hunk
  ownership for review edits, and register canonical review manifests.
- Seal and reconcile the forge repository coordinate before publication.
- Separate review-stack PRs from delivery and external completion authority.
- Select deterministic replay only after disposable merge, squash, and replay
  topology proofs.

## Update policy

Review upstream `split` changes manually. Preserve these safety and lifecycle
semantics when incorporating them, and update the recorded revision only after
the derivative is revalidated.

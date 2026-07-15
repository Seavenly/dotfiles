# Review lens

Review only the pinned base-to-source change and the lens named by this card.
Treat the candidate worktree as read-only. Write exactly the declared JSON
artifact, with findings ordered by path, line, and severity. Complete the card
with an `agent-flow.handoff/v1` under `metadata.handoff`, including the exact
artifact path and SHA-256 digest. Record `passed` as false only when the lens
found a blocking defect. Do not modify product files.

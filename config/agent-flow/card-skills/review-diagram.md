# Review diagram

Read the sealed review manifest and pinned candidate change. Produce one small,
valid Mermaid flowchart that clarifies a material call chain or state change.
Keep labels grounded in the diff and cite repository-relative paths in Mermaid
comments. If the change has no meaningful flow, return a minimal flowchart
whose single node states that no material call-chain change was found. Do not
write a source artifact file or modify the candidate worktree.

Complete through `kanban_complete` with a concise, non-empty `summary` and an
`agent-flow.handoff/v1` under `metadata.handoff`. Use the card's exact run ID
and stage, set `flow` to `review`, omit `attempt`, and set `passed` to true. Put
one `review-diagram` artifact in `artifacts` with the complete Mermaid source
as its `inline` string. Include empty `changed_files`, `verification`,
`dependencies`, `retry_notes`, and `residual_risk` arrays.

Use this as the `metadata` argument, replacing placeholders and content. Pass
the separate non-empty `summary` described above.

```json
{
  "handoff": {
    "schema": "agent-flow.handoff/v1",
    "run_id": "<Run from card>",
    "flow": "review",
    "stage": "diagram",
    "passed": true,
    "artifacts": [
      {
        "kind": "review-diagram",
        "inline": "flowchart LR\n  source --> consumer\n"
      }
    ],
    "changed_files": [],
    "verification": [],
    "dependencies": [],
    "retry_notes": [],
    "residual_risk": []
  }
}
```

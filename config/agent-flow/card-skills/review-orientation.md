# Review orientation

Read the sealed review manifest and pinned candidate change. Produce one
concise Markdown orientation section that explains the changed surface, entry
points, and the safest reading order. Cite repository-relative paths. Do not
write a source artifact file or modify the candidate worktree.

Complete through `kanban_complete` with a concise, non-empty `summary` and an
`agent-flow.handoff/v1` under `metadata.handoff`. Use the card's exact run ID
and stage, set `flow` to `review`, omit `attempt`, and set `passed` to true. Put
one `review-orientation` artifact in `artifacts` with the complete Markdown
section as its `inline` string. Include empty `changed_files`, `verification`,
`dependencies`, `retry_notes`, and `residual_risk` arrays.

Use this as the `metadata` argument, replacing placeholders and content. Pass
the separate non-empty `summary` described above.

```json
{
  "handoff": {
    "schema": "agent-flow.handoff/v1",
    "run_id": "<Run from card>",
    "flow": "review",
    "stage": "orientation",
    "passed": true,
    "artifacts": [
      {
        "kind": "review-orientation",
        "inline": "## Orientation\n\n<complete Markdown section>\n"
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

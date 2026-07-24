# Review lens

Review only the pinned base-to-source change and the lens named by this card.
Treat the candidate worktree as read-only. Order findings by path, line, and
severity. Do not write a source artifact file or calculate a digest. Complete
the card through `kanban_complete` with a concise, non-empty `summary` argument
and an `agent-flow.handoff/v1` under `metadata.handoff`:

- Use the card's exact run ID and stage, and set `flow` to `review`.
- Omit `attempt`; the validator obtains it from Hermes.
- Put one `review-findings` artifact in `artifacts` and place the complete JSON
  findings object in its `inline` field. Use `lens`, `summary`, and `findings`
  fields. Each finding uses `path`, `line`, `side`, `tier`, `lens`, and `body`;
  `side` is `LEFT` or `RIGHT`, and `tier` is `critical`, `important`,
  `recommended`, or `nit`.
- Set `passed` to false only when this lens found a blocking defect.
- Include the required `changed_files`, `verification`, `dependencies`,
  `retry_notes`, and `residual_risk` arrays. Keep `changed_files` empty.

Do not modify product files.

Use this completion metadata shape, replacing placeholders and the inline
content. This JSON is only the `metadata` argument; also pass the separate
non-empty `summary` described above:

```json
{
  "handoff": {
    "schema": "agent-flow.handoff/v1",
    "run_id": "<Run from card>",
    "flow": "review",
    "stage": "<Stage from card>",
    "passed": true,
    "artifacts": [
      {
        "kind": "review-findings",
        "inline": {
          "lens": "<lens name>",
          "summary": "<concise result>",
          "findings": []
        }
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

# Review critic

Read only the validated lens snapshots named by this card. Verify findings
against the pinned candidate change, remove duplicates and unsupported claims,
and produce exactly one `agent-flow.review-comments/v1` document. Do not write
a source artifact file or calculate a digest. Complete the card through
`kanban_complete` with a concise, non-empty `summary` argument and an
`agent-flow.handoff/v1` under `metadata.handoff`:

- Use the card's exact run ID and stage, and set `flow` to `review`.
- Omit `attempt`; the validator obtains it from Hermes.
- Put one `review-comments` artifact in `artifacts` and place the complete
  `agent-flow.review-comments/v1` document in its `inline` field.
- Read `automated_review.urgency` from the sealed review manifest and copy it
  exactly into the review-comments document.
- Use `passed` as the critic's merge measurement.
- Include the required `changed_files`, `verification`, `dependencies`,
  `retry_notes`, and `residual_risk` arrays. Keep `changed_files` empty.

Do not modify product files.

Use this completion metadata shape, replacing placeholders and findings. This
JSON is only the `metadata` argument; also pass the separate non-empty `summary`
described above:

```json
{
  "handoff": {
    "schema": "agent-flow.handoff/v1",
    "run_id": "<Run from card>",
    "flow": "review",
    "stage": "critic",
    "passed": true,
    "artifacts": [
      {
        "kind": "review-comments",
        "inline": {
          "schema": "agent-flow.review-comments/v1",
          "run_id": "<Run from card>",
          "stage": "critic",
          "urgency": "<automated_review.urgency>",
          "posture": "<do_not_merge|merge_after_fixes|merge_ready_with_followups>",
          "posture_rationale": "<concise rationale>",
          "cluster": null,
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

Each review-comments finding requires `path`, `line`, `side`, `tier`, `lens`,
and `body`. Paths are repository-relative, `line` is at least 1, `side` is
`LEFT` or `RIGHT`, and `tier` is `critical`, `important`, `recommended`, or
`nit`. For `hotfix`, use `do_not_merge` when any critical finding remains and
`merge_ready_with_followups` otherwise. For `fast` or `standard`,
`do_not_merge` requires a critical finding or more than one clustered important
finding; `merge_after_fixes` requires no critical findings and at least one
important finding; `merge_ready_with_followups` requires no critical findings.

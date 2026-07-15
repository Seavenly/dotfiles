# Review critic

Read only the validated lens snapshots named by this card. Verify findings
against the pinned candidate change, remove duplicates and unsupported claims,
and write exactly one `agent-flow.review-comments/v1` artifact. Complete the
card with an `agent-flow.handoff/v1` under `metadata.handoff`, including the
artifact path and SHA-256 digest. The handoff `passed` value is the critic's
merge measurement. Do not modify product files.

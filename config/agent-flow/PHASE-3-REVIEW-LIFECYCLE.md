# Phase 3 review lifecycle evidence

Phase 3 completed on 2026-07-15 after the Phase 2 operator review gate. This
record identifies the implemented boundary and the evidence needed before
Phase 4 consumes it.

## Implemented boundary

- `agent-flow review transition` owns explicit lifecycle mutation. A lock and
  atomic same-directory rename serialize writes, while the caller-supplied
  expected generation prevents lost updates. Every mutation appends an event
  containing its actor, timestamp, prior and next generation, head SHA, reason,
  and hashed durable evidence.
- `agent-flow review record-comments` consumes
  `agent-flow.review-comment-dispositions/v1`. Stable IDs are recorded only
  after matching their IDs and types against the authoritative tuicr session,
  with a type-appropriate disposition and readable evidence. Identical retries
  are no-ops; conflicting or newly unconsumed comments fail.
- Approval records exactly `head.sha`. Git branch movement is derived as
  `head_mismatch`; an unaudited manifest head change that contradicts approval
  is contract-invalid. Neither condition is silently rewritten.
- `agent-flow.integration-receipt/v1` binds the run, repository, reviewed head,
  optional approved assembly, target ref, resulting commit, and resulting tree.
  Integration verifies the recorded commit and tree plus live target ancestry
  before the manifest advances. A receipt remains usable after a failed
  manifest write even if the target subsequently advances without rewriting
  that recorded integration.
- `tuicr-reviews` stores manifest paths and rebuildable projection snapshots.
  New JSON output and appended TSV columns report lifecycle, health, immutable
  SHAs, run identity, session slug, entry kind, and manifest path. The first
  seven TSV columns and legacy `add --repo ...` interface remain compatible.
- `tmux-review-inbox` preserves the pulled copy-token and two-press delete
  interactions, displays manifest lifecycle and health, distinguishes the run
  from the tuicr session, and opens only the immutable SHA range. Missing
  worktrees remain visible and cannot be opened or integrated.

## Verification matrix

The Phase 3 tests cover:

- every declared lifecycle edge, including late-comment reopening, and
  rejection of every undeclared edge;
- idempotent manifest and legacy registry insertion;
- generation races, stale generations, atomic writes, and approval provenance;
- current approval, stale approval, moving branches, and vanished worktrees;
- stable-ID comment consumption, duplicate retries, conflicting dispositions,
  and durable evidence;
- Git-before-manifest ordering, simulated manifest failure after Git success,
  target advancement during receipt recovery, invalid pre-Git receipts,
  duplicate receipt recovery, recorded trees, and ancestry;
- deterministic registry rebuild, terminal pruning, preserved TSV columns,
  JSON projection, and immutable picker revsets;
- copy-token, legacy approval mapping, two-press targeted deletion, existing
  tmux behavior, and the repository's Claude configuration compatibility suite.

Run the focused checks with:

```text
cd config/agent-flow && npm test
tests/tuicr_reviews_test.sh
tests/tmux_tools_test.sh
tests/agent_config_test.sh
```

## Pulled `tuicr-reviews` changes

The incoming copy-token, two-press delete, targeted review removal, approval
display, and trailing vanished-worktree registry-jam fix were reviewed before
Phase 3 implementation. Copy and deletion remain unchanged at the user
interface. The stream-cleanup failure mode was removed by replacing cleanup
with locked atomic Node writes. Vanished worktrees are no longer deleted during
cleanup because Phase 3 intentionally projects them as broken candidates.

## Deliberate operator boundary

Starting tuicr remains an explicit interactive action. The operator records the
created session slug with `review_ready -> reviewing`; Agent Flow then checks
the authoritative comment snapshot before approval and integration. It does not
poll for hidden sessions, encode a pending session inside a slug, or read
tuicr's private persistence files. Revisit automatic session discovery after
the full implementation only if an omitted transition causes a real workflow
problem or tuicr adds a documented immutable-session query.

## Rollback

The JSONL registry remains append-only compatible and accepts old records as
`legacy`. Rolling back the picker can continue reading its first seven TSV
columns. Do not delete local review manifests, integration receipts, comment
dispositions, or legacy registry entries during rollback.

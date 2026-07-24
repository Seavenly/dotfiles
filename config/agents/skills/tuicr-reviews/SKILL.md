---
name: tuicr-reviews
description: Operate the local tuicr review projection, resolve inbox tokens, record durable comment dispositions, integrate manifest-approved immutable heads with receipts, and preserve legacy reviews. Use when the user names a review token, asks to address tuicr comments, merge an approved local review, inspect the review inbox, or clean up completed reviews. Use the separate tuicr skill for direct session comment reads and writes.
---

# tuicr review registry

Use `tuicr-reviews` for discovery and projection. For entries whose `kind` is
`manifest`, treat the referenced `agent-flow.local-review/v1` manifest as
lifecycle and approval truth. Treat registry approval as truth only for entries
explicitly marked `legacy`.

The `prefix + r` inbox opens reviews only after a human presses Enter. It opens
manifest reviews by immutable `base_sha...head_sha`, shows lifecycle and health,
copies the run/session token with `ctrl-y`, and requires two `ctrl-x` presses to
remove a row. `ctrl-a` toggles approval only for legacy rows. A missing worktree
remains visible and blocks opening and integration.

## Resolve a token

Run:

```bash
tuicr-reviews list --json
```

Match the token against `slug`, then `run_id`, `session_slug`, or `branch`.
Require one unambiguous match. Check `kind`, `lifecycle`, `health`, `manifest`,
`worktree`, `base_sha`, and `head_sha` before acting.

The TSV interface remains available for older callers. Its first seven columns
are `worktree base branch repo slug created summary`; later columns are
`approved lifecycle health base_sha head_sha run_id session_slug kind manifest`.

## Read and disposition comments

Use the `tuicr` skill to read comments from the recorded `session_slug`. Compare
stable comment `id` values with the manifest's `consumed_comment_ids`.

For a manifest entry, create an
`agent-flow.review-comment-dispositions/v1` file containing the run ID, session
slug, reviewed head SHA, and each new comment's type, disposition, reason, and
absolute durable evidence path. Use these allowed dispositions:

- `issue`: `implemented`
- `suggestion`: `implemented` or `declined`
- `note`: `answered` or `acknowledged`
- `praise`: `no_action`

Record only after the implementation, answer, acknowledgement, or decision is
durable:

```bash
agent-flow review record-comments \
  --manifest <review.json> \
  --comments <dispositions.json> \
  --expected-generation <generation> \
  --actor <actor> \
  --reason <reason> \
  --evidence <absolute-evidence-path>
```

A repeated identical file is idempotent. A conflicting disposition or stale
generation must stop the workflow. Issue comments require a revision cycle
before approval.

## Integrate approved reviews

Start with `tuicr-reviews list --approved --json`. It returns only current
approvals. If it is empty, report that nothing is approved.

For `legacy` entries, preserve the established branch workflow:

```bash
git -C <worktree> switch <base>
git -C <worktree> merge --no-ff <branch>
tuicr-reviews rm --worktree <worktree> --base <base> --branch <branch>
```

For `manifest` entries:

1. Re-read the manifest and require `review.status == approved`,
   `review.reviewed_head_sha == head.sha`, and projection `health == current`.
2. Re-read the tuicr comments for `review.session_slug` and stop if any ID is
   absent from `consumed_comment_ids`. This pre-Git check narrows the race; the
   lifecycle transition repeats it after Git succeeds.
3. Confirm the named base branch is the intended local target. Do not push.
4. Merge the immutable `<head_sha>`, never the moving branch name:

   ```bash
   git -C <repo> switch <base-branch>
   git -C <repo> merge --no-ff <head_sha>
   ```

   When `<repo>` and `<worktree>` are the same checkout, switching to the target
   branch is expected. Receipt reconciliation accepts that checkout movement
   only when Git proves the immutable feature ref and resulting target commit.

5. After Git succeeds, write an `agent-flow.integration-receipt/v1` beside the
   review artifacts. Record the review run ID, repository, reviewed head SHA,
   optional approved assembly SHA, full `refs/heads/<target>` name, resulting
   commit and tree SHAs, actor, and UTC timestamp.
6. Advance the manifest using its current generation and the receipt as both
   receipt and evidence:

   ```bash
   agent-flow review transition \
     --manifest <review.json> \
     --to integrated \
     --expected-generation <generation> \
     --actor <actor> \
     --reason <reason> \
     --evidence <integration-receipt.json> \
     --integration-receipt <integration-receipt.json>
   ```

7. If the manifest write fails after Git succeeds, do not merge again. Retry
   with the same receipt after inspecting Git and the manifest. The command
   verifies the target commit, tree, and ancestry and treats the same recorded
   receipt idempotently.
   The target may have advanced after the receipt was written only when the
   recorded integration commit remains its ancestor.
8. Transition `integrated -> archived`, then run `tuicr-reviews prune` when the
   retained artifacts satisfy the user's cleanup intent.

Stop on conflicts, stale health, branch drift, receipt mismatch, or stale
generation. Never force, create a PR, reopen a draft PR, or push unless the user
explicitly asks.

## Registry maintenance

- Add manifest reviews with `tuicr-reviews add --manifest <absolute-review.json>`.
- Keep Claude feature-flow compatibility through the explicitly legacy
  `add --repo ... --worktree ... --base ... --branch ...` form.
- Rebuild manifest projections with `tuicr-reviews rebuild --root <directory>`.
- Remove one manifest row with `tuicr-reviews rm --manifest <review.json>`.
- Treat removal as projection cleanup only. It does not delete manifests,
  tuicr sessions, comments, branches, worktrees, or Git history.
- Never remove a broken missing-worktree row to make integration appear safe.

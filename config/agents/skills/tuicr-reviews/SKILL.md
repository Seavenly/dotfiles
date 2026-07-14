---
name: tuicr-reviews
description: Operate the local tuicr review registry - list approved reviews, merge an approved branch into its base, and remove reviews once merged. Use when the user asks to merge approved/reviewed branches, act on the tuicr review list, or clean up merged reviews. Distinct from the `tuicr` skill, which is about in-session review comments.
---

# tuicr review registry

Nathan reviews agent work locally with tuicr instead of GitHub draft PRs. The
work under review is tracked in the **tuicr-reviews registry** - a JSONL store
managed only through `tuicr-reviews` (`bin/tuicr-reviews`). Each entry is one
review keyed by `(worktree, base, branch)`: reviewing the commits `branch` adds
over `base`, opened with `tuicr -r base..branch` in `worktree`.

- `feature-flow` records a job on wrap-up; the human approves reviews in the
  tmux picker (`prefix + r`, then `ctrl-a` to toggle the `✓`).
- This registry - NOT the `tuicr` session JSON or `tuicr review` CLI - is the
  source of truth for what is approved.

## Merging approved reviews (the usual agent task)

1. **List what's approved - never guess:**
   ```
   tuicr-reviews list --approved
   ```
   TSV columns: `worktree  base  branch  repo  slug  created  summary  approved`.
   If it's empty, tell the user nothing is approved and stop.

2. **Merge each approved review into its base**, in that review's `worktree`:
   ```
   git -C <worktree> switch <base>
   git -C <worktree> merge --no-ff <branch>
   ```
   - Confirm `<base>` is the intended integration target - it is usually an
     integration branch (`env-topology`, `epic/...`), NOT `main`.
   - On conflict, stop and report; never force.
   - These are local branches (the draft PRs were closed); do not open/reopen a
     PR.
   - **Do not push** unless the user asks. Pushing shared integration branches
     is the human's call, and origin needs the Seavenly account (see the
     push-account note), so surface it rather than pushing silently.

3. **Remove the review from the registry once it is merged** - per review:
   ```
   tuicr-reviews rm --worktree <worktree> --base <base> --branch <branch>
   ```
   Passing only `--worktree` drops EVERY review in that checkout; do that only
   if the user wants to clear all of them.

## Guardrails
- Only act on reviews the user has approved. Never merge an unapproved review.
- One checkout can hold several reviews, so always remove by the full
  `(worktree, base, branch)` triple, not by worktree alone.
- Vanished worktrees self-prune on `list`/`prune`; no manual cleanup needed for
  those.

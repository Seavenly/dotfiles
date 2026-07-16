---
name: tuicr-reviews
description: Operate the local tuicr review registry - resolve a review token handed off from the inbox, list approved reviews, merge an approved branch into its base, and remove reviews once merged. Use when the user pastes/names a review token and asks you to review it or address its comments, or asks to merge approved/reviewed branches, act on the tuicr review list, or clean up reviews. Distinct from the `tuicr` skill, which is about in-session review comments.
---

# tuicr review registry

Nathan reviews agent work locally with tuicr instead of GitHub draft PRs. The
work under review is tracked in the **tuicr-reviews registry** - a JSONL store
managed only through `tuicr-reviews` (`bin/tuicr-reviews`). Each entry is one
review keyed by `(worktree, base, branch)`: reviewing the commits `branch` adds
over `base`, opened with `tuicr -r base...branch` in `worktree`.

- `feature-flow` records a job on wrap-up. In the `prefix + r` inbox
  (`bin/tmux-review-inbox`) the human can: `ctrl-a` toggle the approved `✓`,
  `ctrl-y` copy the review's **token** to the clipboard (to hand to an agent),
  and `ctrl-x` twice remove the review from the inbox.
- This registry - NOT the `tuicr` session JSON or `tuicr review` CLI - is the
  source of truth for what is approved.

## Resolving a review handed off from the inbox

The human copies a review's **token** from the inbox with `ctrl-y` - a bare
string like `fcc439` (the registry `slug`, or the branch name when no slug was
set). When the user says "review `<token>`" or "address the comments on
`<token>`", resolve it here first:

1. Run `tuicr-reviews list` and find the row whose `slug` equals the token
   (fall back to matching the `branch` column). Columns:
   `worktree  base  branch  repo  slug  created  summary  approved`.
2. That row gives you the `worktree` and the `base...branch` revset - the unit
   under review. Everything below runs against that checkout.

Then act through the **`tuicr` skill** (it owns comment read/add), passing
`--repo <worktree>`:

- **Read comments** (to address feedback): discover the session with
  `tuicr review list --repo <worktree>`, matching `anchor` to the branch; then
  `tuicr review comments --repo <worktree> --session <session-slug>`.
- **Add review comments** (an agent reviewing on the human's behalf): same
  discovery, then `tuicr review add ... --username "<agent name>"`.

Two properties of tuicr sessions to work with, not against:

- **Materialize-once.** `tuicr review add` only appends to a session that
  already exists, and only opening the review in the TUI creates one (headless
  export does not create the matching snapshot). If
  `tuicr review list --repo <worktree>` shows no session for the branch, the
  review has not been opened yet - ask the human to open it once from the inbox
  (Enter on the row) before an agent can comment. Reading and merging need no
  session.
- **Snapshots, not threads.** After the implementer pushes fix-up commits the
  revset resolves to a new commit range, so the next inbox open shows a fresh
  session; earlier comments stay on the old snapshot and are not carried
  forward. When addressing feedback, read the session that actually holds those
  comments (the one the human reviewed / highest `comment_count`), not
  necessarily the newest.

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
- Removing a review only drops the registry entry (the inbox row). The `ctrl-x`
  twice inbox action and `tuicr-reviews rm` are equivalent; both leave tuicr's
  persisted sessions/comments alone, since those are keyed to commit snapshots
  and kept by design. Removal is for reviews you have merged, or that the human
  is done with - it is not a way to clean up tuicr's session store.
- The `prefix + r` review inbox (`bin/tmux-review-inbox`) also lists coworker
  PRs, which open to GitHub. This skill concerns only the local registry
  reviews - never try to merge a coworker PR.
- Only act on reviews the user has approved. Never merge an unapproved review.
- One checkout can hold several reviews, so always remove by the full
  `(worktree, base, branch)` triple, not by worktree alone.
- Vanished worktrees self-prune on `list`/`prune`; no manual cleanup needed for
  those.

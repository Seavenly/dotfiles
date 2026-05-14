---
description: In-sandbox lead briefing for review-flow. Orchestrates parallel reviewer teammates → critic synthesizes/caps → synthesizer writes review doc. Optional GitHub pending review draft via gh api.
---

You are the **team lead** for a review-flow run. The host-side slash
command has already drafted a brief and spawned this sandbox.

Read `/work/brief.md` first. Then follow this recipe.

## Setup

1. **Read `/work/brief.md`.** Confirm `type: review`. Note `config:` —
   `max_comments`, `per_tier_caps`, `reviewer_lenses`.
2. **Fetch the PR.** The brief includes `pr_number` and `repo`.
   ```
   gh pr view <pr_number> --repo <repo> --json title,body,author,baseRefName,headRefName,files,changedFiles,additions,deletions
   gh pr diff <pr_number> --repo <repo> > /work/out/pr.diff
   ```
3. **Read project conventions** from the checked-out base ref if mounted:
   `CLAUDE.md`, `CONTRIBUTING.md`, any style guide referenced from them.
   If repo is mounted read-only at a path in the brief, read from there.
4. **Create `/work/out/findings/`** for raw reviewer output.

## Phase 1 — Parallel reviewers (Agent Teams)

Spawn one `reviewer` teammate per lens from
`brief.config.reviewer_lenses`. The default lenses are: `security`,
`correctness`, `style`, `tests`.

For each lens, spawn a teammate using the `researcher` subagent type
(repurposed — the role's read-only discipline and citation requirements
match what a reviewer needs):

> Spawn an Agent Teams teammate named `reviewer-<lens>` using the
> `researcher` subagent type. Spawn prompt:
> "You are the **<lens>** reviewer for PR #<pr_number>: <title>.
> Read /work/out/pr.diff (the full PR diff). Read /work/brief.md and any
> project conventions listed there.
>
> Enumerate findings for the <lens> dimension only:
>   - security: auth, authz, input validation, secrets, injection, crypto, data exposure
>   - correctness: logic bugs, edge cases, error handling, race conditions
>   - style: naming, structure, readability, project conventions
>   - tests: coverage gaps, weak assertions, missing edge case tests
>
> Be aggressive (high recall): list anything worth flagging in your lens.
> The critic will dedupe and cap later.
>
> For each finding, output:
>   - **path**: file path
>   - **line**: integer line number IN the diff (the post-change side
>     unless commenting on a removal)
>   - **side**: RIGHT (for added/modified lines) or LEFT (for removed)
>   - **tier**: critical | important | recommended | nit (your initial
>     read; critic may recategorize)
>   - **body**: one to three sentences. Quote the offending code or
>     describe the missed case.
>   - **anchorable**: true if you have a real file:line from the diff;
>     false if this is a meta/structural comment with no specific anchor.
>
> Write your findings to /work/out/findings/<lens>.json as a JSON array.
> Do not write findings outside your lens — those belong to peers."

**Spawn all reviewer teammates roughly simultaneously** so they work in
parallel. With `teammateMode: tmux` set, each will appear in its own
split pane within the current tmux window.

Wait for all reviewer teammates to complete. Verify each
`/work/out/findings/<lens>.json` exists and is valid JSON.

## Phase 2 — Critic synthesizes (Agent Teams teammate)

Spawn `critic` as an Agent Teams teammate (independent context window):

> Spawn an Agent Teams teammate named `critic-review-<pr_number>` using
> the `critic` subagent type. Spawn prompt:
> "You are the review-flow critic for PR #<pr_number>. Read
> /work/brief.md, /work/out/pr.diff, and all files in
> /work/out/findings/. Operate in Mode B per your role definition:
> dedupe, recategorize tier mistakes, verify inline-comment anchoring
> against the actual diff lines, apply the priority-protect cap from
> brief.config.
>
> Write /work/out/comments.json per the schema in your role definition.
> Write /work/out/cap-report.md if any criticals/important overflowed
> the cap.
>
> DO NOT request the reviewer teammates' transcripts — operate on their
> findings files alone."

Wait for completion. Verify `/work/out/comments.json` is valid.

## Phase 3 — Synthesizer writes review.md

Invoke the `synthesizer` subagent:

> "Read /work/brief.md, /work/out/comments.json, and (if it exists)
> /work/out/cap-report.md. Write the review document to
> /work/out/review.md following the review-flow format in your role
> definition."

## Phase 4 — Optional: Prepare GitHub pending draft

If `brief.config.prepare_draft` is true:

1. Transform `/work/out/comments.json` into the GitHub Reviews API
   payload:
   - Top-level `body`: synthesizer's review summary (top of review.md
     or build from `body` entries in comments.json).
   - `comments` array: from `inline` entries, with `path`, `line`,
     `side`, and `body` (body should include the tier tag, e.g.,
     `**[critical]** ...`).
   - `event`: omit (results in PENDING) — never include APPROVE,
     REQUEST_CHANGES, or COMMENT.
2. Write the payload to `/work/out/draft-review.json`.
3. POST it:
   ```
   gh api -X POST repos/<owner>/<repo>/pulls/<pr_number>/reviews \
     --input /work/out/draft-review.json
   ```
4. On success, capture the review URL/ID from the response and print it
   in the final wrap-up message.
5. On failure (e.g., line anchoring rejected), log the error to
   `/work/out/draft-error.log`. Don't abort the run — the review.md
   document is still useful.

## Wrap-up

Print a clear final message:

```
✓ review-flow complete
  PR:      #<pr_number> — <title>
  review:  ~/.agent-teams/runs/<run_id>/out/review.md
  draft:   <url-if-prepared-or-"not prepared">
  comments: <total>  (critical: X, important: Y, recommended: Z, nit: W)
```

Stay idle. The user may want to ask "why did you classify X as critical?"
or "expand on the security comment about Y."

## Constraints

- **Reviewers must work in parallel.** Don't spawn them sequentially.
  Parallel exploration is the whole point of using Agent Teams here.
- **Never auto-submit the review.** Pending state only. The user submits
  manually from the GitHub UI.
- **Never run tests on the PR.** Review is static. If a reviewer feels
  strongly that a test should fail, they flag it as a `correctness`
  finding for the critic to weigh.
- **Surface anchoring failures.** If the critic drops comments because
  they couldn't anchor to the diff, log it in `cap-report.md` so the user
  knows what was lost.

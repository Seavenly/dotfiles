---
description: Review a GitHub PR with a dynamic workflow — parallel reviewers across lenses → critic → rendered review.md/.html, optional pending draft. Args — PR number (required), optional --repo owner/name, --urgency hotfix|fast|standard, --max-comments N, --prepare-draft, --lenses security,correctness,style,tests,observability.
---

You run a review-flow: gather the PR locally, launch the `review-flow`
dynamic workflow to do the parallel reviewer→critic pass, then render and
(optionally) post the result. The autonomous fan-out lives in the
workflow; you handle the `gh`/`git`/render bookends and anything that
needs to talk to the user.

User's invocation: `/review-flow $ARGUMENTS`

## Read first
- `~/.dotfiles/claude/AGENT-TEAMS.md` — system architecture.
- `~/.dotfiles/claude/defaults.yaml` — cap defaults (`review_flow`).

## Step 1 — Parse arguments

- **PR number** (required) — bare integer or `#1234`.
- **`--repo owner/name`** — defaults to current repo (`gh repo view --json nameWithOwner -q .nameWithOwner`).
- **`--urgency hotfix|fast|standard`** (default `standard`); synonyms `--hotfix`, `--fast`. Tiers:
  - `hotfix` — criticals only; importants/recommendeds/nits skipped; no orientation/diagrams.
  - `fast` — criticals + importants only.
  - `standard` — all four tiers.
- **`--max-comments N`** — overrides `max_comments`.
- **`--prepare-draft`** → `prepare_draft: true` (post a PENDING review at the end).
- **`--lenses a,b,c`** → override `reviewer_lenses` (default from defaults.yaml).

If `$ARGUMENTS` is empty or `help`, explain usage (mention the three urgency tiers) and stop.

## Step 2 — Validate the PR

```bash
gh pr view <pr> --repo <repo> --json title,state,url,baseRefName,headRefName,headRefOid
```
Capture `headRefOid` (full 40-char SHA — the renderer builds `blob/<sha>/<path>#L<line>` deep-links from it). If the PR isn't found or isn't OPEN, surface and stop (for non-OPEN, confirm the user really means it before proceeding).

Show a one-line confirmation including the urgency summary (the user's last chance to catch a mis-set flag), e.g. `urgency: hotfix — criticals only; importants and below skipped`. Allow the user to add a `focus:` ("focus on the new auth code"). Reply `launch` to proceed. Review-flow skips the heavy interview by default.

## Step 3 — Build the run dir, clone, diff, brief

```
run_id  = $(date +%Y-%m-%d-%H%M)-pr-<num>
run_dir = ~/.agent-teams/runs/<run_id>
out_dir = <run_dir>/out
repo_dir= <run_dir>/repo
```
```bash
mkdir -p "$out_dir/findings" "$out_dir/diagrams"
gh pr diff <pr> --repo <repo> > "$out_dir/pr.diff"
# Clone the head ref locally so reviewers can browse surrounding code.
# Fail-soft: on clone/checkout failure, log and proceed diff-only.
mkdir -p "$repo_dir" && ( cd "$repo_dir" \
  && gh repo clone <repo> . -- --depth=50 --no-tags \
  && gh pr checkout <pr> ) 2>"$out_dir/clone-error.log" || echo "clone failed; diff-only"
# Verify the checkout matches the LIVE head (pinned SHA goes stale on push).
live_head=$(gh pr view <pr> --repo <repo> --json headRefOid -q .headRefOid)
( cd "$repo_dir" && git fetch origin "$live_head" 2>/dev/null && git checkout -q "$live_head" \
  && gh pr diff <pr> --repo <repo> > "$out_dir/pr.diff" ) 2>/dev/null || true
```
Use `live_head` for `head_sha` in the brief — not the possibly-stale Step 2 value. If the clone failed, set `repoDir` to null in the launch args.

Write `<run_dir>/brief.md` (always quote `pr_title`; PR titles contain YAML specials):
```markdown
---
type: review
created: <ISO>
run_id: <run_id>
pr_number: <num>
pr_title: "<title>"
repo: <owner/name>
pr_url: <url>
base_ref: <baseRefName>
head_ref: <headRefName>
head_sha: <live_head>
config:
  urgency: <hotfix|fast|standard>
  max_comments: <merged>
  per_tier_caps: <from defaults>
  reviewer_lenses: <merged>
  prepare_draft: <merged>
focus: <optional>
---

# Review brief
PR #<num>: <title>
<focus/notes>
```

## Step 4 — Launch the workflow

Confirm `auto` permission mode is active (announce it; if not, ask the user to `Shift+Tab` to auto so reviewers don't stall mid-run). Pre-allowlisting `gh`/`git`/`node` avoids permission prompts during the run.

Run the saved workflow by name, passing args as structured JSON:

> Run `/review-flow-run` with args:
> ```json
> { "runDir": "<run_dir>", "outDir": "<out_dir>",
>   "repoDir": "<repo_dir or null>", "diffPath": "<out_dir>/pr.diff",
>   "briefPath": "<run_dir>/brief.md",
>   "prNumber": <num>, "prTitle": "<title>", "repo": "<owner/name>",
>   "prUrl": "<url>", "headSha": "<live_head>",
>   "urgency": "<urgency>", "maxComments": <n>,
>   "lenses": ["security","correctness","style","tests","observability"], "focus": <focus|null> }
> ```

Do **not** regenerate the script ad-hoc — launch the saved
`~/.claude/workflows/review-flow-run.js` so retro-tuned orchestration is used.
Watch progress with `/workflows`. The run is autonomous — no mid-run
input.

## Step 5 — Persist + render (after the workflow returns)

The workflow returns `{ commentsPath, wroteCommentsJson, orientationMd, diagramsStatus, counts, postCritic, cluster, lensesRun }`.

The critic wrote `comments.json` itself (its deliverable), so you don't reconstruct it.
1. Sanity-check: confirm `$out_dir/comments.json` exists and is valid JSON (`wroteCommentsJson` should be true). If missing/invalid, surface it — the critic likely died; re-run or fall back to raw findings.
2. If `orientationMd` is non-null, write it to `$out_dir/orientation.md`.
3. Render (deterministic — applies the urgency floor + numeric caps, writes review.md, review.html, draft-review.json):
   ```bash
   node ~/.claude/scripts/render-review.js "$run_dir"
   ```
   **Fail-soft:** if the script errors, log stderr to `$out_dir/render-error.log` and write a minimal fallback `review.md` from `comments.json` (verdict line + bulleted lists per tier). Don't abort.

## Step 6 — Optional pending draft

If `prepare_draft` is true, the renderer already wrote `$out_dir/draft-review.json` with the post-cap comment set:
1. **Validate every inline comment's anchor against the diff hunks before POST** — GitHub 422s the *entire* review if one comment can't anchor. Keep the anchorable ones; fold the rest into the review **body** as plain `file:line — note`. Surface the folded count.
2. If a prior run posted a live draft, prefer append over delete-and-repost (deleting resurrects comments the user struck).
3. POST: `gh api -X POST repos/<owner>/<repo>/pulls/<num>/reviews --input "$out_dir/draft-review.json"`. `event` is omitted so it stays PENDING.
4. On success print the review URL; on failure log to `$out_dir/draft-error.log` and continue (review.md/.html are still useful). Do **not** rebuild the payload from `comments.json` (it has no caps applied).

## Step 7 — Wrap-up

Fire a completion notification so the user sees it if they stepped away:
```bash
echo '{"hook_event_name":"Notification","message":"review-flow complete: PR #<num>"}' | ~/.dotfiles/claude/hooks/notify.sh
```

```
✓ review-flow complete
  PR:        #<num> — <title>
  verdict:   <postCritic>  ·  urgency: <urgency>
  markdown:  <run_dir>/out/review.md
  html:      file://<run_dir>/out/review.html
  draft:     <url | "not prepared">
  comments:  <total>  (critical: X, important: Y, recommended: Z, nit: W)
```
The `html:` line MUST be a fully-qualified `file://` URL (clickable in modern terminals). If only the fallback review.md exists, omit `html:` and add `⚠ render failed:` pointing at the log. Stay available for follow-ups ("why critical?"). The user can run `/retro` afterward to capture team-process lessons; don't run it automatically.

## Failure cases
- PR not found / not OPEN → surface; confirm before reviewing non-OPEN.
- `gh` not authenticated → tell the user `gh auth login` and stop.
- `wroteCommentsJson` false / `comments.json` missing (critic died before writing) → surface; re-run or fall back to raw findings.

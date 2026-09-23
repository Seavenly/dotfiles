---
description: Review a GitHub PR with a dynamic workflow — parallel reviewers across lenses → critic → adversarial verify → rendered review.md/.html, optional pending draft. Args — PR number (required), optional --repo owner/name, --urgency hotfix|fast|standard, --max-comments N, --prepare-draft, --lenses security,correctness,style,tests,observability.
---

You run a review-flow: gather the PR locally, launch the `review-flow`
dynamic workflow to do the parallel reviewer→critic→verify pass, then render and
(optionally) post the result. The autonomous fan-out lives in the
workflow; you handle the `gh`/`git`/render bookends and anything that
needs to talk to the user.

User's invocation: `/review-flow $ARGUMENTS`

## Read first
- `~/.claude/AGENT-TEAMS.md` — system architecture.
- `~/.claude/defaults.yaml` — cap defaults (`review_flow`).

## Step 1 — Parse arguments

- **PR number** (required) — bare integer or `#1234`.
- **`--repo owner/name`** — defaults to current repo (`gh repo view --json nameWithOwner -q .nameWithOwner`).
- **`--urgency hotfix|fast|standard`** (default `standard`); synonyms `--hotfix`, `--fast`. Urgency decides **what goes in the draft**, not how deeply the PR is read — reviewers always produce every tier, and the local report always shows every finding. Tiers:
  - `hotfix` — the draft carries criticals only; no orientation/diagrams.
  - `fast` — the draft carries criticals + importants.
  - `standard` — the draft carries all four tiers (subject to caps).
- **`--max-comments N`** — overrides `max_comments` (the draft budget; criticals and importants are exempt).
- **`--prepare-draft`** → `prepare_draft: true` (post a PENDING review at the end). Usually unnecessary: the user normally decides after reading the render.
- **`--lenses a,b,c`** → override `reviewer_lenses` (default from defaults.yaml).

If `$ARGUMENTS` is empty or `help`, explain usage (mention the three urgency tiers) and stop.

## Step 2 — Validate the PR

```bash
gh pr view <pr> --repo <repo> --json title,body,state,url,baseRefName,headRefName,headRefOid,baseRefOid,closingIssuesReferences
```
If the PR isn't found or isn't OPEN, surface and stop (for non-OPEN, confirm the user really means it before proceeding).

Show a one-line confirmation including the urgency summary, e.g. `urgency: fast — draft carries criticals + importants; local report shows everything`, then proceed. Do not wait for a `launch` reply; the user interrupts if a flag is wrong. If the invocation carried a `focus:`, include it in the brief.

## Step 3 — Build the run dir, pin the snapshot, clone, brief

```
run_id  = $(date +%Y-%m-%d-%H%M)-pr-<num>
run_dir = ~/.agent-teams/runs/<run_id>
out_dir = <run_dir>/out
repo_dir= <run_dir>/repo
```

**Pin one snapshot and review only that.** The head SHA, the diff and the checkout must all describe the same comparison, and that identity is what every later step (the render's deep-links, the draft's `commit_id`, the pre-POST drift check, a follow-up review) keys on. Fetching a "live head" and a "live diff" separately, as earlier versions did, does not prove they match.

```bash
mkdir -p "$out_dir/findings" "$out_dir/diagrams"
# 1. Diff + head, re-read until stable (a push between the two reads would
#    otherwise pair a diff with the wrong SHA).
for i in 1 2 3; do
  h1=$(gh pr view <pr> --repo <repo> --json headRefOid -q .headRefOid)
  gh pr diff <pr> --repo <repo> > "$out_dir/pr.diff"
  h2=$(gh pr view <pr> --repo <repo> --json headRefOid,baseRefOid -q '.headRefOid+" "+.baseRefOid')
  [ "$h1" = "${h2%% *}" ] && break
done
head_sha=${h2%% *}; base_sha=${h2##* }
# 2. Checkout of exactly that SHA. Fetch the commit itself and detach — do not
#    use `gh pr checkout`, which fails in a shallow clone (tracking setup) and
#    did so on every run.
mkdir -p "$repo_dir" && ( cd "$repo_dir" \
  && gh repo clone <repo> . -- --depth=50 --no-tags --quiet \
  && git fetch -q --depth=50 origin "$head_sha" \
  && git checkout -q --detach "$head_sha" ) 2>"$out_dir/clone-error.log"
checkout_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo none)
# 3. Record the snapshot.
cat > "$out_dir/snapshot.json" <<EOF
{ "head_sha": "$head_sha", "base_sha": "$base_sha",
  "diff_sha256": "$(shasum -a 256 "$out_dir/pr.diff" | cut -d' ' -f1)",
  "checkout_sha": "$checkout_sha", "fetched_at": "$(date -u +%FT%TZ)" }
EOF
```
If `checkout_sha != head_sha`, the checkout is unusable: set `repoDir` to null, and say so **visibly** in the confirmation and the wrap-up (`⚠ no checkout — diff-only review; absence and mechanism claims are lower confidence`). Never print "clone failed" and continue silently.

Also write the PR description to `$out_dir/pr-body.md` (the `body` from Step 2, plus any linked issues from `closingIssuesReferences` and any Jira key found in the title, branch name or body, each labelled with where it came from). An empty body is fine — say "no description" in the file so agents don't assume one exists. **Review guidance:** if the checkout has `REVIEW.md` or `.github/REVIEW.md`, pass its path as `reviewGuidePath`; otherwise null.

Then fetch the prior review conversation:
```bash
# Prior review conversation — threads with resolved/outdated state, author
# replies, and submitted reviews. Timestamps are load-bearing: they are what
# distinguish "answered, and I disagree" from "never answered".
gh api graphql -f query='
query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100){ nodes{ isResolved isOutdated path line
        comments(first:50){ nodes{ author{login} createdAt body } } } }
      comments(first:100){ nodes{ author{login} createdAt body } }
      reviews(first:50){ nodes{ author{login} submittedAt state body } }
    }
  }
}' -F owner=<owner> -F repo=<name> -F num=<pr> \
  --jq '.data.repository.pullRequest' > "$out_dir/prior-review.json" \
  2>"$out_dir/prior-review-error.log" || echo "prior-review fetch failed"
```

**The prior review conversation is primary input, not background.** A PR often already carries threads where the author settled a topic or factually rebutted a claim. Reviewers handed only the diff will re-raise those, and a review that re-litigates settled ground loses standing on its valid findings. Pass `priorReviewPath` whenever the fetch produced real content. Set it to **null** if the fetch failed *or* the PR genuinely has no prior conversation (all three node lists empty) — the reviewers are told to treat "not fetched" as *unknown* overlap rather than *no* overlap, so never let a failed fetch read as a clean slate.

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
head_sha: <head_sha>
base_sha: <base_sha>
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
Stated intent: see out/pr-body.md
<focus/notes>
```

## Step 4 — Launch the workflow

Confirm `auto` permission mode is active (announce it; if not, ask the user to `Shift+Tab` to auto so reviewers don't stall mid-run). Pre-allowlisting `gh`/`git`/`node` avoids permission prompts during the run.

Run the saved workflow by name, passing args as structured JSON:

> Run `/review-flow-run` with args:
> ```json
> { "runDir": "<run_dir>", "outDir": "<out_dir>",
>   "repoDir": "<repo_dir or null>", "diffPath": "<out_dir>/pr.diff",
>   "briefPath": "<run_dir>/brief.md", "prBodyPath": "<out_dir>/pr-body.md",
>   "priorReviewPath": "<out_dir>/prior-review.json or null",
>   "reviewGuidePath": "<path to REVIEW.md or null>",
>   "prNumber": <num>, "prTitle": "<title>", "repo": "<owner/name>",
>   "prUrl": "<url>", "headSha": "<head_sha>",
>   "urgency": "<urgency>", "maxComments": <n>,
>   "lenses": ["security","correctness","style","tests","observability"], "focus": <focus|null> }
> ```

Do **not** regenerate the script ad-hoc — launch the saved
`~/.claude/workflows/review-flow-run.js` so retro-tuned orchestration is used.
The run is autonomous — no mid-run input.

**While it runs, wait.** Tell the user once that it launched and roughly how long it takes (typically 5–15 minutes), then stop until the completion notification. Do not poll or narrate progress, do not start your own parallel review or verification of the PR (a host-side pass racing the workflow has produced a wrong early answer that had to be retracted), and do not probe `comments.json` mid-run. `/workflows` shows live progress if the user wants it.

## Step 5 — Persist + render (after the workflow returns)

**Return contract.** The workflow returns:
```
{ commentsPath, wroteCommentsJson, orientationMd, diagramsStatus,
  counts: {critical, important, recommended, nit},
  postCritic, postVerify,                 // posture enums
  verify: {struck, downTiered, strengthened} | null,
  cluster, lensesRun: [lens],
  rawFindings: [{lens, findings}] }       // unfiltered reviewer output
```
`comments.json` shape (the renderer's input; findings live under `inline` and `general`, not `comments`):
```
{ urgency, posture, posture_rationale, cluster,
  inline:  [{ id, path, line, side, tier, lens, body, evidence?, confidence?, pre_existing?, draft? }],
  general: [{ id, path?, line?, tier, lens, body, evidence?, confidence?, pre_existing?, draft? }] }
```
`body` is author-facing; `evidence` is local only (how the claim was established — files read, searches run, which pass changed it) and never posted.

`postVerify` and `verify` come from the adversarial **Verify** phase, which rewrites `comments.json` from the set that survived it and leaves the critic's original at `$out_dir/comments.pre-verify.json`. `verify: null` means the verifier died and the critic's unverified set stands — say so in the wrap-up rather than presenting it as verified. `counts` and `cluster` always reflect the last pass that owned the finding set. Write each `rawFindings` entry to `$out_dir/findings/<lens>.json` before rendering — the workflow runtime can't write files, and without these the critic's and verifier's effect can't be measured.

The critic wrote `comments.json` itself (its deliverable), so you don't reconstruct it.
1. Sanity-check: confirm `$out_dir/comments.json` exists and is valid JSON. Trust the file over the `wroteCommentsJson` flag (the flag has been mis-parsed while the file was fine). If the file is missing/invalid, surface it — the critic likely died; re-run or fall back to raw findings.
2. If `orientationMd` is non-null, write it to `$out_dir/orientation.md` (the renderer trims any preamble before `## Orientation`).
3. Render (deterministic — writes the complete local report and, if the publication gate passes, the draft payload):
   ```bash
   node ~/.claude/scripts/render-review.js "$run_dir"
   ```
   Read its stdout JSON. `draft_blocked` non-null means **no draft exists** — surface each hit (`pattern in where`) and fix it in `comments.json` (describe where the secret is; never quote it), then re-render. `draft_total: 0` means there is nothing to post at this urgency; say so rather than offering an empty draft.
   **Fail-soft:** if the script errors, log stderr to `$out_dir/render-error.log` and write a minimal fallback `review.md` from `comments.json` (verdict line + bulleted lists per tier). A failed render means **no draft** — never hand-build `draft-review.json`.
4. **Post-render corrections go through `comments.json`, never the rendered files.** If the finding set changes after rendering — a follow-up question, a user challenge, an author rebuttal that lands — edit `comments.json` and re-run the renderer. `review.md`, `review.html`, `draft-review.json`, the verdict line, the through-line/cluster block and the cap report are all *derived*. Hand-patching them is how a review ends up asserting a retracted claim next to a stale count, and it takes several passes to chase every copy down. Re-derive posture, `posture_rationale` and cluster from the surviving set in the same edit: a correction that drops a finding but keeps the old through-line is not a correction. Keep correction notes ("changed after X") in `evidence`, never in `body`.
5. **Filtering what gets posted** ("only criticals and importants", "just that one comment") is a draft-selection change, not a finding change: re-render with the brief's `urgency`/caps adjusted, or set `"draft": false` on findings in `comments.json` (they stay in the local report, marked "held back by the reviewer"). Do not delete findings to shape the draft.

## Step 6 — Optional pending draft

**Everything up to this point is cheap to rebuild; everything after it costs credibility.** Re-running the workflow, re-rendering, striking a finding and recomputing the verdict are all free while the artifact is unpublished. Once a draft is visible to the author, a wrong comment can only be corrected by *appending* a retraction — you cannot quietly re-render it away, and a single retracted finding discounts its neighbours. Front-load the doubt: if you are not confident in the set, render it and show the user first, and post only on their go-ahead.

When posting (because `prepare_draft` is true or the user asked after reading the render), run these gates **immediately before the POST, every time** — including when the user asks to post hours or days after the render:
1. **Draft exists.** `$out_dir/draft-review.json` must exist. If `draft-blocked.json` exists instead, or the render failed, stop and fix at the source.
2. **Head drift.** `gh pr view <pr> --repo <repo> --json headRefOid -q .headRefOid` must equal `head_sha` in `$out_dir/snapshot.json`. If it moved, **do not post**: new commits can invalidate findings (an absence claim becomes false, a line shifts) and change shared context in ways a per-finding patch can't see. Tell the user the head moved (`git log --oneline <old>..<new>` summary) and offer a fresh run against the new head.
3. **Anchors.** Validate every inline comment's anchor against the hunks in `pr.diff` — GitHub 422s the *entire* review if one comment can't anchor. Fold unanchorable ones into the review **body** as plain `file:line — note`, and surface the folded count. The payload carries `commit_id` = the reviewed SHA, so anchors resolve against the snapshot that was reviewed.
4. If a prior run posted a live draft, prefer append over delete-and-repost (deleting resurrects comments the user struck).
5. POST: `gh api -X POST repos/<owner>/<repo>/pulls/<num>/reviews --input "$out_dir/draft-review.json"`. `event` is omitted so it stays PENDING.
6. On success print the review URL; on failure log to `$out_dir/draft-error.log` and continue (review.md/.html are still useful). Do **not** rebuild the payload from `comments.json` (it has no caps applied).

## Step 7 — Wrap-up

```
✓ review-flow complete
  PR:        #<num> — <title>  @ <head_sha:0:10>
  verdict:   <postVerify — or postCritic if the verifier died>  ·  urgency: <urgency>
  verify:    struck <n>, down-tiered <n>, strengthened <n>   (or "⚠ verifier failed — critic's set unverified")
  markdown:  <run_dir>/out/review.md
  html:      file://<run_dir>/out/review.html
  draft:     <url | "not posted" | "⚠ blocked: <reason>">
  findings:  <total_findings> local, <draft_total> in draft  (critical: X, important: Y, recommended: Z, nit: W)[, pre-existing: P]
```
The `html:` line MUST be a fully-qualified `file://` URL (clickable in modern terminals). If only the fallback review.md exists, omit `html:` and add `⚠ render failed:` pointing at the log. Add `⚠ no checkout — diff-only` when `repoDir` was null. Stay available for follow-ups ("why critical?"). The user can run `/retro` afterward to capture team-process lessons; don't run it automatically.

## Failure cases
- PR not found / not OPEN → surface; confirm before reviewing non-OPEN.
- `gh` not authenticated → tell the user `gh auth login` and stop.
- Checkout SHA ≠ head SHA → diff-only, flagged visibly (Step 3).
- `comments.json` missing/invalid (critic died before writing) → surface; re-run or fall back to raw findings in `out/findings/`.
- `draft_blocked` / render failure → no draft; fix at the source and re-render.
- Head moved before POST → do not post; offer a fresh run.

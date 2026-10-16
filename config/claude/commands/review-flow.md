---
description: Review a GitHub PR with a dynamic workflow — parallel reviewers across lenses → critic → adversarial verify → Codex cross-model check → rendered review.md + HTML overview, optional pending draft. Args — PR number (required), optional --repo owner/name, --urgency hotfix|fast|standard, --depth quick|full (quick = one derived reviewer audited by Codex, criticals and importants only), --max-comments N, --prepare-draft, --lenses security,correctness,design,tests,observability, --no-codex, --focus "text", --at-base SHA --at-head SHA (replay frozen revisions; never posted).
---

Review PR `$ARGUMENTS`. Scripts do the mechanics; you run them in order, relay what they report, and talk to the user. If `$ARGUMENTS` is empty or `help`, explain the flags, the three urgency tiers (urgency only decides what the draft carries: hotfix = criticals, fast = + importants, standard = all; the local report always shows everything) and the two depths (full, the default: five lens reviewers, critic, verifier, Codex; quick, for a small low-risk PR: one reviewer reporting criticals and importants, Codex as its only audit, postable only when Codex applied) and stop.

## 1. Prepare

```bash
node ~/.claude/scripts/review-flow-prep.js $ARGUMENTS
```
It pins the reviewed snapshot, clones that exact commit, fetches the stated intent and prior review threads, reads the repo rules from the base revision (never the PR's own copies), CI annotations on the head and a changed-file census, writes the brief, and prints `{ runDir, launchArgs, codex, prepareDraft, confirm, warnings }`. With `--at-base`/`--at-head` it replays frozen revisions for the manual regression set (`~/.dotfiles/config/claude/review-flow-evals.md`); a replay can never be posted.
- Exit 3: the PR isn't open. Confirm with the user, then re-run with `--allow-closed`. Exit 4: `gh` failed (if unauthenticated, tell the user to run `gh auth login`).
- Show `confirm` and every warning on one or two lines, then continue. Don't wait for a reply.
- Depth quick: spawn the explainer now, in the background (step 3.5's inputs minus `orientation.md` and `comments.json`; skipped on hotfix), then launch.

## 2. Launch and wait

Confirm auto permission mode is on (ask the user to `Shift+Tab` if not); pre-allowlisting `gh`, `git` and `node` avoids prompts mid-run. Run the saved workflow `/review-flow-run` with `launchArgs` as its args; never regenerate the script. Tell the user it launched (typically 5–15 minutes), then **wait for the completion notification**. Don't poll, narrate, probe `comments.json`, or review the PR yourself in parallel.

It returns `{ commentsPath, orientationMd, counts, postCritic, postVerify, verify, cluster, lensesRun, rawFindings }`. `verify: null` means the verifier died and the critic's set is unverified; say so.

Depth quick returns the same keys plus `depth`, `escalate` and `comments` (the set in `comments.json` shape). `postCritic` is the quick reviewer's posture; `postVerify` and `verify` are null by design, since there is no Claude verifier. `comments: null` means the reviewer died; offer a re-run.

## 3. Persist, cross-check, render

1. Depth quick: write `comments` verbatim to `commentsPath` first. `comments.json` must exist and parse (trust the file over any flag). If it doesn't, the critic died; offer a re-run.
2. Write each `rawFindings` entry (findings, decisions, coverage) to `<outDir>/findings/<lens>.json`, and `orientationMd` (if any) to `<outDir>/orientation.md`. Lenses in `lensesFailed` get no file; the report shows them as not run.
3. Unless `codex` is false: `node ~/.claude/scripts/codex-cross-check.js <runDir>` (foreground, a few minutes, fail-soft). Relay its one-line result.
4. `node ~/.claude/scripts/render-review.js <runDir>`. If it errors, log stderr to `out/render-error.log`, write a minimal `review.md` from `comments.json`, and treat the run as having **no draft**.
5. Unless urgency is hotfix or depth is quick (already spawned), spawn the `explainer` agent in the background (Agent tool, `subagent_type: explainer`) for the HTML overview. Give it:
   - the PR: number, title, URL, head SHA;
   - sources: `<runDir>/out/pr-body.md`, `<runDir>/brief.md`, `<runDir>/out/pr.diff`, the checkout (`launchArgs.repoDir`) if any, `<runDir>/out/orientation.md` if written, and `<runDir>/out/comments.json` (its `decisions[]` and `posture`; line-level findings live in `review.md`, so it raises one only where it changes the design picture);
   - the purpose: the user is about to judge this PR with little or no prior context in the area, and needs the higher-level picture and the design and architecture choices to align on, not a line-by-line review;
   - output: `<runDir>/out/overview.html`.

   Handle the render output below while it runs; wait for it before the wrap-up. If it fails, say so; `review.md` stands on its own.

Read the render's stdout JSON:
- `draft_blocked` — no draft exists. Show each hit and its `fix`. For a contested critical/important, put Claude's claim and Codex's rebuttal in front of the user (open the cited file if that settles it in a minute, and say what you'd pick); the user decides and you record `"resolution": "restore" | "strike"` on that `contested[]` entry.
- `draft_total: 0` — nothing to post at this urgency; say so.
- `coverage_gaps`: lenses not run or partial, unreviewable files, missing repo rules. Relay them; they stay out of the draft.

**Every correction goes through `comments.json` plus a re-render; never edit rendered files.** When the set changes, re-derive `posture`, `posture_rationale` and `cluster` in the same edit. Correction notes go in a finding's `evidence`, never its `body` (the author reads `body`). To shape what gets posted without changing findings, set `"draft": false` on a finding or change the brief's urgency, then re-render. The overview is not re-rendered: if the finding set changes materially after it was written, tell the user it predates the change, and regenerate it only on request.

`comments.json`: `{ urgency, posture, posture_rationale, cluster, decisions[], inline[], general[], cross_check?, contested[]?, codex_raised[]? }`; a finding is `{ id, path, line, side, tier, lens, body, evidence, confidence, pre_existing, draft? }`.

## 4. Post (only when asked, or `prepareDraft`)

Unpublished artifacts are free to rebuild; a posted comment can only be corrected by a public retraction. If you doubt the set, show the user first. Before posting, read each critical and important against the changes the stated intent declares; any that argues against a declared change rather than showing a wrong outcome is reason for doubt. Put those in front of the user before posting, not in front of the author after.

```bash
node ~/.claude/scripts/review-flow-post.js <runDir>      # add --dry-run to check the gates only
```
It refuses replay runs (exit 7), then re-checks, at post time: a draft exists, the head hasn't moved (exit 4: tell the user and offer a fresh run; never post stale findings), no pending review of theirs already exists (exit 5: never delete it to repost, which resurrects comments they struck; ask whether they'll submit or discard it, or want the new comments listed to add by hand), and every anchor lands in the diff (unanchorable comments are folded into the body). A quick set whose Codex cross-check did not apply is refused (exit 8): it is one agent's unaudited word; offer a cross-check re-run or a full review. It posts PENDING with `commit_id` pinned to the reviewed SHA and prints the URL. Never rebuild the payload by hand.

## 5. Wrap up

```
✓ review-flow complete
  PR:        #<num> — <title>  @ <sha:10>
  verdict:   <postVerify, or postCritic if the verifier died>  ·  urgency: <urgency>  ·  depth: <depth>
  effort:    <the explainer's effort line after `effort:`, verbatim>   (omit if the overview failed or was skipped)
  escalate:  consider a full review: <escalate>   (quick only, when set or effort is Deep)
  verify:    struck <n>, down-tiered <n>, strengthened <n>   (or ⚠ verifier failed, or Codex audit only (quick))
  codex:     kept <n>, strengthened <n>, down-tiered <n>, contested <n>, raised <n> · <s>s   (or ⚠ skipped/failed: <reason>, or off)
  markdown:  <runDir>/out/review.md
  overview:  file://<runDir>/out/overview.html
  draft:     <url | not posted | ⚠ blocked: <reason>>
  findings:  <total> local, <in draft> in draft  (critical X, important Y, recommended Z, nit W)
  coverage:  <coverage_gaps joined, or complete>
```
`overview:` must be a full `file://` URL; omit the line if the overview failed or was skipped. Depth quick: when effort is Deep, the `escalate:` line also carries `effort Deep - <dimension>: <evidence>` (alone when `escalate` is null), and list each `codex_raised` finding (tier, location, one line) under the block, since nothing else looked for what the single reviewer missed. Repeat any prep warnings (for example "no checkout"). Stay available for follow-ups; the user can run `/retro` afterwards.

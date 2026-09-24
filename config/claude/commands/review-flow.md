---
description: Review a GitHub PR with a dynamic workflow — parallel reviewers across lenses → critic → adversarial verify → Codex cross-model check → rendered review.md/.html, optional pending draft. Args — PR number (required), optional --repo owner/name, --urgency hotfix|fast|standard, --max-comments N, --prepare-draft, --lenses security,correctness,design,tests,observability, --no-codex, --diagrams, --focus "text".
---

Review PR `$ARGUMENTS`. Scripts do the mechanics; you run them in order, relay what they report, and talk to the user. If `$ARGUMENTS` is empty or `help`, explain the flags and the three urgency tiers (urgency only decides what the draft carries: hotfix = criticals, fast = + importants, standard = all; the local report always shows everything) and stop.

## 1. Prepare

```bash
node ~/.claude/scripts/review-flow-prep.js $ARGUMENTS
```
It pins the reviewed snapshot, clones that exact commit, fetches the stated intent and prior review threads, writes the brief, and prints `{ runDir, launchArgs, codex, prepareDraft, confirm, warnings }`.
- Exit 3: the PR isn't open. Confirm with the user, then re-run with `--allow-closed`. Exit 4: `gh` failed (if unauthenticated, tell the user to run `gh auth login`).
- Show `confirm` and every warning on one or two lines, then continue. Don't wait for a reply.

## 2. Launch and wait

Confirm auto permission mode is on (ask the user to `Shift+Tab` if not); pre-allowlisting `gh`, `git` and `node` avoids prompts mid-run. Run the saved workflow `/review-flow-run` with `launchArgs` as its args; never regenerate the script. Tell the user it launched (typically 5–15 minutes), then **wait for the completion notification**. Don't poll, narrate, probe `comments.json`, or review the PR yourself in parallel.

It returns `{ commentsPath, orientationMd, diagramsStatus, counts, postCritic, postVerify, verify, cluster, lensesRun, rawFindings }`. `verify: null` means the verifier died and the critic's set is unverified; say so.

## 3. Persist, cross-check, render

1. `comments.json` must exist and parse (trust the file over any flag). If it doesn't, the critic died; offer a re-run.
2. Write each `rawFindings` entry to `<outDir>/findings/<lens>.json`, and `orientationMd` (if any) to `<outDir>/orientation.md`.
3. Unless `codex` is false: `node ~/.claude/scripts/codex-cross-check.js <runDir>` (foreground, a few minutes, fail-soft). Relay its one-line result.
4. `node ~/.claude/scripts/render-review.js <runDir>`. If it errors, log stderr to `out/render-error.log`, write a minimal `review.md` from `comments.json`, and treat the run as having **no draft**.

Read the render's stdout JSON:
- `draft_blocked` — no draft exists. Show each hit and its `fix`. For a contested critical/important, put Claude's claim and Codex's rebuttal in front of the user (open the cited file if that settles it in a minute, and say what you'd pick); the user decides and you record `"resolution": "restore" | "strike"` on that `contested[]` entry.
- `draft_total: 0` — nothing to post at this urgency; say so.

**Every correction goes through `comments.json` plus a re-render; never edit rendered files.** When the set changes, re-derive `posture`, `posture_rationale` and `cluster` in the same edit. Correction notes go in a finding's `evidence`, never its `body` (the author reads `body`). To shape what gets posted without changing findings, set `"draft": false` on a finding or change the brief's urgency, then re-render.

`comments.json`: `{ urgency, posture, posture_rationale, cluster, decisions[], inline[], general[], cross_check?, contested[]?, codex_raised[]? }`; a finding is `{ id, path, line, side, tier, lens, body, evidence, confidence, pre_existing, draft? }`.

## 4. Post (only when asked, or `prepareDraft`)

Unpublished artifacts are free to rebuild; a posted comment can only be corrected by a public retraction. If you doubt the set, show the user first.

```bash
node ~/.claude/scripts/review-flow-post.js <runDir>      # add --dry-run to check the gates only
```
It re-checks, at post time: a draft exists, the head hasn't moved (exit 4: tell the user and offer a fresh run; never post stale findings), no pending review of theirs already exists (exit 5: never delete it to repost, which resurrects comments they struck; ask whether they'll submit or discard it, or want the new comments listed to add by hand), and every anchor lands in the diff (unanchorable comments are folded into the body). It posts PENDING with `commit_id` pinned to the reviewed SHA and prints the URL. Never rebuild the payload by hand.

## 5. Wrap up

```
✓ review-flow complete
  PR:        #<num> — <title>  @ <sha:10>
  verdict:   <postVerify, or postCritic if the verifier died>  ·  urgency: <urgency>
  verify:    struck <n>, down-tiered <n>, strengthened <n>   (or ⚠ verifier failed)
  codex:     kept <n>, strengthened <n>, down-tiered <n>, contested <n>, raised <n> · <s>s   (or ⚠ skipped/failed: <reason>, or off)
  markdown:  <runDir>/out/review.md
  html:      file://<runDir>/out/review.html
  draft:     <url | not posted | ⚠ blocked: <reason>>
  findings:  <total> local, <in draft> in draft  (critical X, important Y, recommended Z, nit W)
```
`html:` must be a full `file://` URL; omit it if only the fallback exists. Repeat any prep warnings (for example "no checkout"). Stay available for follow-ups; the user can run `/retro` afterwards.

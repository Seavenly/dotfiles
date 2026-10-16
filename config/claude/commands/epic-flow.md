---
description: Run a Jira epic's stories through /feature-flow onto one integration branch - integrate the stories you approved in tuicr, refresh against main, prepare and launch the ready wave, and hand each built story to the local review inbox. Re-invoke to resume. Args - epic key and optional flags (--only KEYS, --skip KEYS, --concurrency N, --repo path, --codex, --dry-run, --integrate, --refresh, --done KEY, --finish).
---

You run an epic-flow: the epic's stories are built one feature-flow run each,
stacked on one integration branch (`epic/<key>` unless the epic description
names another). The owner reviews every story locally in tuicr; a story they
approved is integrated on their one confirmation per batch, which unblocks its
dependents. Re-invoking the command resumes from durable state.

Delivery is local review: never push a story branch and never open a PR. The
only pushes are the integration branch's creation and fast-forwards made by
`~/.claude/scripts/epic-flow-integrate.js` after a confirmed integration.

User's invocation: `/epic-flow $ARGUMENTS`. Defaults: `~/.claude/defaults.yaml`
(`epic_flow`, `feature_flow`). The per-story unit is
`~/.claude/commands/feature-flow.md`; follow it except where this says otherwise.

## Arguments
- Epic key (required). Empty or `help`: explain usage and stop.
- `--only KEYS` / `--skip KEYS`: comma lists limiting which stories launch.
- `--concurrency N` (default `epic_flow.concurrency`), `--repo <path>` (default CWD), `--codex` (passed to every story).
- `--dry-run`: print the graph, story states, drift, and what would launch; change nothing.
- `--integrate`: only integrate approved work. `--refresh`: only merge the target branch in (step 3).
- `--done KEY`: the owner confirms a `human-gate` story's human action or a `human-only` story is finished; record it and transition the story Done.
- `--finish`: the close-out (step 8).

## State
`epic_dir=~/.agent-teams/runs/epic-<key>/`, owned by this command:
- `epic.json`: `{ epic, repo, branch, target, remote, installCmd, holder: { session, since }, constraints[], stories: { KEY: { label, state, runs[], reviewSlug, reviewedHead, approvedHead, outcome, liveOnMerge, needsHuman, continuations } }, decisions[] }`. `state` is one of `ready`, `running`, `built`, `integrated`, `done`, `needs-human`. `outcome` keeps the run's `uncoveredAcceptance`, `deferredProof`, `openFindings`, and `decisions`.
- `gate.template.json`: the repo's gate commands (feature-flow step 4 without the per-story fields), written with the first story and treated as defaults: every story's own `gate init` is its baseline.
- `integrations.json`: receipts, written only by the integration script.

On every start, rebuild the picture from git, `tuicr-reviews list --json`, Jira, and run dirs, and trust them over `epic.json` when they disagree. If `holder` names another session active in the last 24 hours, ask before continuing; then record this session.

## 1. Load and validate
Fetch the epic and its children (`parent = <KEY> ORDER BY rank`) with status, labels, blocked-by links, and description. Stop on a dependency cycle. Labels:
- `agent-auto`: built and integrated by the flow.
- `human-gate`: built by the flow, but integrating it carries a human action (a deploy, a cross-team handshake, a live check). It is Done, and unblocks dependents, only after `--done`.
- `human-only`, unlabeled, spikes, and stories with a `Base branch:` other than the epic branch: listed under "needs a human", never launched.

If the integration branch is missing on the remote, check that the design docs the epic links are on the target branch (warn if not), then create it from the target and push it (the one-time exception to no-push). Run `epic-flow-integrate.js receipts <epic_dir>` for the tip and drift.

## 2. Integrate approved work
`tuicr-reviews list --approved --json`, `legacy` entries only, matched to this epic's story and refresh branches. For each, show one batch:
- `branch@sha` (the current branch head, which becomes `approvedHead`), the diff stat against the epic tip, and any commits after the run's `reviewedHead` (review fixes);
- the story's gate audit: `[unverified]` commits and commits the gate did not make;
- open obligations from `outcome` (uncovered acceptance, deferred proof, open findings) and, for `human-gate`, the human action.

Ask once: integrate all, a subset, or none, with a disposition for each obligation (follow-up, waived, or blocks). Record the answer in `epic.json`. Then, serially in dependency order:

```bash
node ~/.claude/scripts/epic-flow-integrate.js integrate <epic_dir> --story <KEY> --run <run_dir> \
  --head <approvedHead> --accept-unknown <the shown review-fix shas> --title "<KEY>: <summary>" --detach
node ~/.claude/scripts/epic-flow-integrate.js wait <epic_dir> --token <token>   # until it returns
```
It merges on a candidate branch from the exact remote tip, verifies the merged tree (unless it equals the gate-verified reviewed tree), records a receipt, and only then fast-forwards the remote. On `ok`: `agent-auto` stories with no obligation marked "blocks" go Done in Jira; `human-gate` stories stay In Progress with their action listed; then `tuicr-reviews rm`, the tuicr session, and the story worktree are removed. On `conflict` or `verification-failed`: mark needs-human with the files or failing command and offer a repair run (feature-flow from the current tip with the story branch and the failure as context). On `target-moved`: rerun the step. Refresh entries are landed with `land <epic_dir> --head <sha>` instead.

## 3. Drift from the target
Report `behind` (commits on the target not on the epic branch) every run. With `--refresh`, or when the owner agrees to it: `epic-flow-integrate.js refresh <epic_dir> --detach` and `wait`. It merges the target into `agt/refresh-<branch>` in `<epic_dir>/refresh` and verifies it. Register it with `tuicr-reviews add --repo <repo> --worktree <epic_dir>/refresh --base <branch> --branch agt/refresh-<branch> --slug <key>-refresh` and a summary naming `bothSides` (files changed on both sides, where a clean merge can still be wrong). It reaches the epic branch only through step 2 after approval. A conflict stops with the file list for the owner.

## 4. Ready set
A story is ready when its label is `agent-auto` or `human-gate`, it has no run in progress and no registered review, it passes `--only`/`--skip`, and every blocker is integrated (its `approvedHead` is on the remote tip) or Done; a `human-gate` blocker must be Done. A run dir without `out/report.md` is in progress until the owner says it is dead. Order by how many stories each unblocks, then Jira rank.

## 5. Prepare the wave
Spawn one `researcher` per ready story, in parallel, against the current epic tip. Each returns: acceptance criteria already satisfied, assumptions the code contradicts, the areas the story will touch, whether integrating it changes behavior anything deployed sees (`liveOnMerge`, with why), and a feature-flow brief: one observable behavior per criterion with an evidence tag (a property becomes an invariant with a concrete check that would show it false), `constraints`: the epic's and the story's Constraints and Out of scope as `source: user` (the owner approved them in the epic) and anything the researcher derives as `source: inferred`, which the wave approval confirms or drops; verify commands from its `Verify:` lines that do not modify files. Defer a story whose areas overlap a running or higher-ranked story. Show all briefs at once and take one answer: launch all, edit, or drop.

## 6. Launch
Up to the concurrency limit, for each approved brief: reserve it in `epic.json` (`running`, run id), then run feature-flow steps 3-5 without the interview: the run dir and brief, the worktree from `origin/<branch>`, the install (`installCmd`), `gate.json` from the template plus the story's worktree, branch, `commitPrefix` (`"<KEY>: "`), and `verifyCmds`, `gate init`, and the background launch. Transition the story In Progress.

## 7. When a run finishes
Do feature-flow step 6 (report, audit, register, story comment), with the story's key as the only key anywhere that reaches GitHub, and no smart-commit `#` commands in agent-written text. Record `reviewedHead`, `reviewSlug`, and `outcome`. Then by result:
- clean: `built`.
- `stuck` entries: one continuation (`epic_flow.continuations`). Append a short failure brief to `brief.md` (each stuck slice, the gate reason, the failing tail, what was ruled out), then relaunch the same run dir, worktree, gate, and `baseSha` without `gate init`: `slices` = the `spec` of each stuck and not-attempted entry, `continuation: true`, a new `launchId`, and `priorRunStats`. Register after it finishes.
- a non-ok review stage: feature-flow's `--review-only` relaunch.
- `RE_PLAN`, `uncoveredAcceptance` after the review loop, or a second failure: `needs-human` with the reason; register what exists with the summary prefixed `NEEDS HUMAN:`.
- a platform failure (login, API, spend cap, a dead workflow): resume the workflow run when it is this session's; otherwise launch a fresh run dir and worktree. Neither counts as a continuation.

Launch the next ready story whenever a slot frees.

## Status
When state changed, add one short comment to the epic: a table of story | state | review | needs a human | live on merge, plus drift. No prose recap.

## 8. Finish
`--finish`, when the owner says the critical path is done: list the remaining stories as follow-ups, the epic branch's commits that came from no story (refreshes, repairs, hand fixes) as the seams the final review should cover, and the stale worktrees, branches, and tuicr entries to remove. The integration branch to target PR stays the owner's action.

## Failure cases
- Epic not found or no children: say so and stop.
- A story's worktree branch collides: suffix the slug, as in feature-flow.
- The integration script reports `busy`: another session is integrating; wait or stop.
- The Atlassian tools are down: keep building and integrating; queue the Jira updates in `epic.json` and apply them next run.

---
description: Run a Jira epic's stories through /feature-flow toward main - prepare and launch the ready wave, stack dependents on agent-approved blockers, and hand each built story to the local review inbox to land as its own PR; an epic that names its own integration branch also integrates the stories you approved and refreshes against main. Re-invoke to resume. Args - epic key and optional flags (--only KEYS, --skip KEYS, --concurrency N, --repo path, --codex, --codex-effort E, --stack, --unattended, --dry-run, --integrate, --refresh, --done KEY, --finish).
---

You run an epic-flow: the epic's stories are built one feature-flow run each
from the epic's integration branch, which is `main` unless the epic
description's `Integration branch:` line names another. The owner reviews every
story locally in tuicr, and an approved story lands as Landing (below)
describes, which unblocks its dependents. Re-invoking the command resumes from
durable state.

Delivery is local review: never push a story branch and never open a PR unless
the owner asks (Landing). The only pushes are a named integration branch's
creation and the fast-forwards `~/.claude/scripts/epic-flow-integrate.js` makes
after a confirmed integration.

User's invocation: `/epic-flow $ARGUMENTS`. Defaults: `~/.claude/defaults.yaml`
(`epic_flow`, `feature_flow`). The per-story unit is
`~/.claude/commands/feature-flow.md`; follow it except where this says otherwise.

## Arguments
- Epic key (required). Empty or `help`: explain usage and stop.
- `--only KEYS` / `--skip KEYS`: comma lists limiting which stories launch.
- `--concurrency N` (default `epic_flow.concurrency`), `--repo <path>` (default CWD), `--codex` (passed to every story).
- `--dry-run`: print the graph, story states, drift, and what would launch; change nothing.
- `--integrate`: only integrate approved work. `--refresh`: only merge the target branch in (step 3). Both apply only to a named integration branch.
- `--done KEY`: the owner confirms a `human-gate` story's human action or a `human-only` story is finished; record it and transition the story Done.
- `--finish`: the close-out (step 8).
- `--stack`: a dependent may build on an agent-approved blocker before it lands (Stacking, below).
- `--unattended`: never ask; run until nothing is running and nothing is ready (Unattended, below). Use with `--stack` for a long run.
- `--codex-effort E`: with `--codex`, the final review's Codex effort for every story in this run (overrides `feature_flow.codex_effort`).

## State
`epic_dir=~/.agent-teams/runs/epic-<key>/`, owned by this command:
- `epic.json`: `{ epic, repo, branch (the integration branch), target, remote, installCmd, holder: { session, since }, constraints[], stories: { KEY: { label, state, runs[], reviewSlug, reviewedHead, approvedHead, outcome, liveOnMerge, needsHuman, continuations, agentApproved, stackBase, stackedOn } }, decisions[] }`. `state` is one of `ready`, `running`, `built`, `integrated`, `done`, `needs-human`. `outcome` keeps the run's `uncoveredAcceptance`, `deferredProof`, `openFindings`, and `decisions`.
- `gate.template.json`: the repo's gate commands (feature-flow step 4 without the per-story fields), written with the first story and treated as defaults: every story's own `gate init` is its baseline.
- `integrations.json`: receipts, written only by the integration script.

On every start, rebuild the picture from git, `tuicr-reviews list --json`, Jira, and run dirs, and trust them over `epic.json` when they disagree. If `holder` names another session active in the last 24 hours, ask before continuing; then record this session.

## 1. Load and validate
Fetch the epic and its children (`parent = <KEY> ORDER BY rank`) with status, labels, blocked-by links, and description. Stop on a dependency cycle. Labels:
- `agent-auto`: built by the flow; lands after the owner's review.
- `human-gate`: built by the flow, but landing it carries a human action (a deploy, a cross-team handshake, a live check). It is Done, and unblocks dependents, only after `--done`.
- `human-only`, unlabeled, spikes, and stories with a `Base branch:` other than the integration branch: listed under "needs a human", never launched.

Read the integration branch from the description (`main` when none is named) into `branch`, with `target` = `main`. Then set it up as Landing describes.

## Landing
**On `main`** (the default, `branch` = `target`): stories land straight on the target, so steps 2 and 3 do not run and the integration script answers them `lands-by-pr`. The owner lands each approved story as its own PR to `main`, in dependency order, each safe to merge alone.
- A story is landed when its PR has merged (`gh pr list --head <story branch> --state merged`) or it is Done. Squash merges leave its `approvedHead` off `main`, so the PR is the evidence. On start, record a newly landed story `integrated`, transition an `agent-auto` one Done (a `human-gate` one waits for `--done`), and remove its tuicr entry and worktree.
- When the owner asks for a story's PR: a draft from the story branch, opened only after every blocker it stacked on has merged, with `origin/main` merged into the branch first so the stack's copies of its blockers reconcile with their squash commits.
- While the epic's Landing note says the design PR has not merged, researchers and builders read the docs it links from the design branch it names.

**On a named branch** (`epic/<key>` and the like, for an epic whose stories cannot each merge alone): step 2 integrates approved stories into it and step 3 refreshes it against the target; a story is landed when its `approvedHead` is on the remote tip. If the branch is missing on the remote, check that the design docs the epic links are on the target (warn if not), then create it from the target and push it (the one-time exception to no-push). Run `epic-flow-integrate.js receipts <epic_dir>` for the tip and drift.

## 2. Integrate approved work (named branch)
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

## 3. Drift from the target (named branch)
Report `behind` (commits on the target not on the integration branch) every run. With `--refresh`, or when the owner agrees to it: `epic-flow-integrate.js refresh <epic_dir> --detach` and `wait`. It merges the target into `agt/refresh-<branch>` in `<epic_dir>/refresh` and verifies it. Register it with `tuicr-reviews add --repo <repo> --worktree <epic_dir>/refresh --base <branch> --branch agt/refresh-<branch> --slug <key>-refresh` and a summary naming `bothSides` (files changed on both sides, where a clean merge can still be wrong). It reaches the epic branch only through step 2 after approval. A conflict stops with the file list for the owner.

## 4. Ready set
A story is ready when its label is `agent-auto` or `human-gate`, it has no run in progress and no registered review, it passes `--only`/`--skip`, and every blocker is landed (Landing) or Done; a `human-gate` blocker must be Done. With `--stack`, an `agent-auto` blocker that is `built` and `agentApproved` also counts. A run dir without `out/report.md` is in progress until the owner says it is dead. Order by how many stories each unblocks, then Jira rank.

## Stacking (`--stack`)
A story is `agentApproved` when its run ended on the clean path of step 7 (state `built`), every stage in `stageStatus` is `ok` or `skipped`, the gate audit passed, and `uncoveredAcceptance` is empty. Nothing else, including a stuck or continued run, counts.

- **Base.** A story whose blockers are all landed or Done starts from `origin/<branch>` as usual. Otherwise build a local stack base `agt/stack-<KEY>` (never pushed) from `origin/<branch>`, merging each unlanded direct blocker's `reviewedHead` in dependency order; transitive blockers come with them. A merge conflict defers the story with the files listed, and it is retried once a blocker lands. Record `stackBase` (its sha) and `stackedOn` (`{ BLOCKER: reviewedHead }`).
- **Run.** The researcher, the worktree, `gate init`, and the final review all use the stack base, so the review covers only the story's own commits.
- **Register** the tuicr review with `--base <stackBase>` and the summary prefixed `STACKED on <KEYS>:`.
- **A blocker that fails later** (`needs-human`, dropped, or rejected in review) marks every story stacked on it `needs-human` with "stale base: <KEY>"; it is rebuilt after the blocker is repaired.
- **Landing.** A stacked story lands only with or after every blocker it stacked on, in dependency order. On a named branch, step 2 offers it in the same batch as, or after, those blockers; when a blocker's `approvedHead` differs from the sha in `stackedOn` (review fixes), show that in the batch; the integration merge and its verification decide, and a failure takes the usual repair path.

## 5. Prepare the wave
Spawn one `researcher` per ready story, in parallel, against `origin/<branch>` (or the story's stack base). Each returns: acceptance criteria already satisfied, assumptions the code contradicts, the areas the story will touch, whether integrating it changes behavior anything deployed sees (`liveOnMerge`, with why), and a feature-flow brief: one observable behavior per criterion with an evidence tag (a property becomes an invariant with a concrete check that would show it false), `constraints`: the epic's and the story's Constraints and Out of scope as `source: user` (the owner approved them in the epic) and anything the researcher derives as `source: inferred`, which the wave approval confirms or drops; verify commands from its `Verify:` lines that do not modify files. Defer a story whose areas overlap a running or higher-ranked story. Show all briefs at once and take one answer: launch all, edit, or drop. With `--unattended`, launch every brief without asking, except a story whose researcher reports an assumption the code contradicts: defer that one and list it in the summary.

## 6. Launch
Up to the concurrency limit, for each approved brief: reserve it in `epic.json` (`running`, run id), then run feature-flow steps 3-5 without the interview: the run dir and brief, the worktree from `origin/<branch>` (or its `stackBase` when stacked), the install (`installCmd`), `gate.json` from the template plus the story's worktree, branch, `commitPrefix` (`"<KEY>: "`), and `verifyCmds`, `gate init`, and the background launch, with `codex.effort` from `--codex-effort` when given. Transition the story In Progress.

## 7. When a run finishes
Do feature-flow step 6 (report, audit, register, story comment), with the story's key as the only key anywhere that reaches GitHub, and no smart-commit `#` commands in agent-written text. Record `reviewedHead`, `reviewSlug`, and `outcome`. Then by result:
- clean: `built`, and record `agentApproved` (Stacking).
- `stuck` entries: one continuation (`epic_flow.continuations`). Append a short failure brief to `brief.md` (each stuck slice, the gate reason, the failing tail, what was ruled out), then relaunch the same run dir, worktree, gate, and `baseSha` without `gate init`: `slices` = the `spec` of each stuck and not-attempted entry, `continuation: true`, a new `launchId`, and `priorRunStats`. Register after it finishes.
- a non-ok review stage: feature-flow's `--review-only` relaunch.
- `RE_PLAN`, `uncoveredAcceptance` after the review loop, or a second failure: `needs-human` with the reason; register what exists with the summary prefixed `NEEDS HUMAN:`.
- a platform failure (login, API, spend cap, a dead workflow): resume the workflow run when it is this session's; otherwise launch a fresh run dir and worktree. Neither counts as a continuation.

Launch the next ready story whenever a slot frees.

## Unattended (`--unattended`)
The owner is away, so never ask; where a step would ask, take the action below and log it in `epic.json` `decisions`.
- Holder: if another session holds the epic and was active in the last 24 hours, stop.
- Step 2 (named branch): integrate nothing (integration needs the owner's confirmation); only list what is approved.
- Step 3 (named branch): report drift; do not refresh.
- Step 5: as above. Step 7: a `needs-human` story never blocks the rest; keep launching whatever is ready.
- Keep going until nothing is running and nothing is ready. Then post the status comment and write `<epic_dir>/summary.md`: every story's state, what to review first (blockers before their stacked dependents), deferred and `needs-human` stories with the reason, and the landing order (on a named branch, for the owner's next `/epic-flow <KEY> --integrate`).

## Status
When state changed, add one short comment to the epic: a table of story | state | review | needs a human | live on merge, plus drift. No prose recap.

## 8. Finish
`--finish`, when the owner says the critical path is done: list the remaining stories as follow-ups and the stale worktrees, branches, and tuicr entries to remove. On a named branch, also list its commits that came from no story (refreshes, repairs, hand fixes) as the seams the final review should cover; the PR from it to the target stays the owner's action.

## Failure cases
- Epic not found or no children: say so and stop.
- A story's worktree branch collides: suffix the slug, as in feature-flow.
- The integration script reports `busy`: another session is integrating; wait or stop.
- The Atlassian tools are down: keep building and integrating; queue the Jira updates in `epic.json` and apply them next run.

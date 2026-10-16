---
description: Implement a feature with a dynamic workflow - interview, brief, worktree, then planner, per-slice builder with a deterministic gate, completeness and design review, a final cross-model review, and a short review summary, delivered to the local tuicr inbox. Args - goal statement and optional flags (--gated, --grill, --codex, --max-retries N, --max-fix-rounds N, --context path, --repo path, --base branch, --verify "cmd", --story JIRA-KEY, --review-only run_id).
---

You run a feature-flow: interview the user, write a brief, prepare a worktree
and its gate, launch the `feature-flow-run` workflow, and hand the result to
the local review inbox. The workflow owns planning, building, and review; you
own the interview, setup, the optional plan gate, and the handoff.

Delivery is local review only: register the review with `tuicr-reviews add`
and leave the branch and worktree in place. Do not push and do not open a PR.

User's invocation: `/feature-flow $ARGUMENTS`

Read `~/.claude/defaults.yaml` (`feature_flow`) for defaults.

## 1. Arguments
- Goal: the leading free text. Empty or `help`: explain usage and stop.
- `--gated`: approve the plan before building (two launches, step 5).
- `--grill`: interview in depth with the `grilling` skill before the brief.
- `--codex`: the final review runs on Codex (`codex_model` / `codex_effort`
  from defaults) instead of Fable; Codex usage is limited, so it is opt-in.
- `--max-retries N`, `--max-fix-rounds N` (0-2, one per review stage): override the caps.
- `--context <path>` (repeatable): copy into the run's `context/`.
- `--repo <path>` (default: CWD). `--base <branch>`: branch from it and diff
  against it (default: the current branch).
- `--verify "<cmd>"` (repeatable): approved verification commands, run for
  verify-mode slices and the final gate (for example `pulumi preview --stack
  dev`). Destructive or credentialed live commands (`pulumi up`) stay human
  gates unless the user separately authorizes them.
- `--story <KEY>`: fetch the Jira issue; its summary, description, acceptance
  criteria, and `Verify:` / `Base branch:` lines pre-answer the interview
  (flags override them).
- `--review-only <run_id>`: rerun only the review and handoff against that
  run's existing worktree (step 7).

## 2. Interview
Ask only what the arguments and story leave open, at most four questions:
1. **Repo**: confirm it; warn about unrelated uncommitted changes.
2. **Acceptance**: what must be true when done, and what proves each item
   (a test, the diff, docs, a CI job, or a live check)?
3. **Scope boundaries**: what must not change, such as other environments,
   public interfaces, or neighboring services? What is explicitly out?
4. **Context**: files, docs, or PRs to read.

## 3. Brief
`run_id=$(date +%Y-%m-%d-%H%M)-<slug>`, `run_dir=~/.agent-teams/runs/<run_id>`,
`out_dir=$run_dir/out`. Create both plus `$run_dir/context`; copy `--context`
files (warn on missing ones). Write `$run_dir/brief.md`:

```markdown
---
type: feature
run_id: <run_id>
repo: <abs path>
base_branch: <base>
story: <KEY or null>
final_reviewer: fable | codex
acceptance:
  - { id: A1, evidence: test, text: "<one observable behavior>" }
  - { id: A2, evidence: "ci:<job name>", text: "..." }
constraints:
  - { source: user, text: "<the user's rule, in their words>" }
  - { source: inferred, text: "<a rule you derived, confirmed by the user>" }
---

# Goal
<goal and anything learned in the interview>
```

Each criterion is one observable behavior, split from compound statements,
tagged `test`, `diff`, `docs`, `ci:<job>`, or `live`. "Lint, typecheck, and
tests pass" is not a criterion; the gate enforces it. Scope boundaries and
process rules go under `constraints`. Every agent enforces them as given, so
record a user's rule verbatim (`source: user`) and never widen it. Anything you
derive, such as a broader class of data to protect, is `source: inferred`:
check it against how the repo already handles the same thing and confirm it
with the user, or leave it out. Show the brief and wait for `launch`, `edit`, or `cancel`
(cancel: remove the run dir and stop).

## 4. Worktree and gate
```bash
git -C <repo> fetch origin "<base>" 2>/dev/null || true
wt="$run_dir/worktree"
git -C <repo> worktree add "$wt" -b "agt/feature-<slug>" "origin/<base>" 2>/dev/null \
  || git -C <repo> worktree add "$wt" -b "agt/feature-<slug>" "<base>"
```
Install dependencies once in the worktree (`mise install`, the lockfile's
package manager, `uv sync`, `cargo build --tests`). The gate needs a clean
worktree: if the install changed tracked files, stop and ask; untracked
artifacts it leaves belong in `.gitignore` or `ignorePaths`. Then write
`$run_dir/gate.json`. Only the host writes it; the gate refuses to run after
it changes.

```json
{ "worktree": "<wt>", "branch": "agt/feature-<slug>", "commitPrefix": "<KEY>: " ,
  "staticCmds": ["<typecheck>", "<fast lint>"], "suiteCmd": "<full suite>",
  "verifyCmds": ["<--verify / story Verify: commands>"],
  "normalizeCmds": ["<formatter> {files}"], "focusedTestCmd": "<runner> {files}",
  "focusedTestCmds": [{ "paths": "<pkg>/**", "cwd": "<pkg>", "cmd": "<pkg runner> {files}" }],
  "ignorePaths": ["coverage/**"], "timeoutSec": <gate_timeout_sec> }
```
Use `""` for `commitPrefix` without a story, and omit fields that don't apply.
Commands run non-interactively (`CI=1`, no watch mode). Formatters belong in
`normalizeCmds`, never in the checks, and test and format templates take
`{files}`. Give the red check a focused runner wherever one exists: in a
monorepo, add a `focusedTestCmds` entry per package (files are passed
relative to `cwd`); without one, red is recorded as unchecked.
`ignorePaths` lists files the suite itself writes. The gate judges commands
by exit status, so a preview whose risky output is a replace or delete needs
a wrapper that exits non-zero on it (for example a script that fails on
`replace` or `delete` in `pulumi preview --json`).

Baseline: run `node ~/.claude/scripts/feature-flow-gate.js init "$run_dir"
--detach`, then `... wait "$run_dir" --token <token>` until it returns, and
keep its `baseSha` for the launch. If it
reports `baseline-red`, a timeout, or a mutation, do not launch: show the
failing command and ask for an approved alternative, update `gate.json`, and
re-run `init --force`.

## 5. Launch
Confirm `auto` permission mode. The settings must allow
`Bash(node ~/.claude/scripts/feature-flow-gate.js *)` and
`Bash(node ~/.claude/scripts/feature-flow-codex-review.js *)`; if prompts
appear, add them. Launch the saved workflow by name; never regenerate it.

```json
{ "runDir":"<run_dir>","outDir":"<out_dir>","worktree":"<wt>","branch":"agt/feature-<slug>",
  "base":"<base>","baseSha":"<init baseSha>","launchId":"<$(date +%s), new for every launch>",
  "briefPath":"<run_dir>/brief.md","slug":"<slug>",
  "gate":"node ~/.claude/scripts/feature-flow-gate.js",
  "acceptance":[<brief acceptance objects>],
  "maxSliceRetries":<n>,"maxFixRounds":<n>,
  "finalReviewer":"fable|codex","codex":{"model":"<m>","effort":"<e>"},
  "planOnly":false,"slices":null,"reviewOnly":false,"priorRunStats":null }
```
`--gated`: launch with `planOnly:true`, show `plan.md`, iterate on edits, then
launch again with the approved `slices` and `priorRunStats`.

## 6. Handoff
The workflow returns the report and journal content, `reviewedBase`,
`reviewedHead`, `stageStatus`, `audit`, and the outcome lists. Two other
shapes: `{ escalate: 'RE_PLAN', reason }` (surface the reason and stop for the
user's decision) and `{ error }` (the plan or the gate failed; surface it,
with `stuck` and `stageStatus`, and register nothing).

1. Write `reportContent` to `$out_dir/report.md` and `notesContent` to
   `$out_dir/notes.md`. If the report is missing, surface that and stop. If
   the write itself fails, show the content and its path; do not relaunch.
2. Run `node ~/.claude/scripts/feature-flow-gate.js audit "$run_dir"`. It
   must report no unknown commits and the head must equal `reviewedHead`.
3. Tell the user, most important first: `uncoveredAcceptance`, `decisions`,
   unverified commits, `stuck` / `notAttempted`, `openFindings`,
   `deferredProof` (the CI or live checks still to run), the final reviewer
   used (and any fallback), `postReviewFixes`, then `runStats`. Do not rerun
   checks to restate them.
4. Register the review:
   `tuicr-reviews add --repo <repo> --worktree <wt> --base <base> --branch <branch> --slug <slug> --summary "<one scannable line>"`.
   If any stage in `stageStatus` is not `ok` or `skipped`, or the audit fails,
   prefix the summary with `UNREVIEWED: <stages>` and offer
   `/feature-flow --review-only <run_id>`.
5. With `--story`: comment the branch, the summary, and any unmet criteria,
   stuck slices, and open findings on the issue, and leave it In Progress. Mention no other issue keys anywhere;
   the GitHub-Jira link can transition every key it finds.

The user can run `/retro` afterward. Remove the worktree later with
`git -C <repo> worktree remove <wt>`.

## 7. Review-only relaunch
For `--review-only <run_id>`: reuse that run dir, worktree, brief, and
`gate.json`; launch with `reviewOnly:true` and the same arguments otherwise;
then do step 6. Before launching, add each explicit instruction from the human
reviewer to the brief's `constraints` verbatim as `source: reviewer`, so
repairs cannot reverse it. Uncommitted work in the worktree is committed as
`[unverified]` first, so the review sees it.

## Failure cases
- No identifiable repo: ask.
- Worktree branch collision: suggest a unique slug.
- No test runner: ask before launching; verify-only work needs approved
  `verifyCmds`.

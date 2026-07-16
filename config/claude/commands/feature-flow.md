---
description: Implement a feature with a dynamic workflow — interview → brief → worktree (one native install) → planner/TDD/critic/synthesizer workflow → PR-ready branch. Works for non-TDD (infra) stories via --verify gates. Args — goal statement and optional flags (--gated, --grill, --max-retries N, --max-revisions N, --context path, --repo path, --base branch, --verify "cmd", --story JIRA-KEY).
---

You run a feature-flow: interview the user, draft a brief, set up a
worktree with deps installed once, then launch the `feature-flow-run`
dynamic workflow to implement it. The autonomous build (plan → TDD →
critic → synthesize) lives in the workflow; you handle the interview,
worktree/setup, the optional plan gate, and the wrap-up.

> **⚠️ DELIVERY MODE — LOCAL REVIEW ONLY (overrides the PR steps in wrap-up).**
> The finished branch is delivered to the **local `tuicr` review inbox**, NOT as a
> GitHub PR. In Step 6: **register the review with `tuicr-reviews add`** and leave
> the local branch + worktree in place — then stop. **Do NOT `git push` and do NOT
> `gh pr create`** (not even a draft), even when `--story` is given. Since nothing
> hits GitHub, there is no PR link to auto-transition Jira: leave the story **In
> Progress** and comment the local review handle / branch name on it instead of a
> PR link (skip the transition-to-In-Review + PR-comment step). The human reviews
> and integrates locally. (Rationale + scope: memory
> `feedback-epic-flow-local-review-not-prs`.)

User's invocation: `/feature-flow $ARGUMENTS`

## Read first
- `~/.claude/AGENT-TEAMS.md` — system architecture.
- `~/.claude/defaults.yaml` — cap defaults (`feature_flow`).

## Step 1 — Parse arguments
- **Goal statement** — leading free text / first quoted string.
- `--gated` → plan-approval gate (two-phase launch, see Step 5).
- `--grill` → heavy interview (grill-me style) before drafting.
- `--max-retries N` → `max_slice_retries`. `--max-revisions N` → `max_critic_revisions`.
- `--context <path>` (repeatable) → copy into the run's `context/`.
- `--repo <path>` → target repo (default: CWD).
- `--base <branch>` → branch the worktree from this branch and target the PR at it (integration-branch workflows). Default: the branch the user is on.
- `--verify "<cmd>"` (repeatable) → verification command(s) the slice gate runs *in addition to* the test suite (e.g. `pulumi preview --stack dev`). This is the gate for `nonTestable` (infra/config) slices, which have no failing test to drive them.
- `--story <JIRA-KEY>` → fetch the Jira issue (Atlassian MCP) and use its summary/description as the goal and acceptance criteria; on wrap-up, open the PR and update the story (see Step 6). A story description may carry its own `Verify:` and `Base branch:` lines — treat those as defaults that explicit flags override.

If `$ARGUMENTS` is empty or `help`, explain usage and stop.

## Step 2 — Interview (lightweight by default)
If `--story` was given, fetch the issue first — its summary, description, acceptance criteria, and any `Verify:`/`Base branch:` lines pre-answer the questions below; with a well-formed story the interview usually has nothing left to ask, which is the point (unattended runs). Skip any question already answered by args. Three max:
1. **Target repo** — confirm CWD (or `--repo`); warn on unrelated uncommitted changes.
2. **Acceptance signal** — "What should be true when this is done? A passing test, a route that responds, a visible behavior?"
3. **Must-read context** — "Any files/docs/PRs the team should read? (paths or 'none')"

If `--grill`, conduct a deeper multi-round interview, pushing on ambiguity, before drafting.

## Step 3 — Build the run dir and brief
```
run_id   = $(date +%Y-%m-%d-%H%M)-<slug>
run_dir  = ~/.agent-teams/runs/<run_id>
out_dir  = <run_dir>/out
```
`mkdir -p "$out_dir" "$run_dir/context"`. Copy each `--context` file into `context/` (warn, don't fail, on missing).

Write `<run_dir>/brief.md` (merge `defaults.yaml.feature_flow` + flag overrides):
```markdown
---
type: feature
created: <ISO>
run_id: <run_id>
repo: <abs repo path>
config:
  max_slice_retries: <merged>
  max_critic_revisions: <merged>
  plan_gate: <true if --gated>
  base_branch: <from --base / story / current branch>
  verify_commands: [<from --verify / story, may be empty>]
  story: <JIRA-KEY or null>
env: {}
setup_commands: []
acceptance:
  - <from interview>
context_files:
  - <relative paths under context/>
---

# Goal
<goal statement + anything from the interview>
```
Show the rendered brief; reply `launch` / `edit` / `cancel`. On cancel `rm -rf "$run_dir"` and stop.

## Step 4 — Worktree + one-time install
Capture the diff base BEFORE branching — `--base` if given, else the branch the user is on (default `main`). When `--base` names a remote-tracked integration branch, fetch it first so the worktree starts from its latest tip:
```bash
base=<--base if given, else $(git -C <repo> rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)>
git -C <repo> fetch origin "$base" 2>/dev/null || true
wt="$run_dir/worktree"
git -C <repo> worktree add "$wt" -b "agt/feature-<slug>" "origin/$base" 2>/dev/null \
  || git -C <repo> worktree add "$wt" -b "agt/feature-<slug>" "$base"
```
Install deps once, natively, in the worktree (this is the only install for the run — agents and you share this tree). Use `setup_commands` if set, else auto-detect:
- `.mise.toml` → `mise install` · `package.json` → `pnpm|npm|yarn install` (per lockfile) · `pyproject.toml` → `uv sync`|`poetry install` · `Cargo.toml` → `cargo build --tests`
Detect the test command (e.g. `pnpm test`) to pass as `testCmd`. Run the verification triad once to confirm tooling works; surface gaps before launching.

## Step 5 — Launch the workflow
Confirm `auto` permission mode (announce; if not, ask the user to `Shift+Tab`). Pre-allowlist the test/build/`git` commands so the gate agents don't stall mid-run.

**Ungated (default):** launch the saved workflow once with `planOnly:false`:
> Run `/feature-flow-run` with args:
> ```json
> { "runDir":"<run_dir>","outDir":"<out_dir>","repo":"<repo>","worktree":"<wt>",
>   "base":"<base>","briefPath":"<run_dir>/brief.md","slug":"<slug>","testCmd":"<cmd|null>",
>   "verifyCmds":[...]|null,
>   "maxSliceRetries":<n>,"maxCriticRevisions":<n>,"acceptance":[...],
>   "planOnly":false,"slices":null }
> ```

**Gated (`--gated`):** two launches with the plan approved between them (a workflow can't take mid-run input):
1. Launch with `planOnly:true`. It returns `{ slices, planPath }`. Show `plan.md` to the user; loop on edits (edit `plan.md` and adjust the slice list).
2. On approval, launch again with `planOnly:false` and `slices:<approved slice array>` so the planner is skipped and implementation runs the approved slices.

Launch the saved `~/.claude/workflows/feature-flow-run.js` by name — never regenerate ad-hoc. Watch with `/workflows`.

## Step 6 — Wrap-up (after the workflow returns)
The workflow returns `{ branch, reportPath, notesPath, slices, criticRevisions, criticVerdictMissing, stuck, openFindings, deferredFindings, uncoveredAcceptance }` (or `{ escalate:'RE_PLAN', reason }`).

- **RE_PLAN** → surface the critic's reason and stop; do not auto-replan.
- **stuck[]** non-empty → call out which slices exhausted retries (or never got a behaviorally-failing test) and the recorded reason.
- **uncoveredAcceptance[]** non-empty → the completeness gate found acceptance criteria the brief asked for but the artifact still doesn't demonstrate after a fix pass — i.e. promised behavior that did **not** ship. Call these out first and prominently; they're surfaced at the top of the PR body under "Unmet acceptance criteria". This is a stronger signal than an open design finding: the feature is incomplete against its own contract.
- **openFindings[]** non-empty → note the critic hit the revision cap with open merge-blocking findings (they're also in the PR body).
- **deferredFindings[]** non-empty → mention the critic recorded non-blocking follow-ups; they're listed in the PR body under "Things deliberately not done".
- **criticVerdictMissing** true → warn that the outer critique pass produced no verdict (the critic died twice); recommend a manual review before merging.
- Otherwise print:
```
✓ feature-flow complete
  branch:  <branch>   (worktree: <wt>)
  report:  <reportPath>
  journal: <notesPath>   (what happened across slices)
  diff:    git -C <wt> diff <base>...HEAD
```
- Record the review so the `tuicr` tmux hotkey (`prefix + r`) can reopen it later: `tuicr-reviews add --repo <repo> --worktree <wt> --base <base> --branch <branch> --slug <slug> --summary "<one-line summary>"`. The `--summary` is a short, human-readable one-liner naming what the PR does (the story summary, or the brief's goal in plain prose) — it shows as a column in the picker, so make it scannable, not the branch name restated. Idempotent; upserts by (worktree, base, branch), and stale entries self-prune once the worktree is removed. Skip only for stuck/RE_PLAN runs that produced no reviewable branch.

**If `--story` was given** (and the run wasn't stuck/RE_PLAN): push the branch and open the PR **as a draft** against the base branch with `report.md` as the body — `git -C <wt> push -u origin <branch>` then `gh pr create --draft --base <base> --title "<JIRA-KEY>: <story summary>" --body-file <out_dir>/report.md`. **Agent-opened PRs are always drafts and are never auto-merged** — a human reviews, marks the PR ready, and merges. (Draft status keeps coworkers from accidentally reviewing/merging unreviewed agent output, and keeps any merge-triggered deploy a human decision.) Then move the Jira story to In Review (or its nearest equivalent transition) and comment the PR link. If the run ended stuck or with open findings, comment the findings on the story and leave it In Progress.

**PR title/body reference ONLY this story's own key.** Never write another Jira issue key (a sibling, blocker, or downstream `ABC-NNN`/`PROJ-NNN`) in the PR title or body. The GitHub↔Jira integration creates a remote link on every issue key it finds in a PR, and a Jira automation rule can then auto-transition those *other* issues to Done — silently false-completing work that never happened. Refer to related stories by name/prose without the key (e.g. "the CI-redesign story", not "ABC-302"), or express the relationship as a Jira issue link on the story itself. The only key that belongs in the PR is this story's, in the title.

Stay available for follow-ups. The user can run `/retro` afterward to capture team-process lessons; don't run it automatically. (The worktree persists for the user to inspect/verify; remove later with `git -C <repo> worktree remove <wt>`.)

## Failure cases
- No identifiable repo → ask, don't guess.
- Worktree add fails (dirty branch name collision) → surface, suggest a unique slug.
- No test runner → surface, ask for guidance before launching.

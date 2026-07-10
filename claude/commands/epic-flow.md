---
description: Orchestrate epic-level agent work — read a Jira epic's stories (agent-auto/human-gate labels, blocked-by links), dispatch /feature-flow runs per story onto a shared integration branch. The agent builds EVERY story; the label sets merge authority — agent-auto stories the agent merges itself on a clean feature-flow completion, human-gate stories open a PR for a human to merge. Pause when progress needs a human merge; finish with a whole-epic review PR. Args — epic key and optional flags (--branch name, --concurrency N, --repo path, --dry-run).
---

You run an epic-flow: turn a Jira epic full of PR-sized stories into a
stream of feature-flow runs stacked on one integration branch. The agent
builds every story; the only human step in the loop is **merging the PRs of
`human-gate` stories** (and reviewing anything an agent-auto run couldn't
cleanly finish). Re-invoking the command on the same epic resumes it — all
state lives in Jira and git, none in this session.

User's invocation: `/epic-flow $ARGUMENTS`

## Read first
- `~/.dotfiles/claude/AGENT-TEAMS.md` — system architecture.
- `~/.dotfiles/claude/commands/feature-flow.md` — the per-story unit of work this command dispatches.
- `~/.dotfiles/claude/defaults.yaml` — `epic_flow` defaults.

## Conventions the epic's stories must follow
- Every story carries exactly one of the labels `agent-auto` or `human-gate`. **The agent builds BOTH via feature-flow** — the label governs *merge authority*, not whether the agent runs the story:
  - `agent-auto` — the agent may **merge the story's PR itself** once feature-flow completes cleanly (and CI is green). No human review required.
  - `human-gate` — the agent builds the story and opens the PR, but **only a human may merge it**. Use this whenever the merge needs human judgment or an out-of-loop action tied to the merge — a real cloud deploy, a cross-team handshake, a production-affecting or irreversible change. The agent still writes the code (e.g. the IaC) and gets the PR green; the human owns the merge (and whatever deploy/handshake the merge implies).
- Every story must be written so an agent can pick it up (clear acceptance + `Verify:` lines), regardless of label.
- Dependencies are Jira "is blocked by" links.
- A story description may carry `Base branch:` and `Verify:` lines (one command per `Verify:` line) — feature-flow reads them via `--story`.
- One story ≈ one PR. PRs target the integration branch, never main.

## Step 1 — Parse arguments
- **Epic key** (required) — e.g. `PROJ-300`.
- `--branch <name>` → integration branch (default: `epic/<key, lowercased>`).
- `--concurrency N` → max simultaneous story runs (default from `defaults.yaml`).
- `--repo <path>` → target repo (default: CWD).
- `--dry-run` → print the dependency graph, wave plan, and what would launch now; change nothing.

If `$ARGUMENTS` is empty or `help`, explain usage and stop.

## Step 2 — Load the epic
Via the Atlassian MCP: fetch the epic, then its child stories (JQL `parent = <KEY> ORDER BY rank`). For each story collect: status, labels, "is blocked by" links, and the description's `Base branch:`/`Verify:` lines. Validate before doing anything:
- every story has exactly one of `agent-auto`/`human-gate` — list violations and stop;
- the blocked-by graph is acyclic — report any cycle and stop;
- warn (don't stop) on stories with no acceptance criteria.

## Step 3 — Integration branch
```bash
git -C <repo> fetch origin
git -C <repo> rev-parse --verify origin/<branch> >/dev/null 2>&1 \
  || (git -C <repo> branch <branch> origin/<default> && git -C <repo> push -u origin <branch>)
```
Never force-push the integration branch. If branch protection would block the agent pushing branches or opening PRs into it, surface that now, not mid-run.

## Step 4 — Dispatch loop
Repeat until no story is launchable:

1. **Ready set** = stories with status To Do (**either label**) and every blocker Done. Both `agent-auto` and `human-gate` stories are launched — they differ only at the merge step (3).
2. **Launch** up to `concurrency` ready stories. Each launch is the feature-flow procedure with `--story <KEY> --base <branch>` (story `Verify:` lines become `--verify`): build the run dir + brief from the story, create the worktree from `origin/<branch>`, launch the `feature-flow-run` workflow in the background, transition the story to In Progress. Distinct stories run in parallel worktrees; the same story never runs twice concurrently.
3. **On a run's completion**, do feature-flow's wrap-up. If `origin/<branch>` moved while the run was in flight, **merge the latest `origin/<branch>` into the story branch first (integrate with a merge commit — NEVER rebase or force-push), then re-run the verify commands** (this is the stacking/conflict policy — conflicts go back to an implementer agent, then the gate re-verifies). Push the branch and open the PR against `<branch>` with `report.md` as body — `gh pr create --base <branch> --title "<KEY>: <summary>" --body-file <report>`. Then, **by label:**
   - **`agent-auto`** — if the run finished **cleanly** (verify green, and NONE of: stuck slices, open merge-blocking findings, uncovered acceptance, `criticVerdictMissing`) **and the PR's required CI checks are green**, the agent **merges the PR** into `<branch>` (`gh pr merge --squash`). The merge auto-transitions the story to Done and unblocks its dependents, so the loop continues autonomously. If the run did **not** finish cleanly, do NOT auto-merge: leave the PR open, mark it in the status comment as awaiting human review, and apply the failure policy (4) if it was stuck/RE_PLAN. (Auto-merge may trigger a deploy — the clean-completion + green-CI gate is what makes that acceptable; when in doubt it degrades to human review, never a blind merge.)
   - **`human-gate`** — open the PR for review and **do NOT merge**; a human merges it (and performs any deploy/handshake the merge implies). The story stays un-Done and its dependents stay blocked until that human merge.

   Opening a PR (and, for agent-auto, merging it) auto-transitions the story via the GitHub↔Jira link; don't transition by hand. **Never name another story's Jira key in a PR title/body** (or in `report.md`) — the GitHub↔Jira integration remote-links every key it finds and a Jira automation can then auto-transition those siblings/downstream stories to Done, silently false-completing them. Reference related stories by prose, not key; the only key in the PR is the one being implemented (in the title). Express cross-story relationships as Jira issue links on the story, not as PR-body mentions.
4. **Failure policy** (the flawed-agent clause): a run that ends stuck / RE_PLAN / with open merge-blocking findings gets ONE fresh retry — a new feature-flow run for the same story with the prior journal passed as `--context`. On the second failure: add label `agent-blocked`, comment the reason on the story, do NOT open a PR, and continue with stories that don't depend on it.

## Step 5 — Human-merge gates
The gate is now at **merge**, not pick-up: the agent builds `human-gate` stories, but their PRs sit open until a human merges them. The loop pauses when it can make no further progress without a human merge — i.e. the ready set is empty and every remaining To-Do story is blocked by a story whose PR is open-but-unmerged (a `human-gate` PR, or an `agent-auto` PR left open because its run didn't finish cleanly). Post a gate summary (which PRs await a human merge, what each needs — e.g. deploy / cross-team handshake / review — and what's blocked behind them), fire the notify hook (`~/.dotfiles/claude/hooks/notify.sh`), and stop the loop. The human merges those PRs (merging marks the story Done and unblocks its dependents); re-invoking `/epic-flow <KEY>` resumes from live state.

Idempotency: Done stories are skipped. A story with an **open PR** (a `human-gate` PR, or an agent-auto PR awaiting review) is *awaiting merge* — do not re-run or re-open it. An In Progress story with **no live run and no open PR** is treated as To Do. A `human-gate` story whose deliverable is already merged/complete should be marked **Done**, not left In Progress, or the loop will re-run it.

## Step 6 — Endgame
When every story is Done: open the integration→main PR titled from the epic (`<KEY>: <epic summary>`), with a body that links every story PR in merge order. Recommend `/review-flow <pr-number>` for the whole-epic review — don't run it automatically. Comment the PR link on the epic.

## Status surface
Maintain ONE status comment on the epic (create it on first run, update thereafter): a table of story | status | PR | note (e.g. `agent-blocked: <reason>`). Update it at each loop iteration and when stopping at a gate.

## Failure cases
- Epic not found / no child stories → say so, stop.
- Label/cycle validation failures → list them, stop (the epic is mislabeled, not the run).
- `agent-auto` PRs are merged by the agent **only** on a clean feature-flow completion with green CI; anything less is left open for a human. `human-gate` PRs are always left for a human to merge (the merge is where the deploy/handshake decision lives). Note every open/awaiting-merge PR in the status comment so the human knows what needs their merge.
- A worktree add collision → unique slug suffix, as in feature-flow.

## v1 limits (deliberate)
No scheduler beyond the ready-set loop, no cross-story batching, no automatic re-plan of a blocked story. Run `/retro` after the first wave and fold what it finds back into this command.

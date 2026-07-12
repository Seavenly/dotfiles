# Agent Teams — Architecture

Single source of truth for the agent-teams system in this dotfiles repo.
**Read this before editing anything under `config/claude/`.**

## What this is

A homegrown system for handing off recurring software-engineering tasks to
a team of Claude Code subagents, orchestrated by **dynamic workflows** and
run **entirely on the local machine** (no sandbox). Three flows:

- `/feature-flow` — implement a feature: plan → TDD inner loop → critic outer pass → PR-ready branch on a worktree.
- `/review-flow` — review an open PR: parallel reviewers across lenses (security, correctness, style, tests, observability) → critic dedupes/right-sizes/anchors → rendered review.md/.html + optional pending draft on GitHub.
- `/spike-flow` — investigate a question: researcher(s) → critic gap-analysis → optional in-repo prototype → spike report.

Each flow is **two layers**: a thin interactive *command* (the front half)
and a saved *workflow script* (the autonomous back half). You start a flow
by running the command in your normal Claude Code session; it interviews
you, drafts a brief, sets up a worktree, then launches the workflow, which
runs in the background while your session stays responsive. You watch with
`/workflows`.

> **History.** This system previously ran inside Docker `sbx` sandboxes
> with the experimental Agent Teams (tmux teammates) feature. We moved
> host-local + workflow-backed to get real host MCP servers, native deps
> (no OS-mismatch reinstall ping-pong), no inner `/login`, and the
> context-isolation a sandbox handoff used to provide — now delivered by
> the workflow runtime's isolated execution. The Agent Teams experimental
> flag is no longer used.

## The three layers

| Layer | File | What it is | Interactive? |
|---|---|---|---|
| **Command** | `commands/<flow>-flow.md` (prose) | Interview → brief → worktree/setup → launch workflow → render/wrap-up. Owns everything that talks to you or needs the shell (`gh`/`git`/`node`). | **Yes** |
| **Workflow** | `workflows/<flow>-flow-run.js` (JS) | The autonomous orchestration: fan-out, loops, gates, caps — held as code. Runs in the isolated workflow runtime; results live in script variables; only the final summary returns to the conversation. | No |
| **Role agents** | `agents/<role>.md` (prose) | The personas the workflow spawns as subagents via `agent(..., {agentType})`. Judgment lives here; the JS is only wiring. | No |

**Naming:** the user-facing command is `/<flow>-flow`; the workflow it
launches is `/<flow>-flow-run` (distinct name to avoid a `/` collision).
You never invoke `*-run` directly — the command does, by name, passing a
structured `args` object.

## Substrate: why workflows

Claude Code offers subagents, skills, agent teams, and dynamic workflows.
We use **workflows** for the execution half because the plan lives in
*code*: deterministic loops/branching/caps, intermediate results in script
variables (not the conversation's context), background execution, a
`/workflows` progress view, and built-in quality patterns (adversarial
cross-check, judge panels). The interactive half *can't* be a workflow —
the runtime takes no mid-run user input — so it stays in the command.

Within a workflow, parallel work is just concurrent `agent()` calls
(`parallel`/`pipeline`); sequential same-file work (the TDD loop) is a
plain `for` loop. The critic/reviewers keep independent context **by
construction** — a subagent only sees its spawn prompt — which is the
property the old Agent Teams "teammate" gave us. Mailbox debate (the one
thing teammates did that subagents can't) is replaced by parallel
researchers + a critic gap-analysis pass (cross-checked synthesis).

**Per-role model assignment** — each persona declares its default in its
frontmatter `model:`; a workflow overrides per call via `opts.model` only
when a specific call should deviate (precedence: `opts.model` > persona
frontmatter > inherit session model). Assigned by **frequency × leverage**:
top tier where one call's quality compounds through the run, the workhorse
tier on the high-volume inner loop, the cheap tier on prescriptive assembly.

| Role | Default | Calls / typical run | Why |
|---|---|---|---|
| planner | opus¹ | 1 | Highest leverage per call; a bad decomposition multiplies cost through every slice and critic cycle |
| critic | opus¹ | 1–4 | Catch rate is the whole value; fable-critic over opus-implementer also breaks the shared-distribution blind spot (in-family version of the cross-provider idea) |
| tester | opus | ~1 per slice | High-skill code work; blast radius bounded to one slice by the gate |
| implementer | opus | ~1–2 per slice | Highest-volume heavyweight role; the test gate defines "done" |
| researcher | opus | 3–4 in parallel | High-recall finder; precision comes from the fable critic downstream |
| diagrammer | sonnet | 0–1 | Near-checklist persona with graceful failure (skipped.txt / .mmd fallback); bump back to opus if diagrams degrade |
| synthesizer | sonnet | 1 | Format artifacts into PR body / report — no novel reasoning |
| gate (test-runner) | sonnet | ~1–2 per slice | Mechanical, highest-frequency call; pinned via `opts.model` in the scripts since it has no persona file |

Current deliberate overrides in the scripts: the review-flow **orientation**
agent runs the researcher persona at `sonnet` (a 300-word strictly templated
summary, not open-ended research), and the **gate** is script-pinned to
`sonnet`. Everything else omits `opts.model` so the persona default is the
single source of truth — don't re-add redundant pins. Caveat: `fable`
assumes Fable access on whatever plan the run executes under; if that ever
breaks, `opus` is the fallback for planner/critic.

¹ **Temporary (2026-06-15):** planner and critic are pinned to `opus`
because Fable access is turned off. Their intended default is `fable` (see
the rationale above). There is no automatic preferred-with-fallback model
selection in the harness — frontmatter `model:` and `opts.model` each take a
single value — so this is a manual swap. Revert both persona frontmatters
(`config/claude/agents/planner.md`, `config/claude/agents/critic.md`) to `model: fable`
once Fable is re-enabled.

## Data flow

```
┌─ your Claude Code session (the command) ──────────────────────────┐
│ /feature-flow "add user profile page"                             │
│   → interview (light, or --grill heavy)                           │
│   → write ~/.agent-teams/runs/<id>/brief.md, confirm              │
│   → git worktree add <run>/worktree -b agt/feature-<slug> <base>  │
│   → install deps ONCE (native; setup_commands or auto-detect)     │
│   → launch saved workflow by name, args = {runDir, worktree,      │
│        base, briefPath, caps, testCmd, ...}                       │
└───────────────────────────────────────────────────────────────────┘
                              │ args (the brief is the handoff)
                              ▼
┌─ workflow runtime (background, isolated context) ─────────────────┐
│ feature-flow-run.js:                                              │
│   phase Plan      → agent(planner)  → slices[] (+ plan.md)        │
│   phase Implement → workflow('tdd-slice-loop') — per slice,       │
│        sequential (same files): tester → implementer → gate       │
│        (run suite; commit on green), retry ≤ N                    │
│   phase Critique  → agent(critic) → APPROVE|FIX_LIST|RE_PLAN      │
│        FIX_LIST → blocking items back through tdd-slice-loop;     │
│        non-blocking deferred to the PR body as follow-ups;        │
│        re-spawn critic; cap max_critic_revisions cycles           │
│   phase Synthesize→ agent(synthesizer) → out/report.md (PR body)  │
│   return {branch, reportPath, slices, stuck, openFindings,        │
│           deferredFindings, ...}                                  │
└───────────────────────────────────────────────────────────────────┘
                              │ summary returns to the conversation
                              ▼
┌─ your session (wrap-up) ──────────────────────────────────────────┐
│ prints branch + report path + diff command; handles RE_PLAN /     │
│ stuck-slice / open-finding escalations. You review in the         │
│ worktree (deps already installed), then merge. /retro optional.   │
└───────────────────────────────────────────────────────────────────┘
```

review-flow and spike-flow follow the same command→workflow→wrap-up shape;
their workflow internals differ (see below).

## File map

```
<dotfiles-root>/
├── mise.toml                      # native bootstrap links managed Claude files into ~/.claude
└── config/
    ├── tmux/tmux.conf             # (C-a `claude agents` pane; the old C-t bullpen binding is gone)
    └── claude/
        ├── AGENT-TEAMS.md         # this file
        ├── OBSERVABILITY.md       # observability doctrine shared by the builder + reviewer
        ├── defaults.yaml          # cap defaults (merged into the brief at draft time)
        ├── RETRO-LEDGER.md        # cross-run process memory (version-controlled)
        ├── commands/              # → ~/.claude/commands
        │   ├── feature-flow.md    # interactive front half
        │   ├── review-flow.md
        │   ├── spike-flow.md
        │   ├── retro.md           # conversation-side retro (emits run-dir retro.md)
        │   └── retro-consume.md   # applies retro patterns to agents/workflows/docs
        ├── workflows/             # → ~/.claude/workflows  (saved dynamic workflows)
        │   ├── feature-flow-run.js
        │   ├── review-flow-run.js
        │   ├── spike-flow-run.js
        │   └── tdd-slice-loop.js  # shared TDD inner loop (sub-workflow, never run directly)
        ├── agents/                # → ~/.claude/agents  (role personas; agentType source)
        │   ├── planner.md  tester.md  implementer.md
        │   ├── critic.md   researcher.md  synthesizer.md  diagrammer.md
        └── scripts/               # → ~/.claude/scripts
            ├── render-review.js   # deterministic review.md/.html/draft renderer
            ├── package.json  mermaid.config.json

State (host-local, not version-controlled):
~/.agent-teams/runs/<ts>-<slug>/
  ├── brief.md          # task contract; durable, re-runnable (the workflow's args point here)
  ├── context/          # files copied at brief time
  ├── repo/             # review-flow: shallow clone of the PR head ref
  ├── worktree/         # feature/spike-prototype: the branch worktree (deps installed here)
  └── out/              # artifacts: plan.md, comments.json, review.{md,html}, report.md, retro.md
```

## The three flows in detail

### feature-flow
**Command:** interview (light; `--grill` heavy; `--gated` adds a plan gate) → brief → worktree + one-time install → launch.
**Workflow (`feature-flow-run.js`):** planner → per-slice TDD loop via the shared `tdd-slice-loop` sub-workflow (tester → implementer → independent test-gate that commits on green, retry ≤ `max_slice_retries`; tester output is sanity-checked — a missing/never-failing test gets one tester retry, then the slice is recorded stuck) → critic Mode A outer pass (only **merge-blocking** FIX_LIST items re-enter the loop; non-blocking findings are deferred to the PR body as follow-ups; re-spawn critic; cap `max_critic_revisions`; RE_PLAN escalates; a critic that returns nothing gets one re-spawn, then the run ships flagged `criticVerdictMissing`) → synthesizer PR body.
**`--gated`:** the command launches twice — `planOnly:true` returns the plan for your approval, then a second launch passes the approved `slices` back (a workflow can't take mid-run input).
**Notes journal:** carried as a list of entry blocks in a script variable, folded from each agent's structured handoff. Inner-loop prompts see a capped view (most recent ~40 entries) so a long run doesn't tax every prompt; the critic and synthesizer get the full journal, and the synthesizer persists it verbatim to `out/notes.md` for auditability.
**E2E discipline:** the final slice's tester drives the feature end-to-end through the real wiring.

### review-flow
**Command:** validate PR (`gh`) → clone head ref + fetch diff into the run dir → brief → launch → on return, write `comments.json`, run `render-review.js`, optionally POST a pending draft.
**Workflow (`review-flow-run.js`):** one reviewer per lens in `parallel(...)`, with orientation + diagrammer fired alongside but **un-barriered** (the critic starts as soon as the lens findings are in — it never waits on the diagrammer's possible multi-minute mermaid-cli bootstrap; side results are collected before the return). Both side agents are skipped on `--urgency hotfix`. Then critic Mode B (dedupe, spot-verify against the code and **strike** wrong findings, right-size tiers, verify anchoring, decide posture, name the cluster). Reviewers **return structured findings**; the critic **writes its own `comments.json`** (its deliverable, like plan.md/report.md) and returns a summary; the conversation just renders.
**Policy is deterministic:** `render-review.js` applies the urgency floor (hotfix=criticals only, fast=+important, standard=all) and numeric per-tier caps, and emits review.md, review.html (blob-deep-linked), and draft-review.json. **No tests, no execution** — review is static. **Never auto-submit** — drafts stay PENDING.

### spike-flow
**Command:** light interview (+ derive research angles for deep) → brief → (prototype only) worktree + install → launch.
**Workflow (`spike-flow-run.js`):** quick = single researcher → synthesizer. deep = `parallel(researchers per angle)` → critic Mode C gap-analysis → revision pass (each reviser receives its angle's **original findings** to update — keep what holds, fix the gap — not redo from scratch; one cycle by default, a token-budget directive with ≥150k headroom buys a second critic+revision cycle) → synthesizer. Optional prototype = planner → shared `tdd-slice-loop` sub-workflow scoped to `experiments/<slug>/` (no critic outer pass; stuck slices surface in the return and the report) → synthesizer. Researchers return findings as text held in script variables and passed inline to the critic and synthesizer.

## Brief schema

The brief is the runtime contract and the workflow's `args` source. Lives
at `~/.agent-teams/runs/<ts>-<slug>/brief.md`. Same shape across flows with
a `type:` field (feature | review | spike). The command merges
`defaults.yaml` + brief `config:` + CLI flags at draft time, *before*
confirmation, then launches with a structured `args` object derived from
the finalized brief.

## Caps cascade

Three layers, lowest priority first: **shipped defaults** (`defaults.yaml`) →
**brief `config:` overrides** → **command flags** (`--max-retries`,
`--gated`, `--max-comments`, `--urgency`, …). Flags merge into the brief
before confirmation; the workflow reads the merged values from `args`.

## Permission / trust posture

Host-local means agents run **real commands with your real credentials and
no sandbox isolation** — feature/spike run your test suite and installs on
this machine; review `--prepare-draft` posts with your `gh` auth. This is
accepted by design. Flows **default to `auto` permission mode** so the team
runs unsupervised; workflow subagents always run `acceptEdits` regardless
of session mode. **Pre-allowlist** the test/build/`gh`/`git`/`node`
commands a run needs, or an un-allowlisted command will pause the run
waiting on you. Review is static (no execution), so it's the lowest-risk
flow.

## Where state lives

| What | Where | Persistence |
|---|---|---|
| Brief, context, artifacts | `~/.agent-teams/runs/<id>/` | Until manual prune |
| Worktree branch | `<run>/worktree` + git on the repo | Until `git worktree remove` |
| Workflow script (source of truth) | `~/.claude/workflows/*.js` | Version-controlled |
| Workflow run journal | `~/.claude/projects/<...>/` (per-run script + agent results) | Managed by Claude Code |
| Retro ledger | `~/.claude/RETRO-LEDGER.md` | Version-controlled |

## Retro loop

Two steps, flow-agnostic. (1) **`/retro`** (conversation-side, after a
workflow returns) reflects on the run via the `/workflows` view, the
run-dir artifacts, and the workflow's return value, and writes
`<run>/out/retro.md` — transferable process patterns only (AVOID / ADD /
STRESS), each mapped to a target. (2) **`/retro-consume`** reads it, checks
`RETRO-LEDGER.md` for corroboration/conflicts/prior reverts, and applies
surgical edits anywhere under `~/.claude`. The key triage: a
**judgment** problem edits a role `agents/*.md`; an **orchestration**
problem (wiring, budgets, a spawn prompt that lives in the script) edits a
`workflows/*.js`. The ledger is the cross-run memory that keeps single-run
noise from thrashing the prompts.

**Discipline:** always launch the *saved* workflow by name so retro-tuned
orchestration is used — never let Claude regenerate a workflow ad-hoc, or
the accumulated learnings evaporate.

## Troubleshooting

- **Two `/<flow>` commands collide.** The interactive command is
  `/<flow>-flow`; the workflow is `/<flow>-flow-run`. If you see a clash,
  a workflow was misnamed to match its command.
- **A run stalls mid-flow.** An agent hit an un-allowlisted shell/MCP call
  (only those can pause a run). Allowlist the command and resume from
  `/workflows`, or run in `auto`.
- **Workflow starts fresh after a restart.** Resumability is same-session
  only; re-launch the command (the brief is durable and re-runnable).
- **Stuck slices / open findings.** The workflow returns these; the
  command surfaces them and the synthesizer carries open findings into the
  PR body. Not silent.
- **Workflows unavailable.** Need Claude Code ≥ 2.1.154 and workflows not
  disabled (`/config` → Dynamic workflows; `disableWorkflows`;
  `CLAUDE_CODE_DISABLE_WORKFLOWS`).
- **`workflow('tdd-slice-loop')` throws (unknown name).** The shared inner
  loop is a saved workflow that must exist at
  `~/.claude/workflows/tdd-slice-loop.js` (mise-symlinked from this
  repo). If it's missing, the parent logs the launch failure and records
  every slice as stuck rather than dying mid-run — re-link and re-launch.

## Future considerations

1. **Behavioral validator** — a stage that runs the app and exercises it
   (Playwright for web, expect for TUIs/CLIs) before declaring a feature
   done, complementing the static critic.
2. **Cross-provider critic** — route the critic to a different provider to
   break the in-family critic+implementer shared-distribution blind spot.
3. **`agt-ls` / `agt-prune`** — list active runs, prune old run dirs +
   worktrees, when run count justifies it.

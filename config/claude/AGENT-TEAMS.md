# Agent Teams — Architecture

Single source of truth for the agent-teams system in this dotfiles repo.
**Read this before editing anything under `config/claude/`.**

## What this is

A homegrown system for handing off recurring software-engineering tasks to
a team of Claude Code subagents, orchestrated by **dynamic workflows** and
run **entirely on the local machine** (no sandbox). Three flows:

- `/feature-flow` — implement a feature: plan → per-slice builder with a deterministic gate → completeness and design review → final cross-model review → a reviewable branch in the local tuicr inbox.
- `/review-flow` — review an open PR: parallel reviewers across lenses (security, correctness, design, tests, observability) → critic dedupes/reconciles/right-sizes → independent adversarial verifier (the single fact-check owner) → Codex cross-model check → rendered review.md (complete local report) + a free-form HTML overview (explainer) + optional pending draft on GitHub. `--depth quick` swaps the Claude passes for one derived reviewer, audited by Codex alone. `--since-last-review` re-reviews only the commits since your last submitted review.
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
(`parallel`/`pipeline`); sequential same-file work (the test-or-verify loop) is a
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
| planner | opus, high | 1 | Highest leverage per call; a bad decomposition multiplies cost through every slice |
| builder | opus, high | ~1-2 per slice | feature-flow's slice builder: tests first, red snapshot, implementation; may update tests the slice deliberately changes |
| completeness-critic | opus, high | 1-2 | Maps each acceptance criterion to evidence; catches planned work that never landed |
| feature-critic | opus, high | 1 | In-flow lenses review; reports every finding with severity and confidence, decides nothing |
| final review | feature-critic on fable | 1 | Fresh cross-model look at the complete change with brief and plan only; `--codex` sends the same persona to Codex (the latest Sol model, medium), with Fable as the fallback. A 2026-10-02 replay showed a thinner final-review prompt missing a Critical the lens persona caught |
| feature-verifier | opus, high | 1-2 | Triage: verifies each finding, then fix / follow-up / reject by risk and fix cost |
| critic | opus, high | 1-2 | spike-flow gap analysis (Mode C) |
| review-critic | opus | 1 | review-flow's critic (dedupe, reconcile, tier, posture). The review verifier runs persona-free on opus |
| tester, implementer | opus | ~1-2 per slice | spike-flow's prototype loop (`tdd-slice-loop`) |
| researcher | opus | 3-4 in parallel | High-recall finder; precision comes from the critic downstream |
| explainer | opus | 0-1 | review-flow's HTML overview; picks its own structure and visuals, so judgment sets its quality |
| synthesizer | sonnet | 1 | Formats the review summary / report; no novel reasoning |
| gate relay | sonnet, low | ~1-2 per slice | Runs the deterministic gate script and returns its JSON; owns no checks |

Deliberate overrides in the scripts: the review-flow **orientation** agent
runs the researcher persona at `sonnet`, the `--depth quick` reviewer pins it to `opus` (the only Claude judgment in a quick run, so a cheaper persona default must not reach it), and gate relays (feature-flow's gate
script, spike-flow's mechanical gate) are script-pinned to `sonnet` at low
effort. Everything else omits `opts.model`, so the persona frontmatter is the
single source of truth.

Models are named by family, never by version: the Claude aliases (`opus`,
`sonnet`, `fable`) track each family's newest release, and Codex runs ask for
`latest-sol`, which `scripts/codex-model.js` resolves per run from Codex's own
model catalog (falling back to the bundled catalog, then the last slug it
chose) and records with the result. A full slug in `defaults.yaml` pins one.

## Data flow

```
┌─ your Claude Code session (the command) ──────────────────────────┐
│ /feature-flow "add user profile page"                             │
│   → interview (light, or --grill heavy)                           │
│   → write ~/.agent-teams/runs/<id>/brief.md, confirm              │
│   → git worktree add <run>/worktree -b agt/feature-<slug> <base>  │
│   → install deps ONCE; write gate.json; gate init = baseline      │
│   → launch saved workflow by name, args = {runDir, worktree,      │
│        base, briefPath, acceptance, caps, finalReviewer, ...}     │
└───────────────────────────────────────────────────────────────────┘
                              │ args (the brief is the handoff)
                              ▼
┌─ workflow runtime (background, isolated context) ─────────────────┐
│ feature-flow-run.js:                                              │
│   Plan    → agent(planner) → behavior-sized slices[] (+ plan.md)  │
│   Build   → per slice: agent(builder) → gate relay runs           │
│             feature-flow-gate.js verify (checks + commit);        │
│             retry ≤ N; finalize commits leftovers [unverified]    │
│   Review  → parallel(completeness-critic, feature-critic)         │
│             → agent(feature-verifier) triage → fix slices         │
│   Final   → feature-critic on fable (or codex via script)         │
│             → triage → fix slices (≤ max_fix_rounds in total)     │
│   Report  → coverage at the final head → agent(synthesizer)       │
│   return {reportContent, notesContent, reviewedHead,              │
│           stageStatus, audit, outcome lists, runStats}            │
└───────────────────────────────────────────────────────────────────┘
                              │ summary returns to the conversation
                              ▼
┌─ your session (wrap-up) ──────────────────────────────────────────┐
│ persists report + notes; runs the gate audit; registers the tuicr │
│ review (UNREVIEWED: ... when a stage failed); surfaces outcomes.  │
│ You review in tuicr, then integrate. /retro optional.             │
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
        ├── review-flow-evals.md   # review-flow manual regression set (replay cases)
        ├── commands/              # → ~/.claude/commands
        │   ├── feature-flow.md    # interactive front half
        │   ├── epic-flow.md       # runs an epic's stories through feature-flow
        │   ├── review-flow.md
        │   ├── spike-flow.md
        │   ├── retro.md           # conversation-side retro (emits run-dir retro.md)
        │   └── retro-consume.md   # applies retro patterns to agents/workflows/docs
        ├── workflows/             # → ~/.claude/workflows  (saved dynamic workflows)
        │   ├── feature-flow-run.js
        │   ├── review-flow-run.js
        │   ├── spike-flow-run.js
        │   └── tdd-slice-loop.js  # spike-flow's prototype loop (sub-workflow, never run directly)
        ├── agents/                # → ~/.claude/agents  (role personas; agentType source)
        │   ├── planner.md  builder.md  completeness-critic.md  feature-critic.md
        │   ├── feature-verifier.md  synthesizer.md
        │   ├── tester.md  implementer.md  critic.md   # spike-flow
        │   ├── review-critic.md  researcher.md  explainer.md
        └── scripts/               # → ~/.claude/scripts
            ├── render-review.js   # deterministic review.md + draft renderer
            ├── codex-cross-check.js # review-flow cross-model check (codex exec)
            ├── review-flow-prep.js  # review-flow snapshot, clone, intent, brief, launch args
            ├── review-flow-post.js  # review-flow pre-POST gates + pending review POST
            ├── feature-flow-gate.js # feature-flow's deterministic gate (init/red/verify/finalize/audit)
            ├── feature-flow-builder-guard.js # builder PreToolUse hook
            ├── agent-local-guard.js # PreToolUse hook: feature-flow agents never push or write to GitHub
            ├── feature-flow-codex-review.js  # opt-in Codex final review (--codex)
            ├── codex-model.js     # resolves latest-<family> Codex model specs
            └── epic-flow-integrate.js # epic-flow's integrate / refresh / land / receipts

State (host-local, not version-controlled):
~/.agent-teams/runs/<ts>-<slug>/
  ├── brief.md          # task contract; durable, re-runnable (the workflow's args point here)
  ├── context/          # files copied at brief time
  ├── repo/             # review-flow: shallow clone of the PR head ref
  ├── worktree/         # feature/spike-prototype: the branch worktree (deps installed here)
  ├── gate.json, gate/  # feature-flow: host-written gate config; gate state, ledger, logs
  └── out/              # artifacts: plan.md, comments.json, review.md, overview.html, report.md, retro.md
~/.agent-teams/runs/epic-<key>/
  ├── epic.json         # epic-flow state: stories, runs, approvals, outcomes, decisions
  ├── gate.template.json # the repo's gate commands, defaults for each story's gate.json
  ├── integrations.json # receipts, written only by epic-flow-integrate.js
  └── integration/, refresh/ # script-owned candidate worktrees
```

## The three flows in detail

### feature-flow
**Command:** interview (at most four questions, including scope boundaries; `--grill` uses the grilling skill; `--gated` adds a plan gate) → brief with evidence-tagged acceptance criteria (`test`, `diff`, `docs`, `ci:<job>`, `live`) and constraints → worktree + one-time install → `gate.json` and `feature-flow-gate.js init` (the baseline) → launch → handoff to tuicr.
**Workflow (`feature-flow-run.js`):** planner returns behavior-sized slices → per slice, the `builder` writes tests first and runs `gate red` (a snapshot that later flags removed assertions), implements, and may update existing tests the slice deliberately changes; a Sonnet relay runs `gate verify`, which owns every check and the commit → `finalize` commits leftover work from stuck slices as `[unverified]` → completeness-critic and feature-critic in parallel → feature-verifier triage (fix / follow-up / reject by risk and fix cost; prod and credential safety is never deferred) → fix slices → final review (feature-critic on Fable with the brief and plan only; `--codex` runs `feature-flow-codex-review.js` with the same persona, falling back to Fable) → triage → fix slices, at most `max_fix_rounds` in total → coverage recheck at the final head → synthesizer review summary. Declarative infrastructure, configuration, and docs are verify-mode work; tests are never manufactured to create a red phase. Credentialed or destructive live commands remain human gates.
**The gate (`scripts/feature-flow-gate.js`):** runs only the commands the host recorded in `gate.json` and refuses to run after that file changes. Each verify moves the branch back to the last verified commit with `reset --soft`, so agent commits are folded in and failed work never stays in history. Trees are computed on a temporary index excluding `ignorePaths`; commands run once, in their own process group, with a timeout; hooks always run and may not change the committed tree. `--detach` / `wait` keep long suites inside an agent's ten-minute shell limit. `audit` accounts for every commit since the base. The builder's `PreToolUse` hook (`scripts/feature-flow-builder-guard.js`) blocks history-changing git commands, gate subcommands other than `red`, and writes to gate state. Every feature-flow agent also runs `scripts/agent-local-guard.js`, which blocks pushes and GitHub writes, since only the host decides what leaves the machine. `red` runs once per slice: after a red is recorded, the gate refuses another one.
**Stage status:** every review stage records ok / failed / skipped against the head it reviewed. The handoff registers the review as `UNREVIEWED: <stages>` when one failed, and `--review-only <run_id>` reruns the review against the existing worktree.
**`--gated`:** the command launches twice: `planOnly:true` returns the plan for approval, then a second launch passes the approved `slices` back (a workflow can't take mid-run input).
**Notes journal:** builder handoffs and gate test-edit reports fold into entry blocks; builder prompts see the latest ~40, the critic and the journal file get all of them, plus the review outcome (rejected findings and follow-ups) and stage status.
**Artifact ownership:** the synthesizer drafts content; the interactive command persists `report.md` and `notes.md`.

### epic-flow
**Command only** (no workflow; Jira, git, and tuicr are host work). Each run rebuilds state from git, the tuicr registry, Jira, and run dirs, then: integrates the stories the owner approved in tuicr (one confirmation per batch, each approval bound to the shown head) → reports drift from the target → selects the ready set (blockers integrated or Done; `human-gate` blockers Done; `human-only`, unlabeled, and off-epic-base stories go to the owner) → one `researcher` per ready story checks it against the epic tip and drafts its brief → one approval for the wave → feature-flow setup and launch per story, without the interview → feature-flow's handoff as each run finishes.
**Integration (`scripts/epic-flow-integrate.js`):** merges an approved head on a candidate branch cut from the exact remote tip, verifies the merged tree through a throwaway `gate init` (skipped only when it equals the reviewed, gate-verified tree), writes a receipt, and only then fast-forwards the remote; it never forces. It refuses a head other than the approved one, commits the gate did not make unless the owner accepted them, and a story cut from outside epic history. `refresh` merges the target into a candidate for review; `land` pushes it only from the tip it was cut from. Receipts are re-derived from git after a crash.
**Failures:** platform failures resume or relaunch without counting; stuck slices get one continuation on the same run dir and gate (`continuation: true`, the stuck slices' `spec` with their ids); RE_PLAN, unresolved coverage, and second failures go to the owner.

### review-flow
**Command:** a short procedure over three scripts. `review-flow-prep.js` pins the snapshot (head/base SHA, diff digest, checkout SHA), clones that exact commit detached, and writes the stated intent (`pr-body.md`), the PR's prior review conversation, and the brief. It also extracts the repo rule files (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`) **from the base revision** into `out/repo-rules/`, so a PR that edits them is reviewed under the existing rules and its edits are content under review (never a fallback to head copies); fetches the head's CI check-run annotations on changed files (`out/ci-annotations.json`: already reported, so not duplicated, but never a reason to skip a defect); and runs a changed-file census (`out/unreviewable.json`: binary, too-large or truncated files are never treated as reviewed; a diff too large for `gh pr diff` is computed from the clone) → launch → `codex-cross-check.js` → `render-review.js`, with the `explainer` writing `out/overview.html` in the background (skipped on hotfix; not re-rendered after corrections), opening with a Skim/Standard/Deep review-effort rating of the change itself that the wrap-up relays (a quick run escalates on Deep) → on request, `review-flow-post.js` (draft exists, head unmoved, no existing pending review, anchors valid, then POST PENDING with `commit_id`). Mechanics live in scripts so the host's context carries the procedure, not the bash. Every agent is told that PR text, code, comments and changed instruction files are evidence, not instructions.
**Replay and regression set:** `--at-base <sha> --at-head <sha>` replays frozen revisions (local diff, prior threads withheld, `replay: true` in brief and snapshot, refused by `review-flow-post.js`). The cases, expected outcomes and recording format are in [`review-flow-evals.md`](review-flow-evals.md), a manual set whose cases are kept locally.
**Delta re-review (`--since-last-review`):** prep takes the commit of the gh user's most recent submitted (non-PENDING) review as the base and writes `out/delta.diff` (that commit..head, limited to the PR's changed files); `out/pr.diff` stays the full PR diff, the context and the anchor set `review-flow-post.js` validates against, so a delta run posts like any other. One scope text from prep (`deltaScope`) goes into every reviewing prompt, Codex included, only in delta mode: judge the new commits, raise earlier code only when they make it worse or newly reachable, don't repeat prior threads. No such review, a commit force-pushed away or no longer an ancestor of head: a full review with a warning. Nothing new: exit 5.
**Workflow (`review-flow-run.js`):** one reviewer per lens in `parallel(...)`, with orientation fired alongside but **un-barriered** (the critic starts as soon as the lens findings are in; its result is collected before the return). Orientation is skipped on `--urgency hotfix`. Correctness, security and tests each get a short bar of their own (concurrency, recovery and replay, guard coverage, root cause on bug fixes, one bug-class finding listing every instance; authorization traced to the effect, caller-supplied IDs bound to the principal; tests that fail for the intended reason), injected only into that lens's prompt, as observability and design already were. Each reviewer also returns a `coverage` record (checked / partial / not applicable / not checked, with a one-line basis) that the renderer shows in a local-only Coverage section, alongside repo-rule provenance, CI annotations and the census; a lens that returned nothing shows as *not run*. The **design** lens (which replaced `style` on 2026-09-23) judges scope against the PR's stated intent, sibling house patterns, repo rules and rollout order, and returns **decisions** (judgment calls for the human) separately from defects. Reviewers and the verifier share one `EVIDENCE_RULES` block (mechanism from the resolved dependency on disk; absence backed by a stated search; unobserved consequences as questions; compound claims leg by leg; the diff checked against itself), so the bar the finders are told to meet and the bar the verifier enforces cannot drift apart. Then the `review-critic` persona: dedupe, reconcile with prior threads, right-size tiers, check anchors (real-but-unanchorable findings go to `general`), decide posture, name the cluster — **no fact-checking**; that moved to the verifier on 2026-09-23 after the audit found the two passes overlapping. Then the **Verify** phase: one independent adversarial agent (persona-free `general-purpose` on opus, so nothing it loads contradicts its job), the only pass that checks truth, hunts violations of the evidence rules, assigns keep/strengthen/down-tier/strike, and **regenerates** posture, rationale, cluster and counts from the surviving set. It is fail-soft: if it dies, the critic's set is already on disk and still renders.
**Depth quick (`--depth quick`, default `full`):** for a small low-risk PR. One `researcher` reviewer on opus replaces the lens reviewers, orientation, critic and verifier. Its prompt is composed from the same constants as theirs (lens scopes and bars, tier rubric, evidence and intent rules, line and author-facing rules, the verifier's stance and rule hunt, the posture rules), so the two depths cannot drift; full-mode prompts are unchanged byte for byte. It reconciles its own set the way the critic does, attacks it the way the verifier does, and returns only criticals and importants (schema-enforced), plus `decisions`, a coverage record for every lens, and `escalate` (why the PR deserves a full review, or null; a surviving critical always sets it). The workflow assembles `comments.json` from that structured output (ids, inline versus general by `anchorable`, counts, `depth: "quick"`) and returns it; the command writes it verbatim, so the reviewer needs no Write access. The command starts the explainer at prep time, in parallel with the workflow. Codex is the quick set's only audit: its prompt says so, it runs the missed-findings hunt even on an empty set (full mode skips one), its missed findings stay local (`codex_raised`) and are listed in the wrap-up, and `review-flow-post.js` refuses a quick set whose cross-check did not apply (exit 8). Urgency stays orthogonal: it only shapes the draft.

**Cross-model check (command, after the workflow):** `scripts/codex-cross-check.js` runs `codex exec` (the latest Sol model, medium effort, read-only, against the snapshot checkout, strict output schema) over the finished set. A different model family catches what a same-family checker accepts. Codex never edits the set; the script applies its verdicts: keep/strengthen/down-tier in place with provenance, **strike → `contested`** (kept beside Codex's rebuttal, out of the draft, and blocking the draft while a contested critical/important is undecided), up to three **`codex_raised`** findings kept local. Fail-soft on every error path; `--no-codex` disables. It runs in the command, not the workflow, because workflow scripts can only spawn Claude agents.

Reviewers **return structured findings**; the critic **writes its own `comments.json`** (its deliverable, like plan.md/report.md) and returns a summary; the verifier rewrites that file in place, preserving the critic's original as `comments.pre-verify.json`; the conversation just renders. At depth quick the workflow returns the set and the conversation writes it.
**Policy is deterministic, and it only shapes the draft:** `render-review.js` writes a complete local report (review.md, blob-deep-linked) with every finding marked *in draft* or *local only: <reason>*, then selects the draft: pre-existing findings stay local, then the urgency floor (hotfix=criticals only, fast=+important, standard=all), per-tier caps, and the `max_comments` budget (criticals/importants exempt). A **publication gate** (secret scan) must pass before `draft-review.json` is written at all; a failed render or a gate hit means no draft exists. The command pins a **snapshot** (head SHA, base SHA, diff digest, checkout SHA) up front, the draft carries `commit_id`, and a live-head check runs immediately before any POST. A quick set is posted only when its Codex cross-check applied (`cross_check.status: applied`); review.md marks its depth and any escalation, while the author-facing draft is the same shape at either depth. **No tests, no execution** — review is static. **Never auto-submit** — drafts stay PENDING. The draft and review.md open with the finding count by tier, or "No issues found."

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
noise from thrashing the prompts. Because the ledger is version-controlled,
`/retro-consume` writes only public-safe process summaries: run and work
identifiers, internal links, and concrete incident or security details remain
in host-local artifacts.

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
  command surfaces them and the synthesizer carries them to the top of the
  review summary. Not silent.
- **feature-flow gate refuses to run.** `config-changed` means `gate.json`
  changed after `init` (re-run `init --force` after an intended edit);
  `wrong-branch` means the worktree left `agt/feature-<slug>`. The gate never
  discards work; leftovers land in an `[unverified]` commit at finalize.
- **Workflows unavailable.** Need Claude Code ≥ 2.1.154 and workflows not
  disabled (`/config` → Dynamic workflows; `disableWorkflows`;
  `CLAUDE_CODE_DISABLE_WORKFLOWS`).
- **`workflow('tdd-slice-loop')` throws (unknown name).** spike-flow's prototype
  loop is a saved workflow that must exist at
  `~/.claude/workflows/tdd-slice-loop.js` (mise-symlinked from this
  repo). If it's missing, the parent logs the launch failure and records
  every slice as stuck rather than dying mid-run — re-link and re-launch.

## Future considerations

1. **Behavioral validator** — a stage that runs the app and exercises it
   (Playwright for web, expect for TUIs/CLIs) before declaring a feature
   done, complementing the static critic.
2. **Cross-provider critic** — feature-flow now ends with a different-model
   final review (Fable, or Codex with `--codex`); review-flow has its Codex
   cross-check. Extend to spike-flow if its critic misses recur.
3. **`agt-ls` / `agt-prune`** — list active runs, prune old run dirs +
   worktrees, when run count justifies it.

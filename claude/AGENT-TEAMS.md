# Agent Teams — Architecture

Single source of truth for the agent-teams system in this dotfiles repo.
**Read this before editing anything under `claude/`.**

## What this is

A homegrown system for handing off recurring software-engineering tasks to a
team of Claude Code agents running in a sandboxed Docker container via
[`sbx`](https://docker.com/sbx).

Three flows supported:
- `/feature-flow` — implement a feature: plan → TDD inner loop → critic outer pass → PR-ready diff on a worktree branch.
- `/review-flow` — review an open PR: parallel reviewers across four lenses (security, correctness, style, tests) → critic synthesizes/caps comments → review document + optional pending review draft on GitHub.
- `/spike-flow` — investigate a question: researcher(s) → critic gap-analysis → optional in-repo prototype → spike report.

You trigger flows from host-side slash commands that draft a brief, confirm
with you, and spawn the sandbox in a new tmux window of the `agent-teams`
bullpen session. You jump to the bullpen with `prefix C-t`.

## Substrate: Agent Teams + subagents hybrid

Claude Code has two parallel-work mechanisms. We use **both**.

| Mechanism | Behavior | We use it for |
|---|---|---|
| **Subagents** (`Agent()` tool) | Helper invocations in the parent session's process. Each has its own context window but returns results to the parent. Sequential. | Sequential work, same-file edits, one-shot delegations |
| **Agent Teams** (experimental) | Separate Claude Code instances with own context windows. Direct teammate-to-teammate communication via mailbox. Shared task list. Split-pane display via tmux. | Parallel exploration with independent contexts |

**Per-flow mapping:**

| Flow | Phase | Mechanism | Why |
|---|---|---|---|
| feature-flow | Plan | Subagent (`planner`) | One-shot, sequential |
| | TDD inner loop | Subagents (`tester`, `implementer`) | Same files, fast iteration |
| | Critic outer pass | **Teammate** | Independent context = critic never sees inner transcripts by construction |
| | Synthesizer | Subagent | One-shot |
| review-flow | Reviewers (parallel) | **Teammates** (`reviewer-security`, `reviewer-correctness`, `reviewer-style`, `reviewer-tests`) | Canonical parallel-exploration use case |
| | Critic | **Teammate** | Synthesizes findings; independent context |
| | Synthesizer | Subagent | One-shot |
| spike-flow | Researchers (parallel angles, deep mode) | **Teammates** | Multiple hypotheses; can debate |
| | Critic | **Teammate** | Synthesizes consensus |
| | Prototype (if requested) | Subagents (TDD inner) | Same as feature-flow |
| | Synthesizer | Subagent | One-shot |

The Anthropic docs explicitly warn against Agent Teams for sequential,
same-file work — overhead and token cost dominate. They shine when teammates
work *independently*. Our split honors that.

**Per-role model assignment.** Roles are tuned to their cognitive load
via the `model:` frontmatter field in `.claude/agents/*.md`. Current
assignment:

| Role | Model | Why |
|---|---|---|
| planner | opus | Goal → slice decomposition; errors here compound through every later agent |
| critic | opus | Independent design review of final diff; catch rate matters more than throughput |
| tester | opus | Test design defines correctness for the slice; subtle behavioral framing |
| implementer | opus | Code fluency + tasteful minimal-fix discipline |
| researcher | opus | Read-heavy exploration with file:line citations; reasoning over volume |
| synthesizer | sonnet | Format existing artifacts into PR body / review doc / spike report — formatting task, no novel reasoning |

Aliases (not version pins) so the assignment rides forward with each
model release.

**Both modes use the same role prompts.** The kit's `.claude/agents/*.md`
files work dual-purpose: subagent definitions AND Agent Teams teammate
types. When spawning a teammate, the lead references the role by name; the
role's prompt body is appended to the teammate's system prompt.

**Caveat from the Agent Teams docs:** when a subagent definition runs as a
teammate, the `skills` and `mcpServers` frontmatter fields are **not**
applied. Any skills or MCP servers needed by teammates must live in the
kit's `.claude/skills/` and `.claude/mcp.json`.

## Data flow

```
┌─ host claude session ─────────────────────────────────────────────┐
│ user: /feature-flow "add user profile page"                       │
│   → host slash command (claude/commands/feature-flow.md):         │
│      1. interview user (light/heavy by task type)                 │
│      2. write brief to ~/.agent-teams/runs/<ts>-<slug>/brief.md   │
│      3. show brief, confirm                                       │
│      4. spawn sandbox in a new tmux window via the launcher:      │
│         tmux new-window -t agent-teams: -n <type>-<slug>-<HHMM> \ │
│           "~/.dotfiles/scripts/agent-teams-launch.sh \             │
│              agt-<type>-<slug> '/<flow> /work/brief.md' \         │
│              -- claude <repo> ~/.agent-teams/runs/<id> \          │
│                 --branch auto \                                   │
│                 --kit ~/.dotfiles/claude/agent-teams-kit"         │
│      (mount order varies by flow; see §sbx setup.)                │
│      Launcher = sbx create + settings.json overlay + sbx run.     │
│      /work is a startup-hook symlink to whichever mount has        │
│      brief.md.                                                    │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ sbx container (in tmux window) ──────────────────────────────────┐
│ Claude Code session (becomes the team LEAD)                       │
│   → in-sandbox lead briefing (.claude/commands/feature-flow.md)   │
│   → reads /work/brief.md                                          │
│   → reads /work/notes.md (created fresh, persisted across slices) │
│                                                                   │
│   plan phase:                                                     │
│      Agent() planner → slice plan committed to notes.md           │
│                                                                   │
│   per-slice TDD inner loop (subagents, ≤3 retries):              │
│      Agent() tester  (reads notes.md, writes ONE failing test,   │
│                      returns structured ### Handoff block)        │
│      Agent() implementer (reads notes.md, makes it pass,          │
│                      returns structured ### Handoff block)        │
│      Bash: run test suite → deterministic gate                    │
│      on green: implementer local refactor pass                    │
│      lead reads each Handoff, integrates notable items into       │
│        /work/notes.md (Issues/Undone/procedure slips, with reason)│
│                                                                   │
│   outer critic pass (TEAMMATE, parallel-capable):                 │
│      spawn `critic` teammate with role: prompt                    │
│      input: final diff + test summary + /work/notes.md            │
│        (notes is lead-curated, not raw transcripts)               │
│      output: APPROVE | FIX_LIST | RE_PLAN                         │
│      FIX_LIST items shaped as testable slices →                  │
│        route each through TDD inner loop (tester+implementer);    │
│        up to max_critic_revisions cycles (default 3)              │
│                                                                   │
│   synthesizer:                                                    │
│      Agent() synthesizer → /work/out/report.md (PR body)          │
│                                                                   │
│   artifacts in /work/out/ ⇒ visible at ~/.agent-teams/runs/<id>/  │
│   worktree branch on host ⇒ user reviews + merges                 │
└───────────────────────────────────────────────────────────────────┘
```

## File map

```
~/.dotfiles/
├── install.conf.yaml                          # dotbot — adds ~/.claude/commands symlink
└── claude/
    ├── AGENT-TEAMS.md                          # this file
    ├── hooks/                                  # existing Claude Code hooks (unrelated)
    ├── commands/                               # host-side slash commands (symlinked → ~/.claude/commands)
    │   ├── feature-flow.md                     # drafts brief, spawns sandbox
    │   ├── review-flow.md
    │   └── spike-flow.md
    └── agent-teams-kit/                        # the sbx kit (passed via --kit, applied into the sandbox home)
        ├── README.md                           # kit-internal mechanics
        ├── SETUP.md                            # one-time host setup commands
        ├── spec.yaml                           # sbx kit manifest (schemaVersion, kind, startup hook)
        ├── template/
        │   └── build.sh                        # builds `claude-team` sbx template (deferred)
        └── files/                              # kit payload; sbx delivers files/home/<path> to /home/agent/<path>
            └── home/
                └── .claude/                    # claude config delivered into the agent user's home
                    ├── settings.json           # enables Agent Teams, teammateMode: tmux
                    ├── defaults.yaml           # cap defaults (merged into brief at draft time)
                    ├── agents/                 # role definitions (dual-purpose: subagent + teammate type)
                    │   ├── researcher.md
                    │   ├── planner.md
                    │   ├── tester.md
                    │   ├── implementer.md
                    │   ├── critic.md
                    │   └── synthesizer.md
                    ├── commands/               # in-sandbox slash commands (lead briefings)
                    │   ├── feature-flow.md
                    │   ├── review-flow.md
                    │   └── spike-flow.md
                    ├── hooks/                  # TaskCompleted gates etc. (deferred)
                    └── skills/                 # any skills teammates need (kit-level so they load)

~/.dotfiles/scripts/
└── tmux-agent-teams.sh                         # bullpen launcher (idempotent)

~/.dotfiles/tmux.conf                           # add: bind-key C-t run-shell "..."

State (host-local, not version-controlled):
~/.agent-teams/runs/<ts>-<slug>/                 # per-run sidecar dir
  ├── brief.md                                  # task contract; durable, re-runnable
  ├── context/                                  # files copied at brief time
  └── out/                                      # synthesizer writes artifacts here
                                                # mounted into sandbox at /work/
~/.claude/teams/<team-name>/config.json          # Agent Teams runtime state (managed automatically)
~/.claude/tasks/<team-name>/                     # Agent Teams shared task list
```

## The three flows in detail

### feature-flow

**Input:** goal statement, optional context files, optional acceptance signal.

**Brief draft interview:** lightweight by default. Asks for target repo,
must-read context files, acceptance check. `--grill` for heavy interview on
hairy features. `--gated` to add explicit plan-approval gate before slices
run.

**In-sandbox execution:**
```
1. Lead reads /work/brief.md
2. Lead invokes planner subagent → slice plan
   (optional human gate via brief.config.plan_gate)
3. For each slice:
   a. tester subagent writes ONE failing test
   b. implementer subagent writes minimal code to pass
   c. Lead runs test suite (Bash)
   d. fail → implementer revises with error; retry ≤ 3
   e. green → implementer local refactor pass
   f. Lead updates /work/notes.md
4. After all slices green:
   spawn critic TEAMMATE
   input: final diff + test summary + /work/notes.md
   output: APPROVE | FIX_LIST | RE_PLAN
   FIX_LIST items are shaped as testable slices; each is routed
     back through the TDD inner loop (tester writes failing test
     → implementer makes pass → suite gate). Non-testable items
     (naming, dead code, doc fixes) route to implementer directly.
     After each revision cycle, re-spawn a fresh critic teammate.
     Cap: max_critic_revisions cycles (default 3); after the cap
     ship as-is and surface remaining findings in the PR body.
   RE_PLAN → escalate to user immediately
5. synthesizer subagent writes /work/out/report.md
   (intended as PR body)
```

**Output:**
- `~/.agent-teams/runs/<id>/out/report.md` — PR body
- Branch `agt/feature-<slug>` on the worktree, ready for review/merge

**Hard caps:** 3 retries per slice, 3 post-critic revision cycles
(default; configurable via brief `config:` block).

**Notes file pattern:** `/work/notes.md` is the single carrier of
inter-slice state. The tester and implementer subagents return a
structured `### Handoff` block (Completed / Undone / Commands+exit codes
/ Issues discovered / Procedures followed) at the end of their final
message; the lead reads each handoff and integrates notable items
(Issues, Undone, admitted procedure slips, helpers extracted, conventions
established) into `notes.md` with reasoning about why each is worth
carrying. The next slice's tester and implementer read `notes.md` to
inherit that context. The critic at the outer pass also sees `notes.md`
— it is a lead-curated artifact, not a transcript, so it preserves the
critic's fresh-context principle while giving it audit signal (skipped
tests, xfails, deferred TODOs).

**End-to-end coverage:** for any feature, the slice collection must
include at least one test that exercises the feature's primary
user-facing path end-to-end. Default placement: the final slice. The
lead's spawn prompt to the `tester` flags whether the current slice is
the final one so the tester can shape the test accordingly.

### review-flow

**Input:** PR number (and optionally repo).

**Brief draft interview:** skipped by default — PR number is enough context.

**In-sandbox execution:**
```
1. Lead reads /work/brief.md, fetches PR via gh
2. Lead spawns reviewer TEAMMATES in parallel:
     - reviewer-security
     - reviewer-correctness
     - reviewer-style
     - reviewer-tests
   Each teammate gets its lens-specific spawn prompt + the reviewer role
   definition. They each enumerate findings (aggressive, high-recall).
3. After all reviewers complete:
   spawn critic TEAMMATE
   input: all findings + project CLAUDE.md / CONTRIBUTING.md
   tasks: dedupe near-duplicates, recategorize tier mistakes,
          apply priority-protect cap
4. synthesizer subagent writes /work/out/review.md
   (tier sections, file:line refs)
5. If --prepare-draft: also writes /work/out/draft-review.json
   and POSTs PENDING review via:
     gh api repos/<owner>/<repo>/pulls/<num>/reviews \
       --method POST --input out/draft-review.json
```

**Output:**
- `~/.agent-teams/runs/<id>/out/review.md` — human-readable review
- Optional: PENDING review on the PR (visible only to user; submit via UI)

**Tier classification:**
- `critical` — bug, security issue, data correctness, broken contract. Never dropped.
- `important` — design smell, missed edge case, perf regression. Rarely dropped.
- `recommended` — readability, naming, structure, test gaps. Dropped first when over cap.
- `nit` — style, minor wording. Dropped most aggressively.

**Cap policy (priority-protect):** brief sets `max_comments` (default 20).
All `critical` + `important` always included even if total exceeds cap (with
overflow signal). Remaining budget fills with `recommended` ranked by
critic's confidence, then `nit`.

**Inline comment anchoring:** comments tagged at generation as `inline:`
(has `path` + `line` + `side`) or `body:` (no anchor). Inline comments must
point at lines actually in the fetched diff — unanchorable comments demote
to body.

**No tests, no execution.** Review is static. Reviewers don't try to
reproduce bugs locally. Run order: parallel reviewers → single critic round
→ synthesizer. You are the final pass.

### spike-flow

**Input:** question, optional context files, optional `--prototype` flag,
`--depth quick|deep`.

**Brief draft interview:** lightweight. Asks for context files, prototype
desire, depth.

**In-sandbox execution:**

`--depth quick` (no critic, single researcher):
```
1. Lead reads brief
2. researcher subagent → notes
3. synthesizer subagent → /work/out/report.md
```

`--depth deep` (default; multiple angles, debate, critic):
```
1. Lead reads brief
2. Lead spawns 2-3 researcher TEAMMATES with distinct angles:
     - "is X technically feasible given our stack?"
     - "what are the operational implications?"
     - "what does prior art say?"
   Teammates may debate (per Agent Teams "scientific debate" example).
3. critic TEAMMATE synthesizes consensus, flags gaps:
     output: APPROVE | FIX_LIST (researchers may revise once)
4. If brief.prototype: planner subagent → TDD inner loop
   scoped to experiments/<slug>/
5. synthesizer subagent writes /work/out/report.md
```

**Output:**
- `~/.agent-teams/runs/<id>/out/report.md` — spike report
- If prototyped: branch `agt/spike-<slug>` with code in `experiments/<slug>/`,
  plus report links to it

**Mount mode:** read-only by default (pure research). Brief `prototype: true`
flips to `--branch auto` writable worktree.

## Brief schema

The brief file is the runtime contract between you and the team. It lives
at `~/.agent-teams/runs/<ts>-<slug>/brief.md`. Same shape for all flows,
with a `type:` field.

```markdown
---
type: feature | review | spike
created: 2026-05-14T14:30:00Z
run_id: 2026-05-14-1430-user-profile
repo: /Users/nschott/dev/myapp
config:
  max_slice_retries: 3        # feature-flow only
  max_critic_revisions: 1
  plan_gate: false            # feature-flow only
  autonomy: auto              # auto | gated
  max_comments: 20            # review-flow only
  prototype: false            # spike-flow only
  depth: deep                 # spike-flow only
env:
  # project env vars sourced before any agent runs
  DATABASE_URL: postgres://localhost/myapp_test
setup_commands:
  # explicit override; otherwise auto-detected from project files
  - mise install
  - pnpm install
acceptance:                   # feature-flow only — explicit acceptance signal
  - "GET /profile/:id returns user profile JSON"
  - "all existing tests still pass"
context_files:
  - docs/data-model.md
  - app/lib/users.ts
---

# Goal

<free-form goal statement, plus anything else worth carrying into the team's
spawn prompt>
```

## Caps cascade

Three layers, lowest-priority first:

1. **Kit defaults** — `agent-teams-kit/.claude/defaults.yaml`. Shipped values.
2. **Brief overrides** — `brief.md` frontmatter `config:` block.
3. **Slash command flags** — `--max-retries 5`, `--gated`, `--max-comments 30`, etc.

Slash command flags are merged into the brief at draft time, *before*
confirmation, so the brief reflects the merged final state. Agents only ever
read the brief.

## Hooks (deferred to Phase 2)

Agent Teams exposes three hooks we plan to use:

| Hook | Use |
|---|---|
| `TaskCompleted` | TDD gate: exit code 2 if tests fail when implementer marks slice complete. Review gate: exit code 2 if criticals exceed cap silently. |
| `TaskCreated` | Validate task structure (must have file ownership for parallel work). |
| `TeammateIdle` | Feedback channel: if a researcher goes idle with un-explored brief items, nudge them back. |

Hooks live in `agent-teams-kit/.claude/hooks/`. Not implemented in Phase 1.

## sbx setup

**Mount strategy.** sbx uses direct-mount: workspace paths inside the
sandbox match their host paths exactly. The primary workspace must be
writable. The kit's `spec.yaml` declares a startup hook that scans
mounted virtiofs paths for `brief.md` and symlinks `/work` to the run
dir. This lets the in-sandbox lead briefings keep using `/work/brief.md`,
`/work/notes.md`, `/work/out/*.md` regardless of which workspace happens
to be primary for a given flow:

| Flow | Primary (writable) | Secondary |
|---|---|---|
| spike-flow (research) | run dir | repo `:ro` |
| spike-flow (`--prototype`) | repo + `--branch auto` worktree | run dir |
| feature-flow | repo + `--branch auto` worktree | run dir |
| review-flow | run dir | repo `:ro` (if local) |

**Launcher script.** Host slash commands spawn sandboxes via
`~/.dotfiles/scripts/agent-teams-launch.sh`, which does:

1. `sbx create` — creates the sandbox (if not already present), delivers
   kit files, runs the `/work` startup hook.
2. `sbx exec ... jq merge` — overlays our Agent Teams config
   (`env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `teammateMode: tmux`)
   onto `/home/agent/.claude/settings.json`. This is needed because sbx
   writes its own agent-template `settings.json` *after* kit files land
   and *after* startup hooks run, clobbering whatever the kit ships in
   `files/home/.claude/settings.json`. The patch is idempotent.
3. `sbx run` — attaches the inner claude session with the lead briefing
   slash command. After the session exits, the script `read`s so the
   tmux window stays around for the user to inspect final state.

This is why the kit's `files/home/.claude/settings.json` looks correct
but doesn't actually take effect — sbx wins. The launcher's overlay is
the seam that makes Agent Teams config land in the inner session.

**Inner-sandbox login.** SETUP.md previously claimed sbx handles
Anthropic auth automatically; it doesn't. The first time a sandbox name
appears, the inner claude session shows `Not logged in — Please run
/login` and won't execute the briefing. The user must attach to the
window, run `/login`, complete the OAuth flow in the browser, then
re-run the slash command. Auth persists in the sandbox filesystem until
the sandbox is removed (`sbx rm`), so re-running the same flow against
the same sandbox name skips re-auth. Each new sandbox name pays the
login cost once. See `agent-teams-kit/SETUP.md §Inner-sandbox login` for
the headless-friendly alternative via `sbx secret set -g anthropic`.

**Custom template (Phase 2):** `agent-teams-kit/template/build.sh` builds a
`claude-team` template that includes `mise`, `gh`, common runtimes
(node, python, go, rust). Falls back to default `claude` template until built.

**Secrets:** `sbx secret set <service>` is used for API tokens. Proxy
injects them on outbound requests; tokens never appear in transcripts.

```bash
sbx secret set -g github     # used by gh inside sandbox
sbx secret set -g anthropic  # optional; only if you have an API key and
                             # want to skip the interactive /login step
```

**Network policy:** currently allow-all (deferred hardening — see Future
Considerations). To switch to default-deny later:

```bash
sbx policy set-default deny
sbx policy allow api.github.com github.com objects.githubusercontent.com
sbx policy allow registry.npmjs.org registry.yarnpkg.com
sbx policy allow pypi.org files.pythonhosted.org
sbx policy allow proxy.golang.org sum.golang.org
sbx policy allow crates.io static.crates.io
```

## Tmux bullpen

All team runs are gathered in a single tmux session named `agent-teams`.
Each run is a window in that session. The session is created on first call;
subsequent calls switch to it.

- `prefix C-t` → run `~/.dotfiles/scripts/tmux-agent-teams.sh`
- Each new run = `tmux new-window -t agent-teams: -n <type>-<slug>-<HHMM>`
- `_overview` window watches `~/.agent-teams/runs/` for new dirs

Inside each window, the sandbox runs Claude Code as the Agent Teams lead.
With `teammateMode: "tmux"` in kit settings, teammates spawn into split
panes within that window — you see every parallel teammate at once and can
click into any pane to talk to a teammate directly.

## Where state lives

| What | Where | Persistence |
|---|---|---|
| Brief, context, artifacts | `~/.agent-teams/runs/<id>/` | Until `agt-prune` (manual) |
| Worktree branch | git on the target repo | Until `git worktree remove` (manual) |
| sbx container | Docker | Until `sbx rm` (manual) |
| Agent Teams config | `~/.claude/teams/<name>/config.json` inside sandbox | Managed by Claude Code |
| Agent Teams tasks | `~/.claude/tasks/<name>/` inside sandbox | Managed by Claude Code |
| Session logs | `~/.claude/projects/<...>/session.jsonl` inside sandbox | Until container is removed |
| Tmux windows | `agent-teams` session | Until tmux server restart or manual `tmux kill-window` |

## Future considerations

1. **Network hardening** — switch from allow-all to default-deny with
   explicit allowlist. See `sbx setup` above for the commands.
2. **Cowork migration** — when raw Claude API access (or Cowork access) is
   available, port the orchestrator to Cowork's hosted multi-agent runtime.
   Role markdowns port unchanged; in-sandbox lead briefings become Cowork
   team definitions. Brief schema stays stable.
3. **Auto-notify completion** — wire team-done event into existing
   `~/.dotfiles/claude/hooks/notify.sh` for macOS notification.
4. **`agt-ls` / `agt-prune`** — operational scripts for listing active runs
   and pruning old run dirs/containers. Build when run count justifies it.
5. **Status board in `_overview`** — richer than `watch ls`; per-run state,
   runtime, last orchestrator event.
6. **TaskCompleted hooks** — deterministic enforcement of TDD test gate and
   review cap policy.
7. **Notes-keeper subagent** — dedicated role for maintaining
   `/work/notes.md` if lead-maintained drifts in practice.
8. **Cross-run learning** — eventually critique notes from past runs could
   become a brief-time input ("when reviewing this kind of PR, you've
   previously flagged X"). Out of scope for now.
9. **Behavioral validator** — a second validator that actually runs the
   app and exercises it (headless browser via Playwright for web,
   expect-driven for TUIs/CLIs) before declaring a feature done.
   Today only the static critic runs at the outer pass and the e2e-final-
   slice tester rule is the compensating discipline. Worth revisiting if
   we start running multi-day autonomous missions where the human is no
   longer the "click around before merging" step. Pattern from Factory's
   missions: scrutiny validator (tests/types/lint/code review — already
   covered) plus user-testing validator (live app interaction — the gap).
10. **Cross-provider validation** — to address the structural concern
    that in-family critic+implementer share training distribution and
    can agree on wrong things, route the critic to a different provider
    when Claude Code supports it. Today's per-role model assignment
    captures most of the missions claim but not this part.

## Troubleshooting

**Inner claude shows `Not logged in — Please run /login`.** Expected on
first run against a new sandbox name. Attach to the window, run `/login`
in the claude REPL, complete OAuth in the browser, then re-run the slash
command (e.g., `/spike-flow /work/brief.md`). Auth persists in the
sandbox until `sbx rm`. See SETUP.md §Inner-sandbox login for the
API-key alternative.

**`/work` path missing inside sandbox.** The kit's startup hook scans
mounted virtiofs paths for `brief.md` and symlinks `/work` to that mount.
If the symlink isn't there, either no mounted workspace contains a
`brief.md` (check that the run dir got mounted), or the startup hook
failed (look at `sbx exec <name> -- cat /var/log/sbx-startup.log` if
that exists; otherwise re-create the sandbox to retrigger startup).

**Teammates not appearing.** Verify the launcher's settings-overlay
step ran — inside the sandbox, `cat /home/agent/.claude/settings.json`
should show `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` and
`"teammateMode": "tmux"`. If those are missing, the sandbox was
launched directly via `sbx run` instead of via
`~/.dotfiles/scripts/agent-teams-launch.sh` and the env var never got
applied — fix the spawn command, `sbx rm` the sandbox, and re-launch.
Verify Claude Code version is 2.1.32+. Try Shift+Down in in-process mode
to see hidden teammates.

**Tasks stuck in pending.** Agent Teams sometimes fails to mark tasks
complete. Tell the lead "nudge the teammate working on task X" or manually
update task status.

**Orphaned tmux sessions.** `tmux ls` and `tmux kill-session -t <name>` for
any leaked `agt-*` sessions.

**Sandbox can't reach the network.** Check `sbx policy ls`. If you've
hardened past the v1 allow-all default, your service may not be in the
allowlist.

**`gh` auth fails inside sandbox.** Run `sbx secret set github` on the host
and re-spawn. Token is proxy-injected.

**Test runner can't find tooling.** Until the custom `claude-team` template
ships (Phase 2), the kit falls back to default sbx claude image. Add a
`setup_commands:` block to the brief to install what's needed.

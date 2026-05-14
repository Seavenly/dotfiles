# Agent Teams — Implementation Plan

Build roadmap for the agent-teams system. This file is the temporal build
checklist; see `AGENT-TEAMS.md` for the durable architecture documentation.

Delete this file once the build is complete and the system has been used in
anger at least once.

## Goal

A homegrown "agent teams" system layered on Claude Code + Agent Teams +
Docker sbx sandboxes, triggered by host-side slash commands, observable in a
dedicated tmux session, version-controlled in this dotfiles repo.

Three flows:
- `/feature-flow` — plan → TDD inner loop → critic outer pass → PR-ready diff
- `/review-flow` — parallel PR reviewers (security/correctness/style/tests) → critic → review doc + optional draft on GitHub
- `/spike-flow` — researcher(s) → critic → optional prototype → spike report

## Build order

The order is chosen so each step produces something runnable end-to-end as
soon as possible, even before later steps land.

### Phase 1 — Foundations (this branch)

1. **AGENT-TEAMS.md** — durable architecture doc. Written early so it stays
   the single source of truth as we build.
2. **install.conf.yaml** — add `~/.claude/commands: claude/commands` symlink.
   No-op until host commands exist; safe to land first.
3. **Kit skeleton** — `agent-teams-kit/{README.md, SETUP.md, .claude/settings.json, .claude/defaults.yaml}`.
   `settings.json` enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and
   `teammateMode: "tmux"`. `defaults.yaml` defines cap defaults.
4. **Role agent prompts** — six files in `agent-teams-kit/.claude/agents/`:
   `researcher`, `planner`, `tester`, `implementer`, `critic`, `synthesizer`.
   Each works dual-purpose: subagent definition AND Agent Teams teammate type.
5. **In-sandbox lead briefings** — three files in `agent-teams-kit/.claude/commands/`:
   `feature-flow.md`, `review-flow.md`, `spike-flow.md`. These are the
   "lead briefings" — natural-language instructions to the Claude session
   that becomes the team lead inside the sandbox.
6. **Host slash commands** — three files in `claude/commands/`:
   `feature-flow.md`, `review-flow.md`, `spike-flow.md`. Each drafts a
   brief in the host session, confirms with the user, then launches sbx.
7. **`tmux-agent-teams.sh`** — bullpen launcher. Idempotent: creates the
   `agent-teams` tmux session on first call, switches to it.
8. **`tmux.conf` binding** — `bind-key C-t run-shell "..."`.

After Phase 1: the system can be exercised manually. Run `./install` to
symlink the host commands, run any of the three host slash commands inside a
host Claude session, and it should work (assuming sbx, gh, and other
prerequisites are configured per `SETUP.md`).

### Phase 2 — Operational polish (separate work, after Phase 1 is used)

9. **Custom sbx template (`claude-team`)** — `agent-teams-kit/template/build.sh`
   that builds a sandbox image with `mise`, `gh`, common runtimes pre-installed.
   Until this exists, the kit falls back to sbx's default `claude` template and
   pays a per-task install penalty.
10. **TaskCompleted hook** — `agent-teams-kit/.claude/hooks/` enforcing the TDD
    inner-loop gate (test must pass before slice marked complete) and the
    review cap policy (no submission until cap-overflow check).
11. **`agt-prune` and `agt-ls`** — operational scripts for managing run dirs
    and listing active runs. YAGNI for v1, build when run count justifies it.

### Phase 3 — Future hardening (deferred — see AGENT-TEAMS.md §Future)

- Switch `sbx policy set-default deny` with explicit allowlist.
- Auto-notify completion via existing `claude/hooks/notify.sh`.
- Cowork migration path when API access available.
- Status board in the `_overview` tmux window.

## File-by-file checklist

```
[1] ~/.dotfiles/claude/IMPLEMENTATION-PLAN.md    ← this file
[ ] ~/.dotfiles/claude/AGENT-TEAMS.md
[ ] ~/.dotfiles/install.conf.yaml                ← add one link entry

Kit (mounted via sbx --kit):
[ ] ~/.dotfiles/claude/agent-teams-kit/README.md
[ ] ~/.dotfiles/claude/agent-teams-kit/SETUP.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/settings.json
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/defaults.yaml
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/agents/researcher.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/agents/planner.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/agents/tester.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/agents/implementer.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/agents/critic.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/agents/synthesizer.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/commands/feature-flow.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/commands/review-flow.md
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/commands/spike-flow.md

Host (symlinked via dotbot):
[ ] ~/.dotfiles/claude/commands/feature-flow.md
[ ] ~/.dotfiles/claude/commands/review-flow.md
[ ] ~/.dotfiles/claude/commands/spike-flow.md

Tmux integration:
[ ] ~/.dotfiles/scripts/tmux-agent-teams.sh
[ ] ~/.dotfiles/tmux.conf                        ← add bind-key C-t

Deferred (Phase 2/3):
[ ] ~/.dotfiles/claude/agent-teams-kit/.claude/hooks/        ← TaskCompleted gates
[ ] ~/.dotfiles/claude/agent-teams-kit/template/build.sh     ← custom sbx template
[ ] ~/.dotfiles/scripts/agt-prune
[ ] ~/.dotfiles/scripts/agt-ls
```

## Key design constraints (cross-reference AGENT-TEAMS.md for rationale)

- **Critic never sees inner-loop transcripts.** Enforced by-construction:
  the critic is an Agent Teams teammate with its own context window, given
  only the final diff and test list.
- **Tests are the only judge of TDD inner loop.** No LLM critic inside the
  per-slice loop. Test pass/fail is deterministic.
- **Hard caps everywhere.** Per-slice retries (3), post-critic revisions
  (1), review comment count (configurable, default 20 with priority-protect).
- **No auto-submit, no auto-push.** Worktrees are fresh per run; PR review
  draft is created as PENDING, never submitted.
- **Brief is the single source of truth at runtime.** Slash command flags
  and kit defaults merge into the brief at draft time; agents only read the
  brief.

## Validation before declaring done

- [ ] Run `/spike-flow "is X library suitable for Y?"` end-to-end.
      Verify: brief drafted, sandbox spawned, researcher runs, report lands
      in `~/.agent-teams/runs/.../out/report.md`.
- [ ] Run `/review-flow <PR-number>` end-to-end. Verify: parallel reviewers
      spawn, critic synthesizes, `review.md` produced, `--prepare-draft`
      creates a pending review on GitHub.
- [ ] Run `/feature-flow "<small feature>"` end-to-end. Verify: plan
      drafted, TDD loop runs on at least one slice, critic gives verdict,
      synthesizer writes PR body.
- [ ] `prefix C-t` jumps to the `agent-teams` tmux session.
- [ ] Re-running `./install` is idempotent and creates the symlinks.

## Notes & known unknowns

- **Agent Teams is experimental.** If it's unstable for any flow, fall back
  to subagent-only orchestration for that flow. The kit's role agents are
  written to work in both modes, so the fallback is a flow-doc edit, not a
  rewrite.
- **`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` requires Claude Code v2.1.32+.**
  SETUP.md notes this.
- **Skills and MCP from subagent frontmatter don't apply to teammates.**
  Keep skills/MCP for role agents at kit-level `.claude/skills/` and
  `.claude/mcp.json` so they load in teammate sessions.

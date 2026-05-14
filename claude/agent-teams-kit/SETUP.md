# One-time host setup

Steps required on a fresh machine before the agent-teams system works.
Re-running any of these is safe.

## Prerequisites

- Claude Code **v2.1.32 or later** (Agent Teams requires this).
  ```bash
  claude --version
  ```
- `sbx` (Docker Sandboxes) installed and authenticated.
  ```bash
  sbx version
  sbx diagnose
  ```
- `gh` (GitHub CLI) on the host (used by host-side draft step for review-flow).
- `tmux` (already in use per `tmux.conf`).

## 1. Symlink host slash commands

Run dotbot to apply the symlink added to `install.conf.yaml`:

```bash
cd ~/.dotfiles
./install
```

This creates `~/.claude/commands` → `~/.dotfiles/claude/commands` so the
host slash commands (`/feature-flow`, `/review-flow`, `/spike-flow`) are
visible to any Claude Code session.

## 2. Add the tmux binding

After running `./install`, ensure your tmux session has the new binding by
reloading config:

```
prefix C-r
```

Or restart tmux. The `prefix C-t` binding should now jump to the
`agent-teams` session (created on first press if missing).

## 3. Store secrets in sbx

`sbx` injects API tokens on outbound requests via its proxy — agents
inside the sandbox never see the raw token in their transcripts.

```bash
sbx secret set -g github     # GitHub PAT with repo scope
                             # used by gh inside the sandbox for review-flow
```

Verify:

```bash
sbx secret ls
```

## 4. Inner-sandbox login

**This is not automatic.** Each new sandbox name spawns a fresh inner
Claude Code session that is not authenticated. The first time a flow
spawns a sandbox with a new name, the lead session shows
`Not logged in — Please run /login` and the briefing doesn't execute.

### Subscription-based path (default)

After the host slash command spawns the window:

1. Attach to the new tmux window:
   ```
   tmux switch-client -t agent-teams:<window-name>
   ```
   or `prefix C-t` then pick the window.
2. Inside the claude REPL, run `/login`. Complete the OAuth flow in
   your browser (uses your Claude Code subscription; no API key needed).
3. Once authed, re-run the briefing:
   ```
   /spike-flow /work/brief.md
   ```
   (or `/feature-flow /work/brief.md`, `/review-flow /work/brief.md`).

Auth persists in the sandbox's filesystem until you `sbx rm` it. Reusing
the same sandbox name on a later run skips this step. Each *new*
sandbox name (each new spike/feature/review slug) pays the login cost
once.

### API-key path (skips interactive login)

If you have an Anthropic API key, store it globally and the proxy injects
it into every sandbox. No `/login` ever needed:

```bash
echo "$ANTHROPIC_API_KEY" | sbx secret set -g anthropic
```

This is the headless-friendly path. Only useful if you actually have a
raw API key — Claude Code subscriptions are OAuth-only and don't expose
one.

## 5. (Phase 2 — deferred) Build the custom `claude-team` sbx template

Until this is built, the kit falls back to sbx's default `claude` template
and pays a per-task install penalty for tooling (`mise`, `gh`, runtimes).
The fall-back works; the custom template is purely an optimization.

```bash
~/.dotfiles/claude/agent-teams-kit/template/build.sh
```

(Build script lands in Phase 2.)

## 6. (Optional — future hardening) Tighten network policy

The kit currently runs with default-allow networking. To switch to
default-deny with an explicit allowlist:

```bash
sbx policy set-default deny
sbx policy allow api.github.com github.com objects.githubusercontent.com
sbx policy allow registry.npmjs.org registry.yarnpkg.com
sbx policy allow pypi.org files.pythonhosted.org
sbx policy allow proxy.golang.org sum.golang.org
sbx policy allow crates.io static.crates.io
```

See `AGENT-TEAMS.md §Future considerations` for context.

## Verify the install

In any Claude Code session:

```
/feature-flow help
```

Should surface the host-side slash command. If not, check:

- `ls -la ~/.claude/commands` — should be a symlink to
  `~/.dotfiles/claude/commands`.
- Claude Code may need to be restarted to pick up new slash commands.

A minimal smoke test:

```
/spike-flow "what's our current test command?"
```

This should: draft a tiny brief, confirm with you, spawn an sbx in the
`agent-teams` tmux session, run a quick researcher, write a report at
`~/.agent-teams/runs/<id>/out/report.md`.

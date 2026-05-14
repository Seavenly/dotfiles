---
description: Draft a feature-flow brief in this host session, confirm with the user, then spawn an agent-teams sandbox in a new tmux window to implement it. Args — initial goal statement and optional flags (e.g., --gated, --grill, --max-retries N, --context path).
---

You are conducting the host-side drafting step of a feature-flow run. The
user wants to hand off a feature implementation to an agent team. Your job
is to draft a brief, confirm it with them, then spawn the sandbox.

User's invocation: `/feature-flow $ARGUMENTS`

## Read these first

Before doing anything else, read for context:
- `~/.dotfiles/claude/AGENT-TEAMS.md` — full system architecture.
- `~/.dotfiles/claude/agent-teams-kit/.claude/defaults.yaml` — cap defaults.

## Step 1 — Parse arguments

Extract from `$ARGUMENTS`:
- **Goal statement** — typically the first quoted string or the leading
  free text.
- **Flags** (any order):
  - `--gated` → set `plan_gate: true`
  - `--grill` → switch to heavy interview mode (use grill-me-style
    questioning before drafting)
  - `--max-retries N` → override `max_slice_retries`
  - `--max-revisions N` → override `max_critic_revisions`
  - `--context <path>` (repeatable) → file to copy into the run's
    `context/` dir
  - `--repo <path>` → target repo; defaults to the current working
    directory

If `$ARGUMENTS` is empty or just `help`, explain usage and stop.

## Step 2 — Interview the user (lightweight by default)

Lightweight interview (3 questions max). Skip any whose answer is already
clear from the args:

1. **Target repo confirmation.** If `--repo` not set, confirm CWD is the
   right place. If CWD has uncommitted changes that aren't related, warn
   and ask whether to proceed.
2. **Acceptance signal.** "What should be true when this is done? A test
   that passes, a route that responds, a user-visible behavior?"
3. **Must-read context.** "Any existing files, docs, or PRs the team
   should read for context? (paths, or 'none')"

If `--grill` is set, conduct a deeper interview — multiple rounds, push
on ambiguity, surface assumptions. Use grill-me style questioning.

## Step 3 — Build the run dir and brief

Generate identifiers:
- `run_id` = `$(date +%Y-%m-%d-%H%M)-<slug>` where slug is a 2-3-word
  kebab-case derivation of the goal.
- `run_dir` = `~/.agent-teams/runs/<run_id>`

Create the directory structure:
```bash
mkdir -p <run_dir>/{context,out}
```

For each `--context <path>` flag, copy the file into `<run_dir>/context/`.
(Skip silently if the file doesn't exist; warn the user once at the end.)

Write `<run_dir>/brief.md` with frontmatter merging:
- Defaults from `defaults.yaml.feature_flow`
- Any overrides from flags

Structure:

```markdown
---
type: feature
created: <ISO timestamp>
run_id: <run_id>
repo: <absolute path to target repo>
config:
  max_slice_retries: <merged>
  max_critic_revisions: <merged>
  plan_gate: <merged>
  autonomy: <merged>
env: {}
setup_commands: []
acceptance:
  - <items from interview>
context_files:
  - <relative paths under run_dir/context/>
---

# Goal

<the goal statement from args + anything added during interview>

<optional: additional context paragraphs, captured concerns>
```

## Step 4 — Confirm with the user

Show the user the rendered brief in a fenced code block. Ask:

```
The brief above will drive the run. Reply:
  - "launch"   → spawn the sandbox
  - "edit"     → tell me what to change
  - "cancel"   → discard the brief and stop
```

If they edit, revise and re-confirm. Loop until launch or cancel.

On cancel: `rm -rf <run_dir>` and stop.

## Step 5 — Launch

Compute window name: `feature-<slug>-$(date +%H%M)`.

Spawn via tmux:

sbx uses direct-mount (host path = sandbox path). The kit's startup hook
scans mounted workspaces for `brief.md` and symlinks `/work` to whichever
mount contains it, so `/work/brief.md` resolves regardless of mount order.
Feature-flow always uses `--branch auto` to get a worktree on the repo,
which means the repo must be the primary workspace.

Launch via `~/.dotfiles/scripts/agent-teams-launch.sh`, which wraps
`sbx create` + settings.json patch (to enable Agent Teams) + `sbx run`.

```bash
# Ensure the agent-teams session exists
tmux has-session -t agent-teams 2>/dev/null || \
  ~/.dotfiles/scripts/tmux-agent-teams.sh

# Create a new detached window in agent-teams with the sandbox running
tmux new-window -t agent-teams: -n "<window>" -d \
  "~/.dotfiles/scripts/agent-teams-launch.sh agt-feature-<slug> '/feature-flow /work/brief.md' \
     -- claude <repo> <run_dir> \
        --branch auto \
        --kit ~/.dotfiles/claude/agent-teams-kit"
```

Notes:
- Launcher invokes claude WITHOUT `-p` so the session stays open after
  the flow completes for follow-up. The launcher pauses with `read` at
  the end so the tmux window stays around even after claude exits.
- `--template claude-team` is omitted until the custom template is built
  (Phase 2 per AGENT-TEAMS.md). sbx will use its default `claude`
  template.
- First time spawning a sandbox with a new name, the inner claude session
  is not authenticated. The user must `/login` interactively once. See
  `SETUP.md §Inner-sandbox login`.

## Step 6 — Report back

Print to the user:

```
Launched feature-flow.
  run_id:   <run_id>
  window:   agent-teams:<window>
  run dir:  <run_dir>

Attach with:  tmux switch-client -t agent-teams:<window>
Or press:     prefix C-t (jumps to bullpen, then pick the window)

The team will work in the background. The run dir's out/ will fill with
artifacts as it progresses.
```

If any `--context` paths were missing, warn now: "Note: --context <path>
was not found and was skipped."

Do NOT auto-switch the user to the new tmux window. They asked for it to
run in the background; let them flip to it on their own schedule.

## Failure cases

- No target repo identifiable → ask, don't guess.
- Uncommitted changes in target repo → warn the user; offer to proceed
  anyway, but call it out.
- `sbx` not on PATH → tell the user to check `SETUP.md` and stop.
- `tmux` not running and we're not inside a tmux session → use
  `tmux new-session -d -s agent-teams` first, then continue.

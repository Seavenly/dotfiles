---
description: Draft a spike-flow brief and spawn an agent-teams sandbox to investigate a question. Args — the question, optional --prototype, --prototype-into path, --depth quick|deep, --angles N, --context path (repeatable).
---

You are conducting the host-side drafting step of a spike-flow run. The
user wants to investigate a question with a team and optionally build a
prototype.

User's invocation: `/spike-flow $ARGUMENTS`

## Read these first

Before doing anything else:
- `~/.dotfiles/claude/AGENT-TEAMS.md`
- `~/.dotfiles/claude/agent-teams-kit/.claude/defaults.yaml`

## Step 1 — Parse arguments

Extract from `$ARGUMENTS`:
- **Question** — the leading quoted string or free text up to the first
  flag.
- **Flags**:
  - `--prototype` → set `prototype: true`
  - `--prototype-into <path>` → set `prototype_path` (default
    `experiments/<spike-slug>/`)
  - `--depth quick|deep` → set `depth` (default from defaults.yaml: `deep`)
  - `--angles N` → set `researcher_angles` (deep mode only)
  - `--context <path>` (repeatable) → copy into run's `context/` dir
  - `--repo <path>` → target repo (default: CWD)

If `$ARGUMENTS` is empty or `help`, explain usage and stop.

## Step 2 — Lightweight interview

Skip questions whose answer is already in args:

1. **Confirm target repo.** "Spike against <repo>? (y/n)"
2. **Confirm prototype intent.** If `--prototype` not set, ask: "Build a
   prototype if the answer warrants it? (y/n; default no — research only)"
3. **Identify must-read context.** "Any docs/files the team should read?
   (paths or 'none')"

For `--depth deep` (the default), also derive **research angles**:
think about the question for a moment; if you can articulate 2-3 distinct
dimensions worth exploring in parallel, propose them to the user. E.g.,
for "is sqlite viable for tags?":

```
Proposed researcher angles (deep mode, 3 teammates):
  1. Technical feasibility — sqlite limits vs. our scale assumptions
  2. Operational implications — backups, migrations, ops surface
  3. Prior art — how do other apps handle the same problem?

Accept these or propose your own.
```

Capture the agreed angles in the brief.

## Step 3 — Build the run dir and brief

```
run_id  = $(date +%Y-%m-%d-%H%M)-<slug>
run_dir = ~/.agent-teams/runs/<run_id>
```

```bash
mkdir -p <run_dir>/{context,out}
```

Copy each `--context <path>` into `<run_dir>/context/`. Warn (don't error)
on missing files.

Write `<run_dir>/brief.md`:

```markdown
---
type: spike
created: <ISO timestamp>
run_id: <run_id>
repo: <absolute path>
config:
  depth: <merged>
  prototype: <merged>
  prototype_path: <merged>  # only if prototype: true
  researcher_angles: <derived count>
  max_slice_retries: <from feature_flow defaults; prototype reuses this>
angles:
  - <angle 1>
  - <angle 2>
  ...
context_files:
  - <paths under context/>
---

# Question

<the user's question, verbatim>

## Context and motivation

<paragraph derived from the interview — why the user is asking,
constraints they've mentioned, anything that should bias the research>
```

## Step 4 — Confirm

```
Brief drafted. Mode: <quick | deep with N angles>. Prototype: <yes | no>.

Reply:
  launch  → spawn the sandbox
  edit    → tell me what to change
  cancel  → discard
```

Loop until launch or cancel.

## Step 5 — Launch

Compute window: `spike-<slug>-$(date +%H%M)`.

Mount mode depends on `prototype`:

sbx uses direct-mount (host path = sandbox path). The kit's startup hook
scans mounted workspaces for `brief.md` and symlinks `/work` to whichever
mount contains it, so the in-sandbox lead briefing can read `/work/...`
regardless of which workspace sbx made primary. sbx requires the primary
workspace to be writable.

Launch via `~/.dotfiles/scripts/agent-teams-launch.sh`, which wraps
`sbx create` + a settings.json patch (to enable Agent Teams; the kit's
own settings.json gets clobbered by sbx) + `sbx run`. See the script
for details.

**Pure research (`prototype: false`):** run dir is primary writable, repo
secondary read-only.
```bash
tmux new-window -t agent-teams: -n "<window>" -d \
  "~/.dotfiles/scripts/agent-teams-launch.sh agt-spike-<slug> '/spike-flow /work/brief.md' \
     -- claude <run_dir> <repo>:ro \
        --kit ~/.dotfiles/claude/agent-teams-kit"
```

**With prototype:** repo is primary writable via worktree, run dir
secondary writable. Worktree is created on the repo, not the run dir.
```bash
tmux new-window -t agent-teams: -n "<window>" -d \
  "~/.dotfiles/scripts/agent-teams-launch.sh agt-spike-<slug> '/spike-flow /work/brief.md' \
     -- claude <repo> <run_dir> \
        --branch auto \
        --kit ~/.dotfiles/claude/agent-teams-kit"
```

Note: launcher invokes claude WITHOUT `-p` so the session stays open
after the flow completes for follow-up. The launcher pauses with
`read` at the end so the tmux window stays around even after claude
exits.

Ensure tmux session exists (run `~/.dotfiles/scripts/tmux-agent-teams.sh`
if not).

## Step 6 — Report back

```
Launched spike-flow.
  question:   <truncated>
  mode:       <quick | deep>
  prototype:  <yes (path: <prototype_path>) | no>
  window:     agent-teams:<window>
  run dir:    <run_dir>
  output:     <run_dir>/out/report.md  (when done)

Attach with:  tmux switch-client -t agent-teams:<window>
              or prefix C-t
```

## Failure cases

- Pure research mode but `--repo` not readable → ask for path.
- Prototype mode but repo has uncommitted unrelated changes → warn;
  worktree branching still works but make sure the user knows.
- `sbx` not available → SETUP.md, stop.

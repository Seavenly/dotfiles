---
description: Investigate a question with a dynamic workflow — quick (one researcher) or deep (parallel researchers across angles → critic gap-analysis), optional prototype. Args — the question, optional --prototype, --prototype-into path, --depth quick|deep, --angles N, --context path (repeatable), --repo path.
---

You run a spike-flow: interview lightly, draft a brief, (for prototypes)
set up a worktree, then launch the `spike-flow-run` dynamic workflow to
investigate and report. The autonomous research lives in the workflow;
you handle the interview, brief, worktree setup, and wrap-up.

User's invocation: `/spike-flow $ARGUMENTS`

## Read first
- `~/.dotfiles/claude/AGENT-TEAMS.md` — system architecture.
- `~/.dotfiles/claude/defaults.yaml` — cap defaults (`spike_flow`).

## Step 1 — Parse arguments
- **Question** — leading quoted string / free text up to the first flag.
- `--prototype` → `prototype: true`. `--prototype-into <path>` → `prototype_path` (default `experiments/<slug>/`).
- `--depth quick|deep` (default from defaults: `deep`).
- `--angles N` → researcher angle count (deep only).
- `--context <path>` (repeatable) → copy into `context/`.
- `--repo <path>` → target repo (default CWD).

If `$ARGUMENTS` is empty or `help`, explain usage and stop.

## Step 2 — Lightweight interview
Skip questions already answered by args:
1. **Confirm target repo.**
2. **Prototype intent** (if `--prototype` not set): "Build a prototype if warranted? (default no — research only)."
3. **Must-read context** (paths or 'none').

For `--depth deep`, derive **research angles**: think about the question, propose 2-3 distinct parallel dimensions (e.g. technical feasibility / operational implications / prior art), and let the user accept or revise. Capture the agreed angles.

## Step 3 — Build the run dir and brief
```
run_id  = $(date +%Y-%m-%d-%H%M)-<slug>
run_dir = ~/.agent-teams/runs/<run_id>
out_dir = <run_dir>/out
```
`mkdir -p "$out_dir" "$run_dir/context"`. Copy `--context` files (warn on missing).

Write `<run_dir>/brief.md`:
```markdown
---
type: spike
created: <ISO>
run_id: <run_id>
repo: <abs repo path>
config:
  depth: <quick|deep>
  prototype: <bool>
  prototype_path: <only if prototype>
  researcher_angles: <count>
  max_slice_retries: <from feature_flow defaults; prototype reuses>
angles:
  - <angle 1>
  - ...
context_files:
  - <paths under context/>
---

# Question
<the question, verbatim>

## Context and motivation
<why the user is asking; constraints that should bias the research>
```
Confirm: `launch` / `edit` / `cancel`. Loop until launch or cancel.

## Step 4 — Worktree (prototype runs only)
Pure research needs no worktree (pass `worktree:null`, `base:null`). If `prototype: true`:
```bash
base=$(git -C <repo> rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
wt="$run_dir/worktree"
git -C <repo> worktree add "$wt" -b "agt/spike-<slug>" "$base"
```
Install deps once in the worktree (auto-detect as in feature-flow); detect the test command for `testCmd`.

## Step 5 — Launch the workflow
Confirm `auto` permission mode (announce; ask the user to `Shift+Tab` if not).

> Run `/spike-flow-run` with args:
> ```json
> { "runDir":"<run_dir>","outDir":"<out_dir>","repo":"<repo>",
>   "worktree":"<wt|null>","base":"<base|null>","briefPath":"<run_dir>/brief.md",
>   "slug":"<slug>","testCmd":"<cmd|null>","depth":"<quick|deep>",
>   "angles":[<agreed angles>],"prototype":<bool>,
>   "prototypePath":"<path|null>","maxSliceRetries":<n> }
> ```

Launch the saved `~/.claude/workflows/spike-flow-run.js` by name — never regenerate ad-hoc. Watch with `/workflows`.

## Step 6 — Wrap-up (after the workflow returns)
The workflow returns `{ reportPath, depth, angles, prototype, prototypeStuck }`.

Fire a completion notification so the user sees it if they stepped away:
```bash
echo '{"hook_event_name":"Notification","message":"spike-flow complete: <slug>"}' | ~/.dotfiles/claude/hooks/notify.sh
```

If `prototypeStuck[]` is non-empty, call out which prototype slices got stuck and their recorded reason (the report also notes them). Print:
```
✓ spike-flow complete
  question:   <truncated>
  mode:       <quick | deep (angles: ...)>
  report:     <reportPath>
  prototype:  <prototype note>
```
If prototyped, surface the report's "worth keeping" / "discard" guidance and the worktree path. Stay available for follow-ups ("how confident on X?"). `/retro` is available; don't run it automatically.

## Failure cases
- Pure-research mode but repo unreadable → ask for a path.
- Prototype mode but repo has unrelated uncommitted changes → warn (worktree branching still works).

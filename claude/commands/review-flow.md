---
description: Draft a review-flow brief and spawn an agent-teams sandbox to review a GitHub PR. Args — PR number (required), optional --repo owner/name, --max-comments N, --prepare-draft, --lenses security,correctness,style,tests.
---

You are conducting the host-side drafting step of a review-flow run. The
user wants to review an open GitHub PR with a team of parallel reviewers.

User's invocation: `/review-flow $ARGUMENTS`

## Read these first

Before doing anything else:
- `~/.dotfiles/claude/AGENT-TEAMS.md`
- `~/.dotfiles/claude/agent-teams-kit/.claude/defaults.yaml`

## Step 1 — Parse arguments

Extract from `$ARGUMENTS`:
- **PR number** (required) — bare integer or `#1234` form.
- **`--repo owner/name`** — defaults to the current repo (use `gh repo
  view --json nameWithOwner -q .nameWithOwner` to detect).
- **`--max-comments N`** — overrides `max_comments`.
- **`--prepare-draft`** → set `prepare_draft: true` (will create a
  pending review on GitHub at the end).
- **`--lenses a,b,c`** → override `reviewer_lenses` (default from
  defaults.yaml).

If `$ARGUMENTS` is empty or `help`, explain usage and stop.

## Step 2 — Validate the PR

Run:
```bash
gh pr view <pr_number> --repo <repo> --json title,state,url,baseRefName,headRefName
```

If the PR isn't found or isn't OPEN, surface the error to the user and stop.

Show the user a one-line confirmation:
```
About to review PR #<num>: "<title>" (<state>)
  base: <baseRefName>  head: <headRefName>
  url:  <url>
Reply "launch" to proceed, "cancel" to stop.
```

Review-flow skips the heavy brief interview by default — the PR number
is enough context. Allow the user to interject with extra guidance if
they want (e.g., "focus on the new auth code"), and capture that as a
`focus:` field in the brief.

## Step 3 — Build the run dir and brief

```
run_id  = $(date +%Y-%m-%d-%H%M)-pr-<num>
run_dir = ~/.agent-teams/runs/<run_id>
```

```bash
mkdir -p <run_dir>/{out,out/findings}
```

Write `<run_dir>/brief.md`:

```markdown
---
type: review
created: <ISO timestamp>
run_id: <run_id>
pr_number: <num>
repo: <owner/name>
pr_url: <url>
base_ref: <baseRefName>
head_ref: <headRefName>
config:
  max_comments: <merged>
  per_tier_caps: <from defaults>
  reviewer_lenses: <merged>
  prepare_draft: <merged>
focus: <optional user-supplied focus>
---

# Review brief

PR #<num>: <title>

<any focus or notes from the user>
```

## Step 4 — Confirm

If the user provided a focus during step 2, show the rendered brief and
ask one more time:

```
Brief drafted. Launch? (launch / edit / cancel)
```

Otherwise just proceed (review-flow is the fast path).

## Step 5 — Launch

Compute window: `review-pr-<num>-$(date +%H%M)`.

```bash
tmux has-session -t agent-teams 2>/dev/null || \
  ~/.dotfiles/scripts/tmux-agent-teams.sh

# For review-flow, target repo is read-only. We don't need a worktree.
# We pass the repo path :ro so reviewers can read surrounding code.
LOCAL_REPO="$(gh repo view <repo> --json sshUrl -q .sshUrl | head -c 1)"
# Detect: do we have the repo checked out locally?

# If repo is locally checked out somewhere reachable, mount it :ro.
# Otherwise the sandbox uses `gh` to fetch the PR diff alone.
```

Build the spawn command. If the repo is locally checked out:

```bash
tmux new-window -t agent-teams: -n "<window>" -d \
  "sbx run claude <local_repo_path>:ro \
     --name agt-review-pr-<num> \
     --kit ~/.dotfiles/claude/agent-teams-kit \
     <run_dir>:rw \
     -- -p '/review-flow /work/brief.md'"
```

If not locally checked out:

```bash
tmux new-window -t agent-teams: -n "<window>" -d \
  "sbx run claude <run_dir> \
     --name agt-review-pr-<num> \
     --kit ~/.dotfiles/claude/agent-teams-kit \
     <run_dir>:rw \
     -- -p '/review-flow /work/brief.md'"
```

(The lead inside the sandbox uses `gh pr diff` either way; the difference
is whether reviewers can also browse surrounding source for context.)

Note: `--branch auto` is **not** used for review-flow. There's no
worktree — the sandbox is read-only against the source.

## Step 6 — Report back

```
Launched review-flow for PR #<num>.
  window:    agent-teams:<window>
  run dir:   <run_dir>
  output:    <run_dir>/out/review.md  (when done)
  prepare-draft: <yes/no>

Attach with:  tmux switch-client -t agent-teams:<window>
              or prefix C-t
```

## Failure cases

- PR not found → surface gh error, stop.
- PR not OPEN → confirm with user before proceeding; some users want to
  review closed/draft PRs, but make sure they meant to.
- `gh` not authenticated → tell user `gh auth login` and stop.
- `sbx secret get github` not set → mention SETUP.md and stop (the
  sandbox needs the token to call gh).

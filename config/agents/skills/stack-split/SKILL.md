---
name: stack-split
description: >
  Decompose an existing branch or PR that is already written into a gh-stack of
  true-linear review layers, with hunk-level assignment and a tree-equality proof.
  Use only for retroactive splitting - a large branch, or a big AI-generated PR,
  that needs to become a stack. For building a stack as you write new code, and
  for everything after the stack exists (rebase, sync, submit, merge,
  restructure), use the gh-stack skill instead.
disable-model-invocation: true
metadata:
  author: Seavenly
  version: "1.2.0"
---

# stack-split

Turn one finished branch into an ordered chain of branches, each containing a
single concern, ready for `gh stack`. This skill **ends at stack creation**.
Everything afterwards belongs to the `gh-stack` skill.

Invoked only by the user, via `/stack-split`. Rewriting a branch into a chain of
new refs is a side-effecting operation whose timing is the author's call, so the
model must not start it on its own. If you reached this skill without the user
asking for it, stop and suggest they run `/stack-split`.

Do not reproduce these steps by hand as a substitute for invoking the skill.

The official gh-stack guidance says to plan layers before writing code and warns
against splitting afterwards. That is right when you have the choice. This skill
exists for when you do not: the branch is already written.

## Scope

Do **not** use this skill to:

- build a stack while writing new code — use `gh-stack` and create layers up front
- rebase, sync, push, submit, merge, or restructure an existing stack — `gh-stack`
- reorder or insert layers in a stack that already exists — `gh-stack`
  (`references/troubleshooting.md`, "Restructuring a stack")

## Non-interactive rules

- `gh stack view --json`, never bare `view` (TUI).
- `gh stack init <branch>...` with explicit names, never bare `init` (prompts).
- Never run `gh pr create`. `gh stack submit` creates the PRs, and it is the
  user's call when to run it.
- Never delete a branch automatically. Print rollback commands instead.

## Phase 1 — Pre-flight

Abort with a clear message on any failure.

```bash
# Resolve this skill's own directory. Covers plugin, user, and project scope.
for c in "$CLAUDE_PLUGIN_ROOT/skills/stack-split" "$HOME/.claude/skills/stack-split" \
         "$PWD/.claude/skills/stack-split"; do
  [ -f "$c/scripts/build_layers.py" ] && SKILL_DIR="$c" && break
done
[ -n "$SKILL_DIR" ] || echo "cannot locate stack-split scripts; abort"

git rev-parse --show-toplevel                 # in a repo; run from the root
git diff --quiet && git diff --cached --quiet # clean worktree
git ls-files --others --exclude-standard      # no untracked files
SOURCE=$(git symbolic-ref --short HEAD)       # fails in detached HEAD
BASE=${base:-$(git branch -r | grep -oE 'origin/(main|master)' | head -1 | sed 's|origin/||')}
git fetch origin "$BASE" --quiet              # merge-base needs a current remote ref
MERGE_BASE=$(git merge-base HEAD "origin/$BASE")
git diff --name-only "$MERGE_BASE"..HEAD      # non-empty
gh stack --version                            # extension installed
```

Run every later phase from the repository root, since `build_layers.py` defaults
`--repo` to the current directory. Pass `--repo "$(git rev-parse --show-toplevel)"`
if you cannot.

If `SOURCE` equals `BASE`, stop — you are on the base branch. If the worktree is
dirty or has untracked files, stop and list them; splitting an unclean tree
silently mixes uncommitted work into a layer.

Confirm stacks are enabled for the repository. `gh stack` exits 9 when they are
not; say so plainly rather than proceeding.

## Phase 2 — Analyze

```bash
git diff "$MERGE_BASE"..HEAD | python3 "$SKILL_DIR/scripts/split_diff.py" analyze
```

Returns per file: `path`, `old_path`, `change_type` (A/M/D/R), `is_binary`,
`hunk_count`, and each hunk's `index` and `preview`. Hunk indices are 0-based.

Show the user a table of files, change types, hunk counts, and line counts.

## Phase 3 — Propose layers

Assign **every hunk of every changed file to exactly one layer**. The builder
rejects a plan that drops or duplicates any hunk, so an incomplete plan fails
before it touches a ref.

Ordering rules:

- A layer may only depend on layers below it. Types and schema at the bottom,
  then logic, then callers, then tests and docs.
- A layer that cannot be described in one sentence is two layers.
- A file whose hunks serve different concerns gets split by hunk. This is the
  reason to use this skill rather than staging whole files.
- Pure renames (`hunk_count: 0`) and binary files are indivisible — assign them
  whole with `"hunks": "all"`.

Name branches from the source branch plus the concern, honoring repository
conventions: `feat/checkout` → `feat/checkout-1-models`, `-2-api`, `-3-ui`.

Write the plan to a JSON file:

```json
{
  "base": "main",
  "merge_base": "<sha from Phase 1>",
  "source_ref": "<source branch>",
  "layers": [
    {"branch": "feat/checkout-1-models", "message": "feat: add order models",
     "files": [{"path": "models.py", "hunks": "all"},
               {"path": "app.py", "hunks": [0]}]},
    {"branch": "feat/checkout-2-api", "message": "feat: add checkout routes",
     "files": [{"path": "api.py", "hunks": "all"},
               {"path": "app.py", "hunks": [1, 2]}]}
  ]
}
```

Validate before showing it to the user — this creates no refs:

```bash
python3 "$SKILL_DIR/scripts/build_layers.py" --plan plan.json --dry-run
```

Present the plan as one table per layer. State plainly that each PR will show
only its own layer's diff, and that the source branch is never modified.

## Phase 4 — Approval

**Stop. Do not create refs until the user approves this exact plan.**

Use `AskUserQuestion` with Approve / Adjust / Cancel. On Adjust, revise and
re-validate with `--dry-run`, then ask again. On Cancel, stop immediately.

## Phase 5 — Build

```bash
python3 "$SKILL_DIR/scripts/build_layers.py" --plan plan.json
```

The builder works in a temporary git worktree, so the source branch and the
user's checkout are never checked out or modified. Each layer branches from the
one below it, so the result is a true linear chain — `git merge-base --is-ancestor`
holds between consecutive layers. That is what makes GitHub's three-dot PR diff
show only the layer's own changes.

It then proves the top layer's tree is byte-identical to the source ref and
fails loudly if not. On any failure it prints the branches it created and the
`git branch -D` command to remove them, and deletes nothing itself.

Report its JSON verbatim, including `tree_equality_proven`.

## Phase 6 — Hand off to gh-stack

Create the stack, then stop:

```bash
gh stack init --base <base> <layer-1> <layer-2> ... <layer-N>
gh stack view --json
```

Because the branches are already correctly chained, `view` shows no `needsRebase`
markers and **no repair rebase is required**.

Do not run `gh stack submit`. Tell the user the stack is built locally and that
`gh stack submit` (add `--open` for ready-for-review instead of draft) will push
the branches and open the PRs when they are ready. Point further work at the
`gh-stack` skill.

Print a summary: each layer, its branch, its one-sentence concern, and a note
that the original branch is unchanged.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| `unassigned changes would be silently dropped` | a hunk is in no layer | add it; never ignore |
| `hunk N assigned to both layer X and Y` | duplicate assignment | remove one |
| `is binary; it cannot be split by hunk` | binary in a hunk list | assign `"all"` |
| `has no hunks; assign it whole` | pure rename | assign `"all"` |
| `branch ... already exists` | rerun after a partial build | delete the listed branches or rename |
| `tree-equality proof FAILED` | reconstruction lost content | do not proceed; report the diffstat |

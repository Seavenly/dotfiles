---
schema_version: 1
kind: derivative
sources:
  - id: local-split-mirror
    relationship: base
    repository: https://github.com/Iron-Ham/split.git
    path: skills/split
    revision: 5eec1a6d6cac27cb512ed9b5040d3c3c4b9c3d78
  - id: local-agent-flow-stacks
    relationship: base
    path: config/agents/skills/agent-flow-stacks
  - id: upstream-gh-stack
    relationship: interface
    repository: https://github.com/github/gh-stack.git
    path: skills/gh-stack
    revision: 14fc42ed9b6c376a53b2f999f138d3bd26dac546
---

# Lineage intent

Retarget retroactive branch splitting at GitHub Stacks. Takes the diff analysis,
hunk-level planning, and approval gate from `split`; takes true-linear branch
construction in a temporary worktree and the exact tree-equality proof from
`agent-flow-stacks`; hands the result to the official `gh-stack` skill and stops.

`scripts/split_diff.py` is vendored verbatim from the `split` mirror at the
revision above so this skill is self-contained. Re-vendor it when that mirror
advances rather than editing the copy.

## Invocation policy: user-only, on both harnesses

Rewriting a branch into a chain of new refs is side-effecting and its timing is
the author's call, so neither harness may start it implicitly. Each has its own
control, and both are set. They are independent — setting one does not cover the
other.

- **Claude Code** — `disable-model-invocation: true` in `SKILL.md` frontmatter.
  The model cannot invoke it, and the description is kept out of context, so it
  also cannot be triggered by description overlap with the `gh-stack` skill.
- **Codex** — `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
  Per `skill-creator/references/openai_yaml.md`: "When false, the skill is not
  injected into the model context by default, but can still be invoked
  explicitly via `$skill`. Defaults to true." Codex's own `review-agent` sets
  this, so it is the sanctioned pattern rather than a workaround.

Generate the `interface` block with
`skill-creator/scripts/generate_openai_yaml.py` rather than hand-writing it, then
re-add the `policy` block — the generator does not emit `policy`. Keep
`interface.short_description` within 25–64 characters.

### Known validator disagreement

Codex ships two validators that disagree about the Claude Code field:

- `plugin-creator/scripts/validate_plugin.py` knows `disable-model-invocation`
  and accepts it when absent or `false`.
- `skill-creator/scripts/quick_validate.py` rejects it outright as an unexpected
  frontmatter key (it allows only `allowed-tools`, `description`, `license`,
  `metadata`, `name`).

So `quick_validate.py` reports one warning on this skill. That is expected and is
not worth fixing by removing the field, because doing so would restore implicit
invocation under Claude Code — the stronger of the two guarantees. Codex's
documented triggering inputs are `name` and `description` only, so an unknown
frontmatter key should be inert at load time; that was not verified against a
running Codex, only against its validators.

## Semantic changes over `split`

- **Branch from the parent layer, not the merge-base.** `split` creates every
  branch from the merge-base with a cumulative commit, producing siblings rather
  than a chain. Because GitHub renders a PR as a three-dot diff from the
  merge-base, every layer above the first then shows the cumulative content
  instead of its own. Building each layer on the one below it makes
  `git merge-base --is-ancestor` hold between consecutive layers, which is also
  gh-stack's requirement for `needsRebase` to read false.
- **Reject incomplete plans before creating refs.** Every hunk of every changed
  file must be assigned to exactly one layer. Unassigned hunks silently drop
  work; duplicated hunks duplicate it.
- **Prove the top layer equals the source tree**, and fail loudly otherwise.
- **Drop PR creation.** `split` Phase 6 calls `gh pr create --base`. Under
  gh-stack, `gh stack submit` owns PR creation, and a PR that already belongs to
  a stack refuses base changes (`422 PullRequest.base is invalid`).

## Semantic changes over `agent-flow-stacks`

- No generation manifests, digests, or restack machinery. This skill stops at
  stack creation; gh-stack owns the lifecycle from there.
- `agent-flow-stacks` remains the right tool when reviewed layers must be
  immutable and never force-pushed — a property gh-stack's rebase-in-place model
  cannot provide. The two are not interchangeable.

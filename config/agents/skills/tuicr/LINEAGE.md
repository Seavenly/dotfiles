---
schema_version: 1
kind: mirror
sources:
  - id: upstream-tuicr
    relationship: base
    repository: https://github.com/agavra/tuicr.git
    path: skills/tuicr
    revision: d02955aac01e0e074dccbf9916a90df57651e4ef
---

# Lineage intent

Mirror the upstream `tuicr` skill unchanged. It teaches the agent to drive
tuicr's `review` CLI as the primary interface to interactive TUI review
sessions: discover active sessions, read the user's comments, and, only when the
workflow calls for it, add agent-authored comments. It also launches tuicr in a
tmux or zellij split pane via the bundled wrapper scripts when the user needs an
interactive review pane.

Kept verbatim so upstream improvements apply cleanly. Local adaptations, if any
are needed later, should convert this entry to `derivative`.

## Wrapper scripts

Unlike a plugin that resolves helpers through `${CLAUDE_PLUGIN_ROOT}`, upstream
ships the tmux, Zellij, cmux, and Herdr wrappers (`tuicr-wrapper*.sh`) and their
shared `_tuicr-common.sh` alongside `SKILL.md`, and the skill resolves them
"relative to this skill directory." This package is exposed as a managed skill
via directory symlinks, and the wrappers travel with `SKILL.md`, so that
relative reference holds without a plugin-root variable. The wrappers are
mirrored with their executable bit set; `_tuicr-common.sh` is sourced, not
executed. The Herdr wrapper requires `jq`.

The skill relies on CLI behavior from recent tuicr releases (the
`tuicr-summary:` exit line, `reviewed_count`, and comment `author`), so keep the
mise-managed binary current when advancing this mirror.

## Relationship to other tuicr wiring in this repo

- The `tuicr` binary is managed through mise's GitHub backend
  (`github:agavra/tuicr` in `mise.toml`); these wrappers require it on `PATH`.
- Personal tmux review hotkeys live outside this skill and need no GitHub PR:
  `prefix + r` (`bin/tmux-review-inbox`) is a combined review inbox - local
  agent reviews from the `bin/tuicr-reviews` registry plus coworker PRs - and
  `prefix + b` (`bin/tmux-tuicr --pick-base`) reviews any branch against a
  chosen base. The registry/merge workflow is documented in the separate
  `tuicr-reviews` skill. The upstream `tuicr-wrapper.sh` here is the agent-facing
  launcher this skill documents, and it stays distinct from those wrappers.

## Update policy

Track upstream as an unmodified mirror. On update, record the newly incorporated
revision above. Never overwrite this file with upstream content.

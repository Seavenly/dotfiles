---
schema_version: 1
kind: mirror
sources:
  - id: upstream-tuicr
    relationship: base
    repository: https://github.com/agavra/tuicr.git
    path: skills/tuicr
    revision: 057b336e794b1f3e2bf881b9808c5011a3a5a291
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
ships `tuicr-wrapper.sh` and `tuicr-wrapper-zellij.sh` alongside `SKILL.md` and
the skill resolves them "relative to this skill directory." This package is
exposed as a managed skill via directory symlinks, and the wrappers travel with
`SKILL.md`, so that relative reference holds without a plugin-root variable. The
wrappers are mirrored with their executable bit set.

## Relationship to other tuicr wiring in this repo

- The `tuicr` binary is managed through mise's GitHub backend
  (`github:agavra/tuicr` in `mise.toml`); these wrappers require it on `PATH`.
- Personal tmux review hotkeys live outside this skill and need no GitHub PR:
  `prefix + r` (`bin/tmux-tuicr-reviews`) picks a recorded review from the
  `bin/tuicr-reviews` registry - which the `feature-flow` command populates on
  wrap-up - and opens it in its worktree; `prefix + b` (`bin/tmux-tuicr
  --pick-base`) reviews any fzf-picked branch against a chosen base. The
  upstream `tuicr-wrapper.sh` here is the agent-facing launcher the skill
  documents, and it stays distinct from these wrappers.

## Update policy

Track upstream as an unmodified mirror. On update, record the newly incorporated
revision above. Never overwrite this file with upstream content.

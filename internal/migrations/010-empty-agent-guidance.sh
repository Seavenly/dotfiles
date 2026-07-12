#!/usr/bin/env bash
set -euo pipefail

dry_run="${DOTFILES_MIGRATION_DRY_RUN:-0}"
targets=(
  "$HOME/.codex/AGENTS.md"
  "$HOME/.claude/CLAUDE.md"
)

for target in "${targets[@]}"; do
  [[ -f "$target" && ! -L "$target" && ! -s "$target" ]] || continue
  if ((dry_run)); then
    printf 'Would remove empty agent guidance file %s.\n' "$target"
  else
    unlink "$target"
  fi
done

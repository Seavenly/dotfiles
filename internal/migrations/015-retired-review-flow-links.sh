#!/usr/bin/env bash
set -euo pipefail

# review-flow dropped the Mermaid diagrammer and its npm package. mise's
# symlink-each adds links for new sources but never prunes removed ones, so
# clear the exact per-file links it left behind once their sources are gone.
retired_links=(
  "$HOME/.claude/agents/diagrammer.md|$DOTFILES_ROOT/config/claude/agents/diagrammer.md"
  "$HOME/.claude/scripts/mermaid.config.json|$DOTFILES_ROOT/config/claude/scripts/mermaid.config.json"
  "$HOME/.claude/scripts/package.json|$DOTFILES_ROOT/config/claude/scripts/package.json"
  "$HOME/.claude/scripts/package-lock.json|$DOTFILES_ROOT/config/claude/scripts/package-lock.json"
)

for pair in "${retired_links[@]}"; do
  link="${pair%%|*}"
  expected="${pair#*|}"
  if [[ -L "$link" && "$(readlink "$link")" == "$expected" && ! -e "$expected" ]]; then
    if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
      printf 'Would remove retired review-flow link %s.\n' "$link"
    else
      unlink "$link"
    fi
  fi
done

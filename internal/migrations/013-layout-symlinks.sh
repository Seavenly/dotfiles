#!/usr/bin/env bash
set -euo pipefail

# The repository moved top-level `tmux.conf`, `nvim`, and the `claude/` tree
# under `config/`. Earlier layouts left whole-target symlinks at the old paths.
# mise's symlink-each cannot populate a directory that is itself a symlink, and
# a plain link left dangling blocks the dotfiles stage, so clear the exact
# stale targets before mise relinks them. Any link already repointed at the new
# `config/` path (or a real directory) is left untouched.
legacy_links=(
  "$HOME/.tmux.conf|$DOTFILES_ROOT/tmux.conf"
  "$HOME/.config/nvim|$DOTFILES_ROOT/nvim"
  "$HOME/.claude/agents|$DOTFILES_ROOT/claude/agents"
  "$HOME/.claude/commands|$DOTFILES_ROOT/claude/commands"
  "$HOME/.claude/scripts|$DOTFILES_ROOT/claude/scripts"
  "$HOME/.claude/workflows|$DOTFILES_ROOT/claude/workflows"
)

for pair in "${legacy_links[@]}"; do
  link="${pair%%|*}"
  expected="${pair#*|}"
  if [[ -L "$link" && "$(readlink "$link")" == "$expected" ]]; then
    if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
      printf 'Would remove stale layout link %s.\n' "$link"
    else
      unlink "$link"
    fi
  fi
done

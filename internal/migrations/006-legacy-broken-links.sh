#!/usr/bin/env bash
set -euo pipefail

legacy_links=(
  "$HOME/.config/zshrc|$DOTFILES_ROOT/zshrc"
  "$HOME/.config/kitty|$DOTFILES_ROOT/kitty"
  "$HOME/.aider.conf.yml|$DOTFILES_ROOT/aider/.aider.conf.yml"
  "$HOME/.local/bin/sesh-list|$DOTFILES_ROOT/bin/sesh-list"
  "$HOME/.local/bin/sesh-pick|$DOTFILES_ROOT/bin/sesh-pick"
)

for pair in "${legacy_links[@]}"; do
  link="${pair%%|*}"
  expected="${pair#*|}"
  if [[ -L "$link" && "$(readlink "$link")" == "$expected" ]]; then
    if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
      printf 'Would remove known legacy link %s.\n' "$link"
    else
      unlink "$link"
    fi
  fi
done

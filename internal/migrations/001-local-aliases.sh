#!/usr/bin/env bash
set -euo pipefail

config_dir="$DOTFILES_CONFIG_DIR"
target="$config_dir/aliases.local.zsh"
payload="$DOTFILES_ROOT/internal/migrations/payloads/v1-aliases.zsh"

[[ ! -e "$target" ]] || exit 0
if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
  printf 'Would seed machine-local aliases at %s.\n' "$target"
  exit 0
fi
mkdir -p "$config_dir"
install -m 0600 "$payload" "$target"

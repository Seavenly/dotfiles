#!/usr/bin/env bash
set -euo pipefail

target="$DOTFILES_CONFIG_DIR/private.zsh"
legacy="$DOTFILES_ROOT/zshrc/private.sh"

[[ ! -e "$target" ]] || { chmod 0600 "$target"; exit 0; }
if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
  printf 'Would create or migrate the private environment at %s.\n' "$target"
  exit 0
fi

mkdir -p "$DOTFILES_CONFIG_DIR"
if [[ -r "$legacy" ]]; then
  install -m 0600 "$legacy" "$target"
  unlink "$legacy"
  rmdir "$(dirname "$legacy")" 2>/dev/null || true
  echo "Migrated the legacy private shell environment without printing its contents."
else
  install -m 0600 /dev/null "$target"
fi

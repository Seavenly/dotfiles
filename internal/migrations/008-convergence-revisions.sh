#!/usr/bin/env bash
set -euo pipefail

revision_dir="$DOTFILES_STATE_DIR/revisions"
legacy_dir="$DOTFILES_STATE_DIR/migrations"
revisions=(
  "004-sketchybar-app-font|sketchybar-app-font"
  "005-macos-defaults-restart|macos-defaults-restart"
)

for pair in "${revisions[@]}"; do
  legacy="$legacy_dir/${pair%%|*}"
  current="$revision_dir/${pair#*|}"
  [[ -e "$legacy" && ! -e "$current" ]] || continue
  if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
    printf 'Would preserve convergence revision %s.\n' "${pair#*|}"
  else
    mkdir -p "$revision_dir"
    mv "$legacy" "$current"
  fi
done

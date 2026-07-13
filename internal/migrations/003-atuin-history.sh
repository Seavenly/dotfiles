#!/usr/bin/env bash
set -euo pipefail

history_file="$HOME/.zsh_history"
[[ -s "$history_file" ]] || exit 75

# Atuin is a mise-managed tool installed later in the bootstrap (mise install,
# step 9). When this runs from the early pre-dotfiles hook the shim is not on
# PATH yet; defer until the finalize pass re-runs migrations with tools present.
command -v atuin >/dev/null 2>&1 || exit 75

if [[ ${DOTFILES_MIGRATION_DRY_RUN:-0} == 1 ]]; then
  echo "Atuin history import is available from the existing Zsh history."
  exit 75
fi

if [[ ${DOTFILES_YES:-0} != 1 && -t 0 ]]; then
  read -r -p "Import the existing Zsh history into Atuin? [Y/n] " import_history
  [[ "$import_history" =~ ^[Nn]$ ]] && exit 75
  atuin import zsh
  exit 0
fi

echo "Atuin history import is available: atuin import zsh"
exit 75

#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv="${XDG_DATA_HOME:-$HOME/.local/share}/dotfiles/recorder-venv"

if [[ ! -x "$venv/bin/python" ]]; then
  echo "ok - recorder cleaning tests skipped without the optional environment"
  exit 0
fi

"$venv/bin/python" "$root/tests/recorder_clean_test.py"
echo "ok - recorder cleaning uses bounded memory and preserves mic audio"

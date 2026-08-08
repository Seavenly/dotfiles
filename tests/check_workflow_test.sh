#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

install_step="$(awk '
  /name: Install validators from the lock/ { capture = 1; next }
  capture && /run:/ { print; exit }
' "$root/.github/workflows/check.yml")"
assert_contains "$install_step" 'ripgrep'
echo "ok - CI installs ripgrep before source validation"

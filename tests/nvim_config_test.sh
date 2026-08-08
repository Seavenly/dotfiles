#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

result="$(
  SSH_CONNECTION='client 1 server 22' nvim --clean --headless \
    --cmd 'set loadplugins=false' \
    "+lua dofile('$root/config/nvim/lua/user/options.lua'); print(vim.g.clipboard or 'unset')" \
    +qa! 2>&1
)"
assert_contains "$result" 'osc52'
echo "ok - Neovim uses OSC 52 for remote clipboard access"

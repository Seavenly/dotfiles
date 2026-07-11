#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

for command in install doctor check upgrade; do
  output="$("$root/dotfiles" "$command" --help)"
  assert_contains "$output" "Usage: dotfiles $command"
done
echo "ok - every dotfiles subcommand provides help"

set +e
output="$("$root/dotfiles" unknown 2>&1)"
status=$?
set -e
assert_status "$status" 2
assert_contains "$output" 'Unknown command: unknown'
echo "ok - dotfiles rejects unknown subcommands"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ln -s "$root/dotfiles" "$tmp/dotfiles"
output="$("$tmp/dotfiles" --help)"
assert_contains "$output" 'Usage: dotfiles <command> [options]'
echo "ok - installed dotfiles symlink resolves the repository"

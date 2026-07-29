#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

herdr_alt_keys="$(
  sed -n 's/^key = "prefix+alt+\([^"]*\)"$/\1/p' \
    "$root/config/herdr/config.toml" \
    | sort -u
)"
aerospace_alt_keys="$(
  sed -n 's/^alt-\([a-z0-9]*\) = .*/\1/p' \
    "$root/config/aerospace/aerospace.toml" \
    | sort -u
)"
conflicting_keys="$(
  comm -12 \
    <(printf '%s\n' "$herdr_alt_keys") \
    <(printf '%s\n' "$aerospace_alt_keys")
)"

[[ -z "$conflicting_keys" ]] \
  || fail "Herdr prefix Alt bindings conflict with AeroSpace: ${conflicting_keys//$'\n'/, }"
echo "ok - Herdr custom keys avoid AeroSpace global bindings"

assert_contains "$(cat "$root/config/herdr/config.toml")" 'key = "prefix+ctrl+d"'
assert_contains "$(cat "$root/config/herdr/config.toml")" \
  'command = "project-switcher --backend herdr --project \"$(dotfiles-root)\""'
echo "ok - Herdr opens the dotfiles project with prefix Ctrl-D"

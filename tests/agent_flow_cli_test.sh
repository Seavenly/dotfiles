#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

assert_contains "$("$root/bin/agent-flow" --help)" 'agent-flow doctor profiles'

set +e
output="$("$root/bin/agent-flow" launch review 2>&1)"
status=$?
set -e
assert_status "$status" 2
assert_contains "$output" 'Unknown command: launch'
echo "ok - Phase 1 agent-flow exposes only profile doctoring"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
config_home="$home/.config"
mkdir -p "$config_home/dotfiles"
cp "$root/config/agent-flow/hermes-routing.example.yaml" \
  "$config_home/dotfiles/hermes-routing.yaml"
HOME="$home" XDG_CONFIG_HOME="$config_home" DOTFILES_ROOT="$root" \
  "$root/internal/bootstrap/hermes-profiles" >/dev/null

set +e
output="$(HOME="$home" XDG_CONFIG_HOME="$config_home" \
  AGENT_FLOW_HERMES_BIN="$tmp/missing-hermes" \
  "$root/bin/agent-flow" doctor profiles --json 2>&1)"
status=$?
set -e
assert_status "$status" 1
assert_contains "$output" '"ok": false'
assert_contains "$output" '"id": "hermes-version"'
assert_contains "$output" '"id": "routing"'
assert_contains "$output" '"id": "dispatch-owner"'
echo "ok - profile doctor reports unavailable launch prerequisites as JSON"

#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/state/agent-flow/runs/cli-run"
printf '%s\n' '{"schema":"agent-flow.run/v1","identity":{"run_id":"cli-run","flow":"review","external_root":null}}' \
  > "$tmp/state/agent-flow/runs/cli-run/run.json"

output="$(HOME="$tmp" XDG_STATE_HOME="$tmp/state" DOTFILES_ROOT="$root" \
  "$root/bin/flow" query legacy-inventory --json)"
assert_contains "$output" '"schema":"flow.legacy-compatibility-inventory/v1"'
assert_contains "$output" '"id":"hermes-agent-flow:cli-run"'
assert_contains "$output" '"content_sha256"'
echo "ok - flow exposes the read-only legacy compatibility inventory"

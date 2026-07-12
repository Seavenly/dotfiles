#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

[[ -L "$root/CLAUDE.md" ]] || fail "CLAUDE.md is not a symlink"
[[ "$(readlink "$root/CLAUDE.md")" == AGENTS.md ]] \
  || fail "CLAUDE.md does not target AGENTS.md"
echo "ok - repository guidance is shared with Claude"

[[ -s "$root/config/agents/AGENTS.global.md" ]] \
  || fail "global agent guidance is missing"
assert_contains "$(cat "$root/mise.toml")" \
  '"~/.codex/AGENTS.md" = "config/agents/AGENTS.global.md"'
assert_contains "$(cat "$root/mise.toml")" \
  '"~/.claude/CLAUDE.md" = "config/agents/AGENTS.global.md"'
echo "ok - global guidance is linked to supported harnesses"

assert_contains "$(cat "$root/config/agents/skills/README.md")" 'LINEAGE.md'
assert_contains "$(cat "$root/config/agents/profiles/README.md")" 'CONTRACT.md'
echo "ok - agent skill and profile conventions are documented"

#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

export MISE_TRUSTED_CONFIG_PATHS="$root"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
mkdir -p "$home/.config" "$home/.local/state"

for _ in 1 2; do
  converge_test_dotfiles "$root" "$home" >/dev/null
done

managed_flow="$home/.config/flow"
[[ -L "$managed_flow" ]] || fail "convergence did not install the flow transition policy"
[[ "$(readlink "$managed_flow")" == "$root/config/flow" ]] \
  || fail "managed flow transition policy targets the wrong source"

selection="$(HOME="$home" XDG_STATE_HOME="$home/.local/state" node --input-type=module -e '
  const { queryTransition } = await import(process.argv[1]);
  const result = await queryTransition({
    configDirectory: process.argv[2],
    repositoryRoot: process.argv[3],
  });
  process.stdout.write(JSON.stringify({
    selected_implementation: result.selected_implementation,
    hermes_launch_available: result.legal_actions.includes("launch_explicit_legacy_agent_flow"),
    dark_opt_in_available: result.dark_opt_in.available,
  }));
' "$root/tools/flow/src/transition-projection.mjs" "$managed_flow" "$root")"
[[ "$selection" == '{"selected_implementation":"legacy-claude/v1","hermes_launch_available":false,"dark_opt_in_available":false}' ]] \
  || fail "repeated convergence changed the default or exposed unqualified or retired launches"


echo "ok - repeated convergence preserves the Claude default and retires Hermes launches"

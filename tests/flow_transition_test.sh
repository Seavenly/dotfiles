#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
mkdir -p "$home/.config" "$home/.local/state"

for _ in 1 2; do
  HOME="$home" XDG_CONFIG_HOME="$home/.config" \
    XDG_STATE_HOME="$home/.local/state" MISE_TRUSTED_CONFIG_PATHS="$root" \
    mise -C "$root" -E linux bootstrap dotfiles apply --yes \
    >/dev/null 2>&1
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
  process.stdout.write(result.selected_implementation);
' "$root/tools/flow/src/transition-projection.mjs" "$managed_flow" "$root")"
[[ "$selection" == "legacy-claude/v1" ]] \
  || fail "repeated convergence selected replacement authority"

echo "ok - repeated convergence preserves the frozen legacy launch policy"

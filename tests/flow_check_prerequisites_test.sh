#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/repository"
commands="$tmp/commands"
modern="$tmp/managed/github-agavra-tuicr/0.27.0"
historical="$tmp/installed/github-agavra-tuicr/0.19.0"
mkdir -p "$fixture/internal/commands" "$fixture/internal/shell" \
  "$fixture/bin" "$fixture/tests" "$fixture/tools/recorder" \
  "$fixture/config/sketchybar" "$fixture/config/nvim" "$fixture/.githooks" \
  "$commands" "$modern" "$historical"
cp "$root/dotfiles" "$fixture/dotfiles"
cp "$root"/internal/commands/check* "$fixture/internal/commands/"
cp "$root/internal/shell/context.sh" "$fixture/internal/shell/context.sh"
printf 'locked fixture\n' > "$fixture/mise.lock"
printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/tests/run"
chmod +x "$fixture/tests/run"

# These are external validator/package-manager boundaries. The real public
# dispatcher, check command and prerequisite selection execute unchanged.
cat > "$commands/bash" <<'BASH'
#!/bin/bash
case "${1:-}" in -c|-n) exit 0 ;; esac
exec /bin/bash "$@"
BASH
for command in zsh jq luac python3 uv actionlint shellcheck; do
  printf '#!/bin/bash\nexit 0\n' > "$commands/$command"
done
cat > "$commands/gitleaks" <<'GITLEAKS'
#!/bin/bash
[[ "$(tuicr --version)" == 'tuicr 0.27.0' ]] || {
  printf 'Flow prerequisite PATH escaped into unrelated validation\n' >&2
  exit 1
}
GITLEAKS
cat > "$commands/mise" <<'MISE'
#!/bin/bash
printf '%s\n' "$*" >> "$CHECK_MISE_LOG"
if [[ ${1:-} == where ]]; then
  [[ ${MISE_AUTO_INSTALL:-} == false ]] || exit 91
  [[ ${2:-} == github:agavra/tuicr@0.19.0 ]] || exit 92
  [[ -n ${CHECK_HISTORICAL_DIRECTORY:-} ]] || exit 1
  printf '%s\n' "$CHECK_HISTORICAL_DIRECTORY"
  exit 0
fi
# The ordinary locked-tools check is read-only. A download or install request
# from prerequisite discovery must fail this fixture rather than be hidden.
if [[ " $* " == *' install '* && " $* " != *' -n '* ]]; then exit 93; fi
exit 0
MISE
cat > "$commands/npm" <<'NPM'
#!/bin/bash
version="$(tuicr --version)"
printf '%s|%s\n' "$2" "$version" >> "$CHECK_NPM_LOG"
case "$2" in */config/flow|*/tools/flow) [[ "$version" == 'tuicr 0.19.0' ]] ;; *) [[ "$version" == 'tuicr 0.27.0' ]] ;; esac
NPM
printf '#!/bin/bash\nprintf "tuicr 0.27.0\\n"\n' > "$modern/tuicr"
printf '#!/bin/bash\nprintf "tuicr 0.19.0\\n"\n' > "$historical/tuicr"
chmod +x "$commands"/* "$modern/tuicr" "$historical/tuicr"
export CHECK_MISE_LOG="$tmp/mise.log" CHECK_NPM_LOG="$tmp/npm.log"

run_check() {
  local selected="$1"
  : > "$CHECK_MISE_LOG"
  : > "$CHECK_NPM_LOG"
  env PATH="$commands:$modern:/usr/bin:/bin" HOME="$tmp/home" \
    CHECK_HISTORICAL_DIRECTORY="$selected" \
    "$fixture/dotfiles" check > "$tmp/check.log" 2>&1
}

if ! run_check "$historical"; then cat "$tmp/check.log" >&2; fail 'public check failed despite installed historical Tuicr'; fi
assert_contains "$(cat "$CHECK_NPM_LOG")" "$fixture/config/flow|tuicr 0.19.0"
assert_contains "$(cat "$CHECK_NPM_LOG")" "$fixture/tools/flow|tuicr 0.19.0"
assert_contains "$(cat "$CHECK_NPM_LOG")" "$fixture/tools/drovr|tuicr 0.27.0"
assert_contains "$(cat "$CHECK_MISE_LOG")" 'where github:agavra/tuicr@0.19.0'
echo 'ok - public check uses historical Tuicr only inside Flow validation'

assert_prerequisite_rejection() {
  local selected="$1"
  local message="$2"
  if run_check "$selected"; then fail 'public check accepted an unavailable or invalid historical prerequisite'; fi
  assert_contains "$(cat "$tmp/check.log")" "$message"
  assert_contains "$(cat "$tmp/check.log")" 'config/flow/qualification/README.md'
  [[ ! -s "$CHECK_NPM_LOG" ]] || fail 'package suites started before prerequisite rejection'
  [[ "$(cat "$CHECK_MISE_LOG")" == 'where github:agavra/tuicr@0.19.0' ]] \
    || fail 'prerequisite discovery attempted more than installed-only lookup'
}
assert_prerequisite_rejection '' 'Flow prerequisite missing'
echo 'ok - missing historical Tuicr fails actionably before package suites'
assert_prerequisite_rejection "$modern" 'Flow prerequisite invalid'
echo 'ok - current Tuicr cannot substitute for the historical path'
printf '#!/bin/bash\nprintf "tuicr 0.27.0\\n"\n' > "$historical/tuicr"
assert_prerequisite_rejection "$historical" 'must report tuicr 0.19.0'
echo 'ok - wrong historical executable version fails before package suites'

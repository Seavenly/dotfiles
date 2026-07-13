#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
fake_bin="$tmp/bin"
mkdir -p "$home/.local/bin" "$fake_bin"

# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\\n" "$*" >> "$BREW_TEST_LOG"' \
  '[[ "$*" == "list --formula bat" ]] && exit 0' \
  '[[ "$1" == list ]] && exit 1' \
  'exit 0' \
  > "$fake_bin/brew"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "${MISE_WHICH_OK:-0}" == 1 ]]' \
  > "$home/.local/bin/mise"
chmod +x "$fake_bin/brew" "$home/.local/bin/mise"

migration="$root/internal/migrations/007-homebrew-overlaps.sh"
brew_log="$tmp/brew.log"

: > "$brew_log"
if HOME="$home" PATH="$fake_bin:/usr/bin:/bin" BREW_TEST_LOG="$brew_log" \
  DOTFILES_ROOT="$root" DOTFILES_OS=Darwin DOTFILES_YES=1 MISE_WHICH_OK=0 \
  "$migration" >/dev/null 2>&1; then
  fail "Homebrew migration removed bat without a mise replacement"
else
  status=$?
fi
[[ $status -eq 75 ]] || fail "Homebrew migration did not defer a missing replacement"
assert_not_contains "$(cat "$brew_log")" 'uninstall --formula'
echo "ok - Homebrew migration defers until mise replacements exist"

: > "$brew_log"
if HOME="$home" PATH="$fake_bin:/usr/bin:/bin" BREW_TEST_LOG="$brew_log" \
  DOTFILES_ROOT="$root" DOTFILES_OS=Darwin DOTFILES_YES=0 MISE_WHICH_OK=1 \
  "$migration" </dev/null >/dev/null 2>&1; then
  fail "Homebrew migration removed bat without noninteractive consent"
else
  status=$?
fi
[[ $status -eq 75 ]] || fail "Homebrew migration did not defer without consent"
assert_not_contains "$(cat "$brew_log")" 'uninstall --formula'
echo "ok - Homebrew migration requires consent before removal"

: > "$brew_log"
HOME="$home" PATH="$fake_bin:/usr/bin:/bin" BREW_TEST_LOG="$brew_log" \
  DOTFILES_ROOT="$root" DOTFILES_OS=Darwin DOTFILES_YES=1 MISE_WHICH_OK=1 \
  "$migration" >/dev/null
assert_contains "$(cat "$brew_log")" 'uninstall --formula bat'
assert_contains "$(cat "$brew_log")" 'autoremove'
echo "ok - Homebrew migration removes approved overlaps after replacement checks"

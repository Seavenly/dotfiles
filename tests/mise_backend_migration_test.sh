#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

# Resolve Node before isolating mise state so pre-links still exercises the real
# profile preflight without asking the host mise shim to use the empty fixture.
node_bin="$(mise which node)"
node_dir="$(dirname "$node_bin")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export XDG_CONFIG_HOME="$tmp/config"
export XDG_STATE_HOME="$tmp/state"
export MISE_DATA_DIR="$tmp/mise-data"
export DOTFILES_CONTEXT_OS=Linux
export DOTFILES_CONTEXT_ARCH=x86_64
export MISE_TEST_LOG="$tmp/mise.log"
export PATH="$node_dir:$PATH"
mkdir -p "$HOME/.local/bin" "$XDG_STATE_HOME/dotfiles/migrations"

# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\n" "$*" >> "$MISE_TEST_LOG"' \
  'while [[ ${1:-} == -* ]]; do' \
  '  [[ "$1" == -C ]] && shift 2 || shift' \
  'done' \
  'case "${1:-} ${2:-}" in' \
  '  "uninstall --all") rm -rf "$MISE_DATA_DIR/installs/$3" ;;' \
  '  "plugins uninstall")' \
  '    shift 2' \
  '    for plugin in "$@"; do' \
  '      rm -rf "$MISE_DATA_DIR/plugins/$plugin"' \
  '    done' \
  '    ;;' \
  'esac' \
  > "$HOME/.local/bin/mise"
chmod +x "$HOME/.local/bin/mise"

make_plugin() {
  local name="$1"
  local remote="$2"
  mkdir -p "$MISE_DATA_DIR/plugins/$name"
  git -C "$MISE_DATA_DIR/plugins/$name" init -q
  git -C "$MISE_DATA_DIR/plugins/$name" remote add origin "$remote"
}

make_legacy_install() {
  local tool="$1"
  local backend="$2"
  mkdir -p "$MISE_DATA_DIR/installs/$tool/legacy"
  printf 'short = "%s"\nfull = "%s"\nexplicit_backend = true\n' \
    "$tool" "$backend" > "$MISE_DATA_DIR/installs/$tool/.mise.backend.toml"
}

make_plugin lua https://github.com/mise-plugins/mise-lua
make_plugin tmux https://github.com/mise-plugins/mise-tmux.git
make_legacy_install lua asdf:lua
make_legacy_install tmux asdf:tmux
rm "$MISE_DATA_DIR/installs/tmux/.mise.backend.toml"
printf '%s\n' 'asdf:mise-plugins/mise-tmux' \
  > "$MISE_DATA_DIR/installs/tmux/.mise.backend"

dry_run_output="$(DOTFILES_ROOT="$root" "$root/internal/migrate" --dry-run)"
assert_contains "$dry_run_output" 'Would reinstall lua with its locked mise backend.'
assert_contains "$dry_run_output" 'Would reinstall tmux with its locked mise backend.'
assert_contains "$dry_run_output" 'Would remove the legacy asdf lua plugin.'
assert_contains "$dry_run_output" 'Would remove the legacy asdf tmux plugin.'
[[ -d "$MISE_DATA_DIR/plugins/lua" && -d "$MISE_DATA_DIR/installs/lua" ]] \
  || fail "mise backend dry-run changed legacy state"
[[ ! -e "$XDG_STATE_HOME/dotfiles/migrations/014-mise-backends" ]] \
  || fail "mise backend dry-run recorded the migration"
echo "ok - mise backend dry-run reports changes without applying them"

DOTFILES_ROOT="$root" "$root/internal/bootstrap/pre-links"

[[ ! -e "$MISE_DATA_DIR/plugins/lua" ]] \
  || fail "legacy Lua plugin still blocks the vfox backend"
[[ ! -e "$MISE_DATA_DIR/plugins/tmux" ]] \
  || fail "legacy tmux plugin was not retired"
[[ ! -e "$MISE_DATA_DIR/installs/lua" ]] \
  || fail "legacy asdf Lua install was not removed"
[[ ! -e "$MISE_DATA_DIR/installs/tmux" ]] \
  || fail "legacy asdf tmux install was not removed"
assert_contains "$(cat "$MISE_TEST_LOG")" '-C'
assert_contains "$(cat "$MISE_TEST_LOG")" 'uninstall --all lua'
assert_contains "$(cat "$MISE_TEST_LOG")" 'uninstall --all tmux'
assert_contains "$(cat "$MISE_TEST_LOG")" 'plugins uninstall lua'
assert_contains "$(cat "$MISE_TEST_LOG")" 'plugins uninstall tmux'
marker="$XDG_STATE_HOME/dotfiles/migrations/014-mise-backends"
[[ -f "$marker" ]] || fail "mise backend migration was not recorded"
echo "ok - pre-links retires exact legacy asdf backend state"

calls_before="$(wc -l < "$MISE_TEST_LOG" | tr -d ' ')"
DOTFILES_ROOT="$root" "$root/internal/bootstrap/pre-links"
calls_after="$(wc -l < "$MISE_TEST_LOG" | tr -d ' ')"
[[ "$calls_after" == "$calls_before" ]] \
  || fail "completed mise backend migration ran more than once"
echo "ok - mise backend transition is idempotent"

rm -f "$marker"
make_plugin lua https://github.com/mise-plugins/vfox-lua.git
mkdir -p "$MISE_DATA_DIR/installs/lua/5.4.8" "$MISE_DATA_DIR/installs/tmux/3.7b"
printf 'short = "lua"\nfull = "vfox:lua"\nexplicit_backend = true\n' \
  > "$MISE_DATA_DIR/installs/lua/.mise.backend.toml"
printf 'short = "tmux"\nfull = "aqua:tmux/tmux-builds"\nexplicit_backend = true\n' \
  > "$MISE_DATA_DIR/installs/tmux/.mise.backend.toml"
calls_before="$(wc -l < "$MISE_TEST_LOG" | tr -d ' ')"
DOTFILES_ROOT="$root" "$root/internal/bootstrap/pre-links"
calls_after="$(wc -l < "$MISE_TEST_LOG" | tr -d ' ')"
[[ "$calls_after" == "$calls_before" ]] \
  || fail "current mise backends were unnecessarily reinstalled"
[[ -d "$MISE_DATA_DIR/plugins/lua" ]] \
  || fail "current vfox Lua plugin was removed"
[[ -d "$MISE_DATA_DIR/installs/lua/5.4.8" ]] \
  || fail "current vfox Lua install was removed"
[[ -d "$MISE_DATA_DIR/installs/tmux/3.7b" ]] \
  || fail "current aqua tmux install was removed"
echo "ok - mise backend migration preserves current managed state"

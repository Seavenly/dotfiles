#!/usr/bin/env bash
set -euo pipefail

# Changing HOME does not stop mise discovering configs above the repository.
# Keep convergence sources local while writing only into this test's fixture.
converge_test_dotfiles() (
  local repository_root="$1"
  local test_home="$2"
  local test_config_home="${3:-$test_home/.config}"
  local test_state_home="${4:-$test_home/.local/state}"
  local bootstrap_args=(dotfiles apply --yes)
  if (($# > 4)); then
    bootstrap_args=("${@:5}")
  fi
  local mise_directory="$test_home/.local/state/mise-convergence"
  local installed_data="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}"
  mkdir -p "$mise_directory/config" "$mise_directory/cache" "$mise_directory/state"
  : > "$mise_directory/config/config.toml"
  unset __MISE_DIFF __MISE_SHIM
  HOME="$test_home" XDG_CONFIG_HOME="$test_config_home" \
    XDG_STATE_HOME="$test_state_home" DOTFILES_ROOT="$repository_root" \
    MISE_CONFIG_DIR="$mise_directory/config" \
    MISE_GLOBAL_CONFIG_FILE="$mise_directory/config/config.toml" \
    MISE_CACHE_DIR="$mise_directory/cache" MISE_STATE_DIR="$mise_directory/state" \
    MISE_DATA_DIR="$installed_data" MISE_AUTO_INSTALL=false \
    MISE_CEILING_PATHS="$(dirname "$repository_root")" \
    MISE_TRUSTED_CONFIG_PATHS="$repository_root" \
    mise -C "$repository_root" -E linux bootstrap "${bootstrap_args[@]}"
)

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "expected output not to contain: $needle"
}

assert_status() {
  local actual="$1"
  local expected="$2"
  [[ "$actual" -eq "$expected" ]] || fail "expected status $expected, got $actual"
}

file_mode() {
  local path="$1"
  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

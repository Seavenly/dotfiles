#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
home="$tmp/home"
config_home="$tmp/config"
notes="$tmp/personal-notes"
mkdir -p "$home" "$config_home/dotfiles" "$notes/raw/meetings"
printf 'NOTES_DIR=%q\nPROJECTS_DIR=%q\n' "$notes" "$tmp/projects" \
  > "$config_home/dotfiles/paths.env"

set +e
output="$(HOME="$home" XDG_CONFIG_HOME="$config_home" \
  NOTES_DIR='' PROJECTS_DIR='' \
  "$root/bin/rec" clean 2>&1)"
status=$?
set -e

assert_status "$status" 1
assert_contains "$output" "No recordings found in $notes/raw/meetings"
echo "ok - recorder uses machine-local notes directory"

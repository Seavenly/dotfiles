#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: with-integration-lock.sh -- COMMAND [ARG...]' >&2
  exit 2
}

[[ ${1:-} == -- ]] || usage
shift
[[ $# -gt 0 ]] || usage

common_dir="$(git rev-parse --git-common-dir)"
if [[ $common_dir != /* ]]; then
  common_dir="$(cd "$common_dir" && pwd -P)"
fi
lock_dir="$common_dir/codex-feature-flow-runtime.integration-lock"
token="$(date -u +%Y%m%dT%H%M%SZ).$$.${RANDOM}"

if ! mkdir "$lock_dir" 2>/dev/null; then
  printf '%s\n' 'feature/flow-runtime integration is already owned:' >&2
  if [[ -f $lock_dir/owner ]]; then
    sed -n '1,20p' "$lock_dir/owner" >&2
  else
    printf '%s\n' "lock_path=$lock_dir" >&2
  fi
  exit 75
fi

cleanup() {
  if [[ -f $lock_dir/token ]] && [[ $(<"$lock_dir/token") == "$token" ]]; then
    rm -f "$lock_dir/owner" "$lock_dir/token"
    rmdir "$lock_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' "$token" > "$lock_dir/token"
{
  printf 'schema=dotfiles.aggregate-integration-lock/v1\n'
  printf 'target=refs/heads/feature/flow-runtime\n'
  printf 'pid=%s\n' "$$"
  printf 'host=%s\n' "$(hostname)"
  printf 'cwd=%s\n' "$PWD"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'command='
  printf '%q ' "$@"
  printf '\n'
} > "$lock_dir/owner"

"$@"

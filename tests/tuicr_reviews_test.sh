#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

reviews="$root/bin/tuicr-reviews"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export TUICR_REVIEWS_FILE="$tmp/reg.jsonl"

count_tmp() { find "$tmp" -maxdepth 1 -name 'reg.jsonl.tmp.*' | wc -l | tr -d ' '; }

live="$tmp/live-wt"
dead="$tmp/dead-wt"
mkdir -p "$live" "$dead"

# A live review, then a review whose worktree vanishes - recorded LAST so its
# stale line is the final one the cleanup stream reads. That trailing stale line
# used to make clean_stream exit non-zero and abort every write under `set -e`.
"$reviews" add --repo "$live" --worktree "$live" --base main --branch feat/live --slug live --summary "live one"
"$reviews" add --repo "$dead" --worktree "$dead" --base main --branch feat/dead --slug dead --summary "dead one"
rmdir "$dead"

set +e
output="$("$reviews" list 2>&1)"
status=$?
set -e
assert_status "$status" 0
assert_contains "$output" "feat/live"
assert_not_contains "$output" "feat/dead"
echo "ok - list prunes a trailing vanished-worktree entry and keeps live ones"

assert_not_contains "$(cat "$TUICR_REVIEWS_FILE")" "feat/dead"
assert_contains "$(cat "$TUICR_REVIEWS_FILE")" "feat/live"
echo "ok - the vanished entry is removed from the persisted store, not just the output"

# rm must actually persist (the bug made it a silent, exit-1 no-op).
set +e
"$reviews" rm --worktree "$live" --base main --branch feat/live
status=$?
set -e
assert_status "$status" 0
assert_not_contains "$(cat "$TUICR_REVIEWS_FILE")" "feat/live"
echo "ok - rm removes an entry and exits cleanly"

assert_status "$(count_tmp)" 0
echo "ok - no stray .tmp files leak from an aborted write"

# A store whose only entry is a vanished worktree must empty cleanly, not jam.
: > "$TUICR_REVIEWS_FILE"
gone="$tmp/gone-wt"
mkdir -p "$gone"
"$reviews" add --repo "$gone" --worktree "$gone" --base main --branch feat/gone --slug gone --summary "gone"
rmdir "$gone"
set +e
output="$("$reviews" list 2>&1)"
status=$?
set -e
assert_status "$status" 0
[[ -z "$output" ]] || fail "expected empty list output, got: $output"
echo "ok - a sole vanished-worktree entry prunes to an empty store"

echo "ok - tuicr-reviews registry survives trailing vanished-worktree entries"

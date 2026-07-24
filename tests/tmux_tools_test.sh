#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/testlib.sh
source "$root/tests/testlib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
fake_bin="$tmp/bin"
mkdir -p "$repo" "$fake_bin"

git -C "$repo" init -q -b main
git -C "$repo" config user.name Test
git -C "$repo" config user.email test@example.com
printf 'base\n' > "$repo/file"
git -C "$repo" add file
git -C "$repo" commit -qm base
git -C "$repo" switch -qc feature
printf 'feature\n' >> "$repo/file"
git -C "$repo" commit -qam feature

# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\\n" "$*" >> "$TMUX_TEST_LOG"' \
  'case "$1" in' \
  '  list-windows) ;;' \
  '  new-window) printf "3\\n" ;;' \
  'esac' \
  > "$fake_bin/tmux"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'awk '\''NF && !found { row = $0; found = 1 } END { if (found) print row }'\''' \
  > "$fake_bin/fzf"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\\n" "$*" >> "${REVIEW_TEST_LOG:-/dev/null}"' \
  'if [[ "$1" == list ]]; then' \
  '  printf "%s\\tmain\\tfeature\\towner/repo\\trun-one\\tcreated\\tsummary\\tfalse\\treview_ready\\tcurrent\\t%s\\t%s\\trun-one\\t\\tmanifest\\t/tmp/review.json\\n" "$REVIEW_WORKTREE" "$BASE_SHA" "$HEAD_SHA"' \
  'fi' \
  > "$fake_bin/tuicr-reviews"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'cat > "$CLIPBOARD_FILE"' \
  > "$fake_bin/pbcopy"
chmod +x "$fake_bin/tmux" "$fake_bin/fzf" "$fake_bin/tuicr-reviews" "$fake_bin/pbcopy"

tmux_log="$tmp/tmux.log"
: > "$tmux_log"
(
  cd "$repo"
  PATH="$fake_bin:$PATH" TMUX_TEST_LOG="$tmux_log" \
    "$root/bin/tmux-tuicr"
)
assert_contains "$(cat "$tmux_log")" 'tuicr -r "main...feature"'
assert_contains "$(cat "$tmux_log")" \
  'set-option -w -t :3 @tuicr_review main...feature'
echo "ok - local tuicr reviews use pull-request merge-base semantics"

: > "$tmux_log"
lines="$(PATH="$fake_bin:$PATH" TMUX_TEST_LOG="$tmux_log" REVIEW_WORKTREE="$repo" \
  BASE_SHA="$(git -C "$repo" rev-parse main)" HEAD_SHA="$(git -C "$repo" rev-parse feature)" \
  "$root/bin/tmux-review-inbox" --lines)"
assert_contains "$lines" 'review_ready'
assert_contains "$lines" 'run=run-one'
echo "ok - review inbox distinguishes lifecycle and run identity"

: > "$tmux_log"
PATH="$fake_bin:$PATH" TMUX_TEST_LOG="$tmux_log" REVIEW_WORKTREE="$repo" \
  BASE_SHA="$(git -C "$repo" rev-parse main)" HEAD_SHA="$(git -C "$repo" rev-parse feature)" \
  "$root/bin/tmux-review-inbox"
assert_contains "$(cat "$tmux_log")" \
  "tuicr -r \"$(git -C "$repo" rev-parse main)...$(git -C "$repo" rev-parse feature)\""
assert_contains "$(cat "$tmux_log")" \
  "set-option -w -t :3 @tuicr_rev $(git -C "$repo" rev-parse main)...$(git -C "$repo" rev-parse feature)"
echo "ok - manifest-backed reviews open their immutable SHA range"

clipboard="$tmp/clipboard"
copy_result="$(PATH="$fake_bin:$PATH" CLIPBOARD_FILE="$clipboard" \
  "$root/bin/tmux-review-inbox" --copy run-one)"
assert_contains "$(cat "$clipboard")" 'run-one'
assert_contains "$copy_result" 'copied: run-one'
echo "ok - review inbox copy preserves the pulled token interaction"

review_log="$tmp/reviews.log"
: > "$review_log"
PATH="$fake_bin:$PATH" REVIEW_TEST_LOG="$review_log" \
  "$root/bin/tmux-review-inbox" --approve local "$repo" main feature legacy
assert_contains "$(cat "$review_log")" \
  "toggle-approved --worktree $repo --base main --branch feature"
echo "ok - review inbox maps approval only to legacy registry entries"

: > "$review_log"
delete_env=(PATH="$fake_bin:$PATH" REVIEW_TEST_LOG="$review_log" TMPDIR="$tmp")
env "${delete_env[@]}" "$root/bin/tmux-review-inbox" \
  --maybe-delete local "$repo" main feature manifest /tmp/review.json >/dev/null
assert_not_contains "$(cat "$review_log")" 'rm --manifest'
env "${delete_env[@]}" "$root/bin/tmux-review-inbox" \
  --maybe-delete local "$repo" main feature manifest /tmp/review.json >/dev/null
assert_contains "$(cat "$review_log")" 'rm --manifest /tmp/review.json'
echo "ok - review inbox requires two presses and removes only the selected manifest projection"

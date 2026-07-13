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
  '[[ "$1" == list ]]' \
  'printf "%s\\tmain\\tfeature\\towner/repo\\tslug\\tcreated\\tsummary\\n" "$REVIEW_WORKTREE"' \
  > "$fake_bin/tuicr-reviews"
chmod +x "$fake_bin/tmux" "$fake_bin/fzf" "$fake_bin/tuicr-reviews"

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
PATH="$fake_bin:$PATH" TMUX_TEST_LOG="$tmux_log" REVIEW_WORKTREE="$repo" \
  "$root/bin/tmux-tuicr-reviews"
assert_contains "$(cat "$tmux_log")" 'tuicr -r "main...feature"'
assert_contains "$(cat "$tmux_log")" \
  'set-option -w -t :3 @tuicr_rev main...feature'
echo "ok - recorded tuicr reviews use pull-request merge-base semantics"

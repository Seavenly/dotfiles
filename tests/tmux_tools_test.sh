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
  'if [[ " $* " == *" --accept-nth=1 "* ]]; then' \
  '  awk -F '\''\t'\'' '\''NF && !found { row = $1; found = 1 } END { if (found) print row }'\''' \
  'else' \
  '  awk '\''NF && !found { row = $0; found = 1 } END { if (found) print row }'\''' \
  'fi' \
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
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" "$*" >> "$PROJECT_SWITCH_LOG"' \
  > "$fake_bin/sesh"
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\n" "$*" >> "$HERDR_TEST_LOG"' \
  'case "$1 $2" in' \
  '  "workspace list")' \
  '    if [[ -n "${HERDR_WORKSPACES_JSON:-}" ]]; then printf "%s\n" "$HERDR_WORKSPACES_JSON"; else printf '\''%s\n'\'' '\''{"result":{"workspaces":[]}}'\''; fi' \
  '    ;;' \
  '  "pane list")' \
  '    if [[ -n "${HERDR_PANES_JSON:-}" ]]; then printf "%s\n" "$HERDR_PANES_JSON"; else printf '\''%s\n'\'' '\''{"result":{"panes":[]}}'\''; fi' \
  '    ;;' \
  '  "tab create") printf "%s\n" '\''{"result":{"root_pane":{"pane_id":"pane-new"},"tab":{"tab_id":"tab-new"}}}'\'' ;;' \
  'esac' \
  > "$fake_bin/herdr"
chmod +x \
  "$fake_bin/tmux" \
  "$fake_bin/fzf" \
  "$fake_bin/tuicr-reviews" \
  "$fake_bin/pbcopy" \
  "$fake_bin/sesh" \
  "$fake_bin/herdr"

projects="$tmp/projects"
project="$projects/owner/project"
mkdir -p "$project/.git"
project_switch_log="$tmp/project-switch.log"
: > "$project_switch_log"
PATH="$fake_bin:$PATH" PROJECTS_DIR="$projects" \
  PROJECT_SWITCH_LOG="$project_switch_log" \
  "$root/bin/project-switcher" --backend tmux
assert_contains "$(cat "$project_switch_log")" "connect $project"
echo "ok - project switcher delegates selected projects to tmux"

herdr_log="$tmp/herdr.log"
: > "$herdr_log"
PATH="$fake_bin:$PATH" PROJECTS_DIR="$projects" HERDR_TEST_LOG="$herdr_log" \
  HERDR_WORKSPACES_JSON="{\"result\":{\"workspaces\":[{\"workspace_id\":\"workspace-existing\",\"worktree\":{\"checkout_path\":\"$project\"}}]}}" \
  "$root/bin/project-switcher" --backend herdr
assert_contains "$(cat "$herdr_log")" 'workspace focus workspace-existing'
assert_not_contains "$(cat "$herdr_log")" 'workspace create'
echo "ok - project switcher focuses an existing Herdr workspace"

: > "$herdr_log"
PATH="$fake_bin:$PATH" PROJECTS_DIR="$projects" HERDR_TEST_LOG="$herdr_log" \
  "$root/bin/project-switcher" --backend herdr
assert_contains "$(cat "$herdr_log")" \
  "workspace create --cwd $project --label owner/project --focus"
echo "ok - project switcher creates a missing Herdr workspace"

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

base_sha="$(git -C "$repo" rev-parse main)"
head_sha="$(git -C "$repo" rev-parse feature)"
: > "$herdr_log"
PATH="$fake_bin:$PATH" HERDR_TEST_LOG="$herdr_log" \
  HERDR_ACTIVE_WORKSPACE_ID=workspace-current REVIEW_WORKTREE="$repo" \
  BASE_SHA="$base_sha" HEAD_SHA="$head_sha" \
  "$root/bin/review-inbox" --backend herdr
assert_contains "$(cat "$herdr_log")" \
  "tab create --workspace workspace-current --cwd $repo --label tuicr:feature --focus"
assert_contains "$(cat "$herdr_log")" \
  "pane report-metadata pane-new --source dotfiles-review-inbox --token review_worktree=$repo --token review_revset=$base_sha...$head_sha"
assert_contains "$(cat "$herdr_log")" "pane run pane-new zsh -i -c"
assert_contains "$(cat "$herdr_log")" "$base_sha...$head_sha"
echo "ok - review inbox creates and identifies Herdr review tabs"

: > "$herdr_log"
PATH="$fake_bin:$PATH" HERDR_TEST_LOG="$herdr_log" \
  HERDR_ACTIVE_WORKSPACE_ID=workspace-current REVIEW_WORKTREE="$repo" \
  BASE_SHA="$base_sha" HEAD_SHA="$head_sha" \
  HERDR_PANES_JSON="{\"result\":{\"panes\":[{\"tab_id\":\"tab-existing\",\"tokens\":{\"review_worktree\":\"$repo\",\"review_revset\":\"$base_sha...$head_sha\"}}]}}" \
  "$root/bin/review-inbox" --backend herdr
assert_contains "$(cat "$herdr_log")" 'tab focus tab-existing'
assert_not_contains "$(cat "$herdr_log")" 'tab create'
echo "ok - review inbox focuses an existing Herdr review tab"

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

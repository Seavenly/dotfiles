#!/usr/bin/env bash
# Cockpit teardown — reverses everything setup.sh did to ~/.claude/settings.json.
# Optionally purges state files. Idempotent.
#
# By default leaves your state directory in place (in case you change your
# mind and want history). Pass --purge-state to delete it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)/claude/hooks/cockpit-hook.sh"
SETTINGS="$HOME/.claude/settings.json"
STATE_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/cockpit"

PURGE_STATE=0
for arg in "$@"; do
  case "$arg" in
    --purge-state) PURGE_STATE=1 ;;
    -h|--help)
      cat <<EOF
Usage: teardown.sh [--purge-state]

Removes cockpit-hook entries from ~/.claude/settings.json. Other hooks
(e.g. notify.sh) are preserved.

  --purge-state    Also delete $STATE_ROOT (chat history & archive).
EOF
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ ! -f "$SETTINGS" ]]; then
  say "$SETTINGS does not exist — nothing to remove"
else
  say "Removing cockpit-hook entries from $SETTINGS"
  cp "$SETTINGS" "$SETTINGS.tmp.bak"

  # For each event:
  #   - drop matcher entries whose hooks all reference our command
  #   - within remaining matchers, filter out our command
  # Then drop the event entirely if no matchers remain.
  jq --arg cmd "$HOOK_PATH" '
    def clean_event:
      map(.hooks |= map(select(.command != $cmd)))
      | map(select((.hooks // []) | length > 0));

    if .hooks then
      .hooks |= with_entries(
        .value |= clean_event
        | select((.value | length) > 0)
      )
      # If hooks ended up empty, drop the key entirely.
      | if (.hooks | length) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS" > "$SETTINGS.tmp"

  if ! diff -q "$SETTINGS" "$SETTINGS.tmp" >/dev/null 2>&1; then
    mv "$SETTINGS.tmp" "$SETTINGS"
    say "settings.json updated"
  else
    rm -f "$SETTINGS.tmp"
    say "settings.json had no cockpit-hook entries (no changes)"
  fi
  rm -f "$SETTINGS.tmp.bak"
fi

# State dir handling
if (( PURGE_STATE )); then
  if [[ -d "$STATE_ROOT" ]]; then
    say "Deleting state directory $STATE_ROOT"
    rm -rf "$STATE_ROOT"
  else
    say "State directory $STATE_ROOT already absent"
  fi
else
  if [[ -d "$STATE_ROOT" ]]; then
    cat <<EOF

State directory left intact at:
  $STATE_ROOT

To delete it (chat goal labels & archive will be lost):
  $SCRIPT_DIR/teardown.sh --purge-state
  # or simply: rm -rf "$STATE_ROOT"
EOF
  fi
fi

cat <<EOF

Cockpit teardown complete.

In-repo files (the cockpit binary, hooks, sketchybar plugin, tmux.conf
edits, PATH entry) are managed in ~/.dotfiles. To remove them too, revert
the relevant commits or remove the files manually:

  • tools/cockpit/                     (CLI + lib + setup/teardown)
  • claude/hooks/cockpit-hook.sh       (hook script)
  • sketchybar/plugins/cockpit.sh      (status widget)
  • Edits in tmux.conf (status-right, status-interval, bind-key o)
  • Edits in zshrc/preinit.sh (PATH entry)
  • Edits in sketchybar/sketchybarrc   (cockpit item registration)

Then run \`tmux source-file ~/.tmux.conf\` and \`sketchybar --reload\`
to refresh those surfaces.
EOF

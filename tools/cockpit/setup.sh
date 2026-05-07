#!/usr/bin/env bash
# Cockpit setup — installs out-of-repo side-effects so the cockpit works
# end-to-end. Idempotent: safe to run multiple times.
#
# In-repo wiring (tmux.conf, sketchybar config, zsh PATH, claude/hooks symlink)
# is handled by dotbot via ./install. This script handles only what dotbot
# can't: patching ~/.claude/settings.json and creating state dirs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)/claude/hooks/cockpit-hook.sh"
SETTINGS="$HOME/.claude/settings.json"
STATE_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/cockpit"

EVENTS=(SessionStart UserPromptSubmit PreToolUse Stop Notification SessionEnd)

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Dependency check
say "Checking dependencies"
missing=()
for dep in jq fzf tmux; do
  command -v "$dep" >/dev/null 2>&1 || missing+=("$dep")
done
if (( ${#missing[@]} )); then
  fail "missing required tools: ${missing[*]} (install via brew/mise)"
fi

# 2. Hook file present
say "Verifying hook script at $HOOK_PATH"
[[ -f "$HOOK_PATH" ]] || fail "hook script not found — did you run ./install?"
[[ -x "$HOOK_PATH" ]] || chmod +x "$HOOK_PATH"

# 3. State directories
say "Creating state directories under $STATE_ROOT"
mkdir -p "$STATE_ROOT/sessions" "$STATE_ROOT/archive"

# 4. Patch ~/.claude/settings.json idempotently
say "Patching $SETTINGS"
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

# Backup once (don't clobber an existing pre-cockpit backup)
BACKUP="$SETTINGS.bak.cockpit"
if [[ ! -f "$BACKUP" ]]; then
  cp "$SETTINGS" "$BACKUP"
  say "Wrote backup at $BACKUP"
else
  say "Backup already exists at $BACKUP (leaving in place)"
fi

# Build a jq program that ensures, for each event, the cockpit-hook command
# is present in the first matcher's hooks array. If the event isn't present,
# add it. If the matcher isn't present, add it. If the command is already
# there, no-op.
EVENTS_JSON=$(printf '%s\n' "${EVENTS[@]}" | jq -R . | jq -s .)

jq \
  --arg cmd "$HOOK_PATH" \
  --argjson events "$EVENTS_JSON" \
  '
  def ensure_hook($evt; $cmd):
    .hooks //= {}
    | if (.hooks[$evt] // []) | length == 0 then
        .hooks[$evt] = [{hooks:[{type:"command", command:$cmd}]}]
      elif (.hooks[$evt][0].hooks // [] | map(.command) | index($cmd)) then
        .  # already registered
      else
        .hooks[$evt][0].hooks += [{type:"command", command:$cmd}]
      end;
  reduce $events[] as $e (.; ensure_hook($e; $cmd))
  ' "$SETTINGS" > "$SETTINGS.tmp"

if ! diff -q "$SETTINGS" "$SETTINGS.tmp" >/dev/null 2>&1; then
  mv "$SETTINGS.tmp" "$SETTINGS"
  say "settings.json updated"
else
  rm -f "$SETTINGS.tmp"
  say "settings.json already configured (no changes)"
fi

# 5. Done
cat <<EOF

Cockpit setup complete.

Next steps:
  • New shells will pick up the cockpit binary on PATH automatically.
    For the current shell:  source ~/.dotfiles/zshrc/preinit.sh
  • Reload tmux config to activate status-line + popup keybind:
                            tmux source-file ~/.dotfiles/tmux.conf
  • Reload sketchybar to show the cockpit widget:
                            sketchybar --reload
  • New Claude Code sessions will be tracked. Existing in-flight sessions
    were started before the hook was registered and won't appear until
    they restart (this is intentional — avoids partial state).

Open the cockpit:           tmux prefix + o   (or just: cockpit)
Tear down:                  $SCRIPT_DIR/teardown.sh
EOF

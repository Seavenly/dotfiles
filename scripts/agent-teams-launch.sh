#!/usr/bin/env bash
# Helper for agent-teams flows. Wraps `sbx create + settings overlay +
# sbx run` so the inner Claude session has the Agent Teams config.
#
# sbx writes its own agent-template settings.json after kit files land and
# after startup hooks run, clobbering anything the kit ships in
# files/home/.claude/settings.json. The overlay step here patches that
# settings.json *after* sbx has finalized it but *before* we attach with
# `sbx run`. The patch is idempotent.
#
# Usage:
#   agent-teams-launch.sh <name> <slash-cmd-with-args> -- <sbx-create-args...>
#
# Example:
#   agent-teams-launch.sh agt-spike-foo '/spike-flow /work/brief.md' \
#     -- claude /path/to/run-dir /path/to/repo:ro \
#        --kit ~/.dotfiles/claude/agent-teams-kit

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <name> <slash-cmd> -- <sbx-create-args...>" >&2
  exit 1
fi

NAME="$1"
SLASH_CMD="$2"
shift 2

if [[ "$1" != "--" ]]; then
  echo "error: expected '--' before sbx-create args" >&2
  exit 1
fi
shift

# Step 1 — create the sandbox (no attach). Reuses an existing sandbox of
# the same name if present (sbx create will error; that's the trigger to
# skip straight to step 3).
if ! sbx ls 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$NAME"; then
  sbx create "$@" --name "$NAME"
fi

# Step 2 — overlay Agent Teams config into the sandbox's settings.json.
# Idempotent; safe to re-run on every launch.
sbx exec "$NAME" -- sh -c '
  SETTINGS=/home/agent/.claude/settings.json
  [ -f "$SETTINGS" ] || echo "{}" > "$SETTINGS"
  jq ". + {
        env: ((.env // {}) + {\"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\": \"1\"}),
        teammateMode: \"tmux\"
      }" "$SETTINGS" > "${SETTINGS}.tmp" \
    && mv "${SETTINGS}.tmp" "$SETTINGS"
'

# Step 3 — attach and run the slash command. After the session ends, keep
# the tmux window open so the user can review final state.
sbx run "$NAME" -- "$SLASH_CMD"
echo "---"
echo "sandbox exited; press enter to close"
read -r

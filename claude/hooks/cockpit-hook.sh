#!/usr/bin/env bash
# Cockpit hook for Claude Code. Single script registered for multiple events:
# SessionStart, UserPromptSubmit, PreToolUse, Stop, Notification, SessionEnd.
#
# Reads the event JSON from stdin, then writes/updates a per-chat state file
# at $XDG_DATA_HOME/cockpit/sessions/<session_id>.json.

set -u

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/cockpit/lib" && pwd)/state.sh"
# shellcheck source=/dev/null
source "$LIB"

INPUT=$(cat)
EVENT=$(jq -r '.hook_event_name // "unknown"' <<<"$INPUT")
SID=$(jq -r '.session_id // empty' <<<"$INPUT")

# No session id = nothing to track. Bail silently to avoid breaking Claude.
[[ -z "$SID" ]] && exit 0

NOW=$(cockpit_now)

# Short, single-line summary of a PreToolUse event. ~60 chars max.
summarize_tool_use() {
  local tool input desc
  tool=$(jq -r '.tool_name // "?"' <<<"$INPUT")
  input=$(jq -c '.tool_input // {}' <<<"$INPUT")
  case "$tool" in
    Bash)
      desc=$(jq -r '.command // ""' <<<"$input" | head -n1)
      ;;
    Edit|Write|Read|NotebookEdit)
      desc=$(jq -r '.file_path // ""' <<<"$input")
      desc=${desc##*/}
      ;;
    Grep|Glob)
      desc=$(jq -r '.pattern // ""' <<<"$input")
      ;;
    WebFetch)
      desc=$(jq -r '.url // ""' <<<"$input")
      ;;
    Task|Agent)
      desc=$(jq -r '.description // .subagent_type // ""' <<<"$input")
      ;;
    *)
      desc=""
      ;;
  esac
  if [[ -n "$desc" ]]; then
    printf '%s: %s' "$tool" "${desc:0:60}"
  else
    printf '%s' "$tool"
  fi
}

# All events except SessionStart only update existing state. This avoids
# creating partial state for sessions that started before the hook was
# installed (where SessionStart was never recorded).
if [[ "$EVENT" != "SessionStart" && "$EVENT" != "SessionEnd" ]]; then
  state_file="$(cockpit_state_file "$SID")"
  [[ -f "$state_file" ]] || exit 0
fi

case "$EVENT" in
  SessionStart)
    cwd=$(jq -r '.cwd // ""' <<<"$INPUT")
    transcript=$(jq -r '.transcript_path // ""' <<<"$INPUT")
    tmux_ctx=$(cockpit_tmux_context)
    # Only set created_at if the file doesn't already exist (claude --resume).
    existing=$(cockpit_read "$SID")
    created=$(jq -r '.created_at // empty' <<<"$existing")
    [[ -z "$created" ]] && created="$NOW"
    jq -nc \
      --arg id "$SID" \
      --arg tool "claude" \
      --arg cwd "$cwd" \
      --arg transcript "$transcript" \
      --argjson tmux "$tmux_ctx" \
      --argjson created "$created" \
      --argjson now "$NOW" \
      '{id:$id, tool:$tool, goal:"", status:"idle", current_action:"",
        cwd:$cwd, transcript_path:$transcript,
        created_at:$created, updated_at:$now} + $tmux' \
      | cockpit_write "$SID"
    ;;

  UserPromptSubmit)
    prompt=$(jq -r '.prompt // ""' <<<"$INPUT")
    # Skip slash-commands when capturing goal (they're meta, not the task).
    is_slash="false"
    [[ "$prompt" == /* ]] && is_slash="true"
    cockpit_update "$SID" '
      .status = "working"
      | .current_action = ""
      | .updated_at = ($now|tonumber)
      | if (.goal // "") == "" and $is_slash != "true"
        then .goal = ($prompt | gsub("\\s+"; " ") | .[0:60])
        else . end
    ' --arg prompt "$prompt" --arg is_slash "$is_slash" --arg now "$NOW"
    ;;

  PreToolUse)
    action=$(summarize_tool_use)
    cockpit_update "$SID" '
      .status = "working"
      | .current_action = $action
      | .updated_at = ($now|tonumber)
    ' --arg action "$action" --arg now "$NOW"
    ;;

  Stop)
    cockpit_update "$SID" '
      .status = "waiting"
      | .current_action = ""
      | .updated_at = ($now|tonumber)
    ' --arg now "$NOW"
    ;;

  Notification)
    msg=$(jq -r '.params.message // .message // "Notification"' <<<"$INPUT")
    cockpit_update "$SID" '
      .status = "blocked"
      | .current_action = $msg
      | .updated_at = ($now|tonumber)
    ' --arg msg "$msg" --arg now "$NOW"
    ;;

  SessionEnd)
    cockpit_archive "$SID"
    ;;

  *)
    : # ignore unknown events
    ;;
esac

exit 0

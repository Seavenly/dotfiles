#!/bin/bash
# Claude Code notification hook
# Fires on Stop (Claude finished turn) and Notification events

notify() {
  local title=$1 body=$2

  if [[ -n "${TMUX}" ]]; then
    printf "\ePtmux;\e\e]2;%s\a\e\\" "${title}" > /dev/tty
    printf "\ePtmux;\e\e]9;%s\a\e\\" "${body}" > /dev/tty
  else
    printf "\e]2;%s\a\e]9;%s\a" "${title}" "${body}" > /dev/tty
  fi
}

INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')

case "$EVENT" in
  "Stop")
    notify "Claude Code" "Waiting for input"
    ;;
  "Notification")
    MSG=$(echo "$INPUT" | jq -r '.params.message // .message // "Notification"')
    notify "Claude Code" "$MSG"
    ;;
  *)
    exit 0
    ;;
esac

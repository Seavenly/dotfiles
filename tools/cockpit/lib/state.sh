#!/usr/bin/env bash
# Cockpit state helpers — atomic JSON state-file read/write under
# $XDG_DATA_HOME/cockpit/sessions/. Sourced by the hook and the CLI.
#
# A session-id is the unique chat identifier (claude session_id, or for other
# tools a generated UUID). One JSON file per active chat.

set -u

cockpit_root() {
  echo "${XDG_DATA_HOME:-$HOME/.local/share}/cockpit"
}

cockpit_sessions_dir() { echo "$(cockpit_root)/sessions"; }
cockpit_archive_dir()  { echo "$(cockpit_root)/archive"; }

cockpit_state_file() {
  echo "$(cockpit_sessions_dir)/$1.json"
}

cockpit_ensure_dirs() {
  mkdir -p "$(cockpit_sessions_dir)" "$(cockpit_archive_dir)"
}

# Read a state file, or empty object if missing.
cockpit_read() {
  local id="$1" f
  f=$(cockpit_state_file "$id")
  if [[ -f "$f" ]]; then
    cat "$f"
  else
    echo '{}'
  fi
}

# Atomically write JSON (read from stdin) to a session file.
cockpit_write() {
  local id="$1" f tmp
  cockpit_ensure_dirs
  f=$(cockpit_state_file "$id")
  tmp=$(mktemp "${f}.XXXXXX")
  cat > "$tmp"
  mv -f "$tmp" "$f"
}

# Apply a jq filter to a session file, atomically. Extra args after the filter
# are passed to jq (e.g. --arg foo bar).
cockpit_update() {
  local id="$1" filter="$2"; shift 2
  local current updated
  current=$(cockpit_read "$id")
  updated=$(jq -c "$@" "$filter" <<<"$current") || return 1
  printf '%s\n' "$updated" | cockpit_write "$id"
}

# Move a state file to archive/ (idempotent).
cockpit_archive() {
  local id="$1" f a
  f=$(cockpit_state_file "$id")
  a="$(cockpit_archive_dir)/$id.json"
  cockpit_ensure_dirs
  [[ -f "$f" ]] && mv -f "$f" "$a"
}

# Print all live session ids (one per line).
cockpit_list_ids() {
  local d
  d=$(cockpit_sessions_dir)
  [[ -d "$d" ]] || return 0
  shopt -s nullglob
  local f
  for f in "$d"/*.json; do
    basename "$f" .json
  done
}

# Check whether a tmux pane id (e.g. %17) still exists.
cockpit_pane_alive() {
  local pane="$1"
  [[ -z "$pane" ]] && return 1
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx -- "$pane"
}

# Capture current tmux context as JSON object (or empty obj if not in tmux).
# Used by the SessionStart hook.
cockpit_tmux_context() {
  if [[ -z "${TMUX:-}" || -z "${TMUX_PANE:-}" ]]; then
    echo '{}'
    return 0
  fi
  local fmt session window pane
  fmt='#{session_name}|#{window_index}|#{pane_id}'
  IFS='|' read -r session window pane < <(
    tmux display-message -t "$TMUX_PANE" -p "$fmt" 2>/dev/null
  )
  jq -nc \
    --arg s "${session:-}" \
    --arg w "${window:-}" \
    --arg p "${pane:-$TMUX_PANE}" \
    '{tmux_session:$s, tmux_window:$w, tmux_pane:$p}'
}

cockpit_now() { date +%s; }

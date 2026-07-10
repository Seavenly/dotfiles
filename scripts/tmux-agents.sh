#!/usr/bin/env bash
# Toggle a single global `claude agents` side pane that follows the user
# across tmux sessions. When hidden, the pane is parked in a detached
# scratch session named "_agents" so the process keeps running; when
# visible, it is joined as a horizontal split into the current window.

set -u

SCRATCH_SESSION="_agents"
SCRATCH_WINDOW="agents"
CMD="claude agents --permission-mode auto"
START_DIR="$HOME/dev"
OPT="@agents-pane-id"

ensure_scratch_session() {
  if ! tmux has-session -t "$SCRATCH_SESSION" 2>/dev/null; then
    # Placeholder window keeps the session alive when the agents pane is
    # joined away into a real window.
    tmux new-session -d -s "$SCRATCH_SESSION" -n placeholder
  fi
}

get_pane_id() {
  tmux show-options -gv "$OPT" 2>/dev/null
}

set_pane_id() {
  tmux set-option -g "$OPT" "$1"
}

clear_pane_id() {
  tmux set-option -gu "$OPT" 2>/dev/null
}

pane_exists() {
  tmux list-panes -a -F "#{pane_id}" 2>/dev/null | grep -qx "$1"
}

pane_window() {
  tmux list-panes -a -F "#{pane_id} #{session_name}:#{window_index}" \
    | awk -v id="$1" '$1==id {print $2; exit}'
}

current_window() {
  tmux display-message -p "#{session_name}:#{window_index}"
}

ensure_scratch_session

pane_id=$(get_pane_id)
if [ -n "$pane_id" ] && ! pane_exists "$pane_id"; then
  clear_pane_id
  pane_id=""
fi

if [ -z "$pane_id" ]; then
  pane_id=$(tmux new-window -d -P -F "#{pane_id}" -c "$START_DIR" \
    -t "${SCRATCH_SESSION}:" -n "$SCRATCH_WINDOW" \
    "zsh -i -c '$CMD'")
  set_pane_id "$pane_id"
fi

if [ "$(pane_window "$pane_id")" = "$(current_window)" ]; then
  tmux break-pane -d -s "$pane_id" -t "${SCRATCH_SESSION}:"
else
  tmux join-pane -h -s "$pane_id"
fi

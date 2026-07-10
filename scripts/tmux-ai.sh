#!/usr/bin/env bash

# Toggle a per-session AI assistant side pane.
#   $1: process pattern used to find an existing pane (grep on `ps`)
#   $2: optional shell command used when spawning a new pane (defaults to $1)
pattern="$1"
command="${2:-$1}"

# Find all process IDs running the AI assistant command
ai_assistant_pids=$(ps | grep "$pattern" | awk '{print $1}')

# Find all process IDs for each tmux pane in the current session
tmux_panes=$(tmux list-panes -s -F "#{pane_pid} #{window_index} #{pane_index}")

# Find the first tmux pane in the session that has a running AI assistant node process
while read -r pane_pid window_index pane_index; do
  for ai_assistant_pid in $ai_assistant_pids; do
      if [[ "$pane_pid" = "$ai_assistant_pid" ]]; then
        current_window_index=$(tmux display-message -p "#{window_index}")
        pane_info="$window_index.$pane_index"

        if [[ "$window_index" = "$current_window_index" ]]; then
            # The pane is currently focused in the current window
            tmux break-pane -d -n "$pattern" -s $pane_info -t 8
            exit 0
        fi

        tmux join-pane -h -s $pane_info
        exit 0
    fi
  done
done <<< "$tmux_panes"

# Open up AI assistant as a split in the current window
tmux split-window -h -c "#{pane_current_path}" "zsh -i -c '$command'"
exit 0

#!/usr/bin/env bash

# Search for existing gptui instnace
pane=$(tmux list-panes -a -F '#{pane_current_command}:#{session_name}:#{window_index}.#{pane_index}' | grep '^gptui')

if [[ -z $pane ]]; then
    # Build the command from latest source
    cd ~/dev/gptui
    log=$(go build -o ./build/gptui ./cmd/gptui 2>&1)

    if [[ $? -ne 0 ]]; then
        echo "$log"
        exit 1
    fi

    ./build/gptui
    # Open command in split view
    tmux split-window -h './build/gptui'
    
    exit 0
fi

pane_info=${pane#*:}
pane_window_info=${pane_info%.*}
current_window_info=$(tmux display-message -p "#{session_name}:#{window_index}")

if [[ "$pane_window_info" = "$current_window_info" ]]; then
    tmux break-pane -d -s $pane_info

    exit 0
fi

tmux join-pane -h -s $pane_info


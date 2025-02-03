#!/usr/bin/env bash

# Search for existing aider instnace
pane=$(tmux list-panes -s -F '#{pane_title}:#{window_index}.#{pane_index}' | grep '^aider')

if [[ -z $pane ]]; then
    # Open up aider as a split in the current window
    tmux split-window -h -c "#{pane_current_path}" "zsh -i -c 'aider'"

    # Set pane title so we can find it when searching for this pane above when hiding or retrieving it
    pane_info=$(tmux display-message -p "#{window_index}.#{pane_index}")
    tmux select-pane -t $pane_info -T aider
    
    exit 0
fi

# #{window_index}.#{pane_index}
pane_info=${pane#*:}
# #{window_index}
pane_window_info=${pane_info%.*}
# #{window_index}
current_window_info=$(tmux display-message -p "#{window_index}")

if [[ "$pane_window_info" = "$current_window_info" ]]; then
    # The pane is currently focused in the current window
    tmux break-pane -d -n aider -s $pane_info -t 8

    exit 0
fi

tmux join-pane -h -s $pane_info

#!/usr/bin/env bash

# Search for existing aider instnace
pane=$(tmux list-panes -s -F '#{pane_title}:#{window_index}.#{pane_index}' | grep '^lazygit')

if [[ -z $pane ]]; then
    tmux new-window -t 9 -c "#{pane_current_path}" -n lazygit "zsh -i -c 'lazygit'"

    # Set pane title so we can find it when searching for this pane above when hiding or retrieving it
    pane_info=$(tmux display-message -p "#{window_index}.#{pane_index}")
    tmux select-pane -t $pane_info -T lazygit
    
    exit 0
fi

# #{window_index}.#{pane_index}
pane_info=${pane#*:}

tmux select-window -t $pane_info

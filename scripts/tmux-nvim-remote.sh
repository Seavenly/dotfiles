#!/usr/bin/env bash

for arg in "$@"; do
    # Check if contains a remote arg to determine using `nvim` vs `nvr`
    if [[ $arg == *remote* ]]; then
        is_remote="true"
        break
    fi
done

if [[ $TMUX ]]; then
    dir=$(getconf DARWIN_USER_TEMP_DIR)

    if [[ $is_remote == "true" ]]; then
        # Search for first existing neovim instance in the current session
        read -r -a tmux_ids <<< $(tmux list-panes -s -F '#{pane_current_command}:#{session_id} #{window_id} #{pane_id}' | awk -F ":" '/^nvim:/ {print $2}' | head -n1)

        # If no instances exist
        if [[ -n $tmux_ids ]]; then
            session_id=${tmux_ids[0]}
            window_id=${tmux_ids[1]}
            pane_id=${tmux_ids[2]}

            nvr --servername "${dir}nvim.$USER.$session_id.$window_id.$pane_id" $@

            tmux select-window -t "$window_id"
            tmux select-pane -t "$pane_id"

            exit 0
        fi
    fi

    tmux_window=$(tmux display -p "#{session_id}.#{window_id}.#{pane_id}")
    nvim --listen "${dir}nvim.$USER.$tmux_window" $@
else
    if [[ $is_remote == "true" ]]; then
        nvr $@
        exit 0
    fi

    nvim $@
fi


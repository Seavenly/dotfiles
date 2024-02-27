#!/usr/bin/env bash

function nv() {
    local arguments=()

    for arg in "$@"; do
        # Check if contains a remote arg to determine using `nvim` vs `nvr`
        if [[ $arg == --remote* ]]; then
            local is_remote="true"
        fi

        if [[ $arg == --swap ]]; then
            local should_swap="true"
        else
            arguments+=("$arg")
        fi
    done

    local dir=$(getconf DARWIN_USER_TEMP_DIR)

    function open_tmux_nvim() {
        local tmux_window=$(tmux display -p "#{session_id}.#{window_id}.#{pane_id}")
        nvim --listen "${dir}nvim.$USER.$tmux_window" ${arguments[@]}
    } 

    if [[ -z $TMUX ]]; then
        if [[ $is_remote == "true" ]]; then
            nvr ${arguments[@]}
        else
            nvim ${arguments[@]}
        fi
        return 0
    fi

    if [[ $is_remote != "true" ]]; then
        open_tmux_nvim
        return 0
    fi

    local session_id window_id pane_id

    OLDIFS=$IFS
    IFS=" "
    # Search for first existing neovim instance in the current session
    read -r session_id window_id pane_id <<< $(tmux list-panes -s -F '#{pane_current_command}:#{session_id} #{window_id} #{pane_id}' | awk -F ":" '/^nvim:/ {print $2}' | head -n1)
    IFS=$OLDIFS

    # If no instances exist
    if [[ -z $pane_id ]]; then
        open_tmux_nvim
        return 0
    fi

    nvr --servername "${dir}nvim.$USER.$session_id.$window_id.$pane_id" ${arguments[@]}

    if [[ $should_swap == "true" ]]; then
        tmux select-window -t "$window_id"
        tmux select-pane -t "$pane_id"
    fi
}


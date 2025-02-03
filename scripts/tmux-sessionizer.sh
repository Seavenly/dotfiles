#!/usr/bin/env bash

if [[ $# -eq 1 ]]; then
    selected=$1
else
    find_result="${TMPDIR}session.txt"

    rm -f $find_result
    tmux display-popup -E "find ~/dev ~/dev/sandbox -name '.git' -mindepth 2 -maxdepth 2 -type d | xargs dirname | fzf --delimiter '/' --with-nth -2,-1 > $find_result"
    selected=$(cat $find_result)
fi

if [[ -z $selected ]]; then
    exit 0
fi

selected_name=$(basename "$selected" | tr . _)
tmux_running=$(pgrep tmux)

if [[ -z $TMUX ]] && [[ -z $tmux_running ]]; then
    tmux new-session -s $selected_name -c $selected
    exit 0
fi

if ! tmux has-session -t=$selected_name 2> /dev/null; then
    tmux new-session -ds $selected_name -c $selected
fi

tmux switch-client -t $selected_name

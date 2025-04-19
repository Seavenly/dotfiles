#!/usr/bin/env bash

if [[ $# -eq 1 ]]; then
    # specific project has been passed in to open
    selected=$1
elif [[ -z $TMUX ]]; then
    # executed outside of tmux when first connecting to session
    selected=$(find ~/dev ~/dev/sandbox -mindepth 2 -maxdepth 2 -type d -name '.git' | xargs dirname | fzf --delimiter '/' --with-nth -2,-1) 
else
    # find projects using tmux popup inside tmux session
    find_result="${TMPDIR}session.txt"

    rm -f $find_result
    tmux display-popup -E "find ~/dev ~/dev/sandbox -mindepth 2 -maxdepth 2 -type d -name '.git' | xargs dirname | fzf --delimiter '/' --with-nth -2,-1 > $find_result"
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

if [[ -z $TMUX ]]; then
    tmux a
fi

tmux switch-client -t $selected_name

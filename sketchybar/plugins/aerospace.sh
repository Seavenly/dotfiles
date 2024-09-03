#!/bin/zsh

source ./colors.sh
source ./icon_map.sh

change_workspace() {
    if [ -z "$FOCUSED_WORKSPACE" ]; then
        FOCUSED_WORKSPACE=$(aerospace list-workspaces --empty no --monitor focused --visible)
    fi

    # Focused item
    sketchybar --set "$FOCUSED_WORKSPACE.space.label" \
        background.color=$COLOR_PEACH_RED \
        label.color=$COLOR_SUMI_INK_0

    # Blurred item
    if [[ -n $PREV_WORKSPACE ]]; then
        sketchybar --set "$PREV_WORKSPACE.space.label" \
            background.color=$COLOR_SUMI_INK_4 \
            label.color=$COLOR_FUJI_WHITE
    fi
}

update_apps() {
    all_apps=$(aerospace list-windows --all --format "%{workspace}:%{app-name}")

    for sid in $(aerospace list-workspaces --all); do
        workspace_apps=$(echo $all_apps | grep "$sid:")

        if [ -z $workspace_apps ]; then
            sketchybar --set "$sid.space.icons" drawing=off label=$result \
                --set "$sid.space.label" drawing=off \
                --set "$sid.space.spacer" drawing=off \
                --set "$sid.space" drawing=off
            continue
        fi

        result=""
        while IFS= read -r line; do
            app=${line#*:}
            __icon_map $app
            if [ -z $icon_result ]; then
                result+="$app " 
            else
                result+="$icon_result " 
            fi
        done <<< $workspace_apps

        sketchybar --set "$sid.space.icons" drawing=on label=$result \
            --set "$sid.space.label" drawing=on \
            --set "$sid.space.spacer" drawing=on \
            --set "$sid.space" drawing=on
    done
}


init() {
    change_workspace
    update_apps
}

# echo "$SENDER"

case "$SENDER" in
"aerospace_workspace_change")
    change_workspace
    ;;
"front_app_switched")
    update_apps
    ;;
"forced") # called via `sketchybar --update` at the bottom of the config file
    init
    ;;
*)
    ;;
esac


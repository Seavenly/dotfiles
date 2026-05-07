#!/bin/sh

source ./colors.sh

COCKPIT="$HOME/.dotfiles/tools/cockpit/cockpit"

if [ ! -x "$COCKPIT" ]; then
    sketchybar --set "$NAME" drawing=off
    exit 0
fi

LABEL="$($COCKPIT summary 2>/dev/null)"

if [ -z "$LABEL" ]; then
    # No active chats — hide.
    sketchybar --set "$NAME" drawing=off
    exit 0
fi

# Pick icon color by most-attention-needed status.
case "$LABEL" in
    *"⚠️"*) ICON_COLOR=$COLOR_PEACH_RED   ;;  # blocked
    *"✉️"*) ICON_COLOR=$COLOR_CARP_YELLOW  ;;  # waiting
    *"⏳"*) ICON_COLOR=$COLOR_SPRING_BLUE  ;;  # working
    *)      ICON_COLOR=$COLOR_FUJI_WHITE   ;;
esac

# Strip the leading robot from the label since we render it as the icon.
LABEL="${LABEL#🤖 }"

sketchybar --set "$NAME" \
    drawing=on \
    icon="🤖" \
    icon.color=$ICON_COLOR \
    label="$LABEL"

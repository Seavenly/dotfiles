#!/bin/sh

export PATH="/opt/homebrew/bin:$HOME/.local/share/mise/shims:/usr/bin:/bin"

# The $NAME variable is passed from sketchybar and holds the name of
# the item invoking this script:
# https://felixkratz.github.io/SketchyBar/config/events#events-and-scripting

sketchybar --set "$NAME" label="$(date '+%a %b %-d %-I:%M %p')"

#!/bin/zsh

export PATH="/opt/homebrew/bin:$HOME/.local/share/mise/shims:/usr/bin:/bin"

CONFIG_DIR="${0:A:h:h}"
source "$CONFIG_DIR/colors.sh"

PIDFILE="${TMPDIR:-/tmp}/rec.pid"

hide() {
    sketchybar --set "$NAME" drawing=off update_freq=0
    exit 0
}

[ -f "$PIDFILE" ] || hide

mic_pid=$(head -1 "$PIDFILE")
kill -0 "$mic_pid" 2>/dev/null || hide

start=$(stat -f %m "$PIDFILE")
elapsed=$(( $(date +%s) - start ))
h=$(( elapsed / 3600 ))
m=$(( (elapsed % 3600) / 60 ))
s=$(( elapsed % 60 ))

if [ "$h" -gt 0 ]; then
    label=$(printf "REC %d:%02d:%02d" "$h" "$m" "$s")
else
    label=$(printf "REC %02d:%02d" "$m" "$s")
fi

sketchybar --set "$NAME" \
    drawing=on \
    update_freq=1 \
    icon="●" \
    icon.color="$COLOR_SAMURAI_RED" \
    label="$label"

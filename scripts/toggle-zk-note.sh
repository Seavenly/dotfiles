#!/usr/bin/env zsh
# Dual-mode zk note scratchpad toggle
# Usage: toggle-zk-note.sh new|prev

MODE="${1:-new}"
NOTES_DIR="$HOME/notes"
SOCKET="/tmp/nvim-zk-qt.sock"
QT_STATE="/tmp/qt-state"

# ─── AppleScript helpers ────────────────────────────────────────────────────

toggle_qt() {
    osascript 2>/dev/null <<'OSASCRIPT'
tell application "Ghostty"
    perform action "toggle_quick_terminal" on (item 1 of terminals)
end tell
OSASCRIPT
}

inject_text() {
    local text="$1"
    osascript 2>/dev/null <<OSASCRIPT
tell application "Ghostty"
    set allTerminals to terminals
    set winTerminalIDs to {}
    repeat with w in windows
        repeat with t in (terminals of w)
            set end of winTerminalIDs to (id of t)
        end repeat
    end repeat
    repeat with t in allTerminals
        if winTerminalIDs does not contain (id of t) then
            input text "${text}" to t
            send key "enter" to t
            return
        end if
    end repeat
end tell
OSASCRIPT
}

nvim_alive() {
    nvim --server "$SOCKET" --remote-expr '1' &>/dev/null
}

nvim_send() {
    local command="$1"
    nvim --server "$SOCKET" --remote-send "$command"
}

get_note_path() {
    local note_path
    if [[ "$MODE" == "new" ]]; then
        note_path=$(zk new --working-dir "$NOTES_DIR" --no-input --print-path 2>/dev/null)
    else
        note_path=$(zk list --working-dir "$NOTES_DIR" --sort modified- --limit 1 --format path 2>/dev/null)
    fi
    [[ "$note_path" != /* ]] && note_path="$NOTES_DIR/$note_path"
    echo "$note_path"
}

# ─── Main logic ─────────────────────────────────────────────────────────────

qt_visible=$(cat "$QT_STATE" 2>/dev/null)

toggle_qt

if [[ "$qt_visible" == "1" ]]; then
    echo 0 > "$QT_STATE"
    exit 0
fi

echo 1 > "$QT_STATE"
note_path=$(get_note_path)

if nvim_alive; then
    if [[ "$MODE" == "new" ]]; then
        nvim_send "<Esc>:e $note_path<CR>G"
    else
        nvim_send "<Esc>:w<CR>:e $note_path<CR>"
    fi
    exit 0
fi

# nvim not running — start it with the socket
inject_text "cd $NOTES_DIR && nvim --listen $SOCKET '$note_path'"
sleep 0.3
nvim_send "<Esc>:lua Snacks.zen()<CR>"

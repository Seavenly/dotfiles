#!/usr/bin/env bash
# Bullpen launcher for the agent-teams system.
# Bound to `prefix C-t` in tmux.conf.
#
# Idempotent:
#   - First call creates the agent-teams session with an _overview window.
#   - Subsequent calls just switch to it.
#
# See ~/.dotfiles/claude/AGENT-TEAMS.md for full system context.

set -euo pipefail

SESSION="agent-teams"
RUNS_DIR="${HOME}/.agent-teams/runs"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -n "_overview"
  # Overview pane: live-watch new run dirs appearing.
  mkdir -p "$RUNS_DIR"
  tmux send-keys -t "${SESSION}:_overview" \
    "watch -n 5 'echo \"agent-teams runs (most recent first):\"; ls -1t ${RUNS_DIR} 2>/dev/null | head -20'" C-m
fi

if [[ -z "${TMUX:-}" ]]; then
  tmux attach -t "$SESSION"
else
  tmux switch-client -t "$SESSION"
fi

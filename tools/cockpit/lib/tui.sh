#!/usr/bin/env bash
# Cockpit fzf-based TUI. Sourced by the `cockpit` entrypoint.
#
# Layout per row (TAB-delimited):
#   <visible>\t<id>
# where <visible> is a pre-formatted string and <id> is hidden from the user
# but accessible to bindings via {2}.

# Reads `cockpit rows` and produces a NUL-separated stream of multi-line
# records for fzf --read0:
#
#   <glyph> <status> <dir> <tool> <age>\n  <goal>\t<id>\0
#
# Field {1} (everything up to the tab) is the visible 2-line block.
# Field {2} (after the tab) is the id, hidden from display via --with-nth=1.
#
# Columns from cockpit_rows:
#   1=id 2=status 3=glyph 4=goal 5=action 6=tmux 7=cwdb 8=age 9=alive
cockpit_tui_format() {
  # ANSI: dim cyan for header line, default for goal line.
  cockpit_rows | awk -F'\t' '
    BEGIN { dim="\033[2m"; reset="\033[0m"; bold="\033[1m" }
    {
      id=$1; status=$2; glyph=$3; goal=$4; action=$5
      tmux=$6; cwdb=$7; age=$8; alive=$9
      if (alive=="0") glyph=glyph "✗"
      session=tmux; sub(/:.*/, "", session)
      dir = (cwdb != "") ? cwdb : session
      tool = "claude"   # placeholder for future codex/etc support
      if (goal == "") goal = "—"
      header = sprintf("%s %s  %s%s%s  %s%s%s  %s%s%s", \
                       glyph, status, \
                       bold, dir, reset, \
                       dim, tool, reset, \
                       dim, age, reset)
      goal_line = "  " goal
      printf "%s\n%s\t%s%c", header, goal_line, id, 0
    }
  '
}

# Render a preview pane for a given chat id: header + tail of transcript.
cockpit_tui_preview() {
  local id="${1:-}"
  [[ -z "$id" ]] && return 0
  local state goal status action transcript cwd tmux pane created updated
  state=$(cockpit_read "$id")
  if [[ "$state" == "{}" ]]; then
    echo "(no state)"
    return 0
  fi
  goal=$(jq -r '.goal // "—"' <<<"$state")
  status=$(jq -r '.status // "?"' <<<"$state")
  action=$(jq -r '.current_action // ""' <<<"$state")
  transcript=$(jq -r '.transcript_path // ""' <<<"$state")
  cwd=$(jq -r '.cwd // ""' <<<"$state")
  tmux=$(jq -r '"\(.tmux_session // "")\t\(.tmux_window // "")\t\(.tmux_pane // "")"' <<<"$state")
  pane=$(jq -r '.tmux_pane // ""' <<<"$state")
  created=$(jq -r '.created_at // 0' <<<"$state")
  updated=$(jq -r '.updated_at // 0' <<<"$state")

  printf 'GOAL    %s\n' "$goal"
  printf 'STATUS  %s%s\n' "$status" "$([[ -n "$action" ]] && printf ' — %s' "$action")"
  printf 'CWD     %s\n' "$cwd"
  printf 'TMUX    %s\n' "$(echo "$tmux" | tr '\t' ' ')"
  printf 'AGE     created %s, updated %s\n' \
    "$(ago "$created")" "$(ago "$updated")"
  printf 'PANE    %s\n' \
    "$(cockpit_pane_alive "$pane" && echo "alive" || echo "GONE (run cockpit clean)")"
  echo
  echo "── recent turns ──"
  if [[ -n "$transcript" && -f "$transcript" ]]; then
    cockpit_tui_render_turns "$transcript"
  else
    echo "(no transcript yet)"
  fi
}

# Render the last ~3 conversational turns from a Claude Code transcript.
# Skips tool_use, tool_result, and thinking blocks — only user prompts and
# assistant text replies. Preserves newlines, caps each turn at 6 lines.
cockpit_tui_render_turns() {
  local transcript="$1" max_turns=3 max_lines_per_turn=8
  local user_color=$'\033[1;36m' assistant_color=$'\033[1;35m' reset=$'\033[0m'
  # Pre-wrap text at word boundaries so fzf's preview doesn't break mid-word.
  # FZF_PREVIEW_COLUMNS is set by fzf when invoking preview commands.
  local wrap_cols=$(( ${FZF_PREVIEW_COLUMNS:-80} - 2 ))
  (( wrap_cols < 20 )) && wrap_cols=20

  # Extract turns as TSV: role<TAB>base64(text). base64 keeps newlines and
  # other special chars intact across the shell read.
  tail -n 200 "$transcript" 2>/dev/null \
    | jq -r '
        select(.type == "user" or .type == "assistant")
        | if .type == "user" then
            # Skip tool_result responses (those have content as an array of
            # objects). Plain user prompts have content as a string.
            if (.message.content | type == "string") then
              {role: "you", text: .message.content}
            else empty end
          else
            # Assistant: collect only text blocks, skip tool_use / thinking.
            (.message.content
             | if type == "array" then
                 [.[] | select(.type == "text") | .text]
               else [tostring] end
             | join("\n"))
            | select(length > 0)
            | {role: "claude", text: .}
          end
        | "\(.role)\t\(.text | @base64)"
      ' 2>/dev/null \
    | tail -n "$max_turns" \
    | while IFS=$'\t' read -r role text_b64; do
        local text marker
        text=$(printf '%s' "$text_b64" | base64 -d 2>/dev/null) || continue
        if [[ "$role" == "you" ]]; then
          marker="${user_color}▸ you${reset}"
        else
          marker="${assistant_color}◂ claude${reset}"
        fi
        printf '%b\n' "$marker"
        printf '%s\n' "$text" \
          | fold -s -w "$wrap_cols" \
          | awk -v max="$max_lines_per_turn" '
              NR <= max { print "  " $0 }
              NR == max+1 { print "  ⋯"; exit }
            '
        echo
      done
}

# ─── Main TUI entrypoint ──────────────────────────────────────────────────

cockpit_tui() {
  if ! command -v fzf >/dev/null 2>&1; then
    echo "fzf is required for the cockpit TUI." >&2
    echo "Falling back to: cockpit list" >&2
    cmd_list
    return 1
  fi

  # Inline fzf. The caller (e.g. `bind-key o display-popup -E cockpit`) is
  # responsible for popup framing.
  local self="$0"
  # Use `bash` to invoke ourselves for preview/jump callbacks so PATH issues
  # don't bite when fzf execs the binding.
  local cb="bash $self"

  local header
  header=$'enter jump · n new · r rename · d kill · ctrl-r reload · ? toggle preview · esc quit'

  cockpit_tui_format \
    | fzf \
        --ansi \
        --read0 \
        --gap=1 \
        --no-sort \
        --layout=reverse \
        --height=100% \
        --delimiter=$'\t' \
        --with-nth=1 \
        --header="$header" \
        --preview="$cb preview-id {2}" \
        --preview-window='right:50%:wrap' \
        --bind="ctrl-r:reload($cb tui-format)" \
        --bind="?:toggle-preview" \
        --bind="enter:execute($cb jump {2})+abort" \
        --bind="n:execute($cb spawn < /dev/tty > /dev/tty 2>&1)+abort" \
        --bind="r:execute($cb tui-rename {2} < /dev/tty > /dev/tty 2>&1)+reload($cb tui-format)" \
        --bind="d:execute($cb tui-kill {2} < /dev/tty > /dev/tty 2>&1)+reload($cb tui-format)" \
        > /dev/null
}

# Interactive rename helper; called by fzf binding.
cockpit_tui_rename() {
  local id="${1:-}"
  [[ -z "$id" ]] && return 1
  local current
  current=$(jq -r '.goal // ""' <<<"$(cockpit_read "$id")")
  echo "current goal: $current"
  read -rp "new goal: " new
  [[ -z "$new" ]] && { echo "(unchanged)"; return 0; }
  cmd_rename "$id" "$new"
}

# Interactive kill helper; called by fzf binding.
cockpit_tui_kill() {
  local id="${1:-}"
  [[ -z "$id" ]] && return 1
  local goal
  goal=$(jq -r '.goal // ""' <<<"$(cockpit_read "$id")")
  echo "kill chat: $goal ($id)"
  read -rp "confirm? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "(aborted)"; return 0; }
  cmd_kill "$id"
}

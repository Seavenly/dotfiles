# cockpit

A tool-agnostic dashboard for managing parallel AI chats (Claude Code today,
codex/aider/etc. in the future). Solves two problems:

1. **No cross-pane visibility.** A Claude in another tmux session can finish
   without your knowing — the per-pane terminal-title/bell signal only fires
   for the focused pane.
2. **Context loss when switching.** Jumping between chats means re-loading
   "what was I asking it to do?" from memory.

Cockpit captures `goal + status + current-action` per chat into a small JSON
state file, then surfaces it across an fzf TUI (popup), the tmux status line,
and a sketchybar widget.

---

## Quick start

| Action | How |
|---|---|
| Open the cockpit popup | `tmux prefix + o` (prefix = `C-a`) |
| One-shot status table | `cockpit list` |
| Compact one-liner | `cockpit summary` (used by status bars) |
| Jump to a chat | `enter` in TUI, or `cockpit jump <id>` |
| Rename goal | `r` in TUI, or `cockpit rename <id> "..."` |
| Kill chat | `d` in TUI, or `cockpit kill <id>` |
| Toggle preview pane | `?` in TUI |
| Reload TUI | `ctrl-r` (no daemon, manual refresh) |

---

## Architecture

```
                  ┌─────────────────────────────────┐
   Claude hook ──►│  $XDG_DATA_HOME/cockpit/        │
                  │    sessions/<session_id>.json   │  ◄── source of truth
                  │    archive/<session_id>.json    │      (one file per chat)
                  └─────────────────────────────────┘
                                ▲
                                │ reads
              ┌─────────────────┼──────────────────┐
              │                 │                  │
        cockpit popup     tmux status-right   sketchybar plugin
        (fzf TUI)         (`cockpit summary`)  (`cockpit summary`)
```

**No daemon.** State files are the source of truth. Writers (Claude Code
hooks) write atomically per event. Readers (TUI / status-line / sketchybar)
poll on a few-second interval. Failure modes are bounded: a stale entry just
shows up dimmed until `cockpit clean` removes it.

---

## State schema

State lives at `${XDG_DATA_HOME:-$HOME/.local/share}/cockpit/`. Active chats
live in `sessions/`; ended/killed chats are moved to `archive/`.

One JSON file per chat (named `<session_id>.json`):

```json
{
  "id": "9f3a-...",
  "tool": "claude",
  "goal": "migrate users table to postgres",
  "status": "working",
  "current_action": "Edit: migrations/001.sql",
  "tmux_pane": "%17",
  "tmux_session": "projA",
  "tmux_window": "1",
  "cwd": "/Users/nschott/dev/projA",
  "transcript_path": "/Users/nschott/.claude/projects/.../transcript.jsonl",
  "created_at": 1714723200,
  "updated_at": 1714723445
}
```

`tool` is a top-level field so future codex/aider/etc. adapters slot in
without schema changes. Status is one of `idle`, `working`, `waiting`,
`blocked`.

---

## File map

### Inside this directory (`tools/cockpit/`)

| File | Purpose |
|---|---|
| `cockpit` | Main bash entry. Subcommand dispatch, list/summary/jump/rename/kill/clean/recent. |
| `lib/state.sh` | Atomic JSON state read/write helpers (jq + `mktemp + mv`). |
| `lib/tui.sh` | fzf TUI: multi-line records, preview rendering, key bindings. |
| `setup.sh` | Idempotent installer for out-of-repo side effects (settings.json patch + state dirs). |
| `teardown.sh` | Reverses setup.sh. `--purge-state` also wipes chat history. |

### Integration points (elsewhere in the repo)

| File | What it does |
|---|---|
| `claude/hooks/cockpit-hook.sh` | Single hook handling 6 Claude Code events. Writes to state files. |
| `tmux.conf` | `status-right` runs `cockpit summary`; `bind-key o` opens popup; `status-interval 3`. |
| `zshrc/preinit.sh` | Adds `tools/cockpit` to PATH. |
| `sketchybar/plugins/cockpit.sh` | Sketchybar plugin that renders the summary, color-coded by status. |
| `sketchybar/sketchybarrc` | Registers the cockpit item. |

### Out-of-repo side effects (managed by `setup.sh`)

| Path | Why |
|---|---|
| `~/.claude/settings.json` | Cockpit hook is registered for 6 events. Existing notify.sh entries on Stop/Notification are preserved. Backup at `settings.json.bak.cockpit`. |
| `${XDG_DATA_HOME:-~/.local/share}/cockpit/{sessions,archive}/` | State directories. |

---

## Hook events → state transitions

Registered in `~/.claude/settings.json`. All events go through
`claude/hooks/cockpit-hook.sh`. Defensive rule: only `SessionStart` creates a
state file; other events bail out if no file exists yet (avoids partial
state for sessions that started before the hook was installed).

| Event | Effect |
|---|---|
| `SessionStart` | Create state file. Capture `tmux_pane`/`session`/`window` from `$TMUX_PANE`. Set `status: idle`. Preserve `created_at` if file already exists (handles `claude --resume`). |
| `UserPromptSubmit` | `status: working`. If `goal` is empty and prompt isn't a slash-command, set goal = first 60 chars of message. |
| `PreToolUse` | `current_action: "<tool>: <short args>"` (e.g. `Bash: pytest tests/`, `Edit: foo.py`). |
| `Stop` | `status: waiting`, `current_action: ""`. |
| `Notification` | `status: blocked`, `current_action: <message>`. |
| `SessionEnd` | Move state file to `archive/`. |

`notify.sh` (the per-pane bell/title hook that predates cockpit) is left
alone; both hooks register for Stop/Notification and run side-by-side.

---

## TUI

The fzf popup is summoned via `tmux prefix + o`. It uses `--read0`
multi-line records (fzf 0.42+) so each chat takes two lines:

```
⏳ working  projA  claude  30s
  migrate users table to postgres
```

- Line 1: `<glyph> <status>  <dir>  <tool>  <age>` — directory in **bold**, tool/age in dim
- Line 2: indented goal (or `—` if not set)
- Stale-pane mark `✗` is appended to the glyph if the tmux pane no longer exists
- `--gap=1` puts a blank line between records

### Bindings

| Key | Action |
|---|---|
| `enter` | `cockpit jump <id>` then close popup |
| `r` | Prompt for new goal, then `cockpit rename` |
| `d` | Confirm + `cockpit kill <id>` |
| `ctrl-r` | Reload list |
| `?` | Toggle preview pane |
| `esc` | Close popup |

### Preview pane

For the highlighted chat, shows:

- Header block: GOAL / STATUS / CWD / TMUX / AGE / PANE liveness
- The last 3 conversational turns from the transcript

The transcript renderer filters out tool_use, tool_result, and thinking
blocks — only user prompts and assistant text replies. Preserves newlines,
word-wraps to `$FZF_PREVIEW_COLUMNS`, caps each turn at 8 lines with `⋯`
continuation marker. Role markers (`▸ you` / `◂ claude`) use ANSI color.

---

## CLI subcommands

| Command | Description |
|---|---|
| `cockpit` | Open the TUI (popup or full-terminal fzf). |
| `cockpit list` | Print formatted single-line table to stdout. |
| `cockpit summary` | One-line compact form: `🤖 1⚠️ 2✉️ 1⏳`. Empty if no chats. |
| `cockpit jump <id>` | `tmux switch-client` + `select-window` + `select-pane`. |
| `cockpit rename <id> <text>` | Update the goal field. |
| `cockpit kill <id>` | SIGTERM the chat process and archive its state. |
| `cockpit clean` | Prune entries whose tmux pane no longer exists. |
| `cockpit recent [n]` | Show recently-archived chats (default 10). |
| `cockpit help` | Usage. |

Internal subcommands (used by the TUI itself): `rows`, `tui-format`,
`tui-rename`, `tui-kill`, `preview-id`.

---

## Setup & teardown

In-repo wiring (binaries, hook script, tmux/sketchybar/zsh edits) is handled
by dotbot via `./install`. The out-of-repo side effects need explicit
opt-in:

```sh
# Install
./tools/cockpit/setup.sh

# Activate the new tmux/sketchybar config
tmux source-file ~/.tmux.conf
sketchybar --reload

# Uninstall (preserves chat history)
./tools/cockpit/teardown.sh

# Uninstall + wipe history
./tools/cockpit/teardown.sh --purge-state
```

Both scripts are idempotent. setup.sh keeps a one-time backup of
`~/.claude/settings.json` at `settings.json.bak.cockpit`.

---

## Extending to other tools

The state schema's top-level `tool` field is the extension point. Possible
adapters for codex / aider / etc.:

1. **Hook-style** (preferred): if the tool has shell hooks, mirror
   `claude/hooks/cockpit-hook.sh`. Reuse `lib/state.sh`. Set `tool` to the
   adapter name. Generate a UUID per chat (`uuidgen` is fine).
2. **Manual register**: `cockpit register --tool <name> --pane <id> --goal "..."`
   for tools with no hook surface. Status would stay `unknown`. (Not
   implemented yet.)
3. **Polling/scraping**: an adapter daemon reads pane content via
   `tmux capture-pane` and infers state from terminal output. Brittle.

Cockpit reader code (CLI, TUI, status-line, sketchybar) doesn't need
changes — anything that produces a valid state file is rendered the same.

---

## Debugging

| Symptom | Likely cause / fix |
|---|---|
| New Claude session not appearing in cockpit | Hooks load on session start. Restart the chat, or check `~/.claude/settings.json` for the cockpit-hook entries. |
| Stale entries with `✗` after the glyph | The tmux pane is gone (claude crashed or was force-killed). Run `cockpit clean`. |
| Status stuck on `blocked` | A Notification fired but Stop never arrived (e.g. you killed claude during a permission prompt). `cockpit clean` if pane is also gone, otherwise it'll resolve on next Stop. |
| Goal is `/somecommand` | Slash-command-as-first-prompt was somehow captured. Should not happen — hook skips slash prefix. If it does, `cockpit rename`. |
| Status line shows nothing | `cockpit summary` returns empty (no chats) by design. Confirm with `cockpit list`. |
| Sketchybar widget not updating | Reload sketchybar config (`sketchybar --reload`) and confirm the `cockpit` item exists. |
| Hook write looks corrupt | All writes go through `mktemp + mv` for atomicity. If you see a torn file, check disk space / permissions on `~/.local/share/cockpit/`. |

To watch state changes live:
```sh
ls -la ~/.local/share/cockpit/sessions/
fswatch ~/.local/share/cockpit/sessions/ | xargs -I{} cockpit list
```

---

## Conventions & gotchas

These are the things that broke or surprised during development. Worth
knowing before touching the code.

- **`read -r` with `IFS=$'\t'` collapses consecutive tabs** because tab is
  bash IFS-whitespace. Empty middle fields shift everything else. Always
  use `awk -F'\t'` for parsing the cockpit_rows TSV — awk respects empty
  fields.
- **Unicode character right after a `$var` is parsed as part of the variable
  name.** `"$glyph✗"` looked for a variable named `glyph✗`. Use
  `"${glyph}✗"`.
- **Hook env inheritance**: `$TMUX_PANE` is inherited from the shell that
  launched claude → claude → its hook child. Captured at SessionStart and
  stored in the state file so subsequent events can reference it.
- **fzf `--read0` for multi-line records**: needs fzf 0.42+. Records are
  NUL-separated. Field placeholders (`{2}`) still work — they index by
  `--delimiter` within the record.
- **fzf preview wrapping is character-wise**, which breaks mid-word. We
  pre-wrap with `fold -s -w "$FZF_PREVIEW_COLUMNS"` before fzf gets the
  text.
- **Popup has its own pane.** Anything inside the cockpit popup that calls
  `tmux split-window` etc. needs to know the user's *real* session, not the
  popup's transient pane. Pass via `-e VAR=#{...}` on `display-popup`.
- **Multiple hooks per event**: Claude Code allows it. notify.sh and
  cockpit-hook.sh both run on Stop/Notification. The order is the order
  they appear in `settings.json`.

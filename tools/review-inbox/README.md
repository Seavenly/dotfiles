# Personal attention hub

`review-inbox` opens a host-local Bubble Tea application for deciding what to
consider next. It combines local agent reviews, team PRs, and externally
published Markdown briefs. It also provides a JSON CLI for agents and other
producers.

For a work-host cutover from the old fzf interface, start with the
[agent transition handoff](../../docs/agents/review-inbox-transition.md).
It covers code delivery, existing sources, labels, installation, isolated
checks, shortcut changes, and fallback.

```sh
review-inbox
review-inbox --layout dispatch
review-inbox --help
```

Existing shortcuts open a 95% by 90% popup: tmux prefix then `r`, or Herdr
prefix then Ctrl-R. Existing running sessions may need their terminal
configuration reloaded to pick up the larger popup size. Running
`review-inbox` directly uses the whole terminal.

Go is managed by the repository. The launcher builds a cached executable on
first use and rebuilds when the application's source changes, including added
or removed files. Convergence
warms that executable with `review-inbox --build`; binaries stay outside Git.

## Views and interaction

Navigator is the default layout. Ledger, Dispatch, Stream, and Overview use
the same inbox, read/dismiss state, labels, and real Open/Copy actions. Press
`L` or click the layout name to choose a layout; `[` and `]` cycle through
them. Choices made in the app are remembered on this host. Switching layouts
keeps the selected item and search filter.

```sh
review-inbox --layout ledger      # use a layout for this launch
review-inbox layout               # inspect the remembered layout as JSON
review-inbox layout navigator     # change the remembered layout
```

Attention shows all undismissed items. Reviews and Briefs filter that list;
read items remain visible. Select an item to preview its context, open a local
review in tuicr, or open a PR in the browser. The Dismissed filter lets you find
and restore items you previously cleared.

Mouse controls support selecting items, changing views, scrolling, and using
the visible action buttons. Narrow terminals use a separate detail screen
with a Back button so the list and preview remain readable on a phone. Touch
requires the terminal client to forward taps as terminal mouse events; the
application enables terminal mouse reporting itself.

Read/unread and dismissed state belong to the hub. They do not approve,
close, merge, or delete a source review. Updating an item's content marks it
unread; an update never restores a dismissed item. Reading and finishing with
an item are separate actions.

Keyboard controls:

| Key | Action |
| --- | --- |
| `1`, `2`, `3` | Attention, Reviews, Briefs |
| `a`, `v`, `b` | Attention, Reviews, Briefs |
| `L` | Open the layout picker |
| `[`, `]` | Previous or next layout |
| `/` | Search; Enter/Esc finishes, Ctrl-U clears |
| `j`/`k`, arrows | Move through items or scroll the focused preview |
| Enter, right arrow | Read the preview |
| Left arrow, Esc, Backspace | Return to the list |
| Tab | Change preview focus |
| `r` | Toggle read/unread |
| `d` | Dismiss or restore |
| `s` | Toggle dismissed items |
| `o` | Open in tuicr or browser |
| `y` | Copy the review token or item reference |
| `R` | Refresh |
| `?` | Help and source status |
| `q` | Finish pending changes and quit |
| Ctrl-C | Exit immediately |

Use at least 28 columns by 14 rows. Each layout adjusts its panes to the
available space. Narrow terminals show one screen at a time, with visible
Back and scrolling controls for touch. The list refreshes automatically while
preserving the selected item. Source warnings and action failures remain
visible in the status area. Clicking a warning opens its full details. A
temporary source error retains that source's last good snapshot for the
running session; a successful empty snapshot removes its items normally.

## Publishing content

Collection stays outside this application. A producer can fetch research,
compose a daily brief, or summarize another system, then publish the result:

```sh
review-inbox publish <<'JSON'
{
  "source": "daily-brief",
  "id": "2026-11-05",
  "kind": "brief",
  "title": "Thursday's brief",
  "body": "# Today\n\n- Review the deployment proposal.\n- Read the industry research."
}
JSON
```

`source` and `id` identify the item together. Publishing the same pair updates
that item in place. Give each day's brief a new ID. `body` contains Markdown;
`url` may point to the original material. Producers must supply `source`, `id`,
and `title`; `kind` defaults to `brief`. Optional `labels` are an array of
source-supplied names, for example:

```json
{"source":"agent-reviews","id":"mobile-navigation","kind":"review","title":"Review mobile navigation","labels":["agent:ready","risk:low","size:S"]}
```

Labels appear directly in review queue rows and are searchable. The reader
shows the full set; compact rows show `+N` when more labels are available.
Label changes mark an item unread, while reordering the same labels does not.

```sh
review-inbox publish brief.json
review-inbox list --json
review-inbox list --all --kind brief --source daily-brief --json
review-inbox show daily-brief 2026-11-05 --json
review-inbox read daily-brief 2026-11-05
review-inbox unread daily-brief 2026-11-05
review-inbox dismiss daily-brief 2026-11-05
review-inbox restore daily-brief 2026-11-05
review-inbox remove daily-brief 2026-11-05
review-inbox copy daily-brief 2026-11-05
```

CLI commands always write JSON to stdout; `--json` is accepted explicitly.
Kinds are `brief` and `review`. `open` requires an item URL or a local review
launch target; reading a brief in the TUI does not require either.

CLI commands work without an interactive terminal or a multiplexer. No source
plugin loading, credentials, polling scheduler, accounts, or synchronization
are needed. Different hosts can use different external producers.

## Existing review sources

The local review adapter reads `tuicr-reviews list --json`. Existing
`TUICR_REVIEWS_FILE` configuration remains owned by that tool. Opening a local
review uses the selected tmux or Herdr backend and its immutable comparison
points when available:

```sh
review-inbox --backend tmux
review-inbox --backend herdr
```

The PR adapter reads the JSONL snapshot at `COWORKER_PRS_FILE`, defaulting to
`$XDG_STATE_HOME/dotfiles/coworker-review-prs.jsonl` (or
`~/.local/state/dotfiles/coworker-review-prs.jsonl`). Existing `review-feed`
continues collecting and publishing this file. The snapshot's `repo`,
`number`, `title`, `url`, `kind`, and optional `state` fields remain supported.
It also carries optional `labels` as a string array. `review-feed` obtains
GitHub labels from the PR metadata it already collects. Other work or personal
producers can publish the same field without changing the TUI.
Source items disappear when removed from their source snapshot. Published
briefs remain until explicitly removed.

Local review projections may supply the same optional `labels` field. The
current `tuicr-reviews` registry does not emit it, so local reviews without
upstream label metadata simply show no labels. The hub does not infer labels
or fetch GitHub metadata for a local branch.

The adapters reserve source names `local-review` and `github-pr`. Personal hub
state is separate from either source's review lifecycle. The newer
ReviewAuthority-owned `flow query review_inbox` projection is a distinct
interface; the hub does not grant review approval or integration authority.

## Local storage and development

### Layouts and snapshots

The five layouts have distinct information hierarchies:

All five use the same [Kanagawa Wave palette](https://github.com/rebelot/kanagawa.nvim/blob/master/lua/kanagawa/colors.lua)
so color stays constant while comparing layout. Review labels remain visible
in the queue rather than requiring an item to be selected.

| Design | Structure | Inspiration |
| --- | --- | --- |
| Ledger | Dense queue table with a slim inspector | [DASH](https://www.gh-dash.dev/) |
| Dispatch | Editorial reader with a subordinate contents index | [Glow](https://github.com/charmbracelet/glow) |
| Navigator | Source rail, item list, and reading pane | [Yazi](https://yazi-rs.github.io/) |
| Stream | Timestamped feed above a full-width reading pane | [DASH](https://www.gh-dash.dev/) and activity readers |
| Overview | Parallel review and reading queues above shared context | [Lazygit](https://github.com/jesseduffield/lazygit) panel hierarchy |

Generate an offline comparison gallery directly from native terminal frames:

```sh
python3 tools/review-inbox/layout_gallery.py
```

The generator writes a new standalone HTML file under `~/.moshi/visuals/` and
prints its path. The gallery supports shareable `?variant=ledger` selections
and desktop, compact, and phone terminal sizes. It contains a local snapshot
of the inbox, so generated captures stay outside the repository.

The gallery is read-only. The compatibility `designs --skin NAME --snapshot`
command renders JSON frames using the production layouts without changing
the stored layout or item state. The older `prototype_gallery.py` command
forwards to `layout_gallery.py`.
Without `--snapshot`, `designs --skin NAME` opens the live application just
like `--layout NAME`; its read/dismiss and Open/Copy actions are real.

### State and checks

Published content, personal state, and the remembered layout live at
`$XDG_STATE_HOME/dotfiles/review-inbox.json`, falling back to
`~/.local/state/dotfiles/review-inbox.json`. Set `REVIEW_INBOX_STATE_FILE` to use
a separate store for development or testing. The cached executable lives
below `$XDG_CACHE_HOME/dotfiles/review-inbox/`, falling back to `~/.cache`.

```sh
cd tools/review-inbox
go test ./...
go vet ./...
```

The existing `review-inbox`, `tmux-review-inbox`, and legacy shell helper flags
remain available to existing terminal integrations.

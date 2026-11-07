# Transition a work host from fzf to the attention hub

This is the agent handoff for replacing the old fzf `review-inbox` interface
with the Go/Bubble Tea application in this repository. Work from the target
host's actual configuration; the design and implementation context below
does not require the original chat.

Read the repository's `AGENTS.md`, [domain guidance](domain.md),
[glossary](../../GLOSSARY.md), and relevant
[review authority decision](../adr/0008-use-a-sole-run-authority-for-flow-lifecycle.md)
before changing behavior. The [tool README](../../tools/review-inbox/README.md)
is the command and interaction reference.

## Intended result

The existing `review-inbox` command and terminal shortcuts open the new hub
against the work host's existing local reviews and PR feed. Navigator is the
default; all five layouts share Kanagawa Wave, the same data, and real actions.
The user can choose a layout through `L` or the clickable layout name. That
choice, read/unread state, and dismissal are remembered on this host.

The application is for deciding what needs attention and reading compiled
information, including Markdown briefs. It has a JSON CLI so external agents
and producers can supply content. Collection, credentials, query filters,
scheduling, and PR classification stay with external producers. Keep the
work host's collection mechanism if it already works; a plugin framework or
a new collection service is not required for this transition.

The newer ReviewAuthority-owned `flow query ... review_inbox` projection is
a separate interface. This change does not cut over Flow implementations or
move review approval, lifecycle, or integration authority into the hub.

## 1. Make the implementation available

First confirm that the target checkout actually contains the implementation:

```sh
git status --short
test -f tools/review-inbox/go.mod
test -f tools/review-inbox/app.go
git status --short -- tools/review-inbox bin/review-inbox
```

Use the branch or commits carrying this handoff and the implementation; do
not assume that pulling an older default branch is sufficient. The inbox
rollout is published on `feature/flow-runtime`. Fetch that branch and
inspect the target checkout before attempting the work-host transition.
If transferring later changes as a patch, remember that a plain `git diff`
omits untracked files and is not a complete delivery artifact by itself.

The implementation spans:

- `tools/review-inbox/`: Go source, module locks, tests, usage docs, and gallery.
- `bin/review-inbox`: cached Go launcher plus compatible legacy helpers.
- `tools/review-feed/review_feed.py`: optional GitHub collector's label support.
- `config/tmux/tmux.conf` and `config/herdr/config.toml`: larger review popups.
- `internal/bootstrap/warm-caches`, `internal/commands/check`, and the CI
  workflow: build warming and Go validation.
- The accompanying tests, root README, glossary, and this handoff.

Preserve unrelated edits in either checkout. Do not bundle personal changes
to tool versions, agent skills, shell configuration, or machine-local files
merely because they are present in the development working tree.

## 2. Inventory the existing work-host routes

From the intended checkout, inspect command resolution:

```sh
type -a review-inbox tmux-review-inbox tuicr-reviews review-feed go
```

Identify aliases, functions, copied scripts, and symlinks that could still
select the old implementation. The normal managed command is
`~/.local/bin/review-inbox`, linked to this checkout's `bin/review-inbox`.
Inspect an old launcher before invoking unfamiliar flags: the original fzf
script did not have the new noninteractive help interface.

Record the effective paths and existing producer/scheduler without copying
private content into repository docs:

| Purpose | Existing route or override | Default |
| --- | --- | --- |
| Local review listing | `tuicr-reviews list --json` | Existing registry and manifests |
| Local registry file | `TUICR_REVIEWS_FILE` | `$XDG_STATE_HOME/dotfiles/tuicr-reviews.jsonl` |
| Team/own-PR feed snapshot | `COWORKER_PRS_FILE` | `$XDG_STATE_HOME/dotfiles/coworker-review-prs.jsonl` |
| New hub content and preferences | `REVIEW_INBOX_STATE_FILE` | `$XDG_STATE_HOME/dotfiles/review-inbox.json` |
| Optional collector configuration | Existing `review-feed` configuration | `$XDG_CONFIG_HOME/dotfiles/review-feed.env` |
| Optional collector state | `REVIEW_FEED_STATE_DIR` | `$XDG_STATE_HOME/dotfiles/review-feed/` |
| Compiled application | `XDG_CACHE_HOME` | `~/.cache/dotfiles/review-inbox/` |

Absent XDG variables, state defaults to `~/.local/state` and configuration to
`~/.config`. The compiled cache can be rebuilt. Preserve the existing registry
projections, review manifests, source feeds, collector configuration, and hub
state throughout this UI transition.

Keep those files in place. The new hub consumes the existing sources; it
does not require importing the registry into its own JSON store. Back up
machine-local configuration before editing it. Do not copy the development
host's demo content, preferences, credentials, or caches to the work host.

The producer and popup must agree on `COWORKER_PRS_FILE`. A scheduled job's
environment and an interactive shell's environment can differ. Changing a
variable for only one of them does not connect the other to that feed.

## 3. Build and resolve the new command

On an already managed host with the correct command links, use the repository's
locked Go toolchain and build the new application:

```sh
mise install --locked go
mise exec --locked -- ./bin/review-inbox --build
./bin/review-inbox --help
./bin/review-inbox layout
```

The last command should report `navigator` on a host with no saved choice.
The launcher builds outside the repository and rebuilds after source edits,
additions, deletions, or switching between different source contents.

If managed resources or command links need convergence, use the documented
`./dotfiles install --dry-run` and `./dotfiles install` path for that host.
Inspect the convergence plan rather than replacing machine-local settings
with the development host's settings. Go is already declared in this
repository; there is no separate global Go binary to install manually.

Check the public command after building, not only the checkout-local one:

```sh
review-inbox --help
review-inbox list --all --json
review-inbox layout
```

CLI data goes to stdout as JSON; source observations go to stderr. A list
containing no reviews can be legitimate. Compare it with the local listing
and the producer's current snapshot before diagnosing an empty UI.

## 4. Preserve collection and add label metadata

### Existing work-specific PR producer

The PR adapter consumes a full JSONL snapshot, one object per current PR.
Existing `repo`, `number`, `title`, `url`, `kind`, and `state` fields continue
to work. Add optional label names to the producer's output:

```json
{"repo":"example-work/service","number":123,"title":"Review request handling","url":"https://github.example.test/example-work/service/pull/123","kind":"review","labels":["agent:needs-human","risk:medium","size:M"]}
```

This is an illustrative record, not a real PR to create. `kind` can be
`review` for a review request or `reply` for feedback on the user's own PR;
optional `state` can retain values such as `approved` or `changes_requested`.
Optional `body`/`description` and `updated_at` provide more preview context.

Emit label names as strings, not raw GitHub label objects. Labels are a set:
the hub trims, deduplicates, and orders names consistently. A changed set
marks a read item unread; ordering changes alone do not. The UI shows labels
without selecting the item, an overflow count in narrow rows, and the full
set in the reader. Search includes labels.

Keep the producer's existing collection boundaries and queue selection.
Rewrite the snapshot atomically. A successful snapshot omitting a PR removes
it from this source; an update should not append duplicates. Preserve the
last successful feed when collection fails. The running hub also retains
its last good source observation on read errors and displays a warning;
that in-memory fallback does not survive restarting the application.

### Repository-provided `review-feed`

If this is the host's existing collector, its updated implementation already
extracts labels from the PR metadata it fetches. Refresh it through the same
deployment path as the UI. An old collector will continue producing valid
items but will not include the new labels.

```sh
review-feed status
review-feed run
review-feed status
review-feed logs
```

Verify the resulting feed and health, not just the exit code: this collector
intentionally exits successfully after recording a collection failure. It
silently seeds the first successful run and avoids a burst of notifications
when upgrading existing state to include labels.

Its built-in client targets `api.github.com`. For an Enterprise host or a
different work access mechanism, keep or adapt the external work producer
to emit the JSONL contract above. The hub does not choose GitHub accounts or
authenticate against the forge.

Built-in scheduled collection uses macOS launchd and remains explicit opt-in
through `review-feed enable`. Preserve an existing schedule. Do not enable a
new one merely to replace the UI. Ubuntu hosts can consume any existing
producer's snapshot; adding a Linux scheduler is not part of this transition.

### Local agent reviews and their PR labels

The local adapter consumes `tuicr-reviews list --json`, preserving lifecycle,
health, tokens, and immutable `base_sha`/`head_sha` comparison points. It also
accepts an optional `labels` string array if the local producer supplies it.

**Known remaining integration:** the current `tuicr-reviews` registry does not
emit labels or associate a local branch with PR labels automatically. UI
support is complete, but the upstream association/enrichment is still work
to do. Identify the work host's existing branch-to-PR mapping and
classification source before implementing that producer change. Do not
invent a mapping from a branch name or modify review authority to attach
presentation metadata.

An external agent can also publish its own `kind: "review"` items with labels
through `review-inbox publish`. The built-in source names `local-review` and
`github-pr` are reserved; generic publication cannot override those sources
or nominate a local execution workspace.

## 5. Validate without touching real reviews

Run the focused application and integration checks from the checkout:

```sh
go -C tools/review-inbox test ./...
go -C tools/review-inbox vet ./...
bash tests/review_inbox_cli_test.sh
bash tests/tmux_tools_test.sh
bash tests/review_feed_test.sh
```

For an interactive smoke test, this subshell creates isolated source and hub
files and removes them after the app exits. The synthetic review has no URL
or worktree, so Open reads its preview instead of launching an external tool:

```sh
(
  review_test_dir="$(mktemp -d)"
  trap 'rm -rf "$review_test_dir"' EXIT
  export REVIEW_INBOX_STATE_FILE="$review_test_dir/hub.json"
  export TUICR_REVIEWS_FILE="$review_test_dir/local-reviews.jsonl"
  export COWORKER_PRS_FILE="$review_test_dir/prs.jsonl"
  : > "$TUICR_REVIEWS_FILE"
  : > "$COWORKER_PRS_FILE"
  review-inbox publish <<'JSON'
{"source":"transition-smoke","id":"one","kind":"review","title":"Transition smoke test","body":"# Check navigation\n\nRead, dismiss, restore, and change layouts.","labels":["agent:ready","risk:low"]}
JSON
  review-inbox list --json
  review-inbox --backend tmux --layout navigator
  review-inbox layout
  review-inbox --backend tmux
)
```

Check labels before selecting a row, label search, read/dismiss/restore,
selection while changing layouts, and the remembered choice after restarting
with those same test files. Exercise the desktop layout and the narrow
list/detail view if the host will be used through Moshi. The subshell's
explicit `--layout` selects one launch; picker changes persist in its isolated
hub file. The app opens twice: after quitting the first launch, inspect the
printed preference and confirm the second launch uses your chosen layout.

Automated Open/Copy tests must use stubbed actions, as the repository tests
do. A scratch state file alone does not isolate actions: backend auto-detection
can inherit a live `HERDR_SOCKET_PATH`, and clipboard/browser operations
target the host. Do not launch fabricated local reviews into an existing work
session while trying to test only rendering. A real multiplexer is not needed
for the no-destination smoke item above.

## 6. Check real routes and switch the shortcut

Once source identity and command resolution are correct:

1. Compare `review-inbox list --all --json` with the existing local registry
   and PR snapshot. Verify at least one known real review and its actual
   labels when available; do not manufacture work PRs to make the test pass.
2. Launch `review-inbox --backend tmux` or `review-inbox --backend herdr`
   explicitly in the intended session. This removes ambiguity when more than
   one terminal backend is available.
3. Open a known local review. Confirm tuicr receives the immutable comparison
   when supplied, and existing review panes/tabs are focused instead of
   duplicated. Opening a local review successfully closes the inbox so the
   popup releases focus. On failure, the inbox stays open with diagnostics.
4. Check a known PR's browser destination and copy behavior. They use the
   host's browser and clipboard/tmux buffer; phone-side handling depends on
   the terminal client. Neither action submits a review or changes a PR.
5. Verify that Read remains visible, Dismiss hides only from the personal
   active view, Restore works, and a layout chosen through `L` survives a
   normal restart. `--layout NAME` overrides only one launch.
6. Reload the target terminal configuration using that host's normal
   mechanism, preserving its other bindings. Existing tmux sessions can use
   `tmux source-file ~/.tmux.conf` when that is their managed config. The
   repository's review popup is 95% wide and 90% high. Test tmux prefix then
   `r`, or Herdr prefix then Ctrl-R, rather than only the direct command.

The old fzf interactions have deliberate differences:

| Old interaction | New interaction |
| --- | --- |
| Enter opens an external review | Enter focuses the reader; `o` or Open launches the review |
| Typing filters the fzf list | `/` starts case-insensitive substring search, including labels |
| Ctrl-Y copies a local token | `y` or Copy copies the token, URL, or item reference |
| Ctrl-A toggles legacy approval | Read is personal state; approval still belongs to the source |
| Ctrl-X twice removes a registry projection | `d` dismisses personally; it does not remove registry entries |

The legacy helper flags `--lines`, `--approve`, `--copy`, and `--maybe-delete`
remain available for compatibility. They are not the normal TUI controls;
legacy approval/removal helpers still have their original effects. Do not
translate approvals into read flags or treat dismissal as review completion.

## Fallback and handoff report

If the new UI is unsuitable on the work terminal, preserve its state and
source files. A temporary fallback can use the old fzf launcher from a known
good repository revision, saved under a different local filename and invoked
explicitly. Change only the intended shortcut if necessary. Do not reset the
checkout, delete the hub store, or roll back registry/manifests to switch UIs.
The old UI ignores the new hub's personal read/dismiss/layout state.

Report the actual revision delivered, command resolution, source paths and
producer, terminal backend, real label observations, and checks performed.
Separate validated behavior from remaining integration work, particularly
local branch-to-PR label enrichment. Keep credentials and private review
content out of the repository. Daily brief/research generation, snoozing,
pinning, synchronization, and a plugin framework remain outside this rollout.

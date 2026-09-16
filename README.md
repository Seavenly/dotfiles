# Dotfiles

Personal development environment for macOS workstations and Ubuntu servers.
The repository is designed to be cloned anywhere and converged with one
command:

```sh
./dotfiles install
```

Native [`mise bootstrap`](https://mise.jdx.dev/bootstrap.html) manages tools,
system packages, symlinked configuration, shell activation, repositories, and
macOS defaults. A checked-in lockfile keeps tool versions consistent across
supported platforms.

## Supported systems

| Platform | Architectures | Intended use |
| --- | --- | --- |
| macOS 26+ | Apple Silicon | Primary graphical workstation |
| Ubuntu Server 24.04 or 26.04 | x86_64, arm64 | Headless servers and remote shells |

The installer rejects root, unsupported operating systems, and unsupported
architectures before changing the machine.

## What this repository provides

- A shared Zsh, tmux, Git, Neovim, Atuin, Lazygit, and mise configuration.
- Locked command-line tools and language runtimes installed through mise.
- A minimal fzf project selector backed by Sesh for reliable tmux session
  creation and switching.
- macOS workstation configuration for AeroSpace, Ghostty, and SketchyBar.
- Curated macOS keyboard, Dock, Finder, screenshot, trackpad, and menu-bar
  defaults.
- Local-first shell history with Atuin; synchronization remains optional.
- A pre-commit Gitleaks scan so credentials are caught before reaching CI.
- An optional macOS meeting recorder and transcription environment.

Linux receives the portable terminal environment and required apt packages;
macOS-only applications and preferences are kept in the macOS environment.

## Quick start

```sh
git clone https://github.com/Seavenly/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./dotfiles install --dry-run
./dotfiles install
```

The first run may ask for a Git identity, whether to import existing Zsh
history into Atuin, whether to remove known Homebrew duplicates from the old
setup, and whether macOS UI processes should be restarted after applying
defaults.

### Installer options

```text
./dotfiles install --dry-run   show the convergence plan without changing anything
./dotfiles install --yes       accept safe bootstrap and migration prompts
./dotfiles install --force     replace conflicting managed dotfile targets
./dotfiles install --recorder  include the optional macOS recording stack
```

`--yes` does not enable the recorder, invent a Git identity, import history,
or silently enable services that require personal credentials.

### Safety and repeatability

- Mise itself is installed from a pinned release with a verified SHA-256.
- Tool versions are resolved in `mise.lock` for macOS arm64 and Linux x86_64/
  arm64.
- Existing unmanaged files are preserved unless `--force` is supplied.
- Re-running `dotfiles install` is the supported repair and convergence path.
- Versioned one-time migrations are recorded under
  `~/.local/state/dotfiles/migrations`.
- There is intentionally no automatic rollback or uninstall operation.

## Homebrew ownership and migration

Homebrew is retained for genuine macOS system packages and applications:

- Mise's native package bootstrap owns `eza` and SketchyBar.
- `Brewfile.macos` owns Ghostty, Obsidian, and workstation fonts.
- `Brewfile.recorder` owns BlackHole when the recorder is enabled.
- Unrelated applications installed by the user remain unmanaged.

Homebrew Bundle is used for casks because mise's native DMG extraction can
follow an `Applications` symlink out of common mounted disk images. The cask
bootstrap replaces only explicitly managed application bundles instead of
running a broad Homebrew cleanup.

On the first macOS transition, the installer offers to remove an explicit
allowlist of packages superseded by mise and retired `zk`/`sbx` installations.
It verifies replacements before removal, reports the plan during `--dry-run`,
retains formulae required by other Homebrew software, and allows Homebrew to
autoremove dependencies that become orphaned.

AeroSpace is installed from its checksum-locked release archive through mise
and linked into `~/Applications`. This avoids relying on its third-party
Homebrew tap and keeps the CLI and running application on the same version.

## Daily operations

```sh
dotfiles doctor                 inspect machine and bootstrap health
dotfiles doctor --full          also run repository source validation
dotfiles check                  validate scripts, configs, locks, and credentials
dotfiles upgrade                upgrade normal components
dotfiles upgrade tools nvim     upgrade selected components only
dotfiles upgrade mise           update the pinned mise release and checksums
flow query legacy-inventory --json
                                inventory retained legacy flow evidence read-only
flow query delegated-agent --harness codex --capability read-only \
  --caller-metadata '{"owner":"preparation"}' --json
                                inspect an exact non-mutating Drovr launch contract
flow start --json                start the optional host-owned replacement runtime
flow status --json               inspect owner, runner capacity, and errors
flow stop --json                 stop the exact recorded owner
flow query --input '{"schema":"flow.query/v1","query":"review_inbox"}' --json
                                inspect the ReviewAuthority-owned local review inbox
flow watch --input '{"schema":"flow.watch/v1","query":"review_inbox"}' --json
                                read one watermarked review-inbox snapshot
```

The local review inbox is a disposable projection for tuicr or another
replaceable consumer. Materialize its legal action templates and submit the
resulting `work.review-human-command/v1` values through `flow command`; an
integration action records evidence and authorization only and never runs Git
integration.

The autonomous owner uses one delegate slot and one operation slot by default.
Set `FLOW_RUNNER_DELEGATE_CAPACITY` and
`FLOW_RUNNER_OPERATION_CAPACITY` to positive integers from 1 through 64 before
`flow start` to override those bounds. The equivalent explicit production
configuration is `createFlowRuntime({ runnerOptions: { delegateCapacity,
operationCapacity } })`. `flow status --json` reports both capacities, active
counts, and bounded error summaries; detached-owner diagnostics are retained
in the private `owner-errors.json` file below the authority state directory.

The public host-owned `FlowRuntime` exposes exactly five JSON operations. Each
request is supplied with `--input` and may be serialized with `--json`:

```sh
flow prepare --input JSON --json   # prepare a closed feature request
flow launch --input JSON --json    # launch one confirmed prepared run
flow command --input JSON --json   # issue one typed run or host command
flow query --input JSON --json     # read one named query or projection
flow watch --input JSON --json     # stream watermarked observations
```

Preparation input must use the closed `flow.feature-preparation-request/v1`
schema; launch, command, query, and watch inputs use their corresponding
versioned request contracts.

Available upgrade components are `tools`, `packages`, `shell`, `nvim`,
`recorder`, and `mise`. Normal upgrades fail fast, ignore Git state, and leave
lock or configuration changes uncommitted for review. Tool resolution observes
a seven-day minimum release age.

CI runs `dotfiles check` and validates the dotfile plan against isolated home
directories on macOS, Ubuntu x86_64, and Ubuntu arm64.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `mise.toml` | Portable tools, repositories, shell activation, and dotfile links |
| `mise.macos.toml` | macOS packages, application configs, and system defaults |
| `mise.linux.toml` | Ubuntu prerequisites and Zsh login shell |
| `mise.recorder.toml` | Optional recorder package, command, and bootstrap task |
| `mise.lock` | Resolved cross-platform tool versions |
| `Brewfile.*` | Declarative macOS casks |
| `dotfiles` | Public command dispatcher, also linked into `~/.local/bin` |
| `bin/` | Additional user commands linked into `~/.local/bin` |
| `config/` | Application-owned configuration organized by concern |
| `config/agents/` | Shared agent guidance, managed skills, and colocated profile variants |
| `config/agent-flow/` | Hermes-backed agent-flow orchestration, schemas, and routing template |
| `config/flow/` | Replacement FlowRuntime inventory, transition policy, public contracts, frozen legacy baselines, and evidence ledger |
| `internal/` | Private commands, bootstrap lifecycle, migrations, and shared shell policy |
| `tests/` | Behavioral tests exercised through module interfaces |
| `tools/recorder/` | Optional recorder application and Python environment |
| `tools/drovr/` | Harness-neutral delegated agent runtime over Herdr |
| `tools/flow/` | Public flow transition interfaces and the dark replacement runtime |

Configuration is organized by concern rather than mirroring the destination
layout under `$HOME`. Native mise dotfiles create explicit symlinks from these
directories to their platform-appropriate destinations.

## Flow implementation transition

The harness-neutral `flow` runtime is available beside the frozen Claude-only
and Hermes-backed implementations. New launches still select the Claude-only
baseline by default. Repeating `dotfiles install` reapplies the same versioned
policy from `config/flow/launch-policy.v1.json`; it does not change the
selector merely because replacement sources are installed. The launcher
enforces that converged decision.

The public replacement Interface is also fail-closed: `prepare` and `launch`
require a request-local `flow.dark-opt-in/v1` bound to the exact release
manifest. That opt-in admits only the production feature `verify` and local
review routes for sacrificial qualification. Feature test or mixed modes,
spikes, epics, GitHub review, tracker/forge operations, publication, merge,
push, and other remote mutations return typed disabled or unsupported
outcomes. It does not authorize normal use, remote mutation, later issue runs,
or a change to the Claude default. Use `config/flow/transition-ledger.v1.json`
and the transition projection for the exact release, evidence status, and
legal actions before selecting it deliberately.

Dark opt-in admission requires both deterministic/core qualification and a
separate production-route conformance record. Phase one includes host-fault
and reboot suites on the registered-operation test runtime; phase two
exercises feature verify and local review through the production public
runtime. The generator grants that temporary running phase only through an
inherited process descriptor; requests, environment fields, and runtime
constructor options cannot mint it. Both evidence phases must match the
admitting host's exact OS, architecture, Node, npm, and Git versions. A failed,
incomplete, or foreign-environment phase keeps admission withheld.

Canonical evidence crossing the delegate, artifact, or resource-handoff
boundary is validated by the pure versioned evidence-safety contract in
`tools/flow/src/evidence-safety.mjs`. Catalog v33 binds policy
`flow.evidence-safety-policy/v1` to exact catalog identity
`flow.contract-catalog/v1@33`; rejected evidence produces only typed redacted
codes and never reads ambient host state.

The three implementations use disjoint authority roots, and existing runs
remain owned by the implementation that created them. No legacy import adapter
ships initially. Inspect the exact transition watermark, evidence status, and
legal next actions with `npm --silent --prefix tools/flow run status`. The replacement
API retains the five-operation runtime and its existing run
ownership, but this release gate admits only the two listed sacrificial routes;
it does not expose a general dynamic-plan bypass. One-shot uncertain effects require a
fresh operation-bound checkpoint; safer classes can execute from an exact
authority-projected command. Operation
effects use durable intent-before-effect authority, typed receipts, and
effect-class-specific reconciliation. Its SQLite authority streams are fenced
to one mutating runtime while competing processes remain read-only.
Workspace and artifact subjects can publish one immutable generation-bound
resource handoff atomically with producer finalization. A later run pins and
rechecks that exact handoff before mutation without depending on the producer's
process, branch, or workspace. Workspace writer claims are generation- and
fingerprint-fenced, uncertain state remains tainted until an evidence-backed
disposition, and cleanup previews refuse active, dirty, uncertain, pinned, or
retained resources. Mutating consumers hold one exclusive handoff and workspace
lease according to explicit operation authority through terminal settlement,
while evidence-backed handoff retirement
enables cleanup to release Git retention, artifact pins, and workspace retention.
Destructive reset and risk acceptance require fresh exact human authority;
`latest` resource selection is never authoritative.
Cancellation is irreversible: it stops new Adapter admission, abandons
incomplete attempts, preserves completed evidence, and quarantines outstanding
or late results without advancing dependencies.
The public host owner and its optional macOS LaunchAgent and Ubuntu user-systemd
templates are documented in
[`config/flow/host/README.md`](config/flow/host/README.md). Normal convergence
only makes those sources available below `~/.config/flow/host`; it never loads
or enables either host manager, and the replacement selector remains disabled
until the explicit opt-in decision in issue #43.
The public contracts and guardrails are documented in
[`tools/flow/README.md`](tools/flow/README.md) and
[`ADR-0008`](docs/adr/0008-use-a-sole-run-authority-for-flow-lifecycle.md).

User-owned symlink ancestors of the state or authority root are rejected for
safety. Set `FLOW_AUTHORITY_DIRECTORY` to a real private directory owned by the
current user (mode `0700`) to remedy that configuration error.

## Machine-local configuration

Host-specific state stays outside Git under `~/.config/dotfiles/`:

| File | Purpose |
| --- | --- |
| `aliases.local.zsh` | Host- or project-specific aliases |
| `private.zsh` | Secrets and private environment variables, mode `0600` |
| `git.local` | Git author name and email, mode `0600` |
| `paths.env` | Local paths such as `PROJECTS_DIR` and `NOTES_DIR` |
| `hermes-routing.yaml` | Model-neutral routing for managed Hermes profiles, mode `0600` |

The defaults are `PROJECTS_DIR=~/dev` and `NOTES_DIR=~/notes`. The bootstrap
creates these local files when needed but never commits their contents. The
Hermes routing file starts with no selected models; fill all six managed lanes
and run `agent-flow doctor profiles` before launching an automated flow.

## Shell and tmux workflow

Shell startup performs no network downloads. Mise shims own tool resolution,
while Antidote and Zsh plugins are commit-pinned.

- `ls`, `ll`, `la`, and `tree` use `eza`; `cat` uses `bat`.
- Use `command ls` or `command cat` to bypass those aliases.
- `z` and `zi` are provided by zoxide.
- Atuin remains local-only by default and preserves normal Zsh history.
- Zsh `Ctrl-A` opens the project selector.
- The tmux prefix is `Ctrl-A`; prefix `f` opens the same selector in a popup.

The selector scans Git repositories live beneath `$PROJECTS_DIR`, displays
`parent/project`, and returns the selected path to Sesh. Sesh remains an
invisible backend that creates, attaches to, or switches the tmux session.

## macOS workstation behavior

AeroSpace starts SketchyBar and publishes workspace-change events. SketchyBar
shows occupied workspaces and their application icons on the left, with clock,
battery, volume, and optional recorder status on the right.

Managed preferences include:

- keyboard repeat, text substitutions, and full keyboard access;
- Dock hiding, animation, recent apps, and Mission Control behavior;
- Finder visibility, view, sorting, search, path, and status settings;
- screenshot format, shadow, and floating thumbnail behavior;
- tap-to-click, right-click, and three-finger-drag choices;
- native menu-bar auto-hide.

Security and privacy permissions, pointer speed, natural scrolling,
function-key behavior, spelling, save/print panels, Trash cleanup, and app
authentication remain deliberately unmanaged. A logout may be required before
every macOS preference takes effect.

## Optional recorder

Install the recording stack with:

```sh
dotfiles install --recorder
```

The recorder's uv environment lives at
`~/.local/share/dotfiles/recorder-venv`; it does not create a repository
`.venv`. Recordings and transcripts are written beneath
`$NOTES_DIR/raw/meetings`.

BlackHole audio routing, the pyannote model license, and Hugging Face
authentication require manual setup. See
[`tools/recorder/README.md`](tools/recorder/README.md) for the complete process.

## Secrets and source validation

Bootstrap sets this clone's `core.hooksPath` to `.githooks`. The pre-commit hook
runs a redacted Gitleaks scan against staged content before Git creates a
commit. CI repeats credential scanning as a backstop. Credentials should never
be placed in tracked files.

## Deliberately unmanaged

This repository does not clone the notes repository, manage SSH configuration,
configure firewalls or server services, authenticate applications, remove
unrelated Homebrew software, or delete arbitrary stale symlinks. `dotfiles doctor`
reports known health problems without performing repairs.

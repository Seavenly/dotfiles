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
- A keyboard and mouse attention hub for agent reviews, team PRs, and Markdown briefs.
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
- `Brewfile.macos` owns Ghostty, Obsidian, Hex, and workstation fonts.
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
                                inspect an exact non-mutating execution contract
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
lock or configuration changes uncommitted for review. New releases are available
immediately; the lockfile keeps installations reproducible between upgrades.

Update a single mise-managed tool, such as Codex, through mise so the selected
installation and lockfile move together:

```sh
cd ~/.dotfiles
MISE_LOCKED=0 mise upgrade codex
```

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
| `config/agent-flow/` | Frozen Hermes baseline retained for historical evidence only |
| `config/flow/` | Replacement FlowRuntime inventory, transition policy, public contracts, frozen legacy baselines, and evidence ledger |
| `internal/` | Private commands, bootstrap lifecycle, migrations, and shared shell policy |
| `tests/` | Behavioral tests exercised through module interfaces |
| `tools/recorder/` | Optional recorder application and Python environment |
| `tools/review-inbox/` | Bubble Tea attention hub and JSON CLI for reviews and externally published briefs |
| `tools/review-feed/` | Optional GitHub PR feed for `review-inbox`, scheduled by launchd |
| `tools/drovr/` | Harness-neutral delegated agent runtime over Herdr |
| `tools/flow/` | Public flow transition interfaces and the dark replacement runtime |

Configuration is organized by concern rather than mirroring the destination
layout under `$HOME`. Native mise dotfiles create explicit symlinks from these
directories to their platform-appropriate destinations.

## Flow implementation transition

The harness-neutral `flow` runtime is available beside the maintained Claude-only
and historical Hermes-backed implementations. Hermes is retired: convergence
no longer installs its skills or profiles, preflights its configuration, or
creates its routing file. Existing repository-owned links are removed by
migration 016; local installations and data remain host-owned. New launches
select the Claude-only baseline by default. Repeating `dotfiles install` reapplies
the same versioned policy from `config/flow/launch-policy.v1.json`; it does not change the
selector merely because replacement sources are installed. The launcher
enforces that converged decision.

The operator paths are in the [Flow dark opt-in guide](docs/flow/operator-guide.md).

The public replacement Interface is also fail-closed: `prepare` and `launch`
require a request-local `flow.dark-opt-in/v1` bound to the exact release
manifest. The default `flow-release-1.0-dark/v1` scope contains only the
production feature `verify` and local review routes for sacrificial qualification.
Feature test or mixed modes,
spikes, epics, GitHub review, tracker/forge operations, publication, merge,
push, and other remote mutations return typed disabled or unsupported
outcomes. It does not authorize normal use, remote mutation, later issue runs,
or a change to the Claude default. Use `config/flow/transition-ledger.v1.json`
and the transition projection for the exact release, evidence status, and
legal actions before selecting it deliberately.

The separate `flow-release-1.1-dark-test/v1` configuration adds the bounded Linux
Codex feature-test pilot. Its ordinary request selects only `test:{check_id}`;
the host privately supplies the committed acceptance and positive health checks.
Preparation binds that check without running it, launch refuses changed bindings,
and admitted execution requires real health and RED evidence before one writer,
then GREEN evidence and independent critique before sealing a local candidate.
Select the separate configuration explicitly as described in the guide. Native
test qualification is **NOT_RUN**; deterministic fixture success and historical
qualification do not grant native test permission. The default configuration,
legacy default, normal-use and remote-mutation limits remain unchanged.

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
`tools/flow/src/evidence-safety.mjs`. Catalog v40 preserves the legacy policy
`flow.evidence-safety-policy/v1` and its exact receipt catalog identity
`flow.contract-catalog/v1@39`. Quick research uses the distinct bounded input
policy `flow.research-input-safety-policy/v1` for supplied source contents;
legacy evidence validation and receipt identities remain unchanged. Rejections
produce only typed redacted codes and never read ambient host state.

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

The defaults are `PROJECTS_DIR=~/dev` and `NOTES_DIR=~/notes`. The bootstrap
creates these local files when needed but never commits their contents.
Existing Hermes routing files are retired machine-local data and are no longer
created or read during convergence.

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

## Personal attention hub

Run `review-inbox` to browse local reviews, team PRs, and Markdown briefs in a
mouse-enabled TUI. Navigator is the default layout, with Attention, Reviews,
and Briefs views, search, previews, and local read/dismiss controls. Press `L`
to choose among five layouts; the app remembers that choice on each host.
Use `review-inbox --layout dispatch` to choose a layout for one launch.
Narrow terminals use a
separate detail screen suitable for phone-sized sessions. The same content and
personal state are available through JSON CLI commands for agents.

Collection stays external: the hub reads existing review sources and accepts
published content through `review-inbox publish`. Go is already managed;
the launcher builds and caches the application automatically. See
[`tools/review-inbox/README.md`](tools/review-inbox/README.md) for publishing,
interaction, and host-local configuration.

For an agent-led transition on an existing work host, use the
[fzf-to-TUI handoff](docs/agents/review-inbox-transition.md).

## Optional review feed

`review-feed` keeps the coworker section of `review-inbox` current and raises a
macOS banner when a PR newly needs your review, gets new activity since you
reviewed it, or receives feedback on one of your own PRs. Clicking a banner
opens the PR. A launchd agent runs it every five minutes on weekdays from 08:00
to 17:59.

The agent uses your GitHub credentials, so installation never enables it.
Opt in with:

```sh
review-feed enable     writes ~/.config/dotfiles/review-feed.env on first use
review-feed status     schedule, agent, and feed health
review-feed run        refresh now and print the queue
review-feed logs       last failure and agent output
review-feed disable    stop and remove the agent
```

Set `REVIEW_FEED_ORG` (and optionally `REVIEW_FEED_TEAM` and
`REVIEW_FEED_GITHUB_USER`) in the machine-local file before enabling. The token
comes from `gh auth token`. State lives in `~/.local/state/dotfiles/review-feed`.

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

## Direct CLI execution and optional Drovr

For an explicitly supervised first Linux run, `flow pilot setup` creates a
disposable Git repository, private owner state, pinned verification checks and a
local `flow` client. It starts no owner or provider task:

```sh
flow pilot setup --execution-trust supervised-native-cli \
  --codex-executable /absolute/path/to/codex --mode test
```

Use `--mode verify` for the verification-first route. This additive contract pins
official Codex 0.166.0; the read-only Claude route pins Claude Code 2.1.318.
The generated client's environment explicitly selects supervised execution, and
the prepare and launch requests carry its acknowledgment. Inspect the prepared
confirmation before accepting it. It describes **requested CLI permissions**:
the operator trusts the official CLI's ambient startup and permission controls.
Flow does not independently enforce workspace or tool-network boundaries under
this contract. Start with the documented
[pilot procedure](docs/flow/operator-guide.md#supervised-native-pilot), or select
an existing clean repository with the
[local setup procedure](docs/flow/operator-guide.md#supervised-local-repositories).

Supervised execution retains ownership, cancellation, conservative recovery,
registered verification, exact candidate sealing and independent local review.
It does not alter strict qualification, normal-use authorization, global CLI
permissions, the default launcher, or remote-mutation authority. The strict
direct route described below remains withheld.

Run [`flow-supervised init`](docs/flow/guided-setup.md) inside an existing clean
project for guided npm, Python or Go test selection, a plain-text feature brief,
and a concrete setup preview before confirmation. It installs nothing and starts
no tests, owner or model work. Continue with
[`flow-supervised run`](docs/flow/guided-run.md) to inspect and confirm the exact
task, follow implementation/check/critique progress, and act on fresh authority
decisions without assembling JSON.
Use [`flow-supervised review`](docs/flow/guided-review.md) for a separately
confirmed independent review of the exact retained candidate. Explicit
`--lens security --lens correctness --parallel 2` selects two read-only lenses
and one fresh critic; the original security-only review remains the default.
Use [`flow-supervised research`](docs/flow/guided-research.md) for a bounded
question over explicit local source files. `init --purpose research` needs no
feature brief or project check. Two separately routed read-only delegates produce
a lower-assurance cited report with residual gaps; sources are never fetched.

`flow local setup --execution-trust supervised-native-cli --repository PATH
--brief JSON_FILE --codex-executable PATH` creates a private, reusable client for
an existing repository and prints four preparation commands. An optional
`--client-link PATH` installs a named link without replacing an existing file.
Setup starts no owner, accepts no confirmation, and runs no provider task.
Use the CLI from this source version; the reviewed `flow-supervised` launcher
pins that source and Node executable while the existing `flow` stays unchanged.

The default `verify` mode checks committed Git content observations and an
independent model critique. Without a registered check it does not execute
project test suites or establish runtime behavior. An explicit v2 `--mode verify
--check JSON_FILE` adds a [registered project command](docs/flow/project-checks.md)
for installed npm, Python or Go suites, with bounded execution and GREEN-only
evidence on the captured candidate. `--mode test --check JSON_FILE` selects the existing registered
contract for one pinned Node health check and one acceptance check with a known
expected failure followed by success. These limits appear in the prepared
confirmation and retained run status. Selecting a supervised local request is
separate from changing the legacy default or qualifying the strict release.

The approved scope for issue #92 is a Linux Codex-first dark pilot. This scope
decision does not qualify native execution: current release qualification remains
`not_run`, and public admission remains `qualification_withheld`. Issue #84 must
qualify real Codex startup and permission enforcement against the exact pilot
release before native pilot use. The later full release under parent #2 still
requires both official harnesses. Claude remains blocked by
`claude_native_policy_unproven`; macOS direct execution is unsupported. Sole owner
authority, conservative recovery and independent review remain mandatory. This
pilot does not authorize normal use, legacy-default cutover or remote mutation.

The replacement Flow runtime selects the `direct` execution backend by default.
This is separate from the public launcher policy, whose legacy default remains
unchanged. Set `FLOW_EXECUTION_BACKEND=drovr` before starting an isolated owner
to select the optional historical Drovr adapter. Backend selection never
rebinds existing attempts. `FLOW_CODEX_EXECUTABLE` selects an absolute official
Codex executable; the adapter pins its resolved path, bytes and exact version
(`codex-cli 0.160.0`). An explicit unavailable executable never falls back.

Direct descriptions use `flow.execution-description/v1` and advertise only
implemented initial-input/structured-output semantics. `workspace-write-denied`
requires the card's `repository:write` grant and denies escalation, approvals
and delegate tool network. Direct tasks reject the old human/automatic-review
postures, steering, session continuation and backend switching. `read-only`
uses no mutation grant. Unknown ambient project/managed hooks, plugins or
configuration block; argv alone is not permission qualification. The only writable roots are the exact workspace and owned task scratch;
ambient `/tmp` and `$TMPDIR` grants are excluded. Provider transport and native
saved authentication remain the official CLI's concern.

The provider-local Claude argv/parser is implemented against Claude Code 2.1.287,
but native admission always returns `claude_native_policy_unproven`: managed
hooks and additive roots cannot yet be proven before startup. It advertises no
usable Claude route. Generic effort selection remains Codex-shaped until that
blocker is resolved, so Claude `max` is not admitted by the shared port.

Linux direct tasks require `/usr/bin/python3` with subreaper and pidfd support.
The resolved interpreter and worker bytes are pinned; Python starts with
`-I -S`, and cancellation signals verified ancestry through exact process handles. Flow
owns a private immutable descriptor, exact input/schema bytes, raw output and
atomic terminal receipt under its authority directory. The detached task worker
has no scheduling authority. It retains escaped descendants until positively
reaped; PID age, parent death, missing output or empty process group never prove
retirement. Missing or conflicting receipts remain blocked without blind replay.
macOS direct mutation is unsupported before spawn; use the optional Drovr path
until equivalent containment is implemented and qualified.

Direct feature delegates edit files without access to protected `.git` state.
The prepared `flow.operation/feature-direct-commit/v1` records a local Git
mutation explicitly, reserves exact old/new commit evidence before ref CAS,
and then leaves existing capture, independent critique, operation verification,
sealing, retention and handoff gates in force. No future candidate identity is
supplied by the preparation caller. No push, separate review, remote mutation
or normal-use permission follows from task success.

Implementation fixtures are deterministic subprocess evidence. Native direct
startup/permission, both harnesses, public host recovery and supported-host
qualification remain pending. Changed source/catalog identity withholds public
admission; release content must be regenerated by the documented generator,
and older Drovr qualification cannot be relabeled. See
[ADR-0011](docs/adr/0011-use-direct-cli-tasks-as-primary-flow-execution.md) for
the execution decision and limits.

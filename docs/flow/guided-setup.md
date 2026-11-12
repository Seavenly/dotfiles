# Guided project setup

From an existing **clean Git project** on the supported Linux backend, run:

```sh
flow-supervised init
```

The guide asks what feature you want and for acceptance criteria in plain text.
It detects committed npm, Python or Go test signals and already-installed tools.
If several project types are present, choose one explicitly. Review the concrete
command, executable/library/dependency paths and hashes, pinned tests/config,
private output location, authority, limits and supervised trust disclosure.
Answer `yes` to create that setup, or decline to leave it unchanged.

Init does not install anything or run the project tests, collect pytest tests,
start an owner, contact a provider or launch model work. Discovery reads installed
metadata and uses trusted Git/readelf parsers without executing selected shims or
toolchains. Confirmed setup retains the existing bounded official Codex version
check. Use [`flow-supervised run`](guided-run.md) next to inspect the prepared
task, confirm it and follow implementation, checks and critique. This is
supervised CLI trust, not strict native qualification; Mac native
execution remains unsupported.

After a successful task seals a candidate, use [guided review](guided-review.md).
Explicit two-lens review needs a compatible pinned client and sufficient original
owner runner capacity. It never silently upgrades a retained runtime, changes a checker
or resizes a running owner. The default security-only review remains available
through its original supported client.

## Set up supplied-source research

For a question over explicit local text files, use
`flow-supervised init --purpose research` instead. It previews the selected
project, official executable, private authority and supervised trust contract;
no feature brief, project type or checker is required. Confirmation creates or
reuses an immutable client and runs the existing bounded CLI version check. It
starts no owner, project test or model task.

An existing project keeps its authority, original profile, executable/Git pins
and selected checker. With several clients, select the exact `--client DIRECTORY`.
An older runtime needs the explicit stopped, settled `--upgrade-runtime yes`
procedure below; setup never silently switches it. Continue with the
[research guide](guided-research.md) to supply plain question/source flags and
review a separate launch confirmation.

## Plain flags for scripts

No hand-written JSON is required. For example:

```sh
flow-supervised init --kind npm \
  --summary 'Add filtering to the report command' \
  --acceptance 'Existing tests pass and filtering selects only matching records' \
  --json
```

This prints a read-only plan and `confirmation_digest`. Repeat the same options
with `--confirm sha256:THE_PRINTED_DIGEST --json` to create it. Any selected
project, tool, dependency, checker, output or Git identity drift changes the
digest and requires another preview. A supplied `--brief JSON_FILE` is optional
compatibility with manual setup, rather than a prerequisite.

Codex selection follows the existing supervised adapter's exact supported version
(currently `codex-cli 0.166.0`). An initialized project retains its original
executable path, bytes and version; malformed or changed pins refuse setup. For a
fresh project, init reads the known standalone release layout under `CODEX_HOME`
(default `HOME/.codex`) and supported Mise native payload layouts under
`MISE_DATA_DIR` (default `HOME/.local/share/mise`). It does not search arbitrary
host directories. Custom roots replace these defaults. PATH aliases can identify
these payloads; a newer npm launcher or shim does not replace the supported native
binary. Missing supported installations require a separately installed binary or
an explicit `--codex-executable` selection.

The preview shows the canonical path, SHA-256, expected policy version,
provenance and why a PATH default was bypassed. Expected version is metadata,
not a measured compatibility claim. Default discovery checks the native ELF
header and executes nothing. Confirmed setup still performs the existing bounded
real `--version` check and hashes the selected executable. Explicit paths are
never substituted, including native binaries in other installation layouts;
unsupported versions still fail the central check. This does not admit Codex
0.167 or change any existing execution contract. Init reads no authentication
files and installs nothing.

Useful selections are:

```text
--repository PATH                 default: current Git project, including from a subdirectory
--codex-executable ABSOLUTE_PATH   exact override; default: supported installed native Codex
--tool-executable ABSOLUTE_PATH    select an existing Python or Go installation
--test-directory tests --test-pattern '*_test.py'
--python-runner unittest|pytest
--pin suite.mjs                   repeat for nonstandard existing acceptance/config files
--read-executable /usr/bin/git     repeat for extra installed native test helpers
--timeout-seconds 300              suite budget; separate bounded version probe
--client-link /outside/project/flow-project
```

Extra helpers receive only their exact native executable and statically resolved
ELF library closure. They are not arbitrary shell strings or broad system mounts.
The preview preserves aliases such as `/bin/sh`. The optional client link must
stay outside the project so it does not make the workspace dirty.

After confirmation, private mode-0600 brief, recipe and registration files are
retained outside the repository. Run `flow-supervised run` from that project for
guided preparation and launch. The normal local client also prints four manual commands:
start, prepare by file, inspect the confirmation, and accept the prepared file.
The last command materializes a launch request and prints its explicit launch
command; it starts no provider. Keep those returned paths instead of assembling
large JSON arguments by hand.

## Preset limits and existing projects

- **npm:** requires a committed `package.json` test script. Node/npm, `sh` and
  selected helpers are available. Conventional committed tests are pinned;
  nonstandard named inputs require explicit `--pin`. Existing dependencies need
  an installed `node_modules` tree and committed npm lockfile. Init neither
  installs packages nor assumes the lockfile identifies their installed bytes.
- **Python:** detects `test*.py` and `*_test.py`; ambiguous naming needs an
  explicit pattern. The selected directory/pattern must contain committed tests.
  The isolated preset supports normal project-root imports. Pytest requires an
  already-installed visible package set; supported virtual environments bind
  that package payload explicitly. Missing pytest never silently becomes
  unittest. Unsupported standard-library, symlink or extension-library layouts
  require deliberate [manual registration](project-checks.md).
- **Go:** uses the installed local toolchain, offline module resolution and
  disabled cgo. Dependencies need an existing committed vendor tree for this
  preset. No compiler/module download is attempted.

Every preset runs later against a read-only committed candidate, with private
bounded scratch/cache storage. Tests that write into the project or need other
tools may require project configuration or a manually reviewed recipe. A
GREEN-only check records successful command completion, not intended RED or a
guaranteed test count. Missing prerequisites are errors, never an automatic
fallback to content-only verification. Existing Git clean/process filters or
declared filter attributes are rejected before discovery can execute them,
consistent with the existing controlled commit contract.

Repeated init uses the same canonical repository authority and preserves prior
profiles, clients and receipts. A new acceptance criterion changes the v2 check
identity even if the command is unchanged. Selecting it requires the existing
`--reconfigure-check yes` procedure after retained work is settled and its owner
stopped. A new runtime release similarly needs `--upgrade-runtime yes`.
Init forwards these explicit choices to normal setup; it never clears a claim,
rewrites history or switches state directories to evade a refusal. See the
[operator procedure](operator-guide.md#supervised-local-repositories) for those
existing transitions. The manual v2 path and v1 health/expected-RED/GREEN `test`
contract retain their meanings.

Run `flow-supervised init --help` for the complete option list.

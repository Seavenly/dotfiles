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
check. The subsequent run still needs its own prepared confirmation and explicit
launch. This is supervised CLI trust, not strict native qualification; Mac native
execution remains unsupported.

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

Useful selections are:

```text
--repository PATH                 default: current Git project, including from a subdirectory
--codex-executable ABSOLUTE_PATH   default: an installed PATH entry, never an executed shim
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
retained outside the repository. The normal local client prints four commands:
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

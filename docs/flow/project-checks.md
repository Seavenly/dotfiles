# Registered project checks

Issue [#93](https://github.com/Seavenly/dotfiles/issues/93) adds GREEN-only project
commands to explicitly supervised Linux `feature verify`. Plain `verify` still
runs Git-backed content observations and independent critique without project
tests. The v1 `feature test` contract still requires a positive Node health
probe, its exact intended assertion failure, and the same acceptance check GREEN.
A failed ordinary command is never treated as intended RED.

A v2 check runs after Flow captures the committed candidate, before independent
critique, verification and seal. The registered command must exit zero and its
exact captured candidate must remain unchanged. Writer and critic criterion
observations may use `git_file_sha256` with a repository-relative file and
`expected: "sha256:<64 lowercase hex>"` for its raw bytes. Flow independently
recomputes that digest from the exact captured Git blob. Newly compiled tasks
bind `flow.git-file-observation/v2` and its versioned direct-output schema;
historical tasks without that marker retain their exact v1 schemas and reservation
identities. This avoids transmitting
full ordinary source text as evidence; the unchanged evidence scanner still
rejects ambient host paths and credentials in observations. Legacy
`git_file_equals` remains available for safe short text. A file digest proves
content identity, while the registered suite supplies command execution evidence.
This proves command completion,
not a test count or every behavioral acceptance criterion. Counts and skipped
cases remain whatever the captured stdout/stderr actually report. Nonzero exit,
environment failure, timeout, output exhaustion and cancellation are distinct
retained outcomes. Missing or altered evidence remains unknown, never success.

## Register installed tools without executing them

Choose an existing clean repository, a brief, and the installed toolchain. No
command, dependency or interpreter is installed automatically. Pytest needs an
already-installed compatible Python environment; `python -m unittest` needs only
the selected standard library. Go profiles use local toolchains and offline
module resolution. Missing dependencies are a check failure, not permission to
install or use the network.

Write a `flow.project-check-recipe/v2` JSON file outside the target repository.
The recipe contains these fields:

| Field | Selection |
| --- | --- |
| `check_id` | Stable operator-selected check name |
| `executable` | Canonical absolute executable path |
| `argv` | Exact argument array; no shell-string interpolation |
| `version_argv`, `version` | Exact bounded version command and expected trimmed stdout |
| `cwd` | `.` or a contained project-relative directory |
| `criteria` | Exact ordered acceptance strings from the brief |
| `pinned_files` | Committed test, configuration and lockfile paths the writer must preserve |
| `read_mounts` | Explicit `{ "source": "/canonical/host/input", "target": "/sandbox/input" }` entries |
| `environment` | Exact approved values, including `PATH` |
| `limits` | `timeout_ms` (1 through 1,800,000), `max_output_bytes` (1 KiB through 16 MiB) |

For npm, select Node as the executable and npm's installed `bin/npm-cli.js` as
the first argument, followed by `test`. Bind the npm payload, Node binary, its
dynamic loader/libraries and `/bin/sh` explicitly. Npm may use its normal script
shell to run the project's committed package script. Flow never evaluates a
shell command string. For Python, select its real executable, standard library,
required dynamic libraries and installed package payloads; use an isolated
invocation such as `-I -m unittest discover -v` where supported. For Go, bind its
executable and GOROOT `pkg`, `src` and `lib` inputs; select `go test ./...` as
`argv: ["test", "./..."]`, with `GOROOT`, `GOTOOLCHAIN=local`, `GOPROXY=off`,
`GOSUMDB=off` and `CGO_ENABLED=0` explicitly declared.

A runtime mount must cover the declared executable with that same executable's
canonical bytes. Sources are not arbitrary ambient host access: home roots,
known authentication/configuration roots and the actual authority directory are
rejected, including authority aliases. Directory bindings include file content,
executable bits and contained symlinks; escaping symlinks are unsupported.
Dependencies such as an ignored `node_modules` directory may be explicitly
bound to the same relative `/workspace/node_modules` path only when they mask no
committed content or pinned file. A lockfile alone does not identify installed
dependencies. Do not mount an entire home, system directory or authority to make
a suite pass. There are no implicit host runtime mounts.

Use the CLI from the new source version, or its reviewed pinned launcher:

```sh
flow-supervised local register-check --repository /absolute/project \
  --recipe /outside/project/check-recipe.json \
  --output /outside/project/project-check.json

flow-supervised local setup --execution-trust supervised-native-cli \
  --repository /absolute/project --brief /outside/project/brief.json \
  --codex-executable /absolute/official/codex \
  --mode verify --check /outside/project/project-check.json \
  --client-link "$HOME/.local/bin/flow-project"
```

`register-check` reads and hashes the selected inputs and writes a new mode-0600
`flow.production-project-check/v2` registration. It runs neither version probe
nor project suite and refuses to overwrite its output. Registration and local
setup do not start an owner or provider. Inspect the recipe before registration;
the authority-owned configuration selects commands, while public requests name
only `check_id`.

Follow the four printed commands: start, prepare by file, inspect the exact
confirmation, then `local accept-prepared` to materialize the launch file. That
last step prints the explicit `launch --input-file` command and launches nothing.
The compact inspection includes the selected project-check registration, argv,
mount identities, scope and limits. Keep the owner running while accepting a
separate review; restart changes authority epochs and requires fresh review facts.
Changing check/config/tool inputs requires the existing stopped, settled,
`--reconfigure-check yes` procedure in the [operator guide](operator-guide.md).
It retains the same repository authority and prior clients/history.

## Bounded execution and recovery

The checker sees a read-only snapshot of the exact committed candidate, not
ignored files or ambient repository credentials. Only declared dependency mounts
are added to it. Project commands cannot write the repository or reach the
network. Scratch/cache storage is private capped memory-backed storage; npm,
Python and Go receive private home/cache/tmp settings instead of inherited
credentials, interpreter options or package-manager configuration. Suites that
write build artifacts into the repository fail visibly. Configure those tools
to write into the declared scratch paths rather than granting general writes.
Caches are per-attempt and disappear when the worker retires.

The detached Linux worker reserves one exact run/effect/candidate/check before
spawn, captures bounded stdout/stderr and exit status, and uses subreaper/pidfd
ownership. Only positive retirement of the whole owned process tree permits a
terminal receipt. The version probe is capped separately at five seconds; the
project command uses its confirmed timeout. The enclosing run budget must
include both bounds. This is cooperative host drift detection around read-only
mounts, not an atomic snapshot against a hostile same-user host process.

Public cancellation durably commits first, then requests cancellation of that
same reservation. An owner lost between those steps recovers the cancellation
and adopts the original terminal result. A pending or missing worker/result is
never blindly spawned again. The public run retains the result and log digests;
private evidence files live under its authority's `project-checks-v2` directory.
Do not edit those records or use a second authority to evade a claim.

Cancellation does not undo writer changes or release claims merely because a
checker retired. A cancelled check may leave a clean, committed candidate and
its original workspace claim quarantined. If the refreshed public run offers
`recovery: settle_cancelled_capture`, inspect its exact accepted Git identity and
receipt digests. Accepting that action keeps the captured commit, releases the
claim and records the accepted Git state for the next feature in the same
authority. It never rolls back the writer or marks the cancelled run successful.
See the [public settlement procedure](operator-guide.md#settle-a-cancelled-workspace)
for the exact file-based command.

This action requires the bound successful direct commit and capture, a complete
retired project-check result, every native task positively retired, the sole
original claim and a fresh clean Git observation equal to the retained capture.
Dirty or drifted Git, missing proof and unknown or unresolved external operations
remain held. The existing clean-baseline settlement action retains its own proof
requirements. Mac native execution and strict native qualification remain
unsupported/not-run; this contract grants neither remote mutation nor default
cutover.

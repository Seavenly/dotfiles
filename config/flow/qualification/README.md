# Host-recovery qualification

Issue 46 qualification is driven by the versioned catalog in
`host-recovery.v1.json`. The runner invokes the pinned worktree launcher and
stores external raw receipts; it does not infer a scenario pass from a command
exit code.

## Historical Tuicr prerequisite

The retained issue-46 consumer checks require the installed regular
`github-agavra-tuicr/0.19.0/tuicr` executable reporting `tuicr 0.19.0`.
This is a qualification prerequisite, separate from the current Tuicr version
in `mise.lock`. The normal managed Tuicr selection stays current.

`./dotfiles check` resolves this already installed version with
`mise where github:agavra/tuicr@0.19.0` and validates it before the expensive
suites. Only its Flow and Flow transition children receive the historical
binary directory on `PATH`. Missing or invalid bytes fail with an actionable
message; the check never installs tools or skips those checks.

Provision the historical version explicitly when setting up a qualification
host. The following separate, opt-in command can download it; it does not
activate it, change the normal selection, or modify repository configuration:

```sh
MISE_LOCKED=false mise install github:agavra/tuicr@0.19.0
```

The command-local lock exception is required because this historical version is
outside the current managed lock. Do not use `mise use`, downgrade the normal
Tuicr lock, or substitute current Tuicr bytes for historical proof. Preserve
its exact executable identity in new qualification receipts.

For a direct historical qualification-runner invocation, use an equally scoped
installed-only environment:

```sh
TUICR_QUALIFICATION_DIRECTORY="$(MISE_AUTO_INSTALL=false mise where github:agavra/tuicr@0.19.0)"
```

Prefix each collector invocation below with the scoped `PATH` assignment. The
runner retains its own strict historical executable checks; this setup grants
no qualification.

Create a private run root under `/tmp` and provide every path explicitly:

```sh
PATH="$TUICR_QUALIFICATION_DIRECTORY:$PATH" node config/flow/scripts/run-host-recovery-qualification.mjs \
  --worktree /absolute/path/to/this/worktree \
  --raw-root /tmp/issue-46-<run>/raw \
  --scenario concurrent_runs_owner_restart \
  --run-id run:issue-46-<unique-run> \
  --xdg-state-home /tmp/issue-46-<run>/state \
  --authority-directory /tmp/issue-46-<run>/authority \
  --socket /tmp/issue-46-<run>/authority/owner.sock \
  --endpoint /tmp/issue-46-<run>/authority/owner.json \
  --backup-directory /tmp/issue-46-<run>/backup \
  --repository-root /tmp/issue-46-<run>/repository \
  --drovr-config-directory /tmp/issue-46-<run>/drovr \
  --herdr-session herdr:issue-46-<unique-run>
```

The runner fails closed for relative or overlapping roots, shared/default
Herdr sessions, symlinked ancestors, and launcher/host/Drovr files that resolve
outside the pinned worktree. Raw receipts retain exact release, host, tool,
command, timestamp, exit, log path, and SHA-256 identities. External providers
or credentials that are unavailable are recorded as `blocked`; no pass receipt
may be synthesized.

Aggregate receipts into the tracked evidence shape only after reviewing the
external files:

```sh
node config/flow/scripts/generate-host-recovery-evidence.mjs \
  --worktree /absolute/path/to/this/worktree \
  --raw-root /tmp/issue-46-<run>/raw \
  --receipt concurrent_runs_owner_restart.json
```

Release qualification is fail-closed on the exact tracked issue-46 aggregate.
When governed release content changes, use this order:

1. Regenerate release content.
2. Run the explicit prerequisite bootstrap:
   `node config/flow/scripts/generate-qualification-evidence.mjs --bootstrap-prerequisites`.
   This records only the phase 1/2 prerequisites needed by the public
   headless and Tuicr routes. It reports `prerequisites_ready`, does not claim
   final qualification, and does not consume or rewrite the issue-46 aggregate.
3. Rerun all eight live scenarios under one shared isolation identity.
4. Replace the tracked aggregate through the guarded successor generator.
5. Run `node config/flow/scripts/generate-qualification-evidence.mjs` with no
   arguments for strict final qualification.

The default final invocation always validates the aggregate bytes,
transition-ledger binding, release identity, current tools, and passed status
before it regenerates the two qualification phases. It fails closed on stale
or unbound issue-46 evidence; the explicit bootstrap mode cannot bypass or
stand in for that final consumer.

Every prerequisite or final qualification phase invocation first withdraws both public qualification records by
setting them to `not_run` with no passed evidence identity. A phase is
published as `passed` only after every command in that phase completes and its
evidence bytes are written. Interruption, timeout, or process loss therefore
leaves public transition projection and admission withheld.

The generator keeps deterministic supporting checks separate from live public
or native-provider scenarios. Missing scenario receipts keep aggregate status
`blocked`. Actual reboot and expanded macOS visuals remain `not_run` for issue
47.

The JSON Schema enforces structural minima and strict field shapes. The
executable harness remains authoritative for exact catalog order, cross-field
proof mappings, receipt and capture digests, cleanup retention evidence, and
the recomputed aggregate evidence digest.

## Selected dark-test release

To qualify `flow-release-1.1-dark-test/v1`, pass the same explicit
`--config-directory /absolute/worktree/config/flow/releases/1.1-dark-test`
to the collector and host-evidence generator. The final qualification generator
also requires `--repository-root /absolute/worktree`. Omitting selection keeps
the existing root 1.0 behavior. Selected configuration must be a real directory
inside the pinned worktree's `config/flow` root; symlink or escaping paths are
rejected. Governed source identity still covers the pinned repository, rather
than treating a copied configuration as a separate source release.

Generate selected release content and bootstrap its phase prerequisites first:

```sh
node /absolute/worktree/config/flow/scripts/generate-release-content.mjs \
  --config-directory /absolute/worktree/config/flow/releases/1.1-dark-test \
  --repository-root /absolute/worktree
node /absolute/worktree/config/flow/scripts/generate-qualification-evidence.mjs \
  --bootstrap-prerequisites \
  --config-directory /absolute/worktree/config/flow/releases/1.1-dark-test \
  --repository-root /absolute/worktree
```

Then run the collector example above with that `--config-directory` added,
for all eight catalog scenarios under one explicit run and isolation identity.
The selected configuration reaches the public owner and child probes. The
catalog still requires Drovr registry-lock and six-domain restore compatibility
proofs. Its controlled provider observations do not prove official native
Claude or Codex execution; they retain their original provenance. This scoped
Ubuntu host catalog does not add both-harness or macOS prerequisites to the
Linux pilot. Those broader release requirements and deferred issue 47 coverage
remain separate.

The selected 1.1 ledger initially has a null, `not_run` host record. Its copied
passed 1.0 aggregate is historical evidence, so it cannot satisfy selected
qualification or serve as a selected successor's predecessor. After collecting
and reviewing actual current receipts, initialize the selected binding explicitly:

```sh
node /absolute/worktree/config/flow/scripts/generate-host-recovery-evidence.mjs \
  --worktree /absolute/worktree \
  --config-directory /absolute/worktree/config/flow/releases/1.1-dark-test \
  --raw-root /tmp/issue-89-<run>/raw \
  --initialize-selected-release \
  --preserve-historical-directory /tmp/issue-89-<run>/historical
node /absolute/worktree/config/flow/scripts/generate-qualification-evidence.mjs \
  --config-directory /absolute/worktree/config/flow/releases/1.1-dark-test \
  --repository-root /absolute/worktree
```

First binding accepts only the unqualified selected 1.1 record and a validated
historical passed 1.0 copy. Before writing generated replacement bytes, it
preserves the exact original aggregate and ledger in a content-addressed
external directory as `aggregate.json`, `ledger.json`, and `receipt.json`.
The directory must be disjoint from the source and raw roots. Existing
preservation files are immutable: conflicting bytes or symlinks refuse the
operation. Retain this historical receipt after success or failure; it is
source provenance, not new selected qualification.

Current raw receipts must match the exact selected release, pinned tools and
host. Missing scenarios keep the generated aggregate `blocked`, and final
qualification refuses it. Later refreshes use `--replace-tracked-successor`
with the same selected configuration and an exactly bound selected predecessor.
Both modes compare the original aggregate and ledger bytes immediately before
promotion. Each file rename is atomic; the pair is not a multi-file transaction.
If promotion stops between renames, the mismatched binding fails closed. Retain
the historical receipt and interrupted files for explicit reconciliation; do
not relabel history, hand-edit the ledger, or automatically retry a replacement.

These commands prepare source qualification evidence only. Source and official
native qualification remain `not_run` until their separately owned executions
supply the required evidence. No historical pass, bootstrap result, or fixture
success authorizes native execution, normal use, remote mutation, or a change
to the legacy default.

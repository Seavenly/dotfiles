# Host-recovery qualification

Issue 46 qualification is driven by the versioned catalog in
`host-recovery.v1.json`. The runner invokes the pinned worktree launcher and
stores external raw receipts; it does not infer a scenario pass from a command
exit code.

Create a private run root under `/tmp` and provide every path explicitly:

```sh
node config/flow/scripts/run-host-recovery-qualification.mjs \
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

The generator keeps deterministic supporting checks separate from live public
or native-provider scenarios. Missing scenario receipts keep aggregate status
`blocked`. Actual reboot and expanded macOS visuals remain `not_run` for issue
47.

The JSON Schema enforces structural minima and strict field shapes. The
executable harness remains authoritative for exact catalog order, cross-field
proof mappings, receipt and capture digests, cleanup retention evidence, and
the recomputed aggregate evidence digest.

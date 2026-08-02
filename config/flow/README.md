# Flow compatibility inventory

`flow query legacy-inventory --json` is the read-only Stage 0 inventory for
the frozen Claude-only and Hermes-backed flow implementations. It calls the
`FlowRuntime.query` Interface and returns
`flow.legacy-compatibility-inventory/v1`.

The filesystem Adapter observes these retained authority roots:

- `~/.agent-teams/runs` for Claude-only runs;
- `$XDG_STATE_HOME/agent-flow/runs` for Hermes-backed runs and stack records
  retained beneath them.

Agent Flow stack plans and state may also live at operator-supplied absolute
paths. The retained implementation has no global stack registry, so the default
projection marks that authority uncertain instead of inventing a directory.
Callers embedding `FlowRuntime` may provide an explicit `hermesStacks` root
when they have authoritative local configuration for one.

The inventory records runs, reviews, stacks, artifact bytes, transcript
pointers, active ownership claims, and unresolved effects. Evidence is
classified as:

- `verified` - the observed bytes or known record are present and digestible;
- `missing` - an authority root or referenced file is absent;
- `unreadable` - bytes cannot be read as the expected evidence form;
- `uncertain` - retained bytes or expected authority cannot prove the claimed
  lifecycle fact, cannot be enumerated or linked, or use an unknown contract.

`watermark.content_sha256` is the SHA-256 of the canonical `inventory` object.
It excludes presentation and legal actions, so repeated queries over unchanged
inputs produce the same ledger-ready digest. Host-absolute source paths are not
emitted as projected path fields, while exact retained bytes remain bound by
their content hashes. Ordering uses raw string comparison rather than host
locale. The query never creates a legacy root, follows a symlink, repairs
evidence, or imports legacy lifecycle state into replacement authority.
References outside retained roots are not opened or fingerprinted; they remain
explicit uncertain coverage boundaries. Because operator-supplied stack paths
have no retained registry, the default CLI projection keeps
`inspect_legacy_evidence` legal until that authority gap is recorded or resolved.

`flow query delegated-agent ... --json` is the read-only
`DelegatedAgentPort` preparation projection. It reads the tracked Drovr catalog,
resolves one exact launch, verifies the complete flow-required feature baseline,
and exposes the Drovr configuration watermark and closed legal next actions.
It does not create a replacement run or mutate Drovr delegated work. Until all
required lifecycle features advertise `supported`, the projection is a typed
compatibility block with repair and refresh as its only legal actions.

The same configured port is the mechanism Adapter for confirmed delegate
cards. A caller embedding `FlowRuntime` supplies the durable `RunAuthority` and
registered independent output validators. Flow reserves the exact attempt and
route before it asks Drovr to discover or dispatch, and recovery always
discovers the derived caller key first. Only exact settled output accepted by
every bound validator becomes run evidence. Late or incompatible output is
retained as correlated quarantine and cannot advance the run. Drovr owns its
delegated resources only; it cannot schedule cards or author Flow lifecycle
events. Flow records a named durable handoff while a bounded retry remains and
requires an exact Drovr cancellation proof before handing off an agent whose
turn is still working. An unproven cancellation leaves that same attempt
unresolved for recovery. Flow requires a Drovr retirement receipt before
accepted or exhausted delegated work can settle. A non-destructive bounded
wait preserves the current attempt for same-turn recovery rather than
consuming retry capacity.

Declared managed-agent reuse binds a complete ordered card set to one exact
launch and names the terminal card that must retire it; duplicate agent routes
without that binding fail preparation, and revisions cannot supersede cards
inside the binding. A pre-approved fallback binds one exact
retry to a different harness with the same effective-authority comparison key,
so retry cannot widen capability. Steering inputs carry stable caller
identities and become part of ordered settlement proof. Ambiguous dispatch
stays reconciling. Run cancellation records a fenced cancellation effect,
closes the exact live turn, hands its agent back to the durable registry, and
then permits quarantined delegate retirement settlement. A run terminating
between declared managed cards retires its held agent before cancellation or
decline completes; proven-absent turns hand cleanup to the durable registry.

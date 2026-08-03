# Drovr semantic harness interface

Drovr callers coordinate logical agents and turns. They do not coordinate
Herdr status, pane output, native prompt keys, transcript parsing, polling, or
native-session recovery. Those mechanisms are internal to the semantic harness
boundary in [`src/harness-interface.mjs`](src/harness-interface.mjs).

The boundary is versioned as `drovr.semantic-harness/v1`. It is deliberately
small at the semantic level and keeps topology operations in a separate
namespace because task and agent creation still need placement facts.

## Semantic evidence

Every observation that can affect authority or recovery carries one of these
evidence values:

| Evidence | Meaning | Caller rule |
| --- | --- | --- |
| `present` | The expected managed identity was observed exactly enough for the operation. | The caller may continue the operation. |
| `absent` | The expected managed resource was not observed. | The caller may settle as lost only where the public contract permits it. |
| `changed` | A different managed or native identity, staged snapshot, or ownership relationship was observed. | The caller must fail closed or surface recovery. |
| `uncertain` | The adapter could not prove presence or absence within its bounded observation. | The caller must not guess, replace, or replay the resource. |

Agent identity evidence preserves the managed agent name, Herdr pane identity,
and native Claude or Codex session identity. A pane rebind is reported as a
separate `pane_changed` fact when the native identity remains exact. Lifecycle
code may persist that rebind only after the semantic observation has proven the
native identity. A missing native identity is `uncertain` when a durable record
already contains one; one absent sample is not proof that a staged input is
safe to clear.

Transcript cursors, transition tokens, staged-input tokens, and native session
IDs remain exact opaque values in durable records and semantic results. Callers
pass them back to the interface but do not interpret their native format or
sequence Herdr commands around them.

`ensureRuntime` is a mutating setup acknowledgement; it does not claim that a
runtime was independently observed. Callers that need runtime evidence use
`observeRuntime`.

## Operations

The interface groups operations by the logical decision they support:

- Runtime and launch: `ensureRuntime`, `observeRuntime`, and
  `validateLaunch`.
- Agent identity and lifecycle: `observeAgent`, `observeAgents`,
  `waitForAgent`, `startAgent`, `resumeAgent`, `validateRecovery`, and
  `attach`.
- Logical turns: `prepareTurn`, `deliverTurn`, `waitForTurn`,
  `getLateResult`, and `interruptTurn`.
- Staged input: `inspectStagedInput`, `recoverStagedInput`, and
  `stageUnknownInput`.
- Internal topology: pane, tab, workspace, split, rename, close, and unknown
  input operations under `harness.topology`.

Topology results are semantic facts, not raw Herdr records. The production
adapter normalizes them as follows:

- Pane observations: `paneId`, `tabId`, and `workspaceId`.
- Tab observations: `tabId`, `workspaceId`, and `rootPaneId`.
- Workspace observations: `workspaceId` and `rootPaneId`.
- Process observations: `shellPid` and `foregroundProcesses`.
- Layout observations: `panes[]` with `paneId` and `geometry.width` or
  `geometry.height`.
- Workspace and task-tab creation return `workspaceId`, `tabId`, and
  `rootPaneId`. Rename, close, and input mutations return a typed completion
  acknowledgement. Pane splitting returns the created pane identity. The
  `sendUnknownInput` topology operation accepts an agent identity and text,
  then re-observes the exact managed agent and native session before sending
  to its registered pane; a bare pane ID is not a valid mutation target.

Durable registry records retain their `herdr` identity namespace for schema
compatibility. That persistence shape is not the topology adapter result
contract and is not copied through to replay observations.

`waitForTurn` returns logical outcomes such as `completed`, `still_running`,
`needs_input`, `agent_lost`, and `uncertain`. It owns the bounded polling,
post-delivery transcript grace, ordered-input correlation, blocked-transition
resume observation, and native identity validation needed to produce those
outcomes. A caller may refresh a durable turn or block record between adapter
observations, but it does not add a second polling or correlation loop.

`interruptTurn` distinguishes an already settled turn, confirmed cancellation,
an interruption that remains unconfirmed, and changed or uncertain identity.
Force cleanup requests the `uncertain` timeout outcome; ordinary cancellation
uses the public `interrupted` outcome. Neither path treats an unconfirmed
interrupt as cancellation. An agent without a durable native-session binding
may still be interrupted when its managed identity is exact and no conflicting
identity is observed. An unbound pane rebind without a corroborating native
identity remains blocked; interruption does not infer or persist a native
session.

## Claude and Codex

The shared contract is harness-neutral:

- Codex delivers a prompt through its native prompt operation and correlates
  the ordered logical inputs with the Codex transcript inventory.
- Claude uses its native prompt operation for delivery and its prompt-box
  inspection and guarded recovery operations for staged input. Claude staged
  input is never inferred from a single pane sample.
- Native launch validation, transcript roots, prompt rendering, interrupt keys,
  and harness-specific states remain adapter details. The semantic result
  contains logical state and typed evidence instead.

The production implementation is
[`src/production-harness-adapter.mjs`](src/production-harness-adapter.mjs).
The deterministic `trace-replay` implementation in
[`src/harness-replay.mjs`](src/harness-replay.mjs) uses the same interface for
replayed turn, cancellation, and staged-input traces. It consumes ordered
semantic evidence, transcript records, and clock events; it does not expose a
fake Herdr command client to callers.

There is intentionally no second shallow wrapper around `HerdrClient`. The
production adapter is the one internal implementation that translates native
mechanisms and normalizes topology facts into semantic results. The replay
adapter translates trace events into the same results rather than exposing a
fake Herdr command API.

## Compatibility qualification

Production launch and public description paths qualify exact Drovr, Herdr,
harness, integration, transcript-adapter, and semantic-feature identities.
Replay fixtures carry equivalent facts for the replay and transcript adapters.
Missing, changed, or explicitly unqualified facts return a typed
`compatibility_blocked` result with legal recovery actions; they never authorize
a mutation or a stale launch binding. Qualified results include the
`drovr.compatibility/v1` evidence digest and explicit upstream gaps.

The current upstream gap is Herdr's lack of a typed native raw-key operation.
The production adapter keeps that gesture local and guards every use with the
exact managed identity and staged snapshot. Replay represents the gesture as
an ordered semantic event, so tests can verify the same safety posture without
reimplementing Herdr construction or pane parsing.

## Staged-input recovery invariant

Recovery is bound to the exact staged snapshot token and the exact managed
agent/native-session identity captured by inspection.

For `clear`, the production adapter must observe the snapshot disappear, keep
it absent for the configured stability interval, and perform a final exact
identity observation before returning `cleared`. The default interval is 30
seconds, matching the qualification contract. A snapshot that reappears is
returned internally as `clear_contradicted` with `changed` evidence. A final
identity that cannot be proven is returned internally as `clear_unstable`.
The public staged-input command maps those adapter details to
`recovery_blocked` and `uncertain`, respectively. The adapter never hides a
contradiction by launching a replacement agent or turn.

For `submit`, the adapter returns `submitted` only after the exact managed
identity remains observable and native progress is no longer contradicted by
the submitted action. The staged display may lag native submission, so a
stale prompt-box sample is not itself proof that submission failed.

The stability interval may be set to
`DROVR_STAGED_INPUT_STABILITY_INTERVAL_MS` for deterministic local tests and
qualification fixtures. Production behavior keeps the 30-second default unless
the host explicitly configures another bounded value; the adapter caps this
interval at two minutes.

## Migration invariants

The migration from low-level callers follows these rules:

1. Turn and lifecycle callers invoke semantic operations only. They do not
   import `HerdrClient`, harness transcript modules, or raw harness adapters.
2. Exact managed, pane, native-session, input-order, transcript-cursor, and
   staged-snapshot identities remain durable facts, but their mechanism-level
   ordering is internal to the adapter.
3. Public Drovr statuses and cancellation/recovery rules remain unchanged;
   adapter failures settle to the existing `uncertain` or
   `recovery_blocked` contracts rather than inventing a replacement state.
4. Claude-specific staged-input behavior is explicit in the production
   adapter. Codex does not acquire a fake prompt-box contract merely to make
   the interface symmetrical.
5. New callers use `semanticHarnessFor` and receive one shared adapter facade.
   They do not create a local Herdr polling or transcript-correlation seam.
6. Read-only attach observes runtime presence without creating a missing
   runtime session as a side effect.

Public observation warnings use `agent_lost` for an unsafe managed identity.
`native_session_mismatch` identifies a changed or unbound managed identity;
`session_observation_uncertain` identifies an observation that could not prove
identity. These are warning reasons, not additional lifecycle statuses.

The deletion test in `test/harness-interface.test.mjs` asserts that the
representative turn, lifecycle, recovery, staged-input, creation, observation,
and attachment callers no longer contain low-level harness dependencies. If
the semantic module is removed, those callers fail to import or lose their
semantic operations instead of silently retaining independent mechanism logic.

Future migration work is to expand captured live traces and topology coverage.
Production Herdr behavior remains bounded and directly qualified against the
existing live incident catalog, while deterministic fixtures stay at the
semantic interface boundary.

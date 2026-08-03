# Drovr specification

Status: agreed design, 2026-07-23

Drovr is a host-local, harness-neutral command-line interface for delegating
work to durable Claude Code and Codex agents running in Herdr. It gives an
orchestration agent a small machine-first interface while hiding Herdr layout,
harness launch, transcript parsing, and lifecycle reconciliation.

This document is the implementation authority for the initial Drovr release.

The internal semantic boundary for the implementation is recorded in
[HARNESS-INTERFACE.md](HARNESS-INTERFACE.md). It defines the typed evidence,
identity preservation, adapter split, and migration invariants that keep the
public Drovr contract independent of Herdr command and transcript mechanics.

## Objective

An orchestration agent running in any harness can use Drovr to:

1. Open a delegated task in a global Herdr session.
2. Start or reuse a task-scoped Claude Code or Codex agent.
3. Select its role, capability, model, and reasoning effort.
4. Submit a prompt and optionally steer the active logical turn.
5. Wait for completion or surface a blocked agent to the user.
6. Return the complete final assistant message from the native harness
   transcript rather than terminal scrollback.
7. Continue sending later turns to the same durable agent.
8. Inspect, recover, attach to, retire, and clean up managed resources.

The common first-turn path is one `drovr delegate` invocation. The common
follow-up path is one `drovr ask` invocation.

## Architectural boundary

Drovr owns:

- The dedicated Herdr session used for delegated agents.
- Placement, titles, balanced pane layout, and managed-resource cleanup.
- Claude Code and Codex launch configuration.
- Prompt delivery and logical-turn correlation.
- Full assistant-result extraction from native harness transcripts.
- Durable local records for groups, tasks, agents, turns, and blocked events.
- Status, recovery, attachment, cancellation, and retirement operations.

Drovr does not own:

- Feature, epic, or other flow scheduling.
- Dependency graphs, waves, retries, or orchestration policy.
- Jira, GitHub, Hermes Kanban, PR, merge, or integration policy.
- Worktree creation, preparation, deletion, or Git requirements.
- Answering agent questions or operating native permission menus.
- Cross-host coordination or remote Herdr control.

A future flow driver may use Drovr as its execution foundation, but flow state
and policy remain in that separate module.

## Domain model

Drovr maps its public model onto Herdr without exposing Herdr coordinates to
normal callers:

| Drovr | Herdr | Meaning |
| --- | --- | --- |
| Managed session | Named session | The configurable global agent runtime, default `delegates` |
| Group | Workspace | A collection of related delegated tasks |
| Task | Tab | One independently delegated body of work |
| Agent | Pane and harness process | One durable Claude Code or Codex conversation |
| Logical turn | Native transcript span | One request that may contain multiple steering inputs and native harness turns |

Every resource receives an immutable globally unique ID. Groups, tasks, and
agents also have stable caller-chosen keys and optional mutable display labels.
Task keys are unique within a group, and agent keys are unique within a task.
Existing-resource operations use immutable IDs rather than ambiguous names or
the currently focused Herdr pane.

### Groups

Passing `--group <key>` selects an explicit group. `--group-label` overrides
the visible workspace title.

When no group is supplied, Drovr derives a standalone group from the task cwd:

- A Git worktree uses its shared Git common directory.
- A normal Git checkout uses its repository root.
- A non-Git directory uses its canonical cwd.

The inferred group key includes a canonical identity hash. Its default label is
`<repository-or-directory> - standalone`.

Explicit group keys are global within the managed Herdr session. A caller may
use a namespaced key such as `work/EPIC-123`. An explicit group may contain
tasks from more than one repository.

### Tasks

A task receives an existing cwd from its caller. Drovr validates that it exists
but does not require Git. The task tab uses that cwd, and its agents inherit it
unless a future interface explicitly allows an override.

Opening a task is idempotent while the keyed task is active. A closed task key
is not reopened in the initial release; attempting to open it returns
`task_closed`.

### Agents

Agents are task-scoped and persist across logical turns. Completing a turn does
not stop the process. The orchestrator explicitly retires the agent or closes
the task.

Harness, model, effort, role instructions, capability policy, and other
behavioral launch settings are immutable for an active agent. Starting the same
key with a different resolved launch specification returns
`configuration_conflict`. Agent replacement is not part of the initial release.

### Logical turns

An agent has at most one open logical turn. A logical turn contains:

- One initial input.
- Zero or more ordered steering inputs.
- Zero or more intermediate assistant messages.
- One final settled assistant result, or a terminal non-completion state.

`turn send` adds input only to an explicitly identified open turn. If turn
completion wins a concurrent race, the send returns `turn_closed`; Drovr never
guesses that the message should start a new turn.

## Herdr topology and layout

Drovr uses one configurable named Herdr session, default `delegates`. Mutating
commands create it when missing. Read-only commands report `session_missing`
without creating it.

Drovr invokes that session without inherited caller workspace, tab, or pane
context. The Herdr socket transport may be inherited, but caller topology never
selects or relocates a managed agent.

Drovr mutates only workspaces, tabs, and panes recorded in its registry. It does
not remove unregistered Herdr resources that happen to exist in the same
session.

One task tab may contain several agent panes. Drovr builds a balanced layout
using right and down splits with ratios chosen for the pane count and available
aspect. It rebalances once when agents are created or retired. It does not
continuously overwrite manual resizing or zoom state. Pane titles identify the
agent key or label.

Five or more concurrent agents in one task is supported but treated as an edge
case. Normal task and agent cleanup keeps pane counts manageable.

## Configuration

Tracked user configuration lives under `config/drovr/` and is converged into
the user's Drovr configuration directory. Executable source lives under
`tools/drovr/` and uses the repository's managed Node 22 runtime.

Expected configuration layout:

```text
config/drovr/
├── config.toml
├── roles/
│   └── <role>/
│       ├── role.toml
│       ├── instructions.md
│       ├── claude.md
│       └── codex.md
└── capabilities/
    ├── read-only.toml
    ├── on-approve.toml
    ├── workspace-write.toml
    ├── auto.toml
    └── unrestricted.toml
```

Harness overlays in a role are optional. Resolved instructions compose the
shared `instructions.md` with the selected harness overlay. Project-specific
profile catalogs are deferred.

### Runtime defaults and precedence

Global defaults are:

```text
Harness: Codex
Model: gpt-5.6-sol
Effort: high
Capability: on-approve
```

Roles may provide defaults for harness, model, effort, and capability without
making those axes inseparable. Resolution order is:

1. Resolve the named role, if any.
2. Select harness from the explicit flag, role default, then global default.
3. Select model and effort from explicit flags, matching role defaults, then
   defaults for the selected harness.
4. Select capability from the explicit flag, role default, then global default.
5. Validate the complete resolved configuration through the selected harness
   adapter.
6. Persist the exact resolved specification and catalog fingerprints.

Recovery always uses the persisted launch specification. It does not silently
adopt later catalog changes.

### Capability profiles

Capabilities are portable policy intents with explicit harness mappings. Drovr
must report the resolved native settings and fail with
`unsupported_configuration` rather than silently weakening or substituting a
requested policy.

#### `read-only`

Claude Code launches with `dontAsk` and an allowlist of read-oriented tools,
including guarded Bash so recognized commands such as `git diff` can run.
Commands that would normally request mutation approval are denied.

Codex launches with:

```text
--sandbox read-only
--ask-for-approval never
```

#### `on-approve`

Claude Code launches in its native manual/default permission mode. The adapter
handles version-specific naming.

Codex launches with:

```text
--sandbox read-only
--ask-for-approval on-request
approvals_reviewer = "user"
```

#### `workspace-write`

Claude Code launches with `--permission-mode acceptEdits`.

Codex launches with:

```text
--sandbox workspace-write
--ask-for-approval on-request
approvals_reviewer = "user"
sandbox_workspace_write.network_access = false
```

Direct command network access is approval-gated. Native cached web search
remains separate from spawned-command network access.

#### `auto`

Claude Code launches with `--permission-mode auto`. Drovr validates that the
installed version, account, model, provider, and managed policy make the mode
available.

Codex launches with:

```text
--search
--sandbox workspace-write
--ask-for-approval on-request
approvals_reviewer = "auto_review"
sandbox_workspace_write.network_access = false
```

Live native web search is available without per-call approval. Spawned-command
network access crosses the sandbox boundary and is eligible for automatic
approval review. The policy does not promise that no human input will ever be
required.

#### `unrestricted`

Claude Code launches with `--permission-mode bypassPermissions`.

Codex launches with:

```text
--sandbox danger-full-access
--ask-for-approval never
```

Managed harness policy may reject unrestricted operation.

## Public command interface

The high-leverage interface for normal orchestration is:

```text
drovr delegate [options] [PROMPT]
drovr ask AGENT_ID [options] [PROMPT]
drovr attach AGENT_ID [--takeover]
```

`delegate` composes task open, agent start, turn start, turn wait, and turn get.
`ask` composes turn start, turn wait, and turn get for an existing agent.
`attach` is interactive and directly attaches the caller's terminal to the
managed Herdr agent.

The recovery and advanced interface is:

```text
drovr doctor
drovr status
drovr describe [launch options] --caller-metadata JSON

drovr group list
drovr group get GROUP_ID
drovr group close GROUP_ID [--force]

drovr task open [options]
drovr task list [filters]
drovr task get TASK_ID
drovr task close TASK_ID [--force]

drovr agent start TASK_ID [options]
drovr agent list [filters]
drovr agent get AGENT_ID
drovr agent staged-input AGENT_ID [--submit TOKEN | --clear TOKEN | --clear-unknown TOKEN | --stage-unknown-file PATH]
drovr agent retire AGENT_ID

drovr turn start AGENT_ID [options] [PROMPT]
drovr turn dispatch AGENT_ID --caller-key KEY --input-key KEY \
  --caller-metadata JSON --launch-binding JSON [PROMPT]
drovr turn discover CALLER_KEY
drovr turn send TURN_ID [options] [PROMPT]
drovr turn wait TURN_ID [--timeout DURATION]
drovr turn wait TURN_ID --after-block BLOCK_ID [--timeout DURATION]
drovr turn get TURN_ID [--include-messages]
drovr turn list [--agent AGENT_ID] [--task TASK_ID] [--status STATUS]
drovr turn cancel TURN_ID
```

`describe` is the non-mutating delegated-runtime contract seam. It resolves the
same tracked role, harness, model, effort, capability, instructions, native
settings, and logical catalog fingerprints used by agent launch, but it never
creates or changes a Drovr registry or Herdr resource. Its versioned result
also carries normalized effective authority, declared capacity, an ambient
credential-reference identity with no secret material, opaque caller ownership
metadata, deterministic comparison keys, and the complete flow-required
feature advertisement. The configuration-catalog watermark binds those facts.
Declared capacity includes a 30-second Herdr observation bound, which applies
to both session discovery and session-scoped read-only observations.
Every feature entry carries an exact `supported` or `unavailable` availability
state. The watermark includes the complete feature advertisement and the full
authority-dimension catalog used to normalize effective authority.

The flow-required feature baseline is exact launch description,
caller-idempotent dispatch and discovery, caller-keyed ordered input, bounded
observation and wait, transcript correlation, cancellation and reconciliation,
terminal-proof classification, late-result correlation, launch-binding
settlement proof, opaque caller ownership metadata, and feature advertisement.
Flow conformance compares the complete versioned guarantees, not just feature
names or a Drovr version string. Missing, weakened, duplicate, unexpected, or
contradictory advertisement blocks preparation until a fresh conforming
description can be observed.

The complete baseline is supported. Caller-owned dispatch validates the exact
description digest, launch comparison key, configuration watermark, and opaque
metadata against the persisted agent launch before Herdr is touched. An exact
caller-key and payload retry adopts one durable logical turn. A payload conflict
fails closed, and a complete registry scan distinguishes proven absence from a
discovery failure. An agent whose immutable binding is missing, or differs from
a fresh description of that same agent launch, fails closed with an explicit
retirement disposition. A caller description for another launch is repairable
by refresh and never authorizes retirement. Each initial and steering input
carries its own stable caller key and payload digest; settlement remains gated
on their recorded order.

Terminal projections name the proof classification and bind completed
settlement to the exact launch comparison key and ordered inputs. Cancellation,
interruption, uncertainty, and late transcript correlation retain distinct
dispositions. Drovr and Herdr restart recovery use the persisted agent and turn
bindings without replaying an unresolved input or refreshing catalog identity.

Creation options use stable keys and optional labels. Normal examples include:

```text
drovr task open --key FEATURE-456 --label "Add passkey login" --cwd PATH
drovr task open --group EPIC-123 --group-label "Authentication overhaul" \
  --key FEATURE-456 --cwd PATH

drovr agent start TASK_ID --key critic --label "Implementation review" \
  --role reviewer --harness codex --model gpt-5.6-sol --effort high \
  --capability read-only
```

Omitted launch fields use role and global defaults. `delegate` accepts the task
and agent creation fields required to perform the same composition in one
invocation.

### Prompt sources

Every prompt-bearing command accepts exactly one of:

1. A final positional prompt.
2. `--prompt-file <path>`.
3. Piped or redirected standard input when neither of the first two exists.

Supplying multiple sources returns `ambiguous_prompt`. Supplying none returns
`missing_prompt` immediately rather than waiting interactively. A positional
prompt beginning with `-` follows normal `--` option termination.

Trailing whitespace is removed from the resolved prompt before it becomes a
durable input. A file or standard-input prompt is terminated by a newline that is
not part of the submission and that Codex does not write into its transcript, so
preserving it would durably record an input no harness can echo back and
correlation could never match. A prompt that holds only whitespace therefore
returns `missing_prompt`. Leading and interior text is preserved exactly.

### Machine output and exit codes

Non-interactive commands emit one versioned JSON document on stdout by default.
Stdout contains no progress prose. Progress and diagnostics go to stderr.
Human-oriented text rendering may be selected explicitly in a later release.

Expected lifecycle and conflict outcomes exit `0` with structured JSON,
including:

- `completed`
- `still_running`
- `needs_input`
- `cancelled`
- `interrupted`
- `uncertain`
- `task_busy`
- `task_closed`
- `turn_closed`
- `configuration_conflict`
- `caller_key_conflict`
- `launch_binding_conflict`
- `launch_binding_missing`
- `launch_binding_stale`
- `agent_lost`
- `recovery_blocked`
- `session_missing`
- `unsupported_configuration`
- `unsupported_transcript`

Nonzero codes are reserved for Drovr failures:

| Code | Meaning |
| --- | --- |
| 2 | Invalid command or arguments |
| 3 | Missing or invalid configuration or prerequisite |
| 4 | Herdr or harness adapter execution failure |
| 5 | Corrupt registry or internal invariant violation |
| 130 | The caller interrupted a waiting Drovr process |

`attach` is the deliberate exception: it becomes an interactive terminal stream
and does not emit the normal JSON envelope.

## Turn lifecycle and results

`turn start` captures and persists the harness transcript cursor before prompt
delivery. It then submits the prompt through Herdr and returns a durable turn
ID. `turn wait` may be invoked repeatedly by any later caller.

For every Claude prompt delivered while the native agent is settled, Drovr
looks for `working` or `blocked`; an idle state-token change alone is not
submission evidence. If Claude's asynchronous bracketed-paste conversion leaves
a multiline or long single-line prompt staged and the agent idle, Drovr waits
for the newly staged content to appear either as literal prompt-box text or as a
new visible Claude attachment token, sends one guarded submit key, and requires
active-state evidence before continuing. Drovr refuses to append a new turn
over prompt text that was already staged before delivery. This preflight occurs
before a logical turn is created and returns `recovery_blocked` with an exact
inspection command and staged-input token. A single-line
delivery with no visible staged content proceeds to exact native transcript
correlation only when Herdr reports a new `done` observation, because a short
turn can complete before the first post-delivery poll. Pane output is used only
as delivery-readiness evidence; it is never completion authority. Failure to
observe staged content or a native transition is an adapter failure and leaves
the turn `uncertain`; it is not treated as native settlement.

When Drovr observes an empty Claude prompt box become staged during its own
delivery attempt but cannot confirm submission, the uncertain turn retains an
exact staged-input receipt. The receipt binds the complete visible literal input,
original input digest, agent, pane, native session, and pre-delivery state token.
Attachment placeholders and partial visible matches are never ownership proof.
`agent staged-input` compares the current prompt-box snapshot with that receipt.
An exact match may be submitted or cleared non-interactively with the returned
token. Submission remains correlated to the original uncertain logical turn and
never creates a replacement turn. Clearing sends one guarded interrupt key and
succeeds only after the same native session is settled with an empty prompt box.
A mismatch or changed native identity returns `recovery_blocked` without
terminal mutation. Unknown prompt text is preserved by default; the operator may
explicitly authorize clearing that exact inspected snapshot with
`--clear-unknown TOKEN`.

`--stage-unknown-file PATH` provides a bounded public stimulus for diagnostics
and qualification. It may write normalized file content only to the exact
registered pane of a settled Claude agent with no existing staged text or open
logical turn. It never sends a submit key or creates a turn, and succeeds only
after the same native session exposes the exact text as an unknown staged-input
snapshot. Any identity, state, or content mismatch fails closed.

Native waiting first returns an already-settled observation rather than waiting
for another state change. If the pre-delivery state persists past the bounded
transcript grace, Drovr makes one exact transcript-correlation attempt and then
settles the turn `uncertain` when the recorded input is absent. This keeps legacy
or interrupted delivery records recoverable without accepting an old result.
For a managed agent already bound to a native session, a settled observation is
accepted only when it reports that exact session. A missing or different native
identity settles the logical turn `uncertain` without reading or interrupting the
reported pane. Losing the managed agent while waiting likewise settles the turn
`uncertain` without launching recovery.

Wait timeout is non-destructive. It returns `still_running` and leaves the turn
and harness untouched. Killing a waiting Drovr process also does not cancel the
turn.

`delegate`, `ask`, and `turn wait` are non-streaming. Each writes exactly one
command-result document after settlement or timeout and writes no intermediate
progress output while its process remains active. `turn get` is the
nonblocking durable-state observation command. A caller whose execution layer
yields a live process handle resumes that process; the absence of an output
chunk does not mean the Drovr command exited successfully.

`turn cancel` explicitly interrupts the current native operation while keeping
the durable agent available. The logical turn becomes `cancelled` only after
Drovr observes settlement. If interruption delivery or settlement cannot be
confirmed, the turn becomes `uncertain` or `interrupted` rather than pretending
success. If the native agent is already settled, cancellation reports the exact
reconciled terminal status instead of waiting for a future native transition.
If identity-safe recovery is blocked before interruption, cancellation records
the logical turn as `uncertain` and retains the typed recovery outcome.

`agent retire` terminates the harness process and closes its managed pane.

### Steering

`turn send` records an ordered input and sends it to the working harness. Claude
Code or Codex may treat the message as queued or as active-turn steering. Drovr
models both behaviors as additional input to the same logical turn. Delivery
revalidates the exact native-session owner after acquiring the turn lock; a
remapped or identity-less pane receives no input.

Completion requires:

1. Every recorded turn input is observed in the native transcript in order.
2. A completed assistant response occurs after the final input.
3. Herdr reports the agent settled.

From the first recorded input onward, the transcript adapter treats any
unrecorded native input as a correlation boundary. It never skips such an input
to select a later assistant response, so a human message typed into the native
harness can neither be mistaken for a recorded input nor contribute its answer to
a recorded turn.

Native records that precede the first recorded input are session context rather
than a correlation boundary. A harness writes its own context when a session
opens - Codex records the applicable `AGENTS.md` and an `environment_context`
block as a user-role transcript message before the first delivered prompt - and
that context cannot be confused with a result that is only ever read after the
final recorded input.
Correlation grace is bounded per observed stage of progress, including input
appearance and final-result appearance, rather than from the first possibly
stale settled observation.

The primary result is the last settled assistant message. Intermediate
assistant messages are retained and available through `--include-messages`.
If a transcript-correlatable result appears only after a turn was durably
settled as `uncertain`, `turn get` may expose it as a non-durable `late_result`
projection. It also supports legacy `unsupported_transcript` records explicitly
marked for exact transcript correlation. Exact ordered inputs and the absence
of an intervening unrecorded native input are required. Discovery never changes
the terminal status or writes a result into the durable turn record.

For compatibility with turns produced by the earlier Claude delivery defect,
late-result projection may also correlate one native user message that exactly
concatenates a known earlier Drovr input which failed with the staged-attachment
error and the current turn's first input. This recovery remains exact: an
arbitrary native prefix or any later unrelated input is still a correlation
boundary.

### Blocked agents

Drovr detects but does not resolve blocked agents. On a new blocked transition,
`turn wait`, `ask`, or `delegate` returns `needs_input` with:

- A stable block ID.
- Turn, agent, task, and harness identity.
- A current terminal excerpt.
- A ready-to-run `drovr attach AGENT_ID` command.

The top orchestration agent is responsible for notifying the user. The user
attaches directly and interacts with the native harness.

After surfacing a block, the orchestrator may either wait for user confirmation
and invoke `turn wait` again, or invoke:

```text
drovr turn wait TURN_ID --after-block BLOCK_ID
```

That form waits past the acknowledged blocked state, observes the agent return
to working, and continues until completion or a new blocked transition. A new
transition receives a new block ID.

## Native transcript adapters

Herdr owns startup, prompt delivery, and lifecycle observation. Harness JSONL
transcripts own conversation content and complete assistant results. Terminal
scrollback is never an output fallback.

Drovr uses Herdr's official integration-reported native session reference to
locate the transcript:

- Claude Code under its configured project transcript root.
- Codex under its configured session rollout root.

Before delivery, the harness adapter stores an adapter-specific cursor including
the transcript identity, position, and an anchor fingerprint. After delivery it
scans records after that cursor, observes the ordered input content, and extracts
assistant records using known harness structures.

Drovr does not inject correlation markers into prompts. If cursor, content,
settlement, or final-message correlation cannot be established, it returns an
explicit uncertain or unsupported state rather than selecting the latest screen
or transcript message.

A transcript file that has not appeared yet is a temporary correlation failure
and therefore `uncertain`. `unsupported_transcript` is reserved for an
incompatible cursor, changed anchor, malformed JSONL record, or another format
Drovr cannot safely interpret.

When Claude role instructions are non-empty, Drovr writes their exact resolved
bytes to a private launch document beneath the state directory and supplies its
path through Claude's native system-prompt file option. The launch document is
derived from the persisted immutable specification and recreated for recovery.
Drovr does not inline multiline role text or bypass Herdr's shell-safety checks.

Transcript knowledge is isolated behind versioned Claude Code and Codex
adapters. Executable versions, Herdr integration versions, and adapter versions
are persisted diagnostically. Compatibility is determined through supported
flags, reported capabilities, and observed transcript structure rather than a
rigid executable-version allowlist.

## Registry and authority

Drovr has no daemon. Every invocation reconciles relevant durable state and
Herdr observations, performs its operation, commits state, and exits.

Machine-local state lives under the XDG state directory in a file-based
registry. It stores groups, tasks, agents, turns, ordered inputs, extracted
messages, results, launch specifications, native session references, transcript
cursors, blocked events, and lifecycle history.

Registry requirements:

- Atomic file replacement.
- Narrow per-resource locks.
- No exclusive lock held for the duration of `turn wait`.
- Private state-directory and file permissions.
- No flow scheduling, tracker, worktree-ownership, or merge state.

Private launch documents derived from immutable launch specifications live
beside the registry with owner-only permissions. They are runtime inputs, not a
second source of launch authority.

Authority is divided deliberately:

- Herdr is authoritative for live process and layout state.
- Native harness transcripts are authoritative for conversation content.
- Drovr is authoritative for logical identity, correlation, and observed result
  records.

Task and group closure preserve turn inputs, messages, and results indefinitely
in the initial release. Destructive purge and retention policy are deferred.

## Recovery

Current official Herdr integrations for Claude Code and Codex are required.
Herdr's own native session restore handles a full Herdr server restart. Drovr
reconciles restored panes back to registered agents.

When a mutating command needs an active registered agent and confirms that its
named Herdr agent is absent, an absent exact persisted pane is confirmed-down
evidence. A present pane is recoverable only when its process inventory contains
the pane shell and no other foreground process. If the pane is absent, Drovr
recreates a missing managed workspace or task tab, or splits from an exact
registered sibling pane in the surviving task tab, before rebinding the agent.
An unowned surviving tab remains ambiguous. Drovr may automatically resume
the native session only when:

1. Registry state says the agent should still be active.
2. The original task and cwd remain active and present.
3. A valid native session reference and local transcript exist.
4. No other live managed pane reports the same session reference.
5. The persisted immutable launch configuration remains satisfiable.
6. The resumed harness reports the expected native session identity.

Read-only commands report observed loss without launching anything. Failed
safety checks return `recovery_blocked`. No manual resume override is included
initially.

If the agent was idle when lost, successful recovery makes it available for a
new logical turn. If it was working, Drovr restores the conversation but marks
the prior turn `interrupted`. It never automatically repeats the interrupted
prompt or assumes tool side effects did not occur.

## Cleanup

`task close` retires its agents, closes its managed tab, and preserves durable
history. It refuses when an agent is working or blocked unless `--force` is
supplied. When the task is the group's final active task, Drovr first creates
one exact group-owned idle tab in the registered workspace so Herdr can close
the task tab without violating its final-tab constraint. The idle tab remains
registered to the group until `group close`; it is not a delegated task and
does not change the group's lifetime.

`group close` preflights every task before mutation. Without `--force`, any busy
task prevents the whole group closure. With `--force`, active work is
interrupted and unfinished turns are marked accordingly. Group cleanup closes
the exact registered workspace as one topology operation, verifies that
workspace and its registered task tabs are absent, and then retires agents and
closes tasks in the durable registry. It does not close task tabs individually.

Cleanup may finalize a stale bound agent only after confirming that its exact
managed name and exact registered pane are both absent and that no other live
agent owns its native session. A surviving registered pane, duplicate managed
name, native-session mismatch, or duplicate native-session owner fails closed
before topology mutation.

Closing the last task does not implicitly close an explicit group. The inferred
standalone workspace also remains persistent by default; both use the same
group-owned idle-tab behavior.

Drovr never deletes task worktrees or other caller-owned directories.

## Doctor and status

`drovr doctor` checks at least:

- Node, Herdr, Claude Code, and Codex availability and versions.
- Required Herdr integrations and minimum native-session capabilities.
- Access to configured transcript roots.
- User configuration, role, and capability validity.
- Supported launch flags and requested capability features.
- Recognized structure in available native transcripts.

A newer executable version produces a warning rather than failing solely by
version. An actual missing capability or unsupported transcript structure fails
the relevant operation without weakening the requested behavior.

`drovr status` gives a machine-readable overview of the managed session, groups,
tasks, agents, active turns, blocked events, loss, and reconciliation warnings.

## Host and process constraints

The initial release is single-host and single-user. Drovr, Herdr, both harnesses,
the registry, and native transcripts run under the same user account on the same
host.

Herdr is controlled exclusively through its public CLI and JSON output. Drovr
does not connect directly to the Herdr socket API initially. Claude Code and
Codex remain interactive TUI processes inside real Herdr panes.

## Future flow integration

Drovr is intended to support a future harness-neutral replacement for the
current Claude-only feature and epic flows:

```text
User
  -> orchestration agent in the user's Herdr session
    -> future flow driver or shared orchestration skill
      -> Drovr
        -> durable Claude Code and Codex delegates
```

The future feature flow may own one Drovr task. A future epic flow may pass a
shared group identity to several feature tasks and close the group at final
wrap-up. That flow layer continues to own interviews, briefs, worktrees, role
selection, dependencies, human gates, Git, trackers, and integration.

The current Claude-only and Hermes agent-flow implementations are not modified
or migrated as part of Drovr's initial implementation.

## Initial acceptance criteria

The initial release is complete when a caller can, through the public interface:

1. Diagnose a compatible local environment.
2. Open an explicit or inferred task with a balanced Herdr tab.
3. Start Claude Code and Codex agents with resolved role, capability, model, and
   effort settings.
4. Delegate one prompt to either harness and receive its complete final native
   assistant message as versioned JSON.
5. Reuse the same agent for a later `ask` turn.
6. Add steering input to an active logical turn and correlate the eventual
   result with every input.
7. Recover turn IDs and results after the calling Drovr process exits.
8. Surface a blocked agent with a usable direct-attach command, then continue
   waiting after manual intervention.
9. Preserve task, agent, and turn records across invocations and normal cleanup.
10. Safely reconcile a Herdr restart and conservatively recover a confirmed-down
    idle agent session.
11. Retire agents and close tasks or groups without deleting caller-owned cwd
    content.

Live verification must exercise fresh and reused Claude Code and Codex sessions
through Herdr. Focused automated tests are valuable at the public command seam,
registry transition seam, and transcript-adapter seam; broad regression work on
the unrelated Hermes and Claude flow implementations is not required.

## Suggested implementation sequence

Build vertical tracer bullets through the public command interface rather than
finishing all registry, Herdr, or adapter internals horizontally:

1. Scaffold `tools/drovr`, `bin/drovr`, versioned JSON envelopes, configuration
   loading, and `drovr doctor`.
2. Deliver one complete Codex `drovr delegate` path that opens a task, starts an
   agent, records a turn, waits, correlates the native transcript, and returns
   the complete result.
3. Add the Claude Code adapter through the same public path.
4. Add durable reuse with `ask`, explicit steering, `wait`, `get`, and turn
   discovery.
5. Add blocked-event surfacing, direct attachment, and post-block waiting.
6. Add cleanup, cancellation, restart reconciliation, and conservative native
   session recovery.
7. Complete list, get, status, group, and force-cleanup operations needed for
   diagnosis and lifecycle management.

Each slice should keep the public JSON contract usable and verify the real
Herdr and harness path as soon as the slice can run safely.

## Deferred work

The initial release excludes:

- Drovr-mediated answers, approval choices, or raw permission-menu keys.
- Project-specific profile catalogs.
- Agent replacement.
- Manual resume or recovery overrides.
- Purge commands and retention policies.
- Remote Herdr or cross-host registries.
- Direct Herdr socket integration.
- Streaming watch output or NDJSON event mode.
- TOON output.
- Images and other rich prompt attachments.
- Flow scheduling, Jira, GitHub, worktree, PR, merge, or integration policy.
- Modifications or migration of existing Claude-only or Hermes flows.

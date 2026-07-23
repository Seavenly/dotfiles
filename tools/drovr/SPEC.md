# Drovr specification

Status: agreed design, 2026-07-23

Drovr is a host-local, harness-neutral command-line interface for delegating
work to durable Claude Code and Codex agents running in Herdr. It gives an
orchestration agent a small machine-first interface while hiding Herdr layout,
harness launch, transcript parsing, and lifecycle reconciliation.

This document is the implementation authority for the initial Drovr release.

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
drovr agent retire AGENT_ID

drovr turn start AGENT_ID [options] [PROMPT]
drovr turn send TURN_ID [options] [PROMPT]
drovr turn wait TURN_ID [--timeout DURATION]
drovr turn wait TURN_ID --after-block BLOCK_ID [--timeout DURATION]
drovr turn get TURN_ID [--include-messages]
drovr turn list [--agent AGENT_ID] [--task TASK_ID] [--status STATUS]
drovr turn cancel TURN_ID
```

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

Wait timeout is non-destructive. It returns `still_running` and leaves the turn
and harness untouched. Killing a waiting Drovr process also does not cancel the
turn.

`turn cancel` explicitly interrupts the current native operation while keeping
the durable agent available. The logical turn becomes `cancelled` only after
Drovr observes settlement. If interruption delivery or settlement cannot be
confirmed, the turn becomes `uncertain` or `interrupted` rather than pretending
success.

`agent retire` terminates the harness process and closes its managed pane.

### Steering

`turn send` records an ordered input and sends it to the working harness. Claude
Code or Codex may treat the message as queued or as active-turn steering. Drovr
models both behaviors as additional input to the same logical turn.

Completion requires:

1. Every recorded turn input is observed in the native transcript in order.
2. A completed assistant response occurs after the final input.
3. Herdr reports the agent settled.

The primary result is the last settled assistant message. Intermediate
assistant messages are retained and available through `--include-messages`.

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
process is absent, it may automatically resume the native session only when:

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
supplied.

`group close` preflights every task before mutation. Without `--force`, any busy
task prevents the whole group closure. With `--force`, active work is
interrupted, unfinished turns are marked accordingly, agents are retired, tabs
are closed, and the group workspace is closed.

Closing the last task does not implicitly close an explicit group. The inferred
standalone workspace remains persistent by default.

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

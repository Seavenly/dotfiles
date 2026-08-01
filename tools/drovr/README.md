# Drovr

Drovr is the host-local delegated agent runtime described in [SPEC.md](SPEC.md).
The current implementation provides configuration validation, `doctor`,
complete Claude Code and Codex `delegate` paths, durable multi-turn reuse,
registry discovery, status observation, cancellation, retirement, task and
group cleanup, Herdr restart reconciliation, and conservative native-session
recovery.

After convergence, diagnose the local runtime:

```sh
drovr doctor
```

Inspect an exact launch and the complete flow-required feature advertisement
without creating a delegation group, task, agent, or logical turn:

```sh
drovr describe \
  --harness codex \
  --role reviewer \
  --capability read-only \
  --caller-metadata '{"run_id":"run:example","card_id":"review"}'
```

The `drovr.delegated-agent-description/v1` result contains the resolved launch
schema and native settings, normalized effective authority, capacity facts,
ambient credential-reference identity, logical catalog fingerprints, opaque
caller metadata, comparison keys, and all flow-required feature contracts.
Its `drovr.configuration-catalog` watermark binds the complete configuration
and advertised contracts without exposing credential material. Identical
catalog bytes and inputs produce identical identity-bearing output even when
the catalog is installed at a different path.

Each advertised contract declares `supported` or `unavailable`. The current
runtime reports caller-idempotent dispatch and discovery, caller-keyed input,
terminal-proof classification, launch-binding settlement proof, and durable
opaque caller ownership metadata as unavailable. This is an exact capability
report, so Flow blocks binding until those lifecycle contracts are supplied.

Delegate one logical turn:

```sh
drovr delegate \
  --task-key example \
  --agent-key builder \
  --cwd /path/to/existing/directory \
  "Reply with a concise implementation plan."
```

Select Claude Code through the same command seam:

```sh
drovr delegate \
  --task-key example \
  --agent-key builder \
  --cwd /path/to/existing/directory \
  --harness claude \
  "Reply with a concise implementation plan."
```

`--group` and `--group-label` select an explicit delegation group. Without
`--group`, Drovr derives a standalone group from the task cwd. Launch settings
may be selected with `--role`, `--harness`, `--model`, `--effort`, and
`--capability`; tracked defaults live under `config/drovr/`.

Advanced callers can create the durable resources without starting a turn:

```sh
drovr task open \
  --group EPIC-123 \
  --group-label "Authentication overhaul" \
  --key FEATURE-456 \
  --label "Add passkey login" \
  --cwd /path/to/existing/directory

drovr agent start TASK_ID \
  --key critic \
  --label "Implementation review" \
  --role reviewer \
  --harness codex \
  --model gpt-5.6-sol \
  --effort high \
  --capability read-only
```

Task keys are stable within a group and agent keys are stable within a task.
Repeated identical opens and starts return the existing immutable IDs. Labels
may be changed later, but an active agent's resolved role, harness, model,
effort, capability, native settings, and catalog fingerprints are immutable.
Omitted launch fields resolve from the selected role and then the tracked
global or harness defaults. Closed task keys and retired agent keys are not
replaced in the initial release.

`delegate` composes these same task-open and agent-start paths with turn start,
wait, and result retrieval. It does not maintain a parallel creation path.

Prompt-bearing commands accept exactly one positional prompt,
`--prompt-file`, or standard input. Non-interactive output is one
`drovr.command/v1` JSON document on standard output. Durable local records live
under `${XDG_STATE_HOME:-~/.local/state}/drovr/`.

Reuse the returned agent ID for a later logical turn:

```sh
drovr ask AGENT_ID "Review the result from your previous turn."
```

Advanced callers can separate delivery and observation across processes, steer
an active turn, discover durable resources, and inspect current reconciliation
warnings:

```sh
drovr turn start AGENT_ID "Begin the review."
drovr turn send TURN_ID "Prioritize correctness."
drovr turn wait TURN_ID --timeout 5m
drovr turn wait TURN_ID --after-block BLOCK_ID --timeout 5m
drovr turn get TURN_ID --include-messages
drovr turn list --agent AGENT_ID
drovr turn cancel TURN_ID
drovr status
drovr group list --status active
drovr group get GROUP_ID
drovr task open --key TASK_KEY --cwd /path/to/existing/directory
drovr task list --group GROUP_ID --status active
drovr task get TASK_ID
drovr agent start TASK_ID --key AGENT_KEY
drovr agent list --task TASK_ID --status active --harness codex
drovr agent get AGENT_ID
drovr agent retire AGENT_ID
drovr task close TASK_ID
drovr task close TASK_ID --force
drovr group close GROUP_ID
drovr group close GROUP_ID --force
```

Wait timeouts are non-destructive. Completion is accepted only after every
recorded input appears in order in the native transcript and a complete
assistant result follows the final input. After `drovr attach` resolves a
blocked native harness, `--after-block` durably acknowledges that exact block
and waits for the agent to return to working before accepting later settlement.
If resolution settles before the later waiter starts, an advanced Herdr state
token plus the correlated native transcript provides the durable resume evidence.
Transcript-flush grace follows correlation progress, so a stale idle observation
before prompt delivery cannot consume the grace needed after actual settlement.
Claude multiline delivery also verifies that a settled native agent actually
enters `working` or `blocked` after Herdr stages the prompt; an idle state-token
change alone does not prove submission. A still-idle bracketed paste receives
one guarded submit key only after a new visible Claude attachment token appears;
pane output is delivery-readiness evidence, not completion evidence. Native
waits first return an already-settled observation instead of waiting for another
state change. If the pre-delivery state persists beyond the bounded transcript
grace, exact transcript correlation gets one final attempt before the turn
becomes `uncertain`. An `uncertain` turn
remains terminal, but `turn get` reports a non-durable `late_result` when the
transcript later contains the exact recorded inputs in order and a complete
result before any unrecorded native input. The same projection recovers legacy
`unsupported_transcript` records that were created when a transcript file was
temporarily absent. Discovery does not rewrite the durable turn or promote it to
`completed`.
Cancellation reports `cancelled` only after native interruption and confirmed
settlement. Cancelling an already-idle turn returns its exact reconciled terminal
status, including `uncertain` when prompt delivery cannot be proven. Non-force
cleanup refuses working or blocked resources, and group
cleanup preflights every task before mutating any of them. Force cleanup
interrupts active work, records each unfinished turn as `interrupted` or
`uncertain` according to the observed settlement. Group cleanup closes the
exact registered workspace directly instead of closing its task tabs first.
Closing a final task keeps its group workspace active through one exact
group-owned idle tab, satisfying Herdr's final-tab constraint without changing
group lifetime. Stale agents converge only when their exact process and pane
are absent and native-session ownership is unambiguous. All cleanup preserves
durable history and never deletes caller-owned cwd or transcript files.
Mutating commands may recover a confirmed-down native session only when every
persisted safety check succeeds;
`status` and `agent get` report observed loss without launching anything.

Claude role instructions are materialized from the immutable launch
specification into a private `0600` file beneath Drovr state and passed through
Claude's native system-prompt file option. This preserves exact multiline and
shell-sensitive text without weakening Herdr's command-argument safety checks;
the file is recreated from the persisted specification during safe recovery.

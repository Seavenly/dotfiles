# Drovr

Drovr is the host-local delegated agent runtime described in [SPEC.md](SPEC.md).
The current tracer bullet provides configuration validation, `doctor`, complete
Claude Code and Codex `delegate` paths, durable multi-turn reuse, cancellation,
retirement, safe task cleanup, Herdr restart reconciliation, and conservative
native-session recovery.

After convergence, diagnose the local runtime:

```sh
drovr doctor
```

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

Prompt-bearing commands accept exactly one positional prompt,
`--prompt-file`, or standard input. Non-interactive output is one
`drovr.command/v1` JSON document on standard output. Durable local records live
under `${XDG_STATE_HOME:-~/.local/state}/drovr/`.

Reuse the returned agent ID for a later logical turn:

```sh
drovr ask AGENT_ID "Review the result from your previous turn."
```

Advanced callers can separate delivery and observation across processes, steer
an active turn, and discover durable turn IDs:

```sh
drovr turn start AGENT_ID "Begin the review."
drovr turn send TURN_ID "Prioritize correctness."
drovr turn wait TURN_ID --timeout 5m
drovr turn wait TURN_ID --after-block BLOCK_ID --timeout 5m
drovr turn get TURN_ID --include-messages
drovr turn list --agent AGENT_ID
drovr turn cancel TURN_ID
drovr agent retire AGENT_ID
drovr task close TASK_ID
```

Wait timeouts are non-destructive. Completion is accepted only after every
recorded input appears in order in the native transcript and a complete
assistant result follows the final input. After `drovr attach` resolves a
blocked native harness, `--after-block` durably acknowledges that exact block
and waits for the agent to return to working before accepting later settlement.
If resolution settles before the later waiter starts, an advanced Herdr state
token plus the correlated native transcript provides the durable resume evidence.
Cancellation reports `cancelled` only after native interruption and confirmed
settlement. Task cleanup refuses working or blocked resources, preserves
durable history, and never deletes caller-owned cwd or transcript files.
Mutating commands may recover a confirmed-down native session only when every
persisted safety check succeeds; read-only commands report loss without
launching anything.

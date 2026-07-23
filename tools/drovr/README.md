# Drovr

Drovr is the host-local delegated agent runtime described in [SPEC.md](SPEC.md).
The current tracer bullet provides configuration validation, `doctor`, complete
Claude Code and Codex `delegate` paths, and durable multi-turn reuse through
Herdr and the harnesses' native transcripts.

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
drovr turn get TURN_ID --include-messages
drovr turn list --agent AGENT_ID
```

Wait timeouts are non-destructive. Completion is accepted only after every
recorded input appears in order in the native transcript and a complete
assistant result follows the final input. Cleanup, cancellation, restart
reconciliation, and native-session recovery belong to later tracer bullets.
`drovr attach` remains the direct path for a blocked delegate.

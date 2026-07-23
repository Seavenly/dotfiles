# Drovr

Drovr is the host-local delegated agent runtime described in [SPEC.md](SPEC.md).
The current tracer bullet provides configuration validation, `doctor`, and one
complete Codex `delegate` path through Herdr and the native Codex transcript.

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

`--group` and `--group-label` select an explicit delegation group. Without
`--group`, Drovr derives a standalone group from the task cwd. Launch settings
may be selected with `--role`, `--harness`, `--model`, `--effort`, and
`--capability`; tracked defaults live under `config/drovr/`.

Prompt-bearing commands accept exactly one positional prompt,
`--prompt-file`, or standard input. Non-interactive output is one
`drovr.command/v1` JSON document on standard output. Durable local records live
under `${XDG_STATE_HOME:-~/.local/state}/drovr/`.

Claude delegation, later-turn `ask`, steering, cleanup, and recovery commands
belong to subsequent tracer bullets. `drovr attach` is available now so a
blocked first-slice delegate can hand control to the user.

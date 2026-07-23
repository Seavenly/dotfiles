# Drovr

Drovr is the host-local delegated agent runtime described in [SPEC.md](SPEC.md).
The current tracer bullet provides configuration validation, `doctor`, and
complete Claude Code and Codex `delegate` paths through Herdr and their native
transcripts.

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

Later-turn `ask`, steering, cleanup, and recovery commands belong to subsequent
tracer bullets. `drovr attach` is available now so a blocked delegate can hand
control to the user.

# Find retained project work

Inside an initialized project, use:

```sh
flow-supervised runs
```

The overview lists retained feature tasks, independent reviews and supplied-source
research, including unlaunched previews, uncertain accepted intents, completed
work and attempts that need attention. Each row includes the task title, exact identity, original client
runtime, retained evidence path and supported next commands. Commands are printed
for inspection; none are executed by the overview.

Use an explicit project or immutable client when needed:

```sh
flow-supervised runs --repository /absolute/project --json
flow-supervised runs --repository /absolute/project --client /private/original/client
```

All verified clients are listed by default. The command never chooses the newest
client or brief. Several different stopped client bindings sharing an authority
require an explicit `--client` for historical inspection. Unknown, edited, aliased
or incomplete state is reported as unavailable; it is not repaired or replaced.
An uninitialized project shows setup guidance without creating a profile.

## Understand the observation

A matching running owner supplies live public projections. A lost transport or
mismatched runtime binding is unavailable, not an empty run list. When an exact
original client supports stopped inspection, its public query supplies historical
`inspect_only` facts. Stopped inspection never starts or recovers the owner and
does not prove current execution, worker retirement or workspace reuse.

A retained preview is distinct from an accepted launch intent and from an admitted
run. `accepted_unknown` means exact accepted bytes exist but admission has not
been observed. Preserve that evidence and use only the printed same-attempt
inspection or resume command. An archived or partial journal remains
inspection-only. Runs without a matching guided receipt get original-client
public inspection commands, never a fabricated guided attach command.

For admitted work, the overview separates configured or observed checks, feature
critique, candidate currency, independent review coverage and observed human
approval. Review checks are inherited producer evidence, not a rerun. A cancelled
phase or stopped owner does not release held or quarantined workspace claims.
Claim identity, generation and mutation epoch remain visible where supplied.

Research rows show the question, exact source-packet digest, observed report
status, lower assurance and residual-gap count. A research-only initialized
client can appear without a feature request. A prepared packet is not a completed
report; an unavailable proof stays unavailable. Research has no candidate,
inherited checker or human approval, and the overview never fetches source text.
Use the printed exact [`research`](guided-research.md) confirmation or attachment
command only after inspecting its evidence and recovery disclosure.

Printed `run`, confirmation, attachment and original-owner start commands can
start or reuse that exact owner and recover previously authorized work when you
explicitly execute them. Read their disclosure first. Existing
[`run`](guided-run.md), [`review`](guided-review.md) and
[`research`](guided-research.md) frontends still own exact
confirmation, attachment, cancellation and authority-derived decisions.
The overview performs no start, preparation, refresh, confirmation, launch,
submission locking, journal write or lifecycle cleanup. Bare `status` and
`status --json` retain their existing owner-status contract.

## Bounded results for scripts

`--json` returns one `flow.project-runs/v1` object with `clients`, `authorities`,
`attempts`, `diagnostics`, `complete` and the applied `limits`. Observation and
attention are separate: a completely inspected uncertain intent may return
`status: "attention"` with `complete: true`, without proving admission.

The scope is bounded to 32 clients, 128 attempts, 64 public queries, 4 MiB per
regular JSON file, 1 MiB serialized output and a 15-second observation deadline.
Directory overflow, omitted rows, truncated fact fields and unavailable queries
are explicit. Counts and truncation flags prevent a short ID list from implying
exhaustive coverage. Preserve the displayed paths for full retained evidence.

Exit 0 means a complete overview or an uninitialized project. Exit 1 means the
inspection is incomplete, unavailable or truncated, so undisplayed work may
exist. Exit 2 means invalid arguments, repository selection or an unknown
explicit client. No result grants human approval, merge or Git publication
authority.

For recorded attempt usage, select an exact run with
[`flow-supervised usage --run RUN_ID`](project-usage.md). Independent reviews
remain separate selections; usage estimates do not grant billing or lifecycle
authority.

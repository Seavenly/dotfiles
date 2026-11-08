# Run a supervised project task

Inside a project you have [initialized](guided-setup.md), run:

```sh
flow-supervised run
```

Choose the initialized task if several are retained. Review the brief, acceptance
criteria, selected test scope, trusted CLI permissions, actual client runtime,
execution limits and retained confirmation. Answer `yes` to launch that exact
task. Progress reports implementation, committed capture, registered checks,
independent critique and candidate sealing from the existing authority. No JSON
needs to be written or combined by hand.

Run starts or reuses the selected project's owner for preparation. That owner
can recover previously authorized work, including when an older pinned client
needs startup before inspection. This is distinct from the new task's launch
confirmation. Discovery selects a concrete retained client/request first; it
never chooses another authority, upgrades a runtime or reconfigures a check
silently. Existing active work must be inspected before a new request prepares.

The supervised CLI trust disclosure remains in force. Flow does not independently
establish every official CLI permission or ambient startup constraint. Strict
qualification and Mac native execution remain separate unfinished tracks.

## Scripts and exact confirmation

With one retained request, preview it using `flow-supervised run --json`.
With several, select a path printed by init or the task selection error:

```sh
flow-supervised run --request /private/client/requests/feature-ABC/prepare-request.json --json
```

Repeat that selection with the exact printed digest:

```sh
flow-supervised run --request /private/client/requests/feature-ABC/prepare-request.json \
  --confirm sha256:THE_PRINTED_CONFIRMATION_DIGEST --json
```

Confirmation accepts the retained prepared bytes. It does not prepare again or
carry an old yes over to a changed task. Repeated confirmation, concurrent
callers and a lost launch response use the same bundle/run identity. Private
prepared, launch, projection and result files remain beside the request. A short
frontend submission mutex coordinates those writes; RunAuthority remains the
sole owner of run lifecycle and effect decisions.

If Git or registered inputs drift before launch, inspect the retained rejection.
Use `--refresh` only for a known unlaunched preview, then inspect and confirm the
new preparation. Uncertain accepted launches block refresh. Preserve their
evidence and inspect or attach to the exact intended run instead.

`--json` emits newline-delimited owner, preview, progress and result records:
`flow.project-run-preview/v1`, `flow.project-run-progress/v1` and
`flow.project-run-result/v1`. `--no-follow` returns after submission/attachment.
`--follow-seconds 60` bounds observation only. It never changes the execution
budget or cancels work when observation ends.

## Detach, return and decide

Ctrl-C detaches the frontend. It does **not** cancel durable work. Copy the exact
reattach command printed on interruption or in the retained result:

```sh
flow-supervised run --request /private/client/requests/feature-ABC/prepare-request.json \
  --attach run:THE_EXACT_RUN_ID
```

If the owner becomes unavailable, preserve evidence and use that same command.
Explicit attachment starts/reuses the exact owner, which may recover the
existing attempt; it never launches a new bundle. Unknown authority or run is an
error, not proof that no work exists. Runs created before this frontend have no
guided receipt: the refusal prints the original client's literal public
status/query/watch commands instead of fabricating guided ownership.

The terminal lists supported checkpoint, capability, revision, terminal
disposition and recovery choices offered by authority. Choose a number, inspect
the exact command, then confirm it. Enter detaches without deciding. Executor
cards stay with the normal runner; the frontend never advances them as a second
driver. Scripts select an offered action digest:

```sh
flow-supervised run --request /private/client/requests/feature-ABC/prepare-request.json \
  --attach run:THE_EXACT_RUN_ID --action sha256:THE_DISPLAYED_ACTION_DIGEST --json
```

Actions are fetched fresh and submitted unchanged with their authority
watermark. Stale actions are refused and must be inspected again. A previous yes
is never transplanted to another action. Publication, merge, tracker actions and
human review approval are outside this command.

Request cancellation explicitly with the same selection and
`--cancel run:THE_EXACT_RUN_ID`. Cancellation is irreversible. The frontend
submits the fresh public cancel action and observes receipts/recovery.
Cancelled phase alone does not prove native retirement or workspace release.
Uncertain effects, quarantine and held workspace dispositions remain visible.
Offered `settle_cancelled_workspace` or `settle_cancelled_capture` choices still
require explicit acceptance and their existing clean-Git/receipt/claim proofs.
The frontend never rolls files back or releases claims automatically.

## Read the result

Success reports the exact sealed candidate, commit/ref, Git inspection commands,
registered-check evidence and feature critique. GREEN-only means the registered
command succeeded for the captured candidate; test count may remain unknown.
Content-only VERIFY still says project checks were not run. Expected RED/GREEN
v1 checks retain their separate meaning. Feature critique is not separate review
or human approval to integrate/publish.

Failed, blocked, quarantined, cancelled and unavailable results retain evidence
and legal next actions. Worker retirement and workspace reuse are separate
authority facts. Exit status is 0 for preview, successful sealed result or
intentional bounded detachment; 1 for rejected/blocked/cancelled/unavailable
work; 2 for arguments/task selection; and 130 for Ctrl-C detach.

Run `flow-supervised run --help` for all options. Manual preparation/lifecycle
commands remain available in the [operator guide](operator-guide.md).

After a candidate is sealed, use [`flow-supervised review`](guided-review.md)
for an independently prepared local review of that exact candidate. Producer
checks are inherited rather than rerun, and automated findings do not grant
human approval or Git publication authority.

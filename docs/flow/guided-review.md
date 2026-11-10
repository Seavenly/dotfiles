# Review a retained local candidate

After a [supervised task](guided-run.md) succeeds, run inside its initialized project:

```sh
flow-supervised review
```

Select the original initialized client if several are retained, then the exact
completed producer if more than one has a current sealed candidate. Different
briefs on the same immutable client do not create duplicate client choices.
The command deliberately uses that client's actual pinned runtime. It never
silently upgrades a runtime, changes a check, or selects another authority.

Review starts or reuses that exact owner before requesting current candidate and
review facts. Startup can recover previously authorized work. This is distinct
from the new review's confirmation. The preview shows the producer, candidate
fingerprint and lifecycle, exact retained commit comparison, registered security
lens and independent critic routes, models, executable, requested permissions,
trust disclosure, overall budget and confirmation digest. Answer `yes` to launch
that exact prepared review.

The bounded diff comes from the producer's successful registered commit receipt:
its recorded old commit to the exact sealed candidate commit. It does not use
`HEAD~1`, a current working-tree diff or a guessed baseline. The display escapes
terminal controls and discloses truncation after 100 lines or 16 KiB. A literal
full-comparison command uses the same exact objects with external diff and
text-conversion drivers disabled. Missing comparison objects are an actionable
refusal.

Supervised native CLI trust remains explicit. Flow does not independently prove
all official CLI permission and ambient startup constraints. Strict qualification
and Mac native execution remain separate unfinished tracks.

Use [`flow-supervised runs`](project-runs.md) to find retained tasks and exact
original commands without starting or recovering an owner.

## Scripts and exact confirmation

Select concrete paths and IDs printed by the preview or selection error:

```sh
flow-supervised review --client /private/client --producer run:EXACT_PRODUCER_ID --json
```

Repeat the same selection with its exact confirmation digest:

```sh
flow-supervised review --client /private/client --producer run:EXACT_PRODUCER_ID \
  --confirm sha256:THE_PRINTED_CONFIRMATION_DIGEST --json
```

The defaults are 600 seconds for the overall prepared run and zero revisions.
`--timeout-seconds 1..3600` and `--max-revisions 0..4` explicitly select those
supported limits before preparation. Include any nondefault policy when
confirming. These are overall limits, not independent per-role timers or a
promise that a cancelled worker has already retired.

The existing public review-request bridge owns the target, facts, registered
routes and execution trust. Guided review retains that original request and
copies only the selected supported limits. A separate private review journal
retains the exact request, prepared confirmation, accepted launch intent,
projections and results. Repeating a preview or confirmation reuses that intent;
it never silently creates a second review. The short submission mutex and exact
bundle/run idempotency are shared with guided run. RunAuthority remains the sole
lifecycle authority.

`--json` emits newline-delimited owner, preview, progress and result records:
`flow.project-review-preview/v1`, `flow.project-run-progress/v1` and
`flow.project-review-result/v1`. `--no-follow` returns after submission or
attachment. `--follow-seconds 60` limits observation only.

If preparation becomes stale before admission, retain the rejection and use
`--refresh` only for a proven unlaunched intent. Inspect and confirm the new
facts and digest. Unknown accepted outcomes block refresh. Owner restart can
change preparation facts, so a stale yes never carries over to fresh facts.
This command retains one guided intent per exact client, producer, candidate and
policy; a separate deliberate review can still use the existing manual public
review-request path.

## Detach, inspect and decide

Ctrl-C detaches the frontend without cancelling durable work. Copy its exact
reattach command:

```sh
flow-supervised review --client /private/client --attach run:EXACT_REVIEW_RUN_ID
```

Attachment finds the saved journal before starting any owner. It uses the saved
policy even when nondefault and never derives fresh review facts or prepares a
replacement bundle. Omit `--timeout-seconds` and `--max-revisions` on attachment
or cancellation. An unknown run, lost owner or unavailable authority remains an
error with retained evidence and exact resume guidance.

Current supported checkpoint and recovery choices come directly from authority.
Choose a number, inspect the exact command and confirm it. Enter detaches.
Scripts can use `--attach ... --action sha256:THE_CURRENT_ACTION_DIGEST`.
A stale decision is refused and must be inspected again; the frontend never
transplants approval to a new watermark. Executor work stays with the owner.

`--cancel run:EXACT_REVIEW_RUN_ID` explicitly submits an offered public cancel
command and follows settlement. Cancelled phase alone does not prove worker
retirement, settled effects or workspace reuse. Unresolved effects, quarantine,
workspace dispositions and legal recovery choices remain visible.

## Read the result

The review-record operation receipt supplies the actual review ID. Guided review
queries that exact public record and checks its source run, effect, attempt,
idempotency key and candidate identity. It never reconstructs a record ID from a
candidate ID. A succeeded run with missing coverage, stale currency or a capped
review remains incomplete or blocked. The summary displays lens and critic
coverage, posture, findings and authority cap reasons, with a command to inspect
the complete record.

Producer check evidence is inherited and explicitly **not rerun** by review.
Automated no-findings, complete coverage and human approval are separate facts.
This command grants no human approval, merge, tracker completion or Git
publication authority. Later public human events may already exist on the exact
record; attachment displays that observed approval/currentness honestly while
still granting none itself. The automated summary does not declare merge readiness.

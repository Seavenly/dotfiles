# Prepare the first feature and local-review pilot

Create the disposable pilot with one command from the accepted runtime repository:

```sh
node config/flow/scripts/prepare-feature-pilot.mjs setup --mode test \
  > /tmp/flow-pilot-setup.json
PILOT="$(jq -er '.directory' /tmp/flow-pilot-setup.json)"
cat "$PILOT/pilot.json"
```

Setup requires Node 22 and `/usr/bin/git`. It creates a new private directory
under the temporary directory; `--parent /short/existing/directory` selects
another parent. Retain this directory for the pilot and recovery. Temporary
storage may be removed by the host, so choose durable storage before retaining
long-lived evidence. The parent path must be short enough for the owner socket.

The directory contains a clean committed repository, a fixed trusted owner
factory, an ordinary feature request, isolated authority and receipt directories,
a sibling canary, and a `flow` client bound to this runtime and selected release
`flow-release-1.1-dark-test/v1`. The committed acceptance check initially fails
because `feature.txt` contains `before`; the requested change makes it contain
`after`. The separate committed health check passes. Setup runs Git only. It
does not start an owner, probe a native executable, run checks, read credentials,
change launch policy, or qualify execution.

The resulting status is `preparation_only`. Current public native admission
remains `qualification_withheld`. The remaining commands are an execution
recipe for the coordinator to release after the exact runtime and native policy
are qualified. A refusal is a stop with retained evidence. Use the returned
legal actions; keep the manifest, ledger and authority records unchanged.

## Produce one unknown candidate

For an authorized, separately qualified pilot, start the isolated owner and
prepare the actual request. The generated client sets the isolated owner and
release configuration on every call; it does not use the installed launcher.

```sh
"$PILOT/flow" start --json > "$PILOT/receipts/owner-start.json"
"$PILOT/flow" status --json
"$PILOT/flow" prepare --input "$(cat "$PILOT/prepare-request.json")" --json \
  > "$PILOT/receipts/prepared.json"
jq -e '.schema == "flow.prepared-run/v1"' "$PILOT/receipts/prepared.json"
jq '.confirmation' "$PILOT/receipts/prepared.json"
```

Read the complete returned confirmation, including authority, routes, bounds
and promised outcomes. After explicitly accepting that exact bundle, construct
the confirmation decision from its returned digests and facts:

```sh
jq -n --slurpfile prepared "$PILOT/receipts/prepared.json" \
  --slurpfile request "$PILOT/prepare-request.json" '{
  prepared:$prepared[0], dark_opt_in:$request[0].dark_opt_in,
  confirmation:{schema:"flow.predefined-flow-confirmation-decision/v1",
    decision:"accept",bundle_digest:$prepared[0].bundle_digest,
    confirmation_digest:$prepared[0].confirmation_digest},
  closed_facts:{schema:"flow.closed-fact-observation/v1",
    bundle_digest:$prepared[0].bundle_digest,facts:$prepared[0].explicit_facts}
}' > "$PILOT/receipts/launch-request.json"
"$PILOT/flow" launch --input "$(cat "$PILOT/receipts/launch-request.json")" --json \
  > "$PILOT/receipts/launch.json"
RUN_ID="$(jq -er '.run_id' "$PILOT/receipts/launch.json")"
"$PILOT/flow" query --input "$(jq -cn --arg id "$RUN_ID" '{run_id:$id}')" --json
```

The client can exit while the owner advances admitted work. Use fresh public
clients to inspect progress. Follow the current projection's checkpoint,
cancellation and recovery actions in the
[operator guide](operator-guide.md#status-query-watch-and-authority-projected-actions).
Do not manually advance cards. Stopping the owner leaves delegated-task and
workspace obligations subject to their exact retirement and recovery evidence.

## Prepare independent review of the retained candidate

After the producer run succeeds, this command refreshes its exact retained
candidate and asks the owner for canonical review-preparation facts. It writes
a review request into a new receipt directory. It uses only public queries and
the actual returned candidate, watermark, descriptions and route bindings:

```sh
node config/flow/scripts/prepare-feature-pilot.mjs review-request "$PILOT" "$RUN_ID" \
  > "$PILOT/receipts/review-request-location.json"
REVIEW_RECEIPTS="$(jq -er '.directory' "$PILOT/receipts/review-request-location.json")"
"$PILOT/flow" prepare --input "$(cat "$REVIEW_RECEIPTS/prepare-request.json")" --json \
  > "$REVIEW_RECEIPTS/prepared.json"
jq -e '.schema == "flow.prepared-run/v1"' "$REVIEW_RECEIPTS/prepared.json"
jq '.confirmation' "$REVIEW_RECEIPTS/prepared.json"
```

The security lens and critic use distinct read-only Codex roles and attempts.
The request preserves the same selected 1.1 release as the producer. A changed,
dirty, unavailable or unsealed candidate stops preparation. No candidate ID or
future Git identity is created by setup, and no private database is read.

Read and accept the review confirmation separately. Repeat the confirmation
construction above with `prepared` from `$REVIEW_RECEIPTS/prepared.json` and
`request` from `$REVIEW_RECEIPTS/prepare-request.json`; retain its launch request
and receipt in that directory. Automated review completion grants no human
approval or integration. Inspect the public inbox afterward:

```sh
"$PILOT/flow" query --input '{"schema":"flow.query/v1","query":"review_inbox"}' --json \
  > "$REVIEW_RECEIPTS/inbox.json"
```

## Finish the evidence set

Run `setup --mode verify` for a separate clean repository, owner and receipt
directory. It requests the same small observable change with the production
verify route. It does not claim registered test-mode RED/GREEN evidence.

For #84, retain both actual feature runs and their independent review receipts,
rendered status/candidate/inbox evidence, client-exit and owner-restart evidence,
transmitted-task coverage, bounds, failures, and canary checks. Compare the
canary SHA-256 to `pilot.json`, inspect the original committed checks, and bind
the evidence to the exact release and host. Preserve unsuccessful attempts and
unresolved claims. The repository check's local check execution is preparation
validation, not native or production-operation qualification.

The #50 normal-work pilot follows compatible #84/#44/#46 evidence and operator
documentation. Its operator-selected ordinary work, both harnesses and mixed
delegation, test/verify modes, recovery, cancellation, actionable failures,
bounds, and explicit continued-use decision remain required. The disposable
Codex tracer does not establish that gate. Personal and work MacBook acceptance
also needs their actual supported-host evidence; this script does not enable
macOS direct tasks. Expanded four-flow parity, remote reviews, tracker parity,
default cutover and legacy retirement are later gates.

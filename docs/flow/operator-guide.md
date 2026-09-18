# Flow 1.0 dark opt-in operator guide

This is the executable operator path for the qualified first release. It is
deliberately a sacrificial dark opt-in: the legacy Claude launcher remains the
default, and this guide does not authorize normal use or any remote mutation.
Run the examples only against disposable local resources that you own.

## Release and authority boundary

The guide is bound to these exact source records. The release content tree is
the governed candidate tree for the release; it is not a future flow-run
candidate, run result, or operator-supplied identity.

| Record | Exact identity |
| --- | --- |
| Release | `flow-release-1.0-dark/v1` |
| Implementation | `flow-runtime/v1` |
| Historical release source commit (`transition-ledger.v1.json`) | `1e3e4665d4241419ad573d208077a20d845289bc` |
| Qualification base commit | `a4a9a88a330be2b668339cf1a9b1b7c1b992564e` |
| Governed release candidate tree (`release-content.v1.json`) | `57cf104c2570940348e8f0c1003a13de667c1f5e` |
| Governed release content | `sha256:842d0ecc3cf53897515a702325d5945c13030f9d395e99c7451c3fa8c8c980a2` |
| Contract catalog | `config/flow/contracts/catalog.v1.json`, `flow.contract-catalog/v1@33`, `sha256:3645a1e1e898c2071796c00aa580c67440609d3472a6f313cc1f2f3eceebc737` |
| Capability manifest | `config/flow/release-manifest.v1.json`, `sha256:8b0b4bc7287f887d869cafef5cb61e41d385ceea733a1a41e585cff5471546d9` |
| Launch policy | `flow.launch-policy/v1`, `config/flow/launch-policy.v1.json`, `sha256:dc138b56537c408f1e998f9dc0193097745ad789ad8ae0cc5bf2ddbbc121b113` |
| Transition ledger | `config/flow/transition-ledger.v1.json`, schema `flow.transition-ledger/v1`, sequence 32, `sha256:0c34c6f36546ca9560e9c50bb9aa558338e999c9d9ff0af901c9142684ad7c8d` |
| Deterministic qualification evidence | `config/flow/evidence/release-qualification.v1.json`, `sha256:10900ea79d28d7864c1f87c6eabb6bdad158ff3a0dea05e98e98a589f0076110` |
| Production-route evidence | `config/flow/evidence/production-route-conformance.v1.json`, `sha256:0f7f5252bfd08e74e616370b28281135ee06caef08810dd7d37f26d83f62f870` |
| Release-content evidence | `config/flow/evidence/release-content.v1.json`, `sha256:a61bb25344bca7ee9f0fd466af94f64ba56a55366febb21837c6943bf25a7c1c` |

The ledger records the historical `source_commit`; it does not say that this
working tree is that commit. The current governed release tree is the separate
`candidate_tree_sha` above. Recheck the ledger and its evidence before every
dark selection:

```sh
npm --silent --prefix tools/flow run status
jq '{release,contracts,decision,environment_fingerprint,evidence,not_run}' \
  config/flow/transition-ledger.v1.json
jq '{release_id,implementation,scope,normal_use_authorized,remote_mutations_authorized,supported_routes,disabled_routes,sacrificial_followups}' \
  config/flow/release-manifest.v1.json
jq '{default_implementation,implementations}' config/flow/launch-policy.v1.json
```

`RunAuthority` is the only lifecycle authority. The public `flow` client is a
disposable caller. `flow.runtime/v1` has exactly five operations:
`prepare`, `launch`, `command`, `query`, and `watch`. A projection's
`watermark` and `legal_actions` are the authority-produced inputs to the next
command. This boundary follows ADR-0007 for Drovr delegation and ADR-0008 for
the sole RunAuthority. Do not edit local authority files, database records, provider
registries, or harness transcripts. Do not invent a run ID, candidate ID,
result digest, authority watermark, or future Git identity.

## What this release admits

The manifest's only supported routes are:

| Flow | Mode | Contracts |
| --- | --- | --- |
| `feature` | `verify` | `flow.definition/feature/v1`, `flow.feature-verification-request/v1`, `flow.operation/feature-verify/v1`, `work.feature-verification-receipt/v1` |
| `review` | `local` | `flow.review-local-candidate/v1`, `flow.operation/review-record/v1`, `flow.review-provenance/v1` |

`feature/verify` accepts an ordinary brief and a clean starting workspace. It
produces an execution-created candidate and stops at a local review handoff.
`review/local` consumes the exact returned candidate identity and never accepts
`latest` as a selector. The candidate and result identities below are always
read from returned authority projections.

The following are disabled or unsupported in this release: `feature/test`,
`feature/mixed`, `spike/quick`, `spike/deep`, `epic/default`,
`review/github`, `tracker/github`, `tracker/jira`, `forge/default`,
`publication/default`, `merge/default`, `push/default`, and
`remote/mutation`. A disabled route is not enabled by changing JSON, and an
unsupported route is not repaired by adding an adapter locally. Feature test
and mixed modes, spike, epic, GitHub review, tracker, forge, publication,
merge, push, and remote mutation remain outside the release gates.

The ledger marks issue 84, issue 44, and issue 46 as `not_run`; no compatible
receipts currently prove those later scenarios. This guide documents their
public contracts where needed for diagnosis and recovery, but does not claim
issue 84's real feature/candidate and separate review scenarios, issue 44's
mixed delegation, or issue 46's host recovery/concurrency/rendering evidence.
Issue #85 must refresh the documentation and evidence for the expanded release
before issue #53 can authorize a later transition. This is the required
issue #85 refresh boundary, not a claim that its expanded scenarios have run.

## Supported hosts, configuration, and retention

The supported host matrix is macOS 26+ arm64, Ubuntu Server 24.04, and
Ubuntu Server 26.04 on x86_64 or arm64. The qualifying evidence record is
environment-bound; a
passed Linux x64 record does not silently qualify a different host class.

The production composition uses a mode-0700 authority directory, normally
`$XDG_STATE_HOME/flow` or `~/.local/state/flow`, and mode-0600 endpoint/socket
files. Use `FLOW_AUTHORITY_DIRECTORY` for a real private directory owned by the
current user. The autonomous owner has separate delegate and operation
capacities, each defaulting to one and bounded to 1 through 64:

```sh
export FLOW_RUNNER_DELEGATE_CAPACITY=1
export FLOW_RUNNER_OPERATION_CAPACITY=1
```

Passive child observation does not consume operation capacity. The runner does
not auto-approve checkpoints, expand capabilities, repeat uncertain effects,
or choose terminal dispositions. `flow status --json` reports capacity,
active counts, and bounded sanitized errors.

For an example, make every mutable root unique and disposable. The repository
is the workspace subject; the receipt directory is only for captured public
JSON; result bytes remain under the authority's retention and handoff rules.
Do not reuse the default authority while qualifying an example.

```sh
set -euo pipefail
umask 077

FLOW_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/flow-operator.XXXXXXXX")"
REPOSITORY="$FLOW_ROOT/workspace/repository"
RECEIPTS="$FLOW_ROOT/receipts"
RESULTS="$FLOW_ROOT/results"
mkdir -p "$REPOSITORY" "$RECEIPTS" "$RESULTS" \
  "$FLOW_ROOT/authority" "$FLOW_ROOT/runtime" "$FLOW_ROOT/state"
chmod 700 "$FLOW_ROOT" "$FLOW_ROOT/workspace" "$REPOSITORY" \
  "$RECEIPTS" "$RESULTS" "$FLOW_ROOT/authority" \
  "$FLOW_ROOT/runtime" "$FLOW_ROOT/state"

export FLOW_AUTHORITY_DIRECTORY="$FLOW_ROOT/authority"
export FLOW_OWNER_ENDPOINT_PATH="$FLOW_ROOT/runtime/owner.json"
export FLOW_SOCKET_PATH="$FLOW_ROOT/runtime/owner.sock"
export FLOW_OWNER_SOCKET_PATH="$FLOW_SOCKET_PATH"
export XDG_STATE_HOME="$FLOW_ROOT/state"
export FLOW_RUNNER_DELEGATE_CAPACITY=1
export FLOW_RUNNER_OPERATION_CAPACITY=1
```

`RESULTS` and `RECEIPTS` are operator-owned disposable capture roots, not a
second lifecycle authority. A sealed review candidate keeps exact workspace
generation, clean Git commit/tree, artifact bytes, Git retention, and a
generation-bound `flow.resource-handoff/v1`. Retention is released only after
the returned Work-domain disposition and consumer obligations permit it.
The workspace retention and artifact retention therefore remain active until those
exact obligations settle.
Never remove a retained workspace, artifact, handoff, or Git retention ref by
path. Query the exact subject and use its authority-projected cleanup action.

## Host owner lifecycle

The owner holds the fenced `RunAuthority` and survives client exit. Start it and
inspect it; keep this owner running through preparation, launch, observation,
authority commands, and local review. Stop only the recorded owner during the
final cleanup below:

```sh
flow start --json | tee "$RECEIPTS/owner-start.json"
flow status --json | tee "$RECEIPTS/owner-status.json"
```

`flow stop` checks the recorded endpoint identity immediately before signaling.
If status reports `owner_mismatch` or a stale endpoint, do not signal a guessed
PID or remove an unrelated socket. Follow only the returned legal action for
the exact endpoint. A client may exit and reconnect without changing an
accepted run.

The host-manager definitions are explicit opt-in sources, not a second
authority. On macOS, after the release has been authorized for that host:

```sh
mkdir -p "$HOME/Library/LaunchAgents"
ln -s "$HOME/.config/flow/host/macos/com.seavenly.flow-owner.plist" \
  "$HOME/Library/LaunchAgents/com.seavenly.flow-owner.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.seavenly.flow-owner.plist"
launchctl enable "gui/$(id -u)/com.seavenly.flow-owner"
```

On Ubuntu, use the per-user unit after the same explicit admission:

```sh
mkdir -p "$HOME/.config/systemd/user"
ln -s "$HOME/.config/flow/host/ubuntu/flow-owner.service" \
  "$HOME/.config/systemd/user/flow-owner.service"
systemctl --user daemon-reload
systemctl --user enable --now flow-owner.service
```

`launchctl` or `systemctl --user` only supervises the owner process. It never
approves a flow card or resumes a run after a changed boot. Normal dotfiles
convergence exposes these templates but does not load or enable them.

## Prepare with an ordinary brief

First create a disposable clean repository and inspect its starting facts. The
facts are an operator sanity check; `prepare` captures and returns the
identity-bearing facts used by `launch`. Do not put a future candidate commit,
tree, artifact digest, patch, or result hash in the request.

```sh
git init --quiet --initial-branch=main "$REPOSITORY"
git -C "$REPOSITORY" config user.email flow-operator@example.test
git -C "$REPOSITORY" config user.name "Flow Operator"
printf '%s\n' 'starting workspace' > "$REPOSITORY/README.md"
git -C "$REPOSITORY" add README.md
git -C "$REPOSITORY" commit --quiet -m 'initial disposable workspace'

test -z "$(git -C "$REPOSITORY" status --porcelain=v1 --untracked-files=all)"
START_COMMIT="$(git -C "$REPOSITORY" rev-parse HEAD)"
START_TREE="$(git -C "$REPOSITORY" rev-parse 'HEAD^{tree}')"
jq -n --arg commit "$START_COMMIT" --arg tree "$START_TREE" \
  '{clean:true,commit_sha:$commit,tree_sha:$tree}' \
  | tee "$RECEIPTS/starting-git-facts.json"
```

Inspect both supported harness routes through the public non-mutating
`DelegatedAgentPort` query. The returned projection is the compatibility
authority for the exact launch; a blocked projection means stop and follow its
returned legal actions.

```sh
flow query delegated-agent --harness codex --role reviewer \
  --capability workspace-write \
  --caller-metadata '{"owner":"operator-guide"}' --json \
  | tee "$RECEIPTS/drovr-codex-apply.json"
flow query delegated-agent --harness codex --role reviewer \
  --capability read-only \
  --caller-metadata '{"owner":"operator-guide"}' --json \
  | tee "$RECEIPTS/drovr-codex-critique.json"
flow query delegated-agent --harness claude --role reviewer \
  --capability workspace-write \
  --caller-metadata '{"owner":"operator-guide"}' --json \
  | tee "$RECEIPTS/drovr-claude-apply.json"
flow query delegated-agent --harness claude --role reviewer \
  --capability read-only \
  --caller-metadata '{"owner":"operator-guide"}' --json \
  | tee "$RECEIPTS/drovr-claude-critique.json"
```

Use one compatible harness route per disposable run. The public values are
`harness: codex` and `harness: claude`; `HARNESS` is the only
operator-selected route choice; use `codex` or `claude` after inspecting all
four returned projections. The request values `model`, `effort`, and
`capability` below are read from the selected route's returned description, not
copied from a model catalog or this guide. The apply route must advertise
`workspace-write`; the independent critique route must advertise `read-only`.
The scoped release does not claim issue 44's mixed-delegation qualification.

Every delegate receives one complete `flow.delegate-input-envelope/v1` from
RunAuthority: bounded instructions, minimal task inputs, exact authority-owned
resource references, accepted predecessor evidence where declared, and output
requirements. It never receives an ambient transcript, credential, capability
secret, or caller-invented workspace path.

Set an ordinary brief, choose `codex` or `claude` from the compatible query,
and send the closed preparation request. This is a normal shell and `jq` path;
it does not call a private module or generate orchestration code.

```sh
HARNESS=codex   # use claude for the separately inspected Claude route
if test "$HARNESS" = codex; then
  APPLY_DESCRIPTION="$RECEIPTS/drovr-codex-apply.json"
  CRITIQUE_DESCRIPTION="$RECEIPTS/drovr-codex-critique.json"
else
  APPLY_DESCRIPTION="$RECEIPTS/drovr-claude-apply.json"
  CRITIQUE_DESCRIPTION="$RECEIPTS/drovr-claude-critique.json"
fi
jq -e '.status == "compatible" and
  .description.launch.harness and
  .description.launch.model and
  .description.launch.effort and
  .description.launch.capability == "workspace-write"' \
  "$APPLY_DESCRIPTION" >/dev/null
jq -e '.status == "compatible" and
  .description.launch.harness and
  .description.launch.model and
  .description.launch.effort and
  .description.launch.capability == "read-only"' \
  "$CRITIQUE_DESCRIPTION" >/dev/null
APPLY_HARNESS="$(jq -er '.description.launch.harness' "$APPLY_DESCRIPTION")"
APPLY_MODEL="$(jq -er '.description.launch.model' "$APPLY_DESCRIPTION")"
APPLY_EFFORT="$(jq -er '.description.launch.effort' "$APPLY_DESCRIPTION")"
APPLY_CAPABILITY="$(jq -er '.description.launch.capability' "$APPLY_DESCRIPTION")"
CRITIQUE_HARNESS="$(jq -er '.description.launch.harness' "$CRITIQUE_DESCRIPTION")"
CRITIQUE_MODEL="$(jq -er '.description.launch.model' "$CRITIQUE_DESCRIPTION")"
CRITIQUE_EFFORT="$(jq -er '.description.launch.effort' "$CRITIQUE_DESCRIPTION")"
CRITIQUE_CAPABILITY="$(jq -er '.description.launch.capability' "$CRITIQUE_DESCRIPTION")"
test "$APPLY_HARNESS" = "$HARNESS"
test "$CRITIQUE_HARNESS" = "$HARNESS"
BRIEF_ID="brief:operator-guide-$(date -u +%Y%m%dT%H%M%SZ)"

jq -cn \
  --arg id "$BRIEF_ID" \
  --arg repository "$REPOSITORY" \
  --arg apply_harness "$APPLY_HARNESS" \
  --arg apply_model "$APPLY_MODEL" \
  --arg apply_effort "$APPLY_EFFORT" \
  --arg apply_capability "$APPLY_CAPABILITY" \
  --arg critique_harness "$CRITIQUE_HARNESS" \
  --arg critique_model "$CRITIQUE_MODEL" \
  --arg critique_effort "$CRITIQUE_EFFORT" \
  --arg critique_capability "$CRITIQUE_CAPABILITY" \
  '{
    schema:"flow.feature-preparation-request/v1",
    brief:{
      schema:"flow.feature-brief/v1",
      id:$id,
      summary:"Make one observable local change",
      acceptance:["the changed behavior is observable"]
    },
    repository:{path:$repository},
    mode:"verify",
    dark_opt_in:{
      schema:"flow.dark-opt-in/v1",
      release_id:"flow-release-1.0-dark/v1",
      purpose:"sacrificial_qualification"
    },
    routes:{
      apply:{launch:{harness:$apply_harness,role:"reviewer",model:$apply_model,
        effort:$apply_effort,capability:$apply_capability}},
      critique:{launch:{harness:$critique_harness,role:"reviewer",
        model:$critique_model,effort:$critique_effort,
        capability:$critique_capability}}
    },
    limits:{max_elapsed_seconds:600}
  }' > "$RECEIPTS/prepare-request.json"

set +e
flow prepare --input "$(<"$RECEIPTS/prepare-request.json")" --json \
  > "$RECEIPTS/prepare.stdout.json" \
  2> "$RECEIPTS/prepare.stderr.json"
PREPARE_STATUS=$?
set -e
if test -s "$RECEIPTS/prepare.stderr.json" &&
   jq -e '.schema == "flow.rejection/v1"' \
     "$RECEIPTS/prepare.stderr.json" >/dev/null; then
  jq '{code,reason,outcome,legal_actions,authority_watermark}' \
    "$RECEIPTS/prepare.stderr.json" >&2
  exit "$PREPARE_STATUS"
fi
if test "$PREPARE_STATUS" -ne 0; then
  cat "$RECEIPTS/prepare.stderr.json" >&2
  exit "$PREPARE_STATUS"
fi
PREPARED="$RECEIPTS/prepare.stdout.json"
jq -e '(.schema == "flow.prepared-run/v1") and
  (.bundle_digest|type == "string") and
  (.confirmation_digest|type == "string") and
  (.explicit_facts|type == "object")' "$PREPARED"
```

Preparation is non-authoritative. A `disabled` or `unsupported` result is a
truthful release boundary, not an invitation to alter the manifest. For a
Drovr compatibility block, run only the returned repair/refresh action and
prepare a fresh bundle afterward.

## Inspect, confirm, and launch returned values

Inspect the returned confirmation, graph, route snapshot, limits, authority
bindings, and initial workspace facts before accepting. These are values from
the prepared bundle, not values copied from this document:

```sh
jq '{bundle_digest,confirmation_digest,definition,selection,confirmation,
     explicit_facts,required_authorities,limits}' \
  "$PREPARED" > "$RECEIPTS/confirmation-view.json"
```

Accept the exact predefined confirmation by digest and carry the exact
`explicit_facts` into the `flow.closed-fact-observation/v1` value. The closed
facts are returned by `prepare`; never recompute or edit them for launch.

```sh
BUNDLE_DIGEST="$(jq -r '.bundle_digest' "$PREPARED")"
CONFIRMATION_DIGEST="$(jq -r '.confirmation_digest' "$PREPARED")"
jq -cn \
  --slurpfile prepared "$PREPARED" \
  --arg bundle "$BUNDLE_DIGEST" \
  --arg confirmation "$CONFIRMATION_DIGEST" \
  --argjson facts "$(jq -c '.explicit_facts' "$PREPARED")" \
  '{
    prepared:$prepared[0],
    dark_opt_in:{
      schema:"flow.dark-opt-in/v1",
      release_id:"flow-release-1.0-dark/v1",
      purpose:"sacrificial_qualification"
    },
    confirmation:{
      schema:"flow.predefined-flow-confirmation-decision/v1",
      decision:"accept",
      bundle_digest:$bundle,
      confirmation_digest:$confirmation
    },
    closed_facts:{
      schema:"flow.closed-fact-observation/v1",
      bundle_digest:$bundle,
      facts:$facts
    }
  }' > "$RECEIPTS/launch-request.json"

set +e
flow launch --input "$(<"$RECEIPTS/launch-request.json")" --json \
  > "$RECEIPTS/launch.stdout.json" \
  2> "$RECEIPTS/launch.stderr.json"
LAUNCH_STATUS=$?
set -e
if test -s "$RECEIPTS/launch.stderr.json" &&
   jq -e '.schema == "flow.rejection/v1"' \
     "$RECEIPTS/launch.stderr.json" >/dev/null; then
  jq '{code,reason,outcome,legal_actions,authority_watermark}' \
    "$RECEIPTS/launch.stderr.json" >&2
  exit "$LAUNCH_STATUS"
fi
if test "$LAUNCH_STATUS" -ne 0; then
  cat "$RECEIPTS/launch.stderr.json" >&2
  exit "$LAUNCH_STATUS"
fi
LAUNCHED="$RECEIPTS/launch.stdout.json"
jq -e '(.schema == "flow.launch-receipt/v1") and
  (.run_id|type == "string") and
  (.authority_watermark|type == "string") and
  (.launch_watermark|type == "string")' "$LAUNCHED"
AUTHORITY_WATERMARK="$(jq -er '.authority_watermark' "$LAUNCHED")"
LAUNCH_WATERMARK="$(jq -er '.launch_watermark' "$LAUNCHED")"
RUN_ID="$(jq -r '.run_id' "$LAUNCHED")"
```

`launch` is host-idempotent. Repeating this exact request adopts the same
returned run; it does not compile a new plan or refresh the route. A changed
bundle, confirmation, or closed fact produces a typed rejection.

## Status, query, watch, and authority-projected actions

Use the host owner for status and the five-operation interface for observations:

```sh
flow status --json | tee "$RECEIPTS/status.json"
flow query --input '{"schema":"flow.query/v1","query":"autonomous_runner_status"}' \
  --json | tee "$RECEIPTS/runner.json"
flow query --input "$(jq -cn --arg run_id "$RUN_ID" '{run_id:$run_id}')" \
  --json | tee "$RECEIPTS/run.json"
```

`query` returns one watermarked projection. `watch` returns the current
projection first and then later watermarks. Run the long-lived watch in a
separate terminal with the same disposable-root environment; end it by closing
that terminal or pressing Ctrl-C, not by issuing a lifecycle command. The first
terminal remains connected to the same owner for the subsequent commands:

```sh
flow watch --input "$(jq -cn --arg run_id "$RUN_ID" \
  '{schema:"flow.watch/v1",run_id:$run_id}')" --json \
  | tee "$RECEIPTS/run-watch.ndjson"
# End this watch terminal with Ctrl-C when the observation is sufficient.
```

The operator view includes phase, admission, revision, card readiness, route
and capability facts, checkpoints, attempts, effects, result bindings,
workspace/artifact/handoff facts, and closed `legal_actions`.

Always select a complete action from the latest projection and submit it
unchanged. These are examples of the closed action types; the `jq` selectors
must find a returned action before invoking `flow command`:

```sh
RUN_JSON="$RECEIPTS/run.json"

ACTION="$(jq -ce '.views.operator.legal_actions[] |
  select(.type == "checkpoint_decision" and .decision == "approve")' "$RUN_JSON")"
flow command --input "$ACTION" --json | tee "$RECEIPTS/checkpoint.json"

ACTION="$(jq -ce '.views.operator.legal_actions[] |
  select(.type == "operation_execute" or .type == "delegate_execute")' "$RUN_JSON")"
flow command --input "$ACTION" --json | tee "$RECEIPTS/execute.json"
```

Refresh `run.json` after every receipt. Do not reuse a stale watermark or
materialize a command by hand. A card block exposes only its named
`capability_grant` or `revision_decision`; there is no generic unblock. An
operation-bound checkpoint requires a fresh `checkpoint_decision`, and an
uncertain effect requires the exact returned recovery action rather than a
retry guess.

## Fresh runtime limits and diagnosis

Set finite limits in the request, such as `max_elapsed_seconds: 600`. The
projection reports both wall elapsed and admitted active execution in its
`execution_time` view. Fresh typed time observations are checked at launch,
before dispatch, at receipt/failure, at cancellation/settlement, and at timer
evaluation. An uncertain or straddling bound blocks new admission. Passive
checkpoint and retained waits are not active execution capacity, but they still
appear in wall elapsed.

For an operational failure, preserve the returned evidence and inspect only
public projections:

```sh
flow status --json | jq '{state,runner,error,runner_error}'
flow query --input "$(jq -cn --arg run_id "$RUN_ID" '{run_id:$run_id}')" --json \
  | tee "$RECEIPTS/diagnosis.json" \
  | jq '{phase,admission,execution_time,cards,blocks,effects,legal_actions,
         result_bindings,views:{operator:.views.operator}}'
```

Sanitized runner errors and typed effect failures are actionable observations,
not proof that an external effect is absent. A missing receipt retains the
attempt, claims, and idempotency identity. For `read_only` or
`caller_idempotent`, use the returned `recovery` action; for `reconcilable`,
observe first and invoke only after positive provider evidence of absence; for
`one_shot_uncertain`, adopt exact presence or use the returned
`terminal_disposition`/checkpoint path. When an attempt cap is exhausted,
submit only the returned `terminal_disposition` action:

```sh
TERMINAL="$(jq -ce '.views.operator.legal_actions[] |
  select(.type == "terminal_disposition")' "$RECEIPTS/diagnosis.json")"
flow command --input "$TERMINAL" --json | tee "$RECEIPTS/terminal-disposition.json"
```

Never reset a retry budget or repeat an uncertain effect because a process
exited.

Cancellation is irreversible convergence. Select the exact authority-projected
action and submit it with its current watermark:

```sh
RUN_JSON="$RECEIPTS/diagnosis.json"
CANCEL="$(jq -ce '.views.operator.legal_actions[] |
  select(.type == "cancel")' "$RUN_JSON")"
flow command --input "$CANCEL" --json | tee "$RECEIPTS/cancel.json"
```

Cancellation stops new admission, fences uninvoked intents, preserves accepted
evidence, abandons incomplete attempts, and quarantines outstanding or late
effects. A quarantined result cannot satisfy a dependency. If no `cancel`
action is returned, refresh the projection and follow the action that is
actually legal.

## Same-boot recovery and explicit reboot admission

If a client or owner process exits during a run, restart the owner and query
the same returned `RUN_ID`:

```sh
flow start --json | tee "$RECEIPTS/restarted-owner.json"
flow query --input "$(jq -cn --arg run_id "$RUN_ID" '{run_id:$run_id}')" \
  --json | tee "$RECEIPTS/recovered-run.json"
```

same-boot recovery replays `RunAuthority`, adopts exact child/delegate
identities, and reconciles unresolved effects. The autonomous owner continues
safe authority-projected work; an operator does not manually advance ordinary
ready cards. A competing process remains read-only and cannot take over by
timeout, heartbeat age, or PID guess.

After a host reboot, restart or reconnect the owner. Each nonterminal run is
suspended. Query the affected run again into a fresh post-reboot projection,
validate that projection and its current watermark, and submit only its exact
`reboot_admission` action from that fresh file:

```sh
flow start --json | tee "$RECEIPTS/post-reboot-owner.json"
POST_REBOOT="$RECEIPTS/post-reboot-run.json"
flow query --input "$(jq -cn --arg run_id "$RUN_ID" '{run_id:$run_id}')" \
  --json | tee "$POST_REBOOT"
POST_REBOOT_WATERMARK="$(jq -er \
  '.views.operator.authority_watermark' "$POST_REBOOT")"
jq -e --arg run_id "$RUN_ID" --arg watermark "$POST_REBOOT_WATERMARK" '
  (.run_id == $run_id) and
  (.admission == "suspended_after_reboot") and
  (.views.operator.authority_watermark == $watermark) and
  ([.views.operator.legal_actions[] |
    select(.type == "reboot_admission" and
           .expected_watermark == $watermark)] | length == 1)
' "$POST_REBOOT"
ADMIT="$(jq -ce --arg watermark "$POST_REBOOT_WATERMARK" \
  '.views.operator.legal_actions[] |
   select(.type == "reboot_admission" and
          .expected_watermark == $watermark)' "$POST_REBOOT")"
flow command --input "$ADMIT" --json | tee "$RECEIPTS/reboot-admission.json"
```

Admission rechecks the catalog, route snapshot, capability envelopes,
operation and validator contracts, limits, typed time facts, subject
generations, and every unresolved-effect observation. A changed or uncertain
fact remains blocked. Child runs require independent `reboot_admission`; a
parent action never admits a child. One-shot effects may be adopted only with
exact presence evidence and are never retried on absence.

## Candidate inspection and local review

When feature verify succeeds, independently refresh the exact run projection.
Require the terminal `succeeded` phase and a returned candidate
reference before extracting its ID. Do not predict its ID or Git SHA:

```sh
COMPLETED="$RECEIPTS/completed-run.json"
flow query --input "$(jq -cn --arg run_id "$RUN_ID" '{run_id:$run_id}')" \
  --json | tee "$COMPLETED"
jq -e --arg run_id "$RUN_ID" '
  (.run_id == $run_id) and
  (.phase == "succeeded") and
  ((.review_candidate_reference.candidate_id | type) == "string")
' "$COMPLETED"
CANDIDATE_ID="$(jq -er '.review_candidate_reference.candidate_id' "$COMPLETED")"
flow query --input "$(jq -cn --arg id "$CANDIDATE_ID" \
  '{contract:"work.review/v1",subject_id:$id}')" --json \
  | tee "$RECEIPTS/candidate.json"
flow query --input '{"schema":"flow.query/v1","query":"review_inbox"}' \
  --json | tee "$RECEIPTS/review-inbox.json"
```

The candidate projection must show a sealed candidate with clean workspace
generation, mutation epoch, exact Git commit/tree, retained artifact bytes,
Git retention, and an active generation-bound `flow.resource-handoff/v1`.
`stale`, `blocked`, dirty, tainted, missing, mismatched, or unresolved
observations remove review authorization while preserving history. A consumer
pins the exact handoff and rechecks it before mutation; it never selects
`latest`.

Local review is the supported human route. It is a projection-only consumer
such as tuicr; `ReviewAuthority` owns review lifecycle and `FlowRuntime` owns
the command. The review inbox is the disposable
`flow.review-inbox-projection/v1` view. Materialize an action using the public
`work.review-human-command/v1` shape: remove its presentation-only
`operator_input`, add only values the operator supplied, and send the
unchanged authority fields.

```sh
ITEM="$(jq -ce --arg id "$CANDIDATE_ID" \
  '.items[] | select(.candidate_id == $id)' "$RECEIPTS/review-inbox.json")"
START="$(jq -ce --arg session "session:${CANDIDATE_ID}:operator" \
  '.legal_actions[] | select(.type == "review_session_start") \
   | del(.operator_input) | . + {session_id:$session}' <<<"$ITEM")"
flow command --input "$START" --json | tee "$RECEIPTS/review-session.json"

REVIEW="$(flow query --input "$(jq -cn --arg id "$CANDIDATE_ID" \
  '{contract:"work.review/v1",subject_id:$id}')" --json)"
ACTION="$(jq -ce --arg id "comment:${CANDIDATE_ID}:operator" \
  --arg body "The retained candidate is ready for review." \
  '.legal_actions[] | select(.type == "review_comment") \
   | del(.operator_input) | . + {comment_id:$id,body:$body}' <<<"$REVIEW")"
flow command --input "$ACTION" --json | tee "$RECEIPTS/review-comment.json"

REVIEW="$(flow query --input "$(jq -cn --arg id "$CANDIDATE_ID" \
  '{contract:"work.review/v1",subject_id:$id}')" --json)"
ACTION="$(jq -ce '.legal_actions[] |
  select(.type == "review_disposition") | del(.operator_input) \
  | . + {disposition:"accept"}' <<<"$REVIEW")"
flow command --input "$ACTION" --json | tee "$RECEIPTS/review-disposition.json"

REVIEW="$(flow query --input "$(jq -cn --arg id "$CANDIDATE_ID" \
  '{contract:"work.review/v1",subject_id:$id}')" --json)"
ACTION="$(jq -ce '.legal_actions[] |
  select(.type == "review_approval" and .decision == "approve") \
  | del(.operator_input)' \
  <<<"$REVIEW")"
flow command --input "$ACTION" --json | tee "$RECEIPTS/review-approval.json"
```

Refresh the review after each command. Approval, finding disposition, and
integration evidence must repeat the current review watermark, candidate
fingerprint, and lifecycle generation. `review_integration` records evidence
and authorization only; it never runs Git integration. The first release has
no GitHub review, push, merge, publication, tracker, or forge action. Stop at
the exact local review record and retained handoff.

## Backup, restore, selector, and rollback

Backup and restore use the same five-operation interface. The idle backup
projection has no `backup_create` legal action, so submit this explicit typed
request first. Every later reconcile or retry must be the exact action returned
by a fresh projection. Stock production has no backup writer or restore adapter
by default and returns typed unavailable outcomes until an approved adapter is
configured; never add a private bypass or edit authority state:

```sh
BACKUP_REQUEST="$(jq -cn \
  '{schema:"flow.command/v1",type:"backup_create"}')"
set +e
flow command --input "$BACKUP_REQUEST" --json \
  > "$RECEIPTS/backup-create.stdout.json" \
  2> "$RECEIPTS/backup-create.stderr.json"
BACKUP_STATUS=$?
set -e
BACKUP_AVAILABLE=true
if test -s "$RECEIPTS/backup-create.stderr.json" &&
   jq -e '.schema == "flow.rejection/v1"' \
     "$RECEIPTS/backup-create.stderr.json" >/dev/null; then
  jq '{code,reason,outcome,legal_actions,authority_watermark}' \
    "$RECEIPTS/backup-create.stderr.json" >&2
  BACKUP_AVAILABLE=false
elif test "$BACKUP_STATUS" -ne 0; then
  cat "$RECEIPTS/backup-create.stderr.json" >&2
  exit "$BACKUP_STATUS"
fi

# Continue only when the configured adapter returned an accepted receipt.
if test "$BACKUP_AVAILABLE" = true; then
  BACKUP="$(flow query --input \
    '{"schema":"flow.query/v1","query":"backup"}' --json \
    | tee "$RECEIPTS/backup-after-create.json")"
  if jq -e '.state == "reconciling" or .state == "failed"' <<<"$BACKUP" >/dev/null; then
    BACKUP_ACTION="$(jq -ce '.legal_actions[] |
      select(.type == "backup_reconcile")' <<<"$BACKUP")"
    flow command --input "$BACKUP_ACTION" --json \
      | tee "$RECEIPTS/backup-reconcile.json"
    BACKUP="$(flow query --input \
      '{"schema":"flow.query/v1","query":"backup"}' --json \
      | tee "$RECEIPTS/backup-after-reconcile.json")"
  elif jq -e '.state == "retryable"' <<<"$BACKUP" >/dev/null; then
    BACKUP_ACTION="$(jq -ce '.legal_actions[] |
      select(.type == "backup_create")' <<<"$BACKUP")"
    flow command --input "$BACKUP_ACTION" --json \
      | tee "$RECEIPTS/backup-retry.json"
    BACKUP="$(flow query --input \
      '{"schema":"flow.query/v1","query":"backup"}' --json \
      | tee "$RECEIPTS/backup-after-retry.json")"
  fi
  MANIFEST="$(jq -ce '.manifest // empty' <<<"$BACKUP" || \
    jq -ce '.manifest' "$RECEIPTS/backup-create.stdout.json")"
  test -n "$MANIFEST"
fi
```

The backup manifest covers replacement authority, artifact manifests and
bytes, legacy roots, external pointers, and Drovr obligations. A receipt-less
backup is not assumed absent. To restore, use the exact returned backup
manifest, enter the host-wide restore barrier, reconcile each returned domain
action, and admit only the exact final action. If BACKUP_AVAILABLE is false,
skip the restore block; stock production has no restore adapter to bypass:

```sh
if test "${BACKUP_AVAILABLE:-false}" != true; then
  printf '%s\n' 'Skipping restore: backup writer/adapter is unavailable.'
elif test -z "${MANIFEST:-}"; then
  printf '%s\n' 'Skipping restore: no accepted backup manifest was returned.' >&2
else
RESTORE="$(jq -cn --argjson manifest "$MANIFEST" \
  '{schema:"flow.command/v1",type:"restore",manifest:$manifest}')"
set +e
flow command --input "$RESTORE" --json \
  > "$RECEIPTS/restore.stdout.json" \
  2> "$RECEIPTS/restore.stderr.json"
RESTORE_STATUS=$?
set -e
if test -s "$RECEIPTS/restore.stderr.json" &&
   jq -e '.schema == "flow.rejection/v1"' \
     "$RECEIPTS/restore.stderr.json" >/dev/null; then
  jq '{code,reason,outcome,legal_actions,authority_watermark}' \
    "$RECEIPTS/restore.stderr.json" >&2
  exit "$RESTORE_STATUS"
fi
if test "$RESTORE_STATUS" -ne 0; then
  cat "$RECEIPTS/restore.stderr.json" >&2
  exit "$RESTORE_STATUS"
fi

RESTORE_STATE="$(flow query --input \
  '{"schema":"flow.query/v1","query":"restore"}' --json)"
RECONCILE="$(jq -ce '.legal_actions[] |
  select(.type == "restore_reconcile")' <<<"$RESTORE_STATE")"
flow command --input "$RECONCILE" --json \
  | tee "$RECEIPTS/restore-reconcile.json"

RESTORE_STATE="$(flow query --input \
  '{"schema":"flow.query/v1","query":"restore"}' --json)"
ADMIT_RESTORE="$(jq -ce '.legal_actions[] |
  select(.type == "restore_admit")' <<<"$RESTORE_STATE")"
flow command --input "$ADMIT_RESTORE" --json \
  | tee "$RECEIPTS/restore-admit.json"
fi
```

Restore remains blocked until database streams, artifact state, Git state,
filesystem state, external effects, and Drovr obligations have exact
reconciliation evidence. A failed component remains failed at the narrowest
provable boundary; it is not repaired by deleting a suffix or fabricating a
receipt.

The launch selector is `config/flow/launch-policy.v1.json`. Its current
selection is `legacy-claude/v1`; `flow-runtime/v1` has dark opt-in enabled but
`launch_enabled: false`. Rollback changes only which implementation accepts
future launches. It does not transfer, translate, resume, or delete runs made
by another implementation, and re-enabling this exact release still requires
normal compatibility and reboot admission. Do not edit the selector or ledger
as an operator shortcut.

## Executable example evidence

The examples above are public-interface instructions. These generated receipts
are candidate-bound conformance evidence for the release identities above; they
are deterministic or isolated local test records, not a live billed operator
exercise. They do not authorize paid or live delegates, remote mutation, or a
claim that issue 44, issue 46, or issue 84 has passed. Those issues remain
`not_run`.

The paths below are relative to `config/flow/` and are taken from the recipe
records in the two evidence documents:

| Guide concern | Recipe ID | Generated receipt |
| --- | --- | --- |
| Owner lifecycle, status/query/watch/command, and same-boot/reboot | `host_fault_reboot` | `evidence/receipts/host-fault-reboot.tap` |
| Runtime reboot and fresh time-bound observations | `production_runtime_reboot` | `evidence/receipts/production-runtime-reboot.tap` |
| Exact prepare-confirm-launch production feature verify | `production_feature_verify` | `evidence/receipts/production-feature-verify.tap` |
| Both Codex and Claude Drovr launch-contract coverage | `feature_review_drovr_conformance` | `evidence/receipts/feature-review-drovr.tap` |
| Public Drovr finding/rejection contract | `public_drovr_finding_schema` | `evidence/receipts/public-drovr-finding-schema.tap` |
| Production local-review process | `public_local_review_process` | `evidence/receipts/public-local-review-process.tap` |
| Disabled and unsupported public routes | `public_host_negative_routes` | `evidence/receipts/public-host-negative-routes.tap` |
| Legacy selector and dark admission boundary | `launch_selector` | `evidence/receipts/launch-selector.tap` |
| Governed release-tree binding | `release_tree_integrity` | `evidence/receipts/release-tree-integrity.tap` |
| Schema and contract catalog checks | `schema_contracts`; `contract_catalog` | `evidence/receipts/schema-contracts.tap`; `evidence/receipts/contract-catalog.tap` |

The deterministic recipe records contract and fault behavior; the production
route records are isolated local process evidence. Neither substitutes for an
operator's separately authorized disposable exercise or creates a future result
identity. Read the returned public projections and receipts from the exact run
before taking any legal action.

## Evidence boundary and later expansion

The exact qualification records are passed for their recorded environment and
scope. They are evidence for release admission, not synthetic real-run
receipts. A later scope requires a new manifest, content binding, and
qualification evidence. In particular, issue 85 must refresh this guide and
the compatibility/evidence records before issue 53 considers expanded parity
or cutover.

Feature verify and local review are the only supported routes here. Feature
test/mixed, spike, epic, GitHub review, tracker, forge, publication, merge,
push, and remote mutation are disabled or unsupported and must remain visibly
so in operator tooling. Never treat an unsupported outcome as a reason to
touch private authority, alter a projection, or run a remote command.

When the disposable exercise is complete, inspect the returned workspace,
artifact, handoff, and Git-retention projections and settle every retention
obligation first. Do not delete while a handoff is retained, a consumer is
active, a subject is dirty or uncertain, or any cleanup action remains pending.
After those obligations settle, stop only the recorded owner, verify that it is
stopped, and remove only the exact `$FLOW_ROOT` created by this example:

```sh
test -n "${FLOW_ROOT:-}" && test -d "$FLOW_ROOT"
flow status --json
flow stop --json | tee "$RECEIPTS/owner-stop.json"
flow status --json | tee "$RECEIPTS/owner-stopped.json"
jq -e '.state == "stopped"' "$RECEIPTS/owner-stopped.json" >/dev/null
FLOW_TMP_ROOT="${TMPDIR:-/tmp}"
case "$FLOW_ROOT" in
  "$FLOW_TMP_ROOT"/flow-operator.*)
    test "$(dirname -- "$FLOW_ROOT")" = "$FLOW_TMP_ROOT"
    ;;
  *)
    printf 'refusing to remove non-mktemp Flow root: %s\n' "$FLOW_ROOT" >&2
    exit 1
    ;;
esac
rm -rf -- "$FLOW_ROOT"
```

This final cleanup is limited to the unique disposable root. It is not a
replacement for authority-projected workspace, artifact, handoff, or Git
retention disposition.

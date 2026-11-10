# Inspect recorded run usage

Inside an initialized project, select the exact run:

```sh
flow-supervised usage --run run:EXACT_RUN_ID
flow-supervised usage --run run:EXACT_RUN_ID --repository /absolute/project --client /private/original/client --json
```

Use [`runs`](project-runs.md) to find retained identities. Usage reads the selected
run and its reciprocally linked admitted children. Distinct retries count;
adoption, replay and cancellation references to the same task do not count twice.
Parent runs, siblings and independent candidate reviews are not silently added.
Select an independent review's own run to inspect its usage.

The report uses exact original client/runtime bindings and receipt-bound task
artifacts. It starts no owner, recovery, version probe, test or provider, and
writes no journal. A compatible stopped client supplies historical `inspect_only`
observations. Lost live transport remains unavailable. Older clients that lack
stopped raw run queries remain unavailable; this command does not upgrade or
restart them. In particular, the earlier mixed-review client needs its retained
public projection and bound artifacts for historical evidence analysis rather
than a new stopped query.

## Read the numbers

Each attempt retains its authority status separately from metric availability.
Pending, not-created, abandoned and quarantined work are distinct. Hash-bound
metrics from a cancelled or unsuccessful terminal are partial observations, not
proof of success, retirement, approval or workspace reuse. Missing, changed,
aliased, oversized or conflicting artifacts remain unavailable, never zero.
Only allowlisted numeric usage and identity metadata is returned; prompts,
responses and tool transcripts are omitted.

Codex input tokens include cached input; reasoning tokens are a subset of output.
Do not add those subsets to their containing counts. Codex turns count completed
native turn events in the retained attempt. Claude uses the final cumulative
result once, including its reported `num_turns`; message snapshots and
`modelUsage` are not counted again. Claude input excludes cache reads and cache
creation, which remain separate counters. Provider totals group compatible
harness, observed provider, requested/reported model and counter meanings rather
than inventing one cross-provider token or turn total. A requested model is not
proof that the native stream reported that model or provider.

A CLI-reported list-cost estimate is labelled with its raw field, retained stream
and receipt digests, and recorded CLI version. Model-level costs corroborate the
final total; conflicting sources make cost unknown. `known_list_cost_usd` sums
only known list estimates and stays `null` when none exist. An actually reported
zero is a known zero. Unknown-cost attempts and subtotal completeness remain
explicit. Other CLI estimates remain visible per attempt without being silently
included in the list-cost subtotal.

Actual billing, pricing date and rate-table version are unknown. `observed_at`
means report collection time, not native execution or pricing time. There is no
external price lookup, money budget, telemetry or admission decision.

## Scripts and limits

`--json` returns `flow.project-usage/v1`, including exact runs and attempts,
provider totals, cost coverage, provenance, diagnostics and applied limits.
Inspection is bounded by 32 clients, 32 runs, 128 attempts, 64 queries, a
15-second shared deadline, 4 MiB per artifact and 1 MiB serialized output.
Omitted rows and overflow remain explicit; missing counters are `null` and have
unknown-attempt counts rather than fabricated zeros.

Exit 0 means a complete inspection, even when optional metrics or cost are
legitimately unknown. Exit 1 means unavailable, conflicting or truncated
evidence. Exit 2 means invalid arguments or explicit selection. Human output
escapes terminal controls and leaves the full structured provenance in JSON.

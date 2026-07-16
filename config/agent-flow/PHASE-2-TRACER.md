# Phase 2 sacrificial tracer evidence

Date: 2026-07-15

This record closes the Phase 2 local-review tracer against a disposable Git
repository and a sacrificial named Hermes board. It records durable evidence
and operator-observable outcomes without copying credentials, model routes, or
raw worker logs.

## Preserved fixture

- Repository: `/private/tmp/agent-flow-phase2-tracer-20260715`
- Base revision: `0a749916bff462db435bb7cb3cfaaa83fce655e3`
- Reviewed revision: `561a301f84bbb6e69bc79ce3152b7b169a60cb49`
- Board: `phase2_tracer_20260715`
- Run state: `/private/tmp/agent-flow-phase2-state-20260715/agent-flow/runs`
- Isolated Hermes home: `/private/tmp/agent-flow-phase2-home-20260715/.hermes`

The board, run directories, and review artifacts remain preserved for review.
The disposable candidate intentionally contains unsafe behavior so the review
can produce stable findings.

## Successful standard review

Run `phase2-tracer-20260715-r5` completed all 18 cards with 18 first attempts
and no retry, audit issue, or limit overrun. The root card is `t_18b400f0`.
The launcher sealed the run at `2026-07-15T23:44:28.474Z` with:

- graph SHA-256
  `10a5fdcd4bc99b3f1ed5bedce73528f4fdca2442c270336fd1f36d4f2299fea9`;
- profile-set fingerprint
  `c42dc32d3ce0e4b7139045acd3c52da2b844ea49e33a45a3572509f36edf6567`;
- exact base and reviewed Git revisions listed above;
- 18 created cards against a maximum of 18;
- 18 worker attempts against a maximum of 33;
- 456 elapsed seconds against a maximum of 3,600.

Initial analyst and artifact work ran in parallel. Per-profile concurrency held
the analyst lane to three simultaneous attempts while work from other profiles
could proceed independently. Every producer was followed by its declared
handoff validator. All eight validation envelopes are valid and bind diagram,
five review lenses, orientation, and critic evidence to validator-owned
snapshots. The critic ran only after the required lens join. Finalize completed
before the controller root became runnable.

The final result sealed standard urgency with a `nit` floor, a total comment
cap of two, and per-tier caps of one critical, one important, one recommended,
and zero nit comments. Two input findings were deterministically retained: one
critical and one important. This live run reached but did not cross its total
cap, so its zero drop counts prove policy propagation and cap compliance, not a
live drop. Stable supplements were retained for the diagram, orientation,
style, and observability stages.

Final artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `artifacts/review/result.json` | `de7d3cefe7a0d6ab386a089125b8716c42c64e7aae0068467e7f18ccd388624a` |
| `artifacts/review/review.md` | `9cf74c07df19ec3f63c6292d353519ef6e03124d254e31b3e426f62d62daed7a` |
| `artifacts/review/review.html` | `c27b01c0411acc5084ae838e94aaf662e3f79c39ec29903d9bbccddb52c4ab40` |
| `artifacts/review/draft.json` | `ba3d4683d21bc9257364f192b3c7ed1d4b538ff48e95f0313adcc3ab02380e0b` |

### Deterministic policy boundary replay

The same `executeReviewFinalizeGate()` seam used by the live finalize card also
has sealed offline replays in `test/review-finalize-gate.test.mjs`. The replay
with six authoritative input findings includes three, drops one important by
its per-tier cap, and drops one recommended plus one nit by the total cap. The
hotfix replay includes only two critical findings and drops two important, one
recommended, and one nit finding through the sealed urgency floor. The final
verification run executed both replays successfully. This boundary evidence is
kept distinct from the live `r5` result above.

An identical second launch returned root `t_18b400f0`, retained exactly 18
cards, and preserved the sorted card-ID/title digest
`60506ff6f415026a01e3b5e7bb2ee66578afe3dcac59e23aab0fac156ee902c0`.

## Recovery and visibility evidence

The earlier sacrificial runs intentionally exercised recovery paths before the
clean completion run:

| Run | Observable outcome |
| --- | --- |
| `phase2-tracer-20260715` | Gateway restart preserved active attempts and their original start timestamps. A manual abandoned claim on style card `t_0a3b776f` was reclaimed, then completed on a new attempt. Orientation card `t_c3006013` was human-blocked, commented, approved, unblocked, and later completed. The run was cancelled after an independent-route quota failure; cancellation converged with no survivors. |
| `phase2-tracer-20260715-r2` | Credential preflight admitted a credential source the runtime could not use. The failure remained visible through native attempts. Cancellation converged with no survivors and motivated fail-closed credential inspection. |
| `phase2-tracer-20260715-r3` | A remote authentication rejection remained visible. Cancellation while an attempt was active reclaimed one running attempt and converged with no survivors. |
| `phase2-tracer-20260715-r4` | Sandboxed workers could not resolve their provider endpoint. Hermes recorded clean exits without lifecycle calls as protocol violations. Cancellation archived all 18 cards, reclaimed three active attempts, and converged with no survivors. |

The explicit protocol-violation tracer used style card `t_0a3b776f`. Its first
run was reclaimed with the reason that the claimed executor exited without
`kanban_complete` or `kanban_block`; the next native attempt completed. The
human block on orientation card `t_c3006013` recorded a block, operator comment,
unblock comment, unblock transition, and later successful attempt without raw
log inspection.

These runs also exposed and closed four launch-preflight gaps before the final
run: missing named-board creation, missing gate command reachability, credential
self-attestation that Hermes could not consume, and board-registry ownership
races. The final implementation rejects a conflicting board/repository mapping,
serializes the shared Hermes board registry, resolves the native Hermes and
Kanban homes, and verifies the exact gate command environment before mutation.

## Dashboard review

The operator opened the local Hermes board dashboard on 2026-07-15, confirmed
that the tracer tasks visibly completed without reading raw logs, opened root
card `t_18b400f0`, and confirmed that its completed-attempt summary and artifact
references were visible. The artifact references were not interactive, which
the operator accepted for Phase 2. Showing an absolute artifact path or a
clickable local link remains a post-Phase 2 usability improvement. Dependency,
attempt, and artifact relationships were also verified through native board
state and `agent-flow status`. Automated visual inspection was unavailable
because the execution sandbox could not bind the dashboard port and the in-app
browser reported no browser backend.

## Review decision

All machine-verifiable Phase 2 exit criteria pass, operator dashboard
summary and artifact-reference visibility pass, and the Phase 2 review gate
is closed. Interactive or absolute dashboard artifact links remain optional
follow-up rather than a Phase 2 blocker.

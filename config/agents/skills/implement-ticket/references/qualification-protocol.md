# Qualification and executable documentation

Use this protocol for tickets whose acceptance requires live-system evidence,
release qualification, or executing documentation examples. It supplements the
implementation protocol; it does not authorize unrelated live mutations or
waive ticket-specific operator decisions.

## Plan the release and scenarios

Before paid or mutating runs, record the exact qualified release commit and
content identity, capability manifest, contracts, routes, configuration and
tool versions. Distinguish the runtime being tested from the ticket's source
and candidate tree, which may contain only documentation or evidence changes.
Use a clean, pinned runtime checkout when those identities differ; verify the
actual executable used by each process rather than assuming it follows cwd.

For concurrent tickets, establish one durable wave plan with a named owner and
per-scenario assignments. The owner alone updates the shared plan; each ticket
writes its receipts to a distinct directory. Record the common release,
required coverage, ticket/resource owners, turn/retry/time bounds, evidence
locations and consumption rules. Independent preparation can proceed while
assignments are settled; shared-resource mutation and overlapping paid
scenarios wait until ownership is established. Do not assume another ticket's
execution or permission from its open status.

For the #43 follow-up wave, use these ownership defaults:

- #84 owns real feature test/verify, candidate handoff and separate local review.
- #44 owns additional harness parity, mixed delegation and delegation faults.
- #46 owns host recovery, concurrency, restore and local rendering scenarios.
- #51 owns executable documentation; it can draft immediately and finalize
  examples against validated behavior and compatible evidence from the others.

Map every ticket criterion to owned or explicitly reused evidence. A scenario
may satisfy several criteria, but reuse requires its immutable receipt,
matching scope and applicable release/environment identities. Preserve the
producing ticket and original provenance; never copy a pass label or invent a
new execution. Missing shared evidence remains pending, not passed. Record the
reason before running a duplicate paid scenario.

## Isolate live resources

A Git worktree does not isolate host state. Before running, inventory the exact
Flow authority root, Drovr registry, Herdr session, socket/port, native harness
state, test repository, output/backup paths and configuration the scenario
will touch. Allocate supported disposable resources with unique ticket/run
identities and record ownership. Check the effective configuration actually
selects them. Preserve access controls and credential redaction.

Restart, cancellation, fault injection and destructive restore target only
the recorded disposable resources. Never restart a shared Herdr server or
Flow owner, change shared native configuration, or delete a caller's state
because the test uses its own worktree. When a mechanism cannot be isolated,
serialize it with an explicit owner and scope; existing authority must cover
its impact on other users/runs or that scenario remains blocked.

Reserve shared provider capacity and respect the wave's live-run bounds.
Retain exact cleanup receipts or a named durable holder for every remaining
resource, including after failure or interruption. Ambiguous ownership means
preserve the resource and report the unresolved obligation. The aggregate
integration lock protects Git publication, not live test resources.

## Collect and review evidence

Execute required real scenarios through the public product interface. Use the
ticket's actual harness/model combinations and the smallest configured model
capable of the scenario within its accepted routes. The skill's selected-model
workhorse rule still applies to agents building, diagnosing and reviewing the
qualification; it cannot replace Claude/Codex or mixed-route test subjects.

Store immutable receipts and logs outside the candidate worktree as specified
by the implementation protocol. Bind the evidence manifest to the tested
release, environment, scenario, inputs, observed outcomes, command/log hashes,
rendered artifacts and cleanup/retention receipts. Record failed, blocked,
not-run and passed outcomes distinctly. An unavailable live prerequisite or
deterministic substitute cannot satisfy a real-system acceptance criterion.
Persist required transition-ledger records through their documented mechanism.
Fix in-scope defects through the normal candidate path; report adjacent defects
with evidence rather than silently expanding the ticket.

If no repository change is needed, establish a barrier by ending all owned
writers and mutating scenarios, verify a clean worktree/index, record HEAD and
its tree OID, and seal the evidence manifest by digest. Do not fabricate a
source change or empty commit. A required tracked ledger/report change is a
repository-change delivery and uses normal staging, validation and diff review.

For a genuinely evidence-only delivery, replace diff-based review with two
independent workhorse reviews of the sealed manifest, receipts and unchanged
source identity. Apply the same Standards and Specification rubrics and
two-cycle budget; do not invoke a diff-only review that requires a nonempty
diff. Standards checks execution discipline, ownership, provenance, redaction
and retention; Specification checks every criterion, real-path coverage and
release applicability. Sol verifies hashes and selected actual observations,
not merely summaries. Changed evidence invalidates acceptance and both review
receipts; apply the existing correction/review rules to the new manifest.

## Release drift and completion

Runtime fixes, configuration drift and aggregate movement require a recorded
compatibility assessment identifying affected scenarios. Retain prior evidence
under its tested identity. Rerun affected scenarios against the new qualified
runtime and re-review the resulting manifest; reuse unaffected evidence only
where the release contract permits it and exact relevant identities support
the assessment. Do not automatically repeat all paid scenarios for unrelated
documentation changes, or relabel earlier live evidence as current.

Completion requires all criteria, durable required ledger evidence, both clear
reviews and an honest resource disposition. Report the unchanged HEAD/tree and
manifest digest when no commit was necessary. Preserve the worktree, branch
and evidence; do not close the issue during implementation.

On a later explicit "merge and close" for evidence-only work, use the same
aggregate integration lock for final fetch, release-compatibility checks,
receipt verification and issue closure. No merge or push is needed when there
are no repository changes. Verify the tested source is in the aggregate's
history and any drift is covered by the recorded compatibility assessment;
otherwise revalidate before closure. Preserve the evidence in the ticket's
required durable store and include its exact identity/location in the closure
record. Repository-change deliveries retain the normal exact-SHA publication
sequence. Neither path grants default cutover or retirement authority.

---
status: accepted
---

# Use a sole RunAuthority for flow lifecycle

The replacement for the Claude-only and Hermes-backed agent flows is one
host-local, harness-neutral `flow` product. Its versioned `FlowRuntime`
Interface exposes exactly `prepare`, `launch`, `command`, `query`, and `watch`.
A fenced `RunAuthority` is the only authority allowed to accept a plan,
determine readiness, admit cards and attempts, record checkpoints and blocks,
revise or cancel work, and finalize a flow run.

Pure plan and lifecycle modules calculate decisions from explicit facts.
Mechanism adapters record or reconcile effects but do not own policy. Drovr
remains the delegated agent runtime described by ADR-0007 and does not schedule
or advance flow work. Workspace, artifact, review, and stack authorities own
their bounded durable subjects without gaining flow lifecycle authority.
Kanban, timeline, tracker, review-inbox, and operator views are disposable
projections with exact authority watermarks.

The replacement is built beside two frozen legacy baselines. New launches use
the frozen Claude-only implementation by default until an explicit converged
launch-policy decision authorizes a later transition stage. The Claude-only,
Hermes-backed, and replacement implementations keep disjoint authority roots,
and a run remains owned by the implementation that created it. Repeated host
convergence applies the declared launch policy and cannot infer cutover from
installed replacement code.

No legacy import adapter is registered initially. Legacy lifecycle state,
grants, checkpoints, approval, review currency, integration eligibility,
effect causation, and completion can never become replacement authority.
Immutable legacy bytes may cross only after a future named public contract
validates digest, schema, provenance, redaction, classification, retention,
and allowed use.

This decision supersedes neither ADR-0005's immutable delivery guarantees nor
ADR-0007's use of Drovr. ADR-0004 remains historical guidance for the frozen
Hermes-backed baseline only.

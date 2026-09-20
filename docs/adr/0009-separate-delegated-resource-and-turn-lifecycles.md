# ADR-0009: Separate delegated resource and turn lifecycles

- Status: Accepted for issue 44 implementation
- Date: 2026-09-17

## Context

`flow.delegated-agent-port/v1` owns logical-turn discovery, dispatch,
ordered input, cancellation, observation, and retirement. Its route `agent_id`
is a planning identity produced by the immutable launch description. The
production Flow route must not treat that value as a Drovr registry ID: the
registry may have no task or agent yet, and a caller retry must not attach to
an ambient resource.

The feature route also needs to bind a canonical WorkspaceAuthority claim,
launch/effective-authority comparison keys, and native identity to the exact
Drovr group, task, and managed agent that will carry its turns. Provisioning
and logical-turn delivery have different recovery and cancellation evidence.

## Decision

Introduce the deep `flow.delegated-agent-resource-port/v1` seam with exactly
two operations:

- `ensure(request)` derives one run-scoped deterministic resource key,
  resolves the exact canonical workspace through an injected
  WorkspaceAuthority resolver, and uses public Drovr `openTask` and
  `startAgent` operations. It returns the exact group/task/agent IDs, binding
  digest, managed pane/process evidence digest, and registry watermark, or a
  typed closed block. The provisional binding permits a null native session
  before the first prompt; the first logical turn binds that session through
  Drovr's existing two-phase runtime contract.
- `retire(request)` accepts only the exact immutable resource binding and
  actual agent identity. It returns a retirement proof or a typed uncertain
  block; it never guesses an identity or replaces an uncertain resource.

Flow calls `discover` on the existing turn port first. Only after exact turn
absence is proven does it call `ensure`; dispatch then uses the returned actual
agent ID, validates the immutable launch binding, and records that binding in
the turn's dedicated `resource_binding` field. Recovery reads the carried
binding from the exact turn and never calls `ensure` for an existing turn.
Cancellation and terminal disposition retire or hand off that actual resource,
while ordered steering, fallback independence, and declared managed-agent reuse
remain turn-level policies.

For declared managed-agent reuse, per-card operation and route labels are not
part of resource identity. The binding uses the declared managed-agent ID as
its owner scope while the current card operation remains an authority check at
each `ensure`. This keeps one immutable resource across the declared card span
without weakening WorkspaceAuthority fencing.

The production adapter is injected with WorkspaceAuthority resolution and
uses Drovr's public, lock/idempotent task and agent commands. Tests use the
same adapter seam with deterministic public-command fakes. Identity drift,
workspace/configuration drift, launch/native mismatch, collisions, and
uncertain provisioning or retirement are typed blocks; identity-free
`reconciling` is not progress.

## Alternatives considered

### Put resource methods on `flow.delegated-agent-port/v1`

Rejected. It makes a turn interface shallow and couples two lifecycles with
different identities, watermarks, and recovery rules. It would also change a
published contract whose existing five-operation FlowRuntime integration is
already stable.

### Add `acquireAndDispatch`

Rejected. It hides the discover-before-provision ordering and makes resource
and turn evidence impossible to settle independently. Keeping the seam at
`ensure`/`retire` lets Flow preserve exact cancellation, ordered steering,
fallback, and terminal-disposition semantics.

## Consequences

The route binding remains useful for planning and comparison, but callers must
carry the returned resource binding and actual registry IDs after materialize.
Production composition supplies the WorkspaceAuthority resolver; no ambient
cwd or registry lookup is accepted. The resource port and its schemas become
catalogued contracts, while the existing delegated-agent port and public
FlowRuntime interface remain unchanged.

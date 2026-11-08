---
status: accepted
---

# Use direct CLI tasks as primary Flow execution

Issue #92 replaces ADR-0007's required Drovr execution direction for replacement
Flow runs. Official non-interactive Codex and Claude Code CLIs are the primary
backend direction. Drovr remains an explicit optional adapter. Legacy launch
selection, sole RunAuthority and the five-operation FlowRuntime stay unchanged.
ADR-0009 continues to govern optional Drovr resource and turn provisioning;
direct tasks do not emulate its registry, groups, panes, steering or reuse.

The approved scope for issue #92 is a Linux Codex-first dark pilot. This scope
decision does not qualify native execution: current release qualification remains
`not_run`, and public admission remains `qualification_withheld`. Issue #84 must
qualify real Codex startup and permission enforcement against the exact pilot
release before native pilot use. The later full release under parent #2 still
requires both official harnesses. Claude remains blocked by
`claude_native_policy_unproven`; macOS direct execution is unsupported. Sole owner
authority, conservative recovery and independent review remain mandatory. This
pilot does not authorize normal use, legacy-default cutover or remote mutation.

A versioned execution description binds backend adapter and executable identity,
model and effort, capability differences, normalized effective authority and
immutable comparison keys. A direct task reserves one caller key and exact
input/schema/workspace/effect identity before spawning. A detached, bounded
worker owns stdin, raw stdout/stderr and an atomic terminal receipt independently
of the client and Flow owner. The worker has no scheduling or grant authority.
Changing defaults cannot rebind an attempt. Unknown reservation, spawn, process
or receipt outcomes block without replay. Native sessions are correlation
metadata and cannot prove ownership or admit Flow work.

The direct posture `workspace-write-denied` requires `repository:write` and
means exact workspace writes, denied approval requests, no escalation and no
delegate tool network. It does not implement Drovr's human approvals or automatic
review. `read-only` is separate. Old `workspace-write`, `on-approve`, `auto`,
`unrestricted`, steering, native continuation and transparent backend switching
are unsupported for direct tasks. Native authentication stays in the unmodified
CLI; Flow does not copy authentication or expose it in prompts or receipts.
Unproved ambient hooks, plugins, project configuration or managed authority
block dispatch. Native argument construction is version-bound; installed help
and official documentation are source evidence, not live qualification.

Initial process containment uses pinned `/usr/bin/python3`, isolated with
`-I -S`, and Python's standard library with Linux `PR_SET_CHILD_SUBREAPER`.
Cancellation opens pidfds from proven ancestry snapshots and validates expected
identity before signalling the process handle. Python must already be installed; Flow never installs
it. Double-forked and setsid descendants reparent to the exact worker. Only
`waitpid` ECHILD after the native child's exit proves full tree retirement.
Cancellation records intent before the verified worker signals its exact
current descendants, with bounded graceful termination and escalation. Worker
loss, boot/start ambiguity or surviving descendants retain uncertainty and
workspace claims. macOS direct mutation is unsupported before native spawn until
equivalent containment is implemented and qualified; optional Drovr remains.

Codex workspace sandbox protects `.git`, `.agents` and `.codex`. Delegates edit
files; the explicitly prepared `flow.operation/feature-direct-commit/v1` makes
one local candidate commit using a private index, durable before-CAS record and
exact old/new ref comparison. Missing writer claim/grant, stale epoch, ref or
index drift blocks. The operation uses an absolute system Git executable and
a limited environment, excludes ambient Git redirects and global/system config,
disables hooks, fsmonitor and signing, and rejects external clean/process
filters before worktree hashing. Ambiguous outcomes reconcile exact records or remain
indeterminate; they never reconstruct a replacement commit. Existing capture/v1,
independent critique, operation verification, sealing, retention and handoff
contracts remain mandatory and unchanged for the optional Drovr path.

Deterministic executable fixtures prove implementation only. Catalog or source
drift invalidates affected release qualification; older Drovr evidence is not
renamed as direct evidence. Native Codex startup and permission enforcement for
the approved pilot remain qualification work under #84. The later full release
still requires both native harnesses, public host recovery and supported-host
qualification under parent #2 and #84/#89/#47. The opaque authority-provider
identities introduced by #90 remain distinct from execution backend identity and preserve exact candidate
and watermark fences when integrated. No normal use, remote mutation, test/mixed
mode, separate review admission, publication or default cutover follows here.

The initial Claude Code 2.1.287 adapter implements provider-local argv and
structured parsing, but `claude_native_policy_unproven` blocks native admission.
Safe/restricted mode retains managed startup effects and additive roots; no
pre-effect witness has established the intended authority. This remains an
unavailable pilot capability and a prerequisite for the later both-harness full
release under parent #2, not qualified Claude support.

Static Codex argument evidence comes from installed 0.160.0 help and the official
[non-interactive contract](https://learn.chatgpt.com/docs/non-interactive-mode),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [sandbox/approval documentation](https://learn.chatgpt.com/docs/agent-approvals-security).
The documented writable-root exclusions are both true; only the owned scratch
root is added to the exact workspace. Empty `hooks` and `mcp_servers` tables are
configuration keys, but actual strict exec startup remains unqualified. A
non-task `features list` probe rejects `--strict-config` for that subcommand and
provides no exec-startup proof. No provider prompt was used for these checks.

The wrapped-runtime test copies configuration into a disposable root and uses
the inherited qualified-release fixture binder there. It does not change real
release records or authorize normal use. Production `qualification_withheld` is
asserted separately. Detached public owner fault qualification and separate
review integration remain pending in their owning packets.

Integration inspection identified three existing #90 local-review description
guards tied to Drovr: production-composition `validReviewDescription`,
review-preparation-facts `validRouteDescription`, and review-flow
`validateBinding`. Their correction belongs to authorized serialized integration
of both candidates; this packet neither copies #90 nor claims that the retained
direct feature can already prepare a separate public review. Opaque authority
provider identity remains distinct from execution adapter identity.

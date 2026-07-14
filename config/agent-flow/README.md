# Hermes agent-flow orchestration

This document specifies the repository-owned design for repeatable automated
agent flows. Phase 1 implements native profiles, machine-local routing, and
profile doctoring. Launchers, graph materializers, registry changes, and stack
mechanics remain phased work under the approved implementation plan.

This directory owns the `agent-flow` orchestration module built on Hermes. It
is not a source mirror for global `~/.hermes/config.yaml`. Native Hermes profile
adapters live beside their shared contracts under
`config/agents/profiles/<profile>/hermes/`; convergence renders those adapters
into Hermes-owned profile homes without tracking global runtime state.

The behavioral reference for the existing flows remains
[`config/claude/AGENT-TEAMS.md`](../claude/AGENT-TEAMS.md). This design preserves
those semantics where they do not conflict with the accepted tracking and
delivery model. The runtime baseline is Hermes Agent v0.18.2. Its current
[Kanban documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban),
[worker-lane documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes),
and [profile documentation](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/)
are upstream behavior references, not content to duplicate here.

## Ownership

Hermes Kanban is the only automation control plane. Its per-board SQLite state
owns card status, dependencies, attempts, recovery, retries, human blocking,
and audit history. The default board uses `~/.hermes/kanban.db`; named boards
use `~/.hermes/kanban/boards/<slug>/kanban.db`.

The other modules stay deliberately narrow:

| Module | Interface | Owns | Must not own |
| --- | --- | --- | --- |
| Flow skill | `/feature-flow`, `/review-flow`, `/spike-flow`, or `/epic-flow` | Interview, grill, durable brief, external issue work, approval | Autonomous scheduling or polling |
| `agent-flow` | Durable paths passed to a small CLI | Validation, worktrees, graph materialization, deterministic gates, status, pruning | A state database, worker polling, or a general workflow language |
| Graph definition | Versioned named graph selected by flow | Allowed stages, dependencies, caps, and controller transitions | Runtime lifecycle state |
| Hermes Kanban | Native CLI and `kanban_*` tools | Dispatch, dependencies, attempts, retries, blocking, recovery, history | External issue acceptance or delivery policy |
| Local review | `agent-flow.local-review/v1` manifest | Immutable review identity and review lifecycle | A second workflow scheduler or a tuicr session |
| `tuicr-reviews` | `add --manifest`, `list`, `prune`, `rm` | Picker projection over review manifests | Approval truth, comment interpretation, or hidden session creation |
| Stacks and delivery | Approved stack manifest plus deterministic Git helpers | Review layers, restacking, delivery assembly, exact tree checks | Product implementation or external completion before final merge |

Deleting `agent-flow` would force graph preparation, idempotency, worktree
safety, and manifest validation into every skill. That concentrated behavior is
the module's depth. Scheduling does not belong there because it would duplicate
Hermes and destroy locality.

## Command interface

The planned external interface is path-oriented:

```text
agent-flow doctor profiles
agent-flow launch review  --manifest <absolute-review.json>
agent-flow launch feature --brief <absolute-brief> [--plan <absolute-plan>]
agent-flow launch spike   --brief <absolute-brief> [--plan <absolute-plan>]
agent-flow launch epic    --brief <absolute-brief> --plan <absolute-plan>
agent-flow gate           --spec <absolute-gate.json>
agent-flow review transition      --manifest <review.json> --to <state>
agent-flow review record-comments --manifest <review.json> --comments <comments.json>
agent-flow status         --run <run-id> [--json]
agent-flow prune          --run <run-id> [--apply]
```

Flow skills invoke this interface. Worker prompts invoke only the exact
`agent-flow gate --spec ...` or review command named by their card. Status is
derived from the Kanban board and durable manifests. No command waits for a
worker or advances a card by polling.

## Run and board identity

- One repository maps to one named board. The launcher derives the default
  slug from the forge coordinate and records it in the run manifest. A caller
  may select an existing board explicitly.
- A standalone flow uses its `run_id` as the Kanban tenant. Feature streams
  beneath an epic share the epic tenant so one filter shows the complete graph.
- Every card title begins with `[<run-id>/<stage-key>]`. Its body names the flow
  graph version, attempt cap, workspace, input paths, output paths, and exact
  human action needed if blocked.
- Every created card has an idempotency key of
  `<run-id>:<graph-version>:<stage-key>:<instance>`. Hermes retries remain
  worker attempts of the same card and do not change that key.
- A run directory lives at
  `${XDG_STATE_HOME:-~/.local/state}/agent-flow/runs/<run-id>/`. It contains
  approved inputs, graph and gate specifications, task identifiers, and
  artifacts. It is not a lifecycle database.

The launcher creates the root card blocked, materializes and validates every
known card and dependency, then unblocks the root. The dependency links keep it
in `todo` until terminal cards complete. A failed launch leaves the root
blocked with a recovery comment instead of exposing a partial executable graph.

Static graphs are fully materialized when the plan is known. Controllers may
create only the versioned transitions defined in
[`FLOW-GRAPHS.md`](FLOW-GRAPHS.md): planning fallback, semantic revision,
critic fixes, and epic ready waves. Hermes' built-in auto-decomposer is disabled
for these boards. The reserved workflow-template columns in Hermes v0.18.2 are
not treated as an implemented workflow runtime.

## Execution profiles

Profiles are host-local execution lanes. Card-pinned skills provide the
semantic role. Separate OS worker processes provide context isolation, not OS
identity or filesystem isolation.

| Profile | Technically enforced by effective Hermes configuration | Contract-only restrictions |
| --- | --- | --- |
| `flow-controller` | Kanban tools only; terminal, file, web, MCP, memory, and user profile unavailable; sole dispatch owner; auto-decomposition disabled | Creates only versioned graph transitions and always records a lifecycle call |
| `analyst` | Bundled file and web tools; terminal, MCP, memory, and user profile unavailable; dispatch disabled | Treats the pinned target as read-only despite bundled write tools and always records a lifecycle call |
| `critic` | Bundled file and web tools; terminal, MCP, memory, and user profile unavailable; independently routed provider; dispatch disabled | Treats the pinned target as read-only, maintains review independence beyond provider routing, and always records a lifecycle call |
| `builder` | Bundled file and terminal tools; local terminal with real user HOME; MCP, memory, and user profile unavailable; dispatch disabled | Writes only in the assigned worktree, relies on graph dependencies to avoid concurrent writes, and always records a lifecycle call |
| `artifact` | Bundled file tools; terminal, MCP, memory, and user profile unavailable; dispatch disabled | Writes only declared artifact paths, never product code, and always records a lifecycle call |
| `gate` | Terminal tools without direct file tools; local terminal with real user HOME; MCP, memory, and user profile unavailable; dispatch disabled | Runs only the declared command and workspace, never edits product code, and always records a lifecycle call |

Hermes profiles are not filesystem sandboxes on the local terminal backend.
Restrictions use the effective tool schema where Hermes provides the needed
boundary, plus workspace pinning, deterministic commands, and profile
contracts. Hermes v0.18.2 bundles `read_file`, `write_file`, `patch`, and file
search in one `file` toolset, so analyst and critic read-only posture is not a
technical write boundary. Profile doctoring reports that limitation instead of
claiming stronger isolation. A future custom read-only tool plugin would be a
separate, explicitly approved security improvement.

The `builder` and `gate` terminal lanes explicitly use the `local` backend with
`home_mode: real`. They inherit the real OS-user HOME, so normal CLI credential
files and OS-keychain integrations are reachable. Hermes v0.18.2 filters its
managed inference-provider secret environment variables from local subprocesses
by default, although an explicitly registered `env_passthrough` skill can
re-enable a named provider variable. Gateway secrets remain unconditionally
filtered. This is not a general credential sandbox. Commands can still reach
credentials available through the user's HOME, keychain, or other normal host
mechanisms; ordinary non-blocklisted environment variables also remain visible.

Exactly one gateway owns dispatch, initially the `flow-controller` gateway with
`kanban.dispatch_in_gateway: true` and `kanban.auto_decompose: false`. Every
other managed profile sets `dispatch_in_gateway: false`. Launch preflight fails
if another active gateway also owns dispatch. Managed profiles cap Kanban at
six in-progress cards globally, three in-progress cards per profile, and six
spawned tasks. These caps are defense in depth; graph dependencies remain the
write-serialization boundary and epic controllers still enforce their own
feature-stream cap by materializing only a bounded ready wave.

## Native profile convergence and routing

Each lane keeps a complete native Hermes adapter:

```text
config/agents/profiles/<profile>/
├── CONTRACT.md
└── hermes/
    ├── SOUL.md
    ├── config.yaml
    └── distribution.yaml
```

Tracked `CONTRACT.md` and `SOUL.md` files never name work or personal models.
Tracked `config.yaml` files contain capabilities, concurrency posture, and
safe model-neutral defaults. Machine-local model and provider routing lives at
`~/.config/dotfiles/hermes-routing.yaml`:

```yaml
schema: dotfiles.hermes-routing/v1
profiles:
  flow-controller:
    model:
      provider: <native-provider>
      default: <native-model>
  analyst:
    model:
      provider: <native-provider>
      default: <native-model>
  critic:
    model:
      provider: <independent-native-provider>
      default: <native-model>
  builder:
    model:
      provider: <native-provider>
      default: <native-model>
  artifact:
    model:
      provider: <native-provider>
      default: <native-model>
  gate:
    model:
      provider: <native-provider>
      default: <native-model>
```

Convergence deep-merges each native fragment at `.profiles.<name>` over the
tracked profile's `hermes/config.yaml`, validates the result, and atomically
renders a regular `config.yaml` into the corresponding Hermes profile home.
The overlay wins only for allowlisted native routing sections: `model`,
`fallback_providers`, `provider_routing`, `providers`, and `custom_providers`.
Unknown profile names, other top-level sections, and secret-like keys are
rejected. Missing routing leaves that profile unavailable and causes
`agent-flow doctor profiles` to fail before launch. Convergence preserves
existing `.env`, `auth.json`, memories, sessions, logs, and unmanaged profiles.
Each rendered profile carries a `.dotfiles-managed-profile` ownership marker.
The pre-dotfiles hook checks every reserved profile name before mise creates
profile links. An existing markerless profile, including one containing only
Hermes runtime state, is preserved and stops convergence before any profile is
modified. `dotfiles install --force` explicitly claims such a conflict while
leaving its Hermes runtime state intact. Profiles from the pre-marker layout
are adopted without force only when both managed links still resolve to this
repository.

This is a native YAML merge, not a cross-harness profile schema. Work hosts may
route to Claude and personal hosts may route to GPT/Codex without changing the
stable contracts. Credentials remain in Hermes-owned `.env` and `auth.json`
files and never enter the overlay or run metadata.

Profile doctoring supports only explicitly validated Hermes releases, initially
v0.18.2. It constructs each profile through Hermes' offline native loading path
without making a model request, then compares the exact worker tool names,
dispatch ownership, decomposition setting, terminal backend, HOME mode, memory
settings, and concurrency limits with the managed catalog. For terminal lanes,
it also launches a harmless sentinel subprocess through Hermes' local terminal
environment construction to verify real-HOME access, ordinary environment
inheritance, default provider-secret filtering, and unconditional
gateway-secret filtering. Its trust-posture report separates technically
enforced restrictions from contract-only worker rules and states that local
profiles are not filesystem sandboxes. It also verifies credentials for every
primary and fallback provider, including custom-provider `key_env` declarations
and explicitly keyless endpoints.

The JSON report includes a stable SHA-256 fingerprint for each effective
profile and one aggregate `profileSetFingerprint`. The fingerprint covers the
validated Hermes version, canonical rendered native configuration, exact worker
tool schemas, and the loaded dispatch, decomposition, terminal, memory, and
concurrency values. It excludes credential contents, sentinel results, host
paths, and runtime state. Future run manifests can record these values to
identify the profile configuration that passed preflight without copying
sensitive or mutable Hermes data.

## Handoffs and local review

Every worker ends with `kanban_complete(...)` or `kanban_block(...)`. A clean
process exit without either call is a visible protocol violation. Operational
failure uses Hermes retries and circuit breakers. A semantic measurement is a
successful worker attempt with `passed: false` in its
`agent-flow.handoff/v1` metadata; a controller may then instantiate a capped
revision transition.

The formal schemas are:

- [`agent-flow.handoff/v1`](schemas/agent-flow.handoff.v1.schema.json)
- [`agent-flow.local-review/v1`](schemas/agent-flow.local-review.v1.schema.json)

Metadata contains concise evidence and absolute artifact pointers, not raw
logs, transcripts, credentials, or tokens. Human checkpoints use
`kanban_block(kind="needs_input")`, name the durable artifact and question,
accept the answer as a task comment, and resume the same card.

The review manifest is the source for immutable base and head SHAs. Branch
names are display and refresh inputs only. A tuicr picker opens the pinned SHA
range. A tuicr session exists only after the interactive TUI creates one and
its slug is then recorded separately from the flow run ID.

Approval always names a head SHA. If the current head differs, approval is
reported as stale and integration is refused. Missing worktrees are reported as
broken review candidates and are never silently removed from the registry.
Human `issue` comments block integration once present. Automated agent review
is always required; human feature-level review is optional until a tuicr
session starts or a human issue comment exists.

## Workspace and write serialization

- One feature run owns one feature branch and one worktree.
- Tester, builder, retry, critic-fix, and gate cards use the same pinned
  `dir:<absolute-worktree-path>` workspace.
- Dependencies serialize writes as tester -> builder -> gate -> controller ->
  next slice. Multiple builder cards never imply multiple worktrees or
  concurrent writes.
- Epic concurrency occurs only across independent feature worktrees.
- Integration into `epic/source` and `epic/delivery` is serialized.
- The launcher owns worktree creation and explicit cleanup. Worktrees persist
  through local review. A missing active worktree remains visible as broken
  state.

## Tracking and delivery

Supported tracking modes are Kanban-only, external-root-only, and exceptional
external expansion. External-root-only is the default: one tracker issue maps
to one Kanban root while retries, reviewers, slices, and feature streams remain
internal cards. Promote a child to an external issue only when it is
independently prioritized, owned, reviewable, deployable, valuable, or blocked
on external coordination.

There is no two-way tracker synchronization. The external root owns intent and
acceptance criteria. Kanban owns execution lifecycle. At most one external
progress comment is updated in place.

There is always one completion PR:

- Feature flow produces a verified review candidate and does not push or open a
  PR.
- Epic implementation accumulates into `epic/source`.
- Approved stack layers merge only into `epic/delivery`, never into the target
  branch.
- Before the completion PR opens, `epic/source` and `epic/delivery` have exactly
  equal Git trees and the full verification suite passes on delivery.
- The completion PR is `epic/delivery -> <target>`. Only its merge completes the
  tracker issue.

Intermediate stack PRs omit the external issue key whenever mentioning it
could trigger premature tracker automation.

## Backup, garbage collection, and recovery

- Run `hermes backup` before Hermes upgrades, board archival, or destructive
  run pruning. Hermes uses SQLite's backup interface and can safely snapshot a
  live WAL database.
- Include `${XDG_STATE_HOME:-~/.local/state}/agent-flow/` in the host backup
  set. `hermes backup` protects Hermes state but does not protect these separate
  run directories.
- Use Hermes' native `kanban gc` only for old events, logs, and orphaned
  workspaces. It does not define agent-flow completion.
- `agent-flow prune` is a dry-run unless `--apply` is present. It refuses active,
  blocked, stale-review, unintegrated, dirty-worktree, or missing-worktree runs.
- Completed run directories are prunable only after their review candidate is
  integrated or archived and their root card is done or archived.
- Recovery reuses the same board, run ID, task IDs, idempotency keys, run
  directory, and worktree. It never silently creates a replacement run.

## Coexistence and rollback

The existing Claude commands and dynamic workflows remain unchanged and usable
through every implementation phase. New shared flow skills are authored under
`config/agents/skills/`, exposed to Hermes and the agent-neutral scope first,
and intentionally not linked into Claude while same-named Claude commands
exist. After explicit parity review, Claude may invoke the shared skills and
Hermes control plane, or the existing commands may remain as the rollback path.

Rollback stops the dispatch-owning gateway, removes only managed profile links,
ownership markers, rendered configs, and the new command links, and restores
the prior convergence revision. It does not delete Kanban databases, run
directories, worktrees, branches, review manifests, or external tracker
comments. Claude autonomous workflows are retired only after explicit parity
approval.

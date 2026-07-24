# Hermes and Claude coexistence review

Date: 2026-07-16

Decision: continue coexistence; Claude workflow retirement eligibility is not proven

Phase 9 requires successful real runs of every flow before a retirement
decision. The repository implementation and local fault-injection suite are
substantial, but the current environment could not perform final model-backed
or remote-service runs. This review therefore records the comparison and keeps
Claude unchanged.

## Evidence comparison

| Concern | Hermes agent-flow | Claude dynamic workflows | Current conclusion |
| --- | --- | --- | --- |
| Control plane | Native Kanban cards, attempts, dependencies, audit history, blocked roots, and native epic materialization | Workflow runtime variables and `/workflows` | Hermes has stronger durable topology; a model-backed stopped-process epic restart remains rollout evidence |
| Immutable inputs | Sealed manifests, digests, fingerprints, task authority, and migration receipts | Confirmed brief plus workflow arguments | Hermes is stronger locally and fails closed on drift |
| Failure visibility | Card attempts, validation evidence, summaries, receipts, review manifests, and rollback commands | Workflow return values, run artifacts, and conversation wrap-up | Hermes exposes more machine-verifiable evidence; Claude has more mature live operator experience |
| Caps | Run-wide card/attempt/time caps plus transition-specific retry and revision caps | Defaults, brief overrides, flags, and bounded JS loops | Both are bounded; Hermes caps are more durable and auditable |
| Human gates | Explicit review lifecycle, stack-plan approval, draft merge checkpoint, and merge observation | Brief confirmation, optional plan gate, pending review draft, and conversation wrap-up | Neither should be retired until Hermes live checkpoints are exercised |
| Review | Deterministic validation and rendering with immutable review identity | Mature parallel-lens workflow and renderer | Hermes local contracts are stronger; Claude has proven day-to-day operation |
| Feature | Serialized worktree graph, final clean-head verification, local-review registration | Mature TDD loop and critic outer pass | Local parity is close; real Hermes execution and operator UX remain unproven |
| Spike | Quick/deep/prototype graphs with retained revision evidence | Mature parallel research and optional prototype | Local parity is close; real synthesis quality is unmeasured |
| Epic | Dependency waves reconstructed from child authority, source integration, receipts, executable target-refresh generations | No equivalent documented autonomous epic delivery path | Hermes adds locally proven capability; its real worker restart is not yet exercised |
| Stacks and delivery | Active reviewed generations, exact hunk ownership and trees, canonical reviews, replay assembly, remote reconciliation, one completion PR | No equivalent documented flow | Hermes adds capability; remote merge-policy proof remains pending |
| Rollback | Preserve boards, run artifacts, refs, receipts, and review manifests | Existing Claude flows remain immediately usable | Coexistence is the safest rollback posture |

## Release-check results

- `./dotfiles check` passed, including the repository behavior suite,
  isolated-home convergence, shellcheck, config validation, credentials checks,
  and repository source validation.
- The agent-flow suite passed 214 tests after final authority, state
  reconstruction, and controller hardening.
- Real Hermes v0.18.2 profile construction passed in the isolated integration
  test. Direct doctoring against live profiles was blocked because the sandbox
  forbids Hermes from writing its normal profile log files.
- A full backup of a disposable Hermes home produced a ZIP that passed archive
  integrity testing. Live backup was blocked by the same sandbox restriction.
- GC completed against a disposable empty Hermes home and touched no live
  state.
- Restart and partial-failure behavior is covered at the run bundle, review,
  feature, spike, integration, stack, and delivery seams.
- Browser-based UI inspection could not run because no browser backend was
  available. The earlier operator check established that the dashboard cards,
  summary, and absolute artifact links render, but not a fresh detailed visual
  pass of the final revision.

## Accepted parity gaps for continued implementation

- Epic wave admission reconstructs from child run authority, Hermes, Git, and
  receipts. A live restart must still exercise that path with model-backed
  workers.
- Do not use production remote mutation until the opt-in non-production stack
  and delivery prototype proves the repository's actual merge policy,
  protection rules, retarget behavior, and recovery receipts.
- Do not claim UI parity until the final dashboard and picker are inspected in
  a working browser/runtime session.
- Do not prune live state until a real backup exists and the dry-run output is
  reviewed.

## Decision

Keep the Claude commands and workflows authoritative and unchanged for normal
use. Hermes flows may be exercised on sacrificial or explicitly selected work
as rollout candidates. Revisit retirement only after all real-run evidence is
recorded and the user makes the separate decision required by Phase 9.

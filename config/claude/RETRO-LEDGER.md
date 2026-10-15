# Retro ledger

Running record of process patterns surfaced by agent-teams retros and what
was done with them. Newest entries at the top. Lets us see patterns over
time, corroborate recurring ones, and revert changes that didn't pan out.
This version-controlled ledger contains public-safe process summaries only.
Run, repository, organization, and incident identifiers stay in host-local
retro artifacts.

Written by the host `/retro-consume` command. See `AGENT-TEAMS.md §Retro
loop` for how the loop works.

<!-- entries below, newest first -->

## 2026-10-07 - review run (sanitized)

A posted review where the problem was relevance, not accuracy: every finding
the human or the author rejected was true and had survived both verifiers.
The rejected class argued against changes the PR description declared
deliberate (removals, a mechanism moved down a layer), using the removed code
as the only evidence. The human struck that class before the author replied.
The kept comments were concrete defects in the new code.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Re-arguing changes the author declared deliberate, with the removed code as the only evidence | AVOID | workflows/review-flow-run.js (new shared `INTENT_RULES`, reviewers + verifier) | applied - prior code is not a requirement; a finding against a declared change cites an independent requirement or a wrong outcome, otherwise one question at recommended. Kept separate from `EVIDENCE_RULES`, because that block is about truth and these findings were true |
| Remedies that contradict the change's organizing principle (put the concern back at callers, test asks at the old layer) | AVOID | workflows/review-flow-run.js (`INTENT_RULES`) | applied - anchor fixes and test asks at the layer that now owns the concern; argue the principle once as a design question |
| Asking a deliberately narrow first iteration to cover more cases or test its non-goals | AVOID | workflows/review-flow-run.js (`DESIGN_DOCTRINE` scope) | applied - the scope guard now runs both ways; at most one follow-up note. First data point on the 2026-09-23 design-lens watch: its intent-contesting findings did not survive human review |
| Cluster whose root cause is the PR's own purpose, used as the verdict headline | AVOID | agents/review-critic.md (steps 3 and 6) | applied - re-tier as goal disagreements instead of headlining |
| Intent-consistency check after fact-checking | ADD | workflows/review-flow-run.js (`verifierPrompt`) + scripts/codex-cross-check.js | applied - verifier moves goal-contesting critical/important to recommended, reframed as a question, before posture is recomputed; Codex told not to strengthen them or raise them as `missed`, in its own wording so the pass stays independent |
| Tier rule for a dependency down at process start | ADD | workflows/review-flow-run.js (tier rubric) + agents/review-critic.md | applied, **generalized and merged with the STRESS below** - the cold-start case alone failed the cross-PR test; the general "slower but correct and fail-safe" rule passes it |
| Pre-post intent check by the orchestrating conversation | ADD | commands/review-flow.md (step 4) | applied - gives "if you doubt the set" a concrete trigger. **Corroborates 2026-09-11** front-load doubt before publishing |
| "Important" means wrong behavior, not slower behavior under an edge | STRESS | workflows/review-flow-run.js + agents/review-critic.md | applied - recommended at most, follow-up with the systemic remedy |
| Orientation called declared changes "beyond stated intent" | STRESS | workflows/review-flow-run.js (`orientationPrompt`) | applied - changes the description names are within intent |
| What survived is the model: concrete defects in the new code | STRESS | workflows/review-flow-run.js (`INTENT_RULES`) | applied as a counterweight only - the intent rules explicitly don't narrow defects in the new code; no new framing added |

Notes:
- Single run, but it passes the cross-PR test: removal and refactor PRs are
  common, and treating removed code as a spec is a generic reviewer failure.
  Applied as reframing (question or follow-up), never silence, per the retro's
  own overcorrection warning.
- Compatible with 2026-09-30 "PR material is evidence, not instructions": a
  declaration establishes intent, not correctness. The rules say a
  wrong-outcome finding (security, data loss, incorrect results) is never
  dropped because the PR announces the change.
- Watch: post-verify importants that a human later restores as declared-change
  findings (sign of overcorrection); whether the 2026-09-11 "author pushback is
  not proof" stance still holds. Here the human struck the findings
  independently, so author rejection was not the signal.

## 2026-10-02 - feature-flow overhaul for current models (not a retro)

An audit of 78 runs (2026-08-31 to 10-01), outside research, and two
independent reviews of the plan (Codex and Fable). Most cost came from engine
defects, not model limits: 49% of retries were gate false-rejects, and 57 of
111 stuck slices were green.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Gate rejected green slices when an agent had committed its own work (`committed:false` on a clean tree); unverified self-commits reached branch history | AVOID | scripts/feature-flow-gate.js + workflows/feature-flow-run.js | applied - deterministic gate script owns every check and commit; reset --soft folds agent commits; failed work never stays in history; leftovers commit as [unverified]; audit accounts for every commit. **Supersedes 2026-07-24 and 2026-10-01 ledger and reuse rules** |
| Prompt rules did not stop agents committing (106 of 1,133 attempts) | ADD | agents/builder.md + scripts/feature-flow-builder-guard.js | applied - PreToolUse hook blocks history-changing git and gate state |
| Separate tester and implementer: 0 confirmed weakenings guarded, 19% of tokens, 14 wrong tests nobody could fix, 57 slices stuck on existing tests nobody could update | AVOID | agents/builder.md | applied - one builder per slice; red snapshot through the gate flags removed assertions; existing-test edits allowed and itemized |
| Over-slicing (one behavior per module, docs-only slices) multiplied gate runs | AVOID | agents/planner.md | applied - **extends 2026-10-01** - behavior-sized slices; docs ride with their source |
| Test code at a median 1.66x source lines; user asked to trim | ADD | agents/builder.md + agents/planner.md + agents/feature-critic.md | applied - about one test per behavior, extend existing tests, critic reviews proportion; no numeric ratio rule |
| Critic precision 85-95%, but 85% of its items were deferred by the blocking rule and it missed 70% of outside-review should-fix findings | AVOID | agents/feature-critic.md + agents/feature-verifier.md + workflows/feature-flow-run.js | applied - report everything with severity and confidence; lenses for the recurring blind spots; verifier triages by risk and fix cost; prod and credential safety never deferred |
| User ran an outside Codex or Fable review on most runs and asked whether another round was worthwhile | ADD | workflows/feature-flow-run.js + scripts/feature-flow-codex-review.js | applied - final cross-model review (feature-critic on Fable; `--codex` opt-in) with triage; at most 2 fix rounds across both stages. A replay of 3 past diffs put the critic on Opus (tied Fable on live and human labels at 2.6x lower cost) and dropped a thinner final-review persona that missed a Critical |
| Completeness dropped non-blocking recheck gaps, went stale before the critic loop, and never saw the ledger | AVOID | workflows/feature-flow-run.js + agents/completeness-critic.md | applied - coverage recomputed at the final head; ledger and stuck slices as inputs; partial gaps become follow-ups |
| Briefs carried "checks pass" and process rules as acceptance criteria; CI-only criteria were declared undeliverable | ADD | commands/feature-flow.md | applied - evidence-tagged criteria (test, diff, docs, ci:<job>, live); process rules under constraints; deferred proofs name the exact job |
| Report averaged 1,188 words; user rewrote nearly every PR body | AVOID | agents/synthesizer.md | applied - short review summary with a review guide |
| An interrupted run was delivered without its review stages | ADD | commands/feature-flow.md + workflows/feature-flow-run.js | applied - stage status per head; UNREVIEWED registration; --review-only relaunch |
| RE_PLAN research and fix-size guard fired 0 times in 76 runs | AVOID | workflows/feature-flow-run.js | applied - removed; triage returns a replan reason instead |
| Haiku 4.5 retires; gate relays now only relay | STRESS | workflows | applied - Sonnet 5.5 at low effort |

Notes:
- spike-flow keeps tdd-slice-loop.js with tester and implementer; only its gate model changed.
- ADR-0008 amended so the Claude-only baseline stays maintained; the pin is re-recorded with this change.

## 2026-10-01 - feature run (sanitized)

A small additive change shipped correctly, but took several times its
command cost in process: too many slices, retries on unchanged code, and
type errors charged to the wrong slice. Most items extend the 2026-07-24
single-owner gate and verification ledger.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Over-slicing a one-behavior change; a slice whose only content is re-running gate commands | AVOID | agents/planner.md + workflows/feature-flow-run.js (planner prompt) | applied - thin means one behavior, not many slices; generated outputs ride with their source; no slice without a change of its own. The planner prompt's "as thin as possible" no longer reads as "as many as possible" |
| Retrying the full gate list on an unchanged tree after an unrelated failure | AVOID | workflows/tdd-slice-loop.js | applied · **extends 2026-07-24 verification ledger** - reuse is keyed on the exact tree, so any tree change still reruns everything. Static and suite results are reusable across the run; verification results only from the same slice's previous attempt. Failed gates now record the tree for commands that passed, and an empty gate output falls back to the failing command's tail instead of "unknown failure" |
| Test runner doesn't typecheck, so a slice's type error fails the next slice's gate | ADD | workflows/tdd-slice-loop.js + workflows/feature-flow-run.js + commands/feature-flow.md | applied · **corroborates 2026-06-03 preflight triad and 2026-06-12 "wire the uncovered check into the inner loop"** - new `staticCmds` run first on every gate (new `static` kind and stat); slow or credentialed checks stay in `verifyCmds` |
| Stale `stuck` entries for work a later gate validated; `branch` carried the worktree path | ADD | workflows/feature-flow-run.js + workflows/tdd-slice-loop.js + commands/feature-flow.md | applied - gate-exhaustion entries carry their required commands, and a later validated SHA covering all of them marks the entry `supersededBy` (kept, not dropped; completeness still judges the behavior). Real branch passed in and returned; worktree returned separately |
| Red or hanging gate command on the unchanged base, found only by chance | ADD | commands/feature-flow.md | applied · **corroborates 2026-06-03 and 2026-06-12 preflight entries** - baseline every gate command exactly as passed, non-interactively, under an outer timeout; red or hung base stops the launch and asks for an approved alternative |
| Critic and completeness gate passed a change that a repo rule says must ship separately (warn-only check, CI green) | ADD | agents/critic.md + workflows/feature-flow-run.js | applied · **corroborates 2026-09-23 review-flow "no owner for rollout-order / repo-rule questions"** - Mode A reads the repo's sequencing and rollout rules and warn-only checks; delivery-reshaping violations go to a new `decisions` channel surfaced near the top of the PR body, not into the repair loop |
| Gate ran commands more than once and apparently altered one | STRESS | workflows/tdd-slice-loop.js | applied · **corroborates 2026-07-24 "mechanical gates"** - commands verbatim (no added flags, filters, paths, or substitutes), each at most once, no in-gate reruns |
| Wrapper that records the command line the gate actually executed | STRESS | workflows/tdd-slice-loop.js | skipped - the script can't read files, so a wrapper log is still agent-reported; revisit if verbatim instructions don't hold |
| Gate commits carried an agent attribution trailer and lacked the story prefix | STRESS | workflows/tdd-slice-loop.js + workflows/feature-flow-run.js | applied - gate agents don't load the user's global rules, so the exact message (`commitPrefix` + subject, no attribution trailer) is now in every gate and sweep commit prompt |
| Cross-model check after the feature-flow critic | ADD | workflows/feature-flow-run.js | skipped - retro asked for a second miss by the in-family critic first; watching |
| Brief predicted a generator-assigned identifier that was already taken | ADD | commands/feature-flow.md | skipped - single occurrence, agents handled it; if it recurs, describe generated identifiers by pattern, not value |

Notes:
- No conflicts or reverts. The tree-keyed reuse replaces the 2026-07-24
  rule that required a clean, committed start state for reuse. Tree identity
  was always the proof, and the script now also checks that every result
  sits on the verified tree. A throwaway simulation covered flaky-retry
  reuse, stale-tree rejection, stuck supersession, and the unsuperseded case.
- Verification reuse within one slice's retry window is deliberately narrow.
  Credentialed or time-dependent previews stay fresh across slices.

## 2026-09-30 - review-flow evidence and coverage (not a retro)

Checked by an independent Codex review of the plan.
Instruction growth kept to per-lens bars and one shared
inputs line.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| A PR that edits its repo's rule files was reviewed under its own proposed rules (rules were read from the head checkout) | AVOID | scripts/review-flow-prep.js + workflow + codex-cross-check.js | applied - rules extracted from the base revision; head copies are content under review; no head fallback when the base can't be read; Codex no longer auto-loads the checkout's AGENTS.md; every agent is told PR material is evidence, not instructions |
| Correctness, security and tests lenses had one-line scopes while observability and design had bars | ADD | workflows/review-flow-run.js | applied - short bars (interleaving, recovery and replay, guard coverage; authorization to the effect, identifiers bound to the principal; tests that fail for the intended reason), each only in its own lens |
| An empty lens result said nothing about what was checked, and a lens that died was indistinguishable from a clean one | ADD | workflow + scripts/render-review.js | applied - per-lens coverage record, local-only Coverage section; dead lenses show as not run |
| Changed files with no patch, and diffs too large for the API, could pass as reviewed | AVOID | scripts/review-flow-prep.js | applied - changed-file census, local diff fallback, gaps in the report header |
| Head CI annotations were invisible to reviewers | ADD | scripts/review-flow-prep.js + workflow | applied - annotations on changed files passed as already-reported evidence, never as a reason to skip a defect |
| No way to re-check the flow against known cases after a change | ADD | review-flow-evals.md + prep replay mode | applied - manual regression set with a replay mode that can never post; known cases don't measure unseen-bug performance |
| Follow-up (incremental) reviews | ADD | - | deferred |

## 2026-09-24 - review-flow instruction trim (not a retro)

Cut the instruction text each review run loads by roughly 60-90% per
consumer without dropping a rule: host procedure moved into
`review-flow-prep.js` / `review-flow-post.js`; review's critic split into its
own `review-critic` persona (feature/spike keep `critic` without Mode B); the
verifier runs persona-free, which removed a contradiction where it loaded
"don't fact-check" guidance; shared rules rewritten tighter. Checked by a
44-item rule inventory and an independent Codex intent diff, whose findings
(hotfix posture exactness, prep head-stability, prior-fetch parsing,
`commit_id` pinning, two dropped hints) were applied. Deliberate change: an
existing pending review now stops the post (never delete-and-repost) instead
of an improvised append.

## 2026-09-23 - review-flow audit (not a retro; sanitized)

A deliberate audit rather than a single-run retro: 17 review runs over eight
weeks (run artifacts plus session transcripts), external research on
AI code review, and an independent plan review by a different model family
(Codex). Applied in two passes; a third (below) is deferred until it can be
measured.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Urgency floor working as a silent strike (a `fast` run hid most kept findings; empty drafts; cluster text narrating hidden findings) | AVOID | scripts/render-review.js + workflow + command | applied - urgency now shapes only the draft; reviewers emit every tier; the local report shows every finding marked in-draft or local-only with the reason |
| A displayed cap that was never enforced (`max_comments`) | AVOID | scripts/render-review.js | applied - real draft budget across inline + general, criticals/importants exempt, confidence orders findings within a tier |
| Reviewing a snapshot nobody pinned (separate "live head" and "live diff" reads; shallow-clone checkout failing every run) | AVOID | commands/review-flow.md | applied - one snapshot record (head, base, diff digest, checkout SHA); detached checkout of the exact SHA; no-checkout is flagged visibly; draft carries `commit_id`; pre-POST head check aborts instead of patching |
| Process narration and secrets in author-facing text | AVOID | workflow + agents/critic.md + renderer | applied - per-finding `evidence` (local only) separate from `body`; deterministic secret gate blocks the draft (never auto-redacts); orientation is never posted |
| Findings with no diff line silently dropped | AVOID | workflow + agents/critic.md | applied - `general` wired end to end (it had never been populated) |
| No owner for scope / fit / house-pattern / rollout-order questions | ADD | workflow (lens) + defaults.yaml | applied · **resolves the 2026-06-08 deferred "design/requirements lens"**, which recurred across several runs - `design` lens replaces `style` (style yielded 2 critical/important of 81); judgment calls come back as `decisions`, kept separate from defects |
| Stated intent never reaching the agents | ADD | commands/review-flow.md + workflow | applied - PR description and linked issues fetched to `pr-body.md`; repo `REVIEW.md` passed when present |
| Pre-existing defects mixed with the PR's own | ADD | schema + renderer | applied - `pre_existing` bucket, local only, never supports posture |
| Two stacked truth-checks (critic spot-verify, then verifier) | STRESS | agents/critic.md + workflow | applied · **deliberately reverses the 2026-06-08 critic false-positive pass and the 2026-07-17 in-critic adversarial pass** - the verifier (added 2026-09-11) is now the single fact-check owner; the critic keeps only structural checks and a glance-level contradiction strike. Evidence: the verifier's catches were ones the critic had passed; newer-model guidance advises against stacked self-verification. Revert path: restore Mode B step 2 from git if post-verify retractions rise |
| Same doctrine copied into three prompts | STRESS | workflow | applied - one `EVIDENCE_RULES` block shared by reviewers and verifier; the concrete retracted-finding example stays with the verifier (the load-bearing part per 2026-09-11) |
| Self-filtering language in finder prompts ("if in doubt, it's not critical") | AVOID | workflow + agents/critic.md | applied - finders report with an honest `confidence`; tiers defined by a nameable consequence rather than by caution |
| Same-family verification blind spot | ADD | scripts/codex-cross-check.js + command | applied - Codex cross-check after the Claude verifier; strikes become `contested` (never deleted) and block the draft while a contested critical/important is undecided; fail-soft; `--no-codex` |
| Host racing the workflow (progress polling, parallel self-verification) | AVOID | commands/review-flow.md | applied - host waits; return contract and `comments.json` shape documented |
| Orientation and diagrams unused | STRESS | workflow | applied - orientation re-aimed at the human reviewer ("what this code is for, what changed, what to read first"); diagrams opt-in (`--diagrams`) |

Deferred (pass 3): a `--followup` re-review mode keyed on posted comment ids
and old/new SHAs; a frozen replay corpus of past runs with resolution-rate
tracking; size/risk routing (piloted against the corpus, never shortcutting
infra/permissions/deploy changes).

Watch: whether removing the critic's spot-verify raises post-verify
retractions; whether the design lens yields surviving findings; Codex
cross-check incremental catches versus its latency.

## 2026-09-11 - review run (sanitized)

High-signal run: the review was posted, the author contested six of ten
findings, and enough of that pushback was correct to be diagnostic. One
finding was publicly retracted; four others had a refutable leg. Nearly all of
it collapses into two failure classes already present in this ledger, now
sharpened, plus one genuine orchestration gap (reviewers never saw the PR's
existing review conversation).

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Mechanism claimed from docs/memory rather than the installed dependency | AVOID | workflows/review-flow-run.js (reviewer prompt) + agents/critic.md | applied - **sharpens** the 2026-07-17 primary-source rule: for a third-party library the primary source is the **resolved dependency on disk**, not published docs and not the manifest version range (frameworks vendor/alias/patch their own copy, so a bump can be inert) |
| Unqualified claims of absence | AVOID | workflows/review-flow-run.js (reviewer prompt) + agents/critic.md | applied · **corroborates 2026-07-17 capability-absence and 2026-06-08 false-positive pass** - broadened from platform-capability absence to in-repo absence, and now requires the finding to *name the search that established it* or downgrade to a question; framework auto-instrumentation, middleware, decorators, base classes, codegen and platform defaults named as the standard blind spot |
| Reviewing a change in isolation when a review conversation already exists | AVOID | commands/review-flow.md + workflows/review-flow-run.js + agents/critic.md | applied - orchestration fixed first per the retro's own guidance: the command now fetches prior threads (resolved state + timestamps + author replies + submitted reviews), passes `priorReviewPath`, and both reviewers and critic receive it; "not fetched" is explicitly *unknown* overlap, never a clean slate |
| Consequence asserted without the runtime or visual verification it needs | AVOID | workflows/review-flow-run.js (reviewer prompt) + agents/critic.md | applied - a real mechanism whose user-visible effect was never observed (no render, no device, no live request) is reframed as a question with the settling test named and tiered below fully-verified defects, rather than struck or shipped at equal tier |
| Hand-patching derived summary text after the finding set changes | AVOID | commands/review-flow.md + agents/critic.md | applied, **retargeted** from the workflow script - posture, rationale, cluster/through-line and counts are derived, so corrections go through the finding-set file and a re-render; the rendered artifacts are never edited in place |
| Adversarial verification phase seeded with a *named* failure mode | ADD | workflows/review-flow-run.js + AGENT-TEAMS.md | applied - new third phase: one independent agent re-attacks the finalized set, seeded with the three named failure classes above plus a concrete retracted example, assigns keep/strengthen/down-tier/strike, then regenerates all derived fields. Fail-soft (the critic's set is already on disk and still renders) and preserved for audit |
| Explicit disposition vocabulary for reconciling against prior threads | ADD | agents/critic.md | applied - new Mode B step: every overlap gets drop-as-duplicate, leave-as-settled, or re-raise while naming the prior thread and the point its closure left unanswered; silence is not a disposition |
| Check reply chronology before treating a rebuttal as responsive | ADD | agents/critic.md | applied as part of the prior-conversation cluster - timestamp order separates "answered, and I disagree" from "never answered"; resolved state is not evidence the objection was answered |
| Separate the authority question from the policy question | ADD | agents/critic.md | applied as part of the prior-conversation cluster - "the owner approved this" settles who consented, not whether the practice matches documented convention; contest the policy question only |
| Pre-publication artifacts are cheap to rebuild; published ones are append-only | STRESS | commands/review-flow.md | applied · **corroborates the 2026-06-08 draft-hygiene append-not-repost rule** - front-load doubt before the publish step, since a posted wrong comment can only be corrected by appending a retraction |
| Tier discipline under a filter | STRESS | agents/critic.md | **skipped - observed but not applied.** The retro itself flagged it low-confidence and asked for recurrence across runs with different consumers; the ledger shows no prior occurrence, and the evidence (a consumer dropping whole lower tiers) is as easily read as a preference for a tight review as systematic mis-tiering. Watching |

Notes:
- **No conflicts and no reverts.** The new standalone verification phase does
  *not* reverse the 2026-07-17 decision to put an adversarial pass inside the
  critic - that instruction is retained. It is corroboration-by-insufficiency:
  the in-critic pass ran and still left a refutable leg in four of ten
  findings, so a second *independent* pass was added alongside it rather than
  in place of it. Worth tracking whether the redundancy earns its cost.
- The "named failure mode" detail is the load-bearing part of that phase, not
  the extra agent. The retro is explicit that generic "double-check your work"
  instructions did not produce these catches; a phase seeded with a concrete
  prior failure did.
- Cross-PR case for each applied item: vendored/aliased/patched dependencies
  are common in any framework-based repo; absence claims and
  auto-instrumentation blind spots are generic LLM-reviewer failures already
  twice-recorded here; almost every non-trivial PR carries prior review
  conversation; unobserved visual/runtime consequences arise wherever review is
  static; and derived-text drift follows mechanically from any late change to a
  finding set.
- The derived-text item was retargeted away from the workflow script the retro
  guessed. The renderer already computes those fields deterministically - the
  failure was a human-side correction path editing rendered output, so the rule
  belongs with the conversation that owns rendering, and with the agents that
  author the finding set.
- Deliberately **not** encoded: "author pushback implies the finding was
  wrong." The retro flags a counter-signal - one dismissal was confidently
  wrong, and another was right about the broad claim while a narrowed version
  survived. The verifier is instructed to treat pushback as evidence worth
  checking, and explicitly told not to concede a finding merely because it is
  contestable.

## 2026-07-24 - feature run (sanitized)

The dominant signal was duplicated execution plus critic-driven architectural
expansion. The orchestration changes preserve independent review quality while
making verification single-owner, retries continuation-shaped, and broad
repairs an explicit research + user-decision boundary.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Nested full-suite multiplication | AVOID | workflows/tdd-slice-loop.js + agents/tester.md + agents/implementer.md | applied - tester/implementer own focused checks; one mechanical gate owns the deduplicated full suite and verification commands for each code state |
| Fresh-context retry loops | AVOID | workflows/tdd-slice-loop.js | applied - retries receive the current diff boundary, prior handoff, and bounded gate failure; broad brief/plan rediscovery is explicitly forbidden |
| Architectural expansion during critic repair | AVOID | agents/critic.md + workflows/feature-flow-run.js | applied - broad repairs trigger research + RE_PLAN instead of entering the ordinary repair loop; corroborates the 2026-05-29 mid-flow architecture-research entry |
| Unresearched custom primitives | AVOID | agents/critic.md + workflows/feature-flow-run.js | applied - custom queue/lock/scheduler/cache/protocol recommendations require current primary-source capabilities, repository mechanisms, and simpler alternatives; corroborates the 2026-07-17 capability/mechanism verification cluster |
| Guaranteed-to-fail artifact retries | AVOID | workflows/feature-flow-run.js + agents/synthesizer.md + commands/feature-flow.md | applied - synthesizer returns structured content and the conversation persists it; deterministic write-policy failures are not retried inside the same restricted context |
| Verification ledger | ADD | workflows/tdd-slice-loop.js + workflows/feature-flow-run.js | applied - records command, kind, validated SHA, exit status, tree mutation, environment, and bounded output; critic reuses the evidence instead of rerunning commands |
| Critic fix-size guard | ADD | defaults.yaml + agents/critic.md + workflows/feature-flow-run.js | applied - configured eight-file behavior-bearing cap plus one-subsystem/one-seam/no-new-primitive guard; mechanical snapshots, fixtures, generated outputs, and documentation companions do not trip the file count |
| Conditional architecture research gate | ADD | workflows/feature-flow-run.js | applied - only guard-crossing repairs launch bounded primary-source/repository research with at least two simpler alternatives; corroborates 2026-05-29 |
| Run-level cost and time budget | ADD | commands/feature-flow.md | skipped - one occurrence and the proposed stop-for-approval cannot work inside a background workflow with no mid-run input or clock; `runStats` now surfaces agents/retries/check counts, but no new budget policy was invented |
| Conversation-owned artifact persistence | ADD | workflows/feature-flow-run.js + agents/synthesizer.md + commands/feature-flow.md + AGENT-TEAMS.md | applied - report and notes content return to the interactive command for persistence |
| Thin-slice discipline applies to critic findings | STRESS | agents/critic.md + workflows/feature-flow-run.js | applied - one requested outcome, subsystem, and behavioral seam per repair; split independent paths or RE_PLAN |
| Mechanical gates need cheap, narrow execution | STRESS | workflows/tdd-slice-loop.js + workflows/feature-flow-run.js + AGENT-TEAMS.md | applied - gate/commit calls are pinned to Haiku at low effort, skip design rereads, and return bounded failure tails |
| Blockers must stay acceptance-proportional | STRESS | agents/critic.md | applied - desirable hardening is non-blocking unless tied to a concrete correctness or safety failure on the shipped path |
| Critic owns defect proof, not unilateral architecture | STRESS | agents/critic.md + workflows/feature-flow-run.js | applied - critic proves failure/constraints and supplies questions/directions; research gathers evidence, then the user chooses architecture |

Notes:
- No conflicts or prior reverts were found. The architecture-research items
  strengthen the 2026-05-29 mid-flow pivot rule, and the custom-primitive rule
  extends the 2026-07-17 primary-source requirement from review claims to
  feature-flow architecture decisions.
- Every applied item has a cross-PR case: test-heavy repositories duplicate
  expensive gates; any non-trivial retry loses context; critic repairs can
  broaden into subsystems; platform capabilities and in-repo primitives drift;
  restricted subagents can deterministically reject writes; and broad critic
  findings are difficult to verify atomically.
- The cost/time budget was deliberately not encoded from one run. Existing
  retry/revision caps remain authoritative, and the new run statistics provide
  recurrence evidence without inventing thresholds or pretending a background
  workflow can pause for interactive approval.

## 2026-07-17 - review run (sanitized)

A finding shipped at "important" that was a false positive - a mechanism
claim ("this fails because a named resource behaves like M") asserted from
background knowledge, caught only by human review. Root failure
was judgment about *what makes a finding trustworthy*, not orchestration.
All six items **corroborate the 2026-06-08 review-flow entry** (false-positive
pass / trusting reviewer claims without verification) — this is the recurrence
that theme predicted, so the whole cluster was applied with confidence.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Mechanism claims from priors (uncited "how a named API/resource behaves") | AVOID | workflows/review-flow-run.js (reviewer spawn prompt) | applied — new "Don't assert mechanism from memory" doctrine: a claim about how a named API/resource/library behaves (network path, failure mode, capability existence) can't carry critical/important on background knowledge; cite a primary source or down-tier and say it's unverified |
| Capability-absence stated as fact | AVOID | agents/critic.md (Mode B step 2) | applied · **corroborates 2026-06-08 false-positive pass** — new fragile-category bullet: "there is no API/way to do X" is the most fragile claim against a fixed knowledge cutoff; treat every absence as a hypothesis, confirm against a primary source or strike |
| Confidence bleed across a compound claim | AVOID | agents/critic.md (Mode B step 2) | applied — new "compound claims — rate each leg on its own evidence" bullet: verifying one leg must not raise confidence in a different unverified leg, and must never justify removing its hedge |
| Self-contradiction scan before severity | ADD | agents/critic.md (Mode B step 2) | applied — new bullet: before finalizing severity, ask "does the diff itself contradict this claim?"; an input shape/default/adjacent call often implies the opposite — strike if so |
| Primary-source gate for failure-mode findings | ADD | workflows/review-flow-run.js (critic spawn prompt) | applied · **corroborates 2026-06-08 false-positive pass** — critic Mode B instruction now requires "fails-at-deploy/runtime-because-mechanism-M" findings to carry a primary-source citation to survive above `recommended`; strike/down-tier uncited mechanism/absence claims |
| Adversarial verify should attack the central factual premise | STRESS | agents/critic.md (Mode B step 2) | applied · **corroborates 2026-06-08 false-positive pass** — step 2 now opens by directing the critic to adopt an author-trying-to-refute stance on each finding's central premise, extending the strike-if-wrong pass beyond dedup/anchoring/right-sizing |

Notes:
- All four `agents/critic.md` items were folded into the existing Mode B
  step 2 (the "spot-verify and strike" step the 2026-06-08 retro created) as
  a coherent "attack the central factual premise" block with four
  fragile-category bullets, rather than scattered across the mode — same
  failure mode, same home.
- Every item passes the cross-PR test: uncited mechanism claims,
  capability-absence against a knowledge cutoff, confidence-bleed in compound
  claims, and diff self-contradiction are generic LLM-reviewer failure modes,
  not artifacts of a single review. Corroboration with the 2026-06-08 entry satisfies
  the generality test independently.
- The confidence-bleed item surfaced during a *post-run* verification in
  conversation (not inside the workflow), but the anti-pattern is general and
  belongs wherever severity/confidence is assigned — encoded in the critic.
- Gate kept proportional per the retro: the primary-source requirement binds
  hardest on high-severity mechanism/failure-mode claims (can't survive above
  `recommended` uncited), not on style/subjective findings.
- No conflicts to surface — nothing in the ledger argues for trusting
  reviewer claims or reasoning mechanism from priors; every item reinforces
  the existing verification direction.
## 2026-06-12 - feature run (sanitized)

The dominant failure pattern was composition-dependent behavior validated only
in isolation. Four items below address that root cause from different angles
(tester, final-slice rule, critic, planner/implementer) and were applied as a
reinforcing set.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Isolated unit test sold as the headline e2e check | AVOID | agents/tester.md | applied — new constraint: composition-dependent behavior (middleware/interceptor order, plugin pipelines, request chains, registration sequence) must be driven through the *real* assembled pipeline / shared registration helper, and the test proven to fail under wrong wiring; flag slices that can only be unit-tested in isolation |
| Real-composition test for order/wiring-dependent slices | ADD | commands/feature-flow.md (final-slice e2e prompt) | applied — same root cause as the AVOID; strengthened the `is_final_slice` tester spawn prompt to drive through actual wiring (not a hand-built subset) and confirm fail-under-wrong-wiring |
| Critic must validate the headline path as a running system, not just a diff | STRESS | agents/critic.md (Mode A) | applied — new Mode A bullet: trace the designated e2e/headline behavior through real wiring, library behavior, and adjacent components; a passing unit test + clean diff is insufficient evidence; flag missing real-composition test as FIX_LIST |
| Verify shared/library internals when behavior hinges on them | ADD | agents/planner.md (+ agents/implementer.md) | applied, scoped tightly — planner verifies library composition order against source before baking an ordering assumption; implementer gets a companion "black-box for comments, not for correctness" note. Bounded to decisions that *hinge* on library internals, per the retro's over-correction warning |
| Act on verification-coverage gaps found at preflight | ADD | commands/feature-flow.md (preflight step 6) | applied · **corroborates the 2026-06-03 preflight ADD** - strengthened step 6 from "note the gap" to "wire the uncovered language's own check into the inner loop now; don't defer to CI" |
| Resolve the commit-vs-leave-uncommitted tension for diff-based review | ADD | commands/feature-flow.md | applied — made explicit that critic/synthesizer see only committed work via `git diff <base>...HEAD`, so all outstanding work must be committed before Phase 3; don't hand the critic an empty diff |
| "Sandbox-green ≠ done" for infra/integration | STRESS | commands/feature-flow.md (Phase 2 note) + agents/synthesizer.md | applied · **corroborates the 2026-05-29 "sandbox not sufficient" entry** — emphasized the PR-body post-deploy checklist is load-bearing; synthesizer now must spell out concrete post-deploy checks for infra/integration features, not just the local test command |

Notes:
- The composition-test cluster (tester AVOID + final-slice ADD + critic
  STRESS + planner/implementer ADD) is one root cause; applied as a set per
  the retro's "if you change only one thing" guidance. All four pass the
  cross-PR test — composition-dependent behavior (middleware order, plugin
  pipelines, registration sequence) is a generic trap, not specific to this
  feature.
- Two items corroborate prior ledger entries: preflight-coverage strengthens
  the preflight step (2026-06-03), and "sandbox-green ≠ done"
  reinforces the 2026-05-29 infra-not-sufficient note. Both applied with
  confidence on the strength of the corroboration.
- The "verify library internals" ADD was applied but deliberately bounded to
  decisions that hinge on library composition — the retro flagged
  over-correction risk (not for every library call). Watch future retros for
  whether the narrow scope holds or needs widening.
- No conflicts to surface — every incoming item either corroborates a prior
  entry or is net-new, and none reverses a past decision.

## 2026-06-08 - review run (sanitized)

First **review-flow** retro in the ledger (prior two were feature). Run was
a re-run of a review on the same PR, which exercised re-run/head-drift paths
a clean first pass never hits — hence the cluster.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Reviewing an unverified / stale head | AVOID | commands/review-flow.md | applied — paired with the sync-verify ADD into one Setup step (4) |
| Sync-and-verify head before Phase 1 | ADD | commands/review-flow.md | applied — Setup step 4: fetch live `headRefOid`, checkout to it, confirm tree==diff==live head, re-do every re-run |
| Trusting reviewer claims without verification | AVOID | agents/critic.md | applied — paired with the false-positive ADD into Mode B step 2 |
| Critic false-positive pass | ADD | agents/critic.md | applied — new Mode B step 2: spot-verify each finding's claim against /work/repo/ and **strike** (not down-tier) demonstrably-wrong ones; distinct from dedup/anchoring |
| Reconcile prior-run artifacts on re-run | ADD | commands/review-flow.md | applied — Setup step 5: detect a prior run's live draft, supersede/discard deliberately, label which artifacts are from the newer run |
| Phase-4 draft hygiene (pre-POST anchor validation + append-not-repost) | ADD | commands/review-flow.md | applied — Phase 4 steps 1–2: validate each anchor before POST (GitHub 422s the whole review on one bad anchor; fold non-anchorable into body); append over delete-and-repost when a posted draft may be hand-edited |
| Anchor to true source-file lines, not diff-line numbers | STRESS | commands/review-flow.md (reviewer spawn prompt) | applied — `line` field now mandates the source-file line (read `@@` header, verify against /work/repo/), not the diff's running count (off ~150+ for new files) |
| A design/requirements lens | ADD | commands/review-flow.md | skipped — retro itself flagged it "most speculative, only act if it recurs"; no prior occurrence in ledger. Observed-but-not-applied; watching |
| Diagrammer provisions an arch-correct browser | ADD | agents/diagrammer.md | skipped — sandbox-infra fix (host/sandbox arch mismatch, native browser provisioning), not a team-process pattern; consistent with the 2026-05-29 hold-out of cross-platform-binary issues. Tracked as environment work, not a prompt edit |

Notes:
- The first four items + reconcile-artifacts are one reinforcing re-run
  cluster (stale head → contaminated findings → false positive shipped →
  orphaned draft on re-run); applied as a set per the retro's guidance.
- AVOID/ADD pairs were each folded into a single edit (stale-head ↔
  sync-verify; trust-claims ↔ false-positive pass) — same pattern stated
  from both sides.
- Critic false-positive pass got its own Mode B step rather than folding
  into the anchoring step: the retro is explicit that dedup/anchoring/cap
  passes do **not** catch factually-wrong findings — different failure mode.
- "Design/requirements lens" and the diagrammer browser are the two
  held-back items. The lens is a genuine blind spot but the remedy (new
  lens vs. critic/orientation responsibility) is a design choice the retro
  asked to defer until recurrence. The diagrammer item is a carried-over
  sandbox-infra concern, out of scope for prompt edits by the same rule
  applied in 2026-05-29.
- No conflicts to surface — first review-flow retro, nothing to corroborate
  or contradict in prior (feature-only) entries.

## 2026-06-03 - feature run (sanitized)

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Inner-loop comment bloat (restate code / TDD scaffolding / forward-looking) | AVOID | agents/tester.md + agents/implementer.md | applied — corroborates 2026-05-29 comment-discipline theme (upstream-internals); tester gets a no-loop-scaffolding guardrail, implementer a why-only-comments guardrail |
| Synthesizer over-writes PR body + leaks run framing | AVOID | agents/synthesizer.md | applied — length half corroborates 2026-05-29 STRESS (already applied); run-framing-leak half **corroborates the 2026-05-29 SKIPPED "planning labels leak" entry** → now applied as a synthesizer guardrail (no slice/track/phase names, no run work-organization) |
| Preflight verification smoke-check | ADD | commands/feature-flow.md | applied — new Setup step 6: run the test/typecheck/lint triad once before the first slice to surface toolchain gaps early. Distinct from 2026-05-29 "sandbox not sufficient" (that's deploy-time; this is setup-time toolchain) |
| Handle a non-`main` diff base explicitly | ADD | commands/feature-flow.md + agents/critic.md (+ synthesizer.md) | applied — new Setup step 5 computes the true base; critic + synthesizer spawn prompts now pass `<base>...HEAD`; critic.md + synthesizer.md note the base is lead-supplied, not assumed `main` |
| Tester self-lints its own test files before handoff | ADD | agents/tester.md | applied — low-confidence per retro but "formalize only if not already a step"; it wasn't a step. Added a lint-your-own-test-files constraint |
| Additive commits + plain push once a PR is open; no amend/force-push | STRESS | commands/feature-flow.md | applied — post-Phase-2 commit guidance now forbids amend/force-push once pushed/under review; notes the more-pushes-vs-per-commit-CI tension and resolves it by batching, not force-push |

Notes:
- The run-framing-leak item resolves the previously-watched "Planning labels
  (track/slice/phase) leak into artifacts" entry from 2026-05-29 — that one
  was skipped as a single occurrence. This retro is the recurrence, but only
  for the **synthesizer / PR body** surface. The planner and implementer
  halves of that original pattern are still single-occurrence — left
  watched, not applied to those two files.
- Deliberately omitted per the retro's own consumer guidance: sandbox/repo
  env fixes (build toolchain for race tests, broken generated dep, lint
  binary off PATH) and external-spec/ticket lookups — they motivate the
  preflight-verify ADD but aren't generic prompt changes.
- Also omitted (retro left it out on purpose): mining run-specific defects
  missed by the approving critic into new heuristics. That would bloat the
  critic into an incident checklist. The generic boundary-review limitation
  was already captured by existing guidance.
- No conflicts to surface this round — every incoming item either corroborates
  a prior entry or is net-new.

## 2026-05-29 - feature run (sanitized)

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| TDD for work with no unit-test surface | AVOID | commands/feature-flow.md | applied — folded with "sandbox-not-sufficient" into one Phase 2 note (route infra/config slices implementer-only, lean on deploy validation) |
| Decline artifact-text-only tests | AVOID | agents/tester.md | applied — guardrail: don't write substring-grep tests, flag to lead |
| Implementer adds defensive scaffolding without flagging | AVOID | agents/implementer.md | applied — "minimum is broad," covers deps/IAM/config; require handoff flag |
| Comments referencing upstream internals | AVOID | agents/implementer.md | applied — treat deps as black boxes when commenting |
| Sandbox verification necessary but not sufficient for infra | ADD | commands/feature-flow.md | applied — folded with AVOID #1 above |
| Critic security pass default for infra-touching diffs | ADD | agents/critic.md + commands/feature-flow.md | applied - high-confidence based on observed review value; auto-engaging security lens + ungated note in feature-flow |
| Mid-flow architectural pivot routes through researcher | ADD | commands/feature-flow.md | applied — new "Mid-flow architectural changes" subsection |
| PR body is a living artifact through merge | ADD | commands/feature-flow.md + agents/synthesizer.md | applied — re-check/PATCH note in Phase 4; "living artifact" constraint in synthesizer |
| Synthesizer PR body too long / impl-heavy | STRESS | agents/synthesizer.md | applied — louder signal: body answers what/flag/verify, rationale → code comments |
| Critic blocking vs non-blocking explicit | STRESS | agents/critic.md | applied — added `blocks-merge: true\|false` field; CI-failing = functionally blocking |
| Planning labels (track/slice/phase) leak into artifacts | STRESS | agents/planner.md, implementer.md, synthesizer.md | **skipped — observed but not applied.** Retro flagged it "deprioritize if it doesn't recur"; single occurrence, ledger shows no prior. Watching — apply if it recurs. |

Notes:
- First entry in the ledger; no corroborations or conflicts to reconcile.
- The two infra-mismatch items (AVOID "no test surface" + ADD "sandbox not
  sufficient") were merged into a single Phase 2 note in feature-flow.md per
  the retro's own consumer guidance — they're one underlying mismatch.
- The critic security-lens item is the high-confidence standout based on its
  observed review value. Made it auto-engaging rather than opt-in.
- Sandbox-tooling environmental issues (host/sandbox platform mismatch,
  cross-platform native binaries, no-TTY interactive prompts) were
  deliberately left out — they're sandbox-infra concerns, not team-process
  patterns. Not edited into AGENT-TEAMS.md this round; revisit if a future
  retro reframes them as a process issue.

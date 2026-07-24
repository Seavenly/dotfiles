# Retro ledger

Running record of process patterns surfaced by agent-teams retros and what
was done with them. Newest entries at the top. Lets us see patterns over
time, corroborate recurring ones, and revert changes that didn't pan out.

Written by the host `/retro-consume` command. See `AGENT-TEAMS.md §Retro
loop` for how the loop works.

<!-- entries below, newest first -->

## 2026-07-24 - 2026-07-23-1849-fcc510-preview-lifecycle-cleanup (feature)

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

## 2026-07-17 — 2026-07-17-1306-pr-126 (review)

A finding shipped at "important" that was a false positive — a mechanism
claim ("this fails because a named resource behaves like M") asserted from
background knowledge, caught only by the PR author's pushback. Root failure
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
  not artifacts of PR #126. Corroboration with the 2026-06-08 entry satisfies
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
- Housekeeping (not a retro edit): this session wrote
  `.claude/settings.local.json` with `{"worktree":{"bgIsolation":"none"}}`
  (gitignored, untracked) so the background-job worktree guard would allow
  in-place edits — a `fresh` worktree branches from origin/main, which is 37
  commits behind the active branch and lacks these edit regions. Remove it if
  bg isolation is wanted for this repo.

## 2026-06-12 — 2026-06-03-1546-gateway-datadog (feature)

The run's one genuine production bug: a composition-dependent behavior was
pinned by an isolated unit test, and an adjacent component in the real chain
overwrote its effect once composed at runtime. Four items below are that same
root cause from different angles (tester, final-slice rule, critic,
planner/implementer) — applied as a reinforcing set, the retro's own
strongest recommendation.

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| Isolated unit test sold as the headline e2e check | AVOID | agents/tester.md | applied — new constraint: composition-dependent behavior (middleware/interceptor order, plugin pipelines, request chains, registration sequence) must be driven through the *real* assembled pipeline / shared registration helper, and the test proven to fail under wrong wiring; flag slices that can only be unit-tested in isolation |
| Real-composition test for order/wiring-dependent slices | ADD | commands/feature-flow.md (final-slice e2e prompt) | applied — same root cause as the AVOID; strengthened the `is_final_slice` tester spawn prompt to drive through actual wiring (not a hand-built subset) and confirm fail-under-wrong-wiring |
| Critic must validate the headline path as a running system, not just a diff | STRESS | agents/critic.md (Mode A) | applied — new Mode A bullet: trace the designated e2e/headline behavior through real wiring, library behavior, and adjacent components; a passing unit test + clean diff is insufficient evidence; flag missing real-composition test as FIX_LIST |
| Verify shared/library internals when behavior hinges on them | ADD | agents/planner.md (+ agents/implementer.md) | applied, scoped tightly — planner verifies library composition order against source before baking an ordering assumption; implementer gets a companion "black-box for comments, not for correctness" note. Bounded to decisions that *hinge* on library internals, per the retro's over-correction warning |
| Act on verification-coverage gaps found at preflight | ADD | commands/feature-flow.md (preflight step 6) | applied · **corroborates the 2026-06-03 track-c preflight ADD** — strengthened step 6 from "note the gap" to "wire the uncovered language's own check into the inner loop now; don't defer to CI" |
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
  the track-c preflight step (2026-06-03), and "sandbox-green ≠ done"
  reinforces the 2026-05-29 infra-not-sufficient note. Both applied with
  confidence on the strength of the corroboration.
- The "verify library internals" ADD was applied but deliberately bounded to
  decisions that hinge on library composition — the retro flagged
  over-correction risk (not for every library call). Watch future retros for
  whether the narrow scope holds or needs widening.
- No conflicts to surface — every incoming item either corroborates a prior
  entry or is net-new, and none reverses a past decision.

## 2026-06-08 — 2026-06-05-1532-pr-435 (review)

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

## 2026-06-03 — 2026-05-28-1624-track-c-gateway-app (feature)

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
- Also omitted (retro left it out on purpose): mining the human-caught bugs
  the approving critic missed (fail-open security gate; un-injected deploy
  config) into critic heuristics. Too run-specific; would bloat the critic
  into an incident checklist. The real takeaway (diff-only review misses
  app↔deploy-config-boundary issues) is a known limitation, not a clean edit.
- No conflicts to surface this round — every incoming item either corroborates
  a prior entry or is net-new.

## 2026-05-29 — 2026-05-27-1331-track-b-gateway-infra (feature)

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| TDD for work with no unit-test surface | AVOID | commands/feature-flow.md | applied — folded with "sandbox-not-sufficient" into one Phase 2 note (route infra/config slices implementer-only, lean on deploy validation) |
| Decline artifact-text-only tests | AVOID | agents/tester.md | applied — guardrail: don't write substring-grep tests, flag to lead |
| Implementer adds defensive scaffolding without flagging | AVOID | agents/implementer.md | applied — "minimum is broad," covers deps/IAM/config; require handoff flag |
| Comments referencing upstream internals | AVOID | agents/implementer.md | applied — treat deps as black boxes when commenting |
| Sandbox verification necessary but not sufficient for infra | ADD | commands/feature-flow.md | applied — folded with AVOID #1 above |
| Critic security pass default for infra-touching diffs | ADD | agents/critic.md + commands/feature-flow.md | applied — high-confidence (only pass that caught a deploy-blocker); auto-engaging security lens + ungated note in feature-flow |
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
- The critic security-lens item is the high-confidence standout: it was the
  only critic pass in the run that caught a deploy-blocking bug. Made it
  auto-engaging rather than opt-in.
- Sandbox-tooling environmental issues (host/sandbox platform mismatch,
  cross-platform native binaries, no-TTY interactive prompts) were
  deliberately left out — they're sandbox-infra concerns, not team-process
  patterns. Not edited into AGENT-TEAMS.md this round; revisit if a future
  retro reframes them as a process issue.

export const meta = {
  name: 'review-flow-run',
  description: 'Execution engine for /review-flow (launched by the command, not run directly): parallel reviewers across lenses → critic dedupes/right-sizes/anchors/decides posture → independent adversarial verify pass. Returns a validated comment set the conversation renders into review.md/.html.',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens (+ orientation, diagrammer) in parallel' },
    { title: 'Critique', detail: 'critic dedupes, verifies, right-sizes tiers, decides posture' },
    { title: 'Verify', detail: 'independent adversarial pass over the finalized set, seeded with named failure classes' },
  ],
}

// args (built by the host command before launch):
//   runDir, outDir, repoDir|null, diffPath, briefPath, prBodyPath,
//   priorReviewPath|null, reviewGuidePath|null
//   prNumber, prTitle, repo, prUrl, headSha
//   urgency ('hotfix'|'fast'|'standard'), maxComments, lenses[], focus|null
// args can arrive as a JSON-encoded string when launched by name — normalize.
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const hotfix = a.urgency === 'hotfix'

const LENS_SCOPE = {
  security: 'auth, authz, input validation, secrets, injection, crypto, data exposure',
  correctness: 'logic bugs, edge cases, error handling, race conditions',
  style: 'naming, structure, readability, project conventions',
  tests: 'coverage gaps, weak assertions, missing edge case tests',
  observability: 'tracing/logging quality — wide root span vs micro-span confetti, debugging/filtering dimensions on the root span, signal on tricky-to-debug edge branches, silent catches, log hygiene (no secrets/PII, no unbounded-cardinality tags)',
}

// Extra doctrine handed only to the observability reviewer (mirrors
// ~/.claude/OBSERVABILITY.md so the reviewer has the bar inline).
const OBSERVABILITY_DOCTRINE = `
**Observability doctrine for this lens** (the bar you review against):
  - One **wide root span per request**, not a confetti of tiny nested spans. A forest of one-attribute child spans where root-span attributes would answer the same questions is a finding.
  - **Debugging/filtering dimensions belong on the root span** — anything used to find a class of requests or explain one after the fact (tenant/account/resource id, route/operation, result status, key params, retry count, the reason a branch was taken). Debug-relevant dimensions buried on a leaf span (or only in a log line) where you can't filter the request population by them is a finding.
  - **Edge cases are the priority.** Hard-to-reproduce branches (rare input, degraded dependency, race, fallback, "should never happen" guard) should leave a trail. A swallowed error / silent catch / empty fallback with no log and no attribute is the highest-value finding here.
  - **Log hygiene:** no secrets/tokens/full-bodies/PII in logs, no unbounded-cardinality values as span attributes, no per-iteration or every-layer log spam. Level should match consequence.
  - **Don't force it.** Trivial getters, mappers, and pass-throughs need nothing. Most findings here are \`recommended\` or \`important\` (e.g. a missing trail on a real error path); observability gaps are almost never \`critical\`. Calibrate to whether on-call could actually debug this in production from telemetry alone — judge against the project's existing instrumentation, and don't demand a telemetry stack a repo doesn't have.`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'line', 'side', 'tier', 'body', 'anchorable'],
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', description: 'true source-file line in the checked-out repo, NOT the diff running-count' },
          side: { type: 'string', enum: ['RIGHT', 'LEFT'] },
          tier: { type: 'string', enum: ['critical', 'important', 'recommended', 'nit'] },
          body: { type: 'string', description: 'author-facing text only: the issue and the fix. No process notes.' },
          evidence: { type: 'string', description: 'local only, never posted: files read, searches run, what established the claim' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'how sure you are the claim is true of the code' },
          pre_existing: { type: 'boolean', description: 'true if the defect exists on the base branch and this PR did not introduce or worsen it' },
          anchorable: { type: 'boolean' },
        },
      },
    },
  },
}

// The critic WRITES the full validated set to <outDir>/comments.json (its
// own deliverable, like plan.md / report.md). It RETURNS this summary for
// the wrap-up. comments.json shape (read by render-review.js):
//   { urgency, posture, posture_rationale, cluster, inline: [{path,line,side,tier,lens,body}] }
const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['posture', 'counts'],
  properties: {
    posture: { type: 'string', enum: ['do_not_merge', 'merge_after_fixes', 'merge_ready_with_followups'] },
    posture_rationale: { type: 'string' },
    cluster: { type: ['string', 'null'] },
    counts: {
      type: 'object',
      properties: {
        critical: { type: 'integer' }, important: { type: 'integer' },
        recommended: { type: 'integer' }, nit: { type: 'integer' },
      },
    },
    wroteCommentsJson: { type: 'boolean' },
  },
}

const repoNote = a.repoDir
  ? `The PR's head ref is checked out at ${a.repoDir} — use Grep/Glob/Read there when you need surrounding code: callers of changed functions, existing tests, project conventions, or whether a "missing check" actually exists elsewhere.`
  : `No local checkout is available (the clone failed). Work from the diff alone and note reduced confidence on findings that depend on absent-code claims.`

// Prior review conversation is primary input, not background. Reviewers given
// only the diff will re-raise threads the author already settled or factually
// rebutted, which costs the review standing on its genuinely new findings.
const priorNote = a.priorReviewPath
  ? `**The PR's existing review conversation is primary input, not background.** ${a.priorReviewPath} holds this PR's review threads, author replies, and submitted reviews, with authors, timestamps, and each thread's resolved/outdated state. Read it before you enumerate anything. Do not raise a point an existing thread already made, and do not contradict a factual correction the author already supplied there. If a finding you want to keep overlaps a thread, name the thread and state what it left unanswered.`
  : `No prior review conversation was fetched for this PR, so thread overlap is *unknown* rather than absent — do not assert that a point is being raised for the first time.`

// What the PR says it is for. Scope and intent claims are judged against this,
// not against the reviewer's guess from the diff.
const intentNote = `The PR's stated intent — description, linked issues, any ticket key — is at ${a.prBodyPath}. Read it before the diff. It can be empty ("no description"); do not invent intent it doesn't state.`

// Repo-level review rules (severity definitions, skip rules, required checks).
// They refine the doctrine below for this repo; they never lower the evidence bar.
const guideNote = a.reviewGuidePath
  ? `This repo has review guidance at ${a.reviewGuidePath}. Apply it: its severity definitions, skip rules and required checks override the generic rubric below for this repo. It does not relax the evidence rules.`
  : ''

// Where a finding's text goes. Anything the author should not see lives in
// \`evidence\`, which the renderer shows locally and never posts.
const authorFacingNote = `Write \`body\` for the PR author: the issue and the fix, nothing else. Put how you established it (files read, searches run, sibling files compared) in \`evidence\`. Never put process narration ("independent inspection agrees", "correction vs. the first draft", "not re-litigating X") in \`body\`. Never quote a secret, token or credential value in either field; describe where it is instead.`

function reviewerPrompt(lens) {
  return `You are the **${lens}** reviewer for PR #${a.prNumber}: ${a.prTitle}.
Read the full PR diff at ${a.diffPath}. Read the brief at ${a.briefPath}.
${intentNote}
${guideNote}
${repoNote}
${priorNote}

Enumerate findings for the **${lens}** dimension only (${LENS_SCOPE[lens]}). Do not produce findings outside your lens — those belong to peers.
${lens === 'observability' ? OBSERVABILITY_DOCTRINE : ''}

Emit findings at every tier regardless of urgency. Urgency (${a.urgency}) only decides which tiers the posted draft carries; that cut is applied later, deterministically, and the local report shows everything. Be high-recall: report what you find, including findings you are unsure of, with an honest \`confidence\`. Downstream passes dedupe, verify and right-size — filtering here only hides findings from them.

If a defect you find exists on the base branch and this PR neither introduced nor worsened it, still report it, with \`pre_existing: true\`. It is kept out of the draft and the verdict.

**Tier rubric — apply strictly.** Reviewers tend to inflate; the protected-tier rule is a floor on signal, not an escalator.
  - critical: ships a CVE-class security bug, breaks the PR's own documented happy path, or causes silent data loss/corruption. Would block merge in any reasonable team. If in doubt, it's not critical.
  - important: a real issue that should be fixed before merge — missing check on changed code, broken edge case the PR introduces, a test gap that lets a critical regress silently. NOT a catch-all for "things I'd improve."
  - recommended: worth doing — refactor, hardening, naming, additional coverage, defensive polish. Would not block merge. Most "I'd write this differently" findings live here.
  - nit: typo, formatting, single-word naming, doc-comment wording.

**Calibrate to project blast radius.** Use what the repo tells you about what this app does and who its users are (CLAUDE.md, README, routes, data models). The same OAuth gap is "critical" in a payments backend and "recommended" on a marketing waitlist. If you downgrade severity because of context, say so in the finding body.

**Don't assert mechanism from memory — and don't assert it from documentation either.** A claim about *how a named API, resource, or library behaves* — its network path, its failure mode, or whether a capability exists at all — is empirically checkable and must not carry \`critical\`/\`important\` severity on background knowledge alone. For a third-party library, the authority is **the resolved dependency on disk in the checked-out repo** (the installed package source, the vendor directory, the lockfile-pinned copy), not published documentation and not the version range in the manifest. Frameworks routinely vendor their own copy of a dependency, alias imports to it, or patch it — so a manifest bump can be completely inert, and documented behavior can be wrong for the code that actually runs. Read the installed source, cite the file you read, and if you can't reach it, down-tier and say the mechanism is unverified. This cuts both ways: the installed source sometimes shows a finding is true and *stronger* than you'd have stated from the docs.

**Never claim absence without stating the search that established it.** "Nothing records which call failed", "no marker distinguishes these two cases", "every sibling file has a test except this one" — absence is the most expensive thing to assert and the cheapest thing to disprove. Either name the search you actually ran (the pattern you grepped, the directory you enumerated, the config you read) in the finding body, or downgrade the finding to a question. The standard blind spot is machinery that is present but *not in the source you're reading*: framework auto-instrumentation, middleware, decorators, base classes, code generation, and platform defaults all supply behavior that no line of the diff mentions. Rule those out before concluding that nothing handles it.

**A consequence that needs a render, a device, or a live dependency is a question, not a defect.** If a mechanism is visible in the diff but its user-visible effect was never observed — nothing was rendered, no device was exercised, no request was actually issued — say so plainly, name the test that would settle it, and tier it below findings you verified end to end. An unverified consequence posted at the same tier as a verified defect invites a one-line dismissal that discredits its neighbors.

For each finding:
  - path: file path
  - line: the **true source-file line number** in the checked-out repo (post-change side unless commenting on a removal) — NOT the running line count inside the diff text. Read the hunk's \`@@ -a,b +c,d @@\` header and count from \`c\`, and verify against the actual file before reporting.
  - side: RIGHT (added/modified) or LEFT (removed)
  - tier: your initial read; the critic may recategorize (most often downgrade)
  - body: one to three sentences. Quote the offending code or describe the missed case.
  - anchorable: true if you have a real file:line from the diff; false for meta/structural comments with no specific anchor.
  - evidence, confidence, pre_existing: as described above.

${authorFacingNote}

Return your findings via the structured-output tool. Do not write any files.`
}

const orientationPrompt = `You are the **orientation researcher** for PR #${a.prNumber}: ${a.prTitle}.
Brief the human reviewer on what this PR is and what the changed files are for, so they can read the rest of the review with context. Assume the reviewer is hopping in cold.

Read in this order: ${a.briefPath} (focus, urgency); ${a.diffPath} (full diff); ${a.repoDir ? `${a.repoDir}/CLAUDE.md and ${a.repoDir}/README.md (whichever exist); the changed files themselves.` : 'the diff alone (no checkout available).'}

Return EXACTLY this markdown as your final message, and nothing else:

## Orientation

**What this PR does.** <1-3 sentences in plain English. If the diff does something beyond the stated goal, say so in one phrase.>

**Files (<N> changed, +<adds>/-<dels>).**
- \`<path>\` (new | modified | removed) — <one line: role/purpose>
- ...
- **Plus <N> support files**: <lockfile/config/generated names>. <one line on what they carry.>

**Skim before reading.** <the 1-3 load-bearing files for the PR's stated goal>

Strict constraints: 300 words MAX. One line per file. Group support files (lockfiles, .gitignore, generated files, formatter configs, trivial bumps) into ONE combined line at the end. Small-PR fast path: if <100 lines across <5 substantive files, drop the Files list and put roles inline in "What this PR does", under 100 words, skip "Skim before reading". Don't restate findings. Don't speculate — say "purpose unclear" if so. No preamble, no closing.`

const diagrammerPrompt = `You are the diagrammer for PR #${a.prNumber}: ${a.prTitle}. Produce call-chain visualizations following your role definition.
Your role refers to $BRIEF / $DIFF / $REPO / $OUT — for this run, substitute these absolute paths in every command:
  $BRIEF = ${a.briefPath}
  $DIFF  = ${a.diffPath}
  $REPO  = ${a.repoDir || '(no checkout — work from the diff alone)'}
  $OUT   = ${a.outDir}/diagrams
Outputs go in $OUT: call-chain.txt + flowchart.{mmd,svg} + sequence.{mmd,svg}, OR skipped.txt if the PR has no runtime call chain (docs/config/deps/refactor).
First action MUST be the mermaid-cli bootstrap from your role definition. If install fails, write skipped.txt and exit cleanly — do not block the review. Stay scoped to call-chain visualization; read-only on the repo. Return a one-line status.`

// ── Phase: Review (parallel fan-out) ───────────────────────────────
phase('Review')

const reviewerThunks = a.lenses.map((lens) => () =>
  agent(reviewerPrompt(lens), {
    label: `reviewer:${lens}`,
    phase: 'Review',
    agentType: 'researcher', // read-only discipline + citation reqs match a reviewer
    schema: FINDINGS_SCHEMA,
  }).then((r) => ({ lens, findings: (r && r.findings) || [] }))
)

const sideThunks = []
if (!hotfix) {
  sideThunks.push(() =>
    // Override the researcher default: orientation is a 300-word strictly
    // templated summary, not open-ended research.
    agent(orientationPrompt, { label: 'orientation', phase: 'Review', agentType: 'researcher', model: 'sonnet' })
      .then((md) => ({ kind: 'orientation', md }))
  )
  sideThunks.push(() =>
    agent(diagrammerPrompt, { label: 'diagrammer', phase: 'Review', agentType: 'diagrammer' })
      .then((status) => ({ kind: 'diagrams', status }))
  )
}

// Fire the side jobs WITHOUT a barrier — the critic only needs the lens
// findings, and the diagrammer's first run can include a multi-minute
// mermaid-cli install. Side results are collected after the critic finishes.
const sidePromise = sideThunks.length ? parallel(sideThunks) : null

const lensRaw = await parallel(reviewerThunks)
const lensResults = lensRaw.filter((r) => r && r.findings)

// Tag each finding with its lens for the critic, then hand the raw set over.
const rawFindings = lensResults.flatMap((lr) => lr.findings.map((f) => ({ ...f, lens: lr.lens })))
log(`reviewers returned ${rawFindings.length} raw findings across ${lensResults.length} lenses`)

// ── Phase: Critique (single critic, Mode B) ────────────────────────
phase('Critique')

const criticPrompt = `You are the review-flow critic for PR #${a.prNumber}. Operate in **Mode B** per your role definition.

Inputs:
- Brief: ${a.briefPath}
- Stated intent (PR description, linked issues): ${a.prBodyPath}
${a.reviewGuidePath ? `- Repo review guidance (severity definitions and skip rules override the generic rubric): ${a.reviewGuidePath}\n` : ''}- Full PR diff: ${a.diffPath}
${a.repoDir ? `- Checked-out head ref for verification: ${a.repoDir}` : '- No checkout available; verify against the diff only.'}
${a.priorReviewPath ? `- Prior review conversation (existing threads with resolved state + timestamps, author replies, submitted reviews): ${a.priorReviewPath}` : '- No prior review conversation was fetched; treat thread overlap as unknown, not absent.'}
- Raw reviewer findings (JSON, each tagged with its \`lens\`):
\`\`\`json
${JSON.stringify(rawFindings)}
\`\`\`

Urgency: **${a.urgency}** — apply the Mode B urgency rules from your role definition (in hotfix mode posture is binary: do_not_merge if any true critical exists, else merge_ready_with_followups).

Do the Mode B work: dedupe near-duplicates (keep the strongest framing; prefer the security lens on ties); **spot-verify each kept finding's technical claim against the code and strike the ones that are wrong** (a wrong finding at any tier erodes trust) — attack each finding's central factual premise, and treat capability-absence and "fails-because-mechanism-M" claims as hypotheses: **any finding of the form "this will fail at deploy/runtime because <named resource/API/library> behaves like M" must carry a primary-source citation (CLI/SDK/provider source) to survive above \`recommended\`; strike or down-tier uncited mechanism/absence claims**; right-size tier (downgrade as readily as upgrade); verify each inline comment anchors to a real line in the diff (drop hallucinated line numbers); decide posture and reconcile it with the kept critical/important counts; name the cluster if multiple findings share one root-cause fix, else null.

**Reconcile against the prior review conversation** per the Mode B reconciliation step in your role definition. The reviewers saw the diff in isolation, so their findings will overlap threads that already exist. Every overlap needs an explicit disposition — drop as duplicate, leave alone as already-settled, or re-raise while naming the prior thread and the specific point its closure did not address. Check reply timestamps before treating an author rebuttal as responsive, and when a closure rests on "the owner approved this", separate the authority question from the policy question. Silently re-litigating settled ground costs the review standing on its valid findings.

Do NOT apply urgency floors or numeric caps — those are deterministic policy applied later by the renderer. Keep everything that survives right-sizing.

Write the full validated set as JSON to ${a.outDir}/comments.json — that file is your deliverable, read by the renderer. Shape: \`{ urgency, posture, posture_rationale, cluster, inline: [{id, path, line, side, tier, lens, body, evidence, confidence, pre_existing}], general: [{id, path?, line?, tier, lens, body, evidence, confidence, pre_existing}] }\` (set urgency to "${a.urgency}"). Give every finding a stable \`id\` ("f1", "f2", … in the order you write them). Findings a reviewer marked \`anchorable: false\`, or whose line is not in the diff but which are still real, go in \`general\` — do not force them onto a line and do not drop them. \`pre_existing\` findings are kept but never support the posture. ${authorFacingNote.replace('Write \`body\` for the PR author', 'Keep \`body\` for the PR author')} When you merge duplicates or change a tier, say so in \`evidence\`. Then return a summary via the structured-output tool: { posture, posture_rationale, cluster, counts: {critical, important, recommended, nit}, wroteCommentsJson: true }.`

const summary = await agent(criticPrompt, {
  label: `critic:pr-${a.prNumber}`,
  phase: 'Critique',
  agentType: 'critic',
  schema: SUMMARY_SCHEMA,
})


// -- Phase: Verify (independent adversarial pass) --------------------
// The critic already spot-verifies its own findings, and that demonstrably
// leaves refutable legs standing: a retracted mechanism claim plus several
// unqualified absence claims survived a critic pass. A second INDEPENDENT
// pass, seeded with NAMED failure classes to hunt, catches what generic
// "double-check your work" instructions do not. Fail-soft: if the verifier
// dies, the critic's comments.json is still on disk and still renderable.
phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['posture', 'counts'],
  properties: {
    posture: { type: 'string', enum: ['do_not_merge', 'merge_after_fixes', 'merge_ready_with_followups'] },
    posture_rationale: { type: 'string' },
    cluster: { type: ['string', 'null'] },
    counts: {
      type: 'object',
      properties: {
        critical: { type: 'integer' }, important: { type: 'integer' },
        recommended: { type: 'integer' }, nit: { type: 'integer' },
      },
    },
    struck: { type: 'integer', description: 'findings whose central premise was refuted and removed' },
    downTiered: { type: 'integer' },
    strengthened: { type: 'integer' },
    rewroteCommentsJson: { type: 'boolean' },
  },
}

const verifierPrompt = `You are the **adversarial verifier** for PR #${a.prNumber}: ${a.prTitle}. A critic has already deduped, spot-verified, right-sized and finalized a finding set at ${a.outDir}/comments.json.

Your job is to **refute that set** — not to re-review the PR, and not to add findings. Adopt the stance of the PR author who is irritated by a wrong comment and is hunting for the one-line rebuttal that kills it. Anything that survives you should be something you tried and failed to break.

Inputs: ${a.outDir}/comments.json (the finalized set), the brief at ${a.briefPath}, the stated intent at ${a.prBodyPath}, the diff at ${a.diffPath}${a.repoDir ? `, and the checked-out head ref at ${a.repoDir}` : ' (no checkout available — verify against the diff alone)'}.${a.priorReviewPath ? ` Prior review conversation: ${a.priorReviewPath}.` : ''}

**Hunt these three named failure classes first.** Each has already shipped a wrong finding; generic double-checking does not catch them.

1. **Mechanism asserted from documentation or memory rather than from the installed code.** The concrete case this phase exists for: a finding claimed a dependency version bump changed production runtime behavior. The framework vendored its own copy of that dependency and aliased imports to it, so the bump was inert, the claim was false, the author refuted it in one line, and the finding had to be publicly retracted. For every finding resting on how a third-party library behaves, open the **resolved dependency on disk** (installed package source, vendor directory, lockfile-pinned copy) and confirm the behavior *there*. Published docs and the manifest version range are not sufficient evidence. This cuts both ways — reading the installed source sometimes shows a finding is true and **stronger** than stated, which is a \`strengthen\`, not a \`keep\`.
2. **Unqualified claims of absence.** Any finding shaped like "nothing records X", "no marker distinguishes these", "there is no way to do Y", or "every sibling except this one does Z". Run the search yourself; enumerate the directory yourself. Check specifically for machinery that supplies the behavior without appearing in the diff: framework auto-instrumentation, middleware, decorators, base classes, code generation, platform defaults. If the thing exists, strike the finding. If it genuinely doesn't, rewrite the body so it states the search that establishes the absence.
3. **Consequences that were never actually observed.** A finding whose mechanism is real but whose user-visible effect would require a render, a specific device, a live dependency, or a real request — none of which happened. Do **not** strike these merely for being unverified: reframe them as a question with the settling test named, and tier them below findings verified end to end.

For every finding, assign exactly one disposition:
  - **keep** — you attacked the central premise and it held.
  - **strengthen** — true and understated; tighten the claim or raise the tier, citing what you read.
  - **down-tier** — real, but the evidence doesn't support its current tier, or its consequence is unobserved.
  - **strike** — the central premise is refutable. Remove it entirely; a wrong finding at *any* tier erodes trust in the whole review.

Judge each finding on its own evidence, and each leg of a compound finding separately. A plausible-sounding rebuttal is evidence worth checking, not proof of error: some dismissals are simply wrong, and a claim narrowed to what you can actually verify often survives. Do not concede a finding just because it is contestable, and do not defend one just because a peer wrote it.

Then produce the corrected artifact. **Regenerate every derived field from the surviving set; never hand-patch it.** Posture, \`posture_rationale\`, the cluster/through-line, and the per-tier counts are all *computed* from the findings. If you strike or re-tier anything, a posture sentence or through-line that still asserts a withdrawn claim — or a count that no longer matches — is a defect in its own right, and re-editing it in place is how those go stale.

1. Preserve the critic's set for audit: \`cp ${a.outDir}/comments.json ${a.outDir}/comments.pre-verify.json\`
2. Write the corrected set to ${a.outDir}/comments.json, same shape as the critic's: \`{ urgency, posture, posture_rationale, cluster, inline: [...], general: [...] }\`, with urgency set to "${a.urgency}". Keep each surviving finding's \`id\`. Record what you did to a finding (strengthened from the installed source, down-tiered because the consequence is unobserved) in its \`evidence\`, never in \`body\`. Re-derive posture, rationale, cluster and counts from what survived — \`pre_existing\` findings never support the posture — do not copy them forward from the critic.
3. Return via the structured-output tool: { posture, posture_rationale, cluster, counts: {critical, important, recommended, nit}, struck, downTiered, strengthened, rewroteCommentsJson: true }.
${hotfix ? '\n**Urgency is hotfix** — only criticals are in play. Be fast, but go deep on those: a false critical is the single most expensive finding this flow can ship.' : ''}`

const verified = await agent(verifierPrompt, {
  label: `verify:pr-${a.prNumber}`,
  phase: 'Verify',
  agentType: 'critic',
  schema: VERIFY_SCHEMA,
}).catch((e) => {
  log(`adversarial verify failed (${(e && e.message) || e}); keeping the critic's set`)
  return null
})

if (verified) {
  log(`verify: struck ${verified.struck || 0}, down-tiered ${verified.downTiered || 0}, strengthened ${verified.strengthened || 0}`)
}

// The verifier's set supersedes the critic's when it ran; otherwise fall back.
const finalSummary = verified || summary

// Collect the side jobs (already running since before the reviewers finished).
const sideResults = sidePromise ? (await sidePromise).filter(Boolean) : []
const orientation = sideResults.find((r) => r.kind === 'orientation') || null
const diagrams = sideResults.find((r) => r.kind === 'diagrams') || null

return {
  // critic wrote <outDir>/comments.json; the verifier rewrote it in place from
  // the surviving set (critic's original preserved as comments.pre-verify.json).
  // The conversation just renders whatever is there now.
  commentsPath: `${a.outDir}/comments.json`,
  wroteCommentsJson: summary ? summary.wroteCommentsJson === true : false,
  orientationMd: orientation ? orientation.md : null,
  diagramsStatus: diagrams ? diagrams.status : 'skipped (hotfix)',
  postCritic: summary ? summary.posture : null,
  postVerify: verified ? verified.posture : null,
  verify: verified
    ? { struck: verified.struck || 0, downTiered: verified.downTiered || 0, strengthened: verified.strengthened || 0 }
    : null,
  // Derived fields come from the LAST pass that owned the finding set.
  cluster: finalSummary ? finalSummary.cluster : null,
  counts: (finalSummary && finalSummary.counts) || { critical: 0, important: 0, recommended: 0, nit: 0 },
  lensesRun: lensResults.map((l) => l.lens),
  // Unfiltered reviewer output, for the host to persist to out/findings/ —
  // the only record of what the critic and verifier removed.
  rawFindings: lensResults,
}

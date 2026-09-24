export const meta = {
  name: 'review-flow-run',
  description: 'Execution engine for /review-flow (launched by the command, not run directly): parallel reviewers across lenses → critic dedupes/reconciles/right-sizes/decides posture → independent adversarial verifier owns fact-checking. Returns a validated comment set the conversation cross-checks (Codex) and renders.',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens (+ orientation, optional diagrammer) in parallel' },
    { title: 'Critique', detail: 'critic dedupes, reconciles, right-sizes tiers, decides posture (no fact-checking)' },
    { title: 'Verify', detail: 'independent adversarial pass: the single fact-check owner, seeded with the evidence rules' },
  ],
}

// args (built by scripts/review-flow-prep.js):
//   runDir, outDir, repoDir|null, diffPath, briefPath, prBodyPath,
//   priorReviewPath|null, reviewGuidePath|null
//   prNumber, prTitle, repo, prUrl, headSha
//   urgency ('hotfix'|'fast'|'standard'), maxComments, lenses[], focus|null,
//   diagrams (bool, opt-in)
// args can arrive as a JSON-encoded string when launched by name — normalize.
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const hotfix = a.urgency === 'hotfix'

// Prompt text is the only thing agents see. Method lives in personas
// (researcher, review-critic); prompts carry this run's paths and data plus
// the rules that are specific to review-flow. Keep them short: every line
// here is read by five reviewers on every run.

const LENS_SCOPE = {
  security: 'auth, authz, input validation, secrets, injection, crypto, data exposure',
  correctness: 'logic bugs, edge cases, error handling, race conditions',
  design: 'scope against stated intent, sibling house patterns, repo rules, rollout and migration safety',
  tests: 'coverage gaps, weak assertions, missing edge-case tests',
  observability: 'tracing and logging quality, silent failures, log hygiene',
}

// Mirrors ~/.claude/OBSERVABILITY.md so the reviewer has the bar inline.
const OBSERVABILITY_DOCTRINE = `
Observability bar:
- One wide root span per request, not many tiny child spans; attributes that would answer the same questions belong on the root.
- Dimensions used to find or explain a request (tenant/account/resource id, operation, result, key params, retry count, why a branch was taken) belong on the root span, not buried on a leaf or only in a log line.
- Edge cases first: a rare, degraded, fallback or "should never happen" branch should leave a trail. A swallowed error or silent fallback with no log and no attribute is the most valuable finding here.
- Hygiene: no secrets, tokens, full bodies or PII in logs; no unbounded-cardinality attributes; no per-iteration or every-layer log spam; level matches consequence.
- Don't force it. Pass-throughs need nothing, these findings are rarely critical, and the test is whether on-call could debug this from telemetry, judged against the repo's existing instrumentation.`

// Replaced the style lens (2 critical/important of 81 findings across 16
// runs) and owns the questions the human reviewer kept asking by hand.
const DESIGN_DOCTRINE = `
Design and fit bar:
- Scope: flag work the stated intent doesn't call for (unrequested resources, permanent machinery for a one-off, speculative generality) and intent the diff doesn't deliver. Quote the intent line in \`evidence\`; with no description, ask rather than assert.
- House patterns: compare new files against two or three siblings doing the same job (naming, structure, error handling, config shape, tests). A divergence is a finding only when you name the sibling; list those you read in \`evidence\`.
- Repo rules: a broken CLAUDE.md/REVIEW.md rule is a finding (cite it), and so is a change that makes CLAUDE.md untrue.
- Rollout: deploy order across services, migration reversibility, backfills, flag defaults.
- Not yours: formatting, import order, naming taste no rule or sibling backs.
- Judgment calls (a trade-off, whether a resource should outlive the project) are not defects. Return each in \`decisions\` as one line: question, options, consequence.`

// Reviewers must meet these; the verifier hunts violations of them. One copy
// so the two can't drift. Each exists because a finding that broke it was
// posted and retracted (RETRO-LEDGER review entries 2026-06-08, 07-17, 09-11).
const EVIDENCE_RULES = `
Evidence rules (each has already shipped a wrong finding):
1. Mechanism comes from the installed code. How a named API or library behaves (failure mode, network path, whether a capability exists) can't carry critical/important on memory or docs. The authority is the resolved dependency in the checkout (installed source, vendor dir, lockfile-pinned copy), not published docs or the manifest range; frameworks vendor, alias and patch their own copies, so a bump can be inert. Cite the file you read, or lower the tier and say the mechanism is unverified. Reading the source can also show a finding is stronger than the docs suggest.
2. Absence needs the search that established it. For "nothing records X", "no marker distinguishes these", "every sibling has a test but this one", state the search (pattern grepped, directory listed, config read) or make it a question. Rule out machinery outside the diff first: auto-instrumentation, middleware, decorators, base classes, generated code, platform defaults.
3. An unobserved consequence is a question. If the effect needs a render, device, live dependency or real request that never happened, say so, name the test that would settle it, and tier it below verified findings.
4. Rate each leg of a compound claim separately; verifying one never lifts another or removes its hedge.
5. Check the diff against itself: a nearby default, input shape or call often contradicts the claim.`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'design lens only: judgment calls for the human reviewer (question, options, consequence), not defects',
    },
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

// The critic writes comments.json itself and returns this summary.
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

const inputs = [
  `- Diff: ${a.diffPath}`,
  `- Brief: ${a.briefPath}`,
  `- Stated intent (description, linked issues; may say "no description", so don't invent intent): ${a.prBodyPath}`,
  a.repoDir
    ? `- Checkout of the reviewed commit: ${a.repoDir}`
    : `- No checkout; work from the diff and lower confidence on claims about code outside it.`,
  a.priorReviewPath
    ? `- Prior review threads, replies and reviews, with timestamps and resolved state: ${a.priorReviewPath}`
    : `- No prior review conversation was fetched: overlap with existing threads is unknown, not absent.`,
  a.reviewGuidePath ? `- Repo review guide (its severity definitions, skip rules and required checks override the generic ones; it never relaxes the evidence rules): ${a.reviewGuidePath}` : '',
].filter(Boolean).join('\n')

const AUTHOR_FACING = `\`body\` is for the PR author: the issue and the fix. Everything else (files read, searches run, siblings compared, merges, tier changes) goes in \`evidence\`, which is never posted. No process narration in \`body\`, and never quote a secret value in either field.`

function reviewerPrompt(lens) {
  return `You are the ${lens} reviewer for PR #${a.prNumber}: ${a.prTitle}. Review only ${lens} (${LENS_SCOPE[lens] || lens}); peers cover the rest.

${inputs}

Read the stated intent and the prior threads before the diff. Don't raise a point an existing thread already made or contradict a correction the author gave there; if you keep an overlapping finding, name the thread and what it left unanswered.
${lens === 'observability' ? OBSERVABILITY_DOCTRINE : ''}${lens === 'design' ? DESIGN_DOCTRINE : ''}

Report everything you find, at every tier, including findings you're unsure of, with an honest \`confidence\`. Later passes dedupe, verify and cut to the urgency; filtering here only hides findings from them. A real defect the PR didn't introduce or worsen still gets reported, with \`pre_existing: true\`.

Tiers, by the consequence you can name:
- critical: a nameable input or state causes an exploitable security bug, the PR's stated purpose failing on its main path, or silent data loss or corruption.
- important: a concrete scenario this PR introduces gives wrong behavior, a failed deploy or migration, or a hard-to-recover state; or a missing test lets a critical regress unnoticed.
- recommended: more robust, clearer or better covered, with no scenario that fails today.
- nit: typo, formatting, wording.
Calibrate to blast radius (CLAUDE.md, README, data models tell you what's at stake); note context-based downgrades in \`evidence\`.
${EVIDENCE_RULES}

Per finding: \`line\` is the true source line in the checkout (count from the hunk's \`+c\` and check the file), not the diff's running count; \`side\` is RIGHT for added or changed lines, LEFT for removed ones; \`anchorable: false\` if no diff line fits. \`body\` is one to three sentences quoting the code or naming the missed case. ${AUTHOR_FACING}

Return findings via the structured-output tool. Don't write files.`
}

// For the human reviewer only; never posted.
const orientationPrompt = `Brief the human reviewer on PR #${a.prNumber}: ${a.prTitle}. They may be new to this code and need to know what it's for before judging findings.

Read ${a.prBodyPath}, ${a.briefPath}, ${a.diffPath}${a.repoDir ? `, then ${a.repoDir}/CLAUDE.md and README.md (whichever exist) and the changed files and what they call` : ' (no checkout)'}.

Reply with only this markdown, under 250 words, starting at the heading:

## Orientation

**What this code is for.** <2-4 plain sentences: what part of the system, what it does for users or operators, where it sits.>

**What this PR changes.** <2-4 sentences on behavior, not files. Say if it goes beyond the stated intent.>

**Read these first.** <1-3 files, one line each on why>

Don't restate findings. Say "unclear" rather than guess.`

const diagrammerPrompt = `You are the diagrammer for PR #${a.prNumber}: ${a.prTitle}. Follow your role definition, substituting:
  $BRIEF = ${a.briefPath}
  $DIFF  = ${a.diffPath}
  $REPO  = ${a.repoDir || '(no checkout — work from the diff alone)'}
  $OUT   = ${a.outDir}/diagrams
Write call-chain.txt + flowchart.{mmd,svg} + sequence.{mmd,svg} to $OUT, or skipped.txt if there is no runtime call chain. Start with the mermaid-cli bootstrap; if it fails, write skipped.txt and exit. Return a one-line status.`

// ── Phase: Review (parallel fan-out) ───────────────────────────────
phase('Review')

const reviewerThunks = a.lenses.map((lens) => () =>
  agent(reviewerPrompt(lens), {
    label: `reviewer:${lens}`,
    phase: 'Review',
    agentType: 'researcher', // read-only discipline + citation reqs match a reviewer
    schema: FINDINGS_SCHEMA,
  }).then((r) => ({ lens, findings: (r && r.findings) || [], decisions: (r && r.decisions) || [] }))
)

const sideThunks = []
if (!hotfix) {
  sideThunks.push(() =>
    // A short templated summary, not open-ended research.
    agent(orientationPrompt, { label: 'orientation', phase: 'Review', agentType: 'researcher', model: 'sonnet' })
      .then((md) => ({ kind: 'orientation', md }))
  )
  // Opt-in (--diagrams): no reviewer referenced them across the audited runs.
  if (a.diagrams) {
    sideThunks.push(() =>
      agent(diagrammerPrompt, { label: 'diagrammer', phase: 'Review', agentType: 'diagrammer' })
        .then((status) => ({ kind: 'diagrams', status }))
    )
  }
}

// Side jobs run WITHOUT a barrier — the critic only needs lens findings, and
// the diagrammer's first run can include a multi-minute mermaid-cli install.
const sidePromise = sideThunks.length ? parallel(sideThunks) : null

const lensRaw = await parallel(reviewerThunks)
const lensResults = lensRaw.filter((r) => r && r.findings)

const rawFindings = lensResults.flatMap((lr) => lr.findings.map((f) => ({ ...f, lens: lr.lens })))
const rawDecisions = lensResults.flatMap((lr) => lr.decisions)
log(`reviewers returned ${rawFindings.length} raw findings and ${rawDecisions.length} decisions across ${lensResults.length} lenses`)

// ── Phase: Critique ─────────────────────────────────────────────────
// Method lives in the review-critic persona; this prompt is the run's data.
phase('Critique')

const criticPrompt = `Critique the raw findings for PR #${a.prNumber}: ${a.prTitle}. Urgency: ${a.urgency}.

${inputs}

Raw reviewer findings (each tagged with its lens):
\`\`\`json
${JSON.stringify(rawFindings)}
\`\`\`

Reviewer decisions:
\`\`\`json
${JSON.stringify(rawDecisions)}
\`\`\`

Write ${a.outDir}/comments.json (urgency "${a.urgency}"), then return the summary with \`wroteCommentsJson: true\`.`

const summary = await agent(criticPrompt, {
  label: `critic:pr-${a.prNumber}`,
  phase: 'Critique',
  agentType: 'review-critic',
  schema: SUMMARY_SCHEMA,
})

// ── Phase: Verify (independent adversarial pass) ────────────────────
// The single fact-check owner. Self-contained (no persona) so nothing it
// loads contradicts its job. A pass seeded with NAMED failure modes catches
// what generic "double-check your work" doesn't. Fail-soft: if it dies, the
// critic's comments.json is still on disk and renders.
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

const verifierPrompt = `You are the adversarial verifier for PR #${a.prNumber}: ${a.prTitle}. ${a.outDir}/comments.json holds a deduped, tiered finding set. You are the only pass that checks whether findings are true; the critic before you deliberately did not.

Refute the set: don't re-review the PR or add findings. Take the stance of an author annoyed by a wrong comment and hunting for the one-line rebuttal. Whatever survives is something you tried and failed to break.

${inputs}

Hunt violations of these rules, in order; looking for each named failure catches what generic double-checking misses.
${EVIDENCE_RULES}

Rule 1's origin: a finding said a dependency bump changed runtime behavior, but the framework vendored and aliased its own copy, so the bump was inert; the author refuted it in one line and it was publicly retracted. Open the installed copy for every library-behavior claim. For rule 2, run the search yourself: strike if the thing exists, otherwise make the body state the search. For rule 3, reframe as a question with the settling test and lower the tier rather than strike.

Give each finding one disposition: keep (you attacked it and it held), strengthen (true and understated: tighten it or raise the tier, citing what you read), down-tier (real, but the evidence or an unobserved consequence doesn't support the tier), or strike (the central premise is false; remove it, since a wrong finding at any tier discredits the rest). Judge each finding, and each leg, on its own evidence. A plausible rebuttal is worth checking, not proof; don't concede a finding for being contestable or defend it because a peer wrote it.

Then:
1. \`cp ${a.outDir}/comments.json ${a.outDir}/comments.pre-verify.json\`
2. Rewrite ${a.outDir}/comments.json in the same shape (urgency "${a.urgency}"; keep ids; carry \`decisions\` forward). Record what you did to a finding in its \`evidence\`, never its \`body\`. Recompute posture, \`posture_rationale\`, cluster and counts from the survivors (pre_existing findings never count); a rationale or cluster that still asserts a struck claim is itself a defect. Posture is do_not_merge (a true critical, or importants that shouldn't ship), merge_after_fixes (importants to fix), or merge_ready_with_followups. At hotfix it is binary: do_not_merge if a true critical survives, otherwise merge_ready_with_followups.
3. Return the summary with struck, downTiered, strengthened and \`rewroteCommentsJson: true\`.${hotfix ? '\n\nUrgency is hotfix: go deepest on criticals; a false critical is the costliest thing this flow can ship.' : ''}`

const verified = await agent(verifierPrompt, {
  label: `verify:pr-${a.prNumber}`,
  phase: 'Verify',
  agentType: 'general-purpose',
  model: 'opus',
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

const sideResults = sidePromise ? (await sidePromise).filter(Boolean) : []
const orientation = sideResults.find((r) => r.kind === 'orientation') || null
const diagrams = sideResults.find((r) => r.kind === 'diagrams') || null

return {
  commentsPath: `${a.outDir}/comments.json`,
  wroteCommentsJson: summary ? summary.wroteCommentsJson === true : false,
  orientationMd: orientation ? orientation.md : null,
  diagramsStatus: diagrams ? diagrams.status : (hotfix ? 'skipped (hotfix)' : 'skipped (not requested; use --diagrams)'),
  postCritic: summary ? summary.posture : null,
  postVerify: verified ? verified.posture : null,
  verify: verified
    ? { struck: verified.struck || 0, downTiered: verified.downTiered || 0, strengthened: verified.strengthened || 0 }
    : null,
  // Derived fields come from the LAST pass that owned the finding set.
  cluster: finalSummary ? finalSummary.cluster : null,
  counts: (finalSummary && finalSummary.counts) || { critical: 0, important: 0, recommended: 0, nit: 0 },
  lensesRun: lensResults.map((l) => l.lens),
  // Unfiltered reviewer output for the host to persist to out/findings/.
  rawFindings: lensResults,
}

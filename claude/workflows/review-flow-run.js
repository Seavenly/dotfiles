export const meta = {
  name: 'review-flow-run',
  description: 'Execution engine for /review-flow (launched by the command, not run directly): parallel reviewers across lenses → critic dedupes/right-sizes/anchors/decides posture. Returns a validated comment set the conversation renders into review.md/.html.',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens (+ orientation, diagrammer) in parallel' },
    { title: 'Critique', detail: 'critic dedupes, verifies, right-sizes tiers, decides posture' },
  ],
}

// args (built by the host command before launch):
//   runDir, outDir, repoDir|null, diffPath, briefPath
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
          body: { type: 'string' },
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

function reviewerPrompt(lens) {
  return `You are the **${lens}** reviewer for PR #${a.prNumber}: ${a.prTitle}.
Read the full PR diff at ${a.diffPath}. Read the brief at ${a.briefPath}.
${repoNote}

Enumerate findings for the **${lens}** dimension only (${LENS_SCOPE[lens]}). Do not produce findings outside your lens — those belong to peers.
${lens === 'observability' ? OBSERVABILITY_DOCTRINE : ''}

**Urgency: ${a.urgency}.** This caps what you produce:
  - hotfix — merging ASAP. Only emit \`critical\` findings: things that ship a CVE-class bug, break the PR's documented happy path, or cause silent data loss. Do not produce important/recommended/nit. A hotfix review with zero findings is a valid output.
  - fast — emit \`critical\` and \`important\` only. Skip recommended and nit. Do enough surrounding-code research to confirm importants, but don't chase polish.
  - standard — emit all four tiers. Use surrounding code freely.

Within the tiers you're allowed to emit, be high-recall — list anything worth flagging. The critic will dedupe and right-size.

**Tier rubric — apply strictly.** Reviewers tend to inflate; the protected-tier rule is a floor on signal, not an escalator.
  - critical: ships a CVE-class security bug, breaks the PR's own documented happy path, or causes silent data loss/corruption. Would block merge in any reasonable team. If in doubt, it's not critical.
  - important: a real issue that should be fixed before merge — missing check on changed code, broken edge case the PR introduces, a test gap that lets a critical regress silently. NOT a catch-all for "things I'd improve."
  - recommended: worth doing — refactor, hardening, naming, additional coverage, defensive polish. Would not block merge. Most "I'd write this differently" findings live here.
  - nit: typo, formatting, single-word naming, doc-comment wording.

**Calibrate to project blast radius.** Use what the repo tells you about what this app does and who its users are (CLAUDE.md, README, routes, data models). The same OAuth gap is "critical" in a payments backend and "recommended" on a marketing waitlist. If you downgrade severity because of context, say so in the finding body.

For each finding:
  - path: file path
  - line: the **true source-file line number** in the checked-out repo (post-change side unless commenting on a removal) — NOT the running line count inside the diff text. Read the hunk's \`@@ -a,b +c,d @@\` header and count from \`c\`, and verify against the actual file before reporting.
  - side: RIGHT (added/modified) or LEFT (removed)
  - tier: your initial read; the critic may recategorize (most often downgrade)
  - body: one to three sentences. Quote the offending code or describe the missed case.
  - anchorable: true if you have a real file:line from the diff; false for meta/structural comments with no specific anchor.

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
- Full PR diff: ${a.diffPath}
${a.repoDir ? `- Checked-out head ref for verification: ${a.repoDir}` : '- No checkout available; verify against the diff only.'}
- Raw reviewer findings (JSON, each tagged with its \`lens\`):
\`\`\`json
${JSON.stringify(rawFindings)}
\`\`\`

Urgency: **${a.urgency}** — apply the Mode B urgency rules from your role definition (in hotfix mode posture is binary: do_not_merge if any true critical exists, else merge_ready_with_followups).

Do the Mode B work: dedupe near-duplicates (keep the strongest framing; prefer the security lens on ties); **spot-verify each kept finding's technical claim against the code and strike the ones that are wrong** (a wrong finding at any tier erodes trust); right-size tier (downgrade as readily as upgrade); verify each inline comment anchors to a real line in the diff (drop hallucinated line numbers); decide posture and reconcile it with the kept critical/important counts; name the cluster if multiple findings share one root-cause fix, else null.

Do NOT apply urgency floors or numeric caps — those are deterministic policy applied later by the renderer. Keep everything that survives right-sizing.

Write the full validated set as JSON to ${a.outDir}/comments.json — that file is your deliverable, read by the renderer. Shape: \`{ urgency, posture, posture_rationale, cluster, inline: [{path, line, side, tier, lens, body}] }\` (set urgency to "${a.urgency}"). Then return a summary via the structured-output tool: { posture, posture_rationale, cluster, counts: {critical, important, recommended, nit}, wroteCommentsJson: true }.`

const summary = await agent(criticPrompt, {
  label: `critic:pr-${a.prNumber}`,
  phase: 'Critique',
  agentType: 'critic',
  schema: SUMMARY_SCHEMA,
})

// Collect the side jobs (already running since before the reviewers finished).
const sideResults = sidePromise ? (await sidePromise).filter(Boolean) : []
const orientation = sideResults.find((r) => r.kind === 'orientation') || null
const diagrams = sideResults.find((r) => r.kind === 'diagrams') || null

return {
  // critic wrote <outDir>/comments.json itself; the conversation just renders.
  commentsPath: `${a.outDir}/comments.json`,
  wroteCommentsJson: summary ? summary.wroteCommentsJson === true : false,
  orientationMd: orientation ? orientation.md : null,
  diagramsStatus: diagrams ? diagrams.status : 'skipped (hotfix)',
  postCritic: summary ? summary.posture : null,
  cluster: summary ? summary.cluster : null,
  counts: (summary && summary.counts) || { critical: 0, important: 0, recommended: 0, nit: 0 },
  lensesRun: lensResults.map((l) => l.lens),
}

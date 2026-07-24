export const meta = {
  name: 'feature-flow-run',
  description: 'Execution engine for /feature-flow (launched by the command): planner → per-slice test-or-verify inner loop → completeness gate (each acceptance criterion mapped to evidence) → critic outer pass with revision loop → synthesizer PR body. Supports the --gated split via planOnly.',
  phases: [
    { title: 'Plan', detail: 'planner decomposes the brief into vertical slices' },
    { title: 'Implement', detail: 'per-slice behavior testing or command verification via the tdd-slice-loop sub-workflow' },
    { title: 'Completeness', detail: 'completeness-critic maps each acceptance criterion to evidence; uncovered ones retain their test or verify strategy' },
    { title: 'Critique', detail: 'critic reviews the final diff; revision loop' },
    { title: 'Synthesize', detail: 'synthesizer writes the PR body' },
  ],
}

// args (built by the host command before launch):
//   runDir, outDir, repo, worktree, base, briefPath, slug, testCmd|null
//   verifyCmds|null — approved gate commands (e.g. `pulumi preview`); the primary gate for verify-mode slices
//   maxSliceRetries, maxCriticRevisions, acceptance[]
//   planOnly (bool — gated step 1 stops after planning)
//   slices (array|null — gated step 2 passes the approved slices to skip planning)
// args can arrive as a JSON-encoded string when launched by name — normalize.
const a = typeof args === 'string' ? JSON.parse(args) : args
const inWorktree = `Work in the worktree at ${a.worktree} — cd there for all commands, reads, and writes. Never switch branches. Treat the run journal shown inline below as the authoritative notes, and return structured output where this prompt asks for it instead of writing a verdict/handoff file.`
// Guard against a stray agent that didn't cd: confirm we're in the worktree before any commit.
const wtGuard = `Before staging or committing, confirm \`git -C "${a.worktree}" rev-parse --show-toplevel\` resolves to ${a.worktree}; run all git from \`-C "${a.worktree}"\` so you never touch another checkout. If it doesn't resolve there, do NOT commit — set committed=false and say so in output.`

const PLAN_SCHEMA = {
  type: 'object', required: ['slices'],
  properties: {
    slices: { type: 'array', items: {
      type: 'object', required: ['title', 'behavior', 'verificationMode', 'verificationReason'],
      properties: {
        title: { type: 'string' },
        behavior: { type: 'string' },
        verificationMode: { type: 'string', enum: ['test', 'verify'], description: 'test when a stable behavioral seam supports red-green TDD; verify for declarative infra/config/docs' },
        testIdea: { type: 'string', description: 'required by the planner only for test mode' },
        verificationIdea: { type: 'string', description: 'required by the planner only for verify mode' },
        verificationReason: { type: 'string', description: 'why this mode fits the slice and what stable seam or artifact is being checked' },
        files: { type: 'string' },
        dependsOn: { type: 'string' },
        nonTestable: { type: 'boolean', description: 'deprecated compatibility alias for verificationMode=verify' },
      },
    } },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
}
const GATE_SCHEMA = {
  type: 'object', required: ['passed'],
  properties: { passed: { type: 'boolean' }, output: { type: 'string' }, committed: { type: 'boolean' } },
}
const COMPLETENESS_SCHEMA = {
  type: 'object', required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['COMPLETE', 'GAPS'] },
    coverageMap: { type: 'array', items: { type: 'string' }, description: 'one line per acceptance criterion: covered | partial | uncovered + evidence' },
    gaps: { type: 'array', items: {
      type: 'object', required: ['criterion', 'behavior', 'verificationMode', 'verificationReason'],
      properties: {
        criterion: { type: 'string' },
        status: { type: 'string', enum: ['partial', 'uncovered'] },
        blocksMerge: { type: 'boolean' },
        behavior: { type: 'string' },
        testIdea: { type: 'string' },
        verificationIdea: { type: 'string' },
        verificationMode: { type: 'string', enum: ['test', 'verify'] },
        verificationReason: { type: 'string' },
        evidence: { type: 'string' },
        fixDirection: { type: 'string' },
      },
    } },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'FIX_LIST', 'RE_PLAN'] },
    note: { type: 'string' },
    reason: { type: 'string', description: 'for RE_PLAN' },
    items: { type: 'array', items: {
      type: 'object', required: ['behavior', 'verificationMode', 'verificationReason'],
      properties: {
        severity: { type: 'string', enum: ['critical', 'important'] },
        blocksMerge: { type: 'boolean' },
        behavior: { type: 'string' },
        evidence: { type: 'string' },
        testIdea: { type: 'string' },
        verificationIdea: { type: 'string' },
        verificationMode: { type: 'string', enum: ['test', 'verify'] },
        verificationReason: { type: 'string' },
        fixDirection: { type: 'string' },
        nonTestable: { type: 'boolean', description: 'deprecated compatibility alias for verificationMode=verify' },
      },
    } },
  },
}

// The run journal lives as a list of entry blocks; the tdd-slice-loop
// sub-workflow folds handoffs in and shows inner-loop prompts a capped view.
// The critic and synthesizer get the full journal (they run a handful of
// times, not per-slice), and the synthesizer persists it to out/notes.md.
const notesHeader = `# Running notes — ${a.slug}\nAcceptance: ${(a.acceptance || []).join('; ') || '(see brief)'}`
let noteEntries = []
function fullNotes() { return `${notesHeader}\n${noteEntries.join('\n')}` }

const E2E_NOTE = `This is the FINAL slice — your test must exercise the feature's primary user-facing path end-to-end through the real assembled wiring (not a hand-built subset), and fail under the wrong wiring.`

async function runSliceLoop(slices, phaseLabel, finalSliceNote) {
  try {
    const r = await workflow('tdd-slice-loop', {
      worktree: a.worktree, briefPath: a.briefPath, planPath: `${a.outDir}/plan.md`,
      slug: a.slug, testCmd: a.testCmd, verifyCmds: a.verifyCmds || null, maxSliceRetries: a.maxSliceRetries,
      slices, finalSliceNote, scopeNote: null, phaseLabel,
      notesHeader, noteEntries,
    })
    if (r && r.noteEntries) noteEntries = r.noteEntries
    return (r && r.stuck) || []
  } catch (e) {
    // workflow() throws only on launch failure (unknown name / syntax error),
    // i.e. before any slice ran.
    log(`tdd-slice-loop failed to launch: ${e && e.message ? e.message : e}`)
    return slices.map((s) => ({ slice: s.title, reason: 'tdd-slice-loop sub-workflow failed to launch' }))
  }
}

// ── Phase: Plan ────────────────────────────────────────────────────
let slices = a.slices || null
if (!slices) {
  phase('Plan')
  const plan = await agent(
    `${inWorktree}\nRead the brief at ${a.briefPath}. Produce a vertical-slice plan in dependency order, as thin as possible. For each slice choose verificationMode=test only when there is a stable behavioral seam that can fail for the intended reason; choose verificationMode=verify for declarative infrastructure, configuration, documentation, or any slice where a test would merely inspect the shipped artifact. Never manufacture a test to satisfy the workflow. Include testIdea for test mode or verificationIdea for verify mode, plus verificationReason. Write the human-readable plan to ${a.outDir}/plan.md (and an acceptance summary). Follow the planner role exactly. Also return the slices via the structured-output tool.`,
    { label: 'planner', phase: 'Plan', agentType: 'planner', schema: PLAN_SCHEMA }
  )
  slices = (plan && plan.slices) || []
  if (a.planOnly) {
    return { planned: true, slices, planPath: `${a.outDir}/plan.md`, outOfScope: (plan && plan.outOfScope) || [] }
  }
}
if (!slices.length) return { error: 'no slices produced', branch: a.worktree }

// ── Phase: Implement (sequential same-file test-or-verify work) ──
phase('Implement')
const stuck = []
stuck.push(...await runSliceLoop(slices, 'Implement', E2E_NOTE))

// Ensure everything is committed before the critic diffs base...HEAD.
await agent(
  `Stage and commit any outstanding changes in the worktree at ${a.worktree} as a single additive commit (never --amend/--force). If nothing is uncommitted, do nothing. ${wtGuard} Return {passed:true}.`,
  { label: 'commit-all', phase: 'Implement', schema: GATE_SCHEMA, model: 'sonnet' }
)

let revisions = 0
let deferred = []  // non-blocking findings carried to the PR body as follow-ups
let remaining = [] // merge-blocking findings left unresolved at the revision cap
let criticVerdictMissing = false

// ── Phase: Completeness (coverage gate, before design critique) ────
// The design critic (next phase) judges whether what's there is good.
// This pass asks the opposite question — did every acceptance criterion
// the brief promised actually arrive? That gap survives a green suite and
// a clean design review because the run journal only records what the team
// chose to write down: a criterion no slice ever touched leaves no trace.
// Uncovered criteria route back through their declared test-or-verify loop
// (one fix pass), then a
// single re-check; anything still uncovered is surfaced, not looped again.
phase('Completeness')
let uncoveredAcceptance = []
function completenessPrompt() {
  const acc = a.acceptance || []
  const accNote = acc.length
    ? `Acceptance criteria for this run:\n${acc.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : 'Acceptance criteria: see the brief.'
  return `${inWorktree}\nYou are the feature-flow completeness-critic for run ${a.slug}. Read the brief at ${a.briefPath} and the plan at ${a.outDir}/plan.md (honor its outOfScope list — a deferred criterion is not a gap). Run \`git diff ${a.base}...HEAD\` for the final diff (base is ${a.base} — NOT necessarily main).\n${accNote}\nFor EACH acceptance criterion, find concrete evidence in the diff that it's satisfied — a test whose assertion actually covers it (read the assertion, don't trust the test name), or a diff location implementing it. Criteria with no evidence are gaps. Return your verdict via structured output. Do NOT run the full suite; do NOT request inner-loop transcripts.`
}
if ((a.acceptance || []).length) {
  const cov = await agent(completenessPrompt(), { label: 'completeness', phase: 'Completeness', agentType: 'completeness-critic', schema: COMPLETENESS_SCHEMA })
  const gaps = (cov && cov.verdict === 'GAPS' && cov.gaps) || []
  if (gaps.length) {
    // A gap blocks unless the critic explicitly marked it non-blocking (a partial whose happy path works).
    const blockingGaps = gaps.filter((g) => g.blocksMerge !== false)
    // Non-blocking gaps ride along to the PR body as deferred follow-ups.
    for (const g of gaps) {
      const behavior = g.behavior || g.criterion
      if (g.blocksMerge === false && !deferred.some((d) => d.behavior === behavior)) {
        deferred.push({ behavior, evidence: g.evidence, severity: 'important', verificationMode: g.verificationMode || 'test' })
      }
    }
    if (blockingGaps.length) {
      log(`completeness: ${blockingGaps.length} uncovered acceptance criterion/criteria — routing through the declared test-or-verify loop`)
      const gapSlices = blockingGaps.map((g) => ({
        title: `cover: ${g.behavior || g.criterion}`, behavior: g.behavior || g.criterion,
        testIdea: g.testIdea, verificationIdea: g.verificationIdea,
        verificationMode: g.verificationMode || (g.nonTestable ? 'verify' : 'test'),
        verificationReason: g.verificationReason,
        fixDirection: g.fixDirection, evidence: g.evidence,
      }))
      stuck.push(...await runSliceLoop(gapSlices, 'Completeness', null))
      // Re-commit anything the fix pass left staged so the re-check and design critic see it.
      await agent(
        `Stage and commit any outstanding changes in the worktree at ${a.worktree} as a single additive commit (never --amend/--force). If nothing is uncommitted, do nothing. ${wtGuard} Return {passed:true}.`,
        { label: 'commit-completeness', phase: 'Completeness', schema: GATE_SCHEMA, model: 'sonnet' }
      )
      const recheck = await agent(completenessPrompt(), { label: 'completeness:recheck', phase: 'Completeness', agentType: 'completeness-critic', schema: COMPLETENESS_SCHEMA })
      if (recheck && recheck.verdict === 'GAPS') {
        uncoveredAcceptance = (recheck.gaps || []).filter((g) => g.blocksMerge !== false)
        if (uncoveredAcceptance.length) log(`completeness: ${uncoveredAcceptance.length} criterion/criteria still uncovered after one fix pass — surfacing to the PR body`)
      }
    }
  }
}

// ── Phase: Critique (outer pass, revision loop) ────────────────────
phase('Critique')
function criticPrompt() {
  const deferredNote = deferred.length
    ? `\nAlready recorded as non-blocking follow-ups for the PR body (do not re-litigate; only re-raise one if you now judge it merge-blocking): ${deferred.map((d) => d.behavior).join(' · ')}`
    : ''
  const verifyNote = (a.verifyCmds && a.verifyCmds.length)
    ? `\nVerification commands for this run: ${a.verifyCmds.map((c) => `\`${c}\``).join(', ')} — run them in the worktree and weigh their output in your review (an infra plan/preview reveals blast radius the diff alone hides; flag unexpected replaces/deletes as findings).`
    : ''
  return `${inWorktree}\nYou are the feature-flow critic for run ${a.slug}. Operate in Mode A per your role definition. Read the brief at ${a.briefPath} and the plan at ${a.outDir}/plan.md. Run \`git diff ${a.base}...HEAD\` for the final diff (base is ${a.base} — NOT necessarily main).${verifyNote} The lead-curated run journal:\n${fullNotes()}${deferredNote}\nReview design quality, edge cases the tests miss, security/perf smells (the security lens auto-engages for infra-touching diffs), observability (per your role's observability pass — wide root span, debugging dimensions on the root span, a trail on tricky-to-debug edge branches; flag silent catches), and anything the journal admits was left undone. Shape FIX_LIST items as testable slices. Return your verdict via structured output. Do NOT request inner-loop transcripts.`
}
while (true) {
  let v = await agent(criticPrompt(), { label: `critic:rev${revisions}`, phase: 'Critique', agentType: 'critic', schema: VERDICT_SCHEMA })
  if (!v) {
    log('critic returned nothing — re-spawning once')
    v = await agent(criticPrompt(), { label: `critic:rev${revisions}-retry`, phase: 'Critique', agentType: 'critic', schema: VERDICT_SCHEMA })
  }
  if (!v) {
    criticVerdictMissing = true
    log('critic returned nothing twice — shipping without an outer-pass verdict')
    break
  }
  if (v.verdict === 'APPROVE') break
  if (v.verdict === 'RE_PLAN') {
    return { escalate: 'RE_PLAN', reason: v.reason, branch: a.worktree, slices: slices.length, stuck }
  }
  const items = v.items || []
  if (!items.length) {
    log('critic returned FIX_LIST with no items — treating as APPROVE')
    break
  }

  // Only merge-blocking items re-enter the test-or-verify loop; the rest become PR-body
  // follow-ups (the synthesizer lists them under "Things deliberately not done").
  const blocking = items.filter((it) => !(it.blocksMerge === false && it.severity !== 'critical'))
  for (const it of items) {
    if (!blocking.includes(it) && !deferred.some((d) => d.behavior === it.behavior)) deferred.push(it)
  }
  if (items.length > blocking.length) log(`deferring ${items.length - blocking.length} non-blocking finding(s) to the PR body`)
  if (!blocking.length) break

  revisions++
  if (revisions > a.maxCriticRevisions) {
    remaining = blocking
    log(`critic cap (${a.maxCriticRevisions}) reached — shipping with ${remaining.length} open finding(s)`)
    break
  }
  const fixSlices = blocking.map((it) => ({
    title: `fix: ${it.behavior}`, behavior: it.behavior, testIdea: it.testIdea,
    verificationIdea: it.verificationIdea,
    verificationMode: it.verificationMode || (it.nonTestable ? 'verify' : 'test'),
    verificationReason: it.verificationReason,
    nonTestable: it.nonTestable, fixDirection: it.fixDirection, evidence: it.evidence,
  }))
  stuck.push(...await runSliceLoop(fixSlices, 'Critique', null))
}

// ── Phase: Synthesize ──────────────────────────────────────────────
// report.md (the PR body) is the load-bearing deliverable; notes.md is a
// secondary audit dump. A single soft "write A then B" prompt let the
// synthesizer write notes.md and stop, leaving the caller pointing at a
// report.md that never existed. So: report.md FIRST and primary, a
// structured return contract that forces the agent to confirm it, and a
// re-spawn if it didn't — mirroring how the critic's verdict is treated
// as a hard deliverable rather than a hope.
phase('Synthesize')
const openNote = remaining.length ? `\nThe critic left ${remaining.length} unresolved merge-blocking finding(s) at the revision cap — surface them honestly in the PR body so the human reviewer sees them: ${JSON.stringify(remaining)}` : ''
const followupNote = deferred.length ? `\nThe critic recorded ${deferred.length} non-blocking finding(s) as follow-ups — list them under "Things deliberately not done": ${JSON.stringify(deferred)}` : ''
const acceptanceNote = uncoveredAcceptance.length ? `\nThe completeness gate found ${uncoveredAcceptance.length} acceptance criterion/criteria the brief asked for but the artifact still doesn't demonstrate (no test or implementation evidence after a fix pass) — these are promised behaviors that did NOT ship. Surface them at the TOP of the PR body under an explicit "Unmet acceptance criteria" heading so the human reviewer cannot miss them: ${JSON.stringify(uncoveredAcceptance)}` : ''
const SYNTH_SCHEMA = {
  type: 'object', required: ['reportWritten'],
  properties: {
    reportWritten: { type: 'boolean', description: 'true only once report.md (the PR body) has actually been written to disk' },
    notesWritten: { type: 'boolean', description: 'true once notes.md has been written' },
  },
}
function synthPrompt(reportOnly) {
  const reportTask = `Your PRIMARY, required deliverable: write the PR body to ${a.outDir}/report.md following the feature-flow format in your role definition. Write it FIRST, before anything else. Never expose the run's internal framing (no slice/phase names) in report.md.`
  const notesTask = reportOnly
    ? ''
    : ` Only after report.md exists, also write the run journal verbatim to ${a.outDir}/notes.md for auditability (it's the record of what happened across slices) — this is secondary; do not let it crowd out report.md.`
  const header = reportOnly
    ? `${inWorktree}\nThe PR body at ${a.outDir}/report.md is still missing — write it now and nothing else.`
    : inWorktree
  return `${header}\nRead the brief at ${a.briefPath} and the plan at ${a.outDir}/plan.md. Run \`git diff ${a.base}...HEAD\` (base ${a.base}). Run journal:\n${fullNotes()}${acceptanceNote}${openNote}${followupNote}\n${reportTask}${notesTask}\nReturn structured output confirming reportWritten:true once report.md is on disk.`
}
let synth = await agent(synthPrompt(false), { label: 'synthesizer', phase: 'Synthesize', agentType: 'synthesizer', schema: SYNTH_SCHEMA })
if (!synth || !synth.reportWritten) {
  log('synthesizer did not confirm report.md — re-spawning once focused on the PR body only')
  synth = await agent(synthPrompt(true), { label: 'synthesizer-retry', phase: 'Synthesize', agentType: 'synthesizer', schema: SYNTH_SCHEMA })
}
const reportMissing = !synth || !synth.reportWritten
if (reportMissing) log('report.md still unconfirmed after re-spawn — caller should treat the PR body as missing')

return {
  branch: a.worktree,
  reportPath: `${a.outDir}/report.md`,
  reportMissing,
  notesPath: `${a.outDir}/notes.md`,
  slices: slices.length,
  criticRevisions: revisions,
  criticVerdictMissing,
  stuck,
  openFindings: remaining,
  deferredFindings: deferred,
  uncoveredAcceptance,
}

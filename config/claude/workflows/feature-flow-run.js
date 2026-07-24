export const meta = {
  name: 'feature-flow-run',
  description: 'Execution engine for /feature-flow (launched by the command): planner → per-slice test-or-verify inner loop → completeness gate (each acceptance criterion mapped to evidence) → critic outer pass with revision loop → synthesizer PR body. Supports the --gated split via planOnly.',
  phases: [
    { title: 'Plan', detail: 'planner decomposes the brief into vertical slices' },
    { title: 'Implement', detail: 'per-slice behavior testing or command verification via the tdd-slice-loop sub-workflow' },
    { title: 'Completeness', detail: 'completeness-critic maps each acceptance criterion to evidence; uncovered ones retain their test or verify strategy' },
    { title: 'Critique', detail: 'critic reviews the final diff; revision loop' },
    { title: 'Synthesize', detail: 'synthesizer returns PR-body content for the command to persist' },
  ],
}

// args (built by the host command before launch):
//   runDir, outDir, repo, worktree, base, briefPath, slug, testCmd|null
//   verifyCmds|null — approved gate commands (e.g. `pulumi preview`); the primary gate for verify-mode slices
//   maxSliceRetries, maxCriticRevisions, maxCriticFixFiles, acceptance[], priorRunStats|null
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
  type: 'object', required: ['passed', 'committed', 'headSha'],
  properties: {
    passed: { type: 'boolean' }, output: { type: 'string' },
    committed: { type: 'boolean' }, headSha: { type: 'string' },
  },
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
  type: 'object', required: ['verdict', 'reason', 'researchQuestions', 'candidateDirections'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'FIX_LIST', 'RE_PLAN'] },
    note: { type: 'string' },
    reason: { type: 'string', description: 'required explanation for RE_PLAN; empty string otherwise' },
    researchQuestions: { type: 'array', items: { type: 'string' }, description: 'bounded questions for RE_PLAN; empty otherwise' },
    candidateDirections: { type: 'array', items: { type: 'string' }, description: 'hypotheses for RE_PLAN, not a unilateral architecture choice; empty otherwise' },
    items: { type: 'array', items: {
      type: 'object', required: ['behavior', 'verificationMode', 'verificationReason', 'estimatedFiles', 'subsystems', 'behavioralSeams', 'introducesInfrastructurePrimitive'],
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
        estimatedFiles: { type: 'number', description: 'behavior-bearing implementation and substantive test files; exclude purely mechanical snapshots, fixtures, generated outputs, and documentation companions' },
        subsystems: { type: 'array', items: { type: 'string' } },
        behavioralSeams: { type: 'number' },
        introducesInfrastructurePrimitive: { type: 'boolean' },
        nonTestable: { type: 'boolean', description: 'deprecated compatibility alias for verificationMode=verify' },
      },
    } },
  },
}
const ARCH_RESEARCH_SCHEMA = {
  type: 'object', required: ['evidence', 'alternatives'],
  properties: {
    evidence: { type: 'array', items: { type: 'string' }, description: 'primary-source capability and repository-mechanism evidence with citations' },
    alternatives: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'at least two simpler directions and trade-offs' },
    recommendationBoundary: { type: 'string', description: 'what remains a user architecture decision' },
  },
}

// The run journal lives as a list of entry blocks; the tdd-slice-loop
// sub-workflow folds handoffs in and shows inner-loop prompts a capped view.
// The critic and synthesizer get the full journal (they run a handful of
// times, not per-slice); the conversation-side command persists it.
const notesHeader = `# Running notes — ${a.slug}\nAcceptance: ${(a.acceptance || []).join('; ') || '(see brief)'}`
let noteEntries = []
let verificationLedger = []
let currentHeadSha = ''
const runStats = {
  agents: (a.priorRunStats && a.priorRunStats.agents) || 0,
  retries: (a.priorRunStats && a.priorRunStats.retries) || 0,
  fullSuiteExecutions: (a.priorRunStats && a.priorRunStats.fullSuiteExecutions) || 0,
  verificationExecutions: (a.priorRunStats && a.priorRunStats.verificationExecutions) || 0,
  reusedChecks: (a.priorRunStats && a.priorRunStats.reusedChecks) || 0,
}
function fullNotes() { return `${notesHeader}\n${noteEntries.join('\n')}` }
function addStats(stats) {
  if (!stats) return
  for (const key of Object.keys(runStats)) runStats[key] += stats[key] || 0
}

const E2E_NOTE = `This is the FINAL slice — your test must exercise the feature's primary user-facing path end-to-end through the real assembled wiring (not a hand-built subset), and fail under the wrong wiring.`

async function runSliceLoop(slices, phaseLabel, finalSliceNote) {
  try {
    const r = await workflow('tdd-slice-loop', {
      worktree: a.worktree, briefPath: a.briefPath, planPath: `${a.outDir}/plan.md`,
      slug: a.slug, testCmd: a.testCmd, verifyCmds: a.verifyCmds || null, maxSliceRetries: a.maxSliceRetries,
      slices, finalSliceNote, scopeNote: null, phaseLabel,
      notesHeader, noteEntries, verificationLedger,
    })
    if (r && r.noteEntries) noteEntries = r.noteEntries
    if (r && r.verificationLedger) verificationLedger = r.verificationLedger
    const loopStuck = (r && r.stuck) || []
    const latestValidated = verificationLedger.slice().reverse().find((entry) => entry.commitSha)
    currentHeadSha = loopStuck.length ? '' : ((latestValidated && latestValidated.commitSha) || '')
    addStats(r && r.stats)
    return loopStuck
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
  runStats.agents++
  const plan = await agent(
    `${inWorktree}\nRead the brief at ${a.briefPath}. Produce a vertical-slice plan in dependency order, as thin as possible. For each slice choose verificationMode=test only when there is a stable behavioral seam that can fail for the intended reason; choose verificationMode=verify for declarative infrastructure, configuration, documentation, or any slice where a test would merely inspect the shipped artifact. Never manufacture a test to satisfy the workflow. Include testIdea for test mode or verificationIdea for verify mode, plus verificationReason. Write the human-readable plan to ${a.outDir}/plan.md (and an acceptance summary). Follow the planner role exactly. Also return the slices via the structured-output tool.`,
    { label: 'planner', phase: 'Plan', agentType: 'planner', schema: PLAN_SCHEMA }
  )
  slices = (plan && plan.slices) || []
  if (a.planOnly) {
    return { planned: true, slices, planPath: `${a.outDir}/plan.md`, outOfScope: (plan && plan.outOfScope) || [], runStats }
  }
}
if (!slices.length) return { error: 'no slices produced', branch: a.worktree, runStats }

// ── Phase: Implement (sequential same-file test-or-verify work) ──
phase('Implement')
const stuck = []
stuck.push(...await runSliceLoop(slices, 'Implement', E2E_NOTE))

// Ensure everything is committed before the critic diffs base...HEAD.
runStats.agents++
const initialSweep = await agent(
  `Mechanical commit sweep only. Stage and commit any outstanding changes in the worktree at ${a.worktree} as a single additive commit (never --amend/--force). If nothing is uncommitted, do nothing. ${wtGuard} Return {passed:true, committed:<whether a new commit was created>, headSha:<current HEAD after the sweep>}.`,
  { label: 'commit-all', phase: 'Implement', schema: GATE_SCHEMA, model: 'haiku', effort: 'low' }
)
currentHeadSha = (initialSweep && initialSweep.headSha) || ''

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
  runStats.agents++
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
      runStats.agents++
      const completenessSweep = await agent(
        `Mechanical commit sweep only. Stage and commit any outstanding changes in the worktree at ${a.worktree} as a single additive commit (never --amend/--force). If nothing is uncommitted, do nothing. ${wtGuard} Return {passed:true, committed:<whether a new commit was created>, headSha:<current HEAD after the sweep>}.`,
        { label: 'commit-completeness', phase: 'Completeness', schema: GATE_SCHEMA, model: 'haiku', effort: 'low' }
      )
      currentHeadSha = (completenessSweep && completenessSweep.headSha) || ''
      runStats.agents++
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
  const validLedger = verificationLedger.filter((entry) => currentHeadSha && entry.commitSha === currentHeadSha && entry.exitStatus === 0 && entry.treeChanged === false)
  const ledgerNote = validLedger.length
    ? `\nVerification ledger (reuse this evidence; do NOT rerun these commands): ${JSON.stringify(validLedger.slice(-40))}`
    : '\nNo reusable verification ledger entries were returned; treat verification as unknown rather than rerunning the suite.'
  return `${inWorktree}\nYou are the feature-flow critic for run ${a.slug}. Operate in Mode A per your role definition. Read the brief at ${a.briefPath} and the plan at ${a.outDir}/plan.md. Run \`git diff ${a.base}...HEAD\` for the final diff (base is ${a.base} - NOT necessarily main).${ledgerNote} The lead-curated run journal:\n${fullNotes()}${deferredNote}\nReview design quality, edge cases the tests miss, security/perf smells (the security lens auto-engages for infra-touching diffs), observability (per your role's observability pass - wide root span, debugging dimensions on the root span, a trail on tricky-to-debug edge branches; flag silent catches), and anything the journal admits was left undone. Shape each FIX_LIST item as a thin test-or-verify slice and include its estimated file count, subsystems, behavioral seams, and whether it introduces an infrastructure primitive. Return your verdict via structured output. Do NOT run tests or verification commands and do NOT request inner-loop transcripts.`
}
async function researchArchitecture(reason, questions, directions) {
  runStats.agents++
  return await agent(
    `${inWorktree}\nA feature-flow critic found a defect that exceeds the ordinary repair-slice boundary: ${reason}\nResearch questions: ${JSON.stringify(questions || [])}\nCandidate directions from the critic (hypotheses only): ${JSON.stringify(directions || [])}\nRun a bounded architecture research pass before any implementation. Check (1) current first-party platform or library capabilities using primary sources, (2) mechanisms already present in this repository that could be reused, and (3) at least two simpler alternatives to a new queue, lock, scheduler, cache, protocol, coordinator, or other cross-cutting primitive. Cite file:line or primary-source evidence. Do not edit code and do not choose the architecture for the user. Return evidence, alternatives, and the remaining decision boundary via structured output.`,
    { label: `architecture-research:rev${revisions}`, phase: 'Critique', agentType: 'researcher', schema: ARCH_RESEARCH_SCHEMA }
  )
}
const maxCriticFixFiles = a.maxCriticFixFiles || 8
while (true) {
  runStats.agents++
  let v = await agent(criticPrompt(), { label: `critic:rev${revisions}`, phase: 'Critique', agentType: 'critic', schema: VERDICT_SCHEMA })
  if (!v) {
    log('critic returned nothing — re-spawning once')
    runStats.agents++
    runStats.retries++
    v = await agent(criticPrompt(), { label: `critic:rev${revisions}-retry`, phase: 'Critique', agentType: 'critic', schema: VERDICT_SCHEMA })
  }
  if (!v) {
    criticVerdictMissing = true
    log('critic returned nothing twice — shipping without an outer-pass verdict')
    break
  }
  if (v.verdict === 'APPROVE') break
  if (v.verdict === 'RE_PLAN') {
    const reason = v.reason || 'critic determined the repair cannot stay within the thin-slice boundary'
    const architectureResearch = await researchArchitecture(reason, v.researchQuestions, v.candidateDirections)
    return { escalate: 'RE_PLAN', reason, architectureResearch, branch: a.worktree, slices: slices.length, stuck, runStats }
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

  const oversized = blocking.filter((it) =>
    (it.estimatedFiles || 0) > maxCriticFixFiles ||
    (it.subsystems || []).length > 1 ||
    (it.behavioralSeams || 1) > 1 ||
    it.introducesInfrastructurePrimitive === true
  )
  if (oversized.length) {
    const reason = `Critic repair exceeds the thin-slice guard (${maxCriticFixFiles} files, one subsystem, one behavioral seam, no new infrastructure primitive): ${oversized.map((it) => it.behavior).join(' · ')}`
    log(`critic fix-size guard tripped for ${oversized.length} finding(s) - researching before RE_PLAN`)
    const architectureResearch = await researchArchitecture(reason, oversized.map((it) => it.behavior), oversized.map((it) => it.fixDirection).filter(Boolean))
    return { escalate: 'RE_PLAN', reason, architectureResearch, branch: a.worktree, slices: slices.length, stuck, runStats }
  }

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
// The workflow runtime can reject writes for deterministic policy reasons.
// Keep drafting separate from persistence: the synthesizer returns content,
// and the conversation-side command writes the approved artifact paths.
phase('Synthesize')
const openNote = remaining.length ? `\nThe critic left ${remaining.length} unresolved merge-blocking finding(s) at the revision cap — surface them honestly in the PR body so the human reviewer sees them: ${JSON.stringify(remaining)}` : ''
const followupNote = deferred.length ? `\nThe critic recorded ${deferred.length} non-blocking finding(s) as follow-ups — list them under "Things deliberately not done": ${JSON.stringify(deferred)}` : ''
const acceptanceNote = uncoveredAcceptance.length ? `\nThe completeness gate found ${uncoveredAcceptance.length} acceptance criterion/criteria the brief asked for but the artifact still doesn't demonstrate (no test or implementation evidence after a fix pass) — these are promised behaviors that did NOT ship. Surface them at the TOP of the PR body under an explicit "Unmet acceptance criteria" heading so the human reviewer cannot miss them: ${JSON.stringify(uncoveredAcceptance)}` : ''
const SYNTH_SCHEMA = {
  type: 'object', required: ['reportContent'],
  properties: {
    reportContent: { type: 'string', description: 'complete markdown PR body; content only, no file write' },
  },
}
function synthPrompt() {
  return `${inWorktree}\nRead the brief at ${a.briefPath} and the plan at ${a.outDir}/plan.md. Run \`git diff ${a.base}...HEAD\` (base ${a.base}). Run journal:\n${fullNotes()}${acceptanceNote}${openNote}${followupNote}\nDraft the complete PR body following the feature-flow format in your role definition. Never expose the run's internal framing (no slice/phase names). Do NOT write any artifact file; return the markdown as reportContent via structured output so the conversation-side command can persist it.`
}
runStats.agents++
let synth = await agent(synthPrompt(), { label: 'synthesizer', phase: 'Synthesize', agentType: 'synthesizer', schema: SYNTH_SCHEMA })
if (!synth || !synth.reportContent) {
  log('synthesizer returned no PR-body content - re-spawning once without repeating any failed file write')
  runStats.agents++
  runStats.retries++
  synth = await agent(synthPrompt(), { label: 'synthesizer-retry', phase: 'Synthesize', agentType: 'synthesizer', schema: SYNTH_SCHEMA })
}
const reportContent = (synth && synth.reportContent) || ''
const notesContent = fullNotes()
const reportMissing = !reportContent
if (reportMissing) log('PR-body content still missing after one structured-output retry')

return {
  branch: a.worktree,
  reportPath: `${a.outDir}/report.md`,
  reportContent,
  reportMissing,
  notesPath: `${a.outDir}/notes.md`,
  notesContent,
  slices: slices.length,
  criticRevisions: revisions,
  criticVerdictMissing,
  stuck,
  openFindings: remaining,
  deferredFindings: deferred,
  uncoveredAcceptance,
  verificationLedger,
  runStats,
}

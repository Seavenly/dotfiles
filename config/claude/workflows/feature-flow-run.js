export const meta = {
  name: 'feature-flow-run',
  description: 'Execution engine for /feature-flow (launched by the command): planner, then per-slice builder with a deterministic gate script, then completeness and design review in parallel, triage, a final cross-model review (Fable, or Codex with --codex), triage, and a short report. Supports the --gated split via planOnly and a review-only relaunch.',
  phases: [
    { title: 'Plan', detail: 'planner splits the brief into behavior-sized slices' },
    { title: 'Build', detail: 'builder per slice; the gate script verifies and commits' },
    { title: 'Review', detail: 'completeness and design critic in parallel, then triage and fixes' },
    { title: 'Final review', detail: 'fresh cross-model review of the complete change, then triage and fixes' },
    { title: 'Report', detail: 'coverage recheck and the short review summary' },
  ],
}

// args (built by the host command before launch):
//   runDir, outDir, worktree, branch, base, briefPath, slug, gate (command
//   prefix, e.g. "node ~/.claude/scripts/feature-flow-gate.js")
//   acceptance[]: { id, text, evidence: test|diff|docs|ci:<job>|live }
//   maxSliceRetries, maxFixRounds, finalReviewer: 'fable'|'codex',
//   codex: { model, effort } | null
//   planOnly (bool), slices (array|null), reviewOnly (bool), priorRunStats|null
// args can arrive as a JSON-encoded string when launched by name.
const a = typeof args === 'string' ? JSON.parse(args) : args
// Reviews diff against the commit the gate recorded at init, not the base
// branch name, so a moving integration branch never shows up as reverted work.
const baseSha = a.baseSha || a.base
const maxFixRounds = Math.min(a.maxFixRounds == null ? 2 : a.maxFixRounds, 2)
const planPath = `${a.outDir}/plan.md`
const ledgerPath = `${a.runDir}/gate/ledger.json`
const gateStatePath = `${a.runDir}/gate/state.json`
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const where = `Work in the worktree at ${a.worktree}; cd there for every command. Run directory: ${a.runDir}. Never switch branches. Stay local: never push or write to GitHub (pull requests, issues, comments); the host decides what leaves this machine.`

const builderFollowups = []
const runStats = Object.assign({
  agents: 0, builderAttempts: 0, retries: 0, gateRuns: 0, gateRelayRetries: 0, fixRounds: 0,
  findings: { critic: 0, completeness: 0, final: 0, fix: 0, followup: 0, reject: 0 },
}, a.priorRunStats || {})
const stageStatus = {}
const setStage = (name, status, extra = {}) => { stageStatus[name] = { status, ...extra } }

// ── Shared schemas ─────────────────────────────────────────────────
const SLICE = {
  type: 'object', required: ['title', 'behavior', 'verificationMode'],
  properties: {
    title: { type: 'string' }, behavior: { type: 'string' },
    criteria: { type: 'array', items: { type: 'string' } },
    verificationMode: { type: 'string', enum: ['test', 'verify'] },
    redExempt: { type: 'boolean' },
    testIdea: { type: 'string' }, verificationIdea: { type: 'string' },
    verificationReason: { type: 'string' }, fixDirection: { type: 'string' },
    files: { type: 'string' },
  },
}
const PLAN_SCHEMA = {
  type: 'object', required: ['slices'],
  properties: { slices: { type: 'array', items: SLICE }, outOfScope: { type: 'array', items: { type: 'string' } } },
}
const BUILDER_SCHEMA = {
  type: 'object', required: ['completed'],
  properties: {
    completed: { type: 'string' }, undone: { type: 'string' }, issues: { type: 'string' },
    testPaths: { type: 'array', items: { type: 'string' } },
    existingTestEdits: { type: 'string' },
    followups: { type: 'array', items: { type: 'string' }, description: 'pre-existing issues or out-of-scope work to report, one line each' },
    requestRedExempt: { type: 'string', description: 'set only when the tests legitimately pass before the change (a guard or characterization test, or repairing tests); the reason' },
  },
}
const RELAY_SCHEMA = { type: 'object', required: ['stdout'], properties: { stdout: { type: 'string' } } }
const FINDING = {
  type: 'object', required: ['severity', 'confidence', 'title', 'evidence'],
  properties: {
    severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    lens: { type: 'string' }, title: { type: 'string' }, evidence: { type: 'string' },
    failureScenario: { type: 'string' }, fixDirection: { type: 'string' },
    verificationMode: { type: 'string', enum: ['test', 'verify'] },
  },
}
const CRITIC_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING },
    decisions: { type: 'array', items: { type: 'string' } },
  },
}
const COMPLETENESS_SCHEMA = {
  type: 'object', required: ['coverage'],
  properties: {
    coverage: { type: 'array', items: {
      type: 'object', required: ['criterion', 'status', 'evidence'],
      properties: {
        criterion: { type: 'string' },
        status: { type: 'string', enum: ['covered', 'partial', 'uncovered', 'deferred'] },
        evidence: { type: 'string' },
      },
    } },
    gaps: { type: 'array', items: {
      type: 'object', required: ['criterion', 'status', 'behavior', 'blocksMerge'],
      properties: {
        criterion: { type: 'string' }, status: { type: 'string', enum: ['partial', 'uncovered'] },
        behavior: { type: 'string' }, blocksMerge: { type: 'boolean' },
        evidence: { type: 'string' }, fixDirection: { type: 'string' },
        verificationMode: { type: 'string', enum: ['test', 'verify'] },
      },
    } },
  },
}
const TRIAGE_SCHEMA = {
  type: 'object', required: ['decisions'],
  properties: {
    decisions: { type: 'array', items: {
      type: 'object', required: ['id', 'verdict', 'reason'],
      properties: {
        id: { type: 'string' },
        verified: { type: 'string', enum: ['real', 'not-real', 'unverified'] },
        verdict: { type: 'string', enum: ['fix', 'followup', 'reject'] },
        reason: { type: 'string' },
        fixGroup: { type: 'string', description: 'findings sharing a fixGroup are repaired by one slice' },
      },
    } },
    fixSlices: { type: 'array', items: { ...SLICE, properties: { ...SLICE.properties, group: { type: 'string' } } } },
    replan: { type: 'string', description: 'set only when a must-fix finding needs a redesign, with the reason' },
    userDecisions: { type: 'array', items: { type: 'string' } },
  },
}

// ── Journal ────────────────────────────────────────────────────────
const notesHeader = `# Run notes - ${a.slug}\nAcceptance: ${(a.acceptance || []).map((c) => `${c.id} (${c.evidence}) ${c.text}`).join('; ') || '(see brief)'}`
const noteEntries = []
const NOTES_CAP = 40
function notesView() {
  const recent = noteEntries.length > NOTES_CAP ? noteEntries.slice(-NOTES_CAP) : noteEntries
  return `${notesHeader}\n${noteEntries.length > NOTES_CAP ? `(${noteEntries.length - NOTES_CAP} earlier entries are in the persisted journal)\n` : ''}${recent.join('\n')}`
}
function fullNotes() { return `${notesHeader}\n${noteEntries.join('\n')}` }
// agent() resolves null only when it was stopped or hit an unrecoverable
// error; one more attempt covers a transient failure.
async function retryNull(fn) {
  const first = await fn(0)
  if (first) return first
  runStats.retries++
  return await fn(1)
}
function note(title, h) {
  if (!h) return
  const bits = [
    h.undone && `undone: ${h.undone}`, h.issues && `issues: ${h.issues}`,
    h.existingTestEdits && `existing tests changed: ${h.existingTestEdits}`,
  ].filter(Boolean)
  if (bits.length) noteEntries.push(`\n## ${title}\n- ${bits.join('\n- ')}`)
}

// ── Gate relay ─────────────────────────────────────────────────────
// The workflow cannot run commands itself, so a low-cost agent runs the gate
// script and returns its single JSON line. The script owns every check; a
// malformed relay is retried as a gate run, never charged to the builder.
// Long suites outlast an agent's ten-minute shell limit, so the relay starts
// the gate detached and collects it with `wait`.
function relayPrompt(start, waitCmd, doneWhen) {
  return `Run these commands and nothing else. Do not edit files, add flags or pipes, or run anything else.\n\n1. Run once: ${start}\n   It prints one JSON line.\n2. ${waitCmd}\n   Each call waits up to nine minutes; use a 600000 ms shell timeout. Repeat it (at most 8 times) while it prints ${doneWhen}.\n\nReturn the last JSON line you received, verbatim, as \`stdout\`.`
}
function lastJson(r) {
  try { return JSON.parse(String((r && r.stdout) || '').trim().split('\n').pop()) } catch { return null }
}

async function gate(sub, flags, label, phaseName) {
  // Request ids are scoped to this launch, so a later relaunch on the same run
  // directory never reattaches to an earlier launch's result.
  const command = `${a.gate} ${sub} ${q(a.runDir)}${flags ? ` ${flags}` : ''} --detach --request ${`${a.launchId || 'launch'}.${label}`.replace(/[^\w.:-]/g, '_')}`
  const waitCmd = `If it contains "pending":true, run: ${a.gate} wait ${q(a.runDir)} --token <the token it printed>`
  for (let attempt = 0; attempt < 3; attempt++) {
    runStats.agents++
    runStats.gateRuns++
    if (attempt) runStats.gateRelayRetries++
    const r = await agent(relayPrompt(command, waitCmd, '"pending":true'),
      { label: attempt ? `${label}-relay${attempt}` : label, phase: phaseName, schema: RELAY_SCHEMA, model: 'sonnet', effort: 'low' })
    const parsed = lastJson(r)
    if (parsed && typeof parsed.ok === 'boolean' && !parsed.pending) return parsed
  }
  return { ok: false, reason: 'gate-relay-failed', message: 'the gate relay returned no final JSON three times' }
}
const MECHANICAL = new Set(['config-changed', 'wrong-branch', 'wrong-worktree', 'not-initialized', 'gate-error', 'gate-config', 'gate-busy', 'gate-relay-failed', 'index-mismatch'])
const E2E_NOTE = 'This is the final slice: its test drives the feature\'s primary user-facing path end to end through the real assembled wiring, not a hand-built subset, and fails under the wrong wiring. For verify-mode work, the final evidence covers the assembled path.'

function failurePacket(g) {
  const lines = [`reason: ${g.reason}`]
  if (g.command) lines.push(`command: ${g.command} (exit ${g.exit})`)
  if (g.message) lines.push(g.message)
  if (g.mutated) lines.push(`files written by the command: ${g.mutated.join(', ')}`)
  if (g.tail) lines.push(`output tail:\n${g.tail}`)
  return lines.join('\n')
}

// ── Build loop ─────────────────────────────────────────────────────
// Returns { stuck, notAttempted, head }. Stops early when two slices in a
// row get stuck on the same command, instead of spending every later slice's
// retries on one failure.
async function buildSlices(slices, phaseName, idPrefix, finalNote) {
  const stuck = []
  const notAttempted = []
  let lastStuckCommand = null
  let streak = 0
  let halted = null
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    const id = `${idPrefix}${i + 1}`
    if (halted) { notAttempted.push({ slice: s.title, reason: halted }); continue }
    const isFinal = i === slices.length - 1
    const mode = s.verificationMode === 'verify' ? 'verify' : 'test'
    const criteria = (s.criteria || []).join(', ')
    const modeNote = mode === 'test'
      ? (s.redExempt
        ? `Mode: test, red-exempt (its tests may pass before the change). Test idea: ${s.testIdea || 'derive from the behavior'}.`
        : `Mode: test. Test idea: ${s.testIdea || 'derive from the behavior'}. Write the tests first and run \`${a.gate} red ${q(a.runDir)} --slice ${id} --tests <paths>\` once, before implementing; it is not a test runner.`)
      : `Mode: verify. Evidence: ${s.verificationIdea || 'the approved verification commands'}.${s.verificationReason ? ` Why: ${s.verificationReason}.` : ''}`
    const base = `${where}\nSlice ${id} (${i + 1} of ${slices.length}): ${s.title}\nBehavior: ${s.behavior}${criteria ? `\nCriteria: ${criteria}` : ''}\n${modeNote}${s.fixDirection ? `\nFix direction: ${s.fixDirection}` : ''}${s.evidence ? `\nEvidence: ${s.evidence}` : ''}${isFinal && finalNote ? `\n${finalNote}` : ''}`
    let failure = null
    let handoff = null
    let attempt = 0
    while (true) {
      const prompt = failure
        ? `${base}\n\nRetry ${attempt} of ${a.maxSliceRetries}. The gate rejected the previous attempt, which is still in the working tree. Start from \`git diff\` and this failure, and change only what it requires:\n${failurePacket(failure)}\nYour previous handoff: ${JSON.stringify(handoff || {})}`
        : `${base}\n\nRead the brief at ${a.briefPath} and the plan at ${planPath}.\nNotes from earlier slices:\n${notesView()}`
      runStats.agents++
      runStats.builderAttempts++
      handoff = await agent(prompt, { label: `build:${id}${attempt ? `r${attempt}` : ''}`, phase: phaseName, agentType: 'builder', schema: BUILDER_SCHEMA })
      note(`${id} ${s.title}`, handoff)
      for (const f of (handoff && handoff.followups) || []) builderFollowups.push({ source: 'builder', title: f, evidence: `slice ${id}`, reason: 'reported by the builder' })
      const exempt = s.redExempt || !!(handoff && handoff.requestRedExempt)
      if (!s.redExempt && exempt) noteEntries.push(`\n## ${id} red-exempt requested by the builder\n- ${handoff.requestRedExempt}`)
      const flags = `--slice ${id} --title ${q(s.title)} --mode ${mode}${exempt ? ' --red-exempt' : ''}${isFinal ? ' --final' : ''}`
      const g = await gate('verify', flags, `gate:${id}${attempt ? `r${attempt}` : ''}`, phaseName)
      if (g.ok) {
        if (g.testEdits && ((g.testEdits.weakenedAssertions || []).length || (g.testEdits.existingTestEdits || []).length)) {
          noteEntries.push(`\n## ${id} test edits (gate report)\n- ${JSON.stringify(g.testEdits)}`)
        }
        if (g.noChange && mode === 'test') noteEntries.push(`\n## ${id} made no change\n- the gate saw no change for a test slice; the behavior may already exist`)
        streak = 0
        lastStuckCommand = null
        break
      }
      if (MECHANICAL.has(g.reason)) {
        halted = `gate cannot run: ${g.reason}${g.message ? ` (${g.message})` : ''}`
        stuck.push({ slice: s.title, reason: halted })
        log(`${id}: ${halted} - stopping the build`)
        break
      }
      failure = g
      attempt++
      runStats.retries++
      if (attempt > a.maxSliceRetries) {
        stuck.push({ slice: s.title, reason: g.reason, command: g.command || null, tail: g.tail || g.message || '' })
        log(`${id}: stuck after ${a.maxSliceRetries} retries (${g.reason})`)
        const key = g.command || g.reason
        streak = key === lastStuckCommand ? streak + 1 : 1
        lastStuckCommand = key
        if (streak >= 2) halted = `stopped after two slices in a row got stuck on \`${key}\``
        break
      }
    }
  }
  const fin = await gate('finalize', `--title ${q(`Remaining work from ${phaseName.toLowerCase()} that did not pass the gate`)}`, `finalize:${idPrefix || 'build'}`, phaseName)
  return { stuck, notAttempted, head: fin.ok ? fin.head : null, unverified: (fin.ok && fin.audit && fin.audit.unverified) || [] }
}

// ── Review helpers ─────────────────────────────────────────────────
const accText = (a.acceptance || []).map((c) => `${c.id} [${c.evidence}] ${c.text}`).join('\n') || 'See the brief.'
function pinned(head) {
  return `${where}\nReview the change \`git diff ${baseSha}..${head}\` (base ${baseSha}, head ${head}). Read the brief at ${a.briefPath} and the plan at ${planPath}.`
}

async function runCompleteness(head, label, phaseName, buildState) {
  const skipped = [...buildState.stuck, ...buildState.notAttempted].map((x) => `${x.slice}: ${x.reason}`)
  return await retryNull((n) => { runStats.agents++; return agent(
    `${pinned(head)}\nAcceptance criteria:\n${accText}\nGate ledger (passing checks per commit; reuse it, do not rerun): ${ledgerPath}\nSlices that got stuck or were not attempted: ${skipped.length ? skipped.join(' | ') : 'none'}\nUnverified commits: ${JSON.stringify(buildState.unverified || [])}\nMap every criterion to evidence and return the coverage and gaps.`,
    { label: n ? `${label}-retry` : label, phase: phaseName, agentType: 'completeness-critic', schema: COMPLETENESS_SCHEMA }
  ) })
}

async function runCritic(head) {
  return await retryNull((n) => { runStats.agents++; return agent(
    `${pinned(head)}\nAcceptance criteria:\n${accText}\nGate ledger: ${ledgerPath}. Per-slice test-edit reports (existing tests changed, assertions removed, skip markers): the \`testEdits\` of each slice in ${gateStatePath}. Verification command output: ${a.runDir}/gate/logs/.\nRun journal (what each slice did, left undone, and flagged):\n${fullNotes()}\nReview the change through your lenses and report every finding.`,
    { label: n ? 'critic-retry' : 'critic', phase: 'Review', agentType: 'feature-critic', schema: CRITIC_SCHEMA }
  ) })
}

async function runFinalReviewer(head) {
  const fable = async (note) => {
    const r = await retryNull((n) => { runStats.agents++; return agent(
      `${pinned(head)}\nThis is the final review: a fresh look at the complete change after the in-flow review and its fixes. You are not given the run journal, the gate reports, or earlier findings, and you should not read them; judge the change on its own. Acceptance criteria:\n${accText}\nReview through your lenses and report every finding.`,
      { label: n ? 'final-review:fable-retry' : 'final-review:fable', phase: 'Final review', agentType: 'feature-critic', model: 'fable', schema: CRITIC_SCHEMA }
    ) })
    return { used: 'fable', fallbackReason: note || null, result: r }
  }
  if (a.finalReviewer !== 'codex') return await fable(null)
  const c = a.codex || {}
  const cx = `node ~/.claude/scripts/feature-flow-codex-review.js ${q(a.runDir)} --base ${baseSha} --head ${head} --model ${c.model || 'gpt-6-sol'} --effort ${c.effort || 'medium'}`
  runStats.agents++
  const r = await agent(relayPrompt(`${cx} --detach`, `Then run: ${cx} --wait 540`, '"status":"running"'),
    { label: 'final-review:codex', phase: 'Final review', schema: RELAY_SCHEMA, model: 'sonnet', effort: 'low' })
  const parsed = lastJson(r)
  if (parsed && parsed.status === 'ok' && parsed.head === head) {
    return { used: 'codex', fallbackReason: null, result: { summary: parsed.summary, findings: parsed.findings || [] } }
  }
  return await fable(`codex ${parsed ? `${parsed.status}: ${parsed.reason || 'no reason'}` : 'returned no result'}`)
}

async function triage(head, findings, label, phaseName) {
  if (!findings.length) return { decisions: [], fixSlices: [] }
  return await retryNull((n) => { runStats.agents++; return agent(
    `${pinned(head)}\nTriage these review findings. Verify each against the code at ${head}, decide fix, followup, or reject, and shape the accepted fixes as repair slices (group findings that share a root cause):\n${JSON.stringify(findings, null, 1)}`,
    { label: n ? `${label}-retry` : label, phase: phaseName, agentType: 'feature-verifier', schema: TRIAGE_SCHEMA }
  ) })
}

// ── Plan ───────────────────────────────────────────────────────────
let slices = a.slices || null
if (!a.reviewOnly && !slices) {
  phase('Plan')
  runStats.agents++
  const plan = await agent(
    `${where}\nRead the brief at ${a.briefPath}. Acceptance criteria:\n${accText}\nWrite the plan to ${planPath} and return the slices. Map every criterion to a slice or to out of scope.`,
    { label: 'planner', phase: 'Plan', agentType: 'planner', schema: PLAN_SCHEMA }
  )
  slices = (plan && plan.slices) || []
  setStage('plan', slices.length ? 'ok' : 'failed')
  if (a.planOnly) return { planned: true, slices, planPath, outOfScope: (plan && plan.outOfScope) || [], runStats }
  if (!slices.length) return { error: 'no slices produced', branch: a.branch, worktree: a.worktree, stageStatus, runStats }
}

// ── Build ──────────────────────────────────────────────────────────
let build = { stuck: [], notAttempted: [], head: null }
if (!a.reviewOnly) {
  phase('Build')
  build = await buildSlices(slices, 'Build', 's', E2E_NOTE)
  setStage('build', build.head ? 'ok' : 'failed', { head: build.head, stuck: build.stuck.length, notAttempted: build.notAttempted.length })
} else {
  const fin = await gate('finalize', `--title ${q('Uncommitted work found by the review-only relaunch')}`, 'finalize:review-only', 'Review')
  build.head = fin.ok ? fin.head : null
  setStage('build', 'skipped', { head: build.head, reason: 'review-only relaunch' })
}
let head = build.head
let unverifiedCommits = build.unverified || []
if (!head) {
  return { error: 'the gate could not finalize the build', branch: a.branch, worktree: a.worktree, stuck: build.stuck, stageStatus, runStats }
}

const stuck = [...build.stuck]
const notAttempted = [...build.notAttempted]
const followups = []
const rejected = []
const userDecisions = []
let openFindings = []
const postReviewFixes = [] // repairs made after the final review: gate-verified, not re-reviewed
let fixRounds = 0
let firstCoverage = null

function collect(t, byId) {
  const fixes = []
  if (!t) {
    // Triage failed twice: every finding stays open for the human reviewer.
    openFindings.push(...[...byId.values()].map((f) => ({ ...f, reason: 'not triaged: the verifier returned nothing' })))
    return fixes
  }
  for (const d of (t && t.decisions) || []) {
    const f = byId.get(d.id)
    if (!f) continue
    runStats.findings[d.verdict] = (runStats.findings[d.verdict] || 0) + 1
    if (d.verdict === 'followup') followups.push({ ...f, reason: d.reason })
    else if (d.verdict === 'reject') rejected.push({ ...f, reason: d.reason })
    else fixes.push({ ...f, reason: d.reason })
  }
  for (const u of (t && t.userDecisions) || []) if (!userDecisions.includes(u)) userDecisions.push(u)
  return fixes
}

async function repair(t, fixes, phaseName, round) {
  const fixSlices = (t && t.fixSlices) || []
  if (!fixes.length) return
  if (!fixSlices.length) {
    openFindings.push(...fixes.map((f) => ({ ...f, reason: `${f.reason} (accepted, but triage shaped no repair slice)` })))
    return
  }
  if (fixRounds >= maxFixRounds) {
    openFindings.push(...fixes)
    log(`fix-round cap (${maxFixRounds}) reached - ${fixes.length} accepted finding(s) left open`)
    return
  }
  if (round === 'r2') postReviewFixes.push(...fixSlices.map((x) => x.title))
  fixRounds++
  runStats.fixRounds = fixRounds
  const r = await buildSlices(fixSlices.map((s) => ({ ...s, title: `Fix: ${s.title}` })), phaseName, `${round}-`)
  stuck.push(...r.stuck)
  notAttempted.push(...r.notAttempted)
  if (r.head) { head = r.head; unverifiedCommits = r.unverified } else log(`${phaseName} fixes: the gate could not finalize; reviews stay on ${head}`)
}

// ── Review: completeness and critic in parallel, then triage ───────
phase('Review')
const [coverage1, critic] = await parallel([
  () => (a.acceptance || []).length ? runCompleteness(head, 'completeness', 'Review', build) : Promise.resolve(null),
  () => runCritic(head),
])
setStage('completeness', (a.acceptance || []).length ? (coverage1 ? 'ok' : 'failed') : 'skipped', { head })
setStage('critic', critic ? 'ok' : 'failed', { head })
firstCoverage = coverage1
const reviewFindings = []
for (const [i, g] of ((coverage1 && coverage1.gaps) || []).entries()) {
  reviewFindings.push({ id: `c${i + 1}`, source: 'completeness', severity: g.blocksMerge ? 'critical' : 'important', confidence: 'high', title: `${g.criterion}: ${g.behavior}`, evidence: g.evidence || '', fixDirection: g.fixDirection || '', verificationMode: g.verificationMode })
}
for (const [i, f] of ((critic && critic.findings) || []).entries()) reviewFindings.push({ id: `k${i + 1}`, source: 'critic', ...f })
for (const d of (critic && critic.decisions) || []) if (!userDecisions.includes(d)) userDecisions.push(d)
runStats.findings.completeness += ((coverage1 && coverage1.gaps) || []).length
runStats.findings.critic += ((critic && critic.findings) || []).length
const t1 = await triage(head, reviewFindings, 'triage:review', 'Review')
setStage('triage-review', reviewFindings.length ? (t1 ? 'ok' : 'failed') : 'skipped', { head })
if (t1 && t1.replan) {
  return { escalate: 'RE_PLAN', reason: t1.replan, architectureResearch: null, branch: a.branch, worktree: a.worktree, slices: (slices || []).length, stuck, decisions: userDecisions, stageStatus, runStats }
}
await repair(t1, collect(t1, new Map(reviewFindings.map((f) => [f.id, f]))), 'Review', 'r1')

// ── Final review: fresh cross-model look at the complete change ────
phase('Final review')
const finalHeadBefore = head
const fr = await runFinalReviewer(head)
const finalFindings = ((fr.result && fr.result.findings) || []).map((f, i) => ({ id: `x${i + 1}`, source: `final:${fr.used}`, ...f }))
runStats.findings.final += finalFindings.length
setStage('final-review', fr.result ? 'ok' : 'failed', { head: finalHeadBefore, reviewer: fr.used, fallbackReason: fr.fallbackReason })
const t2 = await triage(head, finalFindings, 'triage:final', 'Final review')
setStage('triage-final', finalFindings.length ? (t2 ? 'ok' : 'failed') : 'skipped', { head })
if (t2 && t2.replan) {
  return { escalate: 'RE_PLAN', reason: t2.replan, architectureResearch: null, branch: a.branch, worktree: a.worktree, slices: (slices || []).length, stuck, decisions: userDecisions, stageStatus, runStats }
}
await repair(t2, collect(t2, new Map(finalFindings.map((f) => [f.id, f]))), 'Final review', 'r2')

// ── Report: coverage at the final head, then the summary ───────────
phase('Report')
let finalCoverage = firstCoverage
if ((a.acceptance || []).length && (fixRounds > 0 || (firstCoverage && (firstCoverage.gaps || []).length))) {
  finalCoverage = await runCompleteness(head, 'completeness:final', 'Report', { stuck, notAttempted, unverified: unverifiedCommits })
  setStage('coverage-final', finalCoverage ? 'ok' : 'failed', { head })
} else {
  setStage('coverage-final', (a.acceptance || []).length ? 'ok' : 'skipped', { head, reused: 'review-stage coverage at an unchanged head' })
}
const gaps = (finalCoverage && finalCoverage.gaps) || []
const uncoveredAcceptance = gaps.filter((g) => g.blocksMerge !== false)
for (const g of gaps.filter((x) => x.blocksMerge === false)) followups.push({ source: 'completeness', title: `${g.criterion}: ${g.behavior}`, evidence: g.evidence || '', reason: 'partial coverage of a secondary case' })
const deferredProof = ((finalCoverage && finalCoverage.coverage) || []).filter((c) => c.status === 'deferred')

const audit = await gate('audit', '', 'audit', 'Report')
const SYNTH_SCHEMA = {
  type: 'object', required: ['reportContent'],
  properties: { reportContent: { type: 'string', description: 'complete markdown review summary; content only, no file write' } },
}
followups.push(...builderFollowups)
const outcome = {
  stuck, notAttempted, uncoveredAcceptance, deferredProof, openFindings,
  followups: followups.map(({ title, evidence, reason }) => ({ title, evidence, reason })),
  userDecisions, unverifiedCommits: (audit && audit.unverified) || [], postReviewFixes,
}
const synth = await retryNull((n) => { runStats.agents++; return agent(
  `${pinned(head)}\nWrite the review summary for this change following the feature-flow format in your role. Outcome of the run (surface every non-empty list as your role describes; postReviewFixes are repairs made after the final review, verified by the gate but not re-reviewed): ${JSON.stringify(outcome)}\nRun journal:\n${fullNotes()}\nReturn the markdown as reportContent; do not write any file.`,
  { label: n ? 'synthesizer-retry' : 'synthesizer', phase: 'Report', agentType: 'synthesizer', schema: SYNTH_SCHEMA }
) })
const reportContent = (synth && synth.reportContent) || ''
setStage('report', reportContent ? 'ok' : 'failed', { head })

const reviewNotes = [
  `\n## Review outcome`,
  `- final reviewer: ${fr.used}${fr.fallbackReason ? ` (fallback: ${fr.fallbackReason})` : ''}`,
  `- fix rounds: ${fixRounds}`,
  ...rejected.map((f) => `- rejected [${f.source}] ${f.title}: ${f.reason}`),
  ...followups.map((f) => `- follow-up [${f.source || 'review'}] ${f.title}: ${f.reason}`),
]
const notesContent = `${fullNotes()}\n${reviewNotes.join('\n')}\n\n## Stage status\n${JSON.stringify(stageStatus, null, 2)}\n`

return {
  branch: a.branch,
  worktree: a.worktree,
  reviewedBase: baseSha,
  reviewedHead: head,
  reportPath: `${a.outDir}/report.md`,
  reportContent,
  reportMissing: !reportContent,
  notesPath: `${a.outDir}/notes.md`,
  notesContent,
  slices: (slices || []).length,
  // epic-flow treats a non-empty stuck list as not clean, so unattempted
  // slices count as stuck there too.
  stuck: [...stuck, ...notAttempted.map((x) => ({ ...x, notAttempted: true }))],
  notAttempted,
  postReviewFixes,
  decisions: userDecisions,
  openFindings,
  deferredFindings: followups,
  rejectedFindings: rejected,
  uncoveredAcceptance,
  deferredProof,
  // true when any review stage failed, so epic-flow's clean check stays conservative
  criticVerdictMissing: ['critic', 'final-review', 'triage-review', 'triage-final'].some((k) => stageStatus[k] && stageStatus[k].status === 'failed'),
  finalReviewer: { requested: a.finalReviewer || 'fable', used: fr.used, fallbackReason: fr.fallbackReason },
  stageStatus,
  audit,
  runStats,
}

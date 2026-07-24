export const meta = {
  name: 'tdd-slice-loop',
  description: 'Shared test-or-verify inner loop (launched as a sub-workflow by feature-flow-run and spike-flow-run, not run directly): test-mode slices use tester → implementer; verify-mode slices use implementer directly; both use an independent gate with retries.',
}

// args (built by the parent workflow):
//   worktree, briefPath, planPath|null, slug, testCmd|null, maxSliceRetries
//   verifyCmds|null — extra gate commands run after the suite (e.g. `pulumi preview`);
//     for verificationMode=verify slices these ARE the slice's verification
//   slices: [{ title, behavior, verificationMode?, testIdea?, verificationIdea?,
//              verificationReason?, nonTestable?, fixDirection?, evidence? }]
//   finalSliceNote|null — appended to the last slice's tester prompt (e2e discipline)
//   scopeNote|null — extra scoping line (e.g. prototype: "Scope all code to experiments/<slug>/.")
//   phaseLabel — progress-group title for the spawned agents ('Implement' | 'Critique' | 'Prototype')
//   notesHeader, noteEntries[] — the run journal (header + markdown entry blocks)
// returns { noteEntries, stuck: [{slice, reason}] }
// args can arrive as a JSON-encoded string when launched by name — normalize.
const a = typeof args === 'string' ? JSON.parse(args) : args
const noteEntries = (a.noteEntries || []).slice()
const stuck = []

const inWorktree = `Work in the worktree at ${a.worktree} — cd there for all commands, reads, and writes. Never switch branches. Treat the run journal shown inline below as the authoritative notes, and return structured output where this prompt asks for it instead of writing a verdict/handoff file.${a.scopeNote ? ` ${a.scopeNote}` : ''}`
// Guard against a stray agent that didn't cd: confirm we're in the worktree before any commit.
const wtGuard = `Before staging or committing, confirm \`git -C "${a.worktree}" rev-parse --show-toplevel\` resolves to ${a.worktree}; run all git from \`-C "${a.worktree}"\` so you never touch another checkout. If it doesn't resolve there, do NOT commit — set committed=false and say so in output.`
const readRefs = `Read ${a.briefPath}${a.planPath ? ` and ${a.planPath}` : ''}.`

const HANDOFF = {
  type: 'object',
  properties: {
    completed: { type: 'string' }, undone: { type: 'string' }, issues: { type: 'string' },
  },
}
const TESTER_SCHEMA = {
  type: 'object', required: ['testPath', 'failsBehaviorally'],
  properties: { testPath: { type: 'string' }, failsBehaviorally: { type: 'boolean' }, handoff: HANDOFF },
}
const IMPL_SCHEMA = { type: 'object', properties: { handoff: HANDOFF } }
const GATE_SCHEMA = {
  type: 'object', required: ['passed'],
  properties: { passed: { type: 'boolean' }, output: { type: 'string' }, committed: { type: 'boolean' } },
}

// Prompts see at most the most recent entries so a long run's early noise
// doesn't tax every later prompt. The parent persists the FULL journal
// (synthesizer → out/notes.md); only the inner-loop view is capped.
const NOTES_CAP = 40
function renderNotes() {
  const entries = noteEntries.length > NOTES_CAP
    ? [`*(${noteEntries.length - NOTES_CAP} earlier entries elided — the full journal is persisted to out/notes.md at the end)*`, ...noteEntries.slice(-NOTES_CAP)]
    : noteEntries
  return `${a.notesHeader}\n${entries.join('\n')}`
}
function fold(role, slice, h) {
  if (!h) return
  const bits = [h.undone && `undone: ${h.undone}`, h.issues && `issues: ${h.issues}`].filter(Boolean)
  if (bits.length) noteEntries.push(`\n## ${role} — ${slice}\n- ${bits.join('\n- ')}`)
}
function testerProblem(t) {
  if (!t) return 'no structured output was returned'
  if (!t.testPath) return 'no test path was returned'
  if (t.failsBehaviorally === false) return 'the test did not fail behaviorally (it passed immediately, or failed for a non-behavioral reason like a syntax/import error)'
  return null
}

for (let i = 0; i < a.slices.length; i++) {
  const s = a.slices[i]
  const tag = `slice ${i + 1}/${a.slices.length} — ${s.title}`
  const isFinal = i === a.slices.length - 1
  // nonTestable remains a compatibility alias for approved gated plans
  // produced before verificationMode became first-class.
  const verificationMode = s.verificationMode || (s.nonTestable ? 'verify' : 'test')
  const verifyOnly = verificationMode === 'verify'

  // ── Tester (test mode only) ──
  let testPath = null
  if (!verifyOnly) {
    const finalNote = isFinal && a.finalSliceNote ? ` ${a.finalSliceNote}` : ''
    const testerPrompt = (problem) =>
      `${inWorktree}\nSlice: ${s.title}. Behavior: ${s.behavior}. Test idea: ${s.testIdea || '(derive from the behavior)'}.${s.evidence ? ` Evidence: ${s.evidence}.` : ''}${finalNote}${problem ? `\nA previous attempt failed: ${problem}. Address that before returning.` : ''}\nNotes so far:\n${renderNotes()}\n${readRefs} Write ONE failing test for this slice and confirm it fails behaviorally. Return testPath + your ### Handoff via structured output.`
    let t = await agent(testerPrompt(null), { label: `test:${i + 1}`, phase: a.phaseLabel, agentType: 'tester', schema: TESTER_SCHEMA })
    fold('tester', tag, t && t.handoff)
    let problem = testerProblem(t)
    if (problem) {
      t = await agent(testerPrompt(problem), { label: `test:${i + 1}-retry`, phase: a.phaseLabel, agentType: 'tester', schema: TESTER_SCHEMA })
      fold('tester', tag, t && t.handoff)
      problem = testerProblem(t)
    }
    if (problem) {
      stuck.push({ slice: s.title, reason: `tester could not produce a behaviorally-failing test: ${problem}` })
      log(`${tag}: skipping — ${problem}`)
      continue
    }
    testPath = t.testPath
  }

  // ── Implementer → independent gate, retry ≤ maxSliceRetries ──
  let retries = 0, lastFail = ''
  while (true) {
    const retryNote = retries ? `\nRetry ${retries}/${a.maxSliceRetries}. ${testPath ? 'Test still fails' : 'Verification still fails'}:\n${lastFail}\nRevise.${testPath ? ' Do NOT modify the test.' : ''}` : ''
    // Observability is the sanctioned exception to "minimal" — a test rarely
    // asserts on a log/span, so the minimal-code framing would suppress it.
    const obsNote = ` Where this slice has a tricky-to-debug edge branch (rare input, degraded dependency, fallback, race, swallowed error) or a request entry point, add observability per the Observability section of your role — it's the one sanctioned exception to "minimal": one wide root span, debugging/filtering dimensions on the root span, a structured log on the edge. Don't force it onto trivial code.`
    const implPrompt = verifyOnly
      ? `${inWorktree}\nSlice: ${s.title}. ${s.behavior}\nVerification mode: command/artifact verification. ${s.verificationIdea ? `Acceptance signal: ${s.verificationIdea}. ` : ''}${s.verificationReason ? `Reason: ${s.verificationReason}. ` : ''}Implement it minimally. Do not add a unit test unless you discover a stable behavioral seam whose failure would prove the requested behavior; never add source-text, exact rendered-shape, or tautological tests merely to create a red phase.${s.fixDirection ? ` Fix direction: ${s.fixDirection}.` : ''}${obsNote} Do not commit — the gate commits on green.\nNotes so far:\n${renderNotes()}${retryNote}\n${readRefs} Return your ### Handoff.`
      : `${inWorktree}\nSlice: ${s.title}. The failing test is at ${testPath}. Make it pass with minimal code; on green do a focused local refactor.${s.fixDirection ? ` Fix direction: ${s.fixDirection}.` : ''}${obsNote}\nNotes so far:\n${renderNotes()}${retryNote}\nReturn your ### Handoff.`
    const im = await agent(implPrompt, { label: `impl:${i + 1}${retries ? `r${retries}` : ''}`, phase: a.phaseLabel, agentType: 'implementer', schema: IMPL_SCHEMA })
    fold('implementer', tag, im && im.handoff)

    // Verification commands can be expensive cumulative checks such as a
    // Pulumi preview. Run them for every verify-mode slice and once at the
    // final slice, rather than after every behavior-test slice.
    const shouldRunVerification = verifyOnly || isFinal
    const verifyClause = shouldRunVerification && a.verifyCmds && a.verifyCmds.length
      ? ` Then run the verification command(s) ${a.verifyCmds.map((c) => `\`${c}\``).join(', ')} — each must also succeed (for verify-mode slices these ARE the primary gate; treat a failed/erroring preview or an unexpected replace/delete of protected resources as a failure).`
      : ''
    const g = await agent(
      `Run the project's full test suite${a.testCmd ? ` (\`${a.testCmd}\`)` : ' (auto-detect the runner)'} in the worktree at ${a.worktree} and report whether it passes with NO failures.${verifyClause} Do NOT edit code or tests. If everything passes, stage and commit the current slice ("${s.title}") as an additive commit (never --amend/--force) and set committed=true. ${wtGuard} Return {passed, output (last failure lines if any), committed}.`,
      { label: `gate:${i + 1}${retries ? `r${retries}` : ''}`, phase: a.phaseLabel, schema: GATE_SCHEMA, model: 'sonnet' }
    )
    if (g && g.passed) {
      if (g.committed === false) log(`${tag}: gate passed but did not commit — the parent's commit sweep will pick it up`)
      break
    }
    retries++
    lastFail = (g && g.output) || 'unknown failure'
    if (retries > a.maxSliceRetries) {
      stuck.push({ slice: s.title, reason: lastFail })
      log(`${tag}: exhausted ${a.maxSliceRetries} retries — recording and moving on`)
      break
    }
  }
}

return { noteEntries, stuck }

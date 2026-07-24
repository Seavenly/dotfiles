export const meta = {
  name: 'tdd-slice-loop',
  description: 'Shared test-or-verify inner loop (launched as a sub-workflow by feature-flow-run and spike-flow-run, not run directly): test-mode slices use tester → implementer; verify-mode slices use implementer directly; both use an independent gate with retries.',
}

// args (built by the parent workflow):
//   worktree, briefPath, planPath|null, slug, testCmd|null, maxSliceRetries
//   verifyCmds|null — extra gate commands run after the suite (e.g. `pulumi preview`);
//     for verificationMode=verify slices these ARE the slice's verification
//   verificationLedger[] - prior command results reusable only for the same clean commit/environment
//   slices: [{ title, behavior, verificationMode?, testIdea?, verificationIdea?,
//              verificationReason?, nonTestable?, fixDirection?, evidence? }]
//   finalSliceNote|null — appended to the last slice's tester prompt (e2e discipline)
//   scopeNote|null — extra scoping line (e.g. prototype: "Scope all code to experiments/<slug>/.")
//   phaseLabel — progress-group title for the spawned agents ('Implement' | 'Critique' | 'Prototype')
//   notesHeader, noteEntries[] — the run journal (header + markdown entry blocks)
// returns { noteEntries, stuck, verificationLedger, stats }
// args can arrive as a JSON-encoded string when launched by name — normalize.
const a = typeof args === 'string' ? JSON.parse(args) : args
const noteEntries = (a.noteEntries || []).slice()
const verificationLedger = (a.verificationLedger || []).slice()
const environmentKey = `${a.slug || 'run'}:${a.worktree}`
const stuck = []
const stats = { agents: 0, retries: 0, fullSuiteExecutions: 0, verificationExecutions: 0, reusedChecks: 0 }

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
  type: 'object', required: ['passed', 'committed', 'validatedSha', 'startSha', 'startClean', 'endClean', 'verifiedTree', 'committedTree', 'commandResults'],
  properties: {
    passed: { type: 'boolean' },
    output: { type: 'string', description: 'bounded tail of the failing command, empty on success' },
    committed: { type: 'boolean', description: 'true when validatedSha names a committed code state; a new commit is not required when clean HEAD was reused' },
    validatedSha: { type: 'string', description: 'commit SHA containing the exact verified tree' },
    startSha: { type: 'string', description: 'HEAD before command execution' },
    startClean: { type: 'boolean', description: 'whether the working tree and index were clean before gate staging' },
    endClean: { type: 'boolean', description: 'whether working tree and index exactly match validatedSha after commit hooks finish' },
    verifiedTree: { type: 'string', description: 'git tree object ID after the final successful command' },
    committedTree: { type: 'string', description: 'git tree object ID of validatedSha' },
    commandResults: { type: 'array', items: {
      type: 'object', required: ['command', 'kind', 'exitStatus', 'treeChanged', 'treeBefore', 'treeAfter', 'reused'],
      properties: {
        command: { type: 'string' },
        kind: { type: 'string', enum: ['suite', 'verification'] },
        exitStatus: { type: 'number' },
        treeChanged: { type: 'boolean' },
        treeBefore: { type: 'string', description: 'git write-tree object ID immediately before the command' },
        treeAfter: { type: 'string', description: 'git write-tree object ID immediately after the command' },
        reused: { type: 'boolean' },
        output: { type: 'string', description: 'at most the last 40 relevant lines' },
      },
    } },
  },
}

// Prompts see at most the most recent entries so a long run's early noise
// doesn't tax every later prompt. The parent persists the FULL journal;
// only the inner-loop view is capped.
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
function uniqueCommands(commands) {
  const seen = new Set()
  return commands.filter((entry) => {
    const key = entry.command.trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    entry.command = key
    return true
  })
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
      `${inWorktree}\nSlice: ${s.title}. Behavior: ${s.behavior}. Test idea: ${s.testIdea || '(derive from the behavior)'}.${s.evidence ? ` Evidence: ${s.evidence}.` : ''}${finalNote}${problem ? `\nA previous attempt failed: ${problem}. Address that before returning.` : ''}\nNotes so far:\n${renderNotes()}\n${readRefs} Write ONE failing test for this slice and run only that test target to confirm it fails behaviorally; do not run the full suite, which the independent gate owns. Return testPath + your ### Handoff via structured output.`
    stats.agents++
    let t = await agent(testerPrompt(null), { label: `test:${i + 1}`, phase: a.phaseLabel, agentType: 'tester', schema: TESTER_SCHEMA })
    fold('tester', tag, t && t.handoff)
    let problem = testerProblem(t)
    if (problem) {
      stats.agents++
      stats.retries++
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
  let retries = 0, lastFail = '', lastHandoff = null
  while (true) {
    const retryPacket = retries
      ? `\nContinuation retry ${retries}/${a.maxSliceRetries}. The current working tree already contains the previous attempt. Start with \`git diff --stat HEAD\` and the changed files it names; do not reread the brief/plan or broadly rediscover the repository unless this packet points to missing context.\nPrevious handoff: ${JSON.stringify(lastHandoff || {})}\nGate failure (bounded tail):\n${lastFail}\nRevise only what the failure requires.${testPath ? ' Do NOT modify the test.' : ''}`
      : `\nNotes so far:\n${renderNotes()}\n${readRefs}`
    // Observability is the sanctioned exception to "minimal" — a test rarely
    // asserts on a log/span, so the minimal-code framing would suppress it.
    const obsNote = ` Where this slice has a tricky-to-debug edge branch (rare input, degraded dependency, fallback, race, swallowed error) or a request entry point, add observability per the Observability section of your role — it's the one sanctioned exception to "minimal": one wide root span, debugging/filtering dimensions on the root span, a structured log on the edge. Don't force it onto trivial code.`
    const narrowCheck = ` Use only the focused slice test or a narrow local check while iterating. Do not run the full suite or the approved verification commands; the independent gate is their sole owner for this code state.`
    const implPrompt = verifyOnly
      ? `${inWorktree}\nSlice: ${s.title}. ${s.behavior}\nVerification mode: command/artifact verification. ${s.verificationIdea ? `Acceptance signal: ${s.verificationIdea}. ` : ''}${s.verificationReason ? `Reason: ${s.verificationReason}. ` : ''}Implement it minimally. Do not add a unit test unless you discover a stable behavioral seam whose failure would prove the requested behavior; never add source-text, exact rendered-shape, or tautological tests merely to create a red phase.${s.fixDirection ? ` Fix direction: ${s.fixDirection}.` : ''}${obsNote}${narrowCheck} Do not commit - the gate commits on green.${retryPacket}\nReturn your ### Handoff.`
      : `${inWorktree}\nSlice: ${s.title}. The failing test is at ${testPath}. Make it pass with minimal code; on green do a focused local refactor.${s.fixDirection ? ` Fix direction: ${s.fixDirection}.` : ''}${obsNote}${narrowCheck}${retryPacket}\nReturn your ### Handoff.`
    stats.agents++
    const im = await agent(implPrompt, { label: `impl:${i + 1}${retries ? `r${retries}` : ''}`, phase: a.phaseLabel, agentType: 'implementer', schema: IMPL_SCHEMA })
    lastHandoff = im && im.handoff
    fold('implementer', tag, lastHandoff)

    // Verification commands can be expensive cumulative checks such as a
    // Pulumi preview. Run them for every verify-mode slice and once at the
    // final slice, rather than after every behavior-test slice. Exact command
    // duplicates are removed before the gate sees them.
    const shouldRunVerification = verifyOnly || isFinal
    const requestedCommands = uniqueCommands([
      { command: a.testCmd || '<auto-detect the project full-suite command once>', kind: 'suite' },
      ...((shouldRunVerification && a.verifyCmds) || []).map((command) => ({ command, kind: 'verification' })),
    ])
    const reusable = verificationLedger.filter((entry) => entry.kind === 'suite' && entry.environment === environmentKey).slice(-40).map((entry) => ({
      command: entry.command, kind: entry.kind, commitSha: entry.commitSha, treeSha: entry.treeSha,
      exitStatus: entry.exitStatus, treeChanged: entry.treeChanged,
      environment: entry.environment,
    }))
    const commandList = requestedCommands.map((entry, index) => `${index + 1}. [${entry.kind}] \`${entry.command}\``).join('\n')
    stats.agents++
    const g = await agent(
      `Mechanical gate only - do not read the brief or plan, inspect architecture, or produce design reasoning. In ${a.worktree}:\n${commandList}\nRun each distinct command at most once, in order. For the auto-detect placeholder, detect one full-suite command, run it once, and report the exact command. First record startSha=HEAD and startClean from both the index and working tree. Use Git tree object IDs, not status text, to prove content identity: before every executed command run \`git add -A\` then \`git write-tree\` as treeBefore; immediately afterward run \`git add -A\` then \`git write-tree\` as treeAfter. Set treeChanged to whether those IDs differ. Only suite results may be reused within this same run-scoped environment; verification commands can depend on credentials, time, or external state and must execute fresh. A suite result may be reused only when startClean is true, startSha equals its commitSha, \`git rev-parse startSha^{tree}\` equals its treeSha, command + kind + environment match exactly, exitStatus is 0, and treeChanged is false. Reusable ledger entries: ${JSON.stringify(reusable)}\nCapture each exit status and at most the last 40 relevant output lines. Any executed command with treeBefore != treeAfter is a gate failure: keep passed=false and let the next attempt rerun the full deduplicated list from the resulting state. Treat failed/erroring previews and unexpected replace/delete of protected resources as failures. Do NOT edit code or tests yourself. After all commands succeed without mutation, set verifiedTree to the final \`git write-tree\`. Commit the staged slice ("${s.title}") additively when changes exist (never --amend/--force); when clean HEAD was fully reused, no new commit is needed. Then compare \`git rev-parse HEAD^{tree}\` as committedTree with verifiedTree and set endClean from whether both the index and working tree exactly match HEAD after all commit hooks finish. A hook or formatter that changes either the committed tree or leaves uncommitted content makes the gate fail; the next attempt must verify that resulting state. Set passed=true only when committedTree == verifiedTree, endClean is true, validatedSha is the matching HEAD, and committed=true means that SHA is a committed code state. Otherwise keep passed=false and validatedSha empty. ${wtGuard} Return {passed, output, committed, validatedSha, startSha, startClean, endClean, verifiedTree, committedTree, commandResults}.`,
      { label: `gate:${i + 1}${retries ? `r${retries}` : ''}`, phase: a.phaseLabel, schema: GATE_SCHEMA, model: 'haiku', effort: 'low' }
    )
    const commandResults = (g && g.commandResults) || []
    const gatePassed = !!(
      g && g.passed && g.committed === true && g.validatedSha && g.endClean === true &&
      g.verifiedTree && g.verifiedTree === g.committedTree &&
      (!commandResults.some((result) => result.reused) || g.validatedSha === g.startSha) &&
      commandResults.length === requestedCommands.length &&
      commandResults.every((result, index) => {
        const requested = requestedCommands[index]
        const commandMatches = requested.command.startsWith('<auto-detect') || result.command.trim() === requested.command
        const contentMatches = result.treeBefore && result.treeBefore === result.treeAfter && result.treeChanged === false
        const reuseMatches = !result.reused || (
          result.kind === 'suite' && g.startClean === true && reusable.some((entry) =>
            entry.command === result.command && entry.kind === result.kind &&
            entry.commitSha === g.startSha && entry.treeSha === g.verifiedTree && entry.exitStatus === 0 &&
            entry.treeChanged === false && entry.environment === environmentKey
          )
        )
        return commandMatches && contentMatches && reuseMatches && result.kind === requested.kind && result.exitStatus === 0
      })
    )
    for (const result of commandResults) {
      if (result.reused) stats.reusedChecks++
      else if (result.kind === 'suite') stats.fullSuiteExecutions++
      else stats.verificationExecutions++
      verificationLedger.push({
        command: result.command,
        kind: result.kind,
        commitSha: gatePassed ? g.validatedSha : '',
        treeSha: gatePassed ? g.verifiedTree : '',
        exitStatus: result.exitStatus,
        treeChanged: result.treeChanged,
        environment: environmentKey,
        output: result.output || '',
      })
    }
    if (gatePassed) break
    retries++
    lastFail = (g && g.output) || (g && g.passed ? 'gate claimed success without a committed validated SHA or with incomplete/mutating command results' : 'unknown failure')
    if (retries > a.maxSliceRetries) {
      stuck.push({ slice: s.title, reason: lastFail })
      log(`${tag}: exhausted ${a.maxSliceRetries} retries — recording and moving on`)
      break
    }
    stats.retries++
  }
}

return { noteEntries, stuck, verificationLedger, stats }

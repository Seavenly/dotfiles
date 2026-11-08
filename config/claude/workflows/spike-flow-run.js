export const meta = {
  name: 'spike-flow-run',
  description: 'Execution engine for /spike-flow (launched by the command): quick = single researcher → synthesizer; deep = parallel researchers across angles → critic gap-analysis → revision pass → synthesizer; optional prototype via the shared tdd-slice-loop. Cross-checked synthesis replaces mailbox debate.',
  phases: [
    { title: 'Research', detail: 'researcher(s) investigate the question' },
    { title: 'Critique', detail: 'critic gap-analysis (deep only)' },
    { title: 'Prototype', detail: 'optional TDD-built prototype' },
    { title: 'Synthesize', detail: 'synthesizer writes the spike report' },
  ],
}

// args (built by the host command before launch):
//   runDir, outDir, repo, worktree|null, base|null, briefPath, slug, testCmd|null
//   depth ('quick'|'deep'), angles[] (deep), prototype (bool), prototypePath
//   maxSliceRetries
// args can arrive as a JSON-encoded string when launched by name — normalize.
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const repoNote = a.worktree
  ? `A writable worktree is at ${a.worktree} (cd there for prototype work).`
  : `The repo is read-only for this run — write only under ${a.outDir}.`

const VERDICT_SCHEMA = {
  type: 'object', required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'FIX_LIST'] },
    note: { type: 'string' },
    items: { type: 'array', items: {
      type: 'object', required: ['gap', 'angle'],
      properties: { gap: { type: 'string' }, angle: { type: 'string' }, ask: { type: 'string' } },
    } },
  },
}

// ── Phase: Research ────────────────────────────────────────────────
phase('Research')
let research = [] // [{angle, md}]
if (a.depth === 'quick') {
  const md = await agent(
    `Read the brief at ${a.briefPath}. Investigate the question. ${repoNote}\nProduce a focused, evidence-cited brief following the researcher role format (Answer / Evidence with file:line or doc refs / Caveats & gaps). Return the markdown as your final message.`,
    { label: 'researcher', phase: 'Research', agentType: 'researcher' }
  )
  research.push({ angle: 'overall', md: md || '' })
} else {
  const angles = a.angles && a.angles.length ? a.angles : ['technical feasibility', 'operational implications', 'prior art / ecosystem']
  const results = await parallel(angles.map((angle) => () =>
    agent(
      `You investigate the **${angle}** angle of the question in the brief at ${a.briefPath}. Stay tightly within this angle — peers cover the others. ${repoNote}\nProduce focused findings (researcher role format), citing file:line or doc refs for every claim and flagging gaps/speculation explicitly. Return the markdown as your final message.`,
      { label: `research:${angle.slice(0, 20)}`, phase: 'Research', agentType: 'researcher' }
    ).then((md) => ({ angle, md: md || '' }))
  ))
  research = results.filter(Boolean)
}
function researchBlock() {
  return research.map((r) => `### Angle: ${r.angle}\n${r.md}`).join('\n\n')
}

// ── Phase: Critique (deep only — gap analysis + revision) ──────────
if (a.depth === 'deep') {
  phase('Critique')
  // One critic+revision cycle by default; a token-budget directive with real
  // headroom buys a second cycle so the revision itself gets re-checked.
  const maxRevisions = budget.total && budget.remaining() > 150_000 ? 2 : 1
  let rev = 0
  while (rev < maxRevisions) {
    const v = await agent(
      `You are the spike-flow critic for run ${a.slug}. Operate in Mode C per your role definition. Read the brief at ${a.briefPath}. The researchers' findings:\n\n${researchBlock()}\n\nDid they answer the brief's ACTUAL question? Are claims evidence-backed? What's missing? Return APPROVE, or FIX_LIST with each gap addressed to a specific angle. Operate on the findings alone.`,
      { label: `critic:gaps${rev ? rev + 1 : ''}`, phase: 'Critique', agentType: 'critic', schema: VERDICT_SCHEMA }
    )
    if (!v || v.verdict !== 'FIX_LIST' || !(v.items || []).length) break
    log(`critic flagged ${v.items.length} gap(s) — revision pass ${rev + 1}/${maxRevisions}`)
    const fixes = await parallel(v.items.map((it) => () => {
      const prior = research.find((r) => r.angle === it.angle)
      return agent(
        `Revise the **${it.angle}** angle of the spike to address this gap: ${it.gap}. Specific ask: ${it.ask || '(close the gap with evidence)'}. Read the brief at ${a.briefPath}. ${repoNote}\nYour angle's current findings — revise these (keep what holds, fix the gap; don't redo the angle from scratch):\n\n${prior ? prior.md : '(no prior findings for this angle — produce fresh findings)'}\n\nReturn the UPDATED full findings markdown for your angle.`,
        { label: `revise:${String(it.angle).slice(0, 16)}`, phase: 'Critique', agentType: 'researcher' }
      ).then((md) => ({ angle: it.angle, md: md || '' }))
    }))
    // Merge revised angles back over the originals.
    for (const f of fixes.filter(Boolean)) {
      const idx = research.findIndex((r) => r.angle === f.angle)
      if (idx >= 0) research[idx] = f; else research.push(f)
    }
    rev++
  }
}

// ── Phase: Prototype (optional — shared TDD loop, no critic outer pass) ─
let prototypeNote = 'no prototype'
let prototypeStuck = []
if (a.prototype && a.worktree) {
  phase('Prototype')
  const scope = a.prototypePath || `experiments/${a.slug}/`
  const plan = await agent(
    `Work in the worktree at ${a.worktree}; scope all code to ${scope}. cd there for commands.\nRead the brief at ${a.briefPath} and the research findings:\n${researchBlock()}\nProduce a minimal-prototype vertical-slice plan scoped to ${scope}; write it to ${a.outDir}/plan.md and return the slices via structured output.`,
    { label: 'planner', phase: 'Prototype', agentType: 'planner', schema: { type: 'object', required: ['slices'], properties: { slices: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, behavior: { type: 'string' }, testIdea: { type: 'string' }, nonTestable: { type: 'boolean' } } } } } } }
  )
  const slices = (plan && plan.slices) || []
  if (slices.length) {
    try {
      const r = await workflow('tdd-slice-loop', {
        worktree: a.worktree, briefPath: a.briefPath, planPath: `${a.outDir}/plan.md`,
        slug: a.slug, testCmd: a.testCmd, maxSliceRetries: a.maxSliceRetries,
        slices,
        finalSliceNote: 'Final slice — exercise the prototype end-to-end so a user can run it.',
        scopeNote: `Scope all code to ${scope}.`, phaseLabel: 'Prototype',
        notesHeader: `# Prototype notes — ${a.slug}`, noteEntries: [],
      })
      prototypeStuck = (r && r.stuck) || []
    } catch (e) {
      log(`tdd-slice-loop failed to launch: ${e && e.message ? e.message : e}`)
      prototypeStuck = slices.map((s) => ({ slice: s.title, reason: 'tdd-slice-loop sub-workflow failed to launch' }))
    }
  }
  prototypeNote = `prototype on ${a.worktree} under ${scope}`
}

// ── Phase: Synthesize ──────────────────────────────────────────────
phase('Synthesize')
const stuckCtx = prototypeStuck.length ? ` ${prototypeStuck.length} prototype slice(s) got stuck (${prototypeStuck.map((s) => s.slice).join('; ')}) — say so honestly in the Prototype section.` : ''
const protoCtx = a.prototype && a.worktree ? `\nA prototype was built (${prototypeNote}); run \`git diff ${a.base || 'main'}...HEAD\` in the worktree to see it, and fill the Prototype section (key files, worth-keeping vs. discard).${stuckCtx}` : ''
await agent(
  `Read the brief at ${a.briefPath}. The researchers' findings (use these as your evidence base):\n\n${researchBlock()}${protoCtx}\nWrite ${a.outDir}/report.md following the spike-flow format in your role definition. The TL;DR must directly answer the brief's question. Don't promise more than the evidence supports — surface gaps honestly.`,
  { label: 'synthesizer', phase: 'Synthesize', agentType: 'synthesizer' }
)

return {
  reportPath: `${a.outDir}/report.md`,
  depth: a.depth,
  angles: research.map((r) => r.angle),
  prototype: prototypeNote,
  prototypeStuck,
}

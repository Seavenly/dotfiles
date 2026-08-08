---
description: Reflect on a just-finished agent-teams workflow run and emit transferable process patterns (avoid/add/stress) to the run's retro.md for /retro-consume to apply. Flow-agnostic — run it in the conversation after a feature / review / spike workflow returns.
---

You are writing a **retro** for the agent-teams workflow that just
finished in this conversation. Run it when the work is done and you (or
the user) want to capture what the run taught us about *how the team
works* — not about the code it produced.

## What a retro is for

The companion `/retro-consume` command reads the file you write and edits
the actual agent personas, workflow scripts, flow commands, and docs under
`~/.claude`. This file is the channel between what the run
revealed and the prompts/scripts that drive the next run. Be concrete and
honest.

## Hard rule — generic patterns only

Record only **transferable, high-level patterns** about how the team
operated. NOT anything specific to this codebase, feature, PR, or
question; not implementation details, repo file names, or bug specifics;
not one-off facts that won't recur. If a lesson wouldn't help a completely
different run in a different repo, it does not belong here. Ask: "is this
about the *process*, or about *this code*?" Only process belongs.

## Privacy rule - assume the eventual ledger is public

The run artifact is host-local, but `/retro-consume` may turn it into a
version-controlled ledger entry. Do not put sensitive work context in the
retro body:

- no organization, customer, repository, project, service, feature, branch,
  ticket, PR, incident, or employee identifiers
- no internal URLs, hostnames, account identifiers, credentials, or local
  paths copied from the work repository
- no production incident narratives, vulnerability details, proprietary
  architecture, or deployment topology

Describe the process failure at the highest useful level. For example, write
"composition-dependent behavior was tested only in isolation," not the
affected service, component chain, or production symptom. Keep `run_id` only
in frontmatter for host-local lookup; do not repeat it in prose or headings.

## Steps

1. **Identify the run.** The flow type (`feature` | `review` | `spike`)
   and `run_id` from the brief you launched. Record both.
2. **Reflect on the run.** Use what you can see: the `/workflows` progress
   view (phases, per-agent results, retries, where an agent stalled or got
   stuck), the artifacts in the run dir's `out/`, the workflow's return
   value (stuck slices, open findings, critic revisions), and the saved
   workflow script itself. Look for: where a phase under- or over-did its
   job, where a spawn prompt was ambiguous or contradictory, where the
   wiring (fan-out, retry budget, cap, gate) was wrong, where a role
   drifted.
3. **Sort findings into three buckets** (omit a bucket if empty):
   - **AVOID** — a pattern that hurt the run and should be discouraged.
   - **ADD** — a pattern that was missing and would have helped.
   - **STRESS** — a pattern already present but not followed / not emphasized enough.
4. **Map each item to a candidate target.** Point each pattern at the file
   most likely to own it:
   - `agents/<role>.md` — planner, researcher, tester, implementer, critic, synthesizer, diagrammer (persona / judgment)
   - `workflows/<flow>-run.js` — orchestration: fan-out shape, retry/cap budgets, gate, phase order, spawn-prompt wording
   - `commands/<flow>-flow.md` — the interactive front half: interview, brief, worktree/setup, wrap-up
   - `AGENT-TEAMS.md` — if the gap is in how the run is framed or set up overall
   This is a suggestion; `/retro-consume` (and the user) make the final call.
5. **Write the retro to the run dir** — `<run_dir>/out/retro.md`:

```markdown
---
type: retro
run_id: <run_id from brief>
flow: <feature|review|spike>
created: <ISO timestamp>
---

# Retro - <flow> run

## AVOID
- **<short pattern name>** — <what happened, generically> ·
  _target:_ `workflows/feature-flow-run.js`

## ADD
- **<short pattern name>** — <what was missing> ·
  _target:_ `commands/feature-flow.md`

## STRESS
- **<short pattern name>** — <present but ignored / under-weighted> ·
  _target:_ `agents/implementer.md`

## Notes for the consumer
<conflicting signals, low-confidence items, "only change this if it recurs", etc.>
```

6. **Tell the user** where you wrote it:
   ```
   ✓ retro written → <run_dir>/out/retro.md
     Apply with:  /retro-consume            (uses the latest retro)
              or  /retro-consume <run_id>
   ```

Keep it tight — a handful of high-signal items beats a long list of
platitudes. If the run was clean and you have nothing transferable to say,
write that plainly rather than padding. Distinguish an orchestration
problem (fix the `.js`) from a judgment problem (fix the role `.md`) —
that distinction is the most useful thing you can give the consumer.

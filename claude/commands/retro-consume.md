---
description: Consume an agent-teams retro file and apply its process patterns to the prompts / personas / docs under ~/.dotfiles/claude, then append to the retro ledger. Args — optional run_id or path to a retro.md (defaults to the most recent run that has one).
---

You are applying a retro produced by an agent-teams run. The `/retro`
command wrote a `retro.md` describing transferable process patterns
(avoid / add / stress). Your job: turn those patterns into concrete edits
to the prompts, workflow scripts, and docs, and record what you did in the
ledger.

User's invocation: `/retro-consume $ARGUMENTS`

## Step 1 — Locate the retro

- If `$ARGUMENTS` is a path to a file, use it.
- If `$ARGUMENTS` is a run_id, use `~/.agent-teams/runs/<run_id>/out/retro.md`.
- If empty, find the most recent retro:
  ```bash
  ls -1dt ~/.agent-teams/runs/*/out/retro.md 2>/dev/null | head -1
  ```
  If none exists, say so and stop.

Read the retro. Its frontmatter gives you `flow` and `run_id` directly —
you don't need to re-derive them. Read the body's AVOID / ADD / STRESS
items and their suggested `target:` files.

## Step 2 — Read the ledger for history

Read `~/.dotfiles/claude/RETRO-LEDGER.md` (create it from the template in
Step 5 if missing). Before applying anything, check each incoming pattern
against the ledger:
- **Corroborates** a prior entry → stronger signal; apply with confidence
  and note the corroboration.
- **Conflicts** with a prior entry (e.g. a past retro added what this one
  wants to remove) → do NOT silently flip it. Surface the conflict to the
  user with both ledger entries and ask how to resolve.
- **Was reverted before** → mention that history; don't blindly re-apply.

The ledger is the memory that keeps single-run noise from thrashing the
prompts. Use it.

## Step 3 — Apply the edits

Scope: anything under `~/.dotfiles/claude` is fair game:
- `agents/<role>.md` — persona / judgment (planner, researcher, tester, implementer, critic, synthesizer, diagrammer)
- `workflows/<flow>-run.js` — orchestration: fan-out shape, retry/cap budgets, gate, phase order, spawn-prompt wording
- `commands/<flow>-flow.md` — the interactive front half (interview, brief, worktree/setup, wrap-up); `commands/retro*.md`
- `AGENT-TEAMS.md` — overall framing

A key triage: is the pattern a **judgment** problem (edit the role `.md`)
or an **orchestration** problem (edit the workflow `.js` — wiring, budgets,
the wording of a spawn prompt that lives in the script)? Put each edit
where the behavior actually originates.

For each retro item:
1. Open the suggested target. Verify it's the right owner — if the pattern
   actually belongs elsewhere, retarget it (the retro only guessed).
2. Make a **surgical, generic edit** that encodes the pattern, matching the
   file's existing voice and structure. AVOID → add a "don't" / guardrail.
   ADD → introduce the missing instruction. STRESS → strengthen or move up
   the existing instruction.
3. Keep edits transferable — never bake in anything specific to the run's
   repo or feature.
4. **Challenge the item's generality before applying it.** A retro can
   state a one-off confidently and phrase it generically, yet it's really
   an artifact of *this* PR's situation. For each item, articulate the
   cross-PR case in one sentence: "this would have helped on a different
   repo/feature because ___." If you can't — if the only honest story is
   "this came up once, here" — treat it as observed-but-not-applied and log
   it rather than baking it into a persona. Corroboration in the ledger
   satisfies this test on its own; a confident-but-uncorroborated,
   plausibly-PR-specific item does not.
5. If an item is low-confidence, conflicts, or the retro flagged it "only
   if it recurs" and the ledger shows no prior occurrence, do NOT edit —
   log it to the ledger as observed-but-not-applied instead.

Apply directly (the user reviews via git). Don't ask file-by-file.

## Step 4 — Report

Print a summary: each pattern, the file you edited (or skipped + why), and
any conflicts you surfaced. Then:
```
Applied retro <run_id> (<flow>). Review the edits:
  git -C ~/.dotfiles diff
Ledger updated: ~/.dotfiles/claude/RETRO-LEDGER.md
```

## Step 5 — Update the ledger

Append an entry to `~/.dotfiles/claude/RETRO-LEDGER.md`. If the file does
not exist, create it with this header first:

```markdown
# Retro ledger

Running record of process patterns surfaced by agent-teams retros and what
was done with them. Newest entries at the top. Lets us see patterns over
time, corroborate recurring ones, and revert changes that didn't pan out.
```

Then prepend (newest-first) an entry of this shape:

```markdown
## <date> — <run_id> (<flow>)

| Pattern | Bucket | Target | Action |
|---|---|---|---|
| <name> | AVOID  | agents/critic.md         | applied · corroborates 2026-05-10 entry |
| <name> | ADD    | commands/feature-flow.md | applied |
| <name> | STRESS | agents/implementer.md    | skipped — single occurrence, watching |
| <name> | ADD    | agents/tester.md         | skipped — no cross-PR case, PR-specific |

Notes: <conflicts surfaced, reverts, anything a future consumer should know>
```

## Reverting

If the user asks to revert a past retro's changes, use the ledger to find
which files an entry touched, revert those edits (`git -C ~/.dotfiles` log
helps), and append a new ledger entry recording the revert and why.

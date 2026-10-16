---
name: grill-with-docs
description: A relentless interview that sharpens a plan, decision, or idea while maintaining the project's domain glossary and architectural decisions.
disable-model-invocation: true
---

# Grill With Docs

Interview the user relentlessly about every aspect of their plan, decision, or
idea until you reach shared understanding. Map it as a **design tree**: every
decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose
prerequisites are already settled: the questions you can ask now without
guessing at answers you have not heard yet. Ask the whole frontier in one round,
number each question, give your recommended answer, then wait for the user's
answers before the next round. Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round of answers reshapes the tree: settled decisions push the frontier
outward and unblock the questions that depended on them. Recompute the frontier
and ask the next round. A question whose answer depends on another question
still open in this round belongs to a later round.

Finding facts is your job, never the user's. When a frontier question needs a
fact from the environment (filesystem, tools, and other available sources),
delegate the lookup to a subagent when the harness supports it, or look it up
directly otherwise; do not ask the user for anything you could find yourself.
Do not block on a running lookup: only the questions downstream of it wait, so
ask the rest of the frontier now. Decisions belong to the user: put each one to
them and wait.

The session is done when the frontier is empty: every branch of the design
tree visited, nothing left silently assumed. Do not act on it until the user
confirms that the shared understanding is complete.

## Maintain the domain model

Read the relevant `GLOSSARY.md`, `GLOSSARY-MAP.md`, and ADRs before questioning.
As decisions crystallize, maintain those documents inline rather than batching
updates at the end.

### Sharpen language

- Call out terms that conflict with the existing glossary.
- Replace vague or overloaded words with a proposed canonical term.
- Invent concrete edge cases that force boundaries and relationships to become
  precise.
- Cross-check claims about current behavior against the code and surface any
  contradiction.

When a term is resolved, update the relevant `GLOSSARY.md` using
[GLOSSARY-FORMAT.md](GLOSSARY-FORMAT.md). Create it lazily if needed.
`GLOSSARY.md` is a domain glossary, not a specification, scratch pad, or
implementation map.

### Record durable decisions

Offer an ADR only when a decision is all three of:

1. Hard to reverse.
2. Surprising without context.
3. The result of a real trade-off.

When accepted, write it using [ADR-FORMAT.md](ADR-FORMAT.md). Create the ADR
directory lazily. Skip reversible, obvious, or consequence-free choices.

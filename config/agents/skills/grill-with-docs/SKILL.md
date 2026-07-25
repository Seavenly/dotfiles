---
name: grill-with-docs
description: A relentless interview that sharpens a plan, decision, or idea while maintaining the project's domain glossary and architectural decisions.
disable-model-invocation: true
---

# Grill With Docs

Interview the user relentlessly about every aspect of their plan, decision, or
idea until you reach shared understanding. Walk the decision tree one decision
at a time, resolving dependencies before moving on. For each question, provide
a recommended answer.

Ask one question at a time and wait for feedback. Multiple questions at once
make it hard to resolve the decision tree cleanly.

Look up facts in the environment (filesystem, tools, and other available
sources) instead of asking the user. Decisions belong to the user: put each one
to them and wait for an answer. Do not act on it until the user confirms that
the shared understanding is complete.

## Maintain the domain model

Read the relevant `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs before questioning.
As decisions crystallize, maintain those documents inline rather than batching
updates at the end.

### Sharpen language

- Call out terms that conflict with the existing glossary.
- Replace vague or overloaded words with a proposed canonical term.
- Invent concrete edge cases that force boundaries and relationships to become
  precise.
- Cross-check claims about current behavior against the code and surface any
  contradiction.

When a term is resolved, update the relevant `CONTEXT.md` using
[CONTEXT-FORMAT.md](CONTEXT-FORMAT.md). Create it lazily if needed.
`CONTEXT.md` is a domain glossary, not a specification or implementation map.

### Record durable decisions

Offer an ADR only when a decision is all three of:

1. Hard to reverse.
2. Surprising without context.
3. The result of a real trade-off.

When accepted, write it using [ADR-FORMAT.md](ADR-FORMAT.md). Create the ADR
directory lazily. Skip reversible, obvious, or consequence-free choices.

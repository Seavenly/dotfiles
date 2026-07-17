---
name: agent-flow-spike
description: Run a bounded quick or deep investigation through Hermes, preserving evidence, residual gaps, and optional prototype work without treating research as production implementation. Use when the user asks for a spike, technical investigation, option comparison, feasibility study, or disposable prototype through agent-flow.
---

# Agent Flow Spike

Choose the smallest mode that answers the decision:

- Use `quick` for one research pass followed by synthesis.
- Use `deep` for named parallel angles, a gap critic, bounded gap-specific
  revision, and synthesis that retains residual uncertainty.
- Enable `prototype` only when executable evidence materially answers the
  question. The launcher creates exactly one disposable worktree for it.

Research-only spikes must not create a product worktree or modify product Git
refs. Prototype writers use only the launcher-provided absolute worktree.

Launch or resume with the same immutable manifest:

```bash
agent-flow launch spike --manifest <absolute-spike.json>
agent-flow status --run <run-id> --json
```

Treat cap exhaustion as a reported residual gap, not a reason to discard prior
evidence. The synthesis must distinguish evidence, inference, rejected options,
open gaps, and any stuck prototype slice. Report absolute artifact and
prototype paths. Never push, open a PR, or promote prototype code into a feature
without a separate feature flow.

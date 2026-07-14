# Flow controller contract

## Purpose

Own native Hermes Kanban transitions for repository agent flows.

## Invariants

- Use Kanban as the only execution control plane.
- Never read or modify product files, run shell commands, browse, or delegate.
- Create only transitions declared by the selected versioned graph.
- End every worker attempt with `kanban_complete` or `kanban_block`.

## Expected capabilities

Native Kanban tools and card-pinned flow instructions.

# Flow controller contract

## Purpose

Own native Hermes Kanban transitions for repository agent flows.

## Invariants

- Use Kanban as the only execution control plane.
- Never read or modify product files, browse, or delegate.
- Use the terminal only for the exact `agent-flow` controller command pinned by
  the current card. Do not run general shell or Git commands.
- Create only transitions declared by the selected versioned graph.
- End semantic attempts with `kanban_complete` or `kanban_block`. Exit 3 is
  reserved for a pinned `agent-flow` command that has durably linked a declared
  transition and intentionally asks Hermes to retry this same card.

## Expected capabilities

Native Kanban tools, local terminal execution, and card-pinned flow
instructions. Terminal restriction is contractual because Hermes v0.18.2 does
not provide per-command allowlists inside a profile.

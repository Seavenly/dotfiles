# Builder contract

## Purpose

Implement and revise one serialized product slice in the assigned worktree.

## Invariants

- Write only inside the absolute worktree named by the card.
- Preserve unrelated user changes and obey repository guidance.
- Run the declared focused verification before completing.
- End every worker attempt with `kanban_complete` or `kanban_block`.

## Expected capabilities

File operations, terminal commands, and card-pinned implementation
instructions.

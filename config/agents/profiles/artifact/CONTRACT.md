# Artifact contract

## Purpose

Create declared reports, diagrams, and synthesis artifacts without owning
product implementation.

## Invariants

- Write only the absolute artifact paths declared by the card.
- Do not modify product code or configuration.
- Preserve traceability from source evidence to the rendered artifact.
- End every worker attempt with `kanban_complete` or `kanban_block`.

## Expected capabilities

File operations and card-pinned artifact instructions.

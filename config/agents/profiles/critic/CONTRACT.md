# Critic contract

## Purpose

Provide an independent adversarial review of plans, evidence, and code.

## Invariants

- Use a provider distinct from the builder lane.
- Treat the assigned repository and workspace as read-only.
- Never use file write, patch, or edit operations even though Hermes v0.18.2
  exposes them in the bundled `file` toolset.
- End every worker attempt with `kanban_complete` or `kanban_block`.

## Expected capabilities

Bundled file inspection and search, optional web research, and task-pinned
critical-review instructions.

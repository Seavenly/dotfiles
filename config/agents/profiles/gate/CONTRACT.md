# Gate contract

## Purpose

Run a deterministic command declared by a versioned gate specification and
report its exit status and durable output.

## Invariants

- Execute only the exact command and workspace declared by the gate spec.
- Do not edit files directly or reinterpret a failing exit status.
- Keep logs concise and store full output at the declared artifact path.
- End every worker attempt with `kanban_complete` or `kanban_block`.

## Expected capabilities

Terminal execution and task-pinned deterministic gate instructions.

---
status: superseded as the required replacement Flow backend by ADR-0010
---

# Use Drovr as the delegated agent runtime

New multi-agent automation uses Drovr, a host-local interface over a dedicated
Herdr session and native Claude Code and Codex transcripts, as its delegated
agent runtime. Drovr owns durable agent and logical-turn mechanics but never
flow scheduling, tracker, worktree, or integration policy; those remain in a
separate calling flow. This supersedes ADR-0004 as the direction for new work
because Hermes Kanban introduced scheduler and lifecycle complexity that is not
needed for agent delegation. Existing Hermes and Claude-only flows remain
unchanged until a separate migration is explicitly authorized.

ADR-0010 selects direct CLI tasks as the primary replacement Flow backend and
retains this adapter as optional. Existing Drovr evidence remains historical
and is never relabeled as direct qualification.

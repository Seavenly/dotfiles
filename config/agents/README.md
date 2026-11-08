# Agent configuration

This concern owns configuration shared across AI agent harnesses. Keep portable
concepts here and keep harness-specific global settings under their application
directories.

## Layout

- `AGENTS.global.md` contains personal instructions that apply across
  repositories.
- `skills/` contains the effective, version-controlled Agent Skills exposed to
  supported harnesses.
- `profiles/` groups role definitions by purpose, with full native variants for
  Claude Code and Codex as needed. The retained Hermes variants are frozen
  historical evidence and are no longer installed.

Repository guidance remains in the root `AGENTS.md`. A root `CLAUDE.md` symlink
exposes the same guidance to Claude Code. When a repository needs Claude-only
guidance, replace that symlink with a small `CLAUDE.md` that imports
`AGENTS.md` before adding the Claude-specific instructions.

## Ownership boundary

Only authored configuration belongs here. Credentials, memories, sessions,
logs, caches, databases, downloaded plugins, and other runtime state remain
machine-local configuration outside Git.

Skills are the portable unit and may be shared directly. Profile definitions
are semantic siblings: keep each harness's complete native format rather than
generating all variants from a common schema.

## Skill discovery

Mise exposes each managed skill as a directory symlink while preserving
harness-owned entries alongside it. Directory links are required because Codex
does not discover a real skill directory whose `SKILL.md` is itself a symlink:

- `~/.agents/skills/` for Codex and the agent-neutral user scope.
- `~/.claude/skills/` for Claude Code.

The repository package is authoritative. Do not edit a linked copy under a
harness directory; update the effective package and its lineage here.

Hermes and its agent-flow skills are retired from convergence and discovery.
The frozen packages remain in Git for Flow baseline audits and read-only legacy
inventory; they are not supported launch paths.

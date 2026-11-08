---
schema_version: 1
kind: derivative
sources:
  - id: upstream-retro
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/retro
    revision: 49dd158d1076134a641b33efb035946536778336
---

# Lineage intent

Preserve upstream's environment retrospective: review a session and propose
repository-specific improvements to navigation pointers, automated checks,
coding standards, steering files, tool economy, and information access.

## Customizations

- Rename the package from `retro` to `repo-retro`. The local `/retro` command
  (`config/claude/commands/retro.md`) is a different workflow: it extracts
  transferable, repository-agnostic process patterns for `/retro-consume`.
  Distinct names keep invocation unambiguous across harnesses.
- Describe the repository-specific scope in the frontmatter description and the
  Codex display metadata so the two retrospectives are distinguishable.

## Update policy

Apply relevant upstream improvements while preserving the distinct name and
description.

---
schema_version: 1
kind: mirror
sources:
  - id: upstream-research
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/research
    revision: 49dd158d1076134a641b33efb035946536778336
---

# Lineage intent

Track upstream's background research workflow unchanged. `wayfinder`
resolves its research tickets with this skill, so it is carried to keep that
dependency satisfied.

## Harness exposure

Linked for Claude Code and Codex only. Hermes keeps its own bundled `research`
skill category at `~/.hermes/skills/research`, and a managed link at that path
would replace it, so `mise.toml` deliberately omits the Hermes link.

## Update policy

Review and mirror relevant upstream package updates.

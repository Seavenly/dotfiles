---
schema_version: 1
kind: derivative
sources:
  - id: upstream-codebase-design
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/codebase-design
    revision: ed37663cc5fbef691ddfecd080dff42f7e7e350d
---

# Lineage intent

Preserve upstream's deep-module vocabulary and interface-design discipline
across all supported agent harnesses.

## Customizations

- Express the design-it-twice parallel work in harness-neutral agent language
  rather than naming Claude's `Agent` tool.

## Update policy

Apply relevant upstream improvements while preserving harness portability.

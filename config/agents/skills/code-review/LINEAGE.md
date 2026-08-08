---
schema_version: 1
kind: derivative
sources:
  - id: upstream-code-review
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/code-review
    revision: ed37663cc5fbef691ddfecd080dff42f7e7e350d
---

# Lineage intent

Preserve upstream's independent standards and specification review axes across
all supported agent harnesses.

## Customizations

- Express independent review passes in harness-neutral subagent language rather
  than naming Claude's `Agent` tool.

## Update policy

Apply relevant upstream improvements while preserving harness portability.

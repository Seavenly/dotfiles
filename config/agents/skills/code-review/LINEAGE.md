---
schema_version: 1
kind: derivative
sources:
  - id: upstream-code-review
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/code-review
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
---

# Lineage intent

Preserve upstream's independent standards and specification review axes across
all supported agent harnesses.

## Customizations

- Express independent review passes in harness-neutral subagent language rather
  than naming Claude's `Agent` tool.

## Update policy

Apply relevant upstream improvements while preserving harness portability.

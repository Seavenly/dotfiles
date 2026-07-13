---
schema_version: 1
kind: composite
sources:
  - id: upstream-implement
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/implement
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
  - id: upstream-tdd
    relationship: component
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/tdd
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
  - id: upstream-code-review
    relationship: component
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/code-review
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
---

# Lineage intent

Provide a self-contained ticket implementation workflow with test-first
execution and independent standards/specification review.

## Customizations

- Bundle the TDD and code-review procedures as local references.
- Express independent review passes in harness-neutral agent language.
- Use the supplied spec or ticket directly when repository tracker guidance is
  absent instead of invoking a setup skill.

## Update policy

Review all three sources together and preserve the self-contained composition.

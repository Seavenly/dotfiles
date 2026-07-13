---
schema_version: 1
kind: composite
sources:
  - id: upstream-grill-with-docs
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/grill-with-docs
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
  - id: upstream-grilling
    relationship: component
    repository: https://github.com/mattpocock/skills.git
    path: skills/productivity/grilling
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
  - id: upstream-domain-modeling
    relationship: component
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/domain-modeling
    revision: 391a2701dd948f94f56a39f7533f8eea9a859c87
---

# Lineage intent

Provide one self-contained grilling workflow that maintains domain terminology
and architectural decisions without requiring nested skill invocation.

## Customizations

- Inline the upstream grilling interaction loop.
- Inline the upstream domain-modeling procedure and bundle its document formats.

## Update policy

Review all three sources together and preserve the self-contained composition.

---
schema_version: 1
kind: mirror
sources:
  - id: upstream-write-a-skill
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/productivity/write-a-skill
    revision: e74f0061bb67222181640effa98c675bdb2fdaa7
---

# Lineage intent

Preserve upstream's complete, harness-portable skill creation workflow at the
last installed revision where it existed.

The later `writing-great-skills` package at revision
`391a2701dd948f94f56a39f7533f8eea9a859c87` was reviewed but not adopted: it is
a useful editing reference, not a replacement for the end-to-end creation
workflow needed by harnesses without a built-in skill creator.

Upstream later renamed that package `writing-for-agents` and widened it to any
agent-facing document. It was reviewed again at revision
`49dd158d1076134a641b33efb035946536778336` and is now carried as its own
`writing-for-agents` mirror, alongside this workflow rather than replacing it:
it still has no gather, scaffold, or review procedure.

## Update policy

Retain this historical mirror unless upstream publishes a complete portable
successor. Review successors deliberately rather than replacing it by name.

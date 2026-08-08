---
schema_version: 1
kind: mirror
sources:
  - id: upstream-i-have-adhd
    relationship: base
    repository: https://github.com/ayghri/i-have-adhd.git
    path: skills/i-have-adhd
    revision: 0241185d6c7f2d0763a988ce52eceb13ea9f5c1f
---

# Lineage intent

Track upstream's ADHD-oriented output-shaping skill unchanged. Only `SKILL.md`
is mirrored; the upstream `agents/openai.yaml` is a Codex plugin artifact and is
not part of the effective package.

## Update policy

Review and mirror relevant upstream package updates.

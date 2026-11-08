---
schema_version: 1
kind: mirror
sources:
  - id: upstream-i-have-adhd
    relationship: base
    repository: https://github.com/ayghri/i-have-adhd.git
    path: skills/i-have-adhd
    revision: 1ecea1993b7fce257ffbd686c070948b5e07eda6
---

# Lineage intent

Track upstream's ADHD-oriented output-shaping skill unchanged. Only `SKILL.md`
is mirrored; the upstream `agents/openai.yaml` is a Codex plugin artifact and is
not part of the effective package.

## Update policy

Review and mirror relevant upstream package updates.

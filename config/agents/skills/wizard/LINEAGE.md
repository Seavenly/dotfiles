---
schema_version: 1
kind: mirror
sources:
  - id: upstream-wizard
    relationship: base
    repository: https://github.com/mattpocock/skills.git
    path: skills/engineering/wizard
    revision: 49dd158d1076134a641b33efb035946536778336
---

# Lineage intent

Track upstream's generator for interactive scripts that walk a human through
steps only a human can perform unchanged. Everything above the `STAGES` marker
in `template.sh` is upstream's fixed library.

## Update policy

Review and mirror relevant upstream package updates.

# Managed skills

This directory contains effective Agent Skill packages. Each child skill is a
normal directory with a required `SKILL.md` and optional `references/`,
`scripts/`, and `assets/` directories.

Skills created locally need no additional metadata. An externally sourced or
composed skill includes a `LINEAGE.md` beside `SKILL.md`.

## `LINEAGE.md`

The file uses YAML frontmatter for machine-readable source state and Markdown
for human- and agent-readable transformation intent. Supported kinds are:

- `mirror`: an intentionally unchanged upstream skill.
- `derivative`: a primary upstream skill with local changes.
- `composite`: material combined from multiple sources.

Example:

```markdown
---
schema_version: 1
kind: derivative
sources:
  - id: upstream-diagnose
    relationship: base
    repository: https://github.com/example/skills.git
    path: skills/diagnose
    revision: 0123456789abcdef
---

# Lineage intent

Preserve the upstream diagnostic loop while applying local authorization and
repository-discovery conventions.

## Customizations

- Diagnosis does not authorize implementation.
- Read the repository's domain documentation before forming hypotheses.

## Update policy

Apply relevant upstream improvements while preserving the customizations
above. Surface contradictions for review instead of resolving them silently.
```

An updater uses each recorded revision as the merge base, fetches source trees
into an ignored temporary cache, and updates the committed effective skill.
The `references/` directory is runtime material for the skill, not a store for
upstream snapshots.

The update process must never overwrite `LINEAGE.md` with upstream content.
After a successful update it records the newly incorporated revisions.

Thin orchestration wrappers may be made self-contained by combining their
upstream component workflows into one package. Record these as `composite` and
list every material component source; retain standalone components only when
they remain useful for direct invocation.

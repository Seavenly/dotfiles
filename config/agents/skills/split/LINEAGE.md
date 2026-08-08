---
schema_version: 1
kind: mirror
sources:
  - id: upstream-split
    relationship: base
    repository: https://github.com/Iron-Ham/split.git
    path: skills/split
    revision: 5eec1a6d6cac27cb512ed9b5040d3c3c4b9c3d78
---

# Lineage intent

Mirror the upstream `/split` skill unchanged. It analyzes the current branch's
diff against a base branch, groups the changes into N logical units with
hunk-level granularity, and creates a linear stack of branches (branch K
contains groups 1..K), each ready to open as a PR targeting the one below it.

Kept verbatim so upstream improvements apply cleanly. Local adaptations, if any
are needed later, should convert this entry to `derivative`.

## Known integration gap

Upstream ships as a Claude Code plugin and resolves its helper script through
`${CLAUDE_PLUGIN_ROOT}` (see `SKILL.md` Phase 1). This package is exposed as a
managed skill via directory symlinks rather than a plugin, so that variable is
not set in every harness. If the skill cannot locate
`scripts/split_diff.py` at runtime, the fix is a local `derivative` change to
resolve the script relative to the skill directory. Left unmodified here to keep
the mirror faithful and surface the contradiction for review.

## Update policy

Track upstream as an unmodified mirror. On update, record the newly incorporated
revision above. Never overwrite this file with upstream content.

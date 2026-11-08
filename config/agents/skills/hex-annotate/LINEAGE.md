---
schema_version: 1
kind: derivative
sources:
  - id: upstream-scrawl
    relationship: base
    repository: https://github.com/kitlangton/scrawl.git
    path: skills/scrawl
    revision: 7b184c67767a1aee6c1d44640d94d8446cd5fed1
---

# Lineage intent

Teach agents to read Hex Annotate captures. Hex 3 hosts Scrawl's capture
engine and writes Scrawl-format `.scrawl` bundles into Scrawl's captures
folder, so upstream's guide to reading a bundle (the paste format, contact
sheet, keyframes, marks, and manifest) still applies unchanged. Hex ships no
agent skill for Annotate, and the Scrawl app (with its `scrawl` CLI) is not
installed, so the tool-facing half is rewritten for Hex.

## Customizations

- Rename the package from `scrawl` to `hex-annotate` and describe Hex Annotate
  in the frontmatter, keeping upstream's paste and bundle triggers.
- Replace the `scrawl` CLI with `hex annotate` (`list`, `show`, `status`,
  `route`, `send`, `undo`). Never pass `send --always` unless asked.
- Replace `scrawl zoom`, `frames`, and `export` with ffmpeg on
  `recording.mp4`, writing to a temporary folder rather than into the bundle.
- Document the capture clock: `videoOffsetMs` maps capture time to video time.
- Document the `scrawl.json` keyframe and mark fields (`markId`, `boxNorm`),
  used to tell marks apart without `scrawl zoom --mark` or `inspect --marks`.
- Note that ink is in the video only with Annotate's "Show in screen
  recordings" setting on, and that `recording.mp4` has no audio track.

## Update policy

Hex imports Scrawl's capture engine, so upstream changes to the bundle format
or paste text matter here. Review upstream `skills/scrawl` changes manually,
apply format and reading changes, keep the Hex CLI and ffmpeg sections, and
verify against a real Hex capture before recording a new revision. Check
`hex annotate --help` when Hex updates.

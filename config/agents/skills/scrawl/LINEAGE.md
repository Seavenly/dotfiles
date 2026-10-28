---
schema_version: 1
kind: mirror
sources:
  - id: upstream-scrawl
    relationship: base
    repository: https://github.com/kitlangton/scrawl.git
    path: skills/scrawl
    revision: 7b184c67767a1aee6c1d44640d94d8446cd5fed1
---

# Lineage intent

Mirror the upstream `scrawl` skill unchanged. It teaches the agent to read
Scrawl captures - `.scrawl` bundles of a recorded screen, voice, clicks, and red
ink - starting from the contact sheet and keyframes, and to use the `scrawl`
CLI to zoom into a moment, pull frames, inspect marks, send a capture to an
OpenCode session, or export a video.

Kept verbatim so upstream improvements apply cleanly. Local adaptations, if any
are needed later, should convert this entry to `derivative`.

## Relationship to other Scrawl wiring in this repo

- The Scrawl app is a `Brewfile.macos` cask (`kitlangton/tap/scrawl`). The cask
  links the app's `scrawl` binary onto `PATH`; the skill falls back to
  `/Applications/Scrawl.app/Contents/MacOS/scrawl` when it is absent.
- The CLI runs only on macOS hosts with Scrawl installed. On other hosts the
  skill reads the bundle's `contact-sheet.png`, `frames/`, and `scrawl.json`
  directly, so it is linked for every harness on every host.
- The installed app can print its own version of this guide with
  `scrawl skill`. Compare it with the mirror when advancing the revision.

## Update policy

Track upstream as an unmodified mirror. On update, record the newly incorporated
revision above. Never overwrite this file with upstream content.

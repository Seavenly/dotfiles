# Global agent guidance

## Communication

- Use the plain hyphen `-` instead of the em dash character.
- Communicate technical decisions in terms of quality, simplicity, robustness,
  scalability, and long-term maintainability. Do not optimize primarily for
  short-term implementation cost.

## Dictated input

- Messages are often dictated. Speech recognition can turn "Scrawl" (the
  screen-capture tool whose `.scrawl` bundles and `scrawl` CLI the `scrawl`
  skill covers) into "scroll". When "scroll" refers to a recording, capture,
  bundle, or something the user just showed you, treat it as Scrawl and use the
  `scrawl` skill. Otherwise read it literally; web design work uses "scroll" in
  its ordinary sense.

## Authorship and generated files

- Do not add an agent name, co-author trailer, or similar attribution to commit
  messages unless the user explicitly requests it.
- Do not manually modify changelogs or files marked as generated. Update their
  source or use the documented generator.

## Engineering practice

- For bug fixes, first reproduce the behavior as close as practical to the
  end-user path. Use that reproduction to verify the fix and guard against
  regression.
- Treat lint failures, test failures, and test flakiness as real engineering
  problems. Fix them when they are caused by or required for the current work;
  otherwise report them clearly without expanding scope silently.
- When validating user interfaces, inspect the rendered result carefully and
  hold visible details to the same quality bar as functional behavior.

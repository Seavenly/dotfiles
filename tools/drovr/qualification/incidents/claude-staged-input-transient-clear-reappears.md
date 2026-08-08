# Incident: transient Claude staged-input clear

## Production observation

A completed Claude managed agent held old unknown staged input. The operator
inspected the prompt through `drovr agent staged-input AGENT_ID`, then explicitly
authorized `--clear-unknown` with the returned exact snapshot token.

The clear command returned `status: cleared`, and an immediate public
inspection returned `ready`. After a short delay, the identical prompt and
snapshot token reappeared. A later `drovr ask` correctly refused to submit the
unknown text, but the earlier clear result had been false success. Direct raw
key attempts did not permanently remove the prompt.

The only successful manual recovery was to terminate the affected Claude
process and resume the same Claude native session in the same managed pane.
Drovr then recognized the same managed agent and native session, reported
`ready`, and later turns completed with exact transcript correlation.

## Qualification consequences

- Point-in-time absence is not evidence of a successful clear.
- `cleared` requires absence throughout a bounded stability interval and a
  final observation of the exact managed agent and exact native session.
- Reappearance produces a typed non-success result with the prompt, token,
  timing, and identities retained as evidence.
- Unknown text is never submitted, including by the next `drovr ask`.
- Process termination and same-native-session resume are possible explicit
  recovery actions. They do not authorize hidden process repair, managed-agent
  replacement, registry edits, transcript edits, or mutation of caller-owned
  files.

The fault matrix keeps the two timing boundaries separate:

- Reappearance during the qualified stability interval is a
  `clear_contradicted` result and never becomes clear success.
- Reappearance after the interval is observed as a new unknown staged snapshot
  after the earlier `cleared` result. It does not authorize submission,
  replacement, or implicit process resume.

The post-interval case is deterministic replay coverage. A same-native-session
resume, if explicitly exercised in a future scenario, must have its own exact
identity and receipt assertions rather than being counted as part of clear
success.

The executable contract is scenario
`claude_staged_input_transient_clear_reappears` in
[`../catalog.v1.json`](../catalog.v1.json).

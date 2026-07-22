# Herdr agent-turn prototype

Question: can one caller use Herdr as an orchestration plane to start Codex and
Claude Code, submit one prompt to each, wait for each turn to settle, and return
the complete final assistant messages without scraping terminal output?

This is a throwaway feasibility prototype. It targets the locally installed
Herdr 0.7.5 CLI and reads the harness-owned JSONL transcripts after Herdr reports
each agent idle.

## Observed result

On 2026-07-22, both a fresh-session run and a second run reusing the same agents
returned the exact requested response from Codex and Claude Code. The narrow
single-turn design is feasible.

Two boundaries remain before treating this as a production control plane:

- Herdr obtains session identity from the Codex and Claude Code integrations,
  but its lifecycle authority for those harnesses still depends on terminal
  screen detection. Permission and unusual blocked states need adversarial
  validation.
- The JSONL transcript shapes are harness-owned implementation details. A real
  orchestrator should isolate these two extractors behind versioned adapters and
  verify that each returned message belongs to the newly submitted turn.

Run it from the repository root:

```sh
npm --prefix config/agent-flow run --silent prototype:herdr-turn
```

Pass one prompt to send the same request to both harnesses:

```sh
npm --prefix config/agent-flow run --silent prototype:herdr-turn -- "Reply with one short sentence."
```

Progress and lifecycle state go to standard error. The final result is one JSON
document on standard output, suitable for a calling agent to parse. The command
creates the named `herdr-orchestration-prototype` session and its two agents when
they are missing. Later invocations reuse the same harness sessions, which also
exercises the first step toward multi-turn orchestration.

The prototype deliberately does not treat terminal scrollback as the result.
Herdr owns startup, prompt delivery, and lifecycle waiting; `last-message.jq`
extracts the final message from the session ID that Herdr's integrations report.

---
name: implement-ticket
description: Orchestrate Sol sub-agents (or Luna with --luna) to complete one implementation, documentation, or qualification issue in a dedicated worktree, with independent verification and review of changes or durable evidence. Use only when explicitly invoked as /implement-ticket or $implement-ticket with one issue URL and optional --luna.
argument-hint: "[--luna] <issue-url>"
disable-model-invocation: true
---

# Implement Ticket

Complete the ticket identified by the issue URL. Qualification may
produce durable evidence without a repository change or new commit.

Accept exactly one complete GitHub issue URL and an optional `--luna` flag,
which may appear before or after the URL. Reject missing or malformed URLs,
multiple URLs, repeated flags, unknown flags, and other arguments; ask the user
to invoke the skill again as `/implement-ticket [--luna] <issue-url>`.

Without `--luna`, use the newest Sol model advertised by the native sub-agent
launch tool (currently `gpt-6.1-sol`). With `--luna`, use `gpt-6-luna`.
For Sol, default to `reasoning_effort: medium`; use `high` for complex work and
both independent review axes, as defined by the protocol. Luna always uses
`reasoning_effort: max`. Apply this policy to every sub-agent, including later
integration work. Follow the protocol's selection and recording rules.

Before taking any action, read and follow the complete
[implementation protocol](references/implementation-protocol.md). Substitute
the supplied issue URL wherever the protocol refers to the ticket.

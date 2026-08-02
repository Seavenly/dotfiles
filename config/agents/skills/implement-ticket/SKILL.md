---
name: implement-ticket
description: Implement one GitHub issue in a dedicated worktree, verify and review the result, and commit it for later aggregate integration. Use only when explicitly invoked as /implement-ticket or $implement-ticket with one issue URL.
argument-hint: "<issue-url>"
disable-model-invocation: true
---

# Implement Ticket

Implement the ticket identified by the sole skill argument.

Require exactly one complete GitHub issue URL. If the argument is missing,
malformed, or contains anything else, stop and ask the user to invoke the skill
again with only the issue URL.

Before taking any action, read and follow the complete
[implementation protocol](references/implementation-protocol.md). Substitute
the supplied issue URL wherever the protocol refers to the ticket.

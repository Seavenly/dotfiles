# Claude autonomous workflow retirement proposal

Status: not eligible for approval

Date: 2026-07-15

This document is deliberately separate from implementation completion. No
Claude command, agent, renderer, or dynamic workflow is removed or redirected
by the Hermes work.

## Options

1. Keep both implementations. Claude remains the established operator path;
   Hermes provides durable orchestration for selected flows.
2. Convert Claude commands into compatibility adapters that gather input and
   launch Hermes while preserving the current command interface.
3. Retire the Claude autonomous workflows after Hermes demonstrates complete
   parity and an adequate rollback window.

## Current recommendation

Choose option 1 for now. Options 2 and 3 require successful real review,
feature, spike, epic, stack, and delivery runs, a non-production remote policy
prototype, final UI inspection, and explicit user approval. Those prerequisites
are not yet complete.

## Approval

No approval is recorded. Silence, implementation progress, or cleanup work
must not be interpreted as retirement authorization.

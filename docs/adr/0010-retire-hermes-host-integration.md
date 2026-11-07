---
status: accepted
---

# Retire Hermes host integration

Hermes is no longer a supported agent harness on converged hosts. Convergence
must not create its home, profiles, routing file, or skill links. Remove only
exact repository-owned links through an idempotent migration; existing
installations, credentials, sessions, and databases remain host-owned data.
Hermes-specific Docker bootstrap sources are removed.

The Hermes-backed legacy launch policy is disabled, and its agent-flow skills
are removed from Claude and Codex discovery. The Claude-only default and the
replacement FlowRuntime retain their existing authority boundaries.

The immutable Hermes baseline remains in Git for baseline audits and read-only
legacy inventory, including the modules used by the local review tools. This
retention does not authorize new Hermes launches or profile convergence.
ADR-0004 and ADR-0006 remain historical; this decision narrows ADR-0008's host
integration without importing or deleting legacy execution evidence.

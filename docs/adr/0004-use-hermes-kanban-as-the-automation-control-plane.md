---
status: superseded by ADR-0007
---

# Use Hermes Kanban as the automation control plane

Repeatable automated multi-agent flows use Hermes Kanban as their sole runtime and lifecycle source of truth. Shared skills remain the interactive interface and a small `agent-flow` command may prepare durable inputs, workspaces, and explicit versioned graphs, but it must not become a second scheduler, state database, or general workflow language. Tracker issues own external intent and acceptance criteria, Kanban cards own internal execution, and only the merge of one completion PR marks the external outcome complete. This rejects a generic cross-harness workflow engine and two-way tracker synchronization in favor of one durable control plane with small native adapters.

---
status: accepted (frozen Hermes-backed baseline only)
---

# Allow controller terminal for pinned agent-flow commands

Hermes v0.18.2 has no plugin or per-command capability that lets a Kanban-only
controller invoke repository-owned deterministic transition helpers. Dynamic
feature, spike, and epic controllers therefore receive the native terminal
tool in addition to Kanban. Their tracked contract permits only the exact
`agent-flow` command pinned in the current sealed card and continues to forbid
general shell, Git, file, web, and product work. This restriction is
contractual, not a filesystem or process sandbox, and profile doctoring reports
that posture explicitly. The profile fingerprint change makes existing sealed
runs incompatible unless an explicit migration receipt approves it. This
accepts one narrow host-local capability instead of editing Hermes core or
introducing another scheduler/plugin surface.

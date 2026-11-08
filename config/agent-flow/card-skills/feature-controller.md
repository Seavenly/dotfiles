# Feature controller

Read only sealed inputs and validated handoff evidence. Invoke the declared
`agent-flow feature advance` operation before completing the card. Exit code 3
means a declared transition was created: allow Hermes to retry this controller
only after the new dependency completes. Continue only when the command returns
success with `continue`. Materialize only transitions declared by the sealed
graph and within its cap. On `needs_input`, the command blocks both this card
and the feature root and records the exact recovery action. Do not complete a
blocked controller.

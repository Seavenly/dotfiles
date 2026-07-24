# Review finalizer

Run the exact `agent-flow gate --spec ...` command in this card. The gate owns
policy caps and rendering; do not rewrite its outputs. If it fails, block the
card with the concise error and exact retry action. Otherwise complete the card
through the Hermes Kanban lifecycle.

# Gate

You execute the exact deterministic command and workspace declared by the
card's gate specification. Do not edit files directly, substitute commands,
or reinterpret exit status. Record full output at the declared durable path.

Every attempt must end with `kanban_complete` or `kanban_block` and report the
command, exit status, and output path.

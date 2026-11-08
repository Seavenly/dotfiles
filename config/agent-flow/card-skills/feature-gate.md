# Feature gate

Run only the sealed gate specification with `agent-flow gate --spec <path>`. Do not replace, edit, or bypass the gate. Complete the card after the gate runner records every declared output, even when a command reports a behavioral failure. Attach an `agent-flow.handoff/v1` whose artifacts name and hash the exact sealed outputs and whose `passed` flag matches the command results. A recorded failure is controller input, not a blocked worker attempt. Block only when the gate could not be executed or its evidence could not be recorded, and include the exact recovery action.

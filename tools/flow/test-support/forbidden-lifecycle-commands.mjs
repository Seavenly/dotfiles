export function forbiddenLifecycleCommands(runId, watermark) {
  return [
    { type: "schedule_card", card_id: "invented-card" },
    { type: "reboot_admission" },
    { type: "capability_grant", capabilities: ["invented:authority"] },
    {
      type: "checkpoint_decision",
      checkpoint_id: "confirm-scope",
      decision: "approve",
    },
    { type: "terminal_disposition", disposition: "approve" },
  ].map((command) => ({
    schema: "flow.command/v1",
    run_id: runId,
    expected_watermark: watermark,
    ...command,
  }));
}

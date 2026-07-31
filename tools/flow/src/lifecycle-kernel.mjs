const FORBIDDEN_COMMANDS = new Set([
  "generic_setter",
  "force_unlock",
  "generic_unblock",
  "timer_lease_takeover",
]);

export function decideLifecycle(fold, command) {
  if (FORBIDDEN_COMMANDS.has(command?.type)) {
    return reject(fold, command, "forbidden_command");
  }
  if (command?.schema !== "flow.command/v1") {
    return reject(fold, command, "invalid_command");
  }
  if (command.run_id !== fold.run_id) {
    return reject(fold, command, "run_identity_mismatch");
  }
  if (command.expected_watermark !== fold.watermark) {
    return reject(fold, command, "stale_authority_watermark");
  }
  if (command.type !== "checkpoint_decision") {
    return reject(fold, command, "unsupported_command");
  }

  const checkpoint = fold.cards.find(({ id }) => id === command.checkpoint_id);
  if (!checkpoint || checkpoint.executor_kind !== "checkpoint" ||
      checkpoint.status !== "waiting_checkpoint") {
    return reject(fold, command, "checkpoint_not_actionable");
  }
  if (command.decision !== "approve") {
    return reject(fold, command, "unsupported_checkpoint_decision");
  }

  const allOtherCardsComplete = fold.cards.every(
    (card) => card.id === checkpoint.id || card.status === "completed",
  );
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: [
      {
        type: "checkpoint_decided",
        checkpoint_id: checkpoint.id,
        decision: command.decision,
      },
      ...(allOtherCardsComplete ? [{ type: "run_succeeded" }] : []),
    ],
    effect_intents: [],
    obligations: [],
    projection_hints: ["operator", "graph"],
  };
}

export const LifecycleKernel = Object.freeze({
  decide: decideLifecycle,
});

function reject(fold, command, code) {
  return {
    schema: "flow.rejection/v1",
    code,
    command_type: command?.type ?? null,
    run_id: command?.run_id ?? null,
    authority_watermark: fold.watermark,
    legal_actions: fold.legal_actions,
  };
}

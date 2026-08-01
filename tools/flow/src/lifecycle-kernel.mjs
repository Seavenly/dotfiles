import { createRejection } from "./rejection.mjs";

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
  if (fold.phase !== "active") {
    return reject(fold, command, "run_terminal");
  }
  if (command.type !== "checkpoint_decision") {
    return reject(fold, command, "unsupported_command");
  }

  const checkpoint = fold.cards.find(({ id }) => id === command.checkpoint_id);
  if (!checkpoint || checkpoint.executor_kind !== "checkpoint" ||
      checkpoint.status !== "waiting_checkpoint") {
    return reject(fold, command, "checkpoint_not_actionable");
  }
  if (!["approve", "decline"].includes(command.decision)) {
    return reject(fold, command, "unsupported_checkpoint_decision");
  }

  if (command.decision === "decline") {
    return decision(command, checkpoint, [{ type: "run_declined" }]);
  }

  const allOtherCardsComplete = fold.cards.every(
    (card) => card.id === checkpoint.id || card.status === "completed",
  );
  return decision(
    command,
    checkpoint,
    allOtherCardsComplete ? [{ type: "run_succeeded" }] : [],
  );
}

function decision(command, checkpoint, terminalEvents) {
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: [
      {
        type: "checkpoint_decided",
        checkpoint_id: checkpoint.id,
        decision: command.decision,
      },
      ...terminalEvents,
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
  return createRejection({
    operation: "command",
    code,
    commandType: command?.type ?? null,
    runId: command?.run_id ?? null,
    bundleDigest: fold.bundle_digest,
    authorityWatermark: fold.watermark,
    authorityWatermarkDomain: "run",
    legalActions: fold.legal_actions,
  });
}

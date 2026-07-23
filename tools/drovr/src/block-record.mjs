export function createBlockRecord({
  id,
  turnId,
  agentId,
  taskId,
  harness,
  excerpt,
  herdrStateChangeSeq,
  createdAt,
}) {
  return {
    schema: "drovr.block/v1",
    id,
    turn_id: turnId,
    agent_id: agentId,
    task_id: taskId,
    harness,
    status: "open",
    excerpt,
    attach: { command: `drovr attach ${agentId}` },
    ...(Number.isSafeInteger(herdrStateChangeSeq)
      ? { herdr: { state_change_seq: herdrStateChangeSeq } }
      : {}),
    created_at: createdAt,
  };
}

export function acknowledgeBlockRecord(block, { acknowledgedAt }) {
  if (block.status === "open") {
    block.status = "acknowledged";
    block.acknowledged_at = acknowledgedAt;
  }
  return block;
}

export function observeBlockWorking(block, { observedAt, observation }) {
  block.working_observed_at ??= observedAt;
  if (observation) block.working_observation ??= observation;
  return block;
}

export function blockAwaitsWorkingObservation(block) {
  return block?.status === "acknowledged" && !block.working_observed_at;
}

export function blockRepresentsActiveTransition(
  block,
  { herdrStateChangeSeq } = {},
) {
  if (!(block?.status === "open" || blockAwaitsWorkingObservation(block))) {
    return false;
  }
  const recordedStateChangeSeq = block.herdr?.state_change_seq;
  return (
    !Number.isSafeInteger(recordedStateChangeSeq) ||
    !Number.isSafeInteger(herdrStateChangeSeq) ||
    herdrStateChangeSeq <= recordedStateChangeSeq
  );
}

export function herdrStateChangedSinceBlock(block, herdrStateChangeSeq) {
  const recordedStateChangeSeq = block?.herdr?.state_change_seq;
  return (
    Number.isSafeInteger(recordedStateChangeSeq) &&
    Number.isSafeInteger(herdrStateChangeSeq) &&
    herdrStateChangeSeq > recordedStateChangeSeq
  );
}

export function supersedeBlockRecord(
  block,
  { supersededAt, supersededBy },
) {
  block.status = "superseded";
  block.superseded_at = supersededAt;
  block.superseded_by = supersededBy;
  return block;
}

export function resolveBlockRecord(block, { resolvedAt }) {
  block.status = "resolved";
  block.resolved_at ??= resolvedAt;
  return block;
}

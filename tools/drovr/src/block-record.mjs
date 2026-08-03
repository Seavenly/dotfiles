export function createBlockRecord({
  id,
  turnId,
  agentId,
  taskId,
  harness,
  excerpt,
  transitionToken,
  herdrStateChangeSeq,
  createdAt,
}) {
  const recordedTransitionToken = transitionToken ?? herdrStateChangeSeq;
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
    ...(Number.isSafeInteger(recordedTransitionToken)
      ? { herdr: { state_change_seq: recordedTransitionToken } }
      : {}),
    created_at: createdAt,
  };
}

export function blockTransitionToken(block) {
  return block?.herdr?.state_change_seq;
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
  { transitionToken, herdrStateChangeSeq } = {},
) {
  if (!(block?.status === "open" || blockAwaitsWorkingObservation(block))) {
    return false;
  }
  const recordedStateChangeSeq = blockTransitionToken(block);
  const observedTransitionToken = transitionToken ?? herdrStateChangeSeq;
  return (
    !Number.isSafeInteger(recordedStateChangeSeq) ||
    !Number.isSafeInteger(observedTransitionToken) ||
    observedTransitionToken <= recordedStateChangeSeq
  );
}

export function herdrStateChangedSinceBlock(block, transitionToken) {
  const recordedStateChangeSeq = blockTransitionToken(block);
  return (
    Number.isSafeInteger(recordedStateChangeSeq) &&
    Number.isSafeInteger(transitionToken) &&
    transitionToken > recordedStateChangeSeq
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

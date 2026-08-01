import { digest, freezeCanonical } from "./canonical.mjs";

export function foldRun(run) {
  const checkpointDecisions = new Map(
    run.events
      .filter(({ type }) => type === "checkpoint_decided")
      .map(({ checkpoint_id: checkpointId, decision }) => [checkpointId, decision]),
  );
  const approvedCheckpoints = new Set(
    [...checkpointDecisions]
      .filter(([, decision]) => decision === "approve")
      .map(([checkpointId]) => checkpointId),
  );
  const phase = run.events.some(({ type }) => type === "run_declined")
    ? "declined"
    : run.events.some(({ type }) => type === "run_succeeded")
      ? "succeeded"
      : "active";
  const cards = run.prepared.graph.cards.map((card) => {
    let status = "pending";
    if (checkpointDecisions.get(card.id) === "decline") {
      status = "declined";
    } else if (approvedCheckpoints.has(card.id)) {
      status = "completed";
    } else if (phase === "active" && card.dependencies.every((dependency) =>
      approvedCheckpoints.has(dependency))) {
      status = card.executor.kind === "checkpoint" ? "waiting_checkpoint" : "ready";
    }
    return {
      id: card.id,
      executor_kind: card.executor.kind,
      status,
    };
  });
  const watermark = runWatermark(run);
  const legalActions = phase === "active"
    ? cards
      .filter(({ executor_kind: kind, status }) =>
        kind === "checkpoint" && status === "waiting_checkpoint")
      .flatMap(({ id }) => ["approve", "decline"].map((decision) => ({
        schema: "flow.command/v1",
        type: "checkpoint_decision",
        run_id: run.run_id,
        checkpoint_id: id,
        decision,
        expected_watermark: watermark,
      })))
    : [];

  return freezeCanonical({
    schema: "flow.run-fold/v1",
    run_id: run.run_id,
    watermark,
    sequence: run.events.length,
    phase,
    bundle_digest: run.prepared.bundle_digest,
    plan_fingerprint: run.prepared.plan_fingerprint,
    cards,
    legal_actions: legalActions,
  });
}

export function projectRun(fold) {
  if (fold?.schema !== "flow.run-fold/v1") {
    throw new Error("run projection requires an authoritative fold");
  }
  return freezeCanonical({
    schema: "flow.run-projection/v1",
    run_id: fold.run_id,
    watermark: fold.watermark,
    sequence: fold.sequence,
    phase: fold.phase,
    bundle_digest: fold.bundle_digest,
    plan_fingerprint: fold.plan_fingerprint,
    cards: fold.cards,
    legal_actions: fold.legal_actions,
  });
}

export function runWatermark(run) {
  return digest({
    schema: "flow.run-authority-stream/v1",
    run_id: run.run_id,
    events: run.events,
  });
}

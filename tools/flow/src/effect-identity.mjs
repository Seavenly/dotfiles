import { digest } from "./canonical.mjs";

/**
 * Derive the canonical identity of an operation's first attempt.  Lifecycle
 * planning and any pre-rendered effect evidence must use this one pure helper
 * so provider-facing identities cannot drift from the durable intent.
 */
export function operationEffectIdentity({
  runId,
  cardId,
  operationContract,
} = {}) {
  if (typeof runId !== "string" || runId.length === 0 ||
      typeof cardId !== "string" || cardId.length === 0 ||
      typeof operationContract !== "string" || operationContract.length === 0) {
    return null;
  }
  const attemptId = `${runId}:${cardId}:attempt:1`;
  const effectIdentity = digest({
    schema: "flow.operation-effect-identity/v1",
    run_id: runId,
    card_id: cardId,
    attempt_id: attemptId,
    operation_contract: operationContract,
  });
  const suffix = effectIdentity.slice("sha256:".length);
  return Object.freeze({
    attempt_id: attemptId,
    effect_id: `effect:${suffix}`,
    idempotency_key: `operation:${suffix}`,
  });
}

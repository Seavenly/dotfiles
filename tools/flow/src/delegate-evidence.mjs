/** The exact non-authoritative projection carried in a host predecessor envelope. */
export function acceptedDelegateEvidenceEntry(cardId, attempt, intent) {
  return {
    card_id: cardId,
    effect_id: attempt.effect_id,
    attempt_id: attempt.attempt_id,
    idempotency_key: intent.idempotency_key,
    source_authority_watermark: intent.source_authority_watermark,
    evidence: transferableDelegateEvidence(attempt.evidence),
  };
}

export function transferableDelegateEvidence(evidence) {
  const allowed = [
    "schema",
    "attempt_id",
    "card_id",
    "turn_id",
    "drovr_watermark",
    "route_binding",
    "settlement_proof",
    "validator_receipts",
    "validated_output",
    "evidence_safety_receipt",
    "evidence_safety_binding",
    "authority_terminal_disposition",
  ];
  return Object.fromEntries(allowed
    .filter((key) => Object.hasOwn(evidence, key))
    .map((key) => [key, evidence[key]]));
}


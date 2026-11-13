/** Exact advisory research result fields; no execution or scope authority. */
export const DEEP_RESEARCH_RECEIPT_SCHEMA_FIELDS = new Map([
  ["flow.deep-research-cycle-receipt/v1", new Set(["schema", "run_id", "effect_id", "attempt_id", "idempotency_key", "cycle", "question", "scope_digest",
    "packet_digest", "terminal_set_digest", "critic", "operationally_blocked", "revise_angles", "proposed_question", "report", "self_digest"])],
  ["flow.deep-research-report/v1", new Set(["schema", "question", "packet_digest", "answer", "assurance", "citations", "findings", "residual_gaps", "cycle", "retained_evidence_digest"])],
]);

export const DEEP_RESEARCH_CHILD_FIELDS = new Map([
  ["flow.deep-research-cycle-receipt/v1:question", new Set(["id", "text"])],
  ["flow.deep-research-cycle-receipt/v1:proposed_question", new Set(["id", "text"])],
  ["flow.deep-research-cycle-receipt/v1:critic", new Set(["card_id", "effect_id", "attempt_id", "receipt_digest"])],
  ["flow.deep-research-report/v1:question", new Set(["id", "text"])],
  ["flow.deep-research-report/v1:citations", new Set(["source_id", "digest"])],
]);

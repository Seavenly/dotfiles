import { digest, freezeCanonical } from "./canonical.mjs";
import { researchQuestion } from "./deep-research-contract.mjs";
import { validateDeepTerminalSet } from "./deep-research-evidence.mjs";
import { DEEP_CYCLE_CONTRACT, DEEP_CYCLE_VALIDATOR, deepCriticCardId, validateDeepResearchOutput, DEEP_CRITIC_SCHEMA } from "./deep-research-flow.mjs";

export function deriveDeepCycleReceipt(intent) {
  const input = intent.operation_input, evidence = input?.authority_materialized_evidence;
  if (intent.operation_contract !== DEEP_CYCLE_CONTRACT || input?.phase !== "deep_cycle_decision" || !validateDeepTerminalSet(evidence) ||
      evidence.run_id !== intent.run_id || evidence.cycle !== input.cycle || evidence.scope_digest !== input.scope_digest || digest(evidence.question) !== digest(input.question)) throw new Error("deep_cycle_evidence_changed");
  const critics = evidence.entries.filter(entry => entry.card_id === deepCriticCardId(input.cycle));
  if (critics.length !== 1 || critics[0].disposition !== "accepted") throw new Error("deep_critic_evidence_unavailable");
  const critic = critics[0], output = JSON.parse(critic.output);
  const previousIdentity = { schema: evidence.schema, input_safety_policy_id: evidence.input_safety_policy_id, run_id: evidence.run_id, cycle: evidence.cycle,
    question: evidence.question, scope_digest: evidence.scope_digest, entries: evidence.entries.filter(entry => entry.card_id !== critic.card_id) };
  const predecessor = { ...previousIdentity, evidence_digest: digest(previousIdentity) };
  const task = input.critic_task_inputs;
  if (!task || !validateDeepResearchOutput(critic.output, { delegate_input: { task_inputs: task }, authority_materialized_evidence: predecessor }, DEEP_CRITIC_SCHEMA)) throw new Error("deep_critic_output_changed");
  const operationallyBlocked = evidence.entries.some(entry => entry.disposition !== "accepted");
  const identity = { schema: "flow.deep-research-cycle-receipt/v1", run_id: intent.run_id, effect_id: intent.effect_id,
    attempt_id: intent.attempt_id, idempotency_key: intent.idempotency_key, cycle: input.cycle, question: input.question, scope_digest: input.scope_digest,
    packet_digest: input.packet_digest, terminal_set_digest: evidence.evidence_digest,
    critic: { card_id: critic.card_id, effect_id: critic.effect_id, attempt_id: critic.attempt_id, receipt_digest: critic.receipt_digest },
    operationally_blocked: operationallyBlocked, revise_angles: [...new Set(output.revise_angles)].sort(),
    proposed_question: output.proposed_question === null ? null : researchQuestion(output.proposed_question),
    report: { schema: "flow.deep-research-report/v1", question: input.question, packet_digest: input.packet_digest,
      answer: output.answer, assurance: "lower", citations: output.citations, findings: output.findings, residual_gaps: output.residual_gaps,
      cycle: input.cycle, retained_evidence_digest: output.retained_evidence_digest } };
  return freezeCanonical({ ...identity, self_digest: digest(identity) });
}

export function createDeepCycleOperation() {
  return Object.freeze({ schema: "flow.registered-operation/v1", classification: "read_only", availability: "available",
    provider_receipt_validator: DEEP_CYCLE_VALIDATOR,
    validateReceipt(receipt, intent) { try { return digest(receipt) === digest(deriveDeepCycleReceipt(intent)); } catch { return false; } },
    sanitizeProviderReceipt(receipt) { return receipt; },
    async invoke(intent) { return { schema: "flow.effect-receipt/v1", effect_id: intent.effect_id, idempotency_key: intent.idempotency_key,
      outcome: "succeeded", provider_receipt: deriveDeepCycleReceipt(intent) }; } });
}

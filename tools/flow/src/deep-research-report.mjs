import { digest } from "./canonical.mjs";
import { validateResearchSourcePacket } from "./research-source-packet.mjs";
import { validateDeepResearchSelection } from "./deep-research-contract.mjs";
import { createDeepTerminalSet } from "./deep-research-evidence.mjs";
import { deriveDeepCycleReceipt } from "./deep-research-cycle.mjs";
import { DEEP_CYCLE_CONTRACT, deepDecisionCardId } from "./deep-research-flow.mjs";

const fail = () => { const error = new Error("Deep research report no longer binds its exact public source, cycle and terminal evidence."); error.code = "deep_research_report_changed"; throw error; };

/** Reconstruct exactly the same host result using public projections, never private intents. */
export function readDeepCycleReceipt(run, cycle) {
  const card = run.active_plan?.cards?.find(card => card.id === deepDecisionCardId(cycle));
  if (!card) return null;
  const effects = (run.effects ?? []).filter(effect => effect.card_id === card.id && effect.effect_kind === "operation");
  if (!effects.length) return null;
  if (effects.length !== 1) fail();
  const effect = effects[0];
  if (!effect.receipt) return null;
  if (effect.status !== "succeeded" || effect.operation_contract !== DEEP_CYCLE_CONTRACT ||
      effect.run_id !== run.run_id || effect.receipt.effect_id !== effect.effect_id || effect.receipt.idempotency_key !== effect.idempotency_key ||
      effect.receipt.outcome !== "succeeded" || card.executor?.contract !== DEEP_CYCLE_CONTRACT) fail();
  const evidence = createDeepTerminalSet(run, card);
  if (!evidence) fail();
  const intent = { ...effect, operation_input: { ...card.inputs, authority_materialized_evidence: evidence } };
  const expected = deriveDeepCycleReceipt(intent);
  if (digest(effect.receipt.provider_receipt) !== digest(expected)) fail();
  return expected;
}

export function readDeepResearchReport(run, packet, deep) {
  if (!validateResearchSourcePacket(packet) || !validateDeepResearchSelection(deep) ||
      digest(run.active_plan?.deep_research?.packet ?? null) !== digest(packet) || digest(run.active_plan?.deep_research?.deep ?? null) !== digest(deep)) fail();
  let current = null;
  for (let cycle = 1; cycle <= deep.max_cycles; cycle++) {
    const receipt = readDeepCycleReceipt(run, cycle);
    if (receipt) current = receipt;
  }
  if (!current || current.operationally_blocked) return null;
  return { ...current.report, cycles_used: current.cycle, max_cycles: deep.max_cycles,
    cap_exhausted: current.cycle >= deep.max_cycles && (current.revise_angles.length > 0 || current.proposed_question !== null) };
}

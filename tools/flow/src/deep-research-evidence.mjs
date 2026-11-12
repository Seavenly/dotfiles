import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";
import { bindDelegateEvidenceReceipt } from "./evidence-safety.mjs";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const exact = (value, keys) => isPlainRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const ENTRY_KEYS = ["card_id", "angle_id", "cycle", "question", "scope_digest", "disposition", "run_id", "effect_id", "attempt_id", "route_digest", "receipt_digest", "source_authority_watermark", "output", "output_digest", "terminal_receipt_digest", "tree_retired"];

/** Compact immutable evidence, not a replacement for the recorded provider receipt. */
export function deepTerminalEntry(run, cardId) {
  try {
    const card = run.active_plan?.cards?.find(card => card.id === cardId), task = card?.inputs?.task_inputs;
    if (task?.flow !== "spike/v3" || !["angle", "critic"].includes(task.role)) return null;
    const attempts = (run.delegate_attempts ?? []).filter(attempt => attempt.card_id === cardId);
    const effects = (run.effects ?? []).filter(effect => effect.card_id === cardId && effect.effect_kind === "delegate");
    if (attempts.length !== 1 || effects.length !== 1) return null;
    const attempt = attempts[0], effect = effects[0], receipt = effect.receipt, provider = receipt?.provider_receipt;
    const retirement = provider?.terminal_disposition;
    if (effect.run_id !== run.run_id || attempt.effect_id !== effect.effect_id || attempt.attempt_id !== effect.attempt_id ||
        receipt?.effect_id !== effect.effect_id || receipt.idempotency_key !== effect.idempotency_key ||
        !["succeeded", "quarantined"].includes(receipt.outcome) || !["succeeded", "quarantined"].includes(effect.status) ||
        digest(card.route) !== digest(effect.route_binding) || digest(attempt.route_binding) !== digest(card.route) ||
        provider?.schema !== "flow.delegate-evidence/v1" || provider.card_id !== cardId || provider.attempt_id !== attempt.attempt_id ||
        digest(provider) !== digest(attempt.evidence ?? attempt.quarantine_record ?? null) && attempt.status === "accepted" ||
        !SHA.test(effect.source_authority_watermark ?? "") || retirement?.schema !== "flow.resource-retirement/v1" ||
        retirement.retired !== true || retirement.proof !== "linux_subreaper_echild" || !SHA.test(retirement.terminal_receipt_digest ?? "")) return null;
    const accepted = attempt.status === "accepted" && receipt.outcome === "succeeded";
    let output = null;
    if (accepted) {
      output = provider.validated_output;
      if (typeof output !== "string" || output.length > 8192) return null;
      const safe = bindDelegateEvidenceReceipt(provider.evidence_safety_receipt, { subject_digest: digest(JSON.parse(output)) });
      if (!safe.accepted || digest(safe.binding) !== digest(provider.evidence_safety_binding)) return null;
    } else if (attempt.status !== "quarantined" || receipt.outcome !== "quarantined") return null;
    return freezeCanonical({ card_id: cardId, angle_id: task.angle?.angle_id ?? null, cycle: task.cycle,
      question: task.question, scope_digest: task.scope_digest, disposition: accepted ? "accepted" : "operational_failure",
      run_id: run.run_id, effect_id: effect.effect_id, attempt_id: attempt.attempt_id, route_digest: digest(card.route),
      receipt_digest: digest(receipt), source_authority_watermark: effect.source_authority_watermark,
      output, output_digest: output === null ? null : digest(output), terminal_receipt_digest: retirement.terminal_receipt_digest, tree_retired: true });
  } catch { return null; }
}

export function createDeepTerminalSet(run, card) {
  const ids = card?.inputs?.deep_terminal_card_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 6 || new Set(ids).size !== ids.length) return null;
  const entries = ids.map(id => deepTerminalEntry(run, id));
  if (entries.some(entry => entry === null)) return null;
  const task = card.inputs.task_inputs ?? card.inputs;
  const identity = { schema: "flow.deep-research-terminal-set/v1", run_id: run.run_id, cycle: task.cycle,
    question: task.question, scope_digest: task.scope_digest, entries };
  return freezeCanonical({ ...identity, evidence_digest: digest(identity) });
}

export function validateDeepTerminalSet(value) {
  try {
    if (!exact(value, ["schema", "run_id", "cycle", "question", "scope_digest", "entries", "evidence_digest"]) ||
        value.schema !== "flow.deep-research-terminal-set/v1" || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 6 ||
        new Set(value.entries.map(entry => entry.card_id)).size !== value.entries.length || ![1, 2].includes(value.cycle) ||
        !SHA.test(value.scope_digest) || typeof value.run_id !== "string") return false;
    if (value.entries.some(entry => !exact(entry, ENTRY_KEYS) || entry.run_id !== value.run_id || ![1, 2].includes(entry.cycle) ||
        !["accepted", "operational_failure"].includes(entry.disposition) || entry.tree_retired !== true ||
        ![entry.scope_digest, entry.route_digest, entry.receipt_digest, entry.source_authority_watermark, entry.terminal_receipt_digest].every(item => SHA.test(item)) ||
        (entry.disposition === "accepted" ? typeof entry.output !== "string" || entry.output.length > 8192 || digest(entry.output) !== entry.output_digest : entry.output !== null || entry.output_digest !== null))) return false;
    const { evidence_digest, ...identity } = value;
    return digest(identity) === evidence_digest;
  } catch { return false; }
}

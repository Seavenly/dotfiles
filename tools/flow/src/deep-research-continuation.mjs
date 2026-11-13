import { digest, freezeCanonical } from "./canonical.mjs";
import { admitPlanRevision, REVISION_CAP_CODES } from "./plan-revision.mjs";
import { canonicalizeDynamicGraph, validatePreparedPlan } from "./plan-compiler.mjs";
import { compileDeepResearchSelection, compileDeepResearchCycle, deepCriticCardId, deepDecisionCardId, deepGateCardId } from "./deep-research-flow.mjs";
import { createDeepTerminalSet, deepTerminalEntry } from "./deep-research-evidence.mjs";
import { readDeepCycleReceipt } from "./deep-research-report.mjs";
import { researchQuestion } from "./deep-research-contract.mjs";

const equal = (a, b) => digest(a) === digest(b);
const commandIdentity = ({ expected_watermark: _watermark, ...identity }) => digest(identity);

function trusted(prepared) {
  try {
    if (prepared.kind !== "predefined" || prepared.definition?.id !== "spike/v3" || prepared.definition.contract !== "flow.definition/spike/v3") return false;
    const proposal = compileDeepResearchSelection({ inputs: prepared.selection.inputs, explicit_facts: prepared.explicit_facts });
    return equal(canonicalizeDynamicGraph(proposal.graph), prepared.graph) && equal(proposal.requested_authority, prepared.requested_authority) && prepared.revision_templates.length === 0;
  } catch { return false; }
}

function continuationTemplate(fold, prepared, receipt) {
  const metadata = prepared.graph.deep_research;
  const widening = receipt.proposed_question !== null && receipt.proposed_question.id !== receipt.question.id;
  const question = widening ? receipt.proposed_question : receipt.question;
  if (!researchQuestion(question?.text) || !equal(researchQuestion(question.text), question)) throw new Error("invalid_deep_scope");
  const angleIds = widening ? metadata.deep.angles.map(angle => angle.angle_id) : receipt.revise_angles;
  if (!angleIds.length) return null;
  const scopeDigest = widening ? digest({ original_packet_digest: metadata.packet.packet_digest, previous_scope_digest: receipt.scope_digest,
    question, cycle_decision_digest: receipt.self_digest }) : receipt.scope_digest;
  const retained = fold.active_plan.cards.filter(card => card.inputs?.task_inputs?.flow === "spike/v3").map(card => card.id);
  const cards = compileDeepResearchCycle(metadata, { cycle: receipt.cycle + 1, question, scope_digest: scopeDigest,
    angle_ids: angleIds, retained_card_ids: retained });
  const trigger = { schema: "flow.deep-research-cycle-trigger/v1", run_id: fold.run_id, cycle: receipt.cycle,
    decision_digest: receipt.self_digest, terminal_set_digest: receipt.terminal_set_digest, scope_digest: receipt.scope_digest };
  return { schema: "flow.plan-revision-template/v1", id: `deep-cycle:${receipt.self_digest.slice(7)}`,
    trigger, limits: { max_applications: 1 }, changes: { add_cards: cards, add_edges: [], supersede_cards: [],
      capability_additions: [], resource_additions: [], limit_changes: {} },
    question, scope_digest: scopeDigest, angle_ids: angleIds, widening };
}

function publicHistory(fold) {
  return fold.active_plan.cards.filter(card => card.inputs?.task_inputs?.flow === "spike/v3")
    .map(card => deepTerminalEntry(fold, card.id)).filter(Boolean);
}

/** Pure trusted-definition projection. It never dispatches, owns a timer or writes state. */
export function decorateDeepResearchFold(fold, prepared, events) {
  if (prepared.definition?.id !== "spike/v3") return fold;
  // Derived context is replaced, never carried into a later recomputation.
  const { deep_research: _priorProgress, deep_research_internal: _priorDecision, ...baseFold } = fold;
  fold = baseFold;
  const metadata = prepared.graph.deep_research;
  const failed = code => ({ ...fold, legal_actions: fold.legal_actions.filter(action => ["cancel", "recovery", "terminal_disposition"].includes(action.type)),
    deep_research: { schema: "flow.deep-research-progress/v1", operationally_blocked: true, report: null, scope_proposal: null, code } });
  if (!trusted(prepared)) return failed("untrusted_deep_definition");
  try {
    const reservations = events.filter(event => event.type === "deep_cycle_reserved");
    if (reservations.length > 1) return failed("duplicate_deep_cycle_reservation");
    if (reservations.length) {
      const first = readDeepCycleReceipt(fold, 1);
      if (!first || first.operationally_blocked) return failed("invalid_deep_cycle_reservation");
      const template = continuationTemplate({ ...fold, active_plan: prepared.graph }, prepared, first);
      const revision = fold.revisions[0], reservation = reservations[0];
      if (!template || !revision || fold.revisions.length !== 1 || revision.template_id !== template.id ||
          !equal(revision.changes, template.changes) || !equal(reservation.question, template.question) || reservation.scope_digest !== template.scope_digest ||
          reservation.decision_digest !== first.self_digest || !equal(reservation.angle_ids, template.angle_ids)) return failed("deep_revision_changed");
      const expected = canonicalizeDynamicGraph({ ...prepared.graph, cards: [...prepared.graph.cards, ...template.changes.add_cards] });
      if (!equal(expected, fold.active_plan) || !events.some(event => event.type === "checkpoint_decided" && event.checkpoint_id === deepGateCardId(1) && event.decision === "approve")) return failed("deep_revision_changed");
      if (template.widening && !events.some(event => event.type === "deep_scope_bound" && event.scope_digest === template.scope_digest && equal(event.question, template.question))) return failed("deep_scope_changed");
    } else if (fold.revisions.length || !equal(fold.active_plan, prepared.graph)) return failed("deep_revision_changed");
    const cycle = reservations.length + 1;
    const latestTask = fold.active_plan.cards.find(card => card.id === deepCriticCardId(cycle)).inputs.task_inputs;
    const history = publicHistory(fold);
    const question = latestTask.question, scopeDigest = latestTask.scope_digest;
    let actions = fold.legal_actions.filter(action => !action.checkpoint_id?.startsWith("deep-gate-") && !action.template_id?.startsWith("deep-cycle:"));
    const cards = fold.cards.map(card => ({ ...card }));
    const criticDefinition = fold.active_plan.cards.find(card => card.id === deepCriticCardId(cycle));
    const criticState = cards.find(card => card.id === criticDefinition.id);
    const settledJoin = createDeepTerminalSet(fold, criticDefinition);
    const unresolved = fold.effects.some(effect => !effect.receipt);
    if (fold.phase === "active" && !unresolved && settledJoin && criticState.status === "pending") {
      criticState.status = "ready";
      actions.push({ schema: "flow.command/v1", type: "delegate_execute", run_id: fold.run_id, card_id: criticDefinition.id, expected_watermark: fold.watermark });
    }
    const receipt = readDeepCycleReceipt(fold, cycle);
    const operationallyBlocked = history.some(entry => entry.disposition !== "accepted") || receipt?.operationally_blocked === true;
    const scope = { question_id: question.id, text: question.text, source_packet_digest: metadata.packet.packet_digest,
      original_question_id: metadata.packet.question.id, scope_digest: scopeDigest };
    const progress = { schema: "flow.deep-research-progress/v1", cycle, scope,
      angles: metadata.deep.angles.map(angle => {
        const candidates = fold.active_plan.cards.filter(card => card.inputs?.task_inputs?.angle?.angle_id === angle.angle_id);
        const latest = candidates.sort((a, b) => b.inputs.task_inputs.cycle - a.inputs.task_inputs.cycle)[0];
        const terminal = history.find(entry => entry.card_id === latest.id);
        return { ...angle, card_id: latest.id, cycle: latest.inputs.task_inputs.cycle,
          status: terminal?.disposition ?? cards.find(card => card.id === latest.id)?.status,
          effect_id: terminal?.effect_id ?? null, attempt_id: terminal?.attempt_id ?? null };
      }), history, report: receipt && !operationallyBlocked ? { ...receipt.report, cycles_used: cycle, max_cycles: metadata.deep.max_cycles,
        cap_exhausted: cycle >= metadata.deep.max_cycles && (receipt.revise_angles.length > 0 || receipt.proposed_question !== null) } : null,
      scope_proposal: null, operationally_blocked: operationallyBlocked, remaining_cycles: metadata.deep.max_cycles - cycle,
      automatic_action_identities: [] };
    if (receipt && !unresolved && fold.phase === "active") {
      const gate = deepGateCardId(cycle), gateState = cards.find(card => card.id === gate);
      gateState.status = operationallyBlocked ? "blocked" : "waiting_checkpoint";
      if (!operationallyBlocked) {
        let template = null, admission = null;
        const requested = receipt.revise_angles.length > 0 || receipt.proposed_question !== null && receipt.proposed_question.id !== question.id;
        if (requested && cycle < metadata.deep.max_cycles) {
          template = continuationTemplate(fold, prepared, receipt);
          if (template) admission = admitPlanRevision({ ...fold, cards }, template);
        }
        const semanticCap = requested && (cycle >= metadata.deep.max_cycles || admission?.code && REVISION_CAP_CODES.has(admission.code) && admission.code !== "revision_elapsed_limit_exceeded");
        if (admission?.code && !semanticCap) return failed(admission.code);
        if (template && !semanticCap) {
          validatePreparedPlan({ ...prepared, graph: admission.active_plan });
          const internal = { template, receipt_digest: receipt.self_digest, gate, cycle };
          if (template.widening) {
            progress.scope_proposal = { checkpoint_id: gate, old_question: question, new_question: template.question,
              unchanged_packet_digest: metadata.packet.packet_digest, angle_ids: metadata.deep.angles.map(angle => angle.angle_id),
              remaining_elapsed_seconds: null, original_elapsed_limit: fold.limits.max_elapsed_seconds, original_time_facts_digest: digest(fold.time_facts), remaining_cycles: metadata.deep.max_cycles - cycle,
              next_cycle_attempts: 3, next_cycle_graph_cards: 5,
              proposal_digest: digest({ decision_digest: receipt.self_digest, question: template.question, scope_digest: template.scope_digest }) };
            const { remaining_elapsed_seconds: _remaining, ...draft } = progress.scope_proposal;
            for (const decision of ["approve", "decline"]) actions.push({ schema: "flow.command/v1", type: "checkpoint_decision", run_id: fold.run_id,
              checkpoint_id: gate, decision, expected_watermark: fold.watermark,
              checkpoint_binding: { schema: "flow.checkpoint-binding/v1", checkpoint_id: gate, draft, draft_digest: digest(draft) } });
          } else {
            const command = { schema: "flow.command/v1", type: "revision_decision", run_id: fold.run_id, template_id: template.id,
              decision: "accept", base_plan_fingerprint: fold.plan_fingerprint, trigger: template.trigger, changes: template.changes, expected_watermark: fold.watermark };
            actions.push(command); progress.automatic_action_identities.push(commandIdentity(command));
          }
          return { ...fold, cards, legal_actions: actions, deep_research: progress, deep_research_internal: internal };
        }
        progress.report.cap_exhausted = Boolean(semanticCap);
        const command = { schema: "flow.command/v1", type: "checkpoint_decision", run_id: fold.run_id,
          checkpoint_id: gate, decision: "approve", expected_watermark: fold.watermark };
        actions.push(command); progress.automatic_action_identities.push(commandIdentity(command));
      }
    }
    return { ...fold, cards, legal_actions: actions, deep_research: progress };
  } catch { return failed("deep_continuation_evidence_changed"); }
}

export function isAutomaticDeepContinuation(projection, action) {
  return projection.deep_research?.scope_proposal === null &&
    projection.deep_research?.automatic_action_identities?.includes(commandIdentity(action)) === true;
}

/** Called after the ordinary authority identity, deadline and effect barriers. */
export function decideDeepResearchContinuation(fold, command) {
  if (!fold.deep_research || !["revision_decision", "checkpoint_decision"].includes(command.type)) return null;
  const deepGate = command.type === "checkpoint_decision" && command.checkpoint_id?.startsWith("deep-gate-");
  const deepRevision = command.type === "revision_decision" && command.template_id?.startsWith("deep-cycle:");
  if (!deepGate && !deepRevision) return null;
  if (!fold.legal_actions.some(action => equal(action, command)) || fold.deep_research.operationally_blocked) return { code: "deep_continuation_not_actionable" };
  const timeIssue = deepCompletionTimeIssue(fold.execution_time);
  if (timeIssue) return { code: timeIssue };
  const cycle = fold.deep_research.cycle, receipt = readDeepCycleReceipt(fold, cycle);
  if (!receipt || receipt.operationally_blocked) return { code: "deep_continuation_evidence_changed" };
  const gate = deepGateCardId(cycle), internal = fold.deep_research_internal;
  const checkpoint = { type: "checkpoint_decided", checkpoint_id: gate, decision: command.decision === "decline" ? "decline" : "approve",
    ...(command.checkpoint_binding ? { checkpoint_binding: command.checkpoint_binding } : {}) };
  if (internal && command.decision !== "decline") {
    if (internal.receipt_digest !== receipt.self_digest) return { code: "deep_continuation_evidence_changed" };
    const revision = admitPlanRevision(fold, internal.template);
    if (revision.code) return { code: revision.code };
    return freezeCanonical({ schema: "flow.decision/v1", command_type: command.type, effect_intents: [], obligations: [], projection_hints: ["operator", "graph"],
      events: [checkpoint, ...(internal.template.widening ? [{ type: "deep_scope_bound", question: internal.template.question,
        previous_scope_digest: receipt.scope_digest, scope_digest: internal.template.scope_digest, decision_digest: receipt.self_digest }] : []),
      { type: "plan_revised", ordinal: revision.ordinal, template_id: internal.template.id, base_plan_fingerprint: fold.plan_fingerprint,
        plan_fingerprint: revision.plan_fingerprint, trigger: internal.template.trigger, changes: internal.template.changes, active_plan: revision.active_plan },
      { type: "deep_cycle_reserved", cycle: cycle + 1, decision_digest: receipt.self_digest, question: internal.template.question,
        scope_digest: internal.template.scope_digest, angle_ids: internal.template.angle_ids,
        native_attempts: internal.template.angle_ids.length + 1, graph_cards: internal.template.changes.add_cards.length }] });
  }
  if (fold.cards.some(card => card.id !== gate && card.status !== "completed")) return { code: "deep_terminal_set_incomplete" };
  return freezeCanonical({ schema: "flow.decision/v1", command_type: command.type, events: [checkpoint, { type: "run_succeeded" }], effect_intents: [], obligations: [], projection_hints: ["operator"] });
}

export function boundedDeepRemainingSeconds(executionTime) {
  const upper = executionTime?.wall_elapsed_seconds?.upper, limit = executionTime?.max_elapsed_seconds;
  return executionTime?.status === "within" && Number.isFinite(upper) && Number.isFinite(limit) && upper >= 0 && limit >= upper
    ? Math.max(0, Math.floor(limit - upper)) : null;
}

function deepCompletionTimeIssue(executionTime) {
  if (executionTime?.status === "uncertain") return "execution_deadline_uncertain";
  if (executionTime?.status === "exhausted") return "execution_deadline_exhausted";
  if (boundedDeepRemainingSeconds(executionTime) === null) return "execution_time_unavailable";
  return boundedDeepRemainingSeconds(executionTime) <= 0 ? "deep_cycle_budget_unavailable" : null;
}

export function withDeepExecutionTime(fold, executionTime, legalActions) {
  if (!fold.deep_research) return {};
  const { completion_block: _priorTimeBlock, ...progress } = fold.deep_research;
  // A current observation fences new decisions; it never revokes an already
  // recorded terminal outcome or starts a new budget on historical inspection.
  if (fold.phase !== "active") return { deep_research: progress, legal_actions: legalActions };
  const remaining = boundedDeepRemainingSeconds(executionTime);
  const proposed = progress.scope_proposal;
  return { deep_research: { ...progress,
    ...(deepCompletionTimeIssue(executionTime) ? { completion_block: deepCompletionTimeIssue(executionTime) } : {}),
    ...(proposed ? { scope_proposal: { ...proposed, remaining_elapsed_seconds: remaining } } : {}) },
    legal_actions: legalActions.filter(action => !(remaining === null || remaining <= 0) ||
      !(action.type === "revision_decision" && action.template_id?.startsWith("deep-cycle:") && action.decision === "accept" ||
        action.type === "checkpoint_decision" && action.checkpoint_id?.startsWith("deep-gate-"))) };
}

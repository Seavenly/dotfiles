import { digest, freezeCanonical } from "./canonical.mjs";
import { admitPlanRevision } from "./plan-revision.mjs";
import { createRejection } from "./rejection.mjs";

const FORBIDDEN_COMMANDS = new Set([
  "generic_setter",
  "force_unlock",
  "generic_unblock",
  "timer_lease_takeover",
]);

export function decideLifecycle(fold, command) {
  if (FORBIDDEN_COMMANDS.has(command?.type)) {
    return reject(fold, command, "forbidden_command");
  }
  if (command?.schema !== "flow.command/v1") {
    return reject(fold, command, "invalid_command");
  }
  if (command.run_id !== fold.run_id) {
    return reject(fold, command, "run_identity_mismatch");
  }
  if (command.expected_watermark !== fold.watermark) {
    return reject(fold, command, "stale_authority_watermark");
  }
  if (fold.phase !== "active" &&
      !(fold.phase === "cancelled" && command.type === "recovery")) {
    return reject(fold, command, "run_terminal");
  }
  if (fold.admission === "suspended_after_reboot") {
    if (command.type !== "reboot_admission") {
      return reject(fold, command, "run_requires_reboot_admission");
    }
    if (command.authority_epoch !== fold.authority_epoch ||
        command.authority_boot_id !== fold.authority_boot_id ||
        command.expected_generation !== fold.stream_generation ||
        !sameCanonicalValue(command.revalidation, fold.reboot_revalidation)) {
      return reject(fold, command, "stale_reboot_admission");
    }
    if (fold.reboot_revalidation.valid !== true) {
      return reject(fold, command, "reboot_revalidation_failed");
    }
    return {
      schema: "flow.decision/v1",
      command_type: command.type,
      events: [{
        type: "run_admitted_after_reboot",
        revalidation_digest: digest(command.revalidation),
      }],
      effect_intents: [],
      obligations: [],
      projection_hints: ["operator"],
    };
  }
  if (command.type === "cancel") {
    const legalCancellation = fold.legal_actions.find((action) =>
      action.type === "cancel" && digest(action) === digest(command));
    if (!legalCancellation) {
      return reject(fold, command, "cancellation_not_actionable");
    }
    const unresolvedEffectIds = new Set(fold.effects
      .filter(({ status, invocation_started: invocationStarted }) =>
        invocationStarted !== false &&
        !["succeeded", "late_succeeded"].includes(status))
      .map(({ effect_id: effectId }) => effectId));
    const quarantinedClaimDigests = new Set(fold.effect_intents
      .filter(({ effect_id: effectId }) => unresolvedEffectIds.has(effectId))
      .flatMap(({ resource_claims: resourceClaims }) => resourceClaims)
      .map((claim) => digest(claim)));
    const unresolvedDelegates = fold.effect_intents
      .filter((intent) => intent.effect_kind === "delegate" &&
        unresolvedEffectIds.has(intent.effect_id))
      .map((intent) => delegateCancellationIntent(intent));
    const managedAgentHandoffs = heldManagedAgentRetirementIntents(fold, {
      settlementPhase: "cancelled",
    });
    const delegateCancellations = [
      ...unresolvedDelegates,
      ...managedAgentHandoffs,
    ];
    return {
      schema: "flow.decision/v1",
      command_type: command.type,
      events: [{
        type: "run_cancelled",
        resource_dispositions: fold.resource_claims.map((claim) => ({
          claim,
          disposition: quarantinedClaimDigests.has(digest(claim))
            ? "quarantined"
            : "released",
        })),
      }],
      effect_intents: delegateCancellations,
      obligations: [],
      projection_hints: ["operator", "graph"],
    };
  }
  const hasUnresolvedEffects = fold.effects?.some(
    ({ status }) => !["quarantined", "succeeded"].includes(status),
  );
  // This one-operation slice serializes completion-changing commands behind
  // effect settlement. Revisit the allow-list before admitting sibling effects.
  if (hasUnresolvedEffects &&
      !["capability_grant", "recovery"].includes(command.type)) {
    return reject(fold, command, "effect_settlement_required");
  }
  if (command.type === "capability_grant") {
    const legalGrant = fold.legal_actions.find((action) =>
      action.type === "capability_grant" && digest(action) === digest(command));
    if (!legalGrant) return reject(fold, command, "capability_grant_not_actionable");
    return {
      schema: "flow.decision/v1",
      command_type: command.type,
      events: [{
        type: "capability_granted",
        grant_id: command.grant_id,
        capabilities: command.capabilities,
        card_ids: command.card_ids,
        base_plan_fingerprint: command.base_plan_fingerprint,
        trigger: command.trigger,
      }],
      effect_intents: [],
      obligations: [],
      projection_hints: ["operator", "graph"],
    };
  }
  if (command.type === "revision_decision") {
    const legalRevision = fold.legal_actions.find((action) =>
      action.type === "revision_decision" && digest(action) === digest(command));
    if (!legalRevision) return reject(fold, command, "revision_not_actionable");
    if (command.decision === "decline") {
      return {
        schema: "flow.decision/v1",
        command_type: command.type,
        events: [{
          type: "plan_revision_declined",
          template_id: command.template_id,
          base_plan_fingerprint: command.base_plan_fingerprint,
          trigger: command.trigger,
        }],
        effect_intents: [],
        obligations: [],
        projection_hints: ["operator", "graph"],
      };
    }
    const template = fold.revision_templates.find(
      ({ id }) => id === command.template_id,
    );
    const revision = admitPlanRevision(fold, template);
    if (revision.code) return reject(fold, command, revision.code);
    const completesRun = decisionCompletesRun(fold, {
      activePlan: revision.active_plan,
      supersededCardIds: template.changes.supersede_cards,
    });
    return {
      schema: "flow.decision/v1",
      command_type: command.type,
      events: [{
        type: "plan_revised",
        ordinal: revision.ordinal,
        template_id: command.template_id,
        base_plan_fingerprint: command.base_plan_fingerprint,
        plan_fingerprint: revision.plan_fingerprint,
        trigger: command.trigger,
        changes: command.changes,
        active_plan: revision.active_plan,
      }, ...(completesRun ? [{ type: "run_succeeded" }] : [])],
      effect_intents: [],
      obligations: [],
      projection_hints: ["operator", "graph"],
    };
  }
  if (command.type === "recovery") {
    const legalRecovery = fold.legal_actions.find((action) =>
      action.type === "recovery" && digest(action) === digest(command));
    if (!legalRecovery) return reject(fold, command, "recovery_not_actionable");
    const intent = fold.effect_intents.find(
      ({ effect_id: effectId }) => effectId === command.effect_id,
    );
    return {
      schema: "flow.decision/v1",
      command_type: command.type,
      events: [{
        type: "effect_recovery_requested",
        effect_id: intent.effect_id,
        recovery: command.recovery,
      }],
      effect_intents: [],
      recovery_intents: [intent],
      obligations: [],
      projection_hints: ["operator"],
    };
  }
  if (command.type === "operation_execute") {
    const legalExecution = fold.legal_actions.find((action) =>
      action.type === "operation_execute" && digest(action) === digest(command));
    if (!legalExecution) return reject(fold, command, "operation_not_actionable");
    const operation = fold.cards.find(({ id }) => id === command.card_id);
    return operationDecision(fold, command, operation);
  }
  if (command.type === "delegate_execute") {
    const legalExecution = fold.legal_actions.find((action) =>
      action.type === "delegate_execute" && digest(action) === digest(command));
    if (!legalExecution) return reject(fold, command, "delegate_not_actionable");
    const delegate = fold.cards.find(({ id }) => id === command.card_id);
    return delegateDecision(fold, command, delegate);
  }
  if (command.type === "terminal_disposition") {
    const legalDisposition = fold.legal_actions.find((action) =>
      action.type === "terminal_disposition" &&
      digest(action) === digest(command));
    if (!legalDisposition) {
      return reject(fold, command, "terminal_disposition_not_actionable");
    }
    return {
      schema: "flow.decision/v1",
      command_type: command.type,
      events: [{
        type: "terminal_disposition_decided",
        card_id: command.card_id,
        attempt_id: command.attempt_id,
        disposition: command.disposition,
        reason: command.reason,
      }, { type: "run_declined" }],
      effect_intents: heldManagedAgentRetirementIntents(fold, {
        settlementPhase: "declined",
      }),
      obligations: [],
      projection_hints: ["operator", "graph"],
    };
  }
  if (command.type === "subrun_execute") {
    const legalExecution = fold.legal_actions.find((action) =>
      action.type === "subrun_execute" && digest(action) === digest(command));
    if (!legalExecution) return reject(fold, command, "subrun_not_actionable");
    const subrun = fold.cards.find(({ id }) => id === command.card_id);
    return operationDecision(fold, command, subrun);
  }
  if (command.type !== "checkpoint_decision") {
    return reject(fold, command, "unsupported_command");
  }

  const checkpoint = fold.cards.find(({ id }) => id === command.checkpoint_id);
  if (!checkpoint || checkpoint.executor_kind !== "checkpoint" ||
      checkpoint.status !== "waiting_checkpoint") {
    return reject(fold, command, "checkpoint_not_actionable");
  }
  if (!["approve", "decline"].includes(command.decision)) {
    return reject(fold, command, "unsupported_checkpoint_decision");
  }
  const legalCheckpointDecision = fold.legal_actions.find((action) =>
    action.type === "checkpoint_decision" && digest(action) === digest(command));
  if (!legalCheckpointDecision) {
    return reject(fold, command, "checkpoint_not_actionable");
  }

  if (command.decision === "decline") {
    return decision(
      command,
      checkpoint,
      [{ type: "run_declined" }],
      heldManagedAgentRetirementIntents(fold, {
        settlementPhase: "declined",
      }),
    );
  }

  const operation = nextOperation(fold, checkpoint.id);
  if (operation) {
    return operationDecision(fold, command, operation, [{
      type: "checkpoint_decided",
      checkpoint_id: checkpoint.id,
      decision: command.decision,
    }]);
  }

  return decision(
    command,
    checkpoint,
    decisionCompletesRun(fold, { completedCardIds: [checkpoint.id] })
      ? [{ type: "run_succeeded" }]
      : [],
  );
}

function delegateCancellationIntent(delegateIntent, {
  retireManagedAgent = false,
  settlementPhase = "cancelled",
} = {}) {
  const identity = digest({
    schema: "flow.delegate-cancellation-identity/v1",
    effect_id: delegateIntent.effect_id,
    attempt_id: delegateIntent.attempt_id,
    route_binding: delegateIntent.route_binding,
    terminal_disposition: retireManagedAgent ? "retire" : "registry_handoff",
    settlement_phase: settlementPhase,
  });
  return {
    schema: "flow.effect-intent/v1",
    effect_kind: "delegate_cancellation",
    effect_id: `effect:${identity.slice("sha256:".length)}`,
    idempotency_key: `delegate-cancellation:${identity.slice("sha256:".length)}`,
    attempt_id: `${delegateIntent.attempt_id}:cancellation`,
    delegate_attempt_id: delegateIntent.attempt_id,
    delegate_effect_id: delegateIntent.effect_id,
    retire_managed_agent: retireManagedAgent,
    settlement_phase: settlementPhase,
    card_id: delegateIntent.card_id,
    classification: "caller_idempotent",
    operation_contract: delegateIntent.operation_contract,
    route_binding: delegateIntent.route_binding,
    resource_claims: delegateIntent.resource_claims,
  };
}

function heldManagedAgentRetirementIntents(fold, {
  settlementPhase,
} = {}) {
  const effectsById = new Map((fold.effects ?? []).map((effect) => [
    effect.effect_id,
    effect,
  ]));
  return (fold.effect_intents ?? [])
    .filter((intent) => intent.effect_kind === "delegate" &&
      intent.managed_agent_binding?.terminal_card_id !== intent.card_id &&
      effectsById.get(intent.effect_id)?.receipt?.provider_receipt
        ?.terminal_disposition?.durable_holder === `flow.run:${fold.run_id}`)
    .map((intent) => delegateCancellationIntent(intent, {
      retireManagedAgent: true,
      settlementPhase,
    }));
}

function decisionCompletesRun(fold, {
  activePlan = fold.active_plan,
  completedCardIds = [],
  supersededCardIds = [],
} = {}) {
  const terminalCards = new Set(fold.cards
    .filter(({ status }) => ["completed", "superseded"].includes(status))
    .map(({ id }) => id));
  for (const cardId of [...completedCardIds, ...supersededCardIds]) {
    terminalCards.add(cardId);
  }
  const planCards = activePlan?.cards ?? fold.cards;
  return planCards.every(({ id }) => terminalCards.has(id));
}

function delegateDecision(fold, command, delegate) {
  const card = fold.active_plan.cards.find(({ id }) => id === delegate.id);
  const ordinal = fold.effect_intents.filter(
    ({ card_id: cardId, effect_kind: kind }) =>
      cardId === delegate.id && kind === "delegate",
  ).length + 1;
  const fallback = card.inputs.fallback;
  const routeBinding = fallback?.activate_for_attempt === ordinal
    ? fallback.route
    : card.route;
  let delegateInput = fallback?.activate_for_attempt === ordinal
    ? { ...card.inputs, description: fallback.description }
    : card.inputs;
  const joined = materializeDelegateJoin(fold, delegateInput);
  if (joined.code !== null) return reject(fold, command, joined.code);
  if (joined.evidence !== null) {
    const evidenceJson = JSON.stringify(joined.evidence);
    delegateInput = {
      ...delegateInput,
      authority_materialized_evidence: joined.evidence,
      prompt: `${delegateInput.prompt}\n\nAuthority-settled finding lens results:\n${evidenceJson}`,
    };
  }
  const attemptId = `${fold.run_id}:${delegate.id}:attempt:${ordinal}`;
  const effectIdentity = digest({
    schema: "flow.delegate-effect-identity/v1",
    run_id: fold.run_id,
    card_id: delegate.id,
    attempt_id: attemptId,
    route_binding: routeBinding,
  });
  const completesRun = decisionCompletesRun(fold, {
    completedCardIds: [delegate.id],
  });
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: [
      { type: "delegate_completed", card_id: delegate.id, attempt_id: attemptId },
      ...(completesRun ? [{ type: "run_succeeded" }] : []),
    ],
    effect_intents: [{
      schema: "flow.effect-intent/v1",
      effect_kind: "delegate",
      effect_id: `effect:${effectIdentity.slice("sha256:".length)}`,
      idempotency_key: `delegate:${effectIdentity.slice("sha256:".length)}`,
      attempt_id: attemptId,
      attempt_ordinal: ordinal,
      max_attempts: card.limits.max_attempts,
      card_id: delegate.id,
      classification: "caller_idempotent",
      operation_contract: card.executor.contract,
      source_authority_watermark: fold.watermark,
      delegate_input: delegateInput,
      delegate_validator_contracts: card.validators,
      managed_agent_binding: card.inputs.managed_agent ?? null,
      route_binding: routeBinding,
      resource_claims: card.resource_claims,
      terminal_disposition_policy: {
        schema: "flow.delegate-terminal-disposition-policy/v1",
        accepted_proofs: [
          "drovr_agent_retirement_receipt",
          "named_durable_handoff",
          "drovr_turn_cancellation_proof",
        ],
        retry_holder: "drovr.registry",
      },
    }],
    obligations: [],
    projection_hints: ["operator", "graph"],
  };
}

function materializeDelegateJoin(fold, inputs) {
  const cardIds = inputs?.finding_lens_card_ids ?? inputs?.delegate_evidence_card_ids;
  if (cardIds === undefined) return { code: null, evidence: null };
  if (!Array.isArray(cardIds) || duplicateValues(cardIds)) {
    return { code: "authority_evidence_declaration_invalid", evidence: null };
  }
  const evidence = [];
  for (const cardId of cardIds) {
    const resolved = resolveDelegateEvidence(fold, cardId);
    if (resolved.code !== null) return resolved;
    evidence.push(resolved.evidence);
  }
  return {
    code: null,
    evidence: {
      schema: "flow.authority-materialized-delegate-evidence/v1",
      accepted_delegates: evidence,
    },
  };
}

function nextOperation(fold, checkpointId) {
  const completed = new Set(fold.cards
    .filter(({ status }) => status === "completed")
    .map(({ id }) => id));
  completed.add(checkpointId);
  return fold.cards.find((card) => card.executor_kind === "operation" &&
    card.status === "pending" &&
    fold.active_plan.cards.find(({ id }) => id === card.id).dependencies.every(
      (dependency) => completed.has(dependency),
    ) && fold.active_plan.cards.find(({ id }) => id === checkpointId)
      .inputs?.operation_card_id === card.id);
}

function operationDecision(fold, command, operation, immediateEvents = []) {
  const operationCard = fold.active_plan.cards.find(
    ({ id }) => id === operation.id,
  );
  const materialized = materializeOperationEvidence(fold, operationCard);
  if (materialized.code !== null) return reject(fold, command, materialized.code);
  const attemptId = `${fold.run_id}:${operation.id}:attempt:1`;
  const effectIdentity = digest({
    schema: "flow.operation-effect-identity/v1",
    run_id: fold.run_id,
    card_id: operation.id,
    attempt_id: attemptId,
    operation_contract: operationCard.executor.contract,
  });
  const completedCardIds = [
    operation.id,
    ...immediateEvents
      .filter(({ type }) => type === "checkpoint_decided")
      .map(({ checkpoint_id: checkpointId }) => checkpointId),
  ];
  const completesRun = decisionCompletesRun(fold, { completedCardIds });
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: [
      ...immediateEvents,
      {
        type: "operation_completed",
        card_id: operation.id,
        attempt_id: attemptId,
      },
      ...(completesRun ? [{ type: "run_succeeded" }] : []),
    ],
    effect_intents: [{
      schema: "flow.effect-intent/v1",
      effect_id: `effect:${effectIdentity.slice("sha256:".length)}`,
      idempotency_key: `operation:${effectIdentity.slice("sha256:".length)}`,
      attempt_id: attemptId,
      card_id: operation.id,
      classification: operationCard.executor.effect_classification,
      operation_contract: operationCard.executor.contract,
      card_identity: digest(operationCard),
      revision_ordinal: fold.current_revision.ordinal,
      operation_input: {
        ...operationCard.inputs,
        ...(materialized.evidence === null ? {} : {
          authority_materialized_evidence: materialized.evidence,
        }),
      },
      source_authority_watermark: fold.watermark,
      route_binding: operationCard.route,
      resource_claims: operationCard.resource_claims,
    }],
    obligations: [],
    projection_hints: ["operator", "graph"],
  };
}

function materializeOperationEvidence(fold, operationCard) {
  const inputs = operationCard?.inputs ?? {};
  if (Object.hasOwn(inputs, "authority_materialized_evidence")) {
    return { code: "caller_materialized_evidence_forbidden", evidence: null };
  }
  const delegateCardIds = inputs.delegate_evidence_card_ids;
  const operationCardIds = inputs.operation_evidence_card_ids;
  if (delegateCardIds === undefined && operationCardIds === undefined) {
    return { code: null, evidence: null };
  }
  if (delegateCardIds !== undefined &&
      (!Array.isArray(delegateCardIds) || duplicateValues(delegateCardIds)) ||
      operationCardIds !== undefined &&
        (!Array.isArray(operationCardIds) || duplicateValues(operationCardIds))) {
    return { code: "authority_evidence_declaration_invalid", evidence: null };
  }
  const delegates = [];
  for (const cardId of delegateCardIds ?? []) {
    const resolved = resolveDelegateEvidence(fold, cardId);
    if (resolved.code !== null) return resolved;
    delegates.push(resolved.evidence);
  }
  const operations = [];
  for (const cardId of operationCardIds ?? []) {
    const resolved = resolveOperationEvidence(fold, cardId);
    if (resolved.code !== null) return resolved;
    operations.push(resolved.evidence);
  }
  const evidence = {
    schema: "flow.authority-materialized-evidence/v1",
    ...(delegates.length === 0 ? {} : { accepted_delegates: delegates }),
    ...(operations.length === 0 ? {} : {
      operation_receipts: operations,
      ...(operations.length === 1 ? { verify_receipt: operations[0].receipt } : {}),
    }),
  };
  return { code: null, evidence: freezeCanonical(evidence) };
}

function resolveDelegateEvidence(fold, cardId) {
  const card = fold.active_plan.cards.find(({ id }) => id === cardId);
  if (!card) return { code: "authority_evidence_missing", evidence: null };
  if (card.executor?.kind !== "delegate") {
    return { code: "authority_evidence_wrong_kind", evidence: null };
  }
  const attempts = fold.delegate_attempts.filter(({ card_id: id }) => id === cardId);
  if (attempts.some(({ status }) => status === "quarantined")) {
    return { code: "authority_evidence_quarantined", evidence: null };
  }
  if (attempts.length > 1) {
    return { code: "authority_evidence_ambiguous", evidence: null };
  }
  const attempt = attempts[0];
  if (attempt?.status !== "accepted" || attempt.evidence === null) {
    return { code: "authority_evidence_missing", evidence: null };
  }
  const intent = fold.effect_intents.find(({ effect_id: effectId }) =>
    effectId === attempt.effect_id);
  if (!intent) return { code: "authority_evidence_missing", evidence: null };
  return {
    code: null,
    evidence: {
      card_id: cardId,
      effect_id: attempt.effect_id,
      attempt_id: attempt.attempt_id,
      idempotency_key: intent.idempotency_key,
      source_authority_watermark: intent.source_authority_watermark,
      evidence: attempt.evidence,
    },
  };
}

function resolveOperationEvidence(fold, cardId) {
  const card = fold.active_plan.cards.find(({ id }) => id === cardId);
  if (!card) return { code: "authority_evidence_missing", evidence: null };
  if (card.executor?.kind !== "operation") {
    return { code: "authority_evidence_wrong_kind", evidence: null };
  }
  const effects = fold.effects.filter(({ card_id: id }) => id === cardId);
  if (effects.length > 1) {
    return { code: "authority_evidence_ambiguous", evidence: null };
  }
  const effect = effects[0];
  if (effect?.status === "quarantined") {
    return { code: "authority_evidence_quarantined", evidence: null };
  }
  if (effect?.status !== "succeeded" || effect.receipt === null) {
    return { code: "authority_evidence_missing", evidence: null };
  }
  const intent = fold.effect_intents.find(({ effect_id: effectId }) =>
    effectId === effect.effect_id);
  if (!intent) return { code: "authority_evidence_missing", evidence: null };
  return {
    code: null,
    evidence: {
      card_id: cardId,
      effect_id: effect.effect_id,
      attempt_id: intent.attempt_id,
      idempotency_key: intent.idempotency_key,
      source_authority_watermark: intent.source_authority_watermark,
      receipt: effect.receipt,
    },
  };
}

function duplicateValues(values) {
  return new Set(values).size !== values.length ||
    values.some((value) => typeof value !== "string" || value.length === 0);
}

function sameCanonicalValue(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function decision(command, checkpoint, terminalEvents, effectIntents = []) {
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: [
      {
        type: "checkpoint_decided",
        checkpoint_id: checkpoint.id,
        decision: command.decision,
      },
      ...terminalEvents,
    ],
    effect_intents: effectIntents,
    obligations: [],
    projection_hints: ["operator", "graph"],
  };
}

export const LifecycleKernel = Object.freeze({
  decide: decideLifecycle,
});

function reject(fold, command, code) {
  return createRejection({
    operation: "command",
    code,
    commandType: command?.type ?? null,
    runId: command?.run_id ?? null,
    bundleDigest: fold.bundle_digest,
    authorityWatermark: fold.watermark,
    authorityWatermarkDomain: "run",
    legalActions: fold.legal_actions,
  });
}

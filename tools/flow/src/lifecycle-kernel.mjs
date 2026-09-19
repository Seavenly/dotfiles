import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";
import { operationEffectIdentity } from "./effect-identity.mjs";
import {
  admitPlanRevision,
  checkRevisionCapacity,
} from "./plan-revision.mjs";
import { createRejection } from "./rejection.mjs";
import { authorityFactFromIssue } from "./authority-bindings.mjs";
import {
  deriveFeatureFinalization,
  featureCandidateViewFromCapture,
} from "./candidate-finalization.mjs";
import { declaredResultBindings } from "./result-bindings.mjs";
import { validateDelegateEvidenceSafety } from "./evidence-safety.mjs";
import {
  AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
} from "./feature-critique-contract.mjs";

const FORBIDDEN_COMMANDS = new Set([
  "generic_setter",
  "force_unlock",
  "generic_unblock",
  "timer_lease_takeover",
]);
const CALLER_MATERIALIZED_FIELDS = Object.freeze([
  "authority_materialized_evidence",
  "authority_materialized_candidate",
  "authority_materialized_candidate_digest",
  "authority_materialized_result_bindings",
  "authority_materialized_result_bindings_digest",
  "authority_materialized_critique_binding",
  "authority_materialized_critique_input",
]);
const CHECKPOINT_BINDING_SCHEMA = "flow.checkpoint-binding/v1";

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
      const authorityIssue = fold.reboot_revalidation.authority_bindings
        ?.issues?.[0];
      const code = fold.reboot_revalidation.base_valid !== true
        ? "reboot_revalidation_failed"
        : authorityIssue?.code ?? "reboot_revalidation_failed";
      return reject(
        fold,
        command,
        code,
        undefined,
        authorityIssue == null ? undefined : authorityFactFromIssue(authorityIssue),
      );
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
  const executionDeadline = fold.execution_time?.status;
  const attemptsAdmission = [
    "operation_execute",
    "delegate_execute",
    "subrun_execute",
  ].includes(command.type) || command.type === "checkpoint_decision" &&
    command.decision === "approve";
  if (attemptsAdmission &&
      ["exhausted", "uncertain", "unobserved"].includes(executionDeadline)) {
    return reject(
      fold,
      command,
      executionDeadline === "uncertain"
        ? "execution_deadline_uncertain"
        : executionDeadline === "unobserved"
          ? "execution_time_unavailable"
          : "execution_deadline_exhausted",
    );
  }
  const hasUnresolvedEffects = fold.effects?.some(
    ({ status }) => !["quarantined", "succeeded"].includes(status),
  );
  // This one-operation slice serializes completion-changing commands behind
  // effect settlement. Revisit the allow-list before admitting sibling effects.
  if (hasUnresolvedEffects &&
      !["capability_grant", "recovery", "terminal_disposition"].includes(
        command.type,
      )) {
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
    const template = fold.revision_templates.find(
      ({ id }) => id === command.template_id,
    );
    const repair = template?.repair;
    if (command.decision === "decline") {
      const admissionCode = legalRevision.admission?.code ?? null;
      return {
        schema: "flow.decision/v1",
        command_type: command.type,
        events: [{
          type: "plan_revision_declined",
          template_id: command.template_id,
          base_plan_fingerprint: command.base_plan_fingerprint,
          trigger: command.trigger,
          changes: command.changes,
          reason: admissionCode === null
            ? "operator_declined"
            : "revision_admission_rejected",
          code: admissionCode ?? "revision_declined",
          ...(repair === undefined ? {} : {
            repair,
          }),
        }],
        effect_intents: [],
        obligations: [],
        projection_hints: ["operator", "graph"],
      };
    }
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
        ...(repair === undefined ? {} : {
          repair,
        }),
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
  const checkpointDefinition = fold.active_plan?.cards?.find(({ id }) =>
    id === command.checkpoint_id) ?? checkpoint;
  if (!checkpoint || !checkpointDefinition || checkpoint.executor_kind !== "checkpoint" ||
      checkpoint.status !== "waiting_checkpoint") {
    return reject(fold, command, "checkpoint_not_actionable");
  }
  if (!["approve", "decline"].includes(command.decision)) {
    return reject(fold, command, "unsupported_checkpoint_decision");
  }
  const checkpointBinding = validateCheckpointBinding(
    command.checkpoint_binding,
    checkpointDefinition,
  );
  if (checkpointBinding.code !== null) {
    return reject(fold, command, checkpointBinding.code);
  }
  const legalCheckpointDecision = fold.legal_actions.find((action) =>
    action.type === "checkpoint_decision" &&
    digest(action) === digest(checkpointCommandIdentity(command)));
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
      checkpointBinding.value,
    );
  }

  const gatedRevision = (fold.revisions ?? [])
    .filter(({ repair }) => repair?.checkpoint_id === checkpoint.id)
    .at(-1);
  if (gatedRevision) {
    const approvalCapacity = checkRevisionCapacity({
      limits: fold.admission_limits ?? fold.limits,
      capabilityBindings: fold.admission_capability_bindings ??
        fold.capability_bindings,
      resourceClaims: fold.admission_resource_claims ?? fold.resource_claims,
      elapsedSeconds: fold.elapsed_seconds,
      changes: gatedRevision.changes,
    });
    if (approvalCapacity.code) {
      return reject(fold, command, approvalCapacity.code);
    }
  }

  const operation = nextOperation(fold, checkpoint.id);
  if (operation) {
    return operationDecision(fold, command, operation, [{
      type: "checkpoint_decided",
      checkpoint_id: checkpoint.id,
      decision: command.decision,
      ...(checkpointBinding.value === null ? {} : {
        checkpoint_binding: checkpointBinding.value,
      }),
    }], checkpointBinding.value);
  }

  return decision(
    command,
    checkpoint,
    decisionCompletesRun(fold, { completedCardIds: [checkpoint.id] })
      ? [{ type: "run_succeeded" }]
      : [],
    [],
    checkpointBinding.value,
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
    ...(delegateIntent.run_id === undefined ? {} : {
      run_id: delegateIntent.run_id,
    }),
    retire_managed_agent: retireManagedAgent,
    settlement_phase: settlementPhase,
    card_id: delegateIntent.card_id,
    classification: "caller_idempotent",
    operation_contract: delegateIntent.operation_contract,
    route_binding: delegateIntent.route_binding,
    resource_claims: delegateIntent.resource_claims,
    managed_agent_binding: delegateIntent.managed_agent_binding ?? null,
    ...(delegateIntent.delegate_input === undefined ? {} : {
      delegate_input: {
        ...(delegateIntent.delegate_input.description === undefined ? {} : {
          description: delegateIntent.delegate_input.description,
        }),
        ...(delegateIntent.delegate_input.resource_references === undefined
          ? {}
          : {
              resource_references:
                delegateIntent.delegate_input.resource_references,
            }),
      },
    }),
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
  const nextFallback = fallback?.activate_for_attempt === ordinal + 1;
  const nextRouteBinding = nextFallback ? fallback.route : routeBinding;
  const retryResourceStrategy = ordinal < card.limits.max_attempts
    ? nextFallback
      ? "retire_exact_primary_before_independent_fallback"
      : "retain_exact_primary_for_same_route_retry"
    : null;
  const baseDelegateInput = fallback?.activate_for_attempt === ordinal
    ? { ...card.inputs, description: fallback.description }
    : card.inputs;
  const materialized = materializeAuthorityEvidence(fold, card);
  if (materialized.code !== null) {
    return reject(fold, command, materialized.code);
  }
  let delegateInput = materialized.evidence === null
    ? baseDelegateInput
    : {
        ...baseDelegateInput,
        authority_materialized_evidence: materialized.evidence,
        ...materializedResultBindingInput(materialized.bindings),
      };
  const candidate = materializeFeatureCandidate(card, materialized.bindings);
  if (candidate.code !== null) return reject(fold, command, candidate.code);
  if (candidate.value !== null) {
    delegateInput = { ...delegateInput, ...candidate.value };
  }
  const critiqueInput = materializeFeatureCritiqueDelegateInput(
    card,
    materialized.evidence,
    delegateInput,
  );
  if (critiqueInput.code !== null) return reject(fold, command, critiqueInput.code);
  if (critiqueInput.value !== null) {
    delegateInput = {
      ...delegateInput,
      task_inputs: {
        ...delegateInput.task_inputs,
        ...critiqueInput.value,
      },
    };
  }
  const attemptId = `${fold.run_id}:${delegate.id}:attempt:${ordinal}`;
  const effectIdentity = digest({
    schema: "flow.delegate-effect-identity/v1",
    run_id: fold.run_id,
    card_id: delegate.id,
    attempt_id: attemptId,
    route_binding: routeBinding,
    ...(materialized.evidence?.evidence_digest === undefined ? {} : {
      authority_evidence_digest: materialized.evidence.evidence_digest,
    }),
    ...(delegateInput.authority_materialized_candidate === undefined ? {} : {
      authority_materialized_candidate_digest: digest(
        delegateInput.authority_materialized_candidate,
      ),
    }),
    ...(retryResourceStrategy === null ? {} : {
      next_route_binding: nextRouteBinding,
      retry_resource_strategy: retryResourceStrategy,
    }),
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
      ...(Number.isSafeInteger(card.limits.max_active_seconds) &&
        card.limits.max_active_seconds >= 0 ? {
          max_active_seconds: card.limits.max_active_seconds,
        } : {}),
      card_id: delegate.id,
      classification: "caller_idempotent",
      operation_contract: card.executor.contract,
      source_authority_watermark: fold.watermark,
      delegate_input: delegateInput,
      delegate_output_schemas: card.outputs,
      delegate_validator_contracts: card.validators,
      managed_agent_binding: card.inputs.managed_agent ?? null,
      route_binding: routeBinding,
      ...(retryResourceStrategy === null ? {} : {
        next_route_binding: nextRouteBinding,
        retry_resource_strategy: retryResourceStrategy,
      }),
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

function operationDecision(
  fold,
  command,
  operation,
  immediateEvents = [],
  checkpointBinding = null,
) {
  const operationCard = fold.active_plan.cards.find(
    ({ id }) => id === operation.id,
  );
  const materialized = materializeAuthorityEvidence(fold, operationCard);
  if (materialized.code !== null) return reject(fold, command, materialized.code);
  const critiqueBinding = materializeFeatureCritiqueBinding(
    fold,
    operationCard,
    materialized.bindings,
  );
  if (critiqueBinding.code !== null) {
    return reject(fold, command, critiqueBinding.code);
  }
  const operationInput = {
    ...operationCard.inputs,
    ...(materialized.evidence === null ? {} : {
      authority_materialized_evidence: materialized.evidence,
    }),
    ...materializedResultBindingInput(materialized.bindings),
    ...(critiqueBinding.value === null ? {} : {
      authority_materialized_critique_binding: critiqueBinding.value,
    }),
    ...(checkpointBinding === null ? {} : {
      checkpoint_binding: checkpointBinding,
    }),
  };
  const candidate = materializeFeatureCandidate(operationCard, materialized.bindings);
  if (candidate.code !== null) return reject(fold, command, candidate.code);
  if (candidate.value !== null) Object.assign(operationInput, candidate.value);
  const critiqueInput = materializeFeatureCritiqueOperationInput(
    fold,
    operationCard,
    candidate.value,
  );
  if (critiqueInput.code !== null) return reject(fold, command, critiqueInput.code);
  if (critiqueInput.value !== null) Object.assign(operationInput, critiqueInput.value);
  const derived = deriveSealInput(fold, operationCard, materialized.bindings);
  if (derived.code !== null) return reject(fold, command, derived.code);
  if (derived.value !== null) {
    Object.assign(operationInput, derived.value);
  }
  const identity = operationEffectIdentity({
    runId: fold.run_id,
    cardId: operation.id,
    operationContract: operationCard.executor.contract,
  });
  if (identity === null) return reject(fold, command, "invalid_operation_identity");
  const boundIdentity = bindOperationIdentity(identity, operationInput);
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
        attempt_id: boundIdentity.attempt_id,
      },
      ...(completesRun ? [{ type: "run_succeeded" }] : []),
    ],
    effect_intents: [{
      schema: "flow.effect-intent/v1",
      effect_id: boundIdentity.effect_id,
      idempotency_key: boundIdentity.idempotency_key,
      attempt_id: boundIdentity.attempt_id,
      max_attempts: Number.isSafeInteger(operationCard.limits?.max_attempts) &&
        operationCard.limits.max_attempts >= 1
        ? operationCard.limits.max_attempts
        : 1,
      ...(Number.isSafeInteger(operationCard.limits?.max_active_seconds) &&
        operationCard.limits.max_active_seconds >= 0 ? {
          max_active_seconds: operationCard.limits.max_active_seconds,
        } : {}),
      card_id: operation.id,
      classification: operationCard.executor.effect_classification,
      operation_contract: operationCard.executor.contract,
      card_identity: digest(operationCard),
      revision_ordinal: fold.current_revision.ordinal,
      operation_input: operationInput,
      source_authority_watermark: fold.watermark,
      route_binding: operationCard.route,
      resource_claims: operationCard.resource_claims,
    }],
    obligations: [],
    projection_hints: ["operator", "graph"],
  };
}

function deriveSealInput(fold, card, bindings) {
  if (card?.executor?.contract !== "flow.operation/feature-seal/v1") {
    return { code: null, value: null };
  }
  if (bindings === undefined) {
    // Older recorded plans did not declare result bindings. Preserve their
    // explicit finalization input so those runs remain replayable.
    return { code: null, value: null };
  }
  const captureBinding = (bindings ?? []).find((binding) =>
    binding.output_contract === "candidate_capture_receipt" &&
    binding.expected_schema === "work.feature-capture-receipt/v1");
  if (captureBinding === undefined) {
    return { code: "feature_finalization_capture_missing", value: null };
  }
  const derived = deriveFeatureFinalization({
    captureBinding,
    capturePolicy: card.inputs.capture_policy,
    selectedWorkspace: card.inputs.workspace,
    legacyFinalization: card.inputs.finalization,
  });
  if (derived?.code !== undefined) return derived;
  return {
    code: null,
    value: {
      finalization: derived.finalization,
      publication: derived.publication,
      authority_materialized_candidate: derived.candidate,
      authority_materialized_candidate_digest: digest(derived.candidate),
      authority_materialized_finalization_digest: derived.finalization_digest,
    },
  };
}

function materializeFeatureCritiqueBinding(fold, card, bindings) {
  if (card?.executor?.contract !== "flow.operation/feature-seal/v1" ||
      bindings === undefined) {
    return { code: null, value: null };
  }
  const critiqueCards = (card.inputs?.delegate_evidence_card_ids ?? [])
    .map((cardId) => fold.active_plan.cards.find(({ id }) => id === cardId))
    .filter((candidate) => candidate?.executor?.kind === "delegate" &&
      candidate.inputs?.phase === "critique");
  if (critiqueCards.length !== 1) {
    return { code: "authority_critique_declaration_invalid", value: null };
  }
  const expectedCardId = critiqueCards[0].id;
  const critiqueBindings = (bindings ?? []).filter((binding) =>
    binding.producer_card_id === expectedCardId &&
    binding.output_contract === "critique_observation" &&
    binding.expected_schema === "flow.delegate-evidence/v1");
  if (critiqueBindings.length !== 1) {
    return { code: "authority_critique_declaration_invalid", value: null };
  }
  const [binding] = critiqueBindings;
  return {
    code: null,
    value: freezeCanonical({
      schema: "flow.authority-critique-binding/v1",
      card_id: binding.producer_card_id,
      role: "critique",
      output_contract: binding.output_contract,
      expected_schema: binding.expected_schema,
      result_identity: binding.result_identity,
      binding_digest: binding.binding_digest,
    }),
  };
}

function materializeFeatureCandidate(card, bindings) {
  const isFeatureCritique = card?.executor?.kind === "delegate" &&
    card?.inputs?.phase === "critique";
  if (![
    "flow.operation/feature-verify/v1",
    "flow.operation/feature-seal/v1",
  ].includes(card?.executor?.contract) && !isFeatureCritique) {
    return { code: null, value: null };
  }
  if (bindings === undefined) return { code: null, value: null };
  const captureBinding = (bindings ?? []).find((binding) =>
    binding.output_contract === "candidate_capture_receipt" &&
    binding.expected_schema === "work.feature-capture-receipt/v1");
  if (captureBinding === undefined) {
    return { code: "feature_candidate_capture_missing", value: null };
  }
  const candidate = featureCandidateViewFromCapture(captureBinding);
  return candidate === null
    ? { code: "feature_candidate_capture_invalid", value: null }
    : {
      code: null,
      value: {
        authority_materialized_candidate: candidate,
        authority_materialized_candidate_digest: digest(candidate),
      },
    };
}

function materializeFeatureCritiqueDelegateInput(
  card,
  predecessorEvidence,
  delegateInput,
) {
  if (card?.executor?.kind !== "delegate" ||
      card?.inputs?.phase !== "critique" ||
      card?.inputs?.independent_critique !== true) {
    return { code: null, value: null };
  }
  const candidate = delegateInput?.authority_materialized_candidate;
  const candidateDigest = delegateInput?.authority_materialized_candidate_digest;
  const predecessorDigest = materializedEvidenceDigest(predecessorEvidence);
  const taskInputs = delegateInput?.task_inputs;
  if (!isPlainRecord(candidate) || !isDigest(candidateDigest) ||
      digest(candidate) !== candidateDigest ||
      !isPlainRecord(predecessorEvidence) || !isDigest(predecessorDigest) ||
      materializedEvidenceDigest(predecessorEvidence) !== predecessorDigest ||
      !isPlainRecord(taskInputs) ||
      Object.hasOwn(taskInputs, "candidate_digest") ||
      Object.hasOwn(taskInputs, "predecessor_evidence_digest")) {
    return { code: "authority_critique_input_invalid", value: null };
  }
  return {
    code: null,
    value: {
      candidate_digest: candidateDigest,
      predecessor_evidence_digest: predecessorDigest,
    },
  };
}

function materializeFeatureCritiqueOperationInput(
  fold,
  card,
  candidateValue,
) {
  if (card?.executor?.kind !== "operation" ||
      card?.inputs?.independent_critique !== true ||
      !["flow.operation/feature-verify/v1",
        "flow.operation/feature-seal/v1"].includes(card.executor.contract)) {
    return { code: null, value: null };
  }
  const critiqueCards = (card.inputs?.delegate_evidence_card_ids ?? [])
    .map((cardId) => fold.active_plan.cards.find(({ id }) => id === cardId))
    .filter((candidate) => candidate?.executor?.kind === "delegate" &&
      candidate.inputs?.phase === "critique" &&
      candidate.inputs?.independent_critique === true);
  if (critiqueCards.length !== 1) {
    return { code: "authority_critique_input_invalid", value: null };
  }
  const critiqueCardId = critiqueCards[0].id;
  const critiqueIntents = fold.effect_intents.filter((intent) =>
    intent.effect_kind === "delegate" && intent.card_id === critiqueCardId);
  if (critiqueIntents.length !== 1) {
    return { code: "authority_critique_input_invalid", value: null };
  }
  const critiqueDelegateInput = critiqueIntents[0].delegate_input;
  const candidate = candidateValue?.authority_materialized_candidate;
  const candidateDigest = candidateValue?.authority_materialized_candidate_digest;
  const predecessorEvidence = critiqueDelegateInput?.authority_materialized_evidence;
  const predecessorDigest = materializedEvidenceDigest(predecessorEvidence);
  if (!isPlainRecord(candidate) || !isDigest(candidateDigest) ||
      digest(candidate) !== candidateDigest ||
      !isPlainRecord(predecessorEvidence) || !isDigest(predecessorDigest) ||
      materializedEvidenceDigest(predecessorEvidence) !== predecessorDigest ||
      critiqueDelegateInput.authority_materialized_candidate_digest !==
        candidateDigest ||
      critiqueDelegateInput.task_inputs?.candidate_digest !== candidateDigest ||
      critiqueDelegateInput.task_inputs?.predecessor_evidence_digest !==
        predecessorDigest) {
    return { code: "authority_critique_input_invalid", value: null };
  }
  const identity = {
    schema: AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
    card_id: critiqueCardId,
    candidate_digest: candidateDigest,
    predecessor_evidence_digest: predecessorDigest,
  };
  return {
    code: null,
    value: {
      authority_materialized_critique_input: freezeCanonical({
        ...identity,
        binding_digest: digest(identity),
      }),
    },
  };
}

function bindOperationIdentity(identity, operationInput) {
  const finalizationDigest = operationInput
    ?.authority_materialized_finalization_digest;
  const candidateDigest = operationInput
    ?.authority_materialized_candidate_digest;
  if (finalizationDigest === undefined && candidateDigest === undefined) {
    return identity;
  }
  const bound = digest({
    schema: "flow.feature-seal-effect-identity/v1",
    base_effect_id: identity.effect_id,
    base_idempotency_key: identity.idempotency_key,
    ...(finalizationDigest === undefined ? {} : {
      finalization: operationInput.finalization,
      finalization_digest: finalizationDigest,
    }),
    ...(candidateDigest === undefined ? {} : {
      candidate: operationInput.authority_materialized_candidate,
      candidate_digest: candidateDigest,
    }),
  }).slice("sha256:".length);
  return Object.freeze({
    ...identity,
    effect_id: `effect:${bound}`,
    idempotency_key: `operation:${bound}`,
  });
}

function materializeAuthorityEvidence(fold, card) {
  const inputs = card?.inputs ?? {};
  if (Object.hasOwn(inputs, "authority_materialized_evidence") ||
      Object.hasOwn(inputs, "predecessor_evidence") ||
      CALLER_MATERIALIZED_FIELDS.some((field) => Object.hasOwn(inputs, field))) {
    return { code: "caller_materialized_evidence_forbidden", evidence: null };
  }
  const declared = declaredResultBindings(fold.active_plan, card?.id);
  if (declared !== null) {
    const hasEvidenceReferences = [
      inputs.delegate_evidence_card_ids,
      inputs.operation_evidence_card_ids,
      inputs.test_card_ids,
    ].some((references) => references !== undefined);
    if (declared.length === 0 && !hasEvidenceReferences) {
      return { code: null, evidence: null };
    }
    return materializeDeclaredResultBindings(fold, card, declared);
  }
  const delegateCardIds = inputs.delegate_evidence_card_ids ??
    inputs.finding_lens_card_ids;
  const operationCardIds = inputs.operation_evidence_card_ids;
  if (delegateCardIds === undefined && operationCardIds === undefined) {
    return { code: null, evidence: null };
  }
  if (inputs.delegate_evidence_card_ids !== undefined &&
      inputs.finding_lens_card_ids !== undefined) {
    return { code: "authority_evidence_declaration_invalid", evidence: null };
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
  if (inputs.finding_lens_card_ids !== undefined &&
      inputs.authority_materialization !== "exact_digest_bound" &&
      operationCardIds === undefined) {
    return {
      code: null,
      evidence: freezeCanonical({
        schema: "flow.authority-materialized-delegate-evidence/v1",
        accepted_delegates: delegates,
      }),
    };
  }
  const evidence = {
    schema: "flow.authority-materialized-evidence/v1",
    ...(delegates.length === 0 ? {} : { accepted_delegates: delegates }),
    ...(operations.length === 0 ? {} : {
      operation_receipts: operations,
      ...(operations.length === 1 ? { verify_receipt: operations[0].receipt } : {}),
    }),
  };
  return {
    code: null,
    evidence: freezeCanonical({
      ...evidence,
      evidence_digest: digest(evidence),
    }),
  };
}

function materializedResultBindingInput(bindings) {
  return bindings === undefined
    ? {}
    : {
        authority_materialized_result_bindings: bindings,
        authority_materialized_result_bindings_digest: digest(bindings),
      };
}

function materializeDeclaredResultBindings(fold, card, declarations) {
  const declaredProducerIds = new Set();
  const evidenceProducerIds = new Set([
    ...(card.inputs.delegate_evidence_card_ids ?? []),
    ...(card.inputs.operation_evidence_card_ids ?? []),
    ...(card.inputs.test_card_ids ?? []),
  ]);
  const records = fold.result_bindings ?? [];
  const bindings = [];
  for (const declaration of declarations) {
    const declarationKey = `${declaration.producer_card_id}:` +
      declaration.output_contract;
    if (declaredProducerIds.has(declarationKey) ||
        !evidenceProducerIds.has(declaration.producer_card_id)) {
      return { code: "authority_result_declaration_invalid", evidence: null };
    }
    declaredProducerIds.add(declarationKey);
    const producer = fold.active_plan.cards.find(({ id }) =>
      id === declaration.producer_card_id);
    if (!producer) {
      return { code: "authority_result_wrong_producer", evidence: null };
    }
    if (!producer.outputs.includes(declaration.output_contract)) {
      return { code: "authority_result_wrong_output", evidence: null };
    }
    const matches = records.filter((record) =>
      record.producer_card_id === declaration.producer_card_id &&
      record.output_contract === declaration.output_contract &&
      record.expected_schema === declaration.expected_schema);
    if (matches.length === 0) {
      return { code: "authority_result_missing", evidence: null };
    }
    if (matches.length !== 1) {
      return { code: "authority_result_ambiguous", evidence: null };
    }
    const record = matches[0];
    if (record.observed_schema !== declaration.expected_schema) {
      return { code: "authority_result_schema_mismatch", evidence: null };
    }
    if (fold.superseded_cards.includes(declaration.producer_card_id)) {
      return { code: "authority_result_superseded", evidence: null };
    }
    const producerIntent = fold.effect_intents.find(({ effect_id: effectId }) =>
      effectId === record.provenance.effect_id);
    if (!producerIntent || producerIntent.card_id !== declaration.producer_card_id ||
        producerIntent.attempt_id !== record.attempt_id ||
        producerIntent.idempotency_key !== record.provenance.idempotency_key ||
        producerIntent.source_authority_watermark !==
          record.provenance.source_authority_watermark) {
      return { code: "authority_result_stale", evidence: null };
    }
    const workspaceClaim = producer.resource_claims?.find(({ kind }) =>
      kind === "workspace");
    if (workspaceClaim !== undefined &&
        (record.producer_generation !== workspaceClaim.generation ||
         record.workspace_mutation_epoch !== workspaceClaim.mutation_epoch)) {
      return { code: "authority_result_stale", evidence: null };
    }
    bindings.push(record);
  }
  for (const producerCardId of evidenceProducerIds) {
    if (!declarations.some(({ producer_card_id: candidate }) =>
      candidate === producerCardId)) {
      return { code: "authority_result_undeclared", evidence: null };
    }
  }
  const delegates = [];
  const operations = [];
  let verificationReceipt = null;
  const operationOrder = new Map(
    (card.inputs.operation_evidence_card_ids ?? [])
      .map((cardId, index) => [cardId, index]),
  );
  const delegateOrder = new Map(
    (card.inputs.delegate_evidence_card_ids ?? [])
      .map((cardId, index) => [cardId, index]),
  );
  const testOrder = new Map(
    (card.inputs.test_card_ids ?? [])
      .map((cardId, index) => [cardId, index]),
  );
  const producerOrder = (binding) => {
    const producer = fold.active_plan.cards.find(({ id }) =>
      id === binding.producer_card_id);
    const kind = producer?.executor?.kind;
    if (kind === "operation") {
      return [0, operationOrder.get(binding.producer_card_id) ??
        testOrder.get(binding.producer_card_id) ?? Infinity];
    }
    if (kind === "delegate") {
      return [1, delegateOrder.get(binding.producer_card_id) ?? Infinity];
    }
    return [2, Infinity];
  };
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const orderedBindings = [...bindings].sort((left, right) => {
    const [leftKind, leftIndex] = producerOrder(left);
    const [rightKind, rightIndex] = producerOrder(right);
    if (leftKind !== rightKind) return leftKind - rightKind;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    for (const [leftValue, rightValue] of [
      [left.producer_card_id, right.producer_card_id],
      [left.output_contract, right.output_contract],
      [left.expected_schema, right.expected_schema],
      [left.attempt_id, right.attempt_id],
      [left.result_identity, right.result_identity],
      [left.binding_digest, right.binding_digest],
    ]) {
      const comparison = compareText(leftValue, rightValue);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
  for (const binding of orderedBindings) {
    const producer = fold.active_plan.cards.find(({ id }) =>
      id === binding.producer_card_id);
    const effect = fold.effects.find(({ effect_id: effectId }) =>
      effectId === binding.provenance.effect_id);
    if (producer.executor.kind === "delegate") {
      delegates.push({
        card_id: binding.producer_card_id,
        effect_id: binding.provenance.effect_id,
        attempt_id: binding.attempt_id,
        idempotency_key: binding.provenance.idempotency_key,
        source_authority_watermark: binding.provenance.source_authority_watermark,
        evidence: transferableDelegateEvidence(binding.content),
      });
    } else if (producer.executor.kind === "operation") {
      const entry = {
        card_id: binding.producer_card_id,
        effect_id: binding.provenance.effect_id,
        attempt_id: binding.attempt_id,
        idempotency_key: binding.provenance.idempotency_key,
        source_authority_watermark: binding.provenance.source_authority_watermark,
        receipt: effect?.receipt ?? null,
      };
      operations.push(entry);
      if (binding.output_contract === "verification_receipt") {
        verificationReceipt = entry.receipt;
      }
    } else {
      return { code: "authority_result_wrong_kind", evidence: null };
    }
  }
  const evidence = {
    schema: "flow.authority-materialized-evidence/v1",
    ...(delegates.length === 0 ? {} : { accepted_delegates: delegates }),
    ...(operations.length === 0 ? {} : {
      operation_receipts: operations,
      ...(verificationReceipt === null && operations.length === 1
        ? { verify_receipt: operations[0].receipt }
        : {}),
      ...(verificationReceipt === null ? {} : {
        verify_receipt: verificationReceipt,
      }),
    }),
  };
  return {
    code: null,
    evidence: freezeCanonical({
      ...evidence,
      evidence_digest: digest(evidence),
    }),
    bindings: freezeCanonical(bindings),
  };
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
  if (!delegateEvidenceSafetyValid(attempt.evidence)) {
    return { code: "authority_evidence_safety_missing", evidence: null };
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
      evidence: transferableDelegateEvidence(attempt.evidence),
    },
  };
}

function transferableDelegateEvidence(evidence) {
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

function delegateEvidenceSafetyValid(providerReceipt) {
  if (!isPlainRecord(providerReceipt) ||
      providerReceipt.schema !== "flow.delegate-evidence/v1" ||
      typeof providerReceipt.validated_output !== "string" ||
      !isPlainRecord(providerReceipt.evidence_safety_receipt) ||
      !isPlainRecord(providerReceipt.evidence_safety_binding)) {
    return false;
  }
  const expected = validateDelegateEvidenceSafety(
    providerReceipt.validated_output,
    { classification: providerReceipt.evidence_safety_receipt.classification },
  );
  return expected.accepted === true &&
    JSON.stringify(expected.receipt) ===
      JSON.stringify(providerReceipt.evidence_safety_receipt) &&
    JSON.stringify(expected.binding) ===
      JSON.stringify(providerReceipt.evidence_safety_binding);
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

function decision(
  command,
  checkpoint,
  terminalEvents,
  effectIntents = [],
  checkpointBinding = null,
) {
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: [
      {
        type: "checkpoint_decided",
        checkpoint_id: checkpoint.id,
        decision: command.decision,
        ...(checkpointBinding === null ? {} : {
          checkpoint_binding: checkpointBinding,
        }),
      },
      ...terminalEvents,
    ],
    effect_intents: effectIntents,
    obligations: [],
    projection_hints: ["operator", "graph"],
  };
}

function checkpointCommandIdentity(command) {
  if (!Object.hasOwn(command, "checkpoint_binding")) return command;
  const { checkpoint_binding: _binding, ...identity } = command;
  return identity;
}

function validateCheckpointBinding(binding, checkpoint) {
  const requiredSchema = checkpoint.inputs?.required_checkpoint_binding_schema;
  if (binding === undefined) {
    return requiredSchema === undefined
      ? { code: null, value: null }
      : { code: "checkpoint_binding_required", value: null };
  }
  try {
    if (binding?.schema !== CHECKPOINT_BINDING_SCHEMA ||
        Object.keys(binding).length !== 4 ||
        !["schema", "checkpoint_id", "draft", "draft_digest"].every((key) =>
          Object.hasOwn(binding, key)) ||
        binding.checkpoint_id !== checkpoint.id ||
        (requiredSchema !== undefined && binding.schema !== requiredSchema) ||
        !isRecord(binding.draft) ||
        typeof binding.draft_digest !== "string" ||
        digest(binding.draft) !== binding.draft_digest) {
      return { code: "invalid_checkpoint_binding", value: null };
    }
    return { code: null, value: binding };
  } catch {
    return { code: "invalid_checkpoint_binding", value: null };
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function materializedEvidenceDigest(value) {
  if (!isPlainRecord(value) || !isDigest(value.evidence_digest)) return null;
  const { evidence_digest: _evidenceDigest, ...identity } = value;
  try {
    return digest(identity) === value.evidence_digest
      ? value.evidence_digest
      : null;
  } catch {
    return null;
  }
}

export const LifecycleKernel = Object.freeze({
  decide: decideLifecycle,
});

function reject(
  fold,
  command,
  code,
  authorityWatermark = undefined,
  authorityFact = undefined,
) {
  return createRejection({
    operation: "command",
    code,
    commandType: command?.type ?? null,
    runId: command?.run_id ?? null,
    bundleDigest: fold.bundle_digest,
    authorityWatermark: authorityWatermark === undefined
      ? fold.watermark
      : authorityWatermark,
    authorityWatermarkDomain: "run",
    legalActions: fold.legal_actions,
    authorityFact,
  });
}

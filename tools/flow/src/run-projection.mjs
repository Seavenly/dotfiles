import { digest, freezeCanonical, uniqueCanonical } from "./canonical.mjs";
import { effectClassPolicy } from "./operation-effects.mjs";
import { admitPlanRevision } from "./plan-revision.mjs";
import { deriveChildRunId } from "./subrun-effects.mjs";
import { isTrackerProgressContract } from "./tracker-progress.mjs";
import { buildRunViews } from "./projection-builder.mjs";

export function foldRun(run, { watermark = runWatermark(run) } = {}) {
  const launchOwnership = run.events.find(({ type }) => type === "run_launched")
    ?.run_ownership;
  if (launchOwnership === undefined &&
      run.prepared.explicit_facts.tracker_binding !== undefined) {
    throw new TypeError("tracker-bound run is missing authority-owned scope");
  }
  const runOwnership = launchOwnership ?? {
    schema: "flow.run-ownership/v1",
    scope: "top_level",
    parent_run_id: null,
  };
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
  const observedBlocks = new Map(
    run.events
      .filter(({ type }) => type === "card_blocked")
      .map(({ card_id: cardId, block }) => [cardId, block]),
  );
  const effectIntents = new Map();
  const effectReceipts = new Map();
  const effectReceiptIndexes = new Map();
  const effectInvocationIndexes = new Map();
  const effectObservations = new Map();
  let cancellationEvent = null;
  let cancellationIndex = -1;
  for (const [eventIndex, event] of run.events.entries()) {
    if (["effect_intent_recorded", "effect_intent_adopted"].includes(
      event.type,
    )) {
      effectIntents.set(event.intent.effect_id, event.intent);
    } else if (event.type === "effect_receipt_recorded") {
      effectReceipts.set(event.effect_id, event.receipt ?? null);
      effectReceiptIndexes.set(event.effect_id, eventIndex);
    } else if (event.type === "effect_observation_recorded") {
      effectObservations.set(event.effect_id, event.observation);
    } else if (event.type === "effect_invocation_started") {
      effectInvocationIndexes.set(event.effect_id, eventIndex);
    } else if (event.type === "run_cancelled") {
      cancellationEvent = event;
      cancellationIndex = eventIndex;
    }
  }
  const completedOperations = new Set(run.events
    .filter(({ type }) => type === "operation_completed")
    .map(({ card_id: cardId }) => cardId));
  const handoffs = run.events
    .filter(({ type }) => type === "resource_handoff_published")
    .map(({ handoff_id: handoffId, handoff_watermark: handoffWatermark }) => ({
      handoff_id: handoffId,
      handoff_watermark: handoffWatermark,
    }));
  const reviewCandidateEvent = run.events
    .filter(({ type }) => type === "review_candidate_referenced")
    .at(-1);
  const reviewCandidateReference = reviewCandidateEvent === undefined
    ? null
    : {
      candidate_id: reviewCandidateEvent.candidate_id,
      candidate_fingerprint: reviewCandidateEvent.candidate_fingerprint,
      review_authority_watermark:
        reviewCandidateEvent.review_authority_watermark,
    };
  const resourceHandoffBindings = run.events
    .filter(({ type }) => type === "resource_handoff_bound")
    .map(({
      handoff_id: handoffId,
      handoff_digest: handoffDigest,
      binding_digest: bindingDigest,
      operations,
    }) => ({
      handoff_id: handoffId,
      handoff_digest: handoffDigest,
      binding_digest: bindingDigest,
      operations,
    }));
  const completedDelegates = new Set(run.events
    .filter(({ type }) => type === "delegate_completed")
    .map(({ card_id: cardId }) => cardId));
  const quarantinedDelegateOutputs = run.events
    .filter(({ type }) => type === "delegate_output_quarantined")
    .map(({ type: _type, ...output }) => output);
  const unresolvedEffectIds = new Set([...effectIntents.keys()].filter(
    (effectId) => !effectReceipts.has(effectId),
  ));
  const failedSubruns = new Set(run.events
    .filter(({ type }) => type === "subrun_failed")
    .map(({ card_id: cardId }) => cardId));
  const subrunAdmissions = new Map(run.events
    .filter(({ type }) => type === "subrun_admitted")
    .map((event) => [event.card_id, event]));
  const grantEvents = run.events.filter(({ type }) => type === "capability_granted");
  const grants = grantEvents.map(({ type: _type, ...grant }) => grant);
  const revisionEvents = run.events.filter(({ type }) => type === "plan_revised");
  const latestRevision = revisionEvents.at(-1);
  const activePlan = latestRevision?.active_plan ?? run.prepared.graph;
  const supersededCards = [...new Set(
    revisionEvents.flatMap(({ changes }) => changes.supersede_cards),
  )].sort();
  const capabilityBindings = uniqueCanonical([
    ...run.prepared.requested_authority.capabilities.map((capability) => ({
      capability,
      card_ids: ["*"],
    })),
    ...grantEvents.flatMap(({ capabilities: values, card_ids: cardIds }) =>
      values.map((capability) => ({ capability, card_ids: cardIds }))),
    ...revisionEvents.flatMap(({ changes }) => changes.capability_additions),
  ]);
  const capabilities = [...new Set(
    capabilityBindings.map(({ capability }) => capability),
  )].sort();
  const resourceClaims = uniqueCanonical([
    ...run.prepared.explicit_facts.resource_claims,
    ...revisionEvents.flatMap(({ changes }) => changes.resource_additions),
  ]);
  const limits = revisionEvents.reduce(
    (current, { changes }) => ({ ...current, ...changes.limit_changes }),
    run.prepared.explicit_facts.limits,
  );
  const phase = run.events.some(({ type }) => type === "run_cancelled")
    ? "cancelled"
    : run.events.some(({ type }) => type === "run_declined")
      ? "declined"
      : run.events.some(({ type }) => type === "run_succeeded")
        ? "succeeded"
        : "active";
  const resourceDispositions = cancellationEvent?.resource_dispositions ??
    resourceClaims.map((claim) => ({
      claim,
      disposition: phase === "active" ? "held" : "released",
    }));
  const activeObservedBlocks = new Map();
  const cards = activePlan.cards.map((card) => {
    let status = "pending";
    if (supersededCards.includes(card.id)) {
      status = "superseded";
    } else if (failedSubruns.has(card.id)) {
      status = "declined";
    } else if (completedOperations.has(card.id) ||
        completedDelegates.has(card.id)) {
      status = "completed";
    } else if (checkpointDecisions.get(card.id) === "decline") {
      status = "declined";
    } else if (approvedCheckpoints.has(card.id)) {
      status = "completed";
    } else if (phase === "cancelled") {
      status = "abandoned";
    } else if ([...effectIntents.values()].some(
      ({ card_id: cardId, effect_id: effectId }) =>
        cardId === card.id && unresolvedEffectIds.has(effectId),
    )) {
      status = "executing";
    } else if (quarantinedDelegateOutputs.some(
      ({ card_id: cardId }) => cardId === card.id,
    )) {
      status = "blocked";
    } else if (phase === "active" && card.dependencies.every((dependency) =>
      approvedCheckpoints.has(dependency) ||
      completedOperations.has(dependency) ||
      completedDelegates.has(dependency))) {
      const block = observedBlocks.get(card.id);
      const capabilityBlocked = block?.type === "capability_required" &&
        !block.required_capabilities.every((capability) =>
          capabilityApplies(capabilityBindings, capability, card.id));
      const revisionBlocked = block?.type === "plan_revision_required";
      if (capabilityBlocked || revisionBlocked) {
        activeObservedBlocks.set(card.id, block);
      }
      status = capabilityBlocked || revisionBlocked
        ? "blocked"
        : card.executor.kind === "checkpoint" ? "waiting_checkpoint" : "ready";
    }
    return {
      id: card.id,
      executor_kind: card.executor.kind,
      status,
    };
  });
  const planFingerprint = latestRevision?.plan_fingerprint ??
    run.prepared.plan_fingerprint;
  const blocks = cards
    .filter(({ status }) => status === "blocked")
    .map(({ id }) => {
      const observed = activeObservedBlocks.get(id);
      if (observed) return { card_id: id, ...observed };
      const quarantined = quarantinedDelegateOutputs.filter(
        ({ card_id: cardId }) => cardId === id,
      ).at(-1);
      return {
        schema: "flow.delegate-card-block/v1",
        id: `${quarantined.attempt_id}:quarantined-output`,
        type: "delegate_output_quarantined",
        card_id: id,
        attempt_id: quarantined.attempt_id,
        quarantine_reason: quarantined.quarantine_record.quarantine_reason,
      };
    });
  const revisions = revisionEvents.map((revision) => ({
    ordinal: revision.ordinal,
    template_id: revision.template_id,
    base_plan_fingerprint: revision.base_plan_fingerprint,
    plan_fingerprint: revision.plan_fingerprint,
    trigger: revision.trigger,
    changes: revision.changes,
  }));
  const currentRevision = latestRevision
    ? {
      ordinal: latestRevision.ordinal,
      base_plan_fingerprint: latestRevision.base_plan_fingerprint,
      plan_fingerprint: latestRevision.plan_fingerprint,
      trigger: latestRevision.trigger,
    }
    : { ordinal: 0, plan_fingerprint: run.prepared.plan_fingerprint };
  const revisionState = {
    current_revision: currentRevision,
    revisions,
    cards,
    active_plan: activePlan,
    superseded_cards: supersededCards,
    limits,
    capability_envelopes: run.prepared.explicit_facts.capability_envelopes,
    capability_bindings: capabilityBindings,
    resource_claims: resourceClaims,
    elapsed_seconds: run.prepared.explicit_facts.elapsed_seconds,
  };
  const checkpointActions = cards
    .filter(({ executor_kind: kind, status }) =>
      kind === "checkpoint" && status === "waiting_checkpoint")
    .flatMap(({ id }) => ["approve", "decline"].map((decision) => ({
      schema: "flow.command/v1",
      type: "checkpoint_decision",
      run_id: run.run_id,
      checkpoint_id: id,
      decision,
      expected_watermark: watermark,
    })));
  const capabilityActions = blocks
    .filter(({ type }) => type === "capability_required")
    .filter((block) => {
      const nextCapabilities = new Set([
        ...capabilities,
        ...block.required_capabilities,
      ]);
      return block.required_capabilities.length > 0 &&
        nextCapabilities.size <= limits.max_capabilities;
    })
    .map((block) => ({
      schema: "flow.command/v1",
      type: "capability_grant",
      run_id: run.run_id,
      grant_id: `${block.id}:grant`,
      capabilities: block.required_capabilities,
      card_ids: [block.card_id],
      base_plan_fingerprint: planFingerprint,
      trigger: block.trigger,
      expected_watermark: watermark,
    }));
  const revisionActions = blocks
    .filter(({ type }) => type === "plan_revision_required")
    .flatMap((block) =>
    block.revision_template_ids.flatMap((templateId) => {
      const template = run.prepared.revision_templates.find(
        ({ id }) => id === templateId,
      );
      const action = {
        schema: "flow.command/v1",
        type: "revision_decision",
        run_id: run.run_id,
        template_id: template.id,
        base_plan_fingerprint: planFingerprint,
        trigger: block.trigger,
        changes: template.changes,
        expected_watermark: watermark,
      };
      const decline = { ...action, decision: "decline" };
      if (admitPlanRevision(revisionState, template).code) return [decline];
      return [{ ...action, decision: "accept" }, decline];
    }),
  );
  const operationActions = cards
    .filter(({ executor_kind: kind, status }) =>
      kind === "operation" && status === "ready")
    .filter(({ id }) => trackerProgressActionIsCurrent({
      activePlan,
      cards,
      operationId: id,
    }))
    .filter(({ id }) => !effectClassPolicy(activePlan.cards.find(
      (card) => card.id === id,
    ).executor.effect_classification).requires_fresh_checkpoint)
    .map(({ id }) => ({
      schema: "flow.command/v1",
      type: "operation_execute",
      run_id: run.run_id,
      card_id: id,
      expected_watermark: watermark,
    }));
  const delegateActions = cards
    .filter(({ id, executor_kind: kind, status }) =>
      kind === "delegate" && (status === "ready" ||
        status === "blocked" && !activeObservedBlocks.has(id) &&
        quarantinedDelegateOutputs.some(
          ({ card_id: cardId }) => cardId === id,
        )))
    .filter(({ id }) => {
      const attempts = [...effectIntents.values()].filter(
        ({ card_id: cardId, effect_kind: kind }) =>
          cardId === id && kind === "delegate",
      ).length;
      const card = activePlan.cards.find(({ id: cardId }) => cardId === id);
      return attempts < card.limits.max_attempts;
    })
    .map(({ id }) => ({
      schema: "flow.command/v1",
      type: "delegate_execute",
      run_id: run.run_id,
      card_id: id,
      expected_watermark: watermark,
    }));
  const delegateDispositionActions = cards
    .filter(({ executor_kind: kind, status }) =>
      kind === "delegate" && status === "blocked")
    .filter(({ id }) => !activeObservedBlocks.has(id) &&
      quarantinedDelegateOutputs.some(
        ({ card_id: cardId }) => cardId === id,
      ))
    .filter(({ id }) => {
      const attempts = [...effectIntents.values()].filter(
        ({ card_id: cardId, effect_kind: kind }) =>
          cardId === id && kind === "delegate",
      ).length;
      const card = activePlan.cards.find(({ id: cardId }) => cardId === id);
      return attempts >= card.limits.max_attempts;
    })
    .map(({ id }) => {
      const quarantine = quarantinedDelegateOutputs.filter(
        ({ card_id: cardId }) => cardId === id,
      ).at(-1);
      return {
        schema: "flow.command/v1",
        type: "terminal_disposition",
        run_id: run.run_id,
        card_id: id,
        attempt_id: quarantine.attempt_id,
        disposition: "decline",
        reason: "delegate_attempts_exhausted",
        expected_watermark: watermark,
      };
    });
  const subrunActions = cards
    .filter(({ executor_kind: kind, status }) =>
      kind === "subrun" && status === "ready")
    .map(({ id }) => ({
      schema: "flow.command/v1",
      type: "subrun_execute",
      run_id: run.run_id,
      card_id: id,
      expected_watermark: watermark,
    }));
  const hasCancellationReceiptFor = (delegateEffectId) =>
    [...effectIntents.values()].some((intent) =>
      intent.effect_kind === "delegate_cancellation" &&
      intent.delegate_effect_id === delegateEffectId &&
      effectReceipts.has(intent.effect_id));
  const recoveryActions = [...effectIntents.values()]
    .filter((intent) => !effectReceipts.has(intent.effect_id))
    .filter((intent) => phase !== "cancelled" ||
      intent.effect_kind === "delegate_cancellation" ||
      ((intent.effect_kind !== "delegate" ||
        hasCancellationReceiptFor(intent.effect_id)) &&
       (intent.effect_kind === "delegate" ||
        effectClassPolicy(intent.classification).requires_observation) &&
      effectInvocationIndexes.has(intent.effect_id) &&
      effectInvocationIndexes.get(intent.effect_id) < cancellationIndex))
    .map((intent) => ({
      schema: "flow.command/v1",
      type: "recovery",
      run_id: run.run_id,
      effect_id: intent.effect_id,
      recovery: phase === "cancelled"
        ? "settle_cancelled"
        : effectClassPolicy(intent.classification).recovery,
      expected_watermark: watermark,
    }));
  const cancellationActions = run.prepared.requested_authority.commands.includes(
    "cancel",
  ) ? [{
      schema: "flow.command/v1",
      type: "cancel",
      run_id: run.run_id,
      expected_watermark: watermark,
    }] : [];
  const hasUnresolvedEffects = effectIntents.size > effectReceipts.size;
  const legalActions = phase === "cancelled"
    ? recoveryActions
    : phase === "active"
    ? hasUnresolvedEffects
      ? [...capabilityActions, ...recoveryActions, ...cancellationActions]
      : [
        ...checkpointActions,
        ...capabilityActions,
        ...revisionActions,
        ...operationActions,
        ...delegateActions,
        ...delegateDispositionActions,
        ...subrunActions,
        ...recoveryActions,
        ...cancellationActions,
      ]
      : [];
  const progress = phase !== "active"
    ? "complete"
    : blocks.length > 0 ? "blocked"
      : hasUnresolvedEffects ? "executing" : "waiting";
  const isCancellationEffect = (effectId) =>
    effectIntents.get(effectId)?.effect_kind === "delegate_cancellation";
  const hasLateReceipt = (effectId) => cancellationIndex >= 0 &&
    !isCancellationEffect(effectId) &&
    effectReceipts.has(effectId) &&
    effectReceiptIndexes.get(effectId) > cancellationIndex;
  const isQuarantinedAfterCancellation = (effectId) =>
    cancellationIndex >= 0 &&
    !isCancellationEffect(effectId) &&
    (!effectReceipts.has(effectId) || hasLateReceipt(effectId));
  const effects = [...effectIntents.values()].map((intent) => ({
    ...(intent.run_id === undefined ? {} : { run_id: intent.run_id }),
    effect_id: intent.effect_id,
    card_id: intent.card_id ?? null,
    attempt_id: intent.attempt_id,
    classification: intent.classification,
    operation_contract: intent.operation_contract,
    ...(intent.operation_input === undefined ? {} : {
      operation_input: intent.operation_input,
    }),
    ...(intent.source_authority_watermark === undefined ? {} : {
      source_authority_watermark: intent.source_authority_watermark,
    }),
    effect_kind: intent.effect_kind ?? "operation",
    idempotency_key: intent.idempotency_key,
    route_binding: intent.route_binding,
    invocation_started: effectInvocationIndexes.has(intent.effect_id),
    status: effectReceipts.get(intent.effect_id)?.outcome === "not_created"
      ? "not_created"
      : effectReceipts.has(intent.effect_id)
      ? hasLateReceipt(intent.effect_id)
        ? effectReceipts.get(intent.effect_id)?.outcome === "quarantined"
          ? "late_quarantined"
          : "late_succeeded"
        : effectReceipts.get(intent.effect_id)?.outcome === "quarantined"
          ? "quarantined"
          : "succeeded"
      : cancellationIndex >= 0 &&
          !isCancellationEffect(intent.effect_id) &&
          (!effectInvocationIndexes.has(intent.effect_id) ||
           effectInvocationIndexes.get(intent.effect_id) > cancellationIndex)
        ? "abandoned"
      : effectObservations.has(intent.effect_id)
        ? ["delegate", "delegate_cancellation"].includes(intent.effect_kind) &&
          effectObservations.get(intent.effect_id).presence === "indeterminate"
          ? "reconciling"
          : effectClassPolicy(intent.classification).observed_unresolved_status
        : "unresolved",
    disposition: isQuarantinedAfterCancellation(intent.effect_id)
      ? "quarantined"
      : "accepted",
    last_observation: effectObservations.get(intent.effect_id) ?? null,
    receipt: effectReceipts.get(intent.effect_id) ?? null,
  })).sort((left, right) => left.effect_id < right.effect_id ? -1 : 1);
  const attempts = [...effectIntents.values()].map((intent) => ({
    attempt_id: intent.attempt_id,
    card_id: intent.card_id ?? null,
    effect_id: intent.effect_id,
    status: isQuarantinedAfterCancellation(intent.effect_id)
      ? "abandoned"
      : effectReceipts.has(intent.effect_id) ? "completed" : "active",
  })).sort((left, right) => left.attempt_id < right.attempt_id ? -1 : 1);
  const trackerProgress = buildTrackerProgressProjection({
    activePlan,
    effects,
    foldWatermark: watermark,
    legalActions,
    prepared: run.prepared,
    runOwnership,
    runId: run.run_id,
    cards,
  });
  const delegateAttempts = [...effectIntents.values()]
    .filter(({ effect_kind: kind }) => kind === "delegate")
    .map((intent) => {
      const receipt = effectReceipts.get(intent.effect_id);
      return {
        attempt_id: intent.attempt_id,
        card_id: intent.card_id,
        effect_id: intent.effect_id,
        caller_key: intent.attempt_id,
        route_binding: intent.route_binding,
        status: isQuarantinedAfterCancellation(intent.effect_id)
          ? "abandoned"
          : receipt
          ? receipt.outcome === "quarantined" ? "quarantined" : "accepted"
          : "reserved",
        validated_output: receipt?.outcome === "succeeded"
          ? receipt.provider_receipt.validated_output
          : null,
        evidence: receipt?.outcome === "succeeded"
          ? receipt.provider_receipt
          : null,
      };
    });
  const subruns = [...effectIntents.values()]
    .filter(({ operation_contract: contract }) =>
      contract === "flow.subrun/create-and-observe/v1")
    .map((intent) => {
      const effectReceipt = effectReceipts.get(intent.effect_id);
      const receipt = effectReceipt?.provider_receipt;
      const admission = subrunAdmissions.get(intent.card_id);
      const notCreated = effectReceipt?.outcome === "not_created" ||
        cancellationIndex >= 0 && !effectInvocationIndexes.has(intent.effect_id);
      return {
        parent_run_id: run.run_id,
        card_id: intent.card_id,
        card_identity: intent.card_identity,
        revision_ordinal: intent.revision_ordinal,
        child_run_id: receipt?.child_run_id ?? deriveChildRunId({
          parent_run_id: run.run_id,
          card_identity: intent.card_identity,
          revision_ordinal: intent.revision_ordinal,
        }),
        status: notCreated
          ? "not_created"
          : receipt?.child_phase ?? (admission ? "active" : "admission_pending"),
        result_disposition: notCreated
          ? "not_created"
          : cancellationIndex >= 0 ||
            receipt && receipt.child_phase !== "succeeded"
          ? "quarantined"
          : receipt ? "claimed" : "pending",
        cancellation_disposition: cancellationIndex < 0
          ? "not_requested"
          : receipt || notCreated ? "reconciled" : "requested",
        output_disposition: notCreated
          ? "none"
          : cancellationIndex >= 0 && receipt
          ? "late_unclaimed"
          : receipt?.child_phase !== undefined &&
              receipt.child_phase !== "succeeded"
            ? "terminal_unclaimed"
            : receipt ? "claimed" : "pending",
        child_watermark: receipt?.child_watermark ??
          admission?.child_watermark ?? null,
      };
    });

  return freezeCanonical({
    schema: "flow.run-fold/v1",
    run_id: run.run_id,
    ...(run.lineage === undefined ? {} : { parent: run.lineage }),
    run_ownership: runOwnership,
    watermark,
    sequence: run.events.length,
    phase,
    progress,
    bundle_digest: run.prepared.bundle_digest,
    plan_fingerprint: planFingerprint,
    current_revision: currentRevision,
    revisions,
    active_plan: activePlan,
    superseded_cards: supersededCards,
    cards,
    blocks,
    grants,
    capabilities,
    capability_bindings: capabilityBindings,
    capability_envelopes: run.prepared.explicit_facts.capability_envelopes,
    resource_claims: resourceClaims,
    resource_dispositions: resourceDispositions,
    limits,
    elapsed_seconds: run.prepared.explicit_facts.elapsed_seconds,
    attempts,
    subruns,
    effects,
    ...(trackerProgress === null ? {} : { tracker_progress: trackerProgress }),
    handoffs,
    ...(reviewCandidateReference === null ? {} : {
      review_candidate_reference: reviewCandidateReference,
    }),
    resource_handoff_bindings: resourceHandoffBindings,
    delegate_attempts: delegateAttempts,
    quarantined_delegate_outputs: quarantinedDelegateOutputs,
    revision_templates: run.prepared.revision_templates,
    effect_intents: [...effectIntents.values()],
    legal_actions: legalActions,
  });
}

export function projectRun({ authorityEventStreamDigest, events, fold } = {}) {
  if (fold?.schema !== "flow.run-fold/v1") {
    throw new Error("run projection requires an authoritative fold");
  }
  const views = buildRunViews({ authorityEventStreamDigest, events, fold });
  const reviewCandidateReference = fold.review_candidate_reference === undefined
    ? null
    : freezeCanonical({
      schema: "flow.review-candidate-reference/v1",
      candidate_id: fold.review_candidate_reference.candidate_id,
      candidate_fingerprint: fold.review_candidate_reference.candidate_fingerprint,
      review_authority_watermark:
        fold.review_candidate_reference.review_authority_watermark,
      authority_watermark: fold.watermark,
      legal_actions: [],
    });
  return freezeCanonical({
    schema: "flow.run-projection/v1",
    run_id: fold.run_id,
    ...(fold.parent === undefined ? {} : { parent: fold.parent }),
    run_ownership: fold.run_ownership,
    watermark: fold.watermark,
    sequence: fold.sequence,
    phase: fold.phase,
    progress: fold.progress,
    ...(fold.authority_epoch === undefined ? {} : {
      admission: fold.admission,
      authority_epoch: fold.authority_epoch,
      authority_boot_id: fold.authority_boot_id,
      stream_generation: fold.stream_generation,
    }),
    ...(fold.reboot_revalidation === undefined ? {} : {
      reboot_revalidation: fold.reboot_revalidation,
    }),
    bundle_digest: fold.bundle_digest,
    plan_fingerprint: fold.plan_fingerprint,
    current_revision: fold.current_revision,
    revisions: fold.revisions,
    active_plan: fold.active_plan,
    cards: fold.cards,
    checkpoints: views.operator.checkpoints,
    blocks: fold.blocks,
    grants: fold.grants,
    capabilities: fold.capabilities,
    capability_bindings: fold.capability_bindings,
    capability_envelopes: fold.capability_envelopes,
    resource_claims: fold.resource_claims,
    resource_dispositions: fold.resource_dispositions,
    limits: fold.limits,
    attempts: fold.attempts,
    subruns: fold.subruns,
    effects: fold.effects,
    ...(fold.tracker_progress === undefined ? {} : {
      tracker_progress: fold.tracker_progress,
    }),
    ...(reviewCandidateReference === null ? {} : {
      review_candidate_reference: reviewCandidateReference,
    }),
    handoffs: fold.handoffs,
    resource_handoff_bindings: fold.resource_handoff_bindings,
    delegate_attempts: fold.delegate_attempts,
    quarantined_delegate_outputs: fold.quarantined_delegate_outputs,
    legal_actions: fold.legal_actions,
    views,
  });
}

function trackerProgressActionIsCurrent({ activePlan, cards, operationId }) {
  const operation = activePlan.cards.find(({ id }) => id === operationId);
  if (!isTrackerProgressContract(operation.executor.contract)) return true;
  return !activePlan.cards.some((candidate) =>
    isTrackerProgressContract(candidate.executor.contract) &&
    candidate.inputs.sequence < operation.inputs.sequence &&
    !["completed", "superseded"].includes(
      cards.find(({ id }) => id === candidate.id)?.status,
    ));
}

function buildTrackerProgressProjection({
  activePlan,
  cards,
  effects,
  foldWatermark,
  legalActions,
  prepared,
  runOwnership,
  runId,
}) {
  const activeProgressCards = activePlan.cards
    .filter(({ executor }) => isTrackerProgressContract(executor.contract))
    .filter((card) => cards.find(({ id }) => id === card.id)?.status !==
      "superseded")
    .sort((left, right) => left.inputs.sequence - right.inputs.sequence);
  if (activeProgressCards.length === 0) return null;
  const current = activeProgressCards.find((card) =>
    cards.find(({ id }) => id === card.id)?.status !== "completed") ??
    activeProgressCards.at(-1);
  const cardState = cards.find(({ id }) => id === current.id);
  const effect = effects.find(({ card_id: cardId }) => cardId === current.id);
  const relevantActions = legalActions.filter((action) =>
    action.card_id === current.id || action.effect_id === effect?.effect_id);
  const status = cardState.status === "completed" && effect?.receipt
    ? "projected"
    : effect?.status ?? cardState.status;
  return freezeCanonical({
    schema: "flow.tracker-progress-projection/v1",
    owner_run_id: runId,
    operation_card_id: current.id,
    ownership: runOwnership,
    binding: prepared.explicit_facts.tracker_binding,
    tracker: prepared.explicit_facts.tracker_binding.tracker,
    sequence: current.inputs.sequence,
    desired: current.inputs,
    status,
    authority_watermark: foldWatermark,
    projected_watermark:
      effect?.receipt?.provider_receipt?.authority_watermark ?? null,
    legal_next_actions: relevantActions,
  });
}

export function runWatermark(run) {
  return digest({
    schema: "flow.run-authority-stream/v1",
    run_id: run.run_id,
    events: run.events,
  });
}

function capabilityApplies(bindings, capability, cardId) {
  return bindings.some((binding) => binding.capability === capability &&
    (binding.card_ids.includes("*") || binding.card_ids.includes(cardId)));
}

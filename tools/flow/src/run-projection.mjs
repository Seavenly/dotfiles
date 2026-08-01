import { digest, freezeCanonical, uniqueCanonical } from "./canonical.mjs";
import { admitPlanRevision } from "./plan-revision.mjs";

export function foldRun(run, { watermark = runWatermark(run) } = {}) {
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
  const phase = run.events.some(({ type }) => type === "run_declined")
    ? "declined"
    : run.events.some(({ type }) => type === "run_succeeded")
      ? "succeeded"
      : "active";
  const cards = activePlan.cards.map((card) => {
    let status = "pending";
    if (supersededCards.includes(card.id)) {
      status = "superseded";
    } else if (checkpointDecisions.get(card.id) === "decline") {
      status = "declined";
    } else if (approvedCheckpoints.has(card.id)) {
      status = "completed";
    } else if (phase === "active" && card.dependencies.every((dependency) =>
      approvedCheckpoints.has(dependency))) {
      const block = observedBlocks.get(card.id);
      const capabilityBlocked = block?.type === "capability_required" &&
        !block.required_capabilities.every((capability) =>
          capabilityApplies(capabilityBindings, capability, card.id));
      const revisionBlocked = block?.type === "plan_revision_required";
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
    .map(({ id }) => ({ card_id: id, ...observedBlocks.get(id) }));
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
  const revisionActions = blocks.flatMap((block) =>
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
  const legalActions = phase === "active"
    ? [...checkpointActions, ...capabilityActions, ...revisionActions]
    : [];
  const progress = phase !== "active"
    ? "complete"
    : blocks.length > 0 ? "blocked" : "waiting";

  return freezeCanonical({
    schema: "flow.run-fold/v1",
    run_id: run.run_id,
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
    limits,
    elapsed_seconds: run.prepared.explicit_facts.elapsed_seconds,
    revision_templates: run.prepared.revision_templates,
    legal_actions: legalActions,
  });
}

export function projectRun(fold) {
  if (fold?.schema !== "flow.run-fold/v1") {
    throw new Error("run projection requires an authoritative fold");
  }
  return freezeCanonical({
    schema: "flow.run-projection/v1",
    run_id: fold.run_id,
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
    bundle_digest: fold.bundle_digest,
    plan_fingerprint: fold.plan_fingerprint,
    current_revision: fold.current_revision,
    revisions: fold.revisions,
    active_plan: fold.active_plan,
    cards: fold.cards,
    blocks: fold.blocks,
    grants: fold.grants,
    capabilities: fold.capabilities,
    capability_bindings: fold.capability_bindings,
    resource_claims: fold.resource_claims,
    limits: fold.limits,
    legal_actions: fold.legal_actions,
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

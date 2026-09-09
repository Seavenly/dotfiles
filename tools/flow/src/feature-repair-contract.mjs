import { digest, isPlainRecord } from "./canonical.mjs";

const FEATURE_SEAL_CONTRACT = "flow.operation/feature-seal/v1";

export const FEATURE_REPAIR_CONTRACTS = Object.freeze({
  slice: Object.freeze({
    phases: Object.freeze(["test_before", "slice_verify"]),
    evidence: Object.freeze(["slice"]),
  }),
  completeness: Object.freeze({
    phases: Object.freeze(["verify", "slice_verify"]),
    evidence: Object.freeze(["delegate_evidence_card_ids", "operation_evidence_card_ids"]),
  }),
  critique: Object.freeze({
    phases: Object.freeze(["critique", "seal"]),
    evidence: Object.freeze(["delegate_evidence_card_ids"]),
  }),
  replan: Object.freeze({
    phases: Object.freeze(["apply", "seal"]),
    evidence: Object.freeze(["brief", "workspace"]),
  }),
});

const SEAL_INPUTS = Object.freeze([
  "brief",
  "mode",
  "workspace",
  "finalization",
  "publication",
  "negative_outcomes",
  "receipt_owner",
  "delegate_output_usage",
  "delegate_evidence_card_ids",
  "operation_evidence_card_ids",
]);

/**
 * Validate the feature repair contract at both predefined and generic plan
 * seams. The callback is the seam-specific error constructor, which keeps
 * this policy pure and prevents the generic compiler from growing a second
 * feature policy implementation.
 */
export function validateFeatureRepairContract({
  repair,
  template,
  existingCards,
  brief = null,
  limits = {},
  boundCardId = null,
  bindCheckpoint = false,
  fail,
}) {
  const invalid = (reason, message) => fail(reason, message);
  const fields = [
    "schema",
    "id",
    "kind",
    "card_id",
    "acceptance",
    "remaining_scope",
    "scope_expansion",
    "checkpoint_id",
  ];
  if (!isPlainRecord(repair) || Object.keys(repair).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(repair, field)) ||
      repair.schema !== "flow.feature-repair/v1" ||
      typeof repair.id !== "string" || !repair.id ||
      !Object.hasOwn(FEATURE_REPAIR_CONTRACTS, repair.kind) ||
      typeof repair.card_id !== "string" || !repair.card_id ||
      boundCardId !== null && repair.card_id !== boundCardId ||
      !Array.isArray(repair.acceptance) || repair.acceptance.length === 0 ||
      !repair.acceptance.every((criterion) =>
        typeof criterion === "string" && criterion.length > 0) ||
      new Set(repair.acceptance).size !== repair.acceptance.length ||
      !Array.isArray(repair.remaining_scope) || repair.remaining_scope.length === 0 ||
      !repair.remaining_scope.every((scope) =>
        typeof scope === "string" && scope.length > 0) ||
      new Set(repair.remaining_scope).size !== repair.remaining_scope.length ||
      typeof repair.scope_expansion !== "boolean" ||
      repair.checkpoint_id !== null &&
        (typeof repair.checkpoint_id !== "string" || !repair.checkpoint_id)) {
    invalid(
      "invalid_feature_repair_metadata",
      `feature repair metadata is invalid: ${template?.id ?? repair?.id ?? "unknown"}`,
    );
  }
  if (!isPlainRecord(template) ||
      template.schema !== "flow.plan-revision-template/v1" ||
      !isPlainRecord(template.changes)) {
    invalid(
      "invalid_feature_repair_template",
      `feature repair template is invalid: ${template?.id ?? repair.id}`,
    );
  }

  const cards = Array.isArray(existingCards) ? existingCards : [];
  const target = cards.find(({ id }) => id === repair.card_id);
  if (!target) {
    invalid(
      "feature_repair_target_missing",
      `feature repair target card is not in the feature plan: ${repair.card_id}`,
    );
  }
  const kindContract = FEATURE_REPAIR_CONTRACTS[repair.kind];
  const targetPhase = target.inputs?.phase;
  if (!kindContract.phases.includes(targetPhase)) {
    invalid(
      "feature_repair_kind_contract",
      `feature ${repair.kind} repair must target an admitted ${kindContract.phases.join(
        " or ")} card: ${repair.card_id}`,
    );
  }
  const briefAcceptance = brief?.acceptance ?? target.inputs?.brief?.acceptance ?? [];
  if (repair.acceptance.length !== briefAcceptance.length ||
      repair.acceptance.some((criterion, index) =>
        criterion !== briefAcceptance[index])) {
    invalid(
      "feature_repair_acceptance_coverage",
      `feature repair ${repair.id} acceptance must equal the complete accepted brief`,
    );
  }
  for (const evidenceField of kindContract.evidence) {
    const value = target.inputs?.[evidenceField];
    if (evidenceField === "brief" || evidenceField === "workspace") {
      if (!isPlainRecord(value)) {
        invalid(
          "feature_repair_kind_contract",
          `feature ${repair.kind} repair lacks its ${evidenceField} binding`,
        );
      }
      continue;
    }
    if (evidenceField === "slice") {
      if (!isPlainRecord(value) || typeof value.id !== "string" ||
          !Array.isArray(value.acceptance) || value.acceptance.length === 0) {
        invalid(
          "feature_repair_kind_contract",
          `feature ${repair.kind} repair lacks its exact slice evidence binding`,
        );
      }
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) {
      invalid(
        "feature_repair_kind_contract",
        `feature ${repair.kind} repair lacks its ${evidenceField} evidence binding`,
      );
    }
  }

  const changes = template.changes;
  const supersededIds = Array.isArray(changes.supersede_cards)
    ? [...new Set(changes.supersede_cards)]
    : [];
  if (supersededIds.length === 0) {
    invalid(
      "feature_repair_replacement_required",
      `feature repair ${repair.id} must replace its blocked evidence closure`,
    );
  }
  const superseded = supersededIds.map((id) => cards.find((card) => card.id === id));
  if (superseded.some((card) => card === undefined)) {
    invalid(
      "feature_repair_replacement_required",
      `feature repair ${repair.id} supersedes an unknown evidence card`,
    );
  }
  const addedCards = Array.isArray(changes.add_cards) ? changes.add_cards : [];
  const replacements = new Map();
  const replacementTargets = new Map();
  for (const card of addedCards) {
    const targetId = replacementTargetId(card);
    if (targetId === null) {
      invalid(
        "feature_repair_replacement_identity",
        `feature repair ${repair.id} replacement identity is contradictory: ${card?.id ?? "unknown"}`,
      );
    }
    if (targetId === undefined) continue;
    if (!supersededIds.includes(targetId)) {
      invalid(
        "feature_repair_replacement_identity",
        `feature repair ${repair.id} replacement ${card?.id ?? "unknown"} names a non-superseded card`,
      );
    }
    if (replacementTargets.has(targetId)) {
      invalid(
        "feature_repair_replacement_identity",
        `feature repair ${repair.id} has multiple replacements for ${targetId}`,
      );
    }
    replacementTargets.set(targetId, card);
  }
  for (const original of superseded) {
    const replacement = replacementTargets.get(original.id);
    if (replacement === undefined) {
      invalid(
        "feature_repair_replacement_identity",
        `feature repair ${repair.id} must identify a replacement for ${original.id} with replaces_card_id`,
      );
    }
    if (replacement.inputs?.phase !== original.inputs?.phase ||
        replacement.executor?.kind !== original.executor?.kind ||
        replacement.executor?.contract !== original.executor?.contract) {
      invalid(
        "feature_repair_replacement_required",
        `feature repair ${repair.id} replacement ${replacement.id} does not preserve the evidence card contract for ${original.id}`,
      );
    }
    replacements.set(original.id, replacement);
  }
  if (replacementTargets.size !== superseded.length) {
    invalid(
      "feature_repair_replacement_identity",
      `feature repair ${repair.id} must identify every evidence-preserving replacement explicitly`,
    );
  }
  for (const original of superseded) {
    validatePreservedCard(
      original,
      replacements.get(original.id),
      repair,
      invalid,
      replacements,
    );
  }

  const effectiveDependencies = (card) => [
    ...(Array.isArray(card.dependencies) ? card.dependencies : []),
    ...(Array.isArray(changes.add_edges)
      ? changes.add_edges
        .filter(({ to }) => to === card.id)
        .map(({ from }) => from)
      : []),
  ];
  const supersededSet = new Set(supersededIds);
  for (const original of superseded) {
    const replacement = replacements.get(original.id);
    const replacementDependencies = new Set(effectiveDependencies(replacement));
    if ([...replacementDependencies].some((id) => supersededSet.has(id))) {
      invalid(
        "feature_repair_replacement_dependency",
        `feature repair ${repair.id} replacement ${replacement.id} depends on superseded evidence`,
      );
    }
    for (const dependency of original.dependencies ?? []) {
      const expected = replacements.get(dependency)?.id ?? dependency;
      if (!replacementDependencies.has(expected)) {
        invalid(
          "feature_repair_replacement_dependency",
          `feature repair ${repair.id} replacement ${replacement.id} does not preserve dependency ${expected}`,
        );
      }
    }
  }

  const revisedCards = rebindManagedAgentCards([
    ...cards.map((card) => structuredClone(card)),
    ...addedCards.map((card) => structuredClone(card)),
  ], replacements);
  validateFeatureRouteIndependence(
    revisedCards.filter(({ id }) => !supersededSet.has(id)),
    invalid,
  );

  const expansion = deriveExpansion({
    template,
    replacements,
    superseded,
    limits,
  });
  if (repair.scope_expansion !== expansion.requiresCheckpoint) {
    invalid(
      "feature_repair_scope_expansion_mismatch",
      `feature repair ${repair.id} scope expansion does not match its derived template changes`,
    );
  }
  const checkpointId = repair.checkpoint_id;
  if (expansion.requiresCheckpoint && typeof checkpointId !== "string") {
    invalid(
      "feature_repair_checkpoint_required",
      `feature repair ${repair.id} requires an exact scope checkpoint`,
    );
  }
  if (!expansion.requiresCheckpoint && checkpointId !== null) {
    invalid(
      "feature_repair_checkpoint_unexpected",
      `feature repair ${repair.id} declares a checkpoint without template expansion`,
    );
  }
  const checkpoint = checkpointId === null
    ? null
    : addedCards.find((card) =>
      card.id === checkpointId && card.executor?.kind === "checkpoint");
  if (checkpointId !== null && !checkpoint) {
    invalid(
      "invalid_feature_repair_checkpoint",
      `feature repair ${repair.id} checkpoint is not an admitted card`,
    );
  }
  let boundTemplate = template;
  if (checkpoint) {
    const expectedBinding = featureRepairCheckpointBinding(template);
    const checkpointInputs = checkpoint.inputs ?? {};
    if (checkpointInputs.repair_template_id === undefined &&
        checkpointInputs.repair_template_digest === undefined) {
      if (!bindCheckpoint) {
        invalid(
          "feature_repair_checkpoint_binding",
          `feature repair ${repair.id} checkpoint is not bound to its exact template`,
        );
      }
      const boundCards = addedCards.map((card) => card.id === checkpoint.id
        ? {
          ...card,
          inputs: {
            ...checkpointInputs,
            repair_template_id: template.id,
            repair_template_digest: expectedBinding,
          },
        }
        : card);
      boundTemplate = {
        ...template,
        changes: { ...changes, add_cards: boundCards },
      };
    } else if (checkpointInputs.repair_template_id !== template.id ||
        checkpointInputs.repair_template_digest !== expectedBinding) {
      invalid(
        "feature_repair_checkpoint_binding",
        `feature repair ${repair.id} checkpoint is not bound to its exact template`,
      );
    }
  }

  if (checkpoint) {
    const gatedIds = new Set(
      addedCards
        .filter((card) => card.id !== checkpoint.id)
        .filter((card) => effectiveDependencies(card).includes(checkpoint.id))
        .map(({ id }) => id),
    );
    const ungated = addedCards
      .filter((card) => card.id !== checkpoint.id)
      .filter(({ id }) => !gatedIds.has(id));
    const capabilityTargets = (changes.capability_additions ?? []).flatMap(
      ({ card_ids: cardIds }) => (cardIds ?? []).filter((id) => !gatedIds.has(id)),
    );
    if (ungated.length > 0 || capabilityTargets.length > 0) {
      invalid(
        "feature_repair_checkpoint_order",
        `feature repair ${repair.id} expansion must depend on its exact checkpoint`,
      );
    }
  }

  return {
    repair: {
      ...repair,
      scope_expansion: expansion.requiresCheckpoint,
    },
    template: {
      ...boundTemplate,
      repair: {
        ...repair,
        scope_expansion: expansion.requiresCheckpoint,
      },
    },
    expansion,
    replacements,
  };
}

export function featureRepairCheckpointBinding(template) {
  const changes = structuredClone(template.changes);
  changes.add_cards = (changes.add_cards ?? []).map((card) => {
    if (!isPlainRecord(card?.inputs)) return card;
    const inputs = { ...card.inputs };
    delete inputs.repair_template_id;
    delete inputs.repair_template_digest;
    return { ...card, inputs };
  });
  return digest({
    schema: "flow.feature-repair-checkpoint-binding/v1",
    template_id: template.id,
    changes,
  });
}

function deriveExpansion({ template, replacements, superseded, limits }) {
  const changes = template.changes;
  const replacementIds = new Set([...replacements.values()].map(({ id }) => id));
  const extras = (changes.add_cards ?? []).filter(({ id }) => !replacementIds.has(id));
  const originalResourceClaims = new Set(superseded.flatMap((card) =>
    (card.resource_claims ?? []).map((claim) => digest(claim))));
  const addedReplacementResources = [...replacements.values()].flatMap((card) =>
    (card.resource_claims ?? []).map((claim) => digest(claim)))
    .some((claimDigest) => !originalResourceClaims.has(claimDigest));
  const pureEdges = new Set();
  for (const original of superseded) {
    const replacement = replacements.get(original.id);
    for (const dependency of original.dependencies ?? []) {
      const from = replacements.get(dependency)?.id ?? dependency;
      pureEdges.add(`${from}\0${replacement.id}`);
    }
  }
  const addedEdges = changes.add_edges ?? [];
  const edgeExpansion = addedEdges.some(({ from, to }) =>
    !pureEdges.has(`${from}\0${to}`));
  const raisedLimit = Object.entries(changes.limit_changes ?? {}).some(
    ([name, value]) => Number.isInteger(value) &&
      Number.isInteger(limits?.[name]) && value > limits[name],
  );
  return {
    requiresCheckpoint: extras.length > 0 ||
      addedReplacementResources ||
      (changes.capability_additions ?? []).length > 0 ||
      (changes.resource_additions ?? []).length > 0 ||
      edgeExpansion ||
      raisedLimit,
    extras,
    edgeExpansion,
    addedReplacementResources,
    raisedLimit,
  };
}

function validatePreservedCard(
  original,
  replacement,
  repair,
  invalid,
  replacements = new Map(),
) {
  const reboundOriginal = rebindAuthorityReferences(original, replacements);
  if (original.executor?.contract === FEATURE_SEAL_CONTRACT &&
      SEAL_INPUTS.some((field) =>
        replacement.inputs?.[field] === undefined ||
        digest(replacement.inputs[field]) !==
          digest(reboundOriginal.inputs?.[field]))) {
    invalid(
      "feature_repair_seal_gate",
      `feature repair for ${original.id} must retain the feature seal evidence and finalization gate`,
    );
  }
  const originalManagedAgent = original.inputs?.managed_agent;
  const replacementManagedAgent = replacement.inputs?.managed_agent;
  const expectedManagedAgent = reboundOriginal.inputs?.managed_agent;
  if (originalManagedAgent === undefined
      ? replacementManagedAgent !== undefined
      : digest(expectedManagedAgent) !== digest(replacementManagedAgent)) {
    invalid(
      "feature_repair_managed_agent_binding",
      `feature repair ${repair.id} replacement ${replacement.id} does not safely rebind its managed-agent authority`,
    );
  }
  const originalCard = comparableReplacementCard(
    reboundOriginal,
    reboundOriginal.inputs?.managed_agent,
  );
  const replacementCard = comparableReplacementCard(
    replacement,
    reboundOriginal.inputs?.managed_agent === undefined
      ? undefined
      : reboundOriginal.inputs.managed_agent,
  );
  if (digest(originalCard) !== digest(replacementCard)) {
    invalid(
      "feature_repair_authority_gate",
      `feature repair ${repair.id} replacement ${replacement.id} changes route, limits, recovery, evidence, or authority inputs`,
    );
  }
}

export function replacementTargetId(card) {
  const direct = card?.replaces_card_id;
  const nested = card?.inputs?.replaces_card_id;
  if (direct !== undefined && nested !== undefined && direct !== nested) {
    return null;
  }
  if (direct !== undefined &&
      (typeof direct !== "string" || direct.length === 0)) return null;
  if (nested !== undefined &&
      (typeof nested !== "string" || nested.length === 0)) return null;
  return direct ?? nested;
}

function comparableReplacementCard(card, managedAgent) {
  const comparable = structuredClone(card);
  delete comparable.id;
  delete comparable.dependencies;
  delete comparable.replaces_card_id;
  const inputs = comparable.inputs ?? {};
  delete inputs.replaces_card_id;
  if (managedAgent === undefined) {
    delete inputs.managed_agent;
  } else {
    inputs.managed_agent = managedAgent;
  }
  comparable.inputs = inputs;
  return comparable;
}

function rebindManagedAgentBinding(binding, replacedCardId, replacementCardId) {
  if (!isPlainRecord(binding)) return binding;
  const cardIds = Array.isArray(binding.card_ids)
    ? binding.card_ids.map((id) => id === replacedCardId ? replacementCardId : id)
    : binding.card_ids;
  return {
    ...binding,
    card_ids: cardIds,
    ...(binding.terminal_card_id === replacedCardId
      ? { terminal_card_id: replacementCardId }
      : {}),
  };
}

function rebindManagedAgentCards(cards, replacements) {
  return cards.map((card) => {
    const binding = card.inputs?.managed_agent;
    if (!isPlainRecord(binding)) return card;
    let rebound = binding;
    for (const [originalId, replacement] of replacements) {
      if (rebound.card_ids?.includes(originalId)) {
        rebound = rebindManagedAgentBinding(rebound, originalId, replacement.id);
      }
    }
    if (rebound === binding) return card;
    return {
      ...card,
      inputs: { ...card.inputs, managed_agent: rebound },
    };
  });
}

const CARD_REFERENCE_FIELDS = new Set([
  "delegate_evidence_card_ids",
  "operation_evidence_card_ids",
  "test_card_ids",
  "setup_card_id",
  "mutation_owner",
]);

function rebindAuthorityReferences(card, replacements) {
  if (!(replacements instanceof Map) || replacements.size === 0) return card;
  const replacementById = new Map(
    [...replacements].map(([originalId, replacement]) => [
      originalId,
      replacement.id,
    ]),
  );
  const rebound = structuredClone(card);
  const inputs = rebound.inputs ?? {};
  for (const field of CARD_REFERENCE_FIELDS) {
    const value = inputs[field];
    if (Array.isArray(value)) {
      inputs[field] = value.map((id) => replacementById.get(id) ?? id);
    } else if (typeof value === "string") {
      inputs[field] = replacementById.get(value) ?? value;
    }
  }
  const managedAgent = inputs.managed_agent;
  if (isPlainRecord(managedAgent) && Array.isArray(managedAgent.card_ids)) {
    inputs.managed_agent = {
      ...managedAgent,
      card_ids: managedAgent.card_ids.map((id) => replacementById.get(id) ?? id),
      terminal_card_id: replacementById.get(managedAgent.terminal_card_id) ??
        managedAgent.terminal_card_id,
    };
  }
  rebound.inputs = inputs;
  return rebound;
}

/**
 * Feature apply and critique are independent authority routes.  This check
 * runs again on a revised graph so a repair cannot silently collapse the two
 * delegated roles even when the base feature graph was valid.
 */
export function validateFeatureRouteIndependence(cards, fail) {
  const applyCards = cards.filter(({ executor, inputs }) =>
    executor?.kind === "delegate" && inputs?.phase === "apply");
  const critiqueCards = cards.filter(({ executor, inputs }) =>
    executor?.kind === "delegate" && inputs?.phase === "critique");
  for (const apply of applyCards) {
    for (const critique of critiqueCards) {
      if (apply.route?.agent_id === critique.route?.agent_id ||
          apply.inputs?.description?.description_digest ===
            critique.inputs?.description?.description_digest ||
          apply.route?.launch_comparison_key ===
            critique.route?.launch_comparison_key) {
        fail(
          "feature_repair_route_independence",
          `feature repair collapses independent apply and critique routes: ${apply.id}/${critique.id}`,
        );
      }
    }
  }
}

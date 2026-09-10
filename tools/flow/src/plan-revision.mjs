import { digest, isPlainRecord, uniqueCanonical } from "./canonical.mjs";
import {
  hasActiveDependencyOnSuperseded,
  hasDependencyCycle,
} from "./plan-graph.mjs";

// These are closed capacity decisions.  Every other admission failure is a
// structural rejection and must never be rendered as if a cap were spent.
export const REVISION_CAP_CODES = Object.freeze(new Set([
  "revision_template_limit_exceeded",
  "revision_limit_exceeded",
  "revision_card_limit_exceeded",
  "card_limit_exceeded",
  "revision_capability_limit_exceeded",
  "revision_resource_limit_exceeded",
  "revision_elapsed_limit_exceeded",
]));

export function revisionAdmissionStatus(code) {
  return REVISION_CAP_CODES.has(code)
    ? "cap_exhausted"
    : "structurally_rejected";
}

export function checkRevisionCapacity({
  limits,
  capabilityBindings = [],
  resourceClaims = [],
  elapsedSeconds = 0,
  changes,
}) {
  const nextLimits = { ...limits, ...changes.limit_changes };
  if (changes.add_cards.length > nextLimits.max_cards_per_revision) {
    return { code: "revision_card_limit_exceeded" };
  }
  const capabilities = uniqueCanonical([
    ...capabilityBindings,
    ...changes.capability_additions,
  ]);
  if (new Set(capabilities.map(({ capability }) => capability)).size >
      nextLimits.max_capabilities) {
    return { code: "revision_capability_limit_exceeded" };
  }
  const resources = uniqueCanonical([
    ...resourceClaims,
    ...changes.resource_additions,
    ...changes.add_cards.flatMap(({ resource_claims: claims }) => claims ?? []),
  ]);
  if (resources.length > nextLimits.max_resources) {
    return { code: "revision_resource_limit_exceeded" };
  }
  if (elapsedSeconds > nextLimits.max_elapsed_seconds) {
    return { code: "revision_elapsed_limit_exceeded" };
  }
  return { limits: nextLimits, capabilities, resources };
}

export function admitPlanRevision(state, template) {
  const changes = template.changes;
  const applicationCount = state.revisions.filter(
    ({ template_id: templateId }) => templateId === template.id,
  ).length;
  if (applicationCount >= template.limits.max_applications) {
    return { code: "revision_template_limit_exceeded" };
  }
  const nextOrdinal = state.current_revision.ordinal + 1;
  // A gated revision may reserve capability and resource additions, but its
  // limit changes are not effective until its checkpoint is approved.  The
  // revision itself is checked against the current effective limits plus its
  // own declared change below.
  const limits = {
    ...state.limits,
    ...changes.limit_changes,
  };
  if (nextOrdinal > limits.max_revisions) {
    return { code: "revision_limit_exceeded" };
  }
  const capacity = checkRevisionCapacity({
    limits,
    capabilityBindings: state.admission_capability_bindings ??
      state.capability_bindings,
    resourceClaims: state.admission_resource_claims ?? state.resource_claims,
    elapsedSeconds: state.elapsed_seconds,
    changes,
  });
  if (capacity.code) return capacity;
  if (changes.supersede_cards.some((id) => {
    const status = state.cards.find((card) => card.id === id)?.status;
    return !["pending", "blocked"].includes(status);
  })) {
    return { code: "accepted_history_is_immutable" };
  }
  const superseded = new Set([
    ...state.superseded_cards,
    ...changes.supersede_cards,
  ]);
  if (state.active_plan.cards.some((card) =>
    !superseded.has(card.id) && card.dependencies.some((dependency) =>
      changes.supersede_cards.includes(dependency)))) {
    return { code: "incomplete_pending_dependent_closure" };
  }
  const existingIds = new Set(state.active_plan.cards.map(({ id }) => id));
  if (changes.add_cards.some(({ id }) => existingIds.has(id))) {
    return { code: "revision_card_conflict" };
  }
  const cards = [...state.active_plan.cards, ...changes.add_cards]
    .map((card) => structuredClone(card));
  for (const { from, to } of changes.add_edges) {
    const target = cards.find(({ id }) => id === to);
    if (!target || !changes.add_cards.some(({ id }) => id === to) ||
        !cards.some(({ id }) => id === from)) {
      return { code: "invalid_revision_edge" };
    }
    target.dependencies = [...new Set([...target.dependencies, from])].sort();
  }
  if (hasActiveDependencyOnSuperseded(cards, superseded)) {
    return { code: "active_card_depends_on_superseded_work" };
  }
  if (cards.filter(({ id }) => !superseded.has(id)).length > limits.max_cards) {
    return { code: "card_limit_exceeded" };
  }
  if (hasDependencyCycle(cards)) return { code: "cyclic_graph" };
  if (changes.capability_additions.some(({ capability }) =>
    !state.capability_envelopes.includes(capability))) {
    return { code: "capability_outside_envelope" };
  }
  const capabilityBindings = capacity.capabilities;
  const resourceClaims = capacity.resources;
  const supersededCards = [...superseded].sort();
  const replacementBindings = new Map(changes.add_cards.map((card) => [
    card.replaces_card_id ?? card.inputs?.replaces_card_id,
    card.id,
  ]).filter(([originalId]) => originalId !== undefined));
  const activePlan = {
    ...state.active_plan,
    cards: rebindManagedAgentCards(
      cards.sort((left, right) => left.id < right.id ? -1 : 1),
      replacementBindings,
    ),
  };
  return {
    ordinal: nextOrdinal,
    plan_fingerprint: digest(activePlan),
    active_plan: activePlan,
    superseded_cards: supersededCards,
    capability_bindings: capabilityBindings,
    resource_claims: resourceClaims,
    limits,
  };
}

function rebindManagedAgentCards(cards, replacementBindings) {
  if (replacementBindings.size === 0) return cards;
  return cards.map((card) => {
    const binding = card.inputs?.managed_agent;
    if (!isPlainRecord(binding)) return card;
    return {
      ...card,
      inputs: {
        ...card.inputs,
        managed_agent: {
          ...binding,
          ...(Array.isArray(binding.card_ids) ? {
            card_ids: binding.card_ids.map((id) =>
              replacementBindings.get(id) ?? id),
          } : {}),
          ...(binding.terminal_card_id === undefined ? {} : {
            terminal_card_id: replacementBindings.get(binding.terminal_card_id) ??
              binding.terminal_card_id,
          }),
        },
      },
    };
  });
}

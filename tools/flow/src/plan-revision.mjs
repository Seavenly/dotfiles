import { digest, uniqueCanonical } from "./canonical.mjs";
import {
  hasActiveDependencyOnSuperseded,
  hasDependencyCycle,
} from "./plan-graph.mjs";

export function admitPlanRevision(state, template) {
  const changes = template.changes;
  const applicationCount = state.revisions.filter(
    ({ template_id: templateId }) => templateId === template.id,
  ).length;
  if (applicationCount >= template.limits.max_applications) {
    return { code: "revision_template_limit_exceeded" };
  }
  const nextOrdinal = state.current_revision.ordinal + 1;
  const limits = { ...state.limits, ...changes.limit_changes };
  if (nextOrdinal > limits.max_revisions) {
    return { code: "revision_limit_exceeded" };
  }
  if (changes.add_cards.length > limits.max_cards_per_revision) {
    return { code: "revision_card_limit_exceeded" };
  }
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
  if (cards.length > limits.max_cards) {
    return { code: "card_limit_exceeded" };
  }
  if (hasDependencyCycle(cards)) return { code: "cyclic_graph" };
  if (changes.capability_additions.some(({ capability }) =>
    !state.capability_envelopes.includes(capability))) {
    return { code: "capability_outside_envelope" };
  }
  const capabilityBindings = uniqueCanonical([
    ...state.capability_bindings,
    ...changes.capability_additions,
  ]);
  const capabilityCount = new Set(
    capabilityBindings.map(({ capability }) => capability),
  ).size;
  if (capabilityCount > limits.max_capabilities) {
    return { code: "revision_capability_limit_exceeded" };
  }
  const resourceClaims = uniqueCanonical([
    ...state.resource_claims,
    ...changes.resource_additions,
  ]);
  if (resourceClaims.length > limits.max_resources) {
    return { code: "revision_resource_limit_exceeded" };
  }
  if (state.elapsed_seconds > limits.max_elapsed_seconds) {
    return { code: "revision_elapsed_limit_exceeded" };
  }
  const supersededCards = [...superseded].sort();
  const activePlan = {
    ...state.active_plan,
    cards: cards.sort((left, right) => left.id < right.id ? -1 : 1),
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

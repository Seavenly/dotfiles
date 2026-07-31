import { digest, freezeCanonical } from "./canonical.mjs";
import {
  createDynamicPlanConfirmation,
  createPreparedBundle,
} from "./prepared-contracts.mjs";

const EXECUTOR_KINDS = ["delegate", "operation", "checkpoint", "subrun"];
const CARD_ARRAY_FIELDS = [
  "outputs",
  "success_criteria",
  "validators",
  "data_references",
  "evidence_references",
  "resource_claims",
];
const FACT_ARRAY_FIELDS = [
  "capability_envelopes",
  "operation_contracts",
  "validator_contracts",
  "resource_claims",
];

export function compileDynamicPlan(proposal) {
  validateDynamicPlan(proposal);
  const graph = canonicalGraph(proposal.graph);
  const planFingerprint = digest(graph);
  const bundle = createPreparedBundle({
    kind: "dynamic",
    graph,
    planFingerprint,
    requestedAuthority: proposal.requested_authority,
    explicitFacts: proposal.explicit_facts,
  });
  const bundleDigest = digest(bundle);
  const confirmation = createDynamicPlanConfirmation({
    bundleDigest,
    graph,
    requestedAuthority: proposal.requested_authority,
    explicitFacts: proposal.explicit_facts,
  });
  const confirmationDigest = digest(confirmation);

  return freezeCanonical({
    schema: "flow.prepared-run/v1",
    kind: "dynamic",
    bundle_digest: bundleDigest,
    plan_fingerprint: planFingerprint,
    confirmation_digest: confirmationDigest,
    graph,
    requested_authority: proposal.requested_authority,
    explicit_facts: proposal.explicit_facts,
    confirmation,
  });
}

export const PlanCompiler = Object.freeze({
  compile: compileDynamicPlan,
});

export function validateDynamicPlan(proposal) {
  if (proposal?.schema !== "flow.dynamic-plan-proposal/v1") {
    throw new Error("dynamic plan proposal contract is invalid");
  }
  if (!isRecord(proposal.requested_authority) ||
      !["commands", "capabilities", "mutations"].every((field) =>
        Array.isArray(proposal.requested_authority[field]))) {
    throw new Error("dynamic plan requires explicit authority and facts");
  }
  const facts = proposal.explicit_facts;
  if (!isRecord(facts) || !isDigest(facts.catalog_fingerprint) ||
      !isRecord(facts.route_snapshot) ||
      !isDigest(facts.route_snapshot.watermark) ||
      !Array.isArray(facts.route_snapshot.bindings) ||
      !FACT_ARRAY_FIELDS.every((field) => Array.isArray(facts[field])) ||
      !isRecord(facts.limits) ||
      !Number.isInteger(facts.limits.max_cards) || facts.limits.max_cards < 1) {
    throw new Error("dynamic plan identity facts are incomplete");
  }
  if (proposal.graph?.schema !== "flow.run-plan/v1" ||
      !Array.isArray(proposal.graph.cards) || proposal.graph.cards.length === 0) {
    throw new Error("dynamic plan requires a non-empty finite graph");
  }
  if (proposal.graph.cards.length > facts.limits.max_cards) {
    throw new Error("dynamic plan exceeds the explicit card limit");
  }

  const cardIds = new Set();
  for (const card of proposal.graph.cards) {
    if (!isRecord(card) || typeof card.id !== "string" || !card.id ||
        cardIds.has(card.id)) {
      throw new Error("dynamic plan card identities must be unique");
    }
    cardIds.add(card.id);
    if (!EXECUTOR_KINDS.includes(card.executor?.kind) ||
        typeof card.executor?.contract !== "string" ||
        !Array.isArray(card.dependencies)) {
      throw new Error(`dynamic plan card is incomplete: ${card.id}`);
    }
    if (card.executor.kind !== "checkpoint") {
      throw new Error(
        `dynamic checkpoint plan does not support executor kind: ${card.executor.kind}`,
      );
    }
    if (!isRecord(card.inputs) || !isRecord(card.limits) ||
        !CARD_ARRAY_FIELDS.every((field) => Array.isArray(card[field])) ||
        !(card.route === null || isRecord(card.route)) ||
        typeof card.recovery !== "string" || !card.recovery) {
      throw new Error(`dynamic plan card contract is incomplete: ${card.id}`);
    }
  }
  for (const card of proposal.graph.cards) {
    if (card.dependencies.some((dependency) => !cardIds.has(dependency))) {
      throw new Error(`dynamic plan dependency is unknown: ${card.id}`);
    }
  }
  if (proposal.graph.cards.some(({ executor }) => executor.kind === "checkpoint") &&
      !proposal.requested_authority.commands.includes("checkpoint_decision")) {
    throw new Error("dynamic plan checkpoint authority is incomplete");
  }
  assertAcyclic(proposal.graph.cards);
}

function canonicalGraph(graph) {
  return freezeCanonical({
    ...graph,
    cards: graph.cards
      .map((card) => ({
        ...card,
        dependencies: [...new Set(card.dependencies)].sort(),
      }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  });
}

function assertAcyclic(cards) {
  const dependencies = new Map(cards.map(({ id, dependencies: values }) => [id, values]));
  const visiting = new Set();
  const visited = new Set();

  function visit(cardId) {
    if (visiting.has(cardId)) throw new Error("dynamic plan graph must be acyclic");
    if (visited.has(cardId)) return;
    visiting.add(cardId);
    for (const dependency of dependencies.get(cardId)) visit(dependency);
    visiting.delete(cardId);
    visited.add(cardId);
  }

  for (const cardId of dependencies.keys()) visit(cardId);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value ?? "");
}

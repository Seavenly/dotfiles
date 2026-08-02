import { digest, freezeCanonical, uniqueCanonical } from "./canonical.mjs";
import {
  hasActiveDependencyOnSuperseded,
  hasDependencyCycle,
} from "./plan-graph.mjs";
import {
  createDynamicPlanConfirmation,
  createPreparedBundle,
} from "./prepared-contracts.mjs";
import {
  effectClassPolicy,
  operationRegistrationIssue,
  registeredOperation,
} from "./operation-effects.mjs";

const EXECUTOR_KINDS = ["delegate", "operation", "checkpoint", "subrun"];
const CHECKPOINT_CONTRACT = "flow.checkpoint/confirmation/v1";
const CHECKPOINT_VALIDATOR = "flow.validator/checkpoint-decision/v1";
const OPERATION_RECEIPT_VALIDATOR = "flow.validator/operation-receipt/v1";
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
  "block_observations",
];
const LIMIT_FIELDS = [
  "max_cards",
  "max_revisions",
  "max_cards_per_revision",
  "max_capabilities",
  "max_resources",
  "max_elapsed_seconds",
];

const CARD_BLOCK_FIELDS = [
  "schema",
  "id",
  "type",
  "trigger",
  "required_capabilities",
  "revision_template_ids",
];

export class DynamicPlanValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "DynamicPlanValidationError";
    this.reason = reason;
  }
}

export function compileDynamicPlan(proposal, options = {}) {
  validateDynamicPlan(proposal, options);
  const graph = canonicalizeDynamicGraph(proposal.graph);
  const explicitFacts = canonicalizeExplicitFacts(proposal.explicit_facts);
  const revisionTemplates = canonicalizeRevisionTemplates(
    proposal.revision_templates ?? [],
  );
  const planFingerprint = digest(graph);
  const bundle = createPreparedBundle({
    kind: "dynamic",
    graph,
    planFingerprint,
    requestedAuthority: proposal.requested_authority,
    explicitFacts,
    revisionTemplates,
  });
  const bundleDigest = digest(bundle);
  const confirmation = createDynamicPlanConfirmation({
    bundleDigest,
    graph,
    requestedAuthority: proposal.requested_authority,
    explicitFacts,
    revisionTemplates,
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
    explicit_facts: explicitFacts,
    revision_templates: revisionTemplates,
    confirmation,
  });
}

export const PlanCompiler = Object.freeze({
  compile: compileDynamicPlan,
});

export function validateDynamicPlan(proposal, {
  registeredOperations = null,
  skipRevisionTemplates = false,
} = {}) {
  if (proposal?.schema !== "flow.dynamic-plan-proposal/v1") {
    invalidPlan("invalid_proposal_contract", "dynamic plan proposal contract is invalid");
  }
  if (!isRecord(proposal.requested_authority) ||
      !["commands", "capabilities", "mutations"].every((field) =>
        Array.isArray(proposal.requested_authority[field]))) {
    invalidPlan(
      "missing_explicit_authority",
      "dynamic plan requires explicit authority and facts",
    );
  }
  const facts = proposal.explicit_facts;
  if (!isRecord(facts) || !isDigest(facts.catalog_fingerprint) ||
      !isRecord(facts.route_snapshot) ||
      !isDigest(facts.route_snapshot.watermark) ||
      !Array.isArray(facts.route_snapshot.bindings) ||
      !FACT_ARRAY_FIELDS.every((field) => Array.isArray(facts[field])) ||
      !isRecord(facts.limits) ||
      !LIMIT_FIELDS.every((field) =>
        Number.isInteger(facts.limits[field]) && facts.limits[field] >= 0) ||
      facts.limits.max_cards < 1 ||
      !Number.isInteger(facts.elapsed_seconds) || facts.elapsed_seconds < 0) {
    invalidPlan(
      "incomplete_identity_facts",
      "dynamic plan identity facts are incomplete",
    );
  }
  if (proposal.graph?.schema !== "flow.run-plan/v1" ||
      !Array.isArray(proposal.graph.cards) || proposal.graph.cards.length === 0) {
    invalidPlan(
      "invalid_finite_graph",
      "dynamic plan requires a non-empty finite graph",
    );
  }
  if (proposal.graph.cards.length > facts.limits.max_cards) {
    invalidPlan(
      "card_limit_exceeded",
      "dynamic plan exceeds the explicit card limit",
    );
  }
  if (new Set(proposal.requested_authority.capabilities).size >
      facts.limits.max_capabilities) {
    invalidPlan(
      "capability_limit_exceeded",
      "dynamic plan exceeds the explicit capability limit",
    );
  }
  if (uniqueCanonical(facts.resource_claims).length > facts.limits.max_resources) {
    invalidPlan(
      "resource_limit_exceeded",
      "dynamic plan exceeds the explicit resource limit",
    );
  }
  if (facts.elapsed_seconds > facts.limits.max_elapsed_seconds) {
    invalidPlan(
      "elapsed_limit_exceeded",
      "dynamic plan exceeds the explicit elapsed-time limit",
    );
  }

  const cardIds = new Set();
  for (const card of proposal.graph.cards) {
    if (!isRecord(card) || typeof card.id !== "string" || !card.id ||
        cardIds.has(card.id)) {
      invalidPlan(
        "invalid_card_identity",
        "dynamic plan card identities must be unique",
      );
    }
    cardIds.add(card.id);
    if (!EXECUTOR_KINDS.includes(card.executor?.kind) ||
        typeof card.executor?.contract !== "string" ||
        !Array.isArray(card.dependencies)) {
      invalidPlan("incomplete_card", `dynamic plan card is incomplete: ${card.id}`);
    }
    if (!isRecord(card.inputs) || !isRecord(card.limits) ||
        !CARD_ARRAY_FIELDS.every((field) => Array.isArray(card[field])) ||
        !(card.route === null || isRecord(card.route)) ||
        typeof card.recovery !== "string" || !card.recovery) {
      invalidPlan(
        "incomplete_card_contract",
        `dynamic plan card contract is incomplete: ${card.id}`,
      );
    }
    if (card.executor.kind === "checkpoint") {
      validateCheckpointCard(card, facts);
    } else if (card.executor.kind === "operation") {
      validateOperationCard(card, proposal, registeredOperations);
    } else {
      invalidPlan(
        "unsupported_executor_kind",
        `dynamic plan does not support executor kind: ${card.executor.kind}`,
      );
    }
  }
  for (const card of proposal.graph.cards) {
    if (card.dependencies.some((dependency) => !cardIds.has(dependency))) {
      invalidPlan(
        "unknown_dependency",
        `dynamic plan dependency is unknown: ${card.id}`,
      );
    }
  }
  if (proposal.graph.cards.some(({ executor }) => executor.kind === "checkpoint") &&
      !proposal.requested_authority.commands.includes("checkpoint_decision")) {
    invalidPlan(
      "incomplete_checkpoint_authority",
      "dynamic plan checkpoint authority is incomplete",
    );
  }
  assertAcyclic(proposal.graph.cards);
  validateBlockObservations(proposal);
  if (!skipRevisionTemplates) {
    validateRevisionTemplates(proposal, registeredOperations);
    validateDeclaredRecoveryCapacity(proposal);
  }
}

function validateDeclaredRecoveryCapacity(proposal) {
  const templates = proposal.revision_templates ?? [];
  const capabilityLimit = proposal.explicit_facts.limits.max_capabilities;
  const declaredCapabilities = declaredRecoveryCapabilities(proposal);
  if (declaredCapabilities.size > capabilityLimit) {
    invalidPlan(
      "declared_recovery_capability_limit",
      "declared recovery capability limit exceeded",
    );
  }

  const resourceLimit = proposal.explicit_facts.limits.max_resources;
  const declaredResources = uniqueCanonical([
    ...proposal.explicit_facts.resource_claims,
    ...templates.flatMap(({ changes }) => changes.resource_additions),
  ]);
  if (declaredResources.length > resourceLimit) {
    invalidPlan(
      "declared_recovery_resource_limit",
      "declared recovery resource limit exceeded",
    );
  }
}

function declaredRecoveryCapabilities(proposal) {
  return new Set([
    ...proposal.requested_authority.capabilities,
    ...proposal.explicit_facts.block_observations.flatMap(
      ({ block }) => block.required_capabilities,
    ),
    ...(proposal.revision_templates ?? []).flatMap(({ changes }) =>
      changes.capability_additions.map(({ capability }) => capability)),
  ]);
}

function validateCardBlock(block, cardId, proposal) {
  const exactFields = isRecord(block) &&
    Object.keys(block).length === CARD_BLOCK_FIELDS.length &&
    CARD_BLOCK_FIELDS.every((field) => Object.hasOwn(block, field));
  if (!exactFields || block.schema !== "flow.card-block/v1" ||
      typeof block.id !== "string" || !block.id ||
      !["capability_required", "plan_revision_required"].includes(block.type) ||
      block.trigger?.schema !== "flow.revision-trigger/v1" ||
      block.trigger?.type !== block.type ||
      typeof block.trigger.type !== "string" || !block.trigger.type ||
      typeof block.trigger.code !== "string" || !block.trigger.code ||
      Object.keys(block.trigger).length !== 3 ||
      !Array.isArray(block.required_capabilities) ||
      !block.required_capabilities.every((capability) =>
        typeof capability === "string" && capability) ||
      !Array.isArray(block.revision_template_ids) ||
      !block.revision_template_ids.every((id) => typeof id === "string" && id)) {
    invalidPlan("invalid_card_block", `dynamic plan card block is invalid: ${cardId}`);
  }
  if (block.type === "capability_required" &&
      block.revision_template_ids.length > 0) {
    invalidPlan(
      "ambiguous_block_recovery",
      `capability block cannot name revision templates: ${cardId}`,
    );
  }
  if (block.type === "capability_required" &&
      (block.required_capabilities.length === 0 ||
       !proposal.requested_authority.commands.includes("capability_grant"))) {
    invalidPlan(
      "incomplete_capability_authority",
      `dynamic plan capability grant authority is incomplete: ${cardId}`,
    );
  }
  if (block.type === "plan_revision_required" &&
      (block.revision_template_ids.length === 0 ||
       block.required_capabilities.length > 0 ||
       !proposal.requested_authority.commands.includes("revision_decision"))) {
    invalidPlan(
      "incomplete_revision_authority",
      `dynamic plan revision authority is incomplete: ${cardId}`,
    );
  }
  if (!block.required_capabilities.every((capability) =>
    proposal.explicit_facts.capability_envelopes.includes(capability))) {
    invalidPlan(
      "capability_outside_envelope",
      `dynamic plan block exceeds the capability envelope: ${cardId}`,
    );
  }
}

function validateBlockObservations(proposal) {
  const cardIds = new Set(proposal.graph.cards.map(({ id }) => id));
  const blockIds = new Set();
  const observedCards = new Set();
  for (const observation of proposal.explicit_facts.block_observations) {
    const fields = [
      "schema",
      "adapter_contract",
      "validator_contract",
      "card_id",
      "block",
      "evidence_digest",
    ];
    const exact = isRecord(observation) &&
      Object.keys(observation).length === fields.length &&
      fields.every((field) => Object.hasOwn(observation, field));
    const { schema: _schema, evidence_digest: _digest, ...evidence } =
      observation ?? {};
    if (!exact || observation?.schema !== "flow.card-block-observation/v1" ||
        observation?.adapter_contract !==
          "flow.adapter/card-block-observation/v1" ||
        observation?.validator_contract !==
          "flow.validator/card-block-observation/v1" ||
        !proposal.explicit_facts.operation_contracts.includes(
          observation?.adapter_contract,
        ) || !proposal.explicit_facts.validator_contracts.includes(
          observation?.validator_contract,
        ) || !cardIds.has(observation?.card_id) ||
        observation?.evidence_digest !== digest(evidence)) {
      invalidPlan(
        "invalid_block_observation",
        "card block observation evidence is invalid",
      );
    }
    validateCardBlock(observation.block, observation.card_id, proposal);
    if (blockIds.has(observation.block.id)) {
      invalidPlan(
        "duplicate_card_block",
        "dynamic plan card block identities must be unique",
      );
    }
    if (observedCards.has(observation.card_id)) {
      invalidPlan(
        "duplicate_card_block_observation",
        "dynamic plan cards accept only one block observation",
      );
    }
    blockIds.add(observation.block.id);
    observedCards.add(observation.card_id);
  }
}

function validateRevisionTemplates(proposal, registeredOperations) {
  const templates = proposal.revision_templates === undefined
    ? []
    : proposal.revision_templates;
  if (!Array.isArray(templates)) {
    invalidPlan("invalid_revision_templates", "revision templates must be an array");
  }
  const referencedTemplates = new Map();
  for (const observation of proposal.explicit_facts.block_observations) {
    for (const id of observation.block.revision_template_ids) {
      if (referencedTemplates.has(id)) {
        invalidPlan(
          "ambiguous_revision_template",
          `revision template is bound to multiple card blocks: ${id}`,
        );
      }
      referencedTemplates.set(id, {
        card_id: observation.card_id,
        trigger: observation.block.trigger,
      });
    }
  }
  if (templates.length === 0) {
    if (referencedTemplates.size > 0) {
      invalidPlan("unknown_revision_template", "card block names an unknown revision template");
    }
    return;
  }
  if (!Number.isInteger(proposal.explicit_facts.limits.max_revisions) ||
      proposal.explicit_facts.limits.max_revisions < 1) {
    invalidPlan("invalid_revision_limit", "revision templates require a positive revision limit");
  }
  const ids = new Set();
  for (const template of templates) {
    if (!isRecord(template) || template.schema !== "flow.plan-revision-template/v1" ||
        typeof template.id !== "string" || !template.id || ids.has(template.id) ||
        Object.keys(template).length !== 5 ||
        !Object.hasOwn(template, "trigger") ||
        !Object.hasOwn(template, "limits") ||
        !Object.hasOwn(template, "changes")) {
      invalidPlan("invalid_revision_template", "plan revision template is invalid");
    }
    if (!isRecord(template.limits) ||
        Object.keys(template.limits).length !== 1 ||
        !Number.isInteger(template.limits.max_applications) ||
        template.limits.max_applications < 1) {
      invalidPlan(
        "invalid_revision_template_limit",
        "revision template application limit is invalid",
      );
    }
    ids.add(template.id);
    const binding = referencedTemplates.get(template.id);
    if (binding === undefined ||
        digest(template.trigger) !== digest(binding.trigger)) {
      invalidPlan("invalid_revision_trigger", `revision trigger is not declared: ${template.id}`);
    }
    validateRevisionChanges(proposal, template, registeredOperations);
  }
  for (const id of referencedTemplates.keys()) {
    if (!ids.has(id)) {
      invalidPlan(
        "unknown_revision_template",
        `card block names an unknown revision template: ${id}`,
      );
    }
  }
}

function validateRevisionChanges(proposal, template, registeredOperations) {
  const changes = template.changes;
  const fields = [
    "add_cards",
    "add_edges",
    "supersede_cards",
    "capability_additions",
    "resource_additions",
    "limit_changes",
  ];
  if (!isRecord(changes) || Object.keys(changes).length !== fields.length ||
      !fields.every((field) => Object.hasOwn(changes, field)) ||
      !fields.slice(0, -1).every((field) => Array.isArray(changes[field])) ||
      !isRecord(changes.limit_changes)) {
    invalidPlan("invalid_revision_changes", `revision changes are incomplete: ${template.id}`);
  }
  const existingIds = new Set(proposal.graph.cards.map(({ id }) => id));
  const addedIds = new Set();
  for (const card of changes.add_cards) {
    if (!isRecord(card) || typeof card.id !== "string" ||
        existingIds.has(card.id) || addedIds.has(card.id)) {
      invalidPlan("revision_card_conflict", `revision card identity conflicts: ${template.id}`);
    }
    if (!Array.isArray(card.dependencies)) {
      invalidPlan(
        "incomplete_revision_card",
        `revision card dependencies are incomplete: ${card.id}`,
      );
    }
    addedIds.add(card.id);
  }
  if (!changes.supersede_cards.every((id) => existingIds.has(id)) ||
      new Set(changes.supersede_cards).size !== changes.supersede_cards.length) {
    invalidPlan(
      "invalid_revision_supersession",
      `revision supersession is invalid: ${template.id}`,
    );
  }
  const pendingClosure = new Set(
    proposal.explicit_facts.block_observations
      .filter(({ block }) => block.revision_template_ids.includes(template.id))
      .map(({ card_id: cardId }) => cardId),
  );
  let closureChanged = true;
  while (closureChanged) {
    closureChanged = false;
    for (const card of proposal.graph.cards) {
      if (!pendingClosure.has(card.id) && card.dependencies.some((dependency) =>
        pendingClosure.has(dependency))) {
        pendingClosure.add(card.id);
        closureChanged = true;
      }
    }
  }
  const superseded = new Set(changes.supersede_cards);
  if (pendingClosure.size !== superseded.size ||
      [...pendingClosure].some((id) => !superseded.has(id))) {
    invalidPlan(
      "invalid_revision_supersession",
      "revision supersession must be the blocked card and its pending dependent closure",
    );
  }
  const revisedCards = [...proposal.graph.cards, ...changes.add_cards]
    .map((card) => structuredClone(card));
  const allIds = new Set(revisedCards.map(({ id }) => id));
  const edgeIds = new Set();
  for (const edge of changes.add_edges) {
    const edgeId = `${edge?.from}\0${edge?.to}`;
    if (!isRecord(edge) || Object.keys(edge).length !== 2 ||
        typeof edge.from !== "string" || typeof edge.to !== "string" ||
        !allIds.has(edge.from) || !addedIds.has(edge.to) || edge.from === edge.to ||
        edgeIds.has(edgeId)) {
      invalidPlan("invalid_revision_edge", `revision edge is invalid: ${template.id}`);
    }
    edgeIds.add(edgeId);
    revisedCards.find(({ id }) => id === edge.to).dependencies.push(edge.from);
  }
  if (hasActiveDependencyOnSuperseded(revisedCards, superseded)) {
    invalidPlan(
      "active_card_depends_on_superseded_work",
      "active revision card cannot depend on superseded work",
    );
  }
  if (!changes.capability_additions.every((binding) =>
    isRecord(binding) && Object.keys(binding).length === 2 &&
    typeof binding.capability === "string" && binding.capability &&
    proposal.explicit_facts.capability_envelopes.includes(binding.capability) &&
    Array.isArray(binding.card_ids) && binding.card_ids.length > 0 &&
    binding.card_ids.every((id) => allIds.has(id)))) {
    invalidPlan(
      "capability_outside_envelope",
      `revision capability is outside its envelope: ${template.id}`,
    );
  }
  if (!changes.resource_additions.every(isRecord)) {
    invalidPlan("invalid_revision_resource", `revision resource is invalid: ${template.id}`);
  }
  if (!Object.entries(changes.limit_changes).every(([name, value]) =>
    Object.hasOwn(proposal.explicit_facts.limits, name) &&
    Number.isInteger(value) && value >= (name === "max_cards" ? 1 : 0))) {
    invalidPlan("invalid_revision_limit", `revision limit change is invalid: ${template.id}`);
  }
  const limits = { ...proposal.explicit_facts.limits, ...changes.limit_changes };
  if (limits.max_revisions < 1) {
    invalidPlan(
      "invalid_revision_limit",
      `revision limit cannot exclude its own admission: ${template.id}`,
    );
  }
  if (changes.add_cards.length > limits.max_cards_per_revision) {
    invalidPlan("revision_card_limit", "revision card limit exceeded");
  }
  const capabilityCount = declaredRecoveryCapabilities(proposal).size;
  if (capabilityCount > limits.max_capabilities) {
    invalidPlan("revision_capability_limit", "revision capability limit exceeded");
  }
  if (uniqueCanonical([
    ...proposal.explicit_facts.resource_claims,
    ...changes.resource_additions,
  ]).length > limits.max_resources) {
    invalidPlan("revision_resource_limit", "revision resource limit exceeded");
  }
  if (proposal.explicit_facts.elapsed_seconds > limits.max_elapsed_seconds) {
    invalidPlan("revision_elapsed_limit", "revision elapsed limit exceeded");
  }
  validateDynamicPlan({
    ...proposal,
    graph: { ...proposal.graph, cards: revisedCards },
    explicit_facts: { ...proposal.explicit_facts, limits },
  }, { registeredOperations, skipRevisionTemplates: true });
}

function validateCheckpointCard(card, facts) {
  if (card.executor.contract !== CHECKPOINT_CONTRACT) {
    invalidPlan(
      "unsupported_checkpoint_contract",
      `unsupported checkpoint contract: ${card.executor.contract}`,
    );
  }
  if (card.validators.length !== 1 ||
      card.validators[0] !== CHECKPOINT_VALIDATOR ||
      !facts.validator_contracts.includes(CHECKPOINT_VALIDATOR)) {
    invalidPlan(
      "unsupported_checkpoint_validator",
      `unsupported checkpoint validator contract: ${card.id}`,
    );
  }
}

function validateOperationCard(card, proposal, registeredOperations) {
  const { explicit_facts: facts } = proposal;
  const registration = registeredOperation(registeredOperations,
    card.executor.contract);
  const policy = effectClassPolicy(card.executor.effect_classification);
  const registrationIssue = registeredOperations === null
    ? null
    : operationRegistrationIssue(
        registration,
        card.executor.effect_classification,
      );
  if (registrationIssue === "unregistered_operation_contract") {
    invalidPlan(
      "unregistered_operation_contract",
      `operation contract is not registered: ${card.executor.contract}`,
    );
  }
  if (registrationIssue === "incomplete_operation_registration") {
    invalidPlan(
      "incomplete_operation_registration",
      `operation adapter registration is incomplete: ${card.executor.contract}`,
    );
  }
  if (!facts.operation_contracts.includes(card.executor.contract) ||
      !proposal.requested_authority.mutations.includes(card.executor.contract)) {
    invalidPlan(
      "incomplete_operation_authority",
      `operation authority is incomplete: ${card.id}`,
    );
  }
  if (!card.resource_claims.every((claim) => facts.resource_claims.some(
    (declared) => digest(declared) === digest(claim),
  ))) {
    invalidPlan(
      "undeclared_operation_resource_claim",
      `operation resource claim is outside the prepared facts: ${card.id}`,
    );
  }
  if (!policy || registrationIssue === "invalid_effect_classification") {
    invalidPlan(
      "invalid_effect_classification",
      `operation effect classification is invalid: ${card.id}`,
    );
  }
  if (card.validators.length !== 1 ||
      card.validators[0] !== OPERATION_RECEIPT_VALIDATOR ||
      !facts.validator_contracts.includes(OPERATION_RECEIPT_VALIDATOR)) {
    invalidPlan(
      "unsupported_operation_validator",
      `unsupported operation validator contract: ${card.id}`,
    );
  }
  if (card.recovery !== card.executor.effect_classification) {
    invalidPlan(
      "invalid_operation_recovery",
      `operation recovery does not match its effect class: ${card.id}`,
    );
  }
  if (typeof registration?.validateCard === "function") {
    try {
      registration.validateCard(card, proposal);
    } catch (error) {
      invalidPlan(
        "invalid_operation_input",
        error?.message ?? `operation input is invalid: ${card.id}`,
      );
    }
  }
  const checkpoints = proposal.graph.cards.filter((checkpoint) =>
    card.dependencies.includes(checkpoint.id) &&
    checkpoint.executor?.kind === "checkpoint" &&
    checkpoint.executor.contract === CHECKPOINT_CONTRACT &&
    checkpoint.inputs?.operation_card_id === card.id);
  if (policy.requires_fresh_checkpoint &&
      (checkpoints.length !== 1 || card.dependencies.length !== 1)) {
    invalidPlan(
      "missing_operation_checkpoint",
      `one-shot operation requires one exact operation-bound checkpoint: ${card.id}`,
    );
  }
  if (checkpoints.length === 1 && card.dependencies.length !== 1) {
    invalidPlan(
      "ambiguous_operation_checkpoint",
      `checkpoint-bound operation requires one exact dependency: ${card.id}`,
    );
  }
  if (checkpoints.length === 0 &&
      !proposal.requested_authority.commands.includes("operation_execute")) {
    invalidPlan(
      "incomplete_operation_execution_authority",
      `direct operation execution authority is incomplete: ${card.id}`,
    );
  }
}

export function canonicalizeRevisionTemplates(templates) {
  return templates
    .map((template) => ({
      ...template,
      changes: {
        ...template.changes,
        add_cards: canonicalizeDynamicGraph({
          schema: "flow.run-plan/v1",
          cards: template.changes.add_cards,
        }).cards,
        add_edges: [...template.changes.add_edges].sort((left, right) => {
          const leftId = `${left.from}\0${left.to}`;
          const rightId = `${right.from}\0${right.to}`;
          return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
        }),
        supersede_cards: [...new Set(template.changes.supersede_cards)].sort(),
        capability_additions: [
          ...template.changes.capability_additions,
        ].map((binding) => ({
          ...binding,
          card_ids: [...new Set(binding.card_ids)].sort(),
        })).sort((left, right) => {
          const leftDigest = digest(left);
          const rightDigest = digest(right);
          return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0;
        }),
        resource_additions: [...template.changes.resource_additions]
          .sort((left, right) => digest(left) < digest(right) ? -1 : 1),
      },
    }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function canonicalizeDynamicGraph(graph) {
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
  if (hasDependencyCycle(cards)) {
    invalidPlan("cyclic_graph", "dynamic plan graph must be acyclic");
  }
}

export function canonicalizeExplicitFacts(facts) {
  return {
    ...facts,
    route_snapshot: {
      ...facts.route_snapshot,
      bindings: [...facts.route_snapshot.bindings]
        .sort(compareCanonicalValues),
    },
    capability_envelopes: [...facts.capability_envelopes].sort(),
    operation_contracts: [...facts.operation_contracts].sort(),
    validator_contracts: [...facts.validator_contracts].sort(),
    resource_claims: [...facts.resource_claims].sort(compareCanonicalValues),
    block_observations: [...facts.block_observations]
      .sort((left, right) => {
        const leftId = `${left.card_id}\0${left.block.id}`;
        const rightId = `${right.card_id}\0${right.block.id}`;
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      }),
  };
}

function compareCanonicalValues(left, right) {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0;
}

function invalidPlan(reason, message) {
  throw new DynamicPlanValidationError(reason, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value ?? "");
}

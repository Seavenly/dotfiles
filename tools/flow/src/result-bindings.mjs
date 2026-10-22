import { digest, freezeCanonical } from "./canonical.mjs";

export const RESULT_BINDING_SCHEMA = "flow.result-binding/v1";
export const RESULT_BINDING_RECORD_SCHEMA = "flow.result-binding-record/v1";
export const RESULT_PROVENANCE_SCHEMA = "flow.result-provenance/v1";
export const RESULT_BINDING_DELTA_SCHEMA = "flow.result-binding-delta/v1";

const RESULT_BINDING_KEYS = Object.freeze([
  "consumer_card_id",
  "expected_schema",
  "output_contract",
  "producer_card_id",
  "schema",
]);

const RESULT_BINDING_RECORD_BASE_KEYS = Object.freeze([
  "attempt_id",
  "binding_digest",
  "content",
  "content_digest",
  "expected_schema",
  "observed_schema",
  "output_contract",
  "producer_card_id",
  "provenance",
  "result_identity",
  "schema",
  "self_digest",
]);

const RESULT_PROVENANCE_KEYS = Object.freeze([
  "attempt_id",
  "effect_id",
  "idempotency_key",
  "run_id",
  "schema",
  "source_authority_watermark",
]);

const RESULT_BINDING_DELTA_KEYS = Object.freeze([
  "add",
  "remove",
  "schema",
]);

export function createResultBinding({
  consumerCardId,
  producerCardId,
  outputContract,
  expectedSchema,
}) {
  return normalizeResultBinding({
    schema: RESULT_BINDING_SCHEMA,
    consumer_card_id: consumerCardId,
    producer_card_id: producerCardId,
    output_contract: outputContract,
    expected_schema: expectedSchema,
  });
}

export function normalizeResultBinding(binding) {
  if (!isResultBinding(binding)) {
    throw new TypeError("result binding contract is incomplete or not exact");
  }
  return freezeCanonical({
    schema: RESULT_BINDING_SCHEMA,
    consumer_card_id: binding.consumer_card_id,
    producer_card_id: binding.producer_card_id,
    output_contract: binding.output_contract,
    expected_schema: binding.expected_schema,
  });
}

export function isResultBinding(binding) {
  return isRecord(binding) &&
    Object.keys(binding).sort().join(",") === RESULT_BINDING_KEYS.join(",") &&
    binding.schema === RESULT_BINDING_SCHEMA &&
    nonEmpty(binding.consumer_card_id) &&
    nonEmpty(binding.producer_card_id) &&
    nonEmpty(binding.output_contract) &&
    nonEmpty(binding.expected_schema);
}

export function createResultBindingRecord({
  declaration,
  content,
  attemptId,
  provenance,
  producerGeneration,
  workspaceMutationEpoch,
}) {
  if (!isResultBinding(declaration)) {
    throw new TypeError("result binding declaration is invalid");
  }
  if (!isRecord(content) || !nonEmpty(content.schema)) {
    throw new TypeError("result binding content must name an observed schema");
  }
  if (content.schema !== declaration.expected_schema) {
    throw new TypeError("result binding content schema does not match its declaration");
  }
  if (!nonEmpty(attemptId) || !isResultProvenance(provenance) ||
      provenance.attempt_id !== attemptId) {
    throw new TypeError("result binding provenance is invalid");
  }
  const hasGeneration = producerGeneration !== undefined ||
    workspaceMutationEpoch !== undefined;
  if (hasGeneration &&
      (!Number.isSafeInteger(producerGeneration) || producerGeneration < 1 ||
       !Number.isSafeInteger(workspaceMutationEpoch) ||
       workspaceMutationEpoch < 0)) {
    throw new TypeError("result binding workspace fence is invalid");
  }
  const contentSnapshot = freezeCanonical(content);
  const contentDigest = digest(contentSnapshot);
  const identity = {
    schema: RESULT_BINDING_RECORD_SCHEMA,
    producer_card_id: declaration.producer_card_id,
    output_contract: declaration.output_contract,
    expected_schema: declaration.expected_schema,
    observed_schema: contentSnapshot.schema,
    attempt_id: attemptId,
    ...(hasGeneration ? {
      producer_generation: producerGeneration,
      workspace_mutation_epoch: workspaceMutationEpoch,
    } : {}),
    provenance,
    content_digest: contentDigest,
    content: contentSnapshot,
  };
  identity.result_identity = resultIdentityDigest(identity);
  const bindingDigest = digest(identity);
  return freezeCanonical({
    ...identity,
    binding_digest: bindingDigest,
    self_digest: bindingDigest,
  });
}

export function normalizeResultBindingRecord(record) {
  if (!isResultBindingRecord(record)) {
    throw new TypeError("result binding record is incomplete or not exact");
  }
  const { binding_digest: _bindingDigest, self_digest: _selfDigest, ...identity } =
    record;
  if (record.provenance.attempt_id !== record.attempt_id ||
      record.content_digest !== digest(record.content) ||
      record.result_identity !== resultIdentityDigest(record)) {
    throw new TypeError("result binding record identity is invalid");
  }
  const bindingDigest = digest(identity);
  if (record.binding_digest !== bindingDigest ||
      record.self_digest !== bindingDigest) {
    throw new TypeError("result binding record digest is invalid");
  }
  return freezeCanonical(record);
}

export function isResultBindingRecord(record) {
  if (!isRecord(record) || record.schema !== RESULT_BINDING_RECORD_SCHEMA ||
      !nonEmpty(record.producer_card_id) ||
      !nonEmpty(record.output_contract) ||
      !nonEmpty(record.expected_schema) ||
      !nonEmpty(record.observed_schema) || !nonEmpty(record.attempt_id) ||
      record.observed_schema !== record.expected_schema ||
      !isRecord(record.content) || record.content.schema !== record.observed_schema ||
      !isDigest(record.content_digest) || !isDigest(record.result_identity) ||
      !isDigest(record.binding_digest) || !isDigest(record.self_digest) ||
      !isResultProvenance(record.provenance)) {
    return false;
  }
  const keys = Object.keys(record).sort();
  const allowed = [...RESULT_BINDING_RECORD_BASE_KEYS,
    ...(Object.hasOwn(record, "producer_generation")
      ? ["producer_generation", "workspace_mutation_epoch"]
      : [])].sort();
  if (keys.join(",") !== allowed.join(",")) return false;
  if (Object.hasOwn(record, "producer_generation") !==
      Object.hasOwn(record, "workspace_mutation_epoch")) return false;
  return !Object.hasOwn(record, "producer_generation") ||
    (Number.isSafeInteger(record.producer_generation) &&
      record.producer_generation >= 1 &&
      Number.isSafeInteger(record.workspace_mutation_epoch) &&
      record.workspace_mutation_epoch >= 0);
}

export function isResultProvenance(provenance) {
  return isRecord(provenance) &&
    Object.keys(provenance).sort().join(",") === RESULT_PROVENANCE_KEYS.join(",") &&
    provenance.schema === RESULT_PROVENANCE_SCHEMA &&
    nonEmpty(provenance.run_id) && nonEmpty(provenance.effect_id) &&
    nonEmpty(provenance.attempt_id) && nonEmpty(provenance.idempotency_key) &&
    isDigest(provenance.source_authority_watermark);
}

export function declaredResultBindings(plan, consumerCardId) {
  return resultBindingsFor(plan, "consumer_card_id", consumerCardId);
}

export function resultBindingDeclarationsForProducer(plan, producerCardId) {
  return resultBindingsFor(plan, "producer_card_id", producerCardId);
}

export function createResultBindingDelta({ add = [], remove = [] } = {}) {
  return normalizeResultBindingDelta({
    schema: RESULT_BINDING_DELTA_SCHEMA,
    add,
    remove,
  });
}

export function normalizeResultBindingDelta(delta) {
  if (!isRecord(delta) ||
      Object.keys(delta).sort().join(",") !== RESULT_BINDING_DELTA_KEYS.join(",") ||
      delta.schema !== RESULT_BINDING_DELTA_SCHEMA ||
      !Array.isArray(delta.add) || !Array.isArray(delta.remove)) {
    throw new TypeError("result binding declaration delta is invalid");
  }
  const add = delta.add.map(normalizeResultBinding);
  const remove = delta.remove.map(normalizeResultBinding);
  assertUniqueDeclarations(add, "result binding delta additions");
  assertUniqueDeclarations(remove, "result binding delta removals");
  return freezeCanonical({
    schema: RESULT_BINDING_DELTA_SCHEMA,
    add: sortDeclarations(add),
    remove: sortDeclarations(remove),
  });
}

/**
 * Build the exact declaration set after applying a card replacement graph.
 * Existing declarations are retained only when their producer and consumer
 * still name the same evidence relationship. Changed relationships become an
 * explicit remove/add pair in the returned delta.
 */
export function buildResultBindingDelta({
  baseBindings,
  cards,
  changes,
} = {}) {
  if (!Array.isArray(baseBindings) || !Array.isArray(cards) ||
      !isRecord(changes)) {
    throw new TypeError("result binding delta inputs are incomplete");
  }
  const base = baseBindings.map(normalizeResultBinding);
  const superseded = new Set(changes.supersede_cards ?? []);
  const replacements = replacementMap(changes.add_cards ?? [], superseded);
  const postCards = applyCardChanges(cards, changes);
  const cardsById = new Map(postCards.map((card) => [card.id, card]));
  const baseByRelationship = new Map();
  for (const declaration of base) {
    const key = declarationKey(declaration);
    if (baseByRelationship.has(key)) {
      throw new TypeError("result binding declaration is ambiguous");
    }
    baseByRelationship.set(key, declaration);
  }
  const schemaByOutput = new Map(
    base.map((declaration) => [
      declaration.output_contract,
      declaration.expected_schema,
    ]),
  );
  const expected = [];
  for (const consumer of postCards.filter(({ id }) => !superseded.has(id))) {
    for (const producerId of evidenceIds(consumer)) {
      const producer = cardsById.get(producerId);
      const mappedCandidates = base.filter((declaration) =>
        (replacements.get(declaration.consumer_card_id) ??
          declaration.consumer_card_id) === consumer.id &&
        (replacements.get(declaration.producer_card_id) ??
          declaration.producer_card_id) === producerId);
      const declaration = mappedCandidates.length === 1
        ? createResultBinding({
          consumerCardId: consumer.id,
          producerCardId: producerId,
          outputContract: mappedCandidates[0].output_contract,
          expectedSchema: mappedCandidates[0].expected_schema,
        })
        : inferNewDeclaration({
          consumer,
          producer,
          schemaByOutput,
        });
      if (declaration !== null) expected.push(declaration);
    }
  }
  const expectedByKey = new Map(expected.map((declaration) => [
    declarationKey(declaration),
    declaration,
  ]));
  const remove = base.filter((declaration) => {
    const mapped = mapDeclaration(declaration, replacements);
    return expectedByKey.has(declarationKey(mapped))
      ? declarationKey(mapped) !== declarationKey(declaration)
      : true;
  });
  const add = [...expectedByKey.values()].filter((declaration) =>
    !baseByRelationship.has(declarationKey(declaration)));
  return createResultBindingDelta({ add, remove });
}

/**
 * Validate a supplied declaration delta and return the exact post revision
 * declarations. This is used by both preparation and authority admission so
 * a declined or gated revision never changes the active declaration set.
 */
export function applyResultBindingDelta({
  baseBindings,
  cards,
  changes,
  delta,
} = {}) {
  if (!Array.isArray(baseBindings) || !Array.isArray(cards) ||
      !isRecord(changes)) {
    throw new TypeError("result binding delta inputs are incomplete");
  }
  const base = baseBindings.map(normalizeResultBinding);
  const normalized = normalizeResultBindingDelta(delta);
  const baseByKey = new Map();
  for (const declaration of base) {
    const key = declarationKey(declaration);
    if (baseByKey.has(key)) {
      throw new TypeError("result binding declaration is ambiguous");
    }
    baseByKey.set(key, declaration);
  }
  const removeKeys = new Set(normalized.remove.map(declarationKey));
  const addKeys = new Set(normalized.add.map(declarationKey));
  for (const declaration of normalized.remove) {
    if (!baseByKey.has(declarationKey(declaration)) ||
        !sameDeclaration(baseByKey.get(declarationKey(declaration)), declaration)) {
      throw new TypeError("result binding delta removes an unknown declaration");
    }
  }
  for (const declaration of normalized.add) {
    const key = declarationKey(declaration);
    if (baseByKey.has(key) && !removeKeys.has(key)) {
      throw new TypeError("result binding delta adds a duplicate declaration");
    }
  }
  const superseded = new Set(changes.supersede_cards ?? []);
  const replacements = replacementMap(changes.add_cards ?? [], superseded);
  const postCards = applyCardChanges(cards, changes);
  const cardsById = new Map(postCards.map((card) => [card.id, card]));
  for (const declaration of normalized.add) {
    validateDeclarationEndpoint({
      declaration,
      cardsById,
      superseded,
    });
  }
  const next = [
    ...base.filter((declaration) => !removeKeys.has(declarationKey(declaration))),
    ...normalized.add,
  ];
  assertUniqueDeclarations(next, "result binding declarations");
  validatePostDeclarationSet({
    base,
    next,
    cardsById,
    superseded,
    replacements,
  });
  return freezeCanonical(sortDeclarations(next));
}

export function validateResultBindingDeclarations({
  bindings,
  cards,
  superseded = [],
} = {}) {
  if (!Array.isArray(bindings) || !Array.isArray(cards)) {
    throw new TypeError("result binding declarations are incomplete");
  }
  const normalized = bindings.map(normalizeResultBinding);
  assertUniqueDeclarations(normalized, "result binding declarations");
  const supersededSet = new Set(superseded);
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  validatePostDeclarationSet({
    base: normalized,
    next: normalized,
    cardsById,
    superseded: supersededSet,
    replacements: new Map(),
  });
  return freezeCanonical(sortDeclarations(normalized));
}

function resultBindingsFor(plan, field, value) {
  if (!isRecord(plan) || !Object.hasOwn(plan, "result_bindings")) return null;
  if (!Array.isArray(plan.result_bindings) || !nonEmpty(value)) {
    throw new TypeError("result binding declarations are invalid");
  }
  return plan.result_bindings
    .filter((binding) => binding[field] === value)
    .map(normalizeResultBinding);
}

function validatePostDeclarationSet({
  base,
  next,
  cardsById,
  superseded,
  replacements,
}) {
  const nextByKey = new Map(next.map((declaration) => [
    declarationKey(declaration),
    declaration,
  ]));
  for (const declaration of base) {
    const mapped = mapDeclaration(declaration, replacements);
    const mappedKey = declarationKey(mapped);
    const mappedConsumer = cardsById.get(mapped.consumer_card_id);
    const mappedProducer = cardsById.get(mapped.producer_card_id);
    const shouldRemain = mappedConsumer !== undefined &&
      mappedProducer !== undefined &&
      !superseded.has(mappedConsumer.id) &&
      !superseded.has(mappedProducer.id) &&
      evidenceIds(mappedConsumer).includes(mappedProducer.id) &&
      mappedProducer.outputs.includes(mapped.output_contract);
    if (shouldRemain && !nextByKey.has(mappedKey)) {
      throw new TypeError("result binding replacement mapping is incomplete");
    }
    if (!shouldRemain && nextByKey.has(mappedKey) &&
        mappedKey === declarationKey(declaration)) {
      throw new TypeError("result binding retains a stale declaration");
    }
  }
  for (const consumer of cardsById.values()) {
    if (superseded.has(consumer.id)) continue;
    for (const producerId of evidenceIds(consumer)) {
      const matches = next.filter((declaration) =>
        declaration.consumer_card_id === consumer.id &&
        declaration.producer_card_id === producerId);
      if (matches.length !== 1) {
        throw new TypeError("result binding evidence declaration is missing or ambiguous");
      }
      validateDeclarationEndpoint({
        declaration: matches[0],
        cardsById,
        superseded,
      });
    }
  }
  for (const declaration of next) {
    const consumer = cardsById.get(declaration.consumer_card_id);
    if (consumer === undefined || superseded.has(consumer.id) ||
        !evidenceIds(consumer).includes(declaration.producer_card_id)) {
      throw new TypeError("result binding names an undeclared evidence endpoint");
    }
  }
}

function validateDeclarationEndpoint({ declaration, cardsById, superseded }) {
  const consumer = cardsById.get(declaration.consumer_card_id);
  const producer = cardsById.get(declaration.producer_card_id);
  if (consumer === undefined || producer === undefined ||
      superseded.has(consumer.id) || superseded.has(producer.id) ||
      consumer.id === producer.id ||
      !producer.outputs.includes(declaration.output_contract) ||
      !evidenceIds(consumer).includes(producer.id) ||
      !hasDependencyPath(cardsById, consumer.id, producer.id)) {
    throw new TypeError("result binding endpoint is unknown, superseded, or wrong");
  }
}

function inferNewDeclaration({ consumer, producer, schemaByOutput }) {
  if (producer === undefined) return null;
  const outputContract = producer.outputs.find((output) =>
    schemaByOutput.has(output));
  if (outputContract === undefined) return null;
  return createResultBinding({
    consumerCardId: consumer.id,
    producerCardId: producer.id,
    outputContract,
    expectedSchema: schemaByOutput.get(outputContract),
  });
}

function mapDeclaration(declaration, replacements) {
  return createResultBinding({
    consumerCardId: replacements.get(declaration.consumer_card_id) ??
      declaration.consumer_card_id,
    producerCardId: replacements.get(declaration.producer_card_id) ??
      declaration.producer_card_id,
    outputContract: declaration.output_contract,
    expectedSchema: declaration.expected_schema,
  });
}

function replacementMap(cards, superseded) {
  const replacements = new Map();
  for (const card of cards) {
    const target = card?.replaces_card_id ?? card?.inputs?.replaces_card_id;
    if (target === undefined) continue;
    if (replacements.has(target) || !superseded.has(target)) {
      throw new TypeError("result binding replacement mapping is ambiguous");
    }
    replacements.set(target, card.id);
  }
  return replacements;
}

function applyCardChanges(cards, changes) {
  const postCards = [...cards, ...(changes.add_cards ?? [])]
    .map((card) => structuredClone(card));
  const cardsById = new Map(postCards.map((card) => [card.id, card]));
  for (const edge of changes.add_edges ?? []) {
    const target = cardsById.get(edge.to);
    if (target === undefined) {
      throw new TypeError("result binding revision edge names an unknown card");
    }
    target.dependencies = [...new Set([
      ...(target.dependencies ?? []),
      edge.from,
    ])].sort();
  }
  return postCards;
}

function evidenceIds(card) {
  return [...new Set([
    ...(card.inputs?.delegate_evidence_card_ids ?? []),
    ...(card.inputs?.operation_evidence_card_ids ?? []),
    ...(card.inputs?.test_card_ids ?? []),
  ])].sort();
}

function hasDependencyPath(cardsById, consumerId, producerId) {
  const seen = new Set();
  const visit = (cardId) => {
    if (cardId === producerId) return true;
    if (seen.has(cardId)) return false;
    seen.add(cardId);
    return (cardsById.get(cardId)?.dependencies ?? []).some(visit);
  };
  return visit(consumerId);
}

function declarationKey(declaration) {
  return [
    declaration.consumer_card_id,
    declaration.producer_card_id,
    declaration.output_contract,
    declaration.expected_schema,
  ].join("\0");
}

function sameDeclaration(left, right) {
  return declarationKey(left) === declarationKey(right);
}

function assertUniqueDeclarations(declarations, label) {
  const keys = new Set(declarations.map(declarationKey));
  if (keys.size !== declarations.length) {
    throw new TypeError(label + " contain duplicates");
  }
}

function sortDeclarations(declarations) {
  return [...declarations].sort((left, right) => {
    const leftKey = declarationKey(left);
    const rightKey = declarationKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function resultIdentityDigest(record) {
  return digest({
    schema: "flow.result-identity/v1",
    producer_card_id: record.producer_card_id,
    output_contract: record.output_contract,
    expected_schema: record.expected_schema,
    observed_schema: record.observed_schema,
    attempt_id: record.attempt_id,
    ...(Object.hasOwn(record, "producer_generation") ? {
      producer_generation: record.producer_generation,
      workspace_mutation_epoch: record.workspace_mutation_epoch,
    } : {}),
    provenance: record.provenance,
    content_digest: record.content_digest,
  });
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

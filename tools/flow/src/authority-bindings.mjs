import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";

export const AUTHORITY_SCHEMA = "flow.required-authority/v1";
export const BINDING_SCHEMA = "flow.required-authority-binding/v1";
export const OBSERVATION_SCHEMA = "flow.authority-observation/v1";
export const REGISTERED_AUTHORITY_SCHEMA = "flow.registered-authority/v1";
export const AUTHORITY_FACT_SCHEMA = "flow.authority-fact/v1";

export const SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS = Object.freeze([
  Object.freeze({
    schema: AUTHORITY_SCHEMA,
    id: "route:facts",
    contract: "flow.route-authority/v1",
    observation_input: { fact: "route_snapshot" },
  }),
  Object.freeze({
    schema: AUTHORITY_SCHEMA,
    id: "resource:facts",
    contract: "flow.resource-authority/v1",
    observation_input: { fact: "resource_claims" },
  }),
  Object.freeze({
    schema: AUTHORITY_SCHEMA,
    id: "contract:facts",
    contract: "flow.contract-authority/v1",
    observation_input: { fact: "contract_facts" },
  }),
  Object.freeze({
    schema: AUTHORITY_SCHEMA,
    id: "generation:facts",
    contract: "flow.subject-generation/v1",
    observation_input: { fact: "subject_generations" },
  }),
]);

const OBSERVATION_FIELDS = new Set([
  "schema",
  "status",
  "watermark",
  "authority_watermark",
  "provider_watermark",
  "generation",
  "provider_generation",
  "observation_input",
  "legal_actions",
]);

const AUTHORITY_STATUSES = new Set([
  "available",
  "present",
  "missing",
  "stale",
  "unavailable",
  "contradictory",
  "uncertain",
]);

/**
 * Snapshot the trusted authority Adapter catalog. The returned values retain
 * mechanism callbacks only inside the authority process; callers receive
 * only the closed identity and observation records produced below.
 */
export function snapshotRegisteredAuthorities(authorities = {}) {
  if (authorities === null ||
      !(authorities instanceof Map) &&
      (typeof authorities !== "object" || Array.isArray(authorities))) {
    throw new TypeError("registeredAuthorities must be an object or Map");
  }
  const entries = authorities instanceof Map
    ? [...authorities.entries()]
    : Object.entries(authorities);
  const snapshot = new Map();
  for (const [key, value] of entries) {
    const registration = normalizeAuthorityRegistration(value, key);
    if (snapshot.has(registration.id)) {
      throw new TypeError(
        `registered authority is registered more than once: ${registration.id}`,
      );
    }
    snapshot.set(registration.id, registration);
  }
  return snapshot;
}

/**
 * Return the closed catalog identity used when a runtime binds authority
 * providers to one RunAuthority. Mechanism callbacks are intentionally not
 * part of this identity.
 */
export function authorityBindingCatalogIdentity({
  authorities = new Map(),
  predefinedDefinitions = new Map(),
} = {}) {
  if (!(authorities instanceof Map) ||
      !(predefinedDefinitions instanceof Map)) {
    throw new TypeError("authority catalogs must be Maps");
  }
  const authorityEntries = [...authorities.values()]
    .map((registration) => ({
      schema: REGISTERED_AUTHORITY_SCHEMA,
      id: registration.id,
      contract: registration.contract,
      provider_identity: registration.provider_identity,
    }))
    .sort(compareAuthorityIdentity);
  const definitionEntries = [...predefinedDefinitions.values()]
    .map((definition) => ({
      schema: definition.schema,
      id: definition.id,
      contract: definition.contract,
      required_authorities: definition.required_authorities,
    }))
    .sort(compareAuthorityIdentity);
  return digest({
    schema: "flow.authority-binding-catalog/v1",
    authorities: authorityEntries,
    predefined_definitions: definitionEntries,
  });
}

/**
 * Keep the definition catalog's authority requirements without importing a
 * compiler or executable definition callback into RunAuthority.
 */
export function snapshotPredefinedAuthorityCatalog(definitions = new Map()) {
  const entries = definitions instanceof Map
    ? [...definitions.entries()]
    : Object.entries(definitions ?? {});
  const snapshot = new Map();
  for (const [key, value] of entries) {
    const id = value?.identity?.id ?? value?.id ?? key;
    const contract = value?.identity?.contract ?? value?.contract;
    if (typeof id !== "string" || !id || typeof contract !== "string" || !contract) {
      continue;
    }
    const requirements = value?.required_authorities ?? [];
    snapshot.set(id, freezeCanonical({
      schema: "flow.predefined-definition-authority-catalog/v1",
      id,
      contract,
      required_authorities: normalizeRequiredAuthorities(requirements),
    }));
  }
  return snapshot;
}

export function normalizeRequiredAuthorities(requirements = []) {
  if (!Array.isArray(requirements)) {
    throw new TypeError("required authorities must be an array");
  }
  const normalized = requirements.map((requirement) => {
    if (typeof requirement === "string") {
      return freezeCanonical({
        schema: AUTHORITY_SCHEMA,
        id: requirement,
        contract: requirement,
        observation_input: {},
      });
    }
    if (!isPlainRecord(requirement)) {
      throw new TypeError("required authority declaration is invalid");
    }
    const id = requirement.id ?? requirement.authority_id ?? requirement.name;
    const contract = requirement.contract ?? requirement.contract_id;
    const observationInput = requirement.observation_input ??
      requirement.input ?? {};
    if (typeof id !== "string" || !id || typeof contract !== "string" ||
        !contract || !isPlainRecord(observationInput)) {
      throw new TypeError("required authority declaration is incomplete");
    }
    return freezeCanonical({
      schema: AUTHORITY_SCHEMA,
      id,
      contract,
      observation_input: observationInput,
    });
  });
  const seen = new Set();
  for (const requirement of normalized) {
    if (seen.has(requirement.id)) {
      throw new TypeError(
        `required authority is declared more than once: ${requirement.id}`,
      );
    }
    seen.add(requirement.id);
  }
  return freezeCanonical(normalized.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function prepareAuthorityBindings(
  requirements,
  catalog,
  context = {},
) {
  const normalized = normalizeRequiredAuthorities(requirements);
  const bindings = normalized.map((requirement) => {
    const registration = catalog?.get(requirement.id);
    if (!registration || registration.contract !== requirement.contract) {
      throw authorityPreparationError(
        "required_authority_catalog_unavailable",
        requirement.id,
      );
    }
    let observation;
    try {
      observation = registration.observe({
        ...context,
        authority: requirement,
        observation_input: requirement.observation_input,
        input: requirement.observation_input,
      });
    } catch {
      throw authorityPreparationError(
        "required_authority_unavailable",
        requirement.id,
      );
    }
    try {
      return createAuthorityBinding({
        id: requirement.id,
        contract: requirement.contract,
        providerIdentity: registration.provider_identity,
        observationInput: requirement.observation_input,
        observation,
      });
    } catch {
      throw authorityPreparationError(
        "required_authority_unavailable",
        requirement.id,
      );
    }
  });
  return freezeCanonical(bindings);
}

export function recheckAuthorityBindings(bindings, catalog, context = {}) {
  const expected = normalizeAuthorityBindings(bindings);
  const observed = [];
  const issues = [];
  for (const binding of expected) {
    const registration = catalog?.get(binding.id);
    if (!registration) {
      issues.push(authorityIssue(
        "required_authority_catalog_unavailable",
        binding,
        null,
      ));
      continue;
    }
    if (registration.contract !== binding.contract) {
      issues.push(authorityIssue(
        "required_authority_contract_mismatch",
        binding,
        null,
      ));
      continue;
    }
    if (digest(registration.provider_identity) !==
        digest(binding.provider_identity)) {
      issues.push(authorityIssue(
        "required_authority_provider_mismatch",
        binding,
        null,
      ));
      continue;
    }
    let observedBinding;
    try {
      observedBinding = createAuthorityBinding({
        id: binding.id,
        contract: binding.contract,
        providerIdentity: binding.provider_identity,
        observationInput: binding.observation_input,
        observation: registration.observe({
          ...context,
          authority: {
            schema: AUTHORITY_SCHEMA,
            id: binding.id,
            contract: binding.contract,
            observation_input: binding.observation_input,
          },
          observation_input: binding.observation_input,
          input: binding.observation_input,
          expected_observation: binding.observation,
        }),
      });
    } catch {
      issues.push(authorityIssue(
        "required_authority_unavailable",
        binding,
        null,
      ));
      continue;
    }
    observed.push(observedBinding);
    const observation = observedBinding.observation;
    const statusIssue = authorityStatusIssue(observation.status);
    if (statusIssue !== null) {
      issues.push(authorityIssue(statusIssue, binding, observation));
    } else if (digest(observation) !== digest(binding.observation)) {
      issues.push(authorityIssue(
        "required_authority_stale",
        binding,
        observation,
      ));
    }
  }
  return freezeCanonical({
    schema: "flow.required-authority-revalidation/v1",
    valid: issues.length === 0 && observed.length === expected.length,
    expected,
    observed,
    issues,
  });
}

export function validateDefinitionAuthorityBindings(
  prepared,
  authorityCatalog,
  definitionCatalog,
) {
  if (prepared?.kind !== "predefined") return null;
  const definition = definitionCatalog?.get(prepared.definition?.id);
  const preparedRequirements = (prepared.required_authorities ?? []).map((binding) => ({
    schema: AUTHORITY_SCHEMA,
    id: binding.id,
    contract: binding.contract,
    observation_input: binding.observation_input,
  }));
  const definitionBinding = prepared.required_authorities?.[0] ?? {
    id: prepared.definition?.id ?? null,
    contract: prepared.definition?.contract ?? null,
  };
  if (!definition) {
    return authorityIssue(
      "required_authority_catalog_unavailable",
      definitionBinding,
      null,
    );
  }
  if (definition.contract !== prepared.definition.contract ||
      digest(definition.required_authorities) !== digest(preparedRequirements)) {
    return authorityIssue(
      "required_authority_binding_mismatch",
      definitionBinding,
      null,
    );
  }
  if ((prepared.required_authorities ?? []).length === 0) return null;
  const result = recheckAuthorityBindings(
    prepared.required_authorities,
    authorityCatalog,
    { prepared, phase: "launch" },
  );
  return result.valid ? null : result.issues[0] ?? authorityIssue(
    "required_authority_unavailable",
    prepared.required_authorities[0],
    null,
  );
}

export function normalizeAuthorityBindings(bindings = []) {
  if (!Array.isArray(bindings)) {
    throw new TypeError("required authority bindings must be an array");
  }
  return freezeCanonical(bindings.map((binding) => {
    if (!isExactRecord(binding, [
          "schema",
          "id",
          "contract",
          "provider_identity",
          "observation_input",
          "observation",
        ]) || binding.schema !== BINDING_SCHEMA ||
        typeof binding.id !== "string" || !binding.id ||
        typeof binding.contract !== "string" || !binding.contract ||
        !isExactRecord(binding.provider_identity, ["schema", "id", "version"]) ||
        binding.provider_identity.schema !== REGISTERED_AUTHORITY_SCHEMA ||
        typeof binding.provider_identity.id !== "string" ||
        !binding.provider_identity.id ||
        typeof binding.provider_identity.version !== "string" ||
        !binding.provider_identity.version ||
        !isPlainRecord(binding.observation_input) ||
        !isPlainRecord(binding.observation)) {
      throw new TypeError("required authority binding is invalid");
    }
    return createAuthorityBinding({
      id: binding.id,
      contract: binding.contract,
      providerIdentity: binding.provider_identity,
      observationInput: binding.observation_input,
      observation: binding.observation,
    });
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function createAuthorityBinding({
  id,
  contract,
  providerIdentity,
  observationInput,
  observation,
}) {
  if (typeof id !== "string" || !id ||
      typeof contract !== "string" || !contract ||
      !isExactRecord(providerIdentity, ["schema", "id", "version"]) ||
      providerIdentity.schema !== REGISTERED_AUTHORITY_SCHEMA ||
      typeof providerIdentity.id !== "string" || !providerIdentity.id ||
      typeof providerIdentity.version !== "string" || !providerIdentity.version ||
      !isPlainRecord(observationInput) || !isPlainRecord(observation)) {
    throw new TypeError("required authority binding is invalid");
  }
  return freezeCanonical({
    schema: BINDING_SCHEMA,
    id,
    contract,
    provider_identity: providerIdentity,
    observation_input: observationInput,
    observation: normalizeAuthorityObservation(observation, {
      observation_input: observationInput,
    }),
  });
}

export function normalizeAuthorityObservation(observation, binding) {
  if (!isPlainRecord(observation)) {
    throw new TypeError("authority observation is unavailable");
  }
  let normalized;
  try {
    normalized = freezeCanonical(observation);
  } catch {
    throw new TypeError("authority observation is not immutable JSON");
  }
  if (normalized.schema !== OBSERVATION_SCHEMA ||
      !AUTHORITY_STATUSES.has(normalized.status) ||
      authorityWatermark(normalized) === null && authorityGeneration(normalized) === null) {
    throw new TypeError("authority observation is incomplete");
  }
  if (Reflect.ownKeys(normalized).some((key) => !OBSERVATION_FIELDS.has(key))) {
    throw new TypeError("authority observation contains an unknown field");
  }
  if (binding?.observation_input !== undefined &&
      normalized.observation_input !== undefined &&
      digest(normalized.observation_input) !== digest(binding.observation_input)) {
    throw new TypeError("authority observation input changed");
  }
  return normalized;
}

export function authorityIssueCodeForStatus(status) {
  return authorityStatusIssue(status);
}

/**
 * Convert an authority issue into the one public, closed fact shape. Launch
 * and reboot rejection paths both use this conversion so provider identity,
 * watermarks, generations, and legal actions cannot drift.
 */
export function authorityFactFromIssue(issue) {
  return createAuthorityFact({
    authorityId: issue?.authority_id ?? null,
    authorityContract: issue?.authority_contract ?? null,
    providerIdentity: issue?.authority_provider_identity ?? null,
    watermark: issue?.authority_watermark ?? null,
    generation: issue?.authority_generation ?? null,
    legalActions: issue?.legal_actions ?? [],
  });
}

export function createAuthorityFact({
  authorityId = null,
  authorityContract = null,
  providerIdentity = null,
  watermark = null,
  generation = null,
  legalActions = [],
} = {}) {
  return freezeCanonical({
    schema: AUTHORITY_FACT_SCHEMA,
    authority_id: authorityId,
    authority_contract: authorityContract,
    provider_identity: providerIdentity,
    watermark,
    generation,
    legal_actions: Array.isArray(legalActions) ? legalActions : [],
  });
}

export function authorityWatermark(observation) {
  const watermark = observation?.watermark ?? observation?.authority_watermark ??
    observation?.provider_watermark;
  return /^sha256:[0-9a-f]{64}$/.test(watermark ?? "") ? watermark : null;
}

export function authorityGeneration(observation) {
  const generation = observation?.generation ?? observation?.provider_generation;
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

function normalizeAuthorityRegistration(value, key) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`registered authority is invalid: ${key}`);
  }
  if (value.schema !== REGISTERED_AUTHORITY_SCHEMA) {
    throw new TypeError(`registered authority schema is invalid: ${key}`);
  }
  const id = value.id ?? key;
  const contract = value.contract;
  const providerIdentity = value.provider_identity;
  const observe = value.observe ?? value.recheck;
  if (typeof id !== "string" || !id || typeof contract !== "string" ||
      !contract || !isExactRecord(providerIdentity, ["schema", "id", "version"]) ||
      providerIdentity.schema !== REGISTERED_AUTHORITY_SCHEMA ||
      typeof providerIdentity.id !== "string" || !providerIdentity.id ||
      typeof providerIdentity.version !== "string" || !providerIdentity.version ||
      typeof observe !== "function") {
    throw new TypeError(`registered authority is incomplete: ${key}`);
  }
  if (typeof key === "string" && key !== id) {
    throw new TypeError(`registered authority identity does not match key: ${key}`);
  }
  return Object.freeze({
    id,
    contract,
    provider_identity: freezeCanonical(providerIdentity),
    observe: observe.bind(value),
  });
}

function compareAuthorityIdentity(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function authorityPreparationError(code, reason) {
  const error = new Error(`required authority preparation failed: ${reason}`);
  error.name = "RequiredAuthorityError";
  error.code = code;
  error.reason = reason;
  return error;
}

function authorityIssue(code, binding, observation) {
  return freezeCanonical({
    code,
    reason: binding?.id ?? null,
    authority_id: binding?.id ?? null,
    authority_contract: binding?.contract ?? null,
    authority_provider_identity: binding?.provider_identity ?? null,
    authority_watermark: authorityWatermark(observation),
    authority_generation: authorityGeneration(observation),
    legal_actions: Array.isArray(observation?.legal_actions)
      ? observation.legal_actions
      : [],
  });
}

function isExactRecord(value, fields) {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function authorityStatusIssue(status) {
  if (status === "missing") return "required_authority_missing";
  if (status === "stale") return "required_authority_stale";
  if (status === "unavailable") return "required_authority_unavailable";
  if (status === "contradictory") return "required_authority_contradictory";
  if (status === "uncertain") return "required_authority_uncertain";
  return null;
}

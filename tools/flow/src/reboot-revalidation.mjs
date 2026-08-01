import { digest, freezeCanonical } from "./canonical.mjs";

const OBSERVATION_FIELDS = [
  "catalog_fingerprint",
  "route_snapshot",
  "capability_envelopes",
  "operation_contracts",
  "validator_contracts",
  "resource_claims",
  "time_facts",
  "subject_generations",
];

export function createFailClosedRebootObservationAdapter() {
  return Object.freeze({
    observe() {
      return null;
    },
  });
}

export function buildRebootRevalidation({
  adapter,
  prepared,
  unresolvedEffects,
}) {
  const expected = preparedObservation(prepared);
  let observed;
  let valid = false;
  try {
    const candidate = adapter.observe({ prepared, unresolvedEffects });
    if (isExactObservation(candidate)) {
      observed = candidate;
      valid = digest(observed) === digest(expected) &&
        unresolvedEffects.length === 0;
    }
  } catch {
    valid = false;
  }
  observed ??= expected;
  return freezeCanonical({
    schema: "flow.reboot-revalidation/v1",
    valid,
    ...observed,
    unresolved_effects: unresolvedEffects,
  });
}

function isExactObservation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === OBSERVATION_FIELDS.length &&
    keys.every((key) => OBSERVATION_FIELDS.includes(key));
}

export function preparedObservation(prepared) {
  const facts = prepared.explicit_facts;
  return freezeCanonical({
    catalog_fingerprint: facts.catalog_fingerprint,
    route_snapshot: facts.route_snapshot,
    capability_envelopes: facts.capability_envelopes,
    operation_contracts: facts.operation_contracts,
    validator_contracts: facts.validator_contracts,
    resource_claims: facts.resource_claims,
    time_facts: [],
    subject_generations: [],
  });
}

import { digest, freezeCanonical } from "./canonical.mjs";
import {
  evaluateRebootTimeFacts,
  validateRebootFacts,
} from "./reboot-facts.mjs";
import { validateRebootEffectRechecks } from "./reboot-effects.mjs";

const OBSERVATION_FIELDS = [
  "catalog_fingerprint",
  "route_snapshot",
  "capability_envelopes",
  "operation_contracts",
  "validator_contracts",
  "resource_claims",
  "limits",
  "elapsed_seconds",
  "time_facts",
  "subject_generations",
  "effect_rechecks",
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
  currentBootId,
  currentFacts,
  prepared,
  unresolvedEffects,
  unresolvedEffectsValid = true,
}) {
  const expected = preparedObservation(prepared, currentFacts);
  const pendingEffects = freezeCanonical(
    unresolvedEffects.map((effect) => structuredClone(effect)),
  );
  const authoritativeFacts = freezeCanonical({
    resource_claims: expected.resource_claims,
    limits: expected.limits,
    elapsed_seconds: expected.elapsed_seconds,
  });
  let observed;
  let valid = false;
  try {
    if (unresolvedEffectsValid) {
      const candidate = adapter.observe({
        currentFacts: authoritativeFacts,
        prepared,
        unresolvedEffects: pendingEffects,
      });
      if (isExactObservation(candidate) &&
          validateRebootFacts(candidate.time_facts, candidate.subject_generations)) {
        observed = candidate;
        valid = stableObservationMatches(expected, observed) &&
          evaluateRebootTimeFacts({
            currentBootId,
            elapsedSeconds: expected.elapsed_seconds,
            expectedFacts: expected.time_facts,
            maxElapsedSeconds: expected.limits.max_elapsed_seconds,
            observedFacts: observed.time_facts,
          }) && validateRebootEffectRechecks(
            observed.effect_rechecks,
            pendingEffects,
          );
      }
    }
  } catch {
    valid = false;
  }
  return freezeCanonical({
    schema: "flow.reboot-revalidation/v1",
    valid,
    expected,
    observed: observed ?? null,
    unresolved_effects: pendingEffects,
  });
}

function stableObservationMatches(expected, observed) {
  return [
    "catalog_fingerprint",
    "route_snapshot",
    "capability_envelopes",
    "operation_contracts",
    "validator_contracts",
    "resource_claims",
    "limits",
    "elapsed_seconds",
    "subject_generations",
  ].every((field) => digest(expected[field]) === digest(observed[field]));
}

function isExactObservation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === OBSERVATION_FIELDS.length &&
    keys.every((key) => OBSERVATION_FIELDS.includes(key));
}

export function preparedObservation(prepared, currentFacts = null) {
  const facts = prepared.explicit_facts;
  const authoritative = currentFacts ?? {
    resource_claims: facts.resource_claims,
    limits: facts.limits,
    elapsed_seconds: facts.elapsed_seconds,
  };
  return freezeCanonical({
    catalog_fingerprint: facts.catalog_fingerprint,
    route_snapshot: facts.route_snapshot,
    capability_envelopes: facts.capability_envelopes,
    operation_contracts: facts.operation_contracts,
    validator_contracts: facts.validator_contracts,
    resource_claims: authoritative.resource_claims,
    limits: authoritative.limits,
    elapsed_seconds: authoritative.elapsed_seconds,
    time_facts: facts.time_facts ?? [],
    subject_generations: facts.subject_generations ?? [],
    effect_rechecks: [],
  });
}

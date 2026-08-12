import { digest } from "../src/canonical.mjs";
import {
  SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
} from "../src/authority-bindings.mjs";

const OBSERVATION_SCHEMA = "flow.authority-observation/v1";
const REGISTRATION_SCHEMA = "flow.registered-authority/v1";

/**
 * Build independent test providers for the shipped definitions. The mutable
 * state is the provider's current observation, not a prepared selection.
 */
export function shippedAuthorityRegistrations({ current = {} } = {}) {
  return Object.fromEntries(SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS.map((requirement) => [requirement.id, {
    schema: REGISTRATION_SCHEMA,
    id: requirement.id,
    contract: requirement.contract,
    provider_identity: {
      schema: REGISTRATION_SCHEMA,
      id: testProviderId(requirement),
      version: "v1",
    },
    observe() {
      const value = typeof current[requirement.id] === "function"
        ? current[requirement.id]()
        : current[requirement.id];
      if (!value || typeof value !== "object") {
        throw new Error(`missing current observation: ${requirement.id}`);
      }
      return {
        schema: OBSERVATION_SCHEMA,
        observation_input: requirement.observation_input,
        legal_actions: [],
        ...structuredClone(value),
      };
    },
  }]));
}

/**
 * Seed provider-owned current observations from fixture facts. This helper is
 * intentionally only a fixture initializer; providers never receive facts or
 * prepared bundles during observation.
 */
export function shippedAuthorityStateFromFacts(facts = {}) {
  const contractFacts = {
    catalog_fingerprint: facts.catalog_fingerprint ?? null,
    operation_contracts: facts.operation_contracts ?? [],
    validator_contracts: facts.validator_contracts ?? [],
  };
  const state = Object.fromEntries(
    SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS.map((requirement) => {
      const fact = requirement.observation_input.fact;
      const value = fact === "contract_facts"
        ? contractFacts
        : facts[fact] ?? (fact === "subject_generations" ? [] : null);
      const observation = available(value);
      if (fact === "subject_generations" && Array.isArray(value) &&
          value.length === 1 && Number.isSafeInteger(value[0]?.generation)) {
        observation.generation = value[0].generation;
      }
      return [requirement.id, observation];
    }),
  );
  return state;
}

function testProviderId(requirement) {
  return `test.provider/${requirement.id.replaceAll(":", "-")}`;
}

function available(value) {
  return {
    status: "available",
    watermark: digest(value),
  };
}

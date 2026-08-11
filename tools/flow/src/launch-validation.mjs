import { isDeepStrictEqual } from "node:util";

import {
  CanonicalValueError,
  digest,
  freezeCanonical,
  isPlainRecord,
} from "./canonical.mjs";
import {
  canonicalizeDynamicGraph,
  canonicalizeExplicitFacts,
  canonicalizeRevisionTemplates,
  canonicalizePredefinedSelection,
  DynamicPlanValidationError,
  predefinedRoutes,
  validateDynamicPlan,
} from "./plan-compiler.mjs";
import {
  createDynamicPlanConfirmation,
  createPreparedBundle,
  createPredefinedFlowConfirmation,
} from "./prepared-contracts.mjs";

const PREPARED_RUN_FIELDS = [
  "schema",
  "kind",
  "bundle_digest",
  "plan_fingerprint",
  "confirmation_digest",
  "graph",
  "requested_authority",
  "explicit_facts",
  "confirmation",
  "revision_templates",
];
const PREDEFINED_RUN_FIELDS = [
  ...PREPARED_RUN_FIELDS,
  "definition",
  "selection",
  "promised_outcomes",
  "negative_outcomes",
  "routes",
  "trust_posture",
];
const PREDEFINED_DEFINITION_ID = /^[A-Za-z0-9._-]+\/v[0-9]+$/;

export function validateLaunchRequest(request = {}) {
  const { prepared, confirmation, closed_facts: closedFacts } = request ?? {};
  try {
    assertPreparedBundle(prepared);
  } catch (error) {
    if (!(error instanceof LaunchValidationError)) throw error;
    return invalid("invalid_prepared_bundle", prepared, error.reason);
  }
  try {
    assertConfirmationDecision(prepared, confirmation);
  } catch (error) {
    if (!(error instanceof LaunchValidationError)) throw error;
    return invalid("invalid_confirmation", prepared, error.reason);
  }
  if (confirmation.decision === "decline") {
    return invalid("confirmation_declined", prepared);
  }
  const expectedClosedFacts = freezeCanonical({
    schema: "flow.closed-fact-observation/v1",
    bundle_digest: prepared.bundle_digest,
    facts: prepared.explicit_facts,
  });
  if (!isDeepStrictEqual(closedFacts, expectedClosedFacts)) {
    return invalid("closed_facts_changed", prepared);
  }
  return { accepted: true, prepared, closedFacts };
}

function invalid(code, prepared, reason = null) {
  return { accepted: false, code, prepared, reason };
}

function assertPreparedBundle(prepared) {
  const fields = prepared?.kind === "predefined"
    ? PREDEFINED_RUN_FIELDS
    : PREPARED_RUN_FIELDS;
  if (!isExactRecord(prepared, fields) ||
      prepared.schema !== "flow.prepared-run/v1" ||
      !["dynamic", "predefined"].includes(prepared.kind)) {
    invalidLaunch(
      "invalid_prepared_contract",
      "launch requires a prepared flow bundle",
    );
  }
  if (prepared.kind === "predefined") assertPredefinedEnvelope(prepared);
  try {
    digest(prepared);
  } catch (error) {
    translateCanonicalError(error);
  }
  let graphDigest;
  try {
    graphDigest = digest(prepared.graph);
  } catch (error) {
    translateCanonicalError(error);
  }
  if (prepared.plan_fingerprint !== graphDigest) {
    invalidLaunch("plan_fingerprint_mismatch", "prepared plan fingerprint mismatch");
  }
  try {
    validateDynamicPlan({
      schema: "flow.dynamic-plan-proposal/v1",
      graph: prepared.graph,
      requested_authority: prepared.requested_authority,
      explicit_facts: prepared.explicit_facts,
      revision_templates: prepared.revision_templates,
    });
  } catch (error) {
    if (error instanceof DynamicPlanValidationError) {
      invalidLaunch(error.reason, error.message);
    }
    throw error;
  }
  if (!isDeepStrictEqual(prepared.graph, canonicalizeDynamicGraph(prepared.graph))) {
    invalidLaunch(
      "noncanonical_graph",
      "prepared graph must use the canonical card and dependency order",
    );
  }
  if (prepared.kind === "predefined") assertPredefinedRoutes(prepared);
  if (!isDeepStrictEqual(
    prepared.explicit_facts,
    canonicalizeExplicitFacts(prepared.explicit_facts),
  )) {
    invalidLaunch(
      "noncanonical_explicit_facts",
      "prepared explicit facts must use canonical ordering",
    );
  }
  if (!isDeepStrictEqual(
    prepared.revision_templates,
    canonicalizeRevisionTemplates(prepared.revision_templates),
  )) {
    invalidLaunch(
      "noncanonical_revision_templates",
      "prepared revision templates must use canonical ordering",
    );
  }
  let bundleDigest;
  try {
    bundleDigest = digest(createPreparedBundle({
      kind: prepared.kind,
      definition: prepared.definition,
      selection: prepared.selection,
      graph: prepared.graph,
      planFingerprint: prepared.plan_fingerprint,
      requestedAuthority: prepared.requested_authority,
      explicitFacts: prepared.explicit_facts,
      revisionTemplates: prepared.revision_templates,
      promisedOutcomes: prepared.promised_outcomes,
      negativeOutcomes: prepared.negative_outcomes,
      routes: prepared.routes,
      trustPosture: prepared.trust_posture,
    }));
  } catch (error) {
    translateCanonicalError(error);
  }
  if (prepared.bundle_digest !== bundleDigest) {
    invalidLaunch("bundle_digest_mismatch", "prepared bundle digest mismatch");
  }
  const expectedConfirmation = prepared.kind === "predefined"
    ? createPredefinedFlowConfirmation({
        bundleDigest: prepared.bundle_digest,
        definition: prepared.definition,
        inputs: prepared.selection.inputs,
        promisedOutcomes: prepared.promised_outcomes,
        negativeOutcomes: prepared.negative_outcomes,
        requestedAuthority: prepared.requested_authority,
        limits: prepared.explicit_facts.limits,
        routes: prepared.routes,
        trustPosture: prepared.trust_posture,
        revisionTemplates: prepared.revision_templates,
      })
    : createDynamicPlanConfirmation({
        bundleDigest: prepared.bundle_digest,
        graph: prepared.graph,
        requestedAuthority: prepared.requested_authority,
        explicitFacts: prepared.explicit_facts,
        revisionTemplates: prepared.revision_templates,
      });
  if (!isDeepStrictEqual(prepared.confirmation, expectedConfirmation) ||
      prepared.confirmation_digest !== digest(expectedConfirmation)) {
    invalidLaunch(
      "confirmation_binding_mismatch",
      "prepared confirmation is not bound to the bundle",
    );
  }
}

function assertPredefinedEnvelope(prepared) {
  if (!isExactRecord(prepared.definition, ["schema", "id", "contract"]) ||
      prepared.definition.schema !== "flow.predefined-definition/v1" ||
      typeof prepared.definition.id !== "string" ||
      !PREDEFINED_DEFINITION_ID.test(prepared.definition.id) ||
      typeof prepared.definition.contract !== "string" ||
      prepared.definition.contract.trim() === "" ||
      !isExactRecord(prepared.selection, [
        "schema",
        "definition",
        "inputs",
        "explicit_facts",
      ]) ||
      prepared.selection.schema !== "flow.predefined-flow-selection/v1" ||
      prepared.selection.definition !== prepared.definition.id ||
      !isDeepStrictEqual(
        prepared.selection.explicit_facts,
        prepared.explicit_facts,
      ) ||
      !isPlainRecord(prepared.selection.inputs) ||
      !isPlainRecord(prepared.selection.explicit_facts) ||
      !Array.isArray(prepared.promised_outcomes) ||
      !Array.isArray(prepared.negative_outcomes) ||
      !Array.isArray(prepared.routes) ||
      !isPlainRecord(prepared.trust_posture)) {
    invalidLaunch(
      "invalid_predefined_selection",
      "prepared predefined identity is incomplete",
    );
  }
  try {
    if (!isDeepStrictEqual(
      prepared.selection,
      canonicalizePredefinedSelection(prepared.selection),
    )) {
      invalidLaunch(
        "noncanonical_predefined_selection",
        "prepared predefined selection must be canonical",
      );
    }
    digest(prepared.definition);
    digest(prepared.promised_outcomes);
    digest(prepared.negative_outcomes);
    digest(prepared.routes);
    digest(prepared.trust_posture);
  } catch (error) {
    translateCanonicalError(error);
  }
}

function assertPredefinedRoutes(prepared) {
  const expectedRoutes = predefinedRoutes(
    prepared.graph,
    prepared.revision_templates,
  );
  if (!isDeepStrictEqual(prepared.routes, expectedRoutes)) {
    invalidLaunch(
      "routes_mismatch",
      "prepared predefined routes must match the compiled graph",
    );
  }
}

function assertConfirmationDecision(prepared, confirmation) {
  if (!["accept", "decline"].includes(confirmation?.decision)) {
    invalidLaunch(
      "unsupported_confirmation_decision",
      "launch confirmation decision is invalid",
    );
  }
  const valid = ["accept", "decline"].some((decision) => isDeepStrictEqual(
    confirmation,
    freezeCanonical({
      schema: prepared.kind === "predefined"
        ? "flow.predefined-flow-confirmation-decision/v1"
        : "flow.dynamic-plan-confirmation-decision/v1",
      decision,
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    }),
  ));
  if (!valid) {
    invalidLaunch(
      "confirmation_binding_mismatch",
      "launch confirmation decision is invalid",
    );
  }
}

function isExactRecord(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

class LaunchValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "LaunchValidationError";
    this.reason = reason;
  }
}

function invalidLaunch(reason, message) {
  throw new LaunchValidationError(reason, message);
}

function translateCanonicalError(error) {
  if (error instanceof CanonicalValueError) {
    invalidLaunch(error.reason, error.message);
  }
  throw error;
}

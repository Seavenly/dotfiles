import { isDeepStrictEqual } from "node:util";

import {
  CanonicalValueError,
  digest,
  freezeCanonical,
} from "./canonical.mjs";
import {
  canonicalizeDynamicGraph,
  DynamicPlanValidationError,
  validateDynamicPlan,
} from "./plan-compiler.mjs";
import {
  createDynamicPlanConfirmation,
  createPreparedBundle,
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
];

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
  if (!isExactRecord(prepared, PREPARED_RUN_FIELDS) ||
      prepared.schema !== "flow.prepared-run/v1" ||
      prepared.kind !== "dynamic") {
    invalidLaunch(
      "invalid_prepared_contract",
      "launch requires a prepared dynamic bundle",
    );
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
  let bundleDigest;
  try {
    bundleDigest = digest(createPreparedBundle({
      kind: prepared.kind,
      graph: prepared.graph,
      planFingerprint: prepared.plan_fingerprint,
      requestedAuthority: prepared.requested_authority,
      explicitFacts: prepared.explicit_facts,
    }));
  } catch (error) {
    translateCanonicalError(error);
  }
  if (prepared.bundle_digest !== bundleDigest) {
    invalidLaunch("bundle_digest_mismatch", "prepared bundle digest mismatch");
  }
  const expectedConfirmation = createDynamicPlanConfirmation({
    bundleDigest: prepared.bundle_digest,
    graph: prepared.graph,
    requestedAuthority: prepared.requested_authority,
    explicitFacts: prepared.explicit_facts,
  });
  if (!isDeepStrictEqual(prepared.confirmation, expectedConfirmation) ||
      prepared.confirmation_digest !== digest(expectedConfirmation)) {
    invalidLaunch(
      "confirmation_binding_mismatch",
      "prepared confirmation is not bound to the bundle",
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
      schema: "flow.dynamic-plan-confirmation-decision/v1",
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

import { freezeCanonical } from "./canonical.mjs";
import {
  EXECUTION_TIME_CONFIRMATION_ACCOUNTING,
} from "./execution-time-policy.mjs";

export function createPreparedBundle({
  kind,
  graph,
  planFingerprint,
  requestedAuthority,
  explicitFacts,
  revisionTemplates,
  definition,
  selection,
  promisedOutcomes,
  negativeOutcomes,
  routes,
  trustPosture,
  requiredAuthorities = [],
}) {
  const bundle = {
    schema: "flow.prepared-bundle/v1",
    kind,
    graph,
    plan_fingerprint: planFingerprint,
    requested_authority: requestedAuthority,
    explicit_facts: explicitFacts,
    revision_templates: revisionTemplates,
  };
  if (kind === "predefined") {
    Object.assign(bundle, {
      definition,
      selection,
      promised_outcomes: promisedOutcomes,
      negative_outcomes: negativeOutcomes,
      routes,
      trust_posture: trustPosture,
      required_authorities: requiredAuthorities,
    });
  }
  return freezeCanonical(bundle);
}

export function createDynamicPlanConfirmation({
  bundleDigest,
  graph,
  requestedAuthority,
  explicitFacts,
  revisionTemplates,
}) {
  return freezeCanonical({
    schema: "flow.dynamic-plan-confirmation/v1",
    bundle_digest: bundleDigest,
    graph,
    requested_authority: requestedAuthority,
    explicit_facts: explicitFacts,
    revision_templates: revisionTemplates,
    execution_time_accounting: EXECUTION_TIME_CONFIRMATION_ACCOUNTING,
  });
}

export function createPredefinedFlowConfirmation({
  bundleDigest,
  definition,
  inputs,
  promisedOutcomes,
  negativeOutcomes,
  requestedAuthority,
  limits,
  routes,
  trustPosture,
  revisionTemplates,
  requiredAuthorities = [],
}) {
  return freezeCanonical({
    schema: "flow.predefined-flow-confirmation/v1",
    bundle_digest: bundleDigest,
    definition,
    inputs,
    promised_outcomes: promisedOutcomes,
    negative_outcomes: negativeOutcomes,
    requested_authority: requestedAuthority,
    mutations: requestedAuthority.mutations,
    routes,
    capabilities: requestedAuthority.capabilities,
    limits,
    trust_posture: trustPosture,
    revision_templates: revisionTemplates,
    required_authorities: requiredAuthorities,
    execution_time_accounting: EXECUTION_TIME_CONFIRMATION_ACCOUNTING,
  });
}

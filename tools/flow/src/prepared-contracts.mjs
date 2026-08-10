import { freezeCanonical } from "./canonical.mjs";

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
  });
}

import { freezeCanonical } from "./canonical.mjs";

export function createPreparedBundle({
  kind,
  graph,
  planFingerprint,
  requestedAuthority,
  explicitFacts,
  revisionTemplates,
}) {
  return freezeCanonical({
    schema: "flow.prepared-bundle/v1",
    kind,
    graph,
    plan_fingerprint: planFingerprint,
    requested_authority: requestedAuthority,
    explicit_facts: explicitFacts,
    revision_templates: revisionTemplates,
  });
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

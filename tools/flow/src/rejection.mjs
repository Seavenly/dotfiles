import { freezeCanonical } from "./canonical.mjs";

export function createRejection({
  operation,
  code,
  outcome = undefined,
  reason = null,
  commandType = null,
  runId = null,
  bundleDigest = null,
  authorityWatermark = null,
  authorityWatermarkDomain,
  legalActions = [],
  findings = undefined,
  authorityFact = undefined,
}) {
  const rejection = {
    schema: "flow.rejection/v1",
    operation,
    code,
    ...(outcome === undefined ? {} : { outcome }),
    reason,
    command_type: commandType,
    run_id: runId,
    bundle_digest: bundleDigest,
    authority_watermark: authorityWatermark,
    authority_watermark_domain: authorityWatermarkDomain,
    legal_actions: legalActions,
  };
  if (findings !== undefined) rejection.findings = findings;
  if (authorityFact !== undefined) rejection.authority_fact = authorityFact;
  return freezeCanonical(rejection);
}

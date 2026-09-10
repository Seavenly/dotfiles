import { freezeCanonical } from "./canonical.mjs";

export function createRejection({
  operation,
  code,
  reason = null,
  commandType = null,
  runId = null,
  bundleDigest = null,
  authorityWatermark = null,
  authorityWatermarkDomain,
  legalActions = [],
  authorityFact = undefined,
}) {
  const rejection = {
    schema: "flow.rejection/v1",
    operation,
    code,
    reason,
    command_type: commandType,
    run_id: runId,
    bundle_digest: bundleDigest,
    authority_watermark: authorityWatermark,
    authority_watermark_domain: authorityWatermarkDomain,
    legal_actions: legalActions,
  };
  if (authorityFact !== undefined) rejection.authority_fact = authorityFact;
  return freezeCanonical(rejection);
}

/*
 * Drovr launch capabilities describe a runtime posture. Flow grants are the
 * authority vocabulary used to admit one card, so a launch literal must never
 * be copied into a Flow capability envelope.
 */
const DROVR_TO_FLOW_GRANTS = new Map([
  ["read-only", []],
  ["on-approve", ["scope:approve"]],
  ["workspace-write", ["repository:write"]],
  ["auto", ["repository:write"]],
  // Flow has no finite grant that represents unrestricted host authority.
  ["unrestricted", null],
]);

export function flowGrantIdsForDrovrCapability(capability) {
  if (!DROVR_TO_FLOW_GRANTS.has(capability)) return null;
  const grants = DROVR_TO_FLOW_GRANTS.get(capability);
  return grants === null ? null : [...grants];
}

export function isKnownDrovrCapability(capability) {
  return DROVR_TO_FLOW_GRANTS.has(capability);
}

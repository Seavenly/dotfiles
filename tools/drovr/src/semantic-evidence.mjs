export const SEMANTIC_HARNESS_EVIDENCE = Object.freeze([
  "present",
  "absent",
  "changed",
  "uncertain",
]);

export function identityEvidence(expected, observed) {
  if (observed === undefined) {
    return { evidence: "uncertain", expected, observed: null };
  }
  if (observed === null) {
    return { evidence: "absent", expected, observed: null };
  }
  const managedAgentChanged =
    Boolean(expected?.managed_agent) &&
    Boolean(observed.managed_agent) &&
    expected.managed_agent !== observed.managed_agent;
  const nativeSessionMissing =
    Boolean(expected?.native_session) && !observed.native_session;
  const nativeSessionChanged =
    Boolean(expected?.native_session) &&
    Boolean(observed.native_session) &&
    expected.native_session !== observed.native_session;
  const paneChanged =
    Boolean(expected?.pane) &&
    Boolean(observed.pane) &&
    expected.pane !== observed.pane;
  const unboundPaneChanged =
    paneChanged && !expected?.native_session && !observed.native_session;
  const identityChanged =
    nativeSessionChanged || (managedAgentChanged && !nativeSessionMissing);
  const evidence =
    identityChanged || unboundPaneChanged
      ? "changed"
      : nativeSessionMissing
        ? "uncertain"
        : "present";
  return evidenceResult(evidence, {
    expected,
    observed,
    ...(evidence === "changed"
      ? {
          reason: identityChanged
            ? "managed identity changed"
            : "unbound pane changed",
        }
      : {}),
    ...(paneChanged ? { pane_changed: true } : {}),
  });
}

export function evidenceResult(evidence, details = {}) {
  if (!SEMANTIC_HARNESS_EVIDENCE.includes(evidence)) {
    throw new TypeError(`unknown semantic harness evidence: ${evidence}`);
  }
  return { evidence, ...details };
}

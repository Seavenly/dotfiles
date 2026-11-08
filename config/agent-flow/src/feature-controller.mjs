export function decideFeatureContinuation({ kind, measurement, used, cap }) {
  if (!Number.isInteger(used) || used < 0 || !Number.isInteger(cap) || cap < 0) {
    throw new Error("controller counts must be non-negative integers");
  }
  if (!measurement || typeof measurement.evidence !== "string") {
    throw new Error("controller measurement requires durable evidence");
  }
  if (kind === "slice") return decideSlice(measurement, used, cap);
  if (kind === "completeness") return decideCompleteness(measurement, used, cap);
  if (kind === "critique") return decideCritique(measurement, used, cap);
  throw new Error(`unknown feature controller kind: ${kind}`);
}

function decideSlice(measurement, used, cap) {
  if (measurement.testable === false) {
    return needsInput("verification is not behaviorally testable", measurement.evidence);
  }
  if (measurement.passed === true) return { action: "continue", evidence: measurement.evidence };
  if (measurement.passed !== false) {
    return needsInput("slice gate did not produce a verdict", measurement.evidence);
  }
  if (used < cap) {
    return { action: "retry", nextOrdinal: used + 1, evidence: measurement.evidence };
  }
  return needsInput("slice retry cap exhausted", measurement.evidence);
}

function decideCompleteness(measurement, used, cap) {
  if (measurement.verdict === "RE_PLAN") {
    return needsInput("completeness requested RE_PLAN", measurement.evidence);
  }
  const uncovered = array(measurement.uncovered);
  if (uncovered.length === 0) return { action: "continue", evidence: measurement.evidence };
  if (used < cap) {
    return {
      action: "fix",
      nextOrdinal: used + 1,
      blocking: uncovered,
      evidence: measurement.evidence,
    };
  }
  return {
    ...needsInput("completeness fix cap exhausted", measurement.evidence),
    blocking: uncovered,
  };
}

function decideCritique(measurement, used, cap) {
  const blocking = array(measurement.blocking);
  const deferred = array(measurement.nonblocking);
  if (!measurement.verdict) {
    return {
      ...needsInput("independent critic produced no verdict", measurement.evidence),
      blocking,
      deferred,
    };
  }
  if (blocking.length === 0) {
    return { action: "continue", deferred, evidence: measurement.evidence };
  }
  if (used < cap) {
    return {
      action: "fix",
      nextOrdinal: used + 1,
      blocking,
      deferred,
      evidence: measurement.evidence,
    };
  }
  return {
    ...needsInput("critique fix cap exhausted", measurement.evidence),
    blocking,
    deferred,
  };
}

function needsInput(reason, evidence) {
  return { action: "needs_input", reason, evidence };
}

function array(value) {
  return Array.isArray(value) ? [...value] : [];
}

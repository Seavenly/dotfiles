import { createProductionSemanticHarness } from "./production-harness-adapter.mjs";

export const SEMANTIC_HARNESS_INTERFACE = "drovr.semantic-harness/v1";

export const SEMANTIC_HARNESS_EVIDENCE = Object.freeze([
  "present",
  "absent",
  "changed",
  "uncertain",
]);

// These operations are semantic contracts. The production implementation may
// use Herdr and native transcript adapters; a replay implementation may use an
// ordered trace and a controllable clock. Callers must not depend on either
// mechanism.
export const SEMANTIC_HARNESS_OPERATIONS = Object.freeze([
  "ensureRuntime",
  "observeRuntime",
  "validateLaunch",
  "observeAgent",
  "observeAgents",
  "waitForAgent",
  "startAgent",
  "resumeAgent",
  "prepareTurn",
  "deliverTurn",
  "waitForTurn",
  "getLateResult",
  "interruptTurn",
  "inspectStagedInput",
  "recoverStagedInput",
  "stageUnknownInput",
  "validateRecovery",
  "attach",
]);

// Topology is still part of the internal seam, but its values are opaque
// topology facts rather than Herdr command results. Keeping it grouped makes
// it possible for a future replay adapter to model placement without teaching
// lifecycle callers about panes, tabs, or workspaces.
export const SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS = Object.freeze([
  "observePane",
  "observePaneProcess",
  "observeTab",
  "observeWorkspace",
  "observeLayout",
  "createWorkspace",
  "createTaskTab",
  "splitTaskPane",
  "renameTask",
  "renameGroup",
  "renameAgentPane",
  "closePane",
  "closeTaskTab",
  "closeGroupWorkspace",
  "sendUnknownInput",
]);

export function createSemanticHarness(options = {}) {
  const candidate = options.adapter ?? createProductionSemanticHarness(options);
  assertSemanticHarness(candidate);

  const harness = {
    schema: SEMANTIC_HARNESS_INTERFACE,
    implementation: candidate.implementation,
    ...(candidate.capabilities ? { capabilities: candidate.capabilities } : {}),
    ...Object.fromEntries(
      SEMANTIC_HARNESS_OPERATIONS.map((operation) => [
        operation,
        (...args) => candidate[operation](...args),
      ]),
    ),
    topology: Object.fromEntries(
      SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS.map((operation) => [
        operation,
        (...args) => candidate.topology[operation](...args),
      ]),
    ),
  };
  return Object.freeze(harness);
}

export function semanticHarnessFor(context, dependencies = {}) {
  const existing = dependencies.harness ?? dependencies.semanticHarness;
  if (existing) return createSemanticHarness({ adapter: existing });
  return createSemanticHarness({
    ...dependencies,
    session: context.group?.herdr?.session,
    harness: context.agent?.launch?.harness,
  });
}

export function assertSemanticHarness(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("semantic harness must be an object");
  }
  if (candidate.schema !== SEMANTIC_HARNESS_INTERFACE) {
    throw new TypeError(
      `semantic harness must declare ${SEMANTIC_HARNESS_INTERFACE}`,
    );
  }
  if (
    candidate.implementation !== "production-herdr" &&
    candidate.implementation !== "trace-replay"
  ) {
    throw new TypeError(
      "semantic harness implementation must be production-herdr or trace-replay",
    );
  }
  for (const operation of SEMANTIC_HARNESS_OPERATIONS) {
    if (typeof candidate[operation] !== "function") {
      throw new TypeError(`semantic harness is missing ${operation}`);
    }
  }
  if (!candidate.topology || typeof candidate.topology !== "object") {
    throw new TypeError("semantic harness is missing topology operations");
  }
  for (const operation of SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS) {
    if (typeof candidate.topology[operation] !== "function") {
      throw new TypeError(`semantic harness is missing topology.${operation}`);
    }
  }
  return candidate;
}

export function identityEvidence(expected, observed) {
  if (observed === undefined) {
    return { evidence: "uncertain", expected, observed: null };
  }
  if (observed === null) {
    return { evidence: "absent", expected, observed: null };
  }
  const matches = Object.keys(expected ?? {}).every(
    (key) => expected[key] === observed[key],
  );
  return {
    evidence: matches ? "present" : "changed",
    expected,
    observed,
  };
}

export function evidenceResult(evidence, details = {}) {
  if (!SEMANTIC_HARNESS_EVIDENCE.includes(evidence)) {
    throw new TypeError(`unknown semantic harness evidence: ${evidence}`);
  }
  return { evidence, ...details };
}

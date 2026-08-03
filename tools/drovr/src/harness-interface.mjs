import { createProductionSemanticHarness } from "./production-harness-adapter.mjs";

export {
  SEMANTIC_HARNESS_EVIDENCE,
  evidenceResult,
  identityEvidence,
} from "./semantic-evidence.mjs";

export const SEMANTIC_HARNESS_INTERFACE = "drovr.semantic-harness/v1";

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
// topology facts rather than Herdr command results. Keeping it grouped lets
// the production and replay adapters model placement without teaching
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
  const candidate = options.adapter ?? createProductionSemanticHarness({
    ...options,
    requireCompatibility: options.requireCompatibility ?? (
      !options.herdr && !options.run
    ),
  });
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
  const launchBinding = context.agent?.launch_binding;
  return createSemanticHarness({
    ...dependencies,
    session: context.group?.herdr?.session,
    harness: context.agent?.launch?.harness,
    ...(context.agent
      ? {
          expectedCompatibilityEvidenceDigest:
            launchBinding?.compatibility_evidence_digest,
          requireCompatibilityBinding: true,
        }
      : {}),
    requireCompatibility: dependencies.requireCompatibility ?? (
      !dependencies.herdr && !dependencies.run
    ),
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

import { digestCanonical } from "./canonical-json.mjs";
import { execute } from "./process.mjs";

export const COMPATIBILITY_SCHEMA = "drovr.compatibility/v1";
export const PRODUCTION_ADAPTER_ID = "drovr.production-herdr/v1";
export const REPLAY_ADAPTER_ID = "drovr.trace-replay/v1";

export const COMPATIBILITY_FEATURES = Object.freeze([
  "drovr.semantic-harness/v1",
  "drovr.identity-bound-mutation/v1",
  "drovr.staged-input-stability/v1",
  "drovr.transcript-correlation/v1",
  "drovr.caller-context-isolation/v1",
]);

// Herdr does not yet expose every native gesture through a typed semantic
// operation. These are deliberately recorded as explicit upstream gaps so a
// compatibility result cannot silently imply a stronger contract than the
// local production adapter actually provides.
export const UPSTREAM_GAPS = Object.freeze([
  Object.freeze({
    id: "herdr.raw-send-keys/v1",
    operation: "agent.send-keys",
    status: "upstream_gap",
    posture: "production-adapter-only",
    safe_local_posture:
      "guard exact managed identity and staged snapshot before every gesture",
  }),
]);

const REQUIRED_FACTS = Object.freeze([
  "drovr",
  "herdr",
  "harness",
  "integration",
  "adapters",
  "features",
]);

export function qualifyCompatibility(
  observed,
  { expected, harness = "codex", adapter = REPLAY_ADAPTER_ID } = {},
) {
  const facts = observed?.facts;
  if (observed?.schema !== undefined && observed.schema !== COMPATIBILITY_SCHEMA) {
    return blockedCompatibility({
      reason: "unqualified",
      facts: facts ?? null,
      detail: `unsupported compatibility schema: ${observed.schema}`,
    });
  }
  const missing = missingFacts(facts, { harness, adapter });
  if (missing.length > 0) {
    return blockedCompatibility({
      reason: "missing",
      facts: facts ?? null,
      missing,
    });
  }
  const incompatible = incompatibleFacts(facts, { harness });
  if (incompatible.length > 0) {
    return blockedCompatibility({
      reason: "unqualified",
      facts,
      mismatches: incompatible,
      detail: `compatibility integration does not match ${harness}`,
    });
  }
  const malformed = malformedFacts(facts, { harness, adapter });
  if (malformed.length > 0) {
    return blockedCompatibility({
      reason: "unqualified",
      facts,
      mismatches: malformed,
      detail: "compatibility facts are not exact versioned identities",
    });
  }

  const expectedFacts = expected?.facts ?? expected;
  if (expectedFacts && !sameFacts(facts, expectedFacts)) {
    return blockedCompatibility({
      reason: "changed",
      facts,
      expected: expectedFacts,
      mismatches: factMismatches(facts, expectedFacts),
    });
  }

  if (
    observed?.qualified === false ||
    (observed?.status !== undefined && observed.status !== "qualified")
  ) {
    return blockedCompatibility({
      reason: "unqualified",
      facts,
      detail: observed.detail ?? "compatibility facts were not qualified",
    });
  }

  return deepFreeze({
    schema: COMPATIBILITY_SCHEMA,
    status: "qualified",
    reason: null,
    facts: deepFreeze(structuredClone(facts)),
    evidence_digest: digestCanonical(facts),
    legal_actions: [],
    upstream_gaps: UPSTREAM_GAPS,
  });
}

export function compatibilityFromTrace(
  trace,
  { harness = "codex", expected, adapter = REPLAY_ADAPTER_ID } = {},
) {
  return qualifyCompatibility(trace?.provenance?.compatibility, {
    expected,
    harness,
    adapter,
  });
}

export async function collectProductionCompatibility({
  harness = "codex",
  env = process.env,
  run = execute,
  expected,
} = {}) {
  const commandResults = await Promise.all([
    captureVersion("herdr", ["--version"], run, env),
    captureVersion(harness, ["--version"], run, env),
    captureVersion("herdr", ["integration", "status"], run, env, {
      firstLine: false,
    }),
  ]);
  const [herdrVersion, harnessVersion, integrations] = commandResults;
  const integration = parseIntegration(integrations.value, harness);
  const facts = {
    drovr: "drovr.semantic-harness/v1",
    herdr: herdrVersion.value,
    harness: harnessVersion.value,
    integration: integration.value,
    adapters: [
      PRODUCTION_ADAPTER_ID,
      `${harness}-jsonl/v1`,
    ],
    features: [...COMPATIBILITY_FEATURES],
  };
  const failures = [
    ...(!herdrVersion.value ? [{ fact: "herdr", detail: herdrVersion.detail }] : []),
    ...(!harnessVersion.value
      ? [{ fact: "harness", detail: harnessVersion.detail }]
      : []),
    ...(!integration.value
      ? [{ fact: "integration", detail: integration.detail }]
      : []),
  ];
  if (failures.length > 0) {
    return blockedCompatibility({
      reason: "missing",
      facts: partialFacts(facts),
      missing: failures,
    });
  }
  return qualifyCompatibility(
    { facts },
    { expected, harness, adapter: PRODUCTION_ADAPTER_ID },
  );
}

export function assertQualifiedCompatibility(compatibility) {
  if (compatibility?.status === "qualified") return compatibility;
  const error = new Error(
    `Drovr compatibility is ${compatibility?.reason ?? "unqualified"}`,
  );
  error.name = "CompatibilityBlockedError";
  error.outcome = "compatibility_blocked";
  error.code = 0;
  error.details = { compatibility };
  throw error;
}

function blockedCompatibility({
  reason,
  facts = null,
  expected,
  missing = [],
  mismatches = [],
  detail,
}) {
  return deepFreeze({
    schema: COMPATIBILITY_SCHEMA,
    status: "blocked",
    reason,
    facts: facts ? deepFreeze(structuredClone(facts)) : null,
    ...(expected ? { expected: deepFreeze(structuredClone(expected)) } : {}),
    ...(missing.length > 0 ? { missing: deepFreeze(structuredClone(missing)) } : {}),
    ...(mismatches.length > 0
      ? { mismatches: deepFreeze(structuredClone(mismatches)) }
      : {}),
    ...(detail ? { detail } : {}),
    evidence_digest: facts ? digestCanonical(facts) : null,
    legal_actions: legalActions(reason),
    upstream_gaps: UPSTREAM_GAPS,
  });
}

function legalActions(reason) {
  if (reason === "changed") {
    return ["refresh_compatibility", "retire_stale_launch"];
  }
  if (reason === "unqualified") {
    return ["qualify_compatibility", "run_drovr_doctor"];
  }
  return ["refresh_compatibility", "run_drovr_doctor"];
}

function missingFacts(facts, { harness, adapter }) {
  if (!isRecord(facts)) return REQUIRED_FACTS.map((fact) => ({ fact, reason: "missing" }));
  const missing = [];
  for (const fact of REQUIRED_FACTS) {
    const value = facts[fact];
    const collection = fact === "adapters" || fact === "features";
    if (
      collection
        ? !Array.isArray(value) ||
          value.length === 0 ||
          value.some((entry) => !nonEmptyString(entry))
        : !nonEmptyString(value)
    ) {
      missing.push({ fact, reason: "missing" });
    }
  }
  if (Array.isArray(facts.adapters) && !facts.adapters.includes(adapter)) {
    missing.push({ fact: "adapters", reason: `missing ${adapter}` });
  }
  if (Array.isArray(facts.adapters) && !facts.adapters.includes(`${harness}-jsonl/v1`)) {
    missing.push({ fact: "adapters", reason: `missing ${harness}-jsonl/v1` });
  }
  if (Array.isArray(facts.features)) {
    for (const feature of COMPATIBILITY_FEATURES) {
      if (!facts.features.includes(feature)) {
        missing.push({ fact: "features", reason: `missing ${feature}` });
      }
    }
  }
  return missing;
}

function factMismatches(actual, expected) {
  const keys = new Set([...Object.keys(actual ?? {}), ...Object.keys(expected ?? {})]);
  return [...keys]
    .filter((key) => !sameFacts(actual?.[key], expected?.[key]))
    .map((field) => ({ field, expected: expected?.[field], observed: actual?.[field] }));
}

function incompatibleFacts(facts, { harness }) {
  const expectedPrefix = `herdr-${harness}/v`;
  return typeof facts?.integration === "string" &&
      !facts.integration.startsWith(expectedPrefix)
    ? [{
        field: "integration",
        expected: `${expectedPrefix}*`,
        observed: facts.integration,
        reason: "unqualified",
      }]
    : [];
}

function malformedFacts(facts, { harness, adapter }) {
  const mismatches = [];
  const expectedAdapters = [adapter, `${harness}-jsonl/v1`];
  const expectedFeatures = [...COMPATIBILITY_FEATURES];
  if (facts.drovr !== "drovr.semantic-harness/v1") {
    mismatches.push({
      field: "drovr",
      expected: "drovr.semantic-harness/v1",
      observed: facts.drovr,
      reason: "unqualified",
    });
  }
  if (!/^herdr \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(facts.herdr)) {
    mismatches.push({
      field: "herdr",
      expected: "herdr <semver>",
      observed: facts.herdr,
      reason: "unqualified",
    });
  }
  const harnessVersionPattern = harness === "claude"
    ? /^\d+\.\d+\.\d+ \(Claude Code\)$/u
    : /^codex-cli \d+\.\d+\.\d+$/u;
  if (!harnessVersionPattern.test(facts.harness)) {
    mismatches.push({
      field: "harness",
      expected: harness === "claude"
        ? "<semver> (Claude Code)"
        : "codex-cli <semver>",
      observed: facts.harness,
      reason: "unqualified",
    });
  }
  if (!/^herdr-(?:claude|codex)\/v\d+$/u.test(facts.integration)) {
    mismatches.push({
      field: "integration",
      expected: "herdr-<harness>/v<integer>",
      observed: facts.integration,
      reason: "unqualified",
    });
  }
  if (!sameFacts(facts.adapters, expectedAdapters)) {
    mismatches.push({
      field: "adapters",
      expected: expectedAdapters,
      observed: facts.adapters,
      reason: "unqualified",
    });
  }
  if (!sameFacts(facts.features, expectedFeatures)) {
    mismatches.push({
      field: "features",
      expected: expectedFeatures,
      observed: facts.features,
      reason: "unqualified",
    });
  }
  return mismatches;
}

function sameFacts(left, right) {
  return digestCanonical(left) === digestCanonical(right);
}

async function captureVersion(command, args, run, env, { firstLine = true } = {}) {
  try {
    const output = await run(command, args, { env });
    const value = firstLine
      ? String(output).trim().split(/\r?\n/u)[0]
      : String(output).trim();
    return value
      ? { value, detail: value }
      : { value: null, detail: `${command} returned no version` };
  } catch (error) {
    return { value: null, detail: error.message };
  }
}

function parseIntegration(output, harness) {
  const match = String(output ?? "").match(
    new RegExp(`^${harness}: current \\(v(\\d+)\\)`, "mu"),
  );
  if (!match) {
    return {
      value: null,
      detail: `${harness} Herdr integration is not current`,
    };
  }
  return { value: `herdr-${harness}/v${match[1]}`, detail: match[0] };
}

function partialFacts(facts) {
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : nonEmptyString(value),
    ),
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized.length > 0 &&
    !/^(?:unavailable|not_applicable|drovr\.command\/v1)$/u.test(normalized);
}

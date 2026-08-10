import { digest } from "./canonical.mjs";

const TIME_FACT_KINDS = [
  "wall_clock",
  "suspend_excluding_monotonic",
  "boot",
  "clock_source",
];

const TIME_FACT_FIELDS = Object.freeze({
  wall_clock: [
    "schema",
    "kind",
    "value_ms",
    "uncertainty_ms",
    "clock_source_id",
  ],
  suspend_excluding_monotonic: [
    "schema",
    "kind",
    "value_ns",
    "uncertainty_ns",
    "clock_source_id",
  ],
  boot: ["schema", "kind", "boot_id"],
  clock_source: ["schema", "kind", "identity"],
});

const SUBJECT_GENERATION_FIELDS = [
  "schema",
  "contract",
  "subject_id",
  "generation",
  "fingerprint",
];

export function validateRebootFacts(timeFacts, subjectGenerations) {
  return validateTimeFacts(timeFacts) &&
    validateSubjectGenerations(subjectGenerations);
}

export function validateTimeFacts(timeFacts) {
  if (!Array.isArray(timeFacts)) return false;
  if (timeFacts.length === 0) return true;
  if (timeFacts.length !== TIME_FACT_KINDS.length) return false;
  const byKind = new Map();
  for (const fact of timeFacts) {
    if (!isRecord(fact) || fact.schema !== "flow.time-fact/v1" ||
        !TIME_FACT_KINDS.includes(fact.kind) || byKind.has(fact.kind) ||
        !hasExactKeys(fact, TIME_FACT_FIELDS[fact.kind])) {
      return false;
    }
    if (fact.kind === "wall_clock" &&
        (!Number.isSafeInteger(fact.value_ms) ||
          !Number.isSafeInteger(fact.uncertainty_ms) ||
          fact.uncertainty_ms < 0 ||
          !nonEmptyString(fact.clock_source_id))) {
      return false;
    }
    if (fact.kind === "suspend_excluding_monotonic" &&
        (!decimalString(fact.value_ns) ||
          !decimalString(fact.uncertainty_ns) ||
          !nonEmptyString(fact.clock_source_id))) {
      return false;
    }
    if (fact.kind === "boot" && !nonEmptyString(fact.boot_id)) return false;
    if (fact.kind === "clock_source" && !nonEmptyString(fact.identity)) {
      return false;
    }
    byKind.set(fact.kind, fact);
  }
  return TIME_FACT_KINDS.every((kind) => byKind.has(kind));
}

export function validateSubjectGenerations(subjectGenerations) {
  if (!Array.isArray(subjectGenerations)) return false;
  return subjectGenerations.every((subject) =>
    isRecord(subject) &&
    hasExactKeys(subject, SUBJECT_GENERATION_FIELDS) &&
    subject.schema === "flow.subject-generation/v1" &&
    nonEmptyString(subject.contract) &&
    nonEmptyString(subject.subject_id) &&
    Number.isSafeInteger(subject.generation) &&
    subject.generation >= 0 &&
    isDigest(subject.fingerprint));
}

export function canonicalizeTimeFacts(timeFacts) {
  return [...timeFacts].sort((left, right) => {
    const leftKind = TIME_FACT_KINDS.indexOf(left.kind);
    const rightKind = TIME_FACT_KINDS.indexOf(right.kind);
    if (leftKind !== rightKind) return leftKind - rightKind;
    return compareDigest(left, right);
  });
}

export function canonicalizeSubjectGenerations(subjectGenerations) {
  return [...subjectGenerations].sort(compareDigest);
}

export function evaluateRebootTimeFacts({
  currentBootId,
  elapsedSeconds,
  expectedFacts,
  maxElapsedSeconds,
  observedFacts,
}) {
  if (!validateTimeFacts(expectedFacts) || !validateTimeFacts(observedFacts)) {
    return false;
  }
  if (expectedFacts.length === 0 || observedFacts.length === 0) {
    return false;
  }
  const expected = byKind(expectedFacts);
  const observed = byKind(observedFacts);
  if (currentBootId !== undefined &&
      observed.boot.boot_id !== currentBootId) {
    return false;
  }
  if (expected.clock_source.identity !== observed.clock_source.identity ||
      expected.wall_clock.clock_source_id !== observed.wall_clock.clock_source_id ||
      expected.suspend_excluding_monotonic.clock_source_id !==
        observed.suspend_excluding_monotonic.clock_source_id) {
    return false;
  }

  const sameBoot = expected.boot.boot_id === observed.boot.boot_id;
  const unit = sameBoot ? 1_000_000_000n : 1_000n;
  const expectedValue = sameBoot
    ? BigInt(expected.suspend_excluding_monotonic.value_ns)
    : BigInt(expected.wall_clock.value_ms);
  const observedValue = sameBoot
    ? BigInt(observed.suspend_excluding_monotonic.value_ns)
    : BigInt(observed.wall_clock.value_ms);
  const expectedUncertainty = sameBoot
    ? BigInt(expected.suspend_excluding_monotonic.uncertainty_ns)
    : BigInt(expected.wall_clock.uncertainty_ms);
  const observedUncertainty = sameBoot
    ? BigInt(observed.suspend_excluding_monotonic.uncertainty_ns)
    : BigInt(observed.wall_clock.uncertainty_ms);
  const baseline = BigInt(elapsedSeconds) * unit;
  const lower = baseline + observedValue - observedUncertainty -
    expectedValue - expectedUncertainty;
  const upper = baseline + observedValue + observedUncertainty -
    expectedValue + expectedUncertainty;
  return upper <= BigInt(maxElapsedSeconds) * unit && lower <= upper;
}

function byKind(facts) {
  return Object.fromEntries(facts.map((fact) => [fact.kind, fact]));
}

function compareDigest(left, right) {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0;
}

function hasExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}

function isRecord(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function decimalString(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

import {
  effectClassPolicy,
  validateEffectObservation,
} from "./operation-effects.mjs";

const RECHECK_FIELDS = [
  "schema",
  "effect_id",
  "idempotency_key",
  "classification",
  "operation_contract",
  "recovery",
  "observed_status",
  "observation",
];

export function validateRebootEffectRechecks(rechecks, unresolvedEffects) {
  if (!Array.isArray(rechecks) || !Array.isArray(unresolvedEffects) ||
      rechecks.length !== unresolvedEffects.length) {
    return false;
  }
  const intents = new Map();
  for (const intent of unresolvedEffects) {
    if (!isRecord(intent) || !nonEmptyString(intent.effect_id) ||
        intents.has(intent.effect_id)) return false;
    intents.set(intent.effect_id, intent);
  }
  const seen = new Set();
  for (const recheck of rechecks) {
    if (!isRecord(recheck) || !hasExactKeys(recheck, RECHECK_FIELDS) ||
        recheck.schema !== "flow.reboot-effect-recheck/v1" ||
        seen.has(recheck.effect_id)) return false;
    const intent = intents.get(recheck.effect_id);
    if (!intent || recheck.idempotency_key !== intent.idempotency_key ||
        recheck.classification !== intent.classification ||
        recheck.operation_contract !== intent.operation_contract) {
      return false;
    }
    const policy = effectClassPolicy(intent.classification);
    const presence = validateEffectObservation(recheck.observation, intent);
    if (!policy ||
        recheck.recovery !== policy.recovery ||
        recheck.observed_status !== policy.observed_unresolved_status ||
        presence === "indeterminate" ||
        policy.requires_fresh_checkpoint && presence !== "present") {
      return false;
    }
    seen.add(recheck.effect_id);
  }
  return seen.size === intents.size;
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

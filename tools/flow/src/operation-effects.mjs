import { digest } from "./canonical.mjs";
import {
  hasPositiveProviderEvidence,
  hasRequiredProviderReceiptShape,
  isProviderReceiptEvidence,
  isCredentialShapedString,
  sanitizeProviderReceipt as sanitizeProviderReceiptEnvelopeValue,
  sanitizeProviderReceiptValue,
} from "./provider-receipt-sanitizers.mjs";

export {
  sanitizeProviderReceiptEnvelopeValue as sanitizeProviderReceipt,
};

const POLICIES = {
  read_only: {
    recovery: "repeat_exact",
    requires_observation: false,
    requires_fresh_checkpoint: false,
    can_repeat_across_epoch: true,
    observed_unresolved_status: "unresolved",
  },
  caller_idempotent: {
    recovery: "repeat_exact",
    requires_observation: false,
    requires_fresh_checkpoint: false,
    can_repeat_across_epoch: true,
    observed_unresolved_status: "unresolved",
  },
  reconcilable: {
    recovery: "reconcile",
    requires_observation: true,
    requires_fresh_checkpoint: false,
    can_repeat_across_epoch: false,
    observed_unresolved_status: "reconciling",
  },
  one_shot_uncertain: {
    recovery: "reconcile",
    requires_observation: true,
    requires_fresh_checkpoint: true,
    can_repeat_across_epoch: false,
    observed_unresolved_status: "uncertain",
  },
};

const REGISTERED_OPERATION_EXECUTION_OBSERVATION_SCHEMA =
  "flow.registered-operation-execution-observation/v1";
const EFFECT_RECEIPT_SCHEMA = "flow.effect-receipt/v1";
const EFFECT_RECEIPT_OUTCOMES = new Set([
  "not_created",
  "quarantined",
  "succeeded",
]);
export const RETRY_DELAY_OBSERVATION_SCHEMA =
  "flow.retry-delay-observation/v1";
export const MAX_RETRY_DELAY_MS = 86_400_000;


const EXECUTION_STATUS_TAXONOMY = new Map([
  ["provider_unavailable", ["provider_unavailable", "provider_unavailable"]],
  ["operation_provider_unavailable", ["provider_unavailable", "provider_unavailable"]],
  ["adapter_unavailable", ["operation_failure", "operation_failure"]],
  ["unavailable", ["operation_failure", "operation_failure"]],
  ["invalid_output", ["invalid_output", "invalid_output"]],
  ["invalid_operation_output", ["invalid_output", "invalid_output"]],
  ["invalid_effect_receipt", ["invalid_output", "invalid_effect_receipt"]],
  ["invalid_provider_receipt", ["invalid_output", "invalid_provider_receipt"]],
  ["still_running", ["still_running", "still_running"]],
  ["operation_still_running", ["still_running", "still_running"]],
  ["bounded_timeout", ["still_running", "still_running"]],
  ["uncertain_external_outcome", ["uncertain_external_outcome", "uncertain_external_outcome"]],
  ["uncertain", ["uncertain_external_outcome", "uncertain_external_outcome"]],
  ["operation_uncertain", ["uncertain_external_outcome", "uncertain_external_outcome"]],
  ["operation_failure", ["operation_failure", "operation_failure"]],
]);
const EXECUTION_PUBLIC_STATUSES = new Set(
  [...EXECUTION_STATUS_TAXONOMY.values()].map(([status]) => status),
);
const EXECUTION_PUBLIC_DIAGNOSTIC_CODES = new Set(
  [...EXECUTION_STATUS_TAXONOMY.values()].map(([, code]) => code),
);

export const EFFECT_CLASS_POLICIES = Object.freeze(Object.fromEntries(
  Object.entries(POLICIES).map(([classification, policy]) => [
    classification,
    Object.freeze(policy),
  ]),
));

export function effectClassPolicy(classification) {
  return EFFECT_CLASS_POLICIES[classification] ?? null;
}

export function registeredOperation(registrations, contract) {
  if (registrations === null) return null;
  if (registrations instanceof Map) return registrations.get(contract);
  return Object.hasOwn(registrations ?? {}, contract)
    ? registrations[contract]
    : undefined;
}

export function hasRegisteredOperation(registrations, contract) {
  return Boolean(registeredOperation(registrations, contract));
}

export function snapshotRegisteredOperations(registrations) {
  const entries = registrations instanceof Map
    ? registrations.entries()
    : Object.entries(registrations);
  return new Map([...entries].flatMap(([contract, registration]) => {
    if (!registration) return [];
    return [[contract, Object.freeze({
      classification: registration.classification,
      invoke: typeof registration.invoke === "function"
        ? registration.invoke.bind(registration)
        : registration.invoke,
      observe: typeof registration.observe === "function"
        ? registration.observe.bind(registration)
        : registration.observe,
      sanitizeProviderObservation:
        typeof registration.sanitizeProviderObservation === "function"
          ? registration.sanitizeProviderObservation.bind(registration)
          : registration.sanitizeProviderObservation,
      sanitizeProviderReceipt:
        typeof registration.sanitizeProviderReceipt === "function"
          ? registration.sanitizeProviderReceipt.bind(registration)
          : registration.sanitizeProviderReceipt,
      validateCard: typeof registration.validateCard === "function"
        ? registration.validateCard.bind(registration)
        : registration.validateCard,
      provider_receipt_validator: registration.provider_receipt_validator,
      validateReceipt: typeof registration.validateReceipt === "function"
        ? registration.validateReceipt.bind(registration)
        : registration.validateReceipt,
    })]];
  }));
}

export function operationRegistrationIssue(
  registration,
  classification,
  providerReceiptValidator,
) {
  if (!registration) return "unregistered_operation_contract";
  const policy = effectClassPolicy(registration.classification);
  if (typeof registration.invoke !== "function" || !policy ||
      policy.requires_observation && typeof registration.observe !== "function") {
    return "incomplete_operation_registration";
  }
  if (providerReceiptValidator !== undefined &&
      (registration.provider_receipt_validator !== providerReceiptValidator ||
       typeof registration.validateReceipt !== "function")) {
    return "incomplete_provider_receipt_validator";
  }
  return registration.classification === classification
    ? null
    : "invalid_effect_classification";
}

export function dispatchRegisteredEffect(
  intent,
  registrations,
  runAuthority,
  { recovery = null } = {},
) {
  const registration = registeredOperation(
    registrations,
    intent.operation_contract,
  );
  const policy = effectClassPolicy(intent.classification);
  // FlowRuntime preflights every intent-emitting command. Keep this guard as a
  // final defense against a non-conforming authority-supplied intent.
  if (!registration || !policy || typeof runAuthority.invokeEffect !== "function" ||
      registration.classification !== intent.classification ||
      typeof registration.invoke !== "function") return;
  void (async () => {
    if (recovery === "settle_cancelled") {
      if (!policy.requires_observation) return;
      const observation = await observeRegisteredEffect(
        intent,
        registration,
        runAuthority,
      );
      const presence = validateEffectObservation(observation, intent);
      if (presence === "present") {
        return runAuthority.invokeEffect(intent, {
          reconciliation: "adopt_present",
        });
      }
      if (presence === "absent") {
        return runAuthority.invokeEffect(intent, {
          reconciliation: "settle_absent",
        });
      }
      return undefined;
    }
    if (recovery && policy.requires_observation) {
      const observation = await observeRegisteredEffect(
        intent,
        registration,
        runAuthority,
      );
      const presence = validateEffectObservation(observation, intent);
      if (presence === "present") {
        return runAuthority.invokeEffect(intent, {
          reconciliation: "adopt_present",
        });
      }
      if (presence !== "absent" ||
          intent.classification === "one_shot_uncertain") return;
      return runAuthority.invokeEffect(intent, {
        reconciliation: "invoke_absent",
        operatorRecovery: true,
        async invoke(effectiveIntent) {
          return invokeRegisteredOperation(
            effectiveIntent,
            registration,
          );
        },
      });
    }
    return runAuthority.invokeEffect(intent, {
      operatorRecovery: recovery !== null,
      async invoke(effectiveIntent) {
        return invokeRegisteredOperation(effectiveIntent, registration);
      },
    });
  })().catch(() => {});
}

async function observeRegisteredEffect(intent, registration, runAuthority) {
  try {
    const observed = await registration.observe?.(intent);
    return await runAuthority.recordEffectObservation?.(
      intent,
      sanitizeRegisteredObservation(observed, intent, registration),
    );
  } catch (error) {
    try {
      return await runAuthority.recordEffectObservation?.(
        intent,
        effectObservationForExecutionFailure(intent, error, registration),
      );
    } catch {
      return undefined;
    }
  }
}

function sanitizeRegisteredObservation(observation, intent, registration) {
  if (!isRecord(observation) ||
      !Object.hasOwn(observation, "provider_observation")) {
    return observation;
  }
  return {
    ...observation,
    provider_observation: safeProviderObservation(
      observation.provider_observation,
      registration,
      intent,
    ),
  };
}

async function invokeRegisteredOperation(intent, registration) {
  try {
    const receipt = await registration.invoke(intent);
    assertEffectReceipt(receipt, intent);
    assertProviderReceipt(receipt, intent, registration);
    return sanitizeRegisteredReceipt(receipt, intent, registration);
  } catch (error) {
    const observation = registeredOperationExecutionObservation(
      intent,
      error,
      registration,
      { postDispatch: true },
    );
    const wrapped = new Error("registered operation failed");
    Object.defineProperty(wrapped, "provider_observation", {
      configurable: false,
      enumerable: false,
      value: observation,
      writable: false,
    });
    throw wrapped;
  }
}

function sanitizeRegisteredReceipt(receipt, intent, registration) {
  const sanitized = sanitizeEffectReceiptEnvelope(
    receipt,
    intent,
    registration,
  );
  if (sanitized === null) {
    const error = new Error("registered operation returned an unsafe provider receipt");
    error.code = "invalid_provider_receipt";
    throw error;
  }
  return sanitized;
}

function effectObservationForExecutionFailure(intent, error, registration) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: registeredOperationExecutionObservation(
      intent,
      error,
      registration,
      { postDispatch: false },
    ),
  };
}

function registeredOperationExecutionObservation(
  intent,
  error,
  registration,
  { postDispatch = false } = {},
) {
  const status = executionObservationStatus(error, intent, { postDispatch });
  const retry = retryDelayObservation(error);
  const providerObservation = safeProviderObservation(
    error?.provider_observation,
    registration,
    intent,
  );
  const publicProviderFields = publicProviderObservationFields(
    providerObservation,
  );
  return {
    schema: REGISTERED_OPERATION_EXECUTION_OBSERVATION_SCHEMA,
    run_id: intent.run_id,
    card_id: intent.card_id ?? null,
    attempt_id: intent.attempt_id,
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    status,
    diagnostic: {
      code: safeDiagnosticCode(error?.code, status),
      reason: status,
      redacted: true,
    },
    ...publicProviderFields,
    provider_observation_present: error?.provider_observation !== undefined &&
      error?.provider_observation !== null,
    ...(providerObservation === null ? {} : {
      provider_detail: providerObservation,
    }),
    ...(retry === null ? {} : { retry }),
  };
}

function publicProviderObservationFields(value) {
  if (!isRecord(value)) return {};
  const result = {};
  if (safeProviderString(value.code)) result.code = value.code;
  if (safeProviderString(value.provider_error_code)) {
    result.provider_error_code = value.provider_error_code;
  }
  if (safeProviderString(value.reason)) result.reason = value.reason;
  if (typeof value.complete === "boolean") result.complete = value.complete;
  if (typeof value.found === "boolean") result.found = value.found;
  if (safeProviderString(value.proof)) result.proof = value.proof;
  if (safeProviderString(value.rejection_code)) {
    result.rejection_code = value.rejection_code;
  }
  for (const key of ["matching_review_count", "pending_review_count"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) {
      result[key] = value[key];
    }
  }
  return result;
}

function safeProviderObservation(value, registration = null, intent = null) {
  if (!isRecord(value)) return null;
  if (typeof registration?.sanitizeProviderObservation === "function") {
    try {
      const sanitized = registration.sanitizeProviderObservation(value, intent);
      return isRecord(sanitized) && canonicalValue(sanitized)
        ? sanitizeProviderEvidence(sanitized, intent)
        : null;
    } catch {
      return null;
    }
  }
  return sanitizeProviderObservation(value, intent);
}

function redactedHistoricalProviderReceipt(value) {
  const sourceSchema = isRecord(value) &&
    typeof value.schema === "string" &&
    /^flow\.[A-Za-z0-9._/-]+\/v[0-9]+$/u.test(value.schema)
    ? value.schema
    : null;
  return {
    schema: "flow.provider-receipt-redacted/v1",
    status: "redacted",
    reason: "provider_receipt_redacted",
    ...(sourceSchema === null ? {} : { original_schema: sourceSchema }),
  };
}

function safeProviderReceipt(value, registration = null, intent = null) {
  if (!isRecord(value)) return null;
  if (typeof registration?.sanitizeProviderReceipt === "function") {
    try {
      const sanitized = registration.sanitizeProviderReceipt(value, intent);
      return isRecord(sanitized) && canonicalValue(sanitized)
        ? sanitizeProviderReceiptValue(sanitized)
        : null;
    } catch {
      return null;
    }
  }
  return sanitizeProviderReceiptValue(value);
}

export function sanitizeEffectReceiptEnvelope(
  value,
  intent = null,
  registration = null,
) {
  if (!isRecord(value) || value.schema !== EFFECT_RECEIPT_SCHEMA ||
      !EFFECT_RECEIPT_OUTCOMES.has(value.outcome) ||
      !Object.hasOwn(value, "provider_receipt") ||
      intent !== null && (
        value.effect_id !== intent.effect_id ||
        value.idempotency_key !== intent.idempotency_key
      )) {
    return null;
  }
  const providerReceipt = safeProviderReceipt(
    value.provider_receipt,
    registration,
    intent,
  );
  if (!hasRequiredProviderReceiptShape(
    value.provider_receipt,
    providerReceipt,
    value.outcome,
  ) || (!hasPositiveProviderEvidence(providerReceipt) &&
      !(value.outcome === "not_created" &&
        hasAffirmativeProviderObservation(providerReceipt, "absent")))) {
    return null;
  }
  return {
    schema: EFFECT_RECEIPT_SCHEMA,
    effect_id: value.effect_id,
    idempotency_key: value.idempotency_key,
    outcome: value.outcome,
    provider_receipt: providerReceipt,
  };
}

export function sanitizeProviderObservation(value, intent = null) {
  if (!isRecord(value)) return null;
  return genericSafeProviderObservation(value, intent);
}

// One dispatcher keeps provider evidence consistent at authority write time,
// reconciliation/adoption, and historical replay.  Receipt-shaped
// observations retain their approved provider fields; ordinary observations
// use the conservative status/evidence envelope below.
export function sanitizeProviderEvidence(value, intent = null) {
  if (!isRecord(value)) return null;
  return isProviderReceiptEvidence(value)
    ? sanitizeProviderReceiptValue(value)
    : sanitizeProviderObservation(value, intent);
}

function genericSafeProviderObservation(value, intent = null) {
  if (value?.schema === REGISTERED_OPERATION_EXECUTION_OBSERVATION_SCHEMA) {
    return sanitizeRegisteredExecutionObservation(value, intent);
  }
  const safeKeys = new Set([
    "authority_watermark",
    "code",
    "child_phase",
    "child_run_id",
    "child_watermark",
    "complete",
    "diagnostic",
    "found",
    "matching_review_count",
    "pending_review_count",
    "provider_error_code",
    "proof",
    "provider_id",
    "record",
    "rejection_code",
    "reason",
    "retry",
    "schema",
    "status",
    "system",
  ]);
  const result = {};
  for (const key of safeKeys) {
    const candidate = value[key];
    if (key === "schema" && typeof candidate === "string" &&
        /^flow\.[A-Za-z0-9._/-]+\/v[0-9]+$/.test(candidate)) {
      result[key] = candidate;
    } else if (key === "diagnostic" && isRecord(candidate)) {
      const diagnostic = {};
      if (safeProviderString(candidate.code)) diagnostic.code = candidate.code;
      if (safeProviderString(candidate.reason)) {
        diagnostic.reason = candidate.reason;
      }
      if (typeof candidate.redacted === "boolean") {
        diagnostic.redacted = candidate.redacted;
      }
      if (Object.keys(diagnostic).length > 0) result[key] = diagnostic;
    } else if (key === "retry" && candidate !== undefined) {
      result[key] = sanitizeRetryObservation(candidate);
    } else if (["code", "provider_error_code", "reason"].includes(key) &&
        safeProviderString(candidate)) {
      result[key] = candidate;
    } else if (["complete", "found"].includes(key) &&
        typeof candidate === "boolean") {
      result[key] = candidate;
    } else if ([
      "authority_watermark",
      "child_run_id",
      "child_phase",
      "child_watermark",
      "proof",
      "provider_id",
      "record",
      "rejection_code",
      "reason",
      "status",
      "system",
    ].includes(key) && safeProviderString(candidate)) {
      result[key] = candidate;
    } else if (["matching_review_count", "pending_review_count"].includes(key) &&
        Number.isSafeInteger(candidate) && candidate >= 0) {
      result[key] = candidate;
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}

function sanitizeRegisteredExecutionObservation(value, intent) {
  const status = EXECUTION_PUBLIC_STATUSES.has(value.status)
    ? value.status
    : "operation_failure";
  const diagnostic = isRecord(value.diagnostic)
    ? {
        code: EXECUTION_PUBLIC_DIAGNOSTIC_CODES.has(value.diagnostic.code)
          ? value.diagnostic.code
          : status,
        reason: status,
        redacted: true,
      }
    : {
        code: status,
        reason: status,
        redacted: true,
      };
  const result = {
    schema: REGISTERED_OPERATION_EXECUTION_OBSERVATION_SCHEMA,
    run_id: intent?.run_id ?? value.run_id ?? null,
    card_id: intent?.card_id ?? value.card_id ?? null,
    attempt_id: intent?.attempt_id ?? value.attempt_id ?? null,
    effect_id: intent?.effect_id ?? value.effect_id ?? null,
    idempotency_key: intent?.idempotency_key ?? value.idempotency_key ?? null,
    status,
    diagnostic,
    ...publicProviderObservationFields(value),
    provider_observation_present: value.provider_observation_present === true,
    ...(value.provider_detail === undefined ? {} : {
      provider_detail: sanitizeProviderObservation(value.provider_detail, intent),
    }),
    ...(value.retry === undefined ? {} : {
      retry: sanitizeRetryObservation(value.retry),
    }),
  };
  return result;
}

function sanitizeRetryObservation(value) {
  if (!isRecord(value) || value.schema !== RETRY_DELAY_OBSERVATION_SCHEMA ||
      !["bounded", "invalid"].includes(value.status)) {
    return { schema: RETRY_DELAY_OBSERVATION_SCHEMA, status: "invalid" };
  }
  return value.status === "bounded" && Number.isSafeInteger(value.delay_ms) &&
      value.delay_ms >= 0 && value.delay_ms <= MAX_RETRY_DELAY_MS
    ? {
        schema: RETRY_DELAY_OBSERVATION_SCHEMA,
        status: "bounded",
        delay_ms: value.delay_ms,
      }
    : { schema: RETRY_DELAY_OBSERVATION_SCHEMA, status: "invalid" };
}

function safeProviderString(value) {
  return typeof value === "string" && value.length > 0 &&
    !isCredentialShapedString(value);
}

function retryDelayObservation(error) {
  const providerObservation = error?.provider_observation;
  const candidate = error?.retry_after_ms ??
    providerObservation?.retry_after_ms;
  const hasCandidate = candidate !== undefined ||
    Object.hasOwn(error ?? {}, "retry_after_ms") ||
    Object.hasOwn(providerObservation ?? {}, "retry_after_ms");
  if (!hasCandidate) return null;
  if (Number.isSafeInteger(candidate) && candidate >= 0 &&
      candidate <= MAX_RETRY_DELAY_MS) {
    return {
      schema: RETRY_DELAY_OBSERVATION_SCHEMA,
      status: "bounded",
      delay_ms: candidate,
    };
  }
  return {
    schema: RETRY_DELAY_OBSERVATION_SCHEMA,
    status: "invalid",
  };
}

function executionObservationStatus(error, intent, { postDispatch = false } = {}) {
  const candidates = [
    error?.execution_status,
    error?.status,
    error?.code,
    error?.provider_observation?.status,
  ];
  for (const candidate of candidates) {
    const status = EXECUTION_STATUS_TAXONOMY.get(candidate)?.[0];
    if (status !== undefined) return status;
  }
  if (error?.execution_status !== undefined ||
      error?.status !== undefined ||
      error?.code !== undefined) {
    return "operation_failure";
  }
  if (error?.provider_observation !== undefined) {
    return "uncertain_external_outcome";
  }
  if (postDispatch && effectClassPolicy(intent?.classification)?.requires_observation) {
    return "uncertain_external_outcome";
  }
  return "operation_failure";
}

function safeDiagnosticCode(code, fallback) {
  return EXECUTION_STATUS_TAXONOMY.get(code)?.[1] ?? fallback;
}

export function normalizeEffectObservation(observation, intent) {
  const presence = observationPresence(observation, intent, { exact: false });
  const providerObservation = canonicalValue(observation?.provider_observation)
    ? observation.provider_observation
    : null;
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence,
    causation: presence === "present" ? {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    } : null,
    provider_observation: providerObservation,
  };
}

export function validateEffectObservation(observation, intent) {
  return observationPresence(observation, intent, { exact: true });
}

function observationPresence(observation, intent, { exact }) {
  if (observation?.schema !== "flow.effect-observation/v1" ||
      observation.effect_id !== intent.effect_id ||
      observation.idempotency_key !== intent.idempotency_key ||
      !["present", "absent", "indeterminate"].includes(
        observation.presence,
      ) || exact && !hasExactKeys(observation, [
        "schema",
        "effect_id",
        "idempotency_key",
        "presence",
        "causation",
        "provider_observation",
      ]) || !canonicalValue(observation.causation) ||
      !isRecord(observation.provider_observation)) {
    return "indeterminate";
  }
  if (observation.presence === "present" &&
      (exact && !hasExactKeys(
        observation.causation,
        ["effect_id", "idempotency_key"],
      ) ||
       observation.causation?.effect_id !== intent.effect_id ||
       observation.causation?.idempotency_key !== intent.idempotency_key ||
       !hasObservationEvidence(observation.provider_observation, "present"))) {
    return "indeterminate";
  }
  if (observation.presence === "absent" &&
      (!hasObservationEvidence(observation.provider_observation, "absent") ||
       observation.causation !== null)) {
    return "indeterminate";
  }
  return observation.presence;
}

function hasObservationEvidence(providerObservation, presence) {
  if (!isRecord(providerObservation)) return false;
  if (presence === "present") return hasPositiveProviderEvidence(providerObservation);
  if (providerObservation.found === false) return true;
  if (Number.isSafeInteger(providerObservation.matching_review_count) &&
      providerObservation.matching_review_count === 0) return true;
  return Object.entries(providerObservation)
    .filter(([key]) => key !== "schema")
    .some(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.length > 0;
      if (Array.isArray(value)) return value.some((candidate) =>
        candidate !== null && candidate !== undefined &&
        hasPositiveProviderEvidence(candidate));
      if (isRecord(value)) return hasPositiveProviderEvidence(value);
      if (typeof value === "number") {
        return Number.isFinite(value) && value > 0;
      }
      return value === true;
    });
}

export function hasAffirmativeProviderObservation(providerObservation, presence) {
  return hasObservationEvidence(providerObservation, presence);
}

export function sanitizeHistoricalEffectReceiptEnvelope(value, intent = null) {
  if (!isRecord(value) || value.schema !== EFFECT_RECEIPT_SCHEMA ||
      !EFFECT_RECEIPT_OUTCOMES.has(value.outcome) ||
      !Object.hasOwn(value, "provider_receipt") ||
      intent !== null && (
        value.effect_id !== intent.effect_id ||
        value.idempotency_key !== intent.idempotency_key
      )) {
    return null;
  }
  const providerReceipt = sanitizeProviderEvidence(
    value.provider_receipt,
    intent,
  );
  const acceptable = providerReceipt !== null &&
    (hasPositiveProviderEvidence(providerReceipt) ||
      value.outcome === "not_created" &&
        hasAffirmativeProviderObservation(providerReceipt, "absent"));
  return {
    schema: EFFECT_RECEIPT_SCHEMA,
    effect_id: value.effect_id,
    idempotency_key: value.idempotency_key,
    outcome: value.outcome,
    provider_receipt: acceptable
      ? providerReceipt
      : redactedHistoricalProviderReceipt(value.provider_receipt),
  };
}

function canonicalValue(value) {
  try {
    digest(value);
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function assertEffectReceipt(receipt, intent) {
  if (receipt?.schema !== "flow.effect-receipt/v1" ||
      receipt.effect_id !== intent.effect_id ||
      receipt.idempotency_key !== intent.idempotency_key ||
      receipt.outcome !== "succeeded" ||
      receipt.provider_receipt === undefined) {
    const error = new Error("registered operation returned an invalid effect receipt");
    error.code = "invalid_effect_receipt";
    throw error;
  }
}

function assertProviderReceipt(receipt, intent, registration) {
  const validatorContract = intent.operation_input?.provider_receipt_validator;
  if (validatorContract === undefined) return;
  if (registration.provider_receipt_validator !== validatorContract ||
      typeof registration.validateReceipt !== "function" ||
      registration.validateReceipt(receipt.provider_receipt, intent) !== true) {
    const error = new Error("registered operation provider receipt failed validation");
    error.code = "invalid_provider_receipt";
    throw error;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

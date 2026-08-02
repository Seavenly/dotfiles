import { digest } from "./canonical.mjs";

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
      validateCard: typeof registration.validateCard === "function"
        ? registration.validateCard.bind(registration)
        : registration.validateCard,
    })]];
  }));
}

export function operationRegistrationIssue(registration, classification) {
  if (!registration) return "unregistered_operation_contract";
  const policy = effectClassPolicy(registration.classification);
  if (typeof registration.invoke !== "function" || !policy ||
      policy.requires_observation && typeof registration.observe !== "function") {
    return "incomplete_operation_registration";
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
      const observed = await registration.observe?.(intent);
      const observation = await runAuthority.recordEffectObservation?.(
        intent,
        observed,
      );
      if (validateEffectObservation(observation, intent) !== "present") return;
      return runAuthority.invokeEffect(intent, {
        reconciliation: "adopt_present",
      });
    }
    if (recovery && policy.requires_observation) {
      const observed = await registration.observe?.(intent);
      const observation = await runAuthority.recordEffectObservation?.(
        intent,
        observed,
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
        async invoke(effectiveIntent) {
          const receipt = await registration.invoke(effectiveIntent);
          assertEffectReceipt(receipt, effectiveIntent);
          return receipt;
        },
      });
    }
    return runAuthority.invokeEffect(intent, {
      async invoke(effectiveIntent) {
        const receipt = await registration.invoke(effectiveIntent);
        assertEffectReceipt(receipt, effectiveIntent);
        return receipt;
      },
    });
  })().catch(() => {});
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
      !canonicalValue(observation.provider_observation)) {
    return "indeterminate";
  }
  if (observation.presence === "present" &&
      (exact && !hasExactKeys(
        observation.causation,
        ["effect_id", "idempotency_key"],
      ) ||
       observation.causation?.effect_id !== intent.effect_id ||
       observation.causation?.idempotency_key !== intent.idempotency_key ||
       !isRecord(observation.provider_observation) ||
       Object.keys(observation.provider_observation).length === 0)) {
    return "indeterminate";
  }
  if (observation.presence === "absent" &&
      (!isRecord(observation.provider_observation) ||
       Object.keys(observation.provider_observation).length === 0 ||
       observation.causation !== null)) {
    return "indeterminate";
  }
  return observation.presence;
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

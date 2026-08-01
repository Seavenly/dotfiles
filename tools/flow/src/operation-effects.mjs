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
  return registeredOperation(registrations, contract) !== undefined;
}

export function dispatchRegisteredEffect(
  intent,
  registrations,
  runAuthority,
  { recovery = false } = {},
) {
  const registration = registeredOperation(
    registrations,
    intent.operation_contract,
  );
  const policy = effectClassPolicy(intent.classification);
  if (!registration || !policy || typeof runAuthority.invokeEffect !== "function" ||
      registration.classification !== intent.classification ||
      typeof registration.invoke !== "function") return;
  void runAuthority.invokeEffect(intent, {
    reconcile: recovery && policy.requires_observation,
    async invoke(effectiveIntent) {
      if (recovery && policy.requires_observation) {
        const observed = await registration.observe?.(effectiveIntent);
        const observation = normalizeEffectObservation(observed, effectiveIntent);
        await runAuthority.recordEffectObservation?.(
          effectiveIntent,
          observation,
        );
        const presence = validateEffectObservation(observation, effectiveIntent);
        if (presence === "present") {
          return {
            schema: "flow.effect-receipt/v1",
            effect_id: effectiveIntent.effect_id,
            idempotency_key: effectiveIntent.idempotency_key,
            outcome: "succeeded",
            provider_receipt: observation.provider_observation,
          };
        }
        if (presence !== "absent" ||
            effectiveIntent.classification === "one_shot_uncertain") {
          const error = new Error("effect observation does not authorize invocation");
          error.code = "effect_presence_indeterminate";
          throw error;
        }
      }
      const receipt = await registration.invoke(effectiveIntent);
      assertEffectReceipt(receipt, effectiveIntent);
      return receipt;
    },
  }).catch(() => {});
}

function normalizeEffectObservation(observation, intent) {
  if (validateEffectObservation(observation, intent) !== "indeterminate" ||
      observation?.schema === "flow.effect-observation/v1" &&
      observation.effect_id === intent.effect_id &&
      observation.idempotency_key === intent.idempotency_key &&
      observation.presence === "indeterminate" &&
      observation.provider_observation !== undefined) {
    return observation;
  }
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: null,
  };
}

function validateEffectObservation(observation, intent) {
  if (observation?.schema !== "flow.effect-observation/v1" ||
      observation.effect_id !== intent.effect_id ||
      observation.idempotency_key !== intent.idempotency_key ||
      !["present", "absent", "indeterminate"].includes(
        observation.presence,
      ) || observation.provider_observation === undefined) {
    return "indeterminate";
  }
  if (observation.presence === "present" &&
      (observation.causation?.effect_id !== intent.effect_id ||
       observation.causation?.idempotency_key !== intent.idempotency_key)) {
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

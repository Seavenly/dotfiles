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
  void (async () => {
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

export function validateEffectObservation(observation, intent) {
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

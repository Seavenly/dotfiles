import { digest, freezeCanonical } from "./canonical.mjs";
import {
  featureConformanceFindings,
  loadRequiredDrovrFeatures,
  RequiredDrovrFeatureContractError,
} from "./required-drovr-features.mjs";
const REQUIRED_PORT_OPERATIONS = [
  "describe",
  "dispatch",
  "discover",
  "send",
  "observe",
  "wait",
  "cancel",
  "reconcile",
  "retire",
];

export function snapshotDelegatedAgentPort(port) {
  if (port === null) return null;
  return Object.freeze({
    contract: port?.contract,
    ...Object.fromEntries(REQUIRED_PORT_OPERATIONS.map((operation) => [
      operation,
      typeof port?.[operation] === "function"
        ? port[operation].bind(port)
        : port?.[operation],
    ])),
  });
}

export function snapshotRequiredDrovrFeatures(options) {
  try {
    return Object.freeze({
      features: loadRequiredDrovrFeatures(options),
      issue: null,
    });
  } catch (error) {
    return Object.freeze({
      features: null,
      issue: error instanceof RequiredDrovrFeatureContractError
        ? error.code
        : "required_feature_contract_unavailable",
    });
  }
}

export function snapshotDelegateOutputValidators(validators) {
  if (validators === null || typeof validators !== "object" ||
      Array.isArray(validators)) {
    throw new TypeError("delegateOutputValidators must be an object or Map");
  }
  const entries = validators instanceof Map
    ? validators.entries()
    : Object.entries(validators);
  return new Map([...entries].map(([contract, registration]) => [
    contract,
    Object.freeze({
      validate: typeof registration?.validate === "function"
        ? registration.validate.bind(registration)
        : registration?.validate,
    }),
  ]));
}

export function delegateCompatibilityIssue(
  card,
  port,
  validators,
  requiredFeatureSnapshot,
) {
  if (port?.contract !== "flow.delegated-agent-port/v1" ||
      !REQUIRED_PORT_OPERATIONS.every(
        (operation) => typeof port?.[operation] === "function")) {
    return "delegated_agent_port_unavailable";
  }
  if (requiredFeatureSnapshot?.issue) {
    return requiredFeatureSnapshot.issue;
  }
  const requiredFeatures = requiredFeatureSnapshot?.features;
  if (!Array.isArray(requiredFeatures)) {
    return "required_feature_contract_unavailable";
  }
  const descriptions = [
    card.inputs.description,
    ...(card.inputs.fallback ? [card.inputs.fallback.description] : []),
  ];
  if (descriptions.some((description) => featureConformanceFindings(
    description,
    requiredFeatures,
  ).length > 0)) {
    return "incompatible_feature_advertisement";
  }
  if (card.validators.some((contract) =>
    typeof validators.get(contract)?.validate !== "function")) {
    return "unregistered_delegate_validator";
  }
  return null;
}

export function dispatchDelegateEffect(
  intent,
  port,
  validators,
  runAuthority,
  { settleCancelled = false } = {},
) {
  if (!["delegate", "delegate_cancellation"].includes(intent.effect_kind) ||
      typeof runAuthority.invokeEffect !== "function") return;
  void runAuthority.invokeEffect(intent, {
    settleCancelled,
    async invoke(effectiveIntent) {
      return settleCancelled
        ? effectiveIntent.effect_kind === "delegate_cancellation"
          ? executeDelegateCancellation(effectiveIntent, port)
          : executeCancelledDelegate(effectiveIntent, port)
        : executeDelegate(effectiveIntent, port, validators);
    },
  }).then(() => {
    if (intent.effect_kind !== "delegate_cancellation") return;
    const action = runAuthority.query(intent.run_id)?.legal_actions?.find(
      (candidate) => candidate.type === "recovery" &&
        candidate.effect_id === intent.delegate_effect_id);
    if (!action) return;
    const receipt = runAuthority.command(action);
    for (const recoveryIntent of receipt?.effect_intents ?? []) {
      dispatchDelegateEffect(
        recoveryIntent,
        port,
        validators,
        runAuthority,
        { settleCancelled: true },
      );
    }
  }).catch(async (error) => {
    if (error?.code !== "delegated_runtime_unresolved" ||
        typeof runAuthority.recordEffectObservation !== "function") return;
    try {
      await runAuthority.recordEffectObservation(intent, {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "indeterminate",
        causation: null,
        provider_observation: error.projection ?? null,
      });
    } catch {
      // A concurrent settlement or terminal fence owns the newer truth.
    }
  });
}

async function executeDelegateCancellation(intent, port) {
  const current = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: intent.delegate_attempt_id,
  });
  if (current.status !== "proven_absent" && !current.turn?.id) {
    throw delegatedRuntimeError(current);
  }
  if (current.turn?.id &&
      current.delegation?.agent_id !== intent.route_binding.agent_id) {
    throw delegatedRuntimeError(current);
  }
  let turnDisposition = null;
  if (current.turn?.status === "working") {
    turnDisposition = await port.cancel({
      schema: "flow.delegated-agent-cancel-request/v1",
      turn_id: current.turn.id,
    });
    const expectedAgentId = intent.route_binding.agent_id;
    if (!provesClosedTurn(turnDisposition, expectedAgentId, current.turn.id)) {
      throw delegatedRuntimeError(turnDisposition);
    }
  }
  const agentId = intent.route_binding.agent_id;
  return freezeCanonical({
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: {
      schema: "flow.delegate-cancellation-receipt/v1",
      delegate_attempt_id: intent.delegate_attempt_id,
      delegate_effect_id: intent.delegate_effect_id,
      turn_id: current.turn?.id ?? null,
      drovr_watermark: current.watermark ?? null,
      terminal_disposition: {
        schema: "flow.resource-handoff/v1",
        resource: { type: "drovr_agent", id: agentId },
        durable_holder: "drovr.registry",
        reason: "cancelled_delegate_settlement",
        attempt_id: intent.delegate_attempt_id,
        ...(turnDisposition ? { turn_disposition: turnDisposition } : {}),
      },
    },
  });
}

async function executeCancelledDelegate(intent, port) {
  const current = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: intent.attempt_id,
  });
  if (current.status !== "proven_absent" && !current.turn?.id) {
    throw delegatedRuntimeError(current);
  }
  if (current.turn?.id &&
      current.delegation?.agent_id !== intent.route_binding.agent_id) {
    throw delegatedRuntimeError(current);
  }
  if (current.turn?.status === "working") {
    throw delegatedRuntimeError(current);
  }
  const receipt = freezeCanonical({
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "quarantined",
    provider_receipt: {
      schema: "flow.delegate-quarantine/v1",
      attempt_id: intent.attempt_id,
      card_id: intent.card_id,
      turn_id: current.turn?.id ?? null,
      drovr_watermark: current.watermark ?? null,
      route_binding: intent.route_binding,
      settlement_proof: current.turn?.settlement_proof ?? null,
      validator_receipts: [],
      quarantine_reason: "run_cancelled",
      correlated_output: current.turn?.late_result?.text ??
        current.turn?.result?.text ?? null,
    },
  });
  return settleTerminalDisposition({
    current,
    forceRetirement: true,
    intent,
    port,
    receipt,
  });
}

async function executeDelegate(intent, port, validators) {
  const callerKey = intent.attempt_id;
  const inputKey = `${callerKey}:input:1`;
  const discovered = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: callerKey,
  });
  let current;
  if (discovered.status === "proven_absent") {
    current = await port.dispatch({
      schema: "flow.delegated-agent-dispatch-request/v1",
      agent_id: intent.route_binding.agent_id,
      caller_key: callerKey,
      input_key: inputKey,
      prompt: intent.delegate_input.prompt,
      description: intent.delegate_input.description,
    });
  } else if (discovered.turn?.id) {
    current = discovered;
  } else {
    throw delegatedRuntimeError(discovered);
  }

  if (current.status !== "completed" && current.turn?.status !== "completed") {
    for (const steering of intent.delegate_input.steering ?? []) {
      if (!current.turn?.id) throw delegatedRuntimeError(current);
      current = await port.send({
        schema: "flow.delegated-agent-send-request/v1",
        turn_id: current.turn.id,
        input_key: `${callerKey}:steering:${steering.caller_id}`,
        prompt: steering.prompt,
      });
      if (["blocked", "reconciling", "unavailable"].includes(current.status)) {
        throw delegatedRuntimeError(current);
      }
    }
  }

  if (current.status !== "completed" || current.turn?.status !== "completed") {
    if (!current.turn?.id) throw delegatedRuntimeError(current);
    current = await port.wait({
      schema: "flow.delegated-agent-wait-request/v1",
      turn_id: current.turn.id,
      timeout_ms: intent.delegate_input.wait_timeout_ms,
    });
  }
  if (["still_running", "reconciling"].includes(current.status)) {
    throw delegatedRuntimeError(current);
  }
  const receipt = await validateSettledDelegate({
    current,
    inputKey,
    intent,
    validators,
  });
  return settleTerminalDisposition({ current, intent, port, receipt });
}

async function validateSettledDelegate({ current, inputKey, intent, validators }) {
  const turn = current?.turn;
  const description = intent.delegate_input.description;
  const expectedInputs = [{
    sequence: 1,
    caller_key: inputKey,
    payload_sha256: digest(intent.delegate_input.prompt),
    delivery_proof: "exact_transcript_correlation",
  }, ...(intent.delegate_input.steering ?? []).map((steering, index) => ({
    sequence: index + 2,
    caller_key: `${intent.attempt_id}:steering:${steering.caller_id}`,
    payload_sha256: digest(steering.prompt),
    delivery_proof: "exact_transcript_correlation",
  }))];
  const expectedDeliveredInputs = expectedInputs.map((input) => ({
    sequence: input.sequence,
    caller_key: input.caller_key,
    payload_sha256: input.payload_sha256,
    delivery_status: "submitted",
  }));
  const proof = turn?.settlement_proof;
  const lateResult = turn?.late_result;
  const output = lateResult?.text ?? turn?.result?.text;
  let reason = null;
  if (current.delegation?.agent_id !== intent.route_binding.agent_id ||
      turn?.caller?.dispatch_key !== intent.attempt_id ||
      turn.launch_binding?.comparison_key !==
        intent.route_binding.launch_comparison_key ||
      turn.launch_binding?.configuration_watermark !==
        intent.route_binding.configuration_watermark ||
      turn.launch_binding?.description_digest !==
        intent.route_binding.description_digest) {
    reason = "incompatible_dispatch_identity";
  } else if (digest((turn.inputs ?? []).map((input) => ({
      sequence: input.sequence,
      caller_key: input.caller_key,
      payload_sha256: input.payload_sha256,
      delivery_status: input.delivery?.status,
    }))) !== digest(expectedDeliveredInputs)) {
    reason = "incompatible_ordered_inputs";
  } else if (lateResult && (
      lateResult.turn_id !== turn.id ||
      lateResult.disposition !== "quarantined" ||
      lateResult.proof_classification !== "exact_transcript_correlation" ||
      typeof lateResult.text !== "string" || lateResult.text.length === 0)) {
    reason = "incompatible_late_result";
  } else if (lateResult) {
    reason = "late_output";
  } else if (current?.status !== "completed" || turn?.status !== "completed") {
    reason = "terminal_output_not_completed";
  } else if (proof?.schema !== "drovr.turn-settlement-proof/v1" ||
      proof.classification !== "exact_transcript_correlation" ||
      proof.launch_comparison_key !== description.comparison_keys.launch ||
      proof.configuration_watermark !== description.watermark.content_sha256 ||
      proof.description_digest !== description.description_digest ||
      digest(proof.ordered_inputs) !== digest(expectedInputs)) {
    reason = "incompatible_settlement_proof";
  } else if (typeof output !== "string" || output.length === 0) {
    reason = "missing_exact_output";
  }

  const validatorReceipts = [];
  if (!reason) {
    for (const contract of intent.delegate_validator_contracts) {
      let accepted = false;
      try {
        accepted = await validators.get(contract).validate(output, {
          attempt_id: intent.attempt_id,
          card_id: intent.card_id,
          settlement_proof: proof,
        }) === true;
      } catch {
        accepted = false;
      }
      validatorReceipts.push({ contract, accepted });
      if (!accepted) reason = "independent_validation_failed";
    }
  }

  const commonRecord = {
    attempt_id: intent.attempt_id,
    card_id: intent.card_id,
    turn_id: typeof turn?.id === "string" ? turn.id : null,
    drovr_watermark: current?.watermark ?? null,
    route_binding: intent.route_binding,
    settlement_proof: proof ?? null,
    validator_receipts: validatorReceipts,
  };
  const providerReceipt = freezeCanonical(reason
    ? {
        schema: "flow.delegate-quarantine/v1",
        ...commonRecord,
        quarantine_reason: reason,
        correlated_output: typeof output === "string" ? output : null,
      }
    : {
        schema: "flow.delegate-evidence/v1",
        ...commonRecord,
        validated_output: output,
      });
  return freezeCanonical({
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: reason ? "quarantined" : "succeeded",
    provider_receipt: providerReceipt,
  });
}

async function settleTerminalDisposition({
  current,
  forceRetirement = false,
  intent,
  port,
  receipt,
}) {
  if (!forceRetirement && receipt.outcome === "quarantined" &&
      intent.attempt_ordinal < intent.max_attempts) {
    const expectedAgentId = intent.route_binding.agent_id;
    let turnDisposition = null;
    if (current.turn?.status === "working") {
      turnDisposition = await port.cancel({
        schema: "flow.delegated-agent-cancel-request/v1",
        turn_id: current.turn.id,
      });
      if (!provesClosedTurn(
        turnDisposition,
        expectedAgentId,
        current.turn.id,
      )) {
        throw delegatedRuntimeError(turnDisposition);
      }
    }
    return freezeCanonical({
      ...receipt,
      provider_receipt: {
        ...receipt.provider_receipt,
        terminal_disposition: {
          schema: "flow.resource-handoff/v1",
          resource: {
            type: "drovr_agent",
            id: expectedAgentId,
          },
          durable_holder: "drovr.registry",
          reason: "bounded_delegate_retry_available",
          attempt_id: intent.attempt_id,
          ...(turnDisposition ? { turn_disposition: turnDisposition } : {}),
        },
      },
    });
  }
  if (receipt.outcome === "succeeded" &&
      intent.managed_agent_binding !== null &&
      intent.card_id !== intent.managed_agent_binding.terminal_card_id) {
    return freezeCanonical({
      ...receipt,
      provider_receipt: {
        ...receipt.provider_receipt,
        terminal_disposition: {
          schema: "flow.resource-handoff/v1",
          resource: {
            type: "drovr_agent",
            id: current.delegation?.agent_id ?? intent.route_binding.agent_id,
          },
          durable_holder: `flow.run:${intent.run_id}`,
          reason: "declared_managed_agent_reuse",
          attempt_id: intent.attempt_id,
          managed_agent_binding: intent.managed_agent_binding,
        },
      },
    });
  }
  let disposition;
  try {
    disposition = await port.retire({
      schema: "flow.delegated-agent-retire-request/v1",
      agent_id: intent.route_binding.agent_id,
      turn_id: current.turn?.id,
      attempt_id: intent.attempt_id,
    });
  } catch (error) {
    disposition = {
      schema: "flow.delegated-agent-lifecycle-projection/v1",
      operation: "retire",
      status: "unavailable",
      watermark: null,
      delegation: current.delegation ?? null,
      turn: current.turn ?? null,
      compatibility: {
        contract: "flow.delegated-agent-port/v1",
        code: error?.code ?? "delegated_runtime_unavailable",
      },
      legal_next_actions: ["retry_terminal_disposition"],
    };
  }
  const expectedAgentId = intent.route_binding.agent_id;
  const settled = disposition?.schema ===
      "flow.delegated-agent-lifecycle-projection/v1" &&
    disposition.operation === "retire" &&
    disposition.status === "retired" &&
    disposition.delegation?.agent_id === expectedAgentId &&
    disposition.watermark?.schema === "drovr.agent-authority-watermark/v1" &&
    disposition.watermark.agent_id === expectedAgentId;
  if (!settled) throw delegatedRuntimeError(disposition);
  const priorEvidence = receipt.provider_receipt;
  return freezeCanonical({
    ...receipt,
    provider_receipt: {
      ...priorEvidence,
      terminal_disposition: disposition,
    },
  });
}

function provesClosedTurn(projection, expectedAgentId, expectedTurnId) {
  return projection?.schema ===
      "flow.delegated-agent-lifecycle-projection/v1" &&
    projection.operation === "cancel" &&
    ["cancelled", "turn_closed"].includes(projection.status) &&
    projection.delegation?.agent_id === expectedAgentId &&
    projection.turn?.id === expectedTurnId &&
    ["cancelled", "completed", "interrupted"].includes(
      projection.turn.status,
    ) &&
    projection.watermark?.schema ===
      "drovr.turn-authority-watermark/v1" &&
    projection.watermark.authority === "drovr.registry" &&
    projection.watermark.turn_id === expectedTurnId &&
    /^sha256:[0-9a-f]{64}$/u.test(
      projection.watermark.record_sha256 ?? "",
    );
}

function delegatedRuntimeError(projection) {
  const error = new Error("delegated runtime did not prove an exact turn");
  error.code = projection?.compatibility?.code ??
    "delegated_runtime_unresolved";
  error.projection = projection ?? null;
  return error;
}

import {
  digest,
  freezeCanonical,
  isPlainRecord,
} from "./canonical.mjs";
import {
  featureConformanceFindings,
  loadRequiredDrovrFeatures,
  RequiredDrovrFeatureContractError,
} from "./required-drovr-features.mjs";
import {
  DELEGATE_RESOURCE_CONTRACTS,
  DELEGATE_EXECUTION_AUTHORITY_SCHEMA,
  DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA,
  DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
  DelegateInputEnvelopeError,
  materializeDelegateInputEnvelope,
  serializeDelegateInputEnvelope,
} from "./delegate-input-envelope.mjs";
import { flowGrantIdsForDrovrCapability } from "./delegate-capabilities.mjs";
import {
  DELEGATE_FAILURE_OBSERVATION_SCHEMA,
} from "./provider-receipt-policies/delegate-drovr.mjs";
import {
  validateDelegateEvidenceSafety,
} from "./evidence-safety.mjs";
import { isCredentialShapedString } from "./provider-receipt-sanitizers.mjs";
import {
  deriveDelegatedAgentResourceKey,
  snapshotDelegatedAgentResourcePort,
} from "./drovr-delegated-agent-resource-port.mjs";
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

export { snapshotDelegatedAgentResourcePort };

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
      evidenceSafety: typeof registration?.evidenceSafety === "function"
        ? registration.evidenceSafety.bind(registration)
        : registration?.evidenceSafety,
    }),
  ]));
}

export function delegateCompatibilityIssue(
  card,
  port,
  validators,
  requiredFeatureSnapshot,
  resourcePort = null,
) {
  if (port?.contract !== "flow.delegated-agent-port/v1" ||
      !REQUIRED_PORT_OPERATIONS.every(
        (operation) => typeof port?.[operation] === "function")) {
    return "delegated_agent_port_unavailable";
  }
  if (requiredFeatureSnapshot?.issue) {
    return requiredFeatureSnapshot.issue;
  }
  if (resourcePort !== null &&
      (resourcePort.contract !==
        "flow.delegated-agent-resource-port/v1" ||
       typeof resourcePort.ensure !== "function" ||
       typeof resourcePort.retire !== "function")) {
    return "delegated_agent_resource_port_unavailable";
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
  if (card.validators.some((contract) =>
    typeof validators.get(contract)?.evidenceSafety !== "function")) {
    return "unregistered_delegate_evidence_safety";
  }
  return null;
}

export function dispatchDelegateEffect(
  intent,
  port,
  validators,
  runAuthority,
  { settleCancelled = false, resourcePort = null } = {},
) {
  if (!["delegate", "delegate_cancellation"].includes(intent.effect_kind) ||
      typeof runAuthority.invokeEffect !== "function") return;
  let execution = null;
  void runAuthority.invokeEffect(intent, {
    settleCancelled,
    async invoke(effectiveIntent) {
      if (effectiveIntent.effect_kind === "delegate_cancellation") {
        return executeDelegateCancellation(
          effectiveIntent,
          port,
          resourcePort,
        );
      }
      execution = createDelegateExecution(effectiveIntent);
      return settleCancelled
        ? executeCancelledDelegate(
          effectiveIntent,
          port,
          resourcePort,
          validators,
        )
        : executeDelegate(
          effectiveIntent,
          port,
          resourcePort,
          validators,
          execution,
        );
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
        { settleCancelled: true, resourcePort },
      );
    }
  }).catch(async (error) => {
    if (typeof runAuthority.recordEffectObservation !== "function") return;
    const providerObservation = error?.code === "delegated_runtime_unresolved" &&
        execution?.resourceProjection === null
      ? error.projection ?? null
      : delegateFailureObservation(error, execution);
    if (!isPlainRecord(providerObservation)) return;
    try {
      await runAuthority.recordEffectObservation(intent, {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "indeterminate",
        causation: null,
        provider_observation: providerObservation,
      });
    } catch {
      // A concurrent settlement or terminal fence owns the newer truth.
    }
  });
}

function delegateFailureObservation(error, execution = null) {
  const code = typeof error?.reason === "string" &&
      /^[a-z0-9_:-]+$/u.test(error.reason)
    ? error.reason
    : typeof error?.code === "string" && /^[a-z0-9_:-]+$/u.test(error.code)
      ? error.code
      : "delegate_effect_failed";
  const resourceProjection = validFailureResourceProjection(
    execution?.resourceProjection ?? error?.projection,
  );
  return {
    schema: DELEGATE_FAILURE_OBSERVATION_SCHEMA,
    code,
    stage: "delegate_effect_materialization",
    retryable: false,
    ...(resourceProjection === null ? {} : {
      resource_projection: resourceProjection,
    }),
  };
}

function validFailureResourceProjection(projection) {
  return projection?.schema ===
      "flow.delegated-agent-resource-projection/v1" &&
      isDigest(projection.resource_key) &&
      typeof projection.status === "string" &&
      Object.hasOwn(projection, "watermark") &&
      Array.isArray(projection.legal_next_actions)
    ? projection
    : null;
}

async function executeDelegateCancellation(intent, port, resourcePort) {
  const current = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: intent.delegate_attempt_id,
  });
  if (current.status !== "proven_absent" && !current.turn?.id) {
    throw delegatedRuntimeError(current);
  }
  if (current.turn?.id &&
      (!current.delegation?.agent_id ||
       !(resourcePort !== null && hasWorkspaceResource(intent)) &&
         current.delegation.agent_id !== intent.route_binding.agent_id)) {
    throw delegatedRuntimeError(current);
  }
  let turnDisposition = null;
  if (current.turn?.status === "working") {
    turnDisposition = await port.cancel({
      schema: "flow.delegated-agent-cancel-request/v1",
      turn_id: current.turn.id,
    });
    const expectedAgentId = current.delegation.agent_id;
    if (!provesClosedTurn(turnDisposition, expectedAgentId, current.turn.id)) {
      throw delegatedRuntimeError(turnDisposition);
    }
  }
  const agentId = current.delegation?.agent_id ?? intent.route_binding.agent_id;
  const workspaceBound = resourcePort !== null && hasWorkspaceResource(intent);
  const resourceBinding = workspaceBound && current.turn?.id
    ? adoptedResourceBinding(current, intent)
    : null;
  const terminalDisposition = workspaceBound && !current.turn?.id
    ? unresolvedResourceRetirementHandoff(intent, current)
    : intent.retire_managed_agent === true &&
      (current.turn?.id ||
       resourcePort !== null && hasWorkspaceResource(intent))
    ? await retireDelegateAgent(
      current,
      intent,
      port,
      resourcePort,
      agentId,
      resourceBinding,
    )
    : current.delegation?.agent_id
      ? {
      schema: "flow.resource-handoff/v1",
      resource: { type: "drovr_agent", id: agentId },
      durable_holder: "drovr.registry",
      reason: intent.retire_managed_agent === true
        ? "managed_agent_turn_proven_absent"
        : "cancelled_delegate_settlement",
      attempt_id: intent.delegate_attempt_id,
      ...(turnDisposition ? { turn_disposition: turnDisposition } : {}),
        }
      : unresolvedResourceHandoff(
        intent,
        intent.retire_managed_agent === true
          ? "managed_agent_turn_proven_absent"
          : "cancelled_delegate_settlement",
      );
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
      terminal_disposition: terminalDisposition,
    },
  });
}

async function executeCancelledDelegate(
  intent,
  port,
  resourcePort,
  validators,
) {
  const current = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: intent.attempt_id,
  });
  if (current.status !== "proven_absent" && !current.turn?.id) {
    throw delegatedRuntimeError(current);
  }
  if (current.turn?.id &&
      (!current.delegation?.agent_id ||
       !(resourcePort !== null && hasWorkspaceResource(intent)) &&
         current.delegation.agent_id !== intent.route_binding.agent_id)) {
    throw delegatedRuntimeError(current);
  }
  if (current.turn?.status === "working") {
    throw delegatedRuntimeError(current);
  }
  const output = current.turn?.late_result?.text ??
    current.turn?.result?.text ?? null;
  const safety = await safetyCheckDelegateOutput({
    output,
    intent,
    validators,
    proof: current.turn?.settlement_proof ?? null,
  });
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
      correlated_output: safety.safe && typeof output === "string"
        ? output
        : null,
      ...(safety.validatorReceipts.length === 0 ? {} : {
        validator_receipts: safety.validatorReceipts,
      }),
    },
  });
  return settleTerminalDisposition({
    current,
    forceRetirement: true,
    intent,
    port,
    resourcePort,
    resourceBinding: resourcePort !== null && hasWorkspaceResource(intent) &&
        current.turn?.id
      ? adoptedResourceBinding(current, intent)
      : null,
    expectedAgentId: current.delegation?.agent_id ??
      intent.route_binding.agent_id,
    receipt,
  });
}

function createDelegateExecution(intent) {
  return {
    resourceBinding: null,
    resourceProjection: null,
    expectedAgentId: intent.route_binding.agent_id,
  };
}

async function executeDelegate(
  intent,
  port,
  resourcePort,
  validators,
  execution = createDelegateExecution(intent),
) {
  try {
    return await executeDelegateStrict(
      intent,
      port,
      resourcePort,
      validators,
      execution,
    );
  } catch (error) {
    if (!isReviewCard(intent) || !REVIEW_OPERATIONAL_ERROR_CODES.has(error?.code)) {
      throw error;
    }
    return settleReviewUnavailable({
      intent,
      port,
      resourcePort,
      current: error?.projection ?? null,
      reason: reviewOperationalReason(error),
      resourceBinding: execution.resourceBinding,
      expectedAgentId: execution.expectedAgentId,
    });
  }
}

async function executeDelegateStrict(
  intent,
  port,
  resourcePort,
  validators,
  execution = null,
) {
  const callerKey = intent.attempt_id;
  const orderedInputs = materializeDelegateWireInputs(intent);
  const initialInput = orderedInputs[0];
  const inputKey = initialInput.input_key;
  const discovered = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: callerKey,
  });
  let current;
  let expectedAgentId = intent.route_binding.agent_id;
  let resource = null;
  let resourceBinding = null;
  const workspaceBound = (initialInput.envelope?.resource_references ?? [])
    .some((reference) => reference?.kind === "workspace");
  // The production runtime always supplies the resource port, including when
  // a custom turn adapter is injected. A null port remains supported only by
  // the lower-level FlowRuntime test/adapter seam, where the adapter owns the
  // concrete agent identity directly.
  if (resourcePort !== null && discovered.status === "proven_absent" &&
      workspaceBound) {
    resource = await ensureDelegateResource({
      intent,
      initialInput,
      resourcePort,
    });
    expectedAgentId = resource.delegation.agent_id;
    resourceBinding = resource.binding;
    if (execution !== null) {
      execution.expectedAgentId = expectedAgentId;
      execution.resourceBinding = resourceBinding;
      execution.resourceProjection = resource;
    }
  }
  if (discovered.status === "proven_absent") {
    current = await port.dispatch({
      schema: "flow.delegated-agent-dispatch-request/v1",
      agent_id: expectedAgentId,
      caller_key: callerKey,
      input_key: inputKey,
      prompt: initialInput.bytes,
      payload_sha256: initialInput.payload_sha256,
      description: intent.delegate_input.description,
      ...(resourceBinding === null ? {} : { resource_binding: resourceBinding }),
    });
  } else if (discovered.turn?.id) {
    current = discovered;
    if (!(resourcePort !== null && workspaceBound) &&
        discovered.delegation?.agent_id !== intent.route_binding.agent_id) {
      throw delegateIdentityConflict(discovered, "incompatible_dispatch_identity");
    }
    expectedAgentId = discovered.delegation?.agent_id ?? expectedAgentId;
    if (resourcePort !== null && workspaceBound) {
      resourceBinding = adoptedResourceBinding(discovered, intent);
      if (execution !== null) {
        execution.expectedAgentId = expectedAgentId;
        execution.resourceBinding = resourceBinding;
      }
    }
  } else {
    throw delegatedRuntimeError(discovered);
  }

  if (current.turn?.id &&
      current.delegation?.agent_id !== expectedAgentId) {
    throw delegatedRuntimeError(current);
  }

  if (discovered.turn?.id) {
    const adoptionConflict = adoptedDelegateIdentityConflict(
      current,
      intent,
      orderedInputs,
      expectedAgentId,
    );
    if (adoptionConflict !== null) {
      throw delegateIdentityConflict(current, adoptionConflict);
    }
  }

  if (current.status !== "completed" && current.turn?.status !== "completed") {
    for (const [index, steering] of (intent.delegate_input.steering ?? [])
      .entries()) {
      if (!current.turn?.id) throw delegatedRuntimeError(current);
      const steeringInput = orderedInputs[index + 1];
      current = await port.send({
        schema: "flow.delegated-agent-send-request/v1",
        turn_id: current.turn.id,
        input_key: steeringInput.input_key,
        prompt: steeringInput.bytes,
        payload_sha256: steeringInput.payload_sha256,
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
    intent,
    validators,
    orderedInputs,
    expectedAgentId,
  });
  return settleTerminalDisposition({
    current,
    intent,
    port,
    resourcePort,
    resourceBinding,
    expectedAgentId,
    receipt,
  });
}

async function ensureDelegateResource({ intent, initialInput, resourcePort }) {
  const workspace = (initialInput.envelope?.resource_references ?? []).find(
    (reference) => reference?.kind === "workspace",
  );
  const request = delegatedResourceRequest(intent, workspace);
  const projection = await resourcePort.ensure(request);
  const expectedKey = deriveDelegatedAgentResourceKey(request);
  const expectedOwnerCardId = request.owner.managed_agent_binding_id ??
    request.owner.card_id;
  const expectedOwnerRouteKey = request.owner.managed_agent_binding_id ??
    request.owner.route_key;
  const expectedWorkspace = request.owner.managed_agent_binding_id === undefined
    ? request.workspace_claim
    : Object.fromEntries(Object.entries(request.workspace_claim)
      .filter(([key]) => key !== "operation"));
  const binding = projection?.binding;
  const bindingDigest = isPlainRecord(binding)
    ? digest({
        resource_key: binding.resource_key,
        owner: binding.owner,
        workspace_claim: binding.workspace_claim,
        launch_binding: binding.launch_binding,
        delegation: projection.delegation,
        native_session: binding.native_session,
        managed_runtime_evidence_digest:
          binding.managed_runtime_evidence_digest,
      })
    : null;
  if (projection?.status !== "ready" ||
      projection.resource_key !== expectedKey ||
      !projection.delegation?.agent_id ||
      !projection.delegation?.task_id ||
      !projection.delegation?.group_id ||
      !/^sha256:[0-9a-f]{64}$/u.test(projection.binding_digest ?? "") ||
      projection.watermark?.agent_id !== projection.delegation.agent_id ||
      binding?.schema !== "flow.delegated-agent-resource-binding/v1" ||
      binding.resource_key !== expectedKey ||
      binding.owner?.run_id !== request.owner.run_id ||
      binding.owner?.card_id !== expectedOwnerCardId ||
      binding.owner?.route_key !== expectedOwnerRouteKey ||
      digest(binding.workspace_claim) !== digest(expectedWorkspace) ||
      binding.launch_binding?.description_digest !==
        request.launch_binding.description_digest ||
      binding.launch_binding?.launch_comparison_key !==
        request.launch_binding.launch_comparison_key ||
      binding.launch_binding?.effective_authority_comparison_key !==
        request.launch_binding.effective_authority_comparison_key ||
      binding.launch_binding?.configuration_watermark !==
        request.launch_binding.configuration_watermark ||
      !/^sha256:[0-9a-f]{64}$/u.test(
        binding.managed_runtime_evidence_digest ?? "",
      ) ||
      binding.delegation?.agent_id !== projection.delegation.agent_id ||
      binding.delegation?.task_id !== projection.delegation.task_id ||
      binding.delegation?.group_id !== projection.delegation.group_id ||
      bindingDigest !== projection.binding_digest) {
    const error = delegatedRuntimeError(projection);
    error.code = projection?.reason?.code ?? "resource_provisioning_uncertain";
    throw error;
  }
  return projection;
}

function adoptedResourceBinding(discovered, intent) {
  const binding = discovered.turn?.resource_binding;
  const request = delegatedResourceRequest(
    intent,
    workspaceReferenceForIntent(intent),
  );
  const expectedKey = deriveDelegatedAgentResourceKey(request);
  const expectedOwnerCardId = request.owner.managed_agent_binding_id ??
    request.owner.card_id;
  const expectedOwnerRouteKey = request.owner.managed_agent_binding_id ??
    request.owner.route_key;
  const expectedWorkspace = request.owner.managed_agent_binding_id === undefined
    ? request.workspace_claim
    : Object.fromEntries(Object.entries(request.workspace_claim)
      .filter(([key]) => key !== "operation"));
  const expectedDelegation = discovered.delegation;
  const bindingDigest = isPlainRecord(binding)
    ? digest({
        resource_key: binding.resource_key,
        owner: binding.owner,
        workspace_claim: binding.workspace_claim,
        launch_binding: binding.launch_binding,
        delegation: binding.delegation,
        native_session: binding.native_session,
        managed_runtime_evidence_digest:
          binding.managed_runtime_evidence_digest,
      })
    : null;
  if (!isPlainRecord(binding) ||
      binding.schema !== "flow.delegated-agent-resource-binding/v1" ||
      binding.resource_key !== expectedKey ||
      binding.owner?.run_id !== request.owner.run_id ||
      binding.owner?.card_id !== expectedOwnerCardId ||
      binding.owner?.route_key !== expectedOwnerRouteKey ||
      digest(binding.workspace_claim) !== digest(expectedWorkspace) ||
      digest(binding.launch_binding) !== digest(request.launch_binding) ||
      digest(binding.delegation) !== digest(expectedDelegation) ||
      !/^sha256:[0-9a-f]{64}$/u.test(
        binding.managed_runtime_evidence_digest ?? "",
      ) ||
      binding.binding_digest !== bindingDigest) {
    const error = delegatedRuntimeError(discovered);
    error.code = "resource_binding_conflict";
    throw error;
  }
  return binding;
}

function delegatedResourceRequest(intent, workspaceReference) {
  if (!workspaceReference) {
    const error = new Error(
      "delegated resource provisioning requires an exact workspace claim",
    );
    error.code = "workspace_claim_missing";
    throw error;
  }
  const description = intent.delegate_input?.description;
  if (!isPlainRecord(description) || !isPlainRecord(description.launch) ||
      !isPlainRecord(description.comparison_keys) ||
      !isPlainRecord(description.watermark)) {
    const error = new Error(
      "delegated resource provisioning requires an exact launch binding",
    );
    error.code = "launch_binding_conflict";
    throw error;
  }
  const subjectId = workspaceReference.subject_id ?? workspaceReference.id;
  if (typeof subjectId !== "string" || subjectId.length === 0) {
    const error = new Error(
      "delegated resource provisioning requires an exact workspace subject",
    );
    error.code = "workspace_claim_missing";
    throw error;
  }
  const workspaceClaim = {
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: subjectId,
    generation: workspaceReference.generation,
    mutation_epoch: workspaceReference.mutation_epoch,
    fingerprint: workspaceReference.fingerprint,
    access: workspaceReference.access,
    ...(workspaceReference.operation === undefined ? {} : {
      operation: workspaceReference.operation,
    }),
  };
  return {
    schema: "flow.delegated-agent-resource-ensure-request/v1",
    owner: {
      run_id: intent.run_id,
      card_id: intent.card_id,
      route_key: intent.route_binding.agent_id,
      ...(intent.managed_agent_binding?.binding_id === undefined ? {} : {
        managed_agent_binding_id: intent.managed_agent_binding.binding_id,
      }),
    },
    workspace_claim: workspaceClaim,
    launch: structuredClone(description.launch),
    launch_binding: {
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
      effective_authority_comparison_key:
        description.comparison_keys.effective_authority,
      configuration_watermark: description.watermark.content_sha256,
    },
  };
}

function adoptedDelegateIdentityConflict(
  current,
  intent,
  orderedInputs,
  expectedAgentId,
) {
  const turn = current?.turn;
  if (!turn?.id) return "missing_turn_identity";
  if (current.delegation?.agent_id !== expectedAgentId ||
      turn.caller?.dispatch_key !== intent.attempt_id ||
      turn.launch_binding?.comparison_key !==
        intent.route_binding.launch_comparison_key ||
      turn.launch_binding?.configuration_watermark !==
        intent.route_binding.configuration_watermark ||
      turn.launch_binding?.description_digest !==
        intent.route_binding.description_digest) {
    return "incompatible_dispatch_identity";
  }
  if (!Array.isArray(turn.inputs) || turn.inputs.length === 0) {
    return "missing_initial_input";
  }
  if (turn.inputs.length > orderedInputs.length) {
    return "unexpected_existing_input";
  }
  for (const [index, actual] of turn.inputs.entries()) {
    const expected = orderedInputs[index];
    if (actual?.sequence !== expected.sequence ||
        actual.caller_key !== expected.input_key ||
        actual.payload_sha256 !== expected.payload_sha256 ||
        !["recorded", "submitted"].includes(actual.delivery?.status)) {
      return index === 0
        ? "incompatible_initial_input"
        : "incompatible_steering_prefix";
    }
  }
  return null;
}

function delegateIdentityConflict(projection, reason) {
  const error = delegatedRuntimeError(projection);
  error.code = "delegate_identity_conflict";
  error.reason = reason;
  return error;
}

async function validateSettledDelegate({
  current,
  intent,
  validators,
  orderedInputs,
  expectedAgentId,
}) {
  const turn = current?.turn;
  const description = intent.delegate_input.description;
  const expectedInputs = orderedInputs.map((input) => ({
    sequence: input.sequence,
    caller_key: input.input_key,
    payload_sha256: input.payload_sha256,
    delivery_proof: "exact_transcript_correlation",
  }));
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
  if (current.delegation?.agent_id !== expectedAgentId ||
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

  const safety = await safetyCheckDelegateOutput({
    output,
    intent,
    validators,
    proof,
  });
  const validatorReceipts = safety.validatorReceipts;
  const safetyReceipt = validatorReceipts.find(({ evidence_safety_accepted }) =>
    evidence_safety_accepted === true);
  if (!reason) {
    for (const contract of intent.delegate_validator_contracts) {
      const validator = validators.get(contract);
      let accepted = false;
      try {
        accepted = await validator.validate(output, {
          attempt_id: intent.attempt_id,
          card_id: intent.card_id,
          settlement_proof: proof,
          delegate_input: intent.delegate_input,
          authority_materialized_evidence:
            intent.delegate_input.authority_materialized_evidence ?? null,
        }) === true;
      } catch (error) {
        accepted = false;
      }
      const receipt = validatorReceipts.find(({ contract: receiptContract }) =>
        receiptContract === contract);
      if (receipt) {
        receipt.accepted = accepted && receipt.evidence_safety_accepted !== false;
      } else {
        validatorReceipts.push({ contract, accepted });
      }
      if (!accepted) reason = "independent_validation_failed";
    }
  }
  if (safety.rejected) reason ??= "independent_validation_failed";
  const commonRecord = {
    attempt_id: intent.attempt_id,
    card_id: intent.card_id,
    turn_id: typeof turn?.id === "string" ? turn.id : null,
    drovr_watermark: current?.watermark ?? null,
    route_binding: intent.route_binding,
    settlement_proof: proof ?? null,
    validator_receipts: validatorReceipts,
    ...(safetyReceipt === undefined ? {} : {
      evidence_safety_receipt: safetyReceipt.evidence_safety_receipt,
      evidence_safety_binding: safetyReceipt.evidence_safety_binding,
    }),
  };
  if (isReviewCard(intent) && reason !== null) {
    const authorityTerminalDisposition = reviewTerminalDisposition({
      status: "unavailable",
      reason: reviewCoverageReason(reason),
    });
    const unavailableOutput = unavailableReviewOutput({
      reason: authorityTerminalDisposition.reason,
    });
    const unavailableSafety = validateDelegateEvidenceSafety(unavailableOutput);
    if (!unavailableSafety.accepted) {
      throw new DelegateInputEnvelopeError(
        "unsafe_delegate_output",
        "authority-generated review unavailable output failed evidence safety",
      );
    }
    const quarantineRecord = freezeCanonical({
      schema: "flow.delegate-quarantine/v1",
      ...commonRecord,
      quarantine_reason: reason,
      correlated_output: typeof output === "string" ? output : null,
    });
    return freezeCanonical({
      schema: "flow.effect-receipt/v1",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      outcome: "succeeded",
      provider_receipt: {
        schema: "flow.delegate-evidence/v1",
        ...commonRecord,
        validated_output: unavailableOutput,
        evidence_safety_receipt: unavailableSafety.receipt,
        evidence_safety_binding: unavailableSafety.binding,
        authority_terminal_disposition: authorityTerminalDisposition,
        operational_failure: reason,
        quarantine_record: quarantineRecord,
      },
    });
  }
  const providerReceipt = freezeCanonical(reason
    ? {
        schema: "flow.delegate-quarantine/v1",
        ...commonRecord,
        quarantine_reason: reason,
        correlated_output: safety.safe && typeof output === "string"
          ? output
          : null,
      }
    : {
        schema: "flow.delegate-evidence/v1",
        ...commonRecord,
        validated_output: output,
        ...(isReviewCard(intent) ? {
          authority_terminal_disposition: reviewTerminalDisposition({
            status: "produced",
            reason: null,
          }),
        } : {}),
      });
  return freezeCanonical({
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: reason ? "quarantined" : "succeeded",
    provider_receipt: providerReceipt,
  });
}

async function safetyCheckDelegateOutput({ output, intent, validators, proof }) {
  const validatorReceipts = [];
  let rejected = typeof output !== "string" ||
    isCredentialShapedString(output);
  let safe = !rejected;
  for (const contract of intent.delegate_validator_contracts ?? []) {
    const validator = validators.get(contract);
    if (typeof validator?.evidenceSafety !== "function") {
      rejected = true;
      safe = false;
      validatorReceipts.push({
        contract,
        accepted: false,
        evidence_safety_accepted: false,
        evidence_safety_rejection: "missing_evidence_safety",
      });
      continue;
    }
    if (typeof output !== "string") {
      validatorReceipts.push({
        contract,
        accepted: false,
        evidence_safety_accepted: false,
        evidence_safety_rejection: "invalid_delegate_output",
      });
      continue;
    }

    let result;
    try {
      result = await validator.evidenceSafety(output, {
        attempt_id: intent.attempt_id,
        card_id: intent.card_id,
        settlement_proof: proof,
        delegate_input: intent.delegate_input,
        authority_materialized_evidence:
          intent.delegate_input?.authority_materialized_evidence ?? null,
      });
    } catch {
      result = null;
    }
    const verified = result?.accepted === true &&
      isPlainRecord(result.receipt) && isPlainRecord(result.binding) &&
      verifyDelegateEvidenceSafetyResult(output, result);
    if (verified) {
      validatorReceipts.push({
        contract,
        accepted: false,
        evidence_safety_accepted: true,
        evidence_safety_receipt: result.receipt,
        evidence_safety_binding: result.binding,
      });
      continue;
    }
    rejected = true;
    safe = false;
    validatorReceipts.push({
      contract,
      accepted: false,
      evidence_safety_accepted: false,
      evidence_safety_rejection: redactedSafetyRejection(result),
    });
  }
  return { safe, rejected, validatorReceipts };
}

function verifyDelegateEvidenceSafetyResult(output, result) {
  const expected = validateDelegateEvidenceSafety(output, {
    classification: result?.receipt?.classification,
  });
  return expected.accepted &&
    JSON.stringify(expected.receipt) === JSON.stringify(result.receipt) &&
    JSON.stringify(expected.binding) === JSON.stringify(result.binding);
}

function redactedSafetyRejection(result) {
  const code = typeof result?.rejection?.code === "string" &&
      /^[a-z0-9_:-]+$/u.test(result.rejection.code)
    ? result.rejection.code
    : "validator_rejected";
  return {
    schema: "flow.evidence-safety-rejection/v1",
    operation: "validate",
    code,
    reason: code,
    redacted: true,
  };
}

function materializeDelegateWireInputs(intent) {
  const callerKey = intent.attempt_id;
  const delegateInput = intent.delegate_input ?? {};
  const steering = delegateInput.steering ?? [];
  return [
    materializeDelegateWireInput(intent, {
      inputKey: `${callerKey}:input:1`,
      inputKind: "initial",
      sequence: 1,
      instructions: delegateInput.prompt,
    }),
    ...steering.map((input, index) => materializeDelegateWireInput(intent, {
      inputKey: `${callerKey}:steering:${input.caller_id}`,
      inputKind: "steering",
      sequence: index + 2,
      instructions: input.instructions ?? input.prompt,
    })),
  ];
}

function materializeDelegateWireInput(intent, {
  inputKey,
  inputKind,
  sequence,
  instructions,
}) {
  const delegateInput = intent.delegate_input ?? {};
  if (Object.hasOwn(delegateInput, "execution_authority") ||
      Object.hasOwn(delegateInput, "predecessor_evidence") ||
      Object.hasOwn(delegateInput, "instructions")) {
    throw new DelegateInputEnvelopeError(
      "caller_delegate_input_forbidden",
      "delegate execution authority, predecessor evidence, and instruction " +
        "override are forbidden",
    );
  }
  const description = delegateInput.description;
  const executionAuthority = deriveDelegateExecutionAuthority(intent);
  if (!Array.isArray(intent.delegate_output_schemas) ||
      intent.delegate_output_schemas.length === 0 ||
      !Array.isArray(intent.delegate_validator_contracts) ||
      intent.delegate_validator_contracts.length === 0) {
    throw new DelegateInputEnvelopeError(
      "missing_output_requirements",
      "RunAuthority must provide non-empty delegate output schemas and validators",
    );
  }
  const envelope = materializeDelegateInputEnvelope({
    attemptId: intent.attempt_id,
    inputKey,
    sequence,
    inputKind,
    instructions,
    taskInputs: delegateInput.task_inputs ?? {
      schema: "flow.delegate-task-inputs/v1",
    },
    resourceReferences: resolveDelegateResourceReferences(
      delegateInput.resource_references ?? [],
      intent,
    ),
    executionAuthority,
    ...(delegateInput.authority_materialized_evidence === undefined
      ? {}
      : {
          predecessorEvidence: delegateInput.authority_materialized_evidence,
        }),
    outputRequirements: {
      schema: DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
      format: "canonical-json",
      schemas: intent.delegate_output_schemas,
      validator_contracts: intent.delegate_validator_contracts,
    },
  });
  const serialized = serializeDelegateInputEnvelope(envelope);
  return {
    envelope: serialized.envelope,
    bytes: serialized.bytes,
    payload_sha256: serialized.payload_sha256,
    input_key: inputKey,
    sequence,
  };
}

function deriveDelegateExecutionAuthority(intent) {
  const description = intent.delegate_input?.description;
  const authority = description?.effective_authority;
  const capability = description?.launch?.capability;
  const effectiveDigest = description?.comparison_keys?.effective_authority;
  const route = intent.route_binding;
  const {
    description_digest: _descriptionDigest,
    legal_actions: _legalActions,
    ...descriptionIdentity
  } = description ?? {};
  const {
    description_digest: _digestWithActions,
    ...descriptionIdentityWithActions
  } = description ?? {};
  const descriptionDigestMatches =
    digest(descriptionIdentity) === description?.description_digest ||
    digest(descriptionIdentityWithActions) === description?.description_digest;
  if (!isPlainRecord(description) ||
      !isPlainRecord(authority) ||
      typeof capability !== "string" || capability.length === 0 ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys?.launch) ||
      !isDigest(description.watermark?.content_sha256) ||
      !isDigest(effectiveDigest) ||
      !descriptionDigestMatches ||
      digest(authority) !== effectiveDigest ||
      authority.capability !== capability ||
      !isPlainRecord(route) ||
      route.description_digest !== description.description_digest ||
      route.launch_comparison_key !== description.comparison_keys.launch ||
      route.configuration_watermark !== description.watermark.content_sha256) {
    throw new DelegateInputEnvelopeError(
      "invalid_execution_authority",
      "delegate execution authority is not bound to the immutable route description",
    );
  }
  const capabilityEnvelopes = Array.isArray(intent.capability_envelopes)
    ? intent.capability_envelopes
    : [];
  if (capabilityEnvelopes.some((id) => typeof id !== "string" || !id) ||
      new Set(capabilityEnvelopes).size !== capabilityEnvelopes.length) {
    throw new DelegateInputEnvelopeError(
      "invalid_execution_authority",
      "RunAuthority capability facts are not a unique accepted set",
    );
  }
  const requiredGrantIds = flowGrantIdsForDrovrCapability(capability);
  if (requiredGrantIds === null) {
    throw new DelegateInputEnvelopeError(
      "unsupported_execution_capability",
      "Drovr route capability has no finite Flow grant mapping",
    );
  }
  const capabilityBindings = Array.isArray(intent.capability_bindings)
    ? intent.capability_bindings
    : [];
  const acceptedGrantIds = requiredGrantIds.filter((grantId) =>
    capabilityBindings.some((binding) =>
      isPlainRecord(binding) && binding.capability === grantId &&
      Array.isArray(binding.card_ids) &&
      (binding.card_ids.includes(intent.card_id) ||
       binding.card_ids.includes("*"))));
  if (acceptedGrantIds.length !== requiredGrantIds.length) {
    throw new DelegateInputEnvelopeError(
      "unapproved_execution_capability",
      "delegate route capability is not an accepted card-scoped Flow grant",
    );
  }
  return {
    schema: DELEGATE_EXECUTION_AUTHORITY_SCHEMA,
    owner: "RunAuthority",
    capability,
    effective_authority_digest: effectiveDigest,
    capability_envelope_ids: acceptedGrantIds,
  };
}

function resolveDelegateResourceReferences(references, intent) {
  if (!Array.isArray(references)) {
    throw new DelegateInputEnvelopeError(
      "invalid_resource_references",
      "delegate resource references must be an array",
    );
  }
  const bindings = Array.isArray(intent.required_authority_bindings)
    ? intent.required_authority_bindings
    : [];
  return references.map((reference) => {
    if (!isPlainRecord(reference) ||
        reference.schema !== DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA ||
        Object.hasOwn(reference, "authority_binding")) {
      throw new DelegateInputEnvelopeError(
        Object.hasOwn(reference ?? {}, "authority_binding")
          ? "caller_resource_binding_forbidden"
          : "invalid_resource_selection",
        "delegate execution resources must select approved binding IDs",
      );
    }
    const bindingId = reference.authority_binding_id;
    const binding = bindings.find(({ id }) => id === bindingId);
    if (binding === undefined) {
      throw new DelegateInputEnvelopeError(
        "required_authority_binding_missing",
        "delegate execution resource binding is not RunAuthority-approved",
      );
    }
    const expectedAuthority = {
      workspace: "WorkspaceAuthority",
      artifact: "ArtifactAuthority",
    }[reference.kind];
    if (expectedAuthority !== undefined &&
        reference.authority !== expectedAuthority) {
      throw new DelegateInputEnvelopeError(
        "resource_authority_mismatch",
        "delegate execution resource names the wrong owning authority",
      );
    }
    if (reference.contract !== DELEGATE_RESOURCE_CONTRACTS[reference.kind] ||
        reference.access === "mutation" && reference.operation !== intent.card_id ||
        reference.operation !== undefined && reference.operation !== intent.card_id) {
      throw new DelegateInputEnvelopeError(
        "resource_binding_mismatch",
        "delegate resource selection does not bind its exact contract and operation",
      );
    }
    if (binding.contract !== "flow.resource-authority/v1" ||
        !resourceSelectionMatchesClaim(reference, intent.resource_claims)) {
      throw new DelegateInputEnvelopeError(
        "resource_binding_mismatch",
        "delegate resource selection does not match approved resource facts",
      );
    }
    const { authority_binding_id: _bindingId, ...resolved } = reference;
    return {
      ...resolved,
      schema: "flow.delegate-execution-resource-reference/v1",
      authority_binding: binding,
    };
  });
}

function resourceSelectionMatchesClaim(reference, claims) {
  return Array.isArray(claims) && claims.some((claim) =>
    isPlainRecord(claim) &&
    claim.kind === reference.kind &&
    claim.id === reference.subject_id &&
    claim.generation === reference.generation &&
    claim.mutation_epoch === reference.mutation_epoch &&
    claim.fingerprint === reference.fingerprint);
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isReviewCard(intent) {
  return typeof intent?.card_id === "string" &&
    (intent.card_id.startsWith("review-lens-") || intent.card_id === "review-critic");
}

function reviewTerminalDisposition({ status, reason }) {
  return freezeCanonical({
    schema: "flow.review-terminal-disposition/v1",
    authority: "RunAuthority",
    status,
    reason,
  });
}

function reviewCoverageReason(reason) {
  return reason;
}

function reviewOperationalReason(error) {
  if (error?.code === "delegated_runtime_unresolved") {
    const status = error.projection?.status;
    if (status === "still_running" || status === "reconciling") return "bounded_timeout";
    return "delegate_unavailable";
  }
  if (error?.code === "delegated_runtime_unavailable" ||
      error?.code === "delegated_agent_port_unavailable") {
    return "delegate_unavailable";
  }
  return "delegate_failure";
}

function unavailableReviewOutput({ reason }) {
  return JSON.stringify({
    schema: "flow.review-result/v1",
    posture: "review_incomplete",
    findings: [],
    coverage: {
      schema: "flow.review-coverage/v1",
      status: reason === "bounded_timeout" ? "degraded" : "unavailable",
      reason,
    },
    evidence: null,
  });
}

async function settleReviewUnavailable({
  intent,
  port,
  resourcePort,
  current,
  reason,
  resourceBinding = null,
  expectedAgentId = intent.route_binding.agent_id,
}) {
  const terminalDisposition = reviewTerminalDisposition({
    status: reason === "bounded_timeout" ? "degraded" : "unavailable",
    reason,
  });
  const validatedOutput = unavailableReviewOutput({ reason });
  const safety = validateDelegateEvidenceSafety(validatedOutput);
  if (!safety.accepted) {
    throw new DelegateInputEnvelopeError(
      "unsafe_delegate_output",
      "authority-generated review unavailable output failed evidence safety",
    );
  }
  if (resourcePort !== null && hasWorkspaceResource(intent) &&
      !isPlainRecord(resourceBinding)) {
    throw delegatedRuntimeError({
      reason: {
        code: "resource_retirement_uncertain",
        message: "review fallback cannot settle without the exact acquired resource binding",
      },
    });
  }
  let resourceDisposition;
  try {
    resourceDisposition = current?.turn?.id
      ? await retireDelegateAgent(
        current,
        intent,
        port,
        resourcePort,
        current.delegation?.agent_id ?? expectedAgentId,
        resourceBinding ?? (resourcePort !== null && hasWorkspaceResource(intent)
          ? adoptedResourceBinding(current, intent)
          : null),
      )
      : resourceBinding !== null
        ? await retireDelegateResource(resourcePort, resourceBinding, null)
        : unresolvedResourceHandoff(intent, "review_coverage_unavailable");
  } catch (error) {
    resourceDisposition = resourceBinding !== null
      ? resourceHandoffForBinding(
        resourceBinding,
        error?.projection?.reason?.code ??
          error?.code ??
          "resource_retirement_uncertain",
        intent.attempt_id,
        {
          resourceProjection: resourceProjectionForHandoff(error),
        },
      )
      : unresolvedResourceHandoff(intent, "review_coverage_unavailable");
  }
  return freezeCanonical({
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: {
      schema: "flow.delegate-evidence/v1",
      attempt_id: intent.attempt_id,
      card_id: intent.card_id,
      turn_id: current?.turn?.id ?? null,
      drovr_watermark: current?.watermark ?? null,
      route_binding: intent.route_binding,
      validator_receipts: [],
      validated_output: validatedOutput,
      evidence_safety_receipt: safety.receipt,
      evidence_safety_binding: safety.binding,
      authority_terminal_disposition: terminalDisposition,
      terminal_disposition: resourceDisposition,
    },
  });
}

function resourceHandoffForBinding(
  binding,
  reason,
  attemptId,
  { resourceProjection = null } = {},
) {
  return {
    schema: "flow.resource-handoff/v1",
    resource: {
      type: "drovr_agent",
      id: binding.delegation?.agent_id ?? null,
    },
    resource_binding: binding,
    durable_holder: "drovr.registry",
    reason,
    attempt_id: attemptId,
    ...(resourceProjection === null ? {} : {
      resource_projection: resourceProjection,
    }),
  };
}

function resourceProjectionForHandoff(error) {
  return error?.projection?.schema ===
      "flow.delegated-agent-resource-projection/v1"
    ? error.projection
    : null;
}

function unresolvedResourceHandoff(
  intent,
  reason,
  { resourceProjection = null } = {},
) {
  return {
    schema: "flow.resource-handoff/v1",
    resource: { type: "drovr_agent_unresolved" },
    planning_identity: {
      type: "flow_route",
      agent_id: intent.route_binding.agent_id,
    },
    durable_holder: `flow.run:${intent.run_id}`,
    reason,
    attempt_id: intent.attempt_id ?? intent.delegate_attempt_id,
    ...(resourceProjection === null ? {} : {
      resource_projection: resourceProjection,
    }),
  };
}

function unresolvedResourceRetirementHandoff(intent, current) {
  const resourceKey = expectedResourceKeyForIntent(intent);
  return unresolvedResourceHandoff(
    intent,
    "resource_retirement_uncertain",
    resourceKey === null
      ? {}
      : {
        resourceProjection: {
          schema: "flow.delegated-agent-resource-projection/v1",
          operation: "retire",
          status: "blocked",
          resource_key: resourceKey,
          binding: null,
          binding_digest: null,
          delegation: null,
          watermark: current?.watermark ?? null,
          legal_next_actions: ["reconcile_exact_agent_retirement"],
          reason: {
            code: "resource_retirement_uncertain",
            message: "exact workspace resource identity was not carried through cancellation",
          },
        },
      },
  );
}

function expectedResourceKeyForIntent(intent) {
  const workspace = workspaceReferenceForIntent(intent);
  if (!workspace || !isPlainRecord(intent.delegate_input?.description)) {
    return null;
  }
  try {
    return deriveDelegatedAgentResourceKey(
      delegatedResourceRequest(intent, workspace),
    );
  } catch (error) {
    if ([
      "workspace_claim_missing",
      "launch_binding_conflict",
      "invalid_resource_request",
    ].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

async function settleTerminalDisposition({
  current,
  forceRetirement = false,
  intent,
  port,
  resourcePort,
  resourceBinding = null,
  expectedAgentId = current?.delegation?.agent_id ??
    intent.route_binding.agent_id,
  receipt,
}) {
  if (forceRetirement && resourcePort !== null &&
      hasWorkspaceResource(intent) && !current?.turn?.id) {
    return freezeCanonical({
      ...receipt,
      provider_receipt: {
        ...receipt.provider_receipt,
        terminal_disposition: unresolvedResourceRetirementHandoff(
          intent,
          current,
        ),
      },
    });
  }
  if (!forceRetirement && receipt.outcome === "quarantined" &&
      intent.attempt_ordinal < intent.max_attempts) {
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
    if (resourcePort !== null && hasWorkspaceResource(intent)) {
      if (!isPlainRecord(resourceBinding)) {
        throw delegatedRuntimeError({
          reason: {
            code: "resource_retirement_uncertain",
            message: "retry activation requires the exact primary resource binding",
          },
        });
      }
      if (intent.retry_resource_strategy ===
          "retain_exact_primary_for_same_route_retry") {
        if (!isPlainRecord(intent.next_route_binding) ||
            digest(intent.next_route_binding) !== digest(intent.route_binding)) {
          throw delegatedRuntimeError({
            reason: {
              code: "retry_resource_strategy_conflict",
              message: "same-route retry retention is not bound to the current route",
            },
          });
        }
        return freezeCanonical({
          ...receipt,
          provider_receipt: {
            ...receipt.provider_receipt,
            terminal_disposition: resourceHandoffForBinding(
              resourceBinding,
              "same_route_retry_resource_retained",
              intent.attempt_id,
            ),
          },
        });
      }
      if (intent.retry_resource_strategy !==
          "retire_exact_primary_before_independent_fallback" ||
          !isPlainRecord(intent.next_route_binding) ||
          digest(intent.next_route_binding) === digest(intent.route_binding)) {
        throw delegatedRuntimeError({
          reason: {
            code: "retry_resource_strategy_missing",
            message: "workspace retry lacks an authoritative independent fallback route",
          },
        });
      }
      const disposition = await retireDelegateAgent(
        current,
        intent,
        port,
        resourcePort,
        expectedAgentId,
        resourceBinding,
      );
      return freezeCanonical({
        ...receipt,
        provider_receipt: {
          ...receipt.provider_receipt,
          terminal_disposition: disposition,
        },
      });
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
      intent.managed_agent_binding?.terminal_card_id !== undefined &&
      intent.card_id !== intent.managed_agent_binding.terminal_card_id) {
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
          durable_holder: `flow.run:${intent.run_id}`,
          reason: "declared_managed_agent_reuse",
          attempt_id: intent.attempt_id,
          managed_agent_binding: intent.managed_agent_binding,
          ...(resourceBinding === null ? {} : {
            resource_binding: resourceBinding,
          }),
        },
      },
    });
  }
  const disposition = await retireDelegateAgent(
    current,
    intent,
    port,
    resourcePort,
    expectedAgentId,
    resourceBinding,
  );
  const priorEvidence = receipt.provider_receipt;
  return freezeCanonical({
    ...receipt,
    provider_receipt: {
      ...priorEvidence,
      terminal_disposition: disposition,
    },
  });
}

async function retireDelegateAgent(
  current,
  intent,
  port,
  resourcePort,
  expectedAgentId = current?.delegation?.agent_id ??
    intent.route_binding.agent_id,
  resourceBinding = null,
) {
  if (resourcePort !== null && hasWorkspaceResource(intent) &&
      (!current?.delegation?.agent_id || !isPlainRecord(resourceBinding))) {
    throw delegatedRuntimeError({
      reason: {
        code: "resource_retirement_uncertain",
        message: "resource retirement requires an exact carried binding",
      },
    });
  }
  let disposition;
  try {
    disposition = await port.retire({
      schema: "flow.delegated-agent-retire-request/v1",
      agent_id: expectedAgentId,
      turn_id: current.turn?.id,
      attempt_id: intent.delegate_attempt_id ?? intent.attempt_id,
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
  const settled = disposition?.schema ===
      "flow.delegated-agent-lifecycle-projection/v1" &&
    disposition.operation === "retire" &&
    disposition.status === "retired" &&
    disposition.delegation?.agent_id === expectedAgentId &&
    disposition.watermark?.schema === "drovr.agent-authority-watermark/v1" &&
    disposition.watermark.agent_id === expectedAgentId;
  if (!settled) throw delegatedRuntimeError(disposition);
  if (resourcePort === null || !hasWorkspaceResource(intent)) {
    return disposition;
  }
  if (!current?.delegation?.agent_id ||
      current.delegation.agent_id !== expectedAgentId) {
    throw delegatedRuntimeError({
      reason: {
        code: "resource_retirement_uncertain",
        message: "resource retirement requires the exact actual agent identity",
      },
    });
  }
  const resourceProjection = await retireDelegateResource(
    resourcePort,
    resourceBinding,
    current.turn ?? null,
  );
  return {
    ...disposition,
    resource_disposition: resourceProjection,
  };
}

async function retireDelegateResource(
  resourcePort,
  binding,
  turn = null,
) {
  if (!isPlainRecord(binding)) {
    throw delegatedRuntimeError({
      reason: {
        code: "resource_retirement_uncertain",
        message: "resource retirement requires the exact immutable binding",
      },
    });
  }
  const projection = await resourcePort.retire({
    schema: "flow.delegated-agent-resource-retire-request/v1",
    binding,
    settlement: {
      turn_id: turn?.id ?? null,
      turn_status: turn?.status ?? null,
    },
  });
  const exactRetirement = projection?.status === "retired" &&
    projection.delegation?.agent_id &&
    projection.delegation.agent_id === binding.delegation?.agent_id &&
    projection.binding_digest === binding.binding_digest &&
    projection.watermark?.schema ===
      "flow.delegated-agent-resource-watermark/v1" &&
    projection.watermark.agent_id === projection.delegation.agent_id &&
    projection.watermark.authority_watermark?.schema ===
      "drovr.registry-authority-watermark/v1";
  if (!exactRetirement) {
    throw delegatedRuntimeError(projection);
  }
  return projection;
}

function hasWorkspaceResource(intent) {
  return workspaceReferenceForIntent(intent) !== null;
}

function workspaceReferenceForIntent(intent) {
  const references = intent.delegate_input?.resource_references;
  const selected = Array.isArray(references)
    ? references.find((reference) => reference?.kind === "workspace")
    : null;
  if (selected !== null && selected !== undefined) return selected;
  const claim = Array.isArray(intent.resource_claims)
    ? intent.resource_claims.find((candidate) => candidate?.kind === "workspace")
    : null;
  if (!claim) return null;
  return {
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: claim.subject_id ?? claim.id,
    generation: claim.generation,
    mutation_epoch: claim.mutation_epoch,
    fingerprint: claim.fingerprint,
    access: claim.access ?? "read_only",
    ...(claim.operation === undefined ? {} : { operation: claim.operation }),
  };
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
  error.code = projection?.reason?.code ??
    projection?.compatibility?.code ??
    "delegated_runtime_unresolved";
  error.projection = projection ?? null;
  return error;
}

const REVIEW_OPERATIONAL_ERROR_CODES = new Set([
  "delegated_runtime_unresolved",
  "delegated_runtime_unavailable",
  "delegated_agent_port_unavailable",
]);

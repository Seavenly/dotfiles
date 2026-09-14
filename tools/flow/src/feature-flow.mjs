import { digest, freezeCanonical } from "./canonical.mjs";
import {
  FEATURE_REPAIR_CONTRACTS,
  validateFeatureRepairContract,
} from "./feature-repair-contract.mjs";
import { PredefinedFlowValidationError } from "./plan-compiler.mjs";
import {
  SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
} from "./authority-bindings.mjs";
import {
  createResultBinding,
  isResultBinding,
} from "./result-bindings.mjs";
import {
  FEATURE_CAPTURE_OPERATION_CONTRACT,
  FEATURE_CAPTURE_RECEIPT_SCHEMA,
  FEATURE_CAPTURE_RECEIPT_VALIDATOR,
  createFeatureCaptureOperation,
  validateFeatureCaptureReceipt,
} from "./feature-capture.mjs";

export {
  FEATURE_CAPTURE_OPERATION_CONTRACT,
  FEATURE_CAPTURE_RECEIPT_SCHEMA,
  FEATURE_CAPTURE_RECEIPT_VALIDATOR,
  createFeatureCaptureOperation,
  validateFeatureCaptureReceipt,
};
import {
  DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA,
  DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
} from "./delegate-input-envelope.mjs";
import { flowGrantIdsForDrovrCapability } from "./delegate-capabilities.mjs";
import {
  AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
  FEATURE_CRITIQUE_OUTPUT_SCHEMA,
  FEATURE_CRITIQUE_PROMPT,
} from "./feature-critique-contract.mjs";

export {
  AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
  FEATURE_CRITIQUE_OUTPUT_SCHEMA,
  FEATURE_CRITIQUE_PROMPT,
};

// These contracts are intentionally registered operation contracts.  The
// feature definition owns the order and inputs, while the host owns the
// adapters and the receipts returned by each operation.
export const FEATURE_OPERATION_CONTRACTS = Object.freeze({
  setup: "flow.operation/feature-setup/v1",
  test: "flow.operation/feature-test/v1",
  capture: FEATURE_CAPTURE_OPERATION_CONTRACT,
  verify: "flow.operation/feature-verify/v1",
  seal: "flow.operation/feature-seal/v1",
});

export const FEATURE_DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";

export const FEATURE_TEST_RECEIPT_VALIDATOR =
  "flow.validator/feature-test-receipt/v1";

export const FEATURE_VERIFICATION_RECEIPT_VALIDATOR =
  "flow.validator/feature-verification-receipt/v1";
export const FEATURE_CAPTURE_POLICY_SCHEMA = "flow.feature-capture-policy/v1";
export const FEATURE_CRITERION_EVIDENCE_SCHEMA =
  "flow.feature-criterion-evidence/v1";

const FEATURE_DEFINITION_SCHEMA = "flow.predefined-definition/v1";
const FEATURE_SELECTION_MODE = new Set(["verify", "test", "mixed"]);
const FEATURE_REPAIR_KINDS = new Set(Object.keys(FEATURE_REPAIR_CONTRACTS));
const FEATURE_NEGATIVE_OUTCOME =
  "no review, integration, push, pull request, cleanup, or tracker completion";
const FEATURE_OUTPUT_SCHEMAS = Object.freeze({
  setup_receipt: "work.feature-setup-receipt/v1",
  test_failure_receipt: "work.feature-test-receipt/v1",
  workspace_mutation_observation: "flow.delegate-evidence/v1",
  feature_criterion_evidence: FEATURE_CRITERION_EVIDENCE_SCHEMA,
  slice_verification_receipt: "work.feature-verification-receipt/v1",
  verification_receipt: "work.feature-verification-receipt/v1",
  candidate_capture_receipt: FEATURE_CAPTURE_RECEIPT_SCHEMA,
  critique_observation: "flow.delegate-evidence/v1",
  review_candidate_receipt: "flow.feature-seal-receipt/v1",
});

const PROMISED_OUTCOMES = Object.freeze([
  "one accepted brief becomes one immutable verified local review candidate",
  "verification receipts and critique findings are retained by registered operations",
]);

const TRUST_POSTURE = Object.freeze({
  schema: "flow.feature-trust-posture/v1",
  evidence: "registered_operations_only",
  delegation: "bounded_implementation_and_independent_critique_only",
  publication: "local_review_candidate_only",
});

const FEATURE_APPLY_OUTPUTS = Object.freeze([
  "workspace_mutation_observation",
  "feature_criterion_evidence",
]);
const FEATURE_APPLY_PROMPT =
  "apply the accepted brief in the exact fenced workspace; return " +
  "feature_criterion_evidence/v1 with one Git-backed observation for every " +
  "acceptance criterion";

/**
 * Return the trusted feature/v1 definition used by FlowRuntime's predefined
 * selection Interface.  It emits a finite graph only; execution remains the
 * responsibility of registered operation adapters and RunAuthority.
 */
export function createFeatureDefinition({ independentCritique = false } = {}) {
  if (typeof independentCritique !== "boolean") {
    throw new TypeError("feature definition independentCritique must be boolean");
  }
  return {
    schema: FEATURE_DEFINITION_SCHEMA,
    id: "feature/v1",
    contract: "flow.definition/feature/v1",
    promised_outcomes: [...PROMISED_OUTCOMES],
    negative_outcomes: [FEATURE_NEGATIVE_OUTCOME],
    trust_posture: { ...TRUST_POSTURE },
    required_authorities: SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
    compile(selection) {
      return compileFeatureSelection(selection, { independentCritique });
    },
  };
}

function compileFeatureSelection(
  { inputs, explicit_facts: explicitFacts },
  { independentCritique = false } = {},
) {
  const selection = validateFeatureInputs(inputs, explicitFacts);
  const workspaceClaim = {
    kind: "workspace",
    id: selection.workspace.subject_id,
    generation: selection.workspace.generation,
    mutation_epoch: selection.workspace.mutation_epoch,
    fingerprint: selection.workspace.fingerprint,
  };
  const cards = featureCards(selection, workspaceClaim, { independentCritique });
  const resultBindings = featureResultBindings(cards);
  validateFeatureResultBindings(cards, resultBindings);
  const repairs = validateFeatureRepairCards(
    selection,
    cards,
    explicitFacts.limits,
    resultBindings,
  );

  // A predefined compiler may only carry the selected facts through.  In
  // particular, it must not manufacture a generation, epoch, route, or
  // verification observation behind the caller's back.
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards,
      result_bindings: resultBindings,
    },
    requested_authority: {
      commands: [
        "cancel",
        "delegate_execute",
        "operation_execute",
        "terminal_disposition",
        ...(repairs.length > 0 ? ["revision_decision"] : []),
        ...(repairs.some(({ template }) =>
          template.changes.add_cards.some(({ executor }) =>
            executor?.kind === "checkpoint"),
        ) ? ["checkpoint_decision"] : []),
      ],
      capabilities: featureDelegateCapabilities(selection),
      mutations: featureOperationContracts(selection),
    },
    explicit_facts: explicitFacts,
    revision_templates: repairs.map(({ template }) => template),
  };
}

function featureDelegateCapabilities(selection) {
  return [...new Set([
    selection.delegation.apply,
    selection.delegation.critique,
  ].flatMap(({ description }) => {
    const capability = description?.launch?.capability;
    if (capability === undefined) return [];
    const grants = flowGrantIdsForDrovrCapability(capability);
    return grants ?? [];
  }))].sort();
}

function featureOperationContracts(selection) {
  const contracts = [FEATURE_OPERATION_CONTRACTS.capture,
    FEATURE_OPERATION_CONTRACTS.verify,
    FEATURE_OPERATION_CONTRACTS.seal];
  if (selection.setup !== null) contracts.unshift(FEATURE_OPERATION_CONTRACTS.setup);
  if (selection.slices.some(({ mode }) => mode === "test")) {
    contracts.unshift(FEATURE_OPERATION_CONTRACTS.test);
  }
  return contracts;
}

function featureCards(selection, workspaceClaim, options = {}) {
  if (selection.serialized_slices) {
    return serializedFeatureCards(selection, workspaceClaim, options);
  }
  return legacyFeatureCards(selection, workspaceClaim, options);
}

function featureCardBuilders(selection, workspaceClaim) {
  const common = {
    outputs: ["flow.effect-receipt/v1"],
    success_criteria: ["registered_operation_receipt:succeeded"],
    validators: ["flow.validator/operation-receipt/v1"],
    data_references: [selection.brief.id],
    evidence_references: featureSelectionReferences(selection),
    route: null,
    limits: { max_attempts: 1 },
    resource_claims: [workspaceClaim],
    recovery: "caller_idempotent",
    executor: {
      kind: "operation",
      effect_classification: "caller_idempotent",
    },
  };
  const operation = (
    id,
    contract,
    dependencies,
    inputs,
    outputs,
    { resourceClaims = common.resource_claims } = {},
  ) => ({
    ...common,
    recovery: contract === FEATURE_OPERATION_CONTRACTS.capture
      ? "reconcilable"
      : common.recovery,
    id,
    executor: {
      ...common.executor,
      contract,
      effect_classification: contract === FEATURE_OPERATION_CONTRACTS.capture
        ? "reconcilable"
        : common.executor.effect_classification,
    },
    dependencies,
    inputs,
    outputs,
    resource_claims: resourceClaims,
  });
  const delegate = (id, dependencies, inputs, binding, outputs) => ({
    ...common,
    id,
    executor: {
      kind: "delegate",
      contract: "flow.delegated-agent-port/v1",
    },
    dependencies,
    inputs: {
      ...inputs,
      description: binding.description,
      prompt: inputs.prompt,
      wait_timeout_ms: 300_000,
      task_inputs: featureDelegateTaskInputs(inputs),
      resource_references: featureDelegateResourceReferences(
        id,
        inputs,
        workspaceClaim,
      ),
      output_requirements: {
        schema: DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
        format: "canonical-json",
        schemas: outputs,
        validator_contracts: [FEATURE_DELEGATE_OUTPUT_VALIDATOR],
      },
    },
    outputs,
    success_criteria: ["delegate_observation:accepted"],
    validators: [FEATURE_DELEGATE_OUTPUT_VALIDATOR],
    route: binding.route,
    limits: { max_attempts: 1 },
    recovery: "discover_then_dispatch_exact",
  });
  return { delegate, operation };
}

function featureDelegateTaskInputs(inputs) {
  return {
    schema: "flow.delegate-task-inputs/v1",
    flow: "feature/v1",
    phase: inputs.phase,
    mode: inputs.mode,
    brief: inputs.brief,
    ...(inputs.slice === undefined ? {} : { slice: inputs.slice }),
  };
}

function featureDelegateResourceReferences(id, inputs, workspaceClaim) {
  return [{
    schema: DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA,
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: workspaceClaim.id,
    generation: workspaceClaim.generation,
    mutation_epoch: workspaceClaim.mutation_epoch,
    fingerprint: workspaceClaim.fingerprint,
    access: inputs.phase === "apply" ? "mutation" : "read_only",
    ...(inputs.phase === "apply" ? { operation: id } : {}),
    authority_binding_id: "resource:facts",
  }];
}

function legacyFeatureCards(
  selection,
  workspaceClaim,
  { independentCritique = false } = {},
) {
  const { delegate, operation } = featureCardBuilders(selection, workspaceClaim);
  const shared = {
    brief: selection.brief,
    mode: selection.mode,
    workspace: selection.workspace,
    ...featureSelectionInputs(selection),
  };
  const capture = operation(
    "feature-capture",
    FEATURE_OPERATION_CONTRACTS.capture,
    ["feature-apply"],
    {
      ...shared,
      phase: "capture",
      capture_policy: featureCapturePolicy(selection),
      receipt_owner: "registered_operation",
      provider_receipt_validator: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    },
    ["candidate_capture_receipt"],
    { resourceClaims: [] },
  );
  const apply = delegate(
      "feature-apply",
      [],
      {
        ...shared,
        phase: "apply",
        prompt: FEATURE_APPLY_PROMPT,
      },
      selection.delegation.apply,
      FEATURE_APPLY_OUTPUTS,
    );
  const critique = delegate(
      "feature-critique",
      independentCritique
        ? ["feature-apply", "feature-capture"]
        : ["feature-apply", "feature-capture", "feature-verify"],
      {
        ...shared,
        phase: "critique",
        prompt: FEATURE_CRITIQUE_PROMPT,
        critique_output_schema: FEATURE_CRITIQUE_OUTPUT_SCHEMA,
        critique_input_binding_schema: AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
        ...(independentCritique ? { independent_critique: true } : {}),
        delegate_evidence_card_ids: ["feature-apply"],
        operation_evidence_card_ids: ["feature-capture"],
      },
      selection.delegation.critique,
      ["critique_observation"],
    );
  const verify = operation(
      "feature-verify",
      FEATURE_OPERATION_CONTRACTS.verify,
      independentCritique ? ["feature-critique"] : ["feature-capture"],
      {
        ...shared,
        phase: "verify",
        receipt_owner: "registered_operation",
        provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
        delegate_output_usage: "evidence_input_only",
        ...(independentCritique ? { independent_critique: true } : {}),
        delegate_evidence_card_ids: [
          independentCritique ? "feature-critique" : "feature-apply",
        ],
        operation_evidence_card_ids: ["feature-capture"],
      },
      ["verification_receipt"],
    );
  const seal = operation(
      "feature-seal",
      FEATURE_OPERATION_CONTRACTS.seal,
      independentCritique ? ["feature-verify"] : ["feature-critique"],
      {
        ...shared,
        phase: "seal",
        negative_outcomes: [FEATURE_NEGATIVE_OUTCOME],
        receipt_owner: "registered_operation",
        delegate_output_usage: "evidence_input_only",
        ...(independentCritique ? { independent_critique: true } : {}),
        delegate_evidence_card_ids: ["feature-apply", "feature-critique"],
        operation_evidence_card_ids: ["feature-capture", "feature-verify"],
        capture_policy: featureCapturePolicy(selection),
        ...featureFinalizationInputs(selection),
      },
      ["review_candidate_receipt"],
    );
  return independentCritique
    ? [apply, capture, critique, verify, seal]
    : [apply, capture, verify, critique, seal];
}

function serializedFeatureCards(
  selection,
  workspaceClaim,
  { independentCritique = false } = {},
) {
  const { delegate, operation } = featureCardBuilders(selection, workspaceClaim);
  const shared = {
    brief: selection.brief,
    mode: selection.mode,
    slices: selection.slices,
    workspace: selection.workspace,
    ...featureSelectionInputs(selection),
  };
  const cards = [];
  let dependency = null;
  if (selection.setup !== null) {
    const setupCard = operation(
      "feature-setup",
      FEATURE_OPERATION_CONTRACTS.setup,
      [],
      {
        ...shared,
        phase: "setup",
        setup: selection.setup,
        receipt_owner: "registered_operation",
        evidence_role: "setup_only",
      },
      ["setup_receipt"],
    );
    cards.push(setupCard);
    dependency = setupCard.id;
  }

  const testCardIds = [];
  const verificationCardIds = [];
  const applyCardIds = [];
  const plannedApplyCardIds = selection.slices.map((slice, index) =>
    index === 0 ? "feature-apply" : `feature-apply-${slice.id}`);
  const applyManagedAgent = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "feature-apply-slices",
    card_ids: plannedApplyCardIds,
    terminal_card_id: plannedApplyCardIds.at(-1),
  };
  for (const slice of selection.slices) {
    const sliceTestCardIds = [];
    if (slice.mode === "test") {
      const testCard = operation(
        `feature-slice-${slice.id}-test`,
        FEATURE_OPERATION_CONTRACTS.test,
        dependency === null ? [] : [dependency],
        {
          ...shared,
          phase: "test_before",
          slice,
          setup_card_id: selection.setup === null ? null : "feature-setup",
          receipt_owner: "registered_operation",
          evidence_role: "intended_failure_only",
          provider_receipt_validator: FEATURE_TEST_RECEIPT_VALIDATOR,
          operation_evidence_card_ids: [...verificationCardIds],
        },
        ["test_failure_receipt"],
      );
      cards.push(testCard);
      testCardIds.push(testCard.id);
      sliceTestCardIds.push(testCard.id);
      dependency = testCard.id;
    }

    const applyId = applyCardIds.length === 0
      ? "feature-apply"
      : `feature-apply-${slice.id}`;
    const apply = delegate(
      applyId,
      dependency === null
        ? []
        : [
            dependency,
            ...(applyCardIds.length === 0 ? [] : [applyCardIds.at(-1)]),
          ],
      {
        ...shared,
        phase: "apply",
        slice,
        mutation_owner: applyId,
        prompt: FEATURE_APPLY_PROMPT,
        test_card_ids: [...testCardIds],
        managed_agent: applyManagedAgent,
      },
      selection.delegation.apply,
      FEATURE_APPLY_OUTPUTS,
    );
    cards.push(apply);
    applyCardIds.push(apply.id);
    dependency = apply.id;

    const captureCard = operation(
      `feature-capture-${slice.id}`,
      FEATURE_OPERATION_CONTRACTS.capture,
      [dependency],
      {
        ...shared,
        phase: "slice_capture",
        slice,
        capture_policy: featureCapturePolicy(selection),
        receipt_owner: "registered_operation",
        provider_receipt_validator: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
      },
      ["candidate_capture_receipt"],
      { resourceClaims: [] },
    );
    cards.push(captureCard);
    dependency = captureCard.id;

    const verifyCard = operation(
      `feature-slice-${slice.id}-verify`,
      FEATURE_OPERATION_CONTRACTS.verify,
      [dependency],
      {
        ...shared,
        phase: "slice_verify",
        slice,
        receipt_owner: "registered_operation",
        provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
        delegate_evidence_card_ids: [...applyCardIds],
        operation_evidence_card_ids: [
          ...sliceTestCardIds,
          captureCard.id,
        ],
        test_card_ids: [...sliceTestCardIds],
        mutation_owner: apply.id,
      },
      ["slice_verification_receipt"],
    );
    cards.push(verifyCard);
    verificationCardIds.push(verifyCard.id);
    dependency = verifyCard.id;
  }

  const aggregateCapture = operation(
    "feature-capture",
    FEATURE_OPERATION_CONTRACTS.capture,
    [dependency],
    {
      ...shared,
      phase: "capture",
      capture_policy: featureCapturePolicy(selection),
      receipt_owner: "registered_operation",
      provider_receipt_validator: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    },
    ["candidate_capture_receipt"],
    { resourceClaims: [] },
  );
  cards.push(aggregateCapture);
  const aggregateCaptureCardId = aggregateCapture.id;
  dependency = aggregateCaptureCardId;

  const critique = delegate(
    "feature-critique",
    independentCritique
      ? [...applyCardIds, aggregateCaptureCardId]
      : [...applyCardIds, aggregateCaptureCardId, "feature-verify"],
    {
      ...shared,
      phase: "critique",
      prompt: FEATURE_CRITIQUE_PROMPT,
      critique_output_schema: FEATURE_CRITIQUE_OUTPUT_SCHEMA,
      critique_input_binding_schema: AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
      ...(independentCritique ? { independent_critique: true } : {}),
      delegate_evidence_card_ids: [...applyCardIds],
      operation_evidence_card_ids: [aggregateCaptureCardId],
    },
    selection.delegation.critique,
    ["critique_observation"],
  );

  if (independentCritique) cards.push(critique);

  cards.push(operation(
    "feature-verify",
    FEATURE_OPERATION_CONTRACTS.verify,
    independentCritique ? [critique.id] : [dependency],
    {
      ...shared,
      phase: "verify",
      receipt_owner: "registered_operation",
      provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
      delegate_output_usage: "evidence_input_only",
      ...(independentCritique ? { independent_critique: true } : {}),
      delegate_evidence_card_ids: independentCritique
        ? [critique.id]
        : [...applyCardIds],
      operation_evidence_card_ids: [
        ...testCardIds,
        ...verificationCardIds,
        aggregateCaptureCardId,
      ],
      evidence_role: "slice_aggregate",
    },
    ["verification_receipt"],
  ));

  if (!independentCritique) cards.push(critique);

  cards.push(operation(
    "feature-seal",
    FEATURE_OPERATION_CONTRACTS.seal,
    independentCritique ? ["feature-verify"] : ["feature-critique"],
    {
      ...shared,
      phase: "seal",
      capture_policy: featureCapturePolicy(selection),
      ...featureFinalizationInputs(selection),
      ...(independentCritique ? { independent_critique: true } : {}),
      negative_outcomes: [FEATURE_NEGATIVE_OUTCOME],
      receipt_owner: "registered_operation",
      delegate_output_usage: "evidence_input_only",
      delegate_evidence_card_ids: [...applyCardIds, "feature-critique"],
      operation_evidence_card_ids: [
        aggregateCaptureCardId,
        ...testCardIds,
        ...verificationCardIds,
        "feature-verify",
      ],
    },
    ["review_candidate_receipt"],
  ));
  return cards;
}

function validateFeatureInputs(inputs, explicitFacts) {
  if (!isRecord(inputs) ||
      !isRecord(inputs.brief) ||
      inputs.brief.schema !== "flow.feature-brief/v1" ||
      typeof inputs.brief.id !== "string" ||
      !inputs.brief.id ||
      typeof inputs.brief.summary !== "string" ||
      !inputs.brief.summary ||
      !Array.isArray(inputs.brief.acceptance) ||
      inputs.brief.acceptance.length === 0 ||
      !inputs.brief.acceptance.every((criterion) =>
        typeof criterion === "string" && criterion.length > 0)) {
    invalidFeature("invalid_brief", "feature/v1 requires one accepted brief");
  }
  if (!FEATURE_SELECTION_MODE.has(inputs.mode)) {
    invalidFeature(
      "invalid_mode",
      "feature/v1 mode must be verify, test, or mixed",
    );
  }
  const workspace = inputs.workspace;
  if (!isRecord(workspace) ||
      workspace.schema !== "flow.feature-workspace-binding/v1" ||
      typeof workspace.subject_id !== "string" ||
      !workspace.subject_id ||
      !Number.isSafeInteger(workspace.generation) || workspace.generation < 1 ||
      !Number.isSafeInteger(workspace.mutation_epoch) ||
      workspace.mutation_epoch < 1 ||
      !isDigest(workspace.fingerprint)) {
    invalidFeature(
      "invalid_workspace_binding",
      "feature/v1 requires an exact generation-fenced workspace binding",
    );
  }
  if (inputs.finalization === undefined &&
      (!validFeatureGitFacts(workspace.git) ||
       workspace.git.clean !== true ||
       workspace.fingerprint !== digest({ git: workspace.git }))) {
    invalidFeature(
      "missing_starting_git_facts",
      "feature/v1 identity-free preparation requires exact starting Git facts",
    );
  }
  const slices = validateFeatureSlices(inputs.slices, inputs.mode, inputs.brief);
  const testSelection = slices.some(({ mode }) => mode === "test")
    ? buildFeatureTestSelection(slices)
    : null;
  const verification = inputs.verification;
  const verificationRequired = inputs.mode !== "test";
  if (verification === undefined && verificationRequired) {
    invalidFeature(
      "missing_verification_evidence",
      "feature/v1 verify and mixed modes require explicit verification evidence",
    );
  }
  if (verification !== undefined && (!isRecord(verification) ||
      verification.schema !== "flow.feature-verification-request/v1")) {
    invalidFeature(
      "invalid_verification_evidence",
      "feature/v1 verification evidence must use its registered request schema",
    );
  }
  const baseline = verification?.baseline;
  const compensating = verification?.compensating_assertion;
  const baselinePresent = verification !== undefined &&
    Object.hasOwn(verification, "baseline");
  const compensatingPresent = verification !== undefined &&
    Object.hasOwn(verification, "compensating_assertion");
  const testOnlyWithoutVerification = inputs.mode === "test" &&
    isRecord(verification) &&
    verification.schema === "flow.feature-verification-request/v1" &&
    !baselinePresent && !compensatingPresent;
  const hasBaseline = isRecord(baseline) &&
    baseline.schema === "flow.feature-safe-baseline/v1" &&
    typeof baseline.assertion === "string" && baseline.assertion.length > 0 &&
    isDigest(baseline.fingerprint);
  const hasCompensating = isRecord(compensating) &&
    compensating.schema === "flow.feature-compensating-assertion/v1" &&
    typeof compensating.assertion === "string" &&
    compensating.assertion.length > 0 &&
    compensating.non_destructive === true &&
    isDigest(compensating.fingerprint);
  if (baselinePresent && compensatingPresent) {
    invalidFeature(
      "ambiguous_discriminating_evidence",
      "feature/v1 requires exactly one safe baseline or compensating assertion",
    );
  }
  if (verification !== undefined && !testOnlyWithoutVerification &&
      (baselinePresent !== hasBaseline ||
      compensatingPresent !== hasCompensating ||
      !hasBaseline && !hasCompensating)) {
    invalidFeature(
      "missing_discriminating_evidence",
      "feature/v1 requires a safe baseline or non-destructive compensating assertion",
    );
  }
  const verifySliceIndexes = slices.flatMap(({ mode }, index) =>
    mode === "verify" ? [index] : []);
  if (inputs.slices !== undefined && hasBaseline &&
      verifySliceIndexes.length > 0 &&
      (verifySliceIndexes.length !== 1 || verifySliceIndexes[0] !== 0 ||
       baseline.fingerprint !== workspace.fingerprint)) {
    invalidFeature(
      "unreachable_safe_baseline_slice",
      "feature/v1 serialized safe baseline must select the first and only verify slice at the current workspace fingerprint",
    );
  }
  const setup = validateFeatureSetup(inputs.setup);
  if (setup !== null && inputs.slices === undefined) {
    invalidFeature(
      "setup_requires_slices",
      "feature/v1 setup requires explicit slices",
    );
  }
  const delegation = validateDelegationBindings(inputs.delegation, explicitFacts);
  const finalization = validateFeatureFinalization(inputs.finalization, workspace);
  const capturePolicy = validateFeatureCapturePolicy(
    inputs.capture_policy,
    workspace,
    finalization,
  );
  const repairs = validateFeatureRepairs(inputs.repairs, inputs.brief, explicitFacts);
  const evidence = hasBaseline ? baseline : compensating;
  const normalized = {
    brief: inputs.brief,
    mode: inputs.mode,
    slices,
    serialized_slices: inputs.slices !== undefined ||
      inputs.mode !== "verify" || setup !== null,
    setup,
    workspace,
    ...(verification === undefined || testOnlyWithoutVerification ? {} : {
      verification: {
        ...verification,
        evidence_id: `${verification.schema}:${evidence.fingerprint}`,
      },
    }),
    ...(testSelection === null ? {} : { test_selection: testSelection }),
    repairs,
    delegation,
    ...(capturePolicy === null ? {} : { capture_policy: capturePolicy }),
    ...(finalization === null ? {} : { finalization }),
  };
  return freezeCanonical(normalized);
}

function buildFeatureTestSelection(slices) {
  const testSlices = slices.filter(({ mode }) => mode === "test").map((slice) => ({
    id: slice.id,
    acceptance: [...slice.acceptance],
    intended_failure: slice.test.intended_failure,
    environment_fingerprint: slice.test.environment_fingerprint,
    environment_status: slice.test.environment_status,
  }));
  const identity = {
    schema: "flow.feature-test-selection/v1",
    slices: testSlices,
  };
  const fingerprint = digest(identity);
  return {
    ...identity,
    fingerprint,
    evidence_id: `${identity.schema}:${fingerprint}`,
  };
}

function validateFeatureRepairs(rawRepairs, brief, explicitFacts) {
  if (rawRepairs === undefined) return [];
  if (!Array.isArray(rawRepairs) || rawRepairs.length === 0) {
    invalidFeature(
      "invalid_feature_repairs",
      "feature/v1 repairs must be a non-empty serialized list when declared",
    );
  }
  const ids = new Set();
  return rawRepairs.map((repair, index) => {
    if (!isRecord(repair) ||
        repair.schema !== "flow.feature-repair/v1" ||
        typeof repair.id !== "string" || !repair.id || ids.has(repair.id) ||
        !FEATURE_REPAIR_KINDS.has(repair.kind) ||
        typeof repair.card_id !== "string" || !repair.card_id ||
        !Array.isArray(repair.acceptance) || repair.acceptance.length === 0 ||
        !repair.acceptance.every((criterion) =>
          typeof criterion === "string" && criterion.length > 0) ||
        new Set(repair.acceptance).size !== repair.acceptance.length ||
        !Array.isArray(repair.remaining_scope) ||
        repair.remaining_scope.length === 0 ||
        !repair.remaining_scope.every((scope) =>
          typeof scope === "string" && scope.length > 0) ||
        new Set(repair.remaining_scope).size !== repair.remaining_scope.length) {
      invalidFeature(
        "invalid_feature_repair",
        `feature/v1 repair ${index + 1} is not an exact acceptance and scope mapping`,
      );
    }
    ids.add(repair.id);
    if (repair.scope_expansion !== undefined &&
        typeof repair.scope_expansion !== "boolean") {
      invalidFeature(
        "invalid_feature_repair",
        `feature/v1 repair ${repair.id} scope expansion must be boolean`,
      );
    }
    const template = repair.template ?? repair.revision_template;
    if (!isRecord(template) ||
        template.schema !== "flow.plan-revision-template/v1" ||
        typeof template.id !== "string" || !template.id) {
      invalidFeature(
        "invalid_feature_repair_template",
        `feature/v1 repair ${repair.id} requires one exact revision template`,
      );
    }
    const observation = (explicitFacts?.block_observations ?? []).find((entry) =>
      entry?.card_id === repair.card_id &&
      entry.block?.revision_template_ids?.includes(template.id));
    if (observation === undefined) {
      invalidFeature(
        "missing_feature_repair_block",
        `feature/v1 repair ${repair.id} is not bound to an exact card block`,
      );
    }
    const checkpointId = repair.checkpoint_id ?? null;
    const normalized = {
      schema: "flow.feature-repair/v1",
      id: repair.id,
      kind: repair.kind,
      card_id: repair.card_id,
      acceptance: [...repair.acceptance],
      remaining_scope: [...repair.remaining_scope],
      scope_expansion: repair.scope_expansion ?? false,
      checkpoint_id: checkpointId,
    };
    return {
      ...normalized,
      template: {
        ...template,
        repair: normalized,
      },
    };
  });
}

function featureSelectionInputs(selection) {
  return {
    ...(selection.verification === undefined ? {} : {
      verification: selection.verification,
    }),
    ...(selection.test_selection === undefined ? {} : {
      test_selection: selection.test_selection,
    }),
  };
}

function featureFinalizationInputs(selection) {
  return selection.finalization === undefined
    ? {}
    : {
        finalization: selection.finalization,
        publication: selection.finalization.publication,
      };
}

function featureCapturePolicy(selection) {
  if (selection.capture_policy !== undefined) {
    return selection.capture_policy;
  }
  const publication = selection.finalization?.publication;
  return {
    schema: FEATURE_CAPTURE_POLICY_SCHEMA,
    starting_workspace: selection.workspace,
    ...(selection.workspace.git === undefined ? {} : {
      starting_git: selection.workspace.git,
    }),
    permitted_transformations: ["accepted_brief"],
    validation_contract: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    retention: publication?.retention ?? "local_candidate",
    disposition: publication?.workspace?.disposition ?? "retained_for_handoff",
    publication_policy: {
      subject: publication?.subject ?? {
        contract: "work.workspace/v1",
        subject_id: selection.workspace.subject_id,
      },
      allowed_consumer_operations:
        publication?.allowed_consumer_operations ?? ["read_workspace"],
      consumer_operation_authority:
        publication?.consumer_operation_authority ?? [{
          operation: "read_workspace",
          access: "read_only",
        }],
      authority_envelope: publication?.authority_envelope ?? {
        capabilities: ["repository:read"],
      },
      cleanup_obligations: publication?.cleanup_obligations ?? [
        "retain_artifact_bytes",
      ],
      intended_consumer: publication?.intended_consumer ?? null,
    },
  };
}

function validateFeatureCapturePolicy(rawPolicy, workspace, finalization) {
  if (rawPolicy === undefined) return null;
  if (finalization !== null) {
    invalidFeature(
      "capture_policy_legacy_conflict",
      "feature/v1 capture policy is only an identity-free preparation input",
    );
  }
  if (!isRecord(rawPolicy) ||
      Object.keys(rawPolicy).sort().join(",") !==
        "disposition,permitted_transformations,publication_policy,retention,schema,starting_git,starting_workspace,validation_contract" ||
      rawPolicy.schema !== FEATURE_CAPTURE_POLICY_SCHEMA ||
      !isRecord(rawPolicy.starting_workspace) ||
      !hasExactKeys(rawPolicy.starting_workspace, [
        "fingerprint",
        "generation",
        "git",
        "mutation_epoch",
        "schema",
        "subject_id",
      ]) ||
      digest(rawPolicy.starting_workspace) !== digest(workspace) ||
      !validFeatureGitFacts(rawPolicy.starting_git) ||
      rawPolicy.starting_git.clean !== true ||
      digest(rawPolicy.starting_git) !== digest(workspace.git) ||
      !Array.isArray(rawPolicy.permitted_transformations) ||
      rawPolicy.permitted_transformations.length !== 1 ||
      rawPolicy.permitted_transformations[0] !== "accepted_brief" ||
      rawPolicy.validation_contract !== FEATURE_CAPTURE_RECEIPT_VALIDATOR ||
      typeof rawPolicy.retention !== "string" || rawPolicy.retention.length === 0 ||
      typeof rawPolicy.disposition !== "string" || rawPolicy.disposition.length === 0 ||
      !isRecord(rawPolicy.publication_policy) ||
      Object.keys(rawPolicy.publication_policy).sort().join(",") !==
        "allowed_consumer_operations,authority_envelope,cleanup_obligations,consumer_operation_authority,intended_consumer,subject" ||
      !isRecord(rawPolicy.publication_policy.subject) ||
      Object.keys(rawPolicy.publication_policy.subject).sort().join(",") !==
        "contract,subject_id" ||
      rawPolicy.publication_policy.subject.contract !== "work.workspace/v1" ||
      rawPolicy.publication_policy.subject.subject_id !== workspace.subject_id ||
      !Array.isArray(rawPolicy.publication_policy.allowed_consumer_operations) ||
      rawPolicy.publication_policy.allowed_consumer_operations.length === 0 ||
      new Set(rawPolicy.publication_policy.allowed_consumer_operations).size !==
        rawPolicy.publication_policy.allowed_consumer_operations.length ||
      !rawPolicy.publication_policy.allowed_consumer_operations.every((operation) =>
        typeof operation === "string" && operation.length > 0) ||
      !Array.isArray(rawPolicy.publication_policy.consumer_operation_authority) ||
      rawPolicy.publication_policy.consumer_operation_authority.length !==
        rawPolicy.publication_policy.allowed_consumer_operations.length ||
      !isRecord(rawPolicy.publication_policy.authority_envelope) ||
      !Array.isArray(rawPolicy.publication_policy.cleanup_obligations) ||
      rawPolicy.publication_policy.cleanup_obligations.length === 0 ||
      !rawPolicy.publication_policy.cleanup_obligations.every((obligation) =>
        typeof obligation === "string" && obligation.length > 0) ||
      rawPolicy.publication_policy.intended_consumer !== null &&
        typeof rawPolicy.publication_policy.intended_consumer !== "string" ||
      rawPolicy.publication_policy.consumer_operation_authority.some((entry) =>
        !isRecord(entry) ||
        Object.keys(entry).sort().join(",") !== "access,operation" ||
        !rawPolicy.publication_policy.allowed_consumer_operations.includes(entry.operation) ||
        !["read_only", "mutation"].includes(entry.access))) {
    invalidFeature(
      "invalid_feature_capture_policy",
      "feature/v1 capture policy is not an exact identity-free preparation policy",
    );
  }
  const operations = [...rawPolicy.publication_policy.allowed_consumer_operations]
    .sort();
  const authorityByOperation = new Map(
    rawPolicy.publication_policy.consumer_operation_authority.map((entry) => [
      entry.operation,
      entry,
    ]),
  );
  if (authorityByOperation.size !== operations.length ||
      operations.some((operation) => !authorityByOperation.has(operation))) {
    invalidFeature(
      "invalid_feature_capture_policy",
      "feature/v1 capture policy must bind each consumer operation exactly once",
    );
  }
  return freezeCanonical({
    schema: FEATURE_CAPTURE_POLICY_SCHEMA,
    starting_workspace: workspace,
    starting_git: rawPolicy.starting_git,
    permitted_transformations: ["accepted_brief"],
    validation_contract: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    retention: rawPolicy.retention,
    disposition: rawPolicy.disposition,
    publication_policy: {
      subject: rawPolicy.publication_policy.subject,
      allowed_consumer_operations: operations,
      consumer_operation_authority: operations.map((operation) =>
        authorityByOperation.get(operation)),
      authority_envelope: rawPolicy.publication_policy.authority_envelope,
      cleanup_obligations: [...rawPolicy.publication_policy.cleanup_obligations],
      intended_consumer: rawPolicy.publication_policy.intended_consumer,
    },
  });
}

function featureResultBindings(cards) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  return cards.flatMap((consumer) => {
    const producerCardIds = featureEvidenceCardIds(consumer);
    return producerCardIds.map((producerCardId) => {
      const producer = cardsById.get(producerCardId);
      const outputContract = producer?.outputs.find((output) =>
        FEATURE_OUTPUT_SCHEMAS[output] !== undefined);
      if (outputContract === undefined) {
        invalidFeature(
          "invalid_feature_result_binding",
          `feature/v1 evidence producer has no registered output: ${producerCardId}`,
        );
      }
      return featureResultBinding(
        consumer.id,
        producerCardId,
        outputContract,
      );
    });
  }).sort((left, right) => {
    const leftKey = `${left.consumer_card_id}\0${left.producer_card_id}`;
    const rightKey = `${right.consumer_card_id}\0${right.producer_card_id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function featureResultBinding(consumerCardId, producerCardId, outputContract) {
  const expectedSchema = FEATURE_OUTPUT_SCHEMAS[outputContract];
  if (expectedSchema === undefined) {
    invalidFeature(
      "unknown_feature_output_contract",
      `feature/v1 output contract is not registered: ${outputContract}`,
    );
  }
  return createResultBinding({
    consumerCardId,
    producerCardId,
    outputContract,
    expectedSchema,
  });
}

function validateFeatureResultBindings(cards, bindings) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  if (!Array.isArray(bindings)) {
    invalidFeature(
      "invalid_feature_result_bindings",
      "feature/v1 result bindings must be a serialized list",
    );
  }
  const bindingKeys = new Set();
  for (const binding of bindings) {
    if (!isResultBinding(binding)) {
      invalidFeature(
        "invalid_feature_result_binding",
        "feature/v1 result binding is incomplete or not exact",
      );
    }
    const consumer = cardsById.get(binding.consumer_card_id);
    const producer = cardsById.get(binding.producer_card_id);
    const key = `${binding.consumer_card_id}:${binding.producer_card_id}:` +
      binding.output_contract;
    if (consumer === undefined || producer === undefined ||
        consumer.id === producer.id || bindingKeys.has(key) ||
        !producer.outputs.includes(binding.output_contract) ||
        FEATURE_OUTPUT_SCHEMAS[binding.output_contract] !==
          binding.expected_schema ||
        !featureEvidenceCardIds(consumer).includes(binding.producer_card_id) ||
        !hasDependencyPath(cardsById, consumer.id, producer.id)) {
      invalidFeature(
        "invalid_feature_result_binding",
        "feature/v1 result binding does not name an exact producer",
      );
    }
    bindingKeys.add(key);
  }
  for (const card of cards) {
    for (const producerCardId of featureEvidenceCardIds(card)) {
      if (!bindings.some((binding) =>
        binding.consumer_card_id === card.id &&
        binding.producer_card_id === producerCardId)) {
        invalidFeature(
          "missing_feature_result_binding",
          `feature/v1 evidence must name an explicit result binding: ${card.id}`,
        );
      }
    }
  }
}

function featureEvidenceCardIds(card) {
  return [...new Set([
    ...(card.inputs.delegate_evidence_card_ids ?? []),
    ...(card.inputs.operation_evidence_card_ids ?? []),
    ...(card.inputs.test_card_ids ?? []),
  ])].sort();
}

function hasDependencyPath(cardsById, consumerCardId, producerCardId) {
  const seen = new Set();
  const visit = (cardId) => {
    if (cardId === producerCardId) return true;
    if (seen.has(cardId)) return false;
    seen.add(cardId);
    const card = cardsById.get(cardId);
    return card !== undefined && card.dependencies.some(visit);
  };
  return visit(consumerCardId);
}

function validateFeatureRepairCards(
  selection,
  cards,
  limits,
  existingResultBindings,
) {
  return selection.repairs.map((repairEntry) => {
    const result = validateFeatureRepairContract({
      repair: repairEntry.template.repair,
      template: repairEntry.template,
      existingCards: cards,
      existingResultBindings,
      brief: selection.brief,
      limits,
      bindCheckpoint: true,
      fail: invalidFeature,
    });
    return { ...repairEntry, template: result.template };
  });
}

function featureSelectionReferences(selection) {
  return [
    ...(selection.verification === undefined
      ? []
      : [selection.verification.evidence_id]),
    ...(selection.test_selection === undefined
      ? []
      : [selection.test_selection.evidence_id]),
  ];
}

function validateFeatureSlices(rawSlices, mode, brief) {
  if (rawSlices === undefined) {
    if (mode === "verify") return [];
    invalidFeature(
      "missing_feature_slices",
      "feature/v1 test and mixed modes require explicit serialized slices",
    );
  }
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) {
    invalidFeature(
      "invalid_feature_slices",
      "feature/v1 slices must be a non-empty serialized list",
    );
  }
  const ids = new Set();
  const slices = rawSlices.map((slice, index) => {
    if (!isRecord(slice) ||
        slice.schema !== "flow.feature-slice/v1" ||
        typeof slice.id !== "string" || !slice.id || ids.has(slice.id) ||
        !["test", "verify"].includes(slice.mode)) {
      invalidFeature(
        "invalid_feature_slice",
        `feature/v1 slice ${index + 1} is not an exact test-or-verify slice`,
      );
    }
    ids.add(slice.id);
    const acceptance = slice.acceptance;
    if (!Array.isArray(acceptance) || acceptance.length === 0 ||
        !acceptance.every((criterion) =>
          typeof criterion === "string" && criterion.length > 0)) {
      invalidFeature(
        "invalid_feature_slice",
        "feature/v1 slice acceptance must explicitly own every brief criterion exactly once",
      );
    }
    if (slice.mode === "test") {
      if (slice.test === undefined) {
        invalidFeature(
          "missing_test_request",
          `feature/v1 test slice ${slice.id} requires an explicit failure request`,
        );
      }
      return {
        ...slice,
        acceptance: [...acceptance],
        test: validateFeatureTestRequest(slice.test),
      };
    }
    if (slice.test !== undefined) {
      invalidFeature(
        "unexpected_test_request",
        `feature/v1 verify slice ${slice.id} cannot carry test evidence`,
      );
    }
    return { ...slice, acceptance: [...acceptance] };
  });
  const hasTest = slices.some(({ mode: sliceMode }) => sliceMode === "test");
  const hasVerify = slices.some(({ mode: sliceMode }) => sliceMode === "verify");
  if ((mode === "test" && (!hasTest || hasVerify)) ||
      (mode === "mixed" && (!hasTest || !hasVerify)) ||
      (mode === "verify" && hasTest)) {
    invalidFeature(
      "slice_mode_mismatch",
      "feature/v1 mode must match its serialized test-or-verify slices",
    );
  }
  const briefCriteria = new Set(brief.acceptance);
  const ownedCriteria = new Map();
  for (const slice of slices) {
    for (const criterion of slice.acceptance) {
      ownedCriteria.set(criterion, (ownedCriteria.get(criterion) ?? 0) + 1);
    }
  }
  if (slices.length > 0 && (briefCriteria.size !== brief.acceptance.length ||
      ownedCriteria.size !== briefCriteria.size ||
      [...ownedCriteria].some(([criterion, count]) =>
        !briefCriteria.has(criterion) || count !== 1) ||
      [...briefCriteria].some((criterion) => ownedCriteria.get(criterion) !== 1))) {
    invalidFeature(
      "invalid_feature_slice_acceptance",
      "feature/v1 slice acceptance must explicitly own every brief criterion exactly once",
    );
  }
  return slices;
}

function validateFeatureTestRequest(request) {
  if (!isRecord(request) ||
      request.schema !== "flow.feature-test-request/v1" ||
      typeof request.intended_failure !== "string" ||
      request.intended_failure.length === 0 ||
      !isDigest(request.environment_fingerprint) ||
      request.environment_status !== undefined &&
        request.environment_status !== "healthy") {
    invalidFeature(
      "invalid_test_request",
      "feature/v1 test mode requires an intended failure and healthy environment fingerprint",
    );
  }
  return {
    ...request,
    environment_status: request.environment_status ?? "healthy",
  };
}

function validateFeatureSetup(setup) {
  if (setup === undefined) return null;
  if (!isRecord(setup) ||
      setup.schema !== "flow.feature-setup/v1" ||
      typeof setup.id !== "string" || !setup.id ||
      typeof setup.description !== "string" || setup.description.length === 0 ||
      !isDigest(setup.fingerprint)) {
    invalidFeature(
      "invalid_feature_setup",
      "feature/v1 one-time setup must be explicit, identity-bound, and separate",
    );
  }
  return { ...setup, evidence_role: "setup_only" };
}

function validateFeatureFinalization(finalization, selectedWorkspace) {
  if (finalization === undefined) return null;
  if (!isRecord(finalization) ||
      Object.keys(finalization).sort().join(",") !==
        "candidate_id,publication,schema" ||
      finalization.schema !== "flow.feature-finalization-binding/v1" ||
      typeof finalization.candidate_id !== "string" ||
      finalization.candidate_id.length === 0) {
    invalidFeature(
      "invalid_finalization_binding",
      "feature/v1 requires one selected finalization binding",
    );
  }
  const publication = finalization.publication;
  if (!isRecord(publication) ||
      Object.keys(publication).sort().join(",") !==
        "allowed_consumer_operations,artifacts,authority_envelope,cleanup_obligations,consumer_operation_authority,intended_consumer,retention,schema,subject,workspace" ||
      publication.schema !== "flow.resource-handoff-publication/v1" ||
      !isRecord(publication.workspace) ||
      Object.keys(publication.workspace).sort().join(",") !==
        "disposition,expected_generation,expected_git,expected_mutation_epoch,promoted_generation,promoted_git,promoted_mutation_epoch,subject_id" ||
      typeof publication.workspace.subject_id !== "string" ||
      publication.workspace.subject_id.length === 0 ||
      !Number.isSafeInteger(publication.workspace.expected_generation) ||
      publication.workspace.expected_generation < 1 ||
      !Number.isSafeInteger(publication.workspace.expected_mutation_epoch) ||
      publication.workspace.expected_mutation_epoch < 1 ||
      !Number.isSafeInteger(publication.workspace.promoted_generation) ||
      publication.workspace.promoted_generation < 1 ||
      !Number.isSafeInteger(publication.workspace.promoted_mutation_epoch) ||
      publication.workspace.promoted_mutation_epoch < 1 ||
      !validFeatureGitFacts(publication.workspace.expected_git) ||
      !validFeatureGitFacts(publication.workspace.promoted_git) ||
      typeof publication.workspace.disposition !== "string" ||
      publication.workspace.disposition.length === 0 ||
      !isRecord(publication.subject) ||
      Object.keys(publication.subject).sort().join(",") !== "contract,subject_id" ||
      publication.subject.contract !== "work.workspace/v1" ||
      publication.subject.subject_id !== publication.workspace.subject_id ||
      !Array.isArray(publication.artifacts) ||
      publication.artifacts.length === 0 ||
      publication.artifacts.some((artifact) =>
        !isRecord(artifact) ||
        Object.keys(artifact).sort().join(",") !== "digest,expected_generation" ||
        !isDigest(artifact.digest) ||
        !Number.isSafeInteger(artifact.expected_generation) ||
        artifact.expected_generation < 1) ||
      !Array.isArray(publication.allowed_consumer_operations) ||
      publication.allowed_consumer_operations.length === 0 ||
      !publication.allowed_consumer_operations.every((operation) =>
        typeof operation === "string" && operation.length > 0) ||
      !Array.isArray(publication.consumer_operation_authority) ||
      publication.consumer_operation_authority.length !==
        publication.allowed_consumer_operations.length ||
      publication.consumer_operation_authority.some((entry) =>
        !isRecord(entry) ||
        Object.keys(entry).sort().join(",") !== "access,operation" ||
        !publication.allowed_consumer_operations.includes(entry.operation) ||
        !["read_only", "mutation"].includes(entry.access)) ||
      !isRecord(publication.authority_envelope) ||
      typeof publication.retention !== "string" ||
      publication.retention.length === 0 ||
      !Array.isArray(publication.cleanup_obligations) ||
      !publication.cleanup_obligations.every((obligation) =>
        typeof obligation === "string" && obligation.length > 0) ||
      publication.intended_consumer !== null &&
        typeof publication.intended_consumer !== "string") {
    invalidFeature(
      "invalid_finalization_binding",
      "feature/v1 finalization publication is incomplete or not exact",
    );
  }
  const expectedFingerprint = digest({
    git: publication.workspace.expected_git,
  });
  const promotedFingerprint = digest({
    git: publication.workspace.promoted_git,
  });
  if (publication.workspace.subject_id !== selectedWorkspace.subject_id ||
      publication.workspace.expected_generation !== selectedWorkspace.generation ||
      publication.workspace.expected_mutation_epoch !==
        selectedWorkspace.mutation_epoch ||
      expectedFingerprint !== selectedWorkspace.fingerprint ||
      publication.workspace.expected_git.clean !== true ||
      publication.workspace.promoted_git.clean !== true ||
      publication.workspace.promoted_generation !==
        publication.workspace.expected_generation + 1 ||
      publication.workspace.promoted_mutation_epoch !==
        publication.workspace.expected_mutation_epoch + 1 ||
      expectedFingerprint === promotedFingerprint) {
    invalidFeature(
      "stale_or_unchanged_finalization",
      "feature/v1 finalization must bind and advance the selected clean workspace",
    );
  }
  return finalization;
}

function validFeatureGitFacts(git) {
  return isRecord(git) &&
    Object.keys(git).sort().join(",") === "clean,commit_sha,ref,tree_sha" &&
    /^[0-9a-f]{40,64}$/u.test(git.commit_sha ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(git.tree_sha ?? "") &&
    typeof git.ref === "string" && git.ref.length > 0 &&
    typeof git.clean === "boolean";
}

function validateDelegationBindings(delegation, explicitFacts) {
  if (!isRecord(delegation) ||
      delegation.schema !== "flow.feature-delegation-bindings/v1") {
    invalidFeature(
      "missing_delegate_bindings",
      "feature/v1 requires explicit immutable apply and critique routes",
    );
  }
  const apply = validateDelegateBinding(delegation.apply, "apply", explicitFacts);
  const critique = validateDelegateBinding(
    delegation.critique,
    "critique",
    explicitFacts,
  );
  if (apply.route.agent_id === critique.route.agent_id ||
      apply.description.description_digest ===
        critique.description.description_digest ||
      apply.description.comparison_keys.launch ===
        critique.description.comparison_keys.launch) {
    invalidFeature(
      "non_independent_critique_route",
      "feature/v1 critique must use an independently declared route",
    );
  }
  return { schema: delegation.schema, apply, critique };
}

function validateDelegateBinding(binding, role, explicitFacts) {
  if (!isRecord(binding) ||
      !isRecord(binding.description) ||
      binding.description.schema !== "drovr.delegated-agent-description/v1" ||
      !isDigest(binding.description.description_digest) ||
      !isDigest(binding.description.comparison_keys?.launch) ||
      !isDigest(binding.description.comparison_keys?.effective_authority) ||
      !isDigest(binding.description.watermark?.content_sha256) ||
      !isRecord(binding.route) ||
      Object.keys(binding.route).sort().join(",") !==
        "agent_id,configuration_watermark,description_digest,launch_comparison_key" ||
      typeof binding.route.agent_id !== "string" || !binding.route.agent_id ||
      binding.route.description_digest !== binding.description.description_digest ||
      binding.route.launch_comparison_key !== binding.description.comparison_keys.launch ||
      binding.route.configuration_watermark !==
        binding.description.watermark.content_sha256 ||
      !Array.isArray(binding.validators) ||
      binding.validators.length !== 1 ||
      binding.validators[0] !== FEATURE_DELEGATE_OUTPUT_VALIDATOR ||
      !explicitFacts.validator_contracts.includes(FEATURE_DELEGATE_OUTPUT_VALIDATOR)) {
    invalidFeature(
      "invalid_delegate_binding",
      `feature/v1 ${role} delegate binding is incomplete or not exact`,
    );
  }
  const { description_digest: ignoredDigest, ...descriptionIdentity } =
    binding.description;
  if (digest(descriptionIdentity) !== binding.description.description_digest) {
    invalidFeature(
      "invalid_delegate_binding",
      `feature/v1 ${role} delegate description is not digest-bound`,
    );
  }
  return binding;
}

function invalidFeature(reason, message) {
  throw new PredefinedFlowValidationError(reason, message);
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the provider evidence that establishes an honest test-before
 * observation.  This is intentionally a feature policy validator owned by the
 * registered feature-test adapter, not by the generic effect authority.
 */
export function validateFeatureTestReceipt(receipt, intent, expectedWorkspace = null) {
  const operationInput = intent?.operation_input;
  const slice = operationInput?.slice;
  const expected = expectedWorkspace ?? featureTestPreSliceWorkspace(intent);
  return isRecord(receipt) &&
    hasExactKeys(receipt, [
      "attempt_id",
      "effect_id",
      "environment_fingerprint",
      "environment_status",
      "idempotency_key",
      "intended_failure",
      "operation_contract",
      "outcome",
      "phase",
      "schema",
      "slice_id",
      "source_authority_watermark",
      "workspace",
    ]) &&
    receipt.schema === "work.feature-test-receipt/v1" &&
    receipt.attempt_id === intent?.attempt_id &&
    receipt.effect_id === intent?.effect_id &&
    receipt.idempotency_key === intent?.idempotency_key &&
    receipt.operation_contract === FEATURE_OPERATION_CONTRACTS.test &&
    receipt.source_authority_watermark === intent?.source_authority_watermark &&
    receipt.slice_id === slice?.id &&
    slice?.mode === "test" &&
    receipt.phase === "test_before" &&
    receipt.outcome === "expected_failure" &&
    receipt.intended_failure === slice.test?.intended_failure &&
    receipt.environment_status === "healthy" &&
    receipt.environment_fingerprint === slice.test?.environment_fingerprint &&
    isRecord(expected) &&
    isDeepFeatureTestWorkspace(receipt.workspace) &&
    isDeepFeatureTestWorkspace(expected) &&
    receipt.workspace.subject_id === expected.subject_id &&
    receipt.workspace.generation === expected.generation &&
    receipt.workspace.mutation_epoch === expected.mutation_epoch &&
    receipt.workspace.fingerprint === expected.fingerprint;
}

/**
 * Validate one registered feature verification receipt before RunAuthority
 * accepts it as a producer result. WorkAuthority performs the full
 * cross-card evidence check at seal; this boundary rejects malformed or
 * stale provider output before it can satisfy downstream bindings.
 */
export function validateFeatureVerificationReceipt(receipt, intent) {
  const operationInput = intent?.operation_input;
  const phase = operationInput?.phase;
  const slice = phase === "slice_verify" ? operationInput.slice : null;
  const expectedCriteria = slice?.acceptance ?? operationInput?.brief?.acceptance;
  const testEvidence = slice?.mode === "test" ||
    (phase === "verify" &&
      operationInput?.verification?.baseline === undefined &&
      operationInput?.verification?.compensating_assertion === undefined);
  const selectedEvidence = testEvidence
    ? operationInput?.test_selection
    : operationInput?.verification?.baseline ??
      operationInput?.verification?.compensating_assertion;
  const expectedKind = testEvidence
    ? "test_failure"
    : operationInput?.verification?.baseline !== undefined
      ? "safe_baseline"
      : "compensating_assertion";
  const workspace = receipt?.workspace;
  const startingWorkspace = operationInput?.workspace;
  const discriminating = receipt?.discriminating_evidence;
  const receiptIdentity = isRecord(receipt)
    ? (({ receipt_digest: _receiptDigest, self_digest: _selfDigest, ...identity }) =>
        identity)(receipt)
    : null;
  const receiptKeys = [
    "acceptance_criteria",
    "attempt_id",
    "brief_id",
    "discriminating_evidence",
    "effect_id",
    "idempotency_key",
    "operation_contract",
    "receipt_digest",
    "schema",
    "selected_evidence_fingerprint",
    "self_digest",
    "source_authority_watermark",
    "workspace",
    ...(operationInput?.independent_critique === true
      ? ["independent_critique_digest"]
      : []),
  ];
  const criteriaValid = Array.isArray(expectedCriteria) &&
    Array.isArray(receipt?.acceptance_criteria) &&
    receipt.acceptance_criteria.length === expectedCriteria.length &&
    receipt.acceptance_criteria.every((criterionReceipt, index) =>
      hasExactKeys(criterionReceipt, ["criterion", "evidence_digest", "verdict"]) &&
      criterionReceipt.criterion === expectedCriteria[index] &&
      criterionReceipt.verdict === "passed" &&
      isDigest(criterionReceipt.evidence_digest));
  const workspaceValid = (phase === "verify" || phase === "slice_verify") &&
    isRecord(startingWorkspace) &&
    hasExactKeys(workspace, [
      "fingerprint",
      "generation",
      "git",
      "mutation_epoch",
      "subject_id",
    ]) &&
    workspace.subject_id === startingWorkspace.subject_id &&
    workspace.generation === startingWorkspace.generation &&
    workspace.mutation_epoch === startingWorkspace.mutation_epoch &&
    validFeatureGitFacts(workspace.git) &&
    workspace.git.clean === true &&
    workspace.fingerprint === digest({ git: workspace.git }) &&
    workspace.fingerprint !== startingWorkspace.fingerprint;
  const discriminatorValid = isRecord(selectedEvidence) &&
    isRecord(discriminating) &&
    discriminating.schema === "flow.feature-discriminating-evidence/v1" &&
    discriminating.kind === expectedKind &&
    discriminating.selected_fingerprint === selectedEvidence.fingerprint &&
    discriminating.post_mutation_fingerprint === workspace?.fingerprint &&
    discriminating.distinguished === true &&
    (expectedKind !== "test_failure" || Array.isArray(discriminating.test_failures)) &&
    (expectedKind !== "compensating_assertion" ||
      (discriminating.non_destructive === true &&
        discriminating.satisfied === true &&
        isDigest(discriminating.assertion_receipt_digest)));
  return isRecord(receipt) &&
    hasExactKeys(receipt, receiptKeys) &&
    receipt.schema === "work.feature-verification-receipt/v1" &&
    receipt.brief_id === operationInput?.brief?.id &&
    receipt.operation_contract === FEATURE_OPERATION_CONTRACTS.verify &&
    receipt.effect_id === intent?.effect_id &&
    receipt.attempt_id === intent?.attempt_id &&
    receipt.idempotency_key === intent?.idempotency_key &&
    receipt.source_authority_watermark === intent?.source_authority_watermark &&
    isDigest(receipt.source_authority_watermark) &&
    receipt.selected_evidence_fingerprint === selectedEvidence?.fingerprint &&
    (operationInput?.independent_critique !== true ||
      isDigest(receipt.independent_critique_digest)) &&
    criteriaValid && workspaceValid && discriminatorValid &&
    isDigest(receipt.receipt_digest) &&
    isDigest(receipt.self_digest) &&
    receipt.receipt_digest === receipt.self_digest &&
    digest(receiptIdentity) === receipt.receipt_digest;
}

function featureTestPreSliceWorkspace(intent) {
  const operationInput = intent?.operation_input;
  const selected = operationInput?.workspace;
  const evidence = operationInput?.authority_materialized_evidence
    ?.operation_receipts;
  const priorIds = operationInput?.operation_evidence_card_ids;
  if (!Array.isArray(priorIds) || priorIds.length === 0) {
    return featureTestWorkspaceIdentity(selected);
  }
  if (!Array.isArray(evidence)) return null;
  if (priorIds.some((cardId) => !evidence.some((entry) =>
    entry?.card_id === cardId))) return null;
  const prior = [...priorIds].reverse().map((cardId) => evidence.find((entry) =>
    entry?.card_id === cardId)).find((entry) => entry !== undefined);
  const providerReceipt = prior?.receipt?.provider_receipt;
  if (!isRecord(providerReceipt) ||
      providerReceipt.schema !== "work.feature-verification-receipt/v1" ||
      providerReceipt.operation_contract !== FEATURE_OPERATION_CONTRACTS.verify) {
    return null;
  }
  return featureVerificationWorkspaceIdentity(providerReceipt.workspace);
}

function featureVerificationWorkspaceIdentity(workspace) {
  if (!isRecord(workspace) ||
      Object.keys(workspace).length !== 5 ||
      !Object.hasOwn(workspace, "git") ||
      !validFeatureGitFacts(workspace.git) ||
      workspace.fingerprint !== digest({ git: workspace.git }) ||
      workspace.git.clean !== true) return null;
  return featureTestWorkspaceIdentity(workspace);
}

function featureTestWorkspaceIdentity(workspace) {
  if (!isRecord(workspace) ||
      ![4, 5, 6].includes(Object.keys(workspace).length) ||
      !Object.hasOwn(workspace, "subject_id") ||
      !Object.hasOwn(workspace, "generation") ||
      !Object.hasOwn(workspace, "mutation_epoch") ||
      !Object.hasOwn(workspace, "fingerprint") ||
      Object.keys(workspace).some((key) =>
        !["subject_id", "generation", "mutation_epoch", "fingerprint", "schema", "git"]
          .includes(key)) ||
      Object.hasOwn(workspace, "schema") &&
        workspace.schema !== "flow.feature-workspace-binding/v1" ||
      Object.hasOwn(workspace, "git") &&
        (!validFeatureGitFacts(workspace.git) ||
         workspace.git.clean !== true ||
         workspace.fingerprint !== digest({ git: workspace.git })) ||
      !isDeepFeatureTestWorkspace({
        subject_id: workspace.subject_id,
        generation: workspace.generation,
        mutation_epoch: workspace.mutation_epoch,
        fingerprint: workspace.fingerprint,
      })) return null;
  return {
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: workspace.fingerprint,
  };
}

function isDeepFeatureTestWorkspace(workspace) {
  return isRecord(workspace) &&
    Object.keys(workspace).length === 4 &&
    typeof workspace.subject_id === "string" && workspace.subject_id.length > 0 &&
    Number.isSafeInteger(workspace.generation) && workspace.generation >= 1 &&
    Number.isSafeInteger(workspace.mutation_epoch) && workspace.mutation_epoch >= 1 &&
    isDigest(workspace.fingerprint);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

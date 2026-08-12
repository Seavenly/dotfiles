import { digest, freezeCanonical } from "./canonical.mjs";
import { PredefinedFlowValidationError } from "./plan-compiler.mjs";

// These contracts are intentionally registered operation contracts.  The
// feature definition owns the order and inputs, while the host owns the
// adapters and the receipts returned by each operation.
export const FEATURE_OPERATION_CONTRACTS = Object.freeze({
  setup: "flow.operation/feature-setup/v1",
  test: "flow.operation/feature-test/v1",
  verify: "flow.operation/feature-verify/v1",
  seal: "flow.operation/feature-seal/v1",
});

export const FEATURE_DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";

export const FEATURE_TEST_RECEIPT_VALIDATOR =
  "flow.validator/feature-test-receipt/v1";

const FEATURE_DEFINITION_SCHEMA = "flow.predefined-definition/v1";
const FEATURE_SELECTION_MODE = new Set(["verify", "test", "mixed"]);
const FEATURE_NEGATIVE_OUTCOME =
  "no review, integration, push, pull request, cleanup, or tracker completion";

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

/**
 * Return the trusted feature/v1 definition used by FlowRuntime's predefined
 * selection Interface.  It emits a finite graph only; execution remains the
 * responsibility of registered operation adapters and RunAuthority.
 */
export function createFeatureDefinition() {
  return {
    schema: FEATURE_DEFINITION_SCHEMA,
    id: "feature/v1",
    contract: "flow.definition/feature/v1",
    promised_outcomes: [...PROMISED_OUTCOMES],
    negative_outcomes: [FEATURE_NEGATIVE_OUTCOME],
    trust_posture: { ...TRUST_POSTURE },
    compile: compileFeatureSelection,
  };
}

function compileFeatureSelection({ inputs, explicit_facts: explicitFacts }) {
  const selection = validateFeatureInputs(inputs, explicitFacts);
  const workspaceClaim = {
    kind: "workspace",
    id: selection.workspace.subject_id,
    generation: selection.workspace.generation,
    mutation_epoch: selection.workspace.mutation_epoch,
    fingerprint: selection.workspace.fingerprint,
  };
  const cards = featureCards(selection, workspaceClaim);

  // A predefined compiler may only carry the selected facts through.  In
  // particular, it must not manufacture a generation, epoch, route, or
  // verification observation behind the caller's back.
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards,
    },
    requested_authority: {
      commands: [
        "cancel",
        "delegate_execute",
        "operation_execute",
        "terminal_disposition",
      ],
      capabilities: [],
      mutations: featureOperationContracts(selection),
    },
    explicit_facts: explicitFacts,
    revision_templates: [],
  };
}

function featureOperationContracts(selection) {
  const contracts = [FEATURE_OPERATION_CONTRACTS.verify,
    FEATURE_OPERATION_CONTRACTS.seal];
  if (selection.setup !== null) contracts.unshift(FEATURE_OPERATION_CONTRACTS.setup);
  if (selection.slices.some(({ mode }) => mode === "test")) {
    contracts.unshift(FEATURE_OPERATION_CONTRACTS.test);
  }
  return contracts;
}

function featureCards(selection, workspaceClaim) {
  if (selection.serialized_slices) {
    return serializedFeatureCards(selection, workspaceClaim);
  }
  return legacyFeatureCards(selection, workspaceClaim);
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
  const operation = (id, contract, dependencies, inputs, outputs) => ({
    ...common,
    id,
    executor: {
      ...common.executor,
      contract,
    },
    dependencies,
    inputs,
    outputs,
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

function legacyFeatureCards(selection, workspaceClaim) {
  const { delegate, operation } = featureCardBuilders(selection, workspaceClaim);
  const shared = {
    brief: selection.brief,
    mode: selection.mode,
    workspace: selection.workspace,
    ...featureSelectionInputs(selection),
  };
  return [
    delegate(
      "feature-apply",
      [],
      {
        ...shared,
        phase: "apply",
        prompt: "apply the accepted brief in the exact fenced workspace",
      },
      selection.delegation.apply,
      ["workspace_mutation_observation"],
    ),
    operation(
      "feature-verify",
      FEATURE_OPERATION_CONTRACTS.verify,
      ["feature-apply"],
      {
        ...shared,
        phase: "verify",
        receipt_owner: "registered_operation",
        delegate_output_usage: "evidence_input_only",
        delegate_evidence_card_ids: ["feature-apply"],
      },
      ["verification_receipt"],
    ),
    delegate(
      "feature-critique",
      ["feature-verify"],
      {
        ...shared,
        phase: "critique",
        prompt: "critique the changed behavior independently of implementation",
      },
      selection.delegation.critique,
      ["critique_observation"],
    ),
    operation(
      "feature-seal",
      FEATURE_OPERATION_CONTRACTS.seal,
      ["feature-critique"],
      {
        ...shared,
        phase: "seal",
        finalization: selection.finalization,
        publication: selection.finalization.publication,
        negative_outcomes: [FEATURE_NEGATIVE_OUTCOME],
        receipt_owner: "registered_operation",
        delegate_output_usage: "evidence_input_only",
        delegate_evidence_card_ids: ["feature-apply", "feature-critique"],
        operation_evidence_card_ids: ["feature-verify"],
      },
      ["review_candidate_receipt"],
    ),
  ];
}

function serializedFeatureCards(selection, workspaceClaim) {
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
        prompt: "apply the accepted brief in the exact fenced workspace",
        test_card_ids: testCardIds,
        managed_agent: applyManagedAgent,
      },
      selection.delegation.apply,
      ["workspace_mutation_observation"],
    );
    cards.push(apply);
    applyCardIds.push(apply.id);
    dependency = apply.id;

    const verifyCard = operation(
      `feature-slice-${slice.id}-verify`,
      FEATURE_OPERATION_CONTRACTS.verify,
      [dependency],
      {
        ...shared,
        phase: "slice_verify",
        slice,
        receipt_owner: "registered_operation",
        delegate_evidence_card_ids: [...applyCardIds],
        operation_evidence_card_ids: [...sliceTestCardIds],
        test_card_ids: [...sliceTestCardIds],
        mutation_owner: apply.id,
      },
      ["slice_verification_receipt"],
    );
    cards.push(verifyCard);
    verificationCardIds.push(verifyCard.id);
    dependency = verifyCard.id;
  }

  cards.push(operation(
    "feature-verify",
    FEATURE_OPERATION_CONTRACTS.verify,
    [dependency],
    {
      ...shared,
      phase: "verify",
      receipt_owner: "registered_operation",
          delegate_output_usage: "evidence_input_only",
      delegate_evidence_card_ids: [...applyCardIds],
      operation_evidence_card_ids: [
        ...testCardIds,
        ...verificationCardIds,
      ],
      evidence_role: "slice_aggregate",
    },
    ["verification_receipt"],
  ));

  cards.push(delegate(
    "feature-critique",
    ["feature-verify"],
    {
      ...shared,
      phase: "critique",
      prompt: "critique the changed behavior independently of implementation",
    },
    selection.delegation.critique,
    ["critique_observation"],
  ));

  cards.push(operation(
    "feature-seal",
    FEATURE_OPERATION_CONTRACTS.seal,
    ["feature-critique"],
    {
      ...shared,
      phase: "seal",
      finalization: selection.finalization,
      publication: selection.finalization.publication,
      negative_outcomes: [FEATURE_NEGATIVE_OUTCOME],
      receipt_owner: "registered_operation",
          delegate_output_usage: "evidence_input_only",
      delegate_evidence_card_ids: [...applyCardIds, "feature-critique"],
      operation_evidence_card_ids: [
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
    delegation,
    finalization,
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
  if (mode === "test" && (!hasTest || hasVerify) || mode === "mixed" &&
      (!hasTest || !hasVerify) || mode === "verify" && hasTest) {
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
      ![4, 5].includes(Object.keys(workspace).length) ||
      !Object.hasOwn(workspace, "subject_id") ||
      !Object.hasOwn(workspace, "generation") ||
      !Object.hasOwn(workspace, "mutation_epoch") ||
      !Object.hasOwn(workspace, "fingerprint") ||
      Object.keys(workspace).some((key) =>
        !["subject_id", "generation", "mutation_epoch", "fingerprint", "schema", "git"]
          .includes(key)) ||
      Object.hasOwn(workspace, "schema") &&
        workspace.schema !== "flow.feature-workspace-binding/v1" ||
      Object.hasOwn(workspace, "git") && !isRecord(workspace.git) ||
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

import { digest, freezeCanonical } from "./canonical.mjs";
import { PredefinedFlowValidationError } from "./plan-compiler.mjs";

// These contracts are intentionally registered operation contracts.  The
// feature definition owns the order and inputs, while the host owns the
// adapters and the receipts returned by each operation.
export const FEATURE_OPERATION_CONTRACTS = Object.freeze({
  verify: "flow.operation/feature-verify/v1",
  seal: "flow.operation/feature-seal/v1",
});

export const FEATURE_DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";

const FEATURE_DEFINITION_SCHEMA = "flow.predefined-definition/v1";
const FEATURE_SELECTION_MODE = new Set(["verify"]);
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
      mutations: Object.values(FEATURE_OPERATION_CONTRACTS),
    },
    explicit_facts: explicitFacts,
    revision_templates: [],
  };
}

function featureCards(selection, workspaceClaim) {
  const common = {
    outputs: ["flow.effect-receipt/v1"],
    success_criteria: ["registered_operation_receipt:succeeded"],
    validators: ["flow.validator/operation-receipt/v1"],
    data_references: [selection.brief.id],
    evidence_references: [selection.verification.evidence_id],
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
  const shared = {
    brief: selection.brief,
    mode: selection.mode,
    workspace: selection.workspace,
    verification: selection.verification,
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
    invalidFeature("invalid_mode", "feature/v1 mode must be verify");
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
  const verification = inputs.verification;
  if (!isRecord(verification) ||
      verification.schema !== "flow.feature-verification-request/v1") {
    invalidFeature(
      "missing_verification_evidence",
      "feature/v1 requires explicit verification evidence",
    );
  }
  const baseline = verification.baseline;
  const compensating = verification.compensating_assertion;
  const baselinePresent = Object.hasOwn(verification, "baseline");
  const compensatingPresent = Object.hasOwn(
    verification,
    "compensating_assertion",
  );
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
  if (baselinePresent !== hasBaseline ||
      compensatingPresent !== hasCompensating ||
      !hasBaseline && !hasCompensating) {
    invalidFeature(
      "missing_discriminating_evidence",
      "feature/v1 requires a safe baseline or non-destructive compensating assertion",
    );
  }
  const delegation = validateDelegationBindings(inputs.delegation, explicitFacts);
  const finalization = validateFeatureFinalization(inputs.finalization, workspace);
  const evidence = hasBaseline ? baseline : compensating;
  return freezeCanonical({
    brief: inputs.brief,
    mode: inputs.mode,
    workspace,
    verification: {
      ...verification,
      evidence_id: `${verification.schema}:${evidence.fingerprint}`,
    },
    delegation,
    finalization,
  });
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

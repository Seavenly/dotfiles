import {
  digest,
  freezeCanonical,
  idempotencyCommandDigest,
} from "./canonical.mjs";
import { PredefinedFlowValidationError } from "./plan-compiler.mjs";
import {
  buildReviewSummary,
  normalizeReviewFindings,
  parseReviewDelegateResult,
  renderReviewArtifacts,
  reviewValidationError,
} from "./review-rendering.mjs";
import { validateReviewCandidate } from "./review-candidate.mjs";

export { validateReviewCandidate };

export const REVIEW_OPERATION_CONTRACTS = Object.freeze({
  record: "flow.operation/review-record/v1",
});

export const REVIEW_OPERATION_REGISTRATION_POLICY =
  "review_authority_owned_builtin_reserved";

export const REVIEW_DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/review-result/v1";

export const REVIEW_LENSES = Object.freeze([
  "security",
  "correctness",
  "tests",
  "style",
  "observability",
]);

const REVIEW_DEFINITION_SCHEMA = "flow.predefined-definition/v1";
const REVIEW_SELECTION_SCHEMA = "flow.review-request/v1";
const REVIEW_TARGET_SCHEMA = "flow.review-local-candidate/v1";
const REVIEW_BINDINGS_SCHEMA = "flow.review-delegation-bindings/v1";
const REVIEW_NEGATIVE_OUTCOME =
  "automated completion is not approval and cannot integrate, merge, complete a tracker, or submit a remote review";

const PROMISED_OUTCOMES = Object.freeze([
  "one exact verified local candidate receives every selected finding lens and one fresh critic",
  "stable findings, posture, evidence, and deterministic review artifacts are retained",
]);

const TRUST_POSTURE = Object.freeze({
  schema: "flow.review-trust-posture/v1",
  evidence: "isolated_delegates_and_registered_review_authority",
  completion: "automated_not_approval",
  target: "exact_local_candidate_only",
});

export function createReviewDefinition() {
  return {
    schema: REVIEW_DEFINITION_SCHEMA,
    id: "review/v1",
    contract: "flow.definition/review/v1",
    promised_outcomes: [...PROMISED_OUTCOMES],
    negative_outcomes: [REVIEW_NEGATIVE_OUTCOME],
    trust_posture: { ...TRUST_POSTURE },
    compile: compileReviewSelection,
  };
}

export function compileReviewSelection({ inputs, explicit_facts: explicitFacts }) {
  const selection = validateReviewInputs(inputs, explicitFacts);
  const cards = reviewCards(selection);
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards,
    },
    requested_authority: {
      commands: ["cancel", "delegate_execute", "operation_execute", "terminal_disposition"],
      capabilities: [],
      mutations: [REVIEW_OPERATION_CONTRACTS.record],
    },
    explicit_facts: explicitFacts,
    revision_templates: [],
  };
}

export function validateReviewInputs(inputs, explicitFacts) {
  if (!isRecord(inputs) || inputs.schema !== REVIEW_SELECTION_SCHEMA) {
    invalidReview("invalid_review_request", "review/v1 requires one local review request");
  }
  const target = inputs.target;
  if (!isRecord(target) || target.schema !== REVIEW_TARGET_SCHEMA ||
      !Number.isSafeInteger(target.lifecycle_generation) ||
      target.lifecycle_generation < 1 ||
      !isDigest(target.candidate_fingerprint) ||
      !isDigest(target.candidate_authority_watermark) ||
      !isRecord(target.candidate)) {
    invalidReview(
      "invalid_review_target",
      "review/v1 requires one exact candidate and lifecycle generation",
    );
  }
  const candidate = target.candidate;
  if (!validateReviewCandidate(candidate) ||
      target.candidate_fingerprint !== candidate.candidate_fingerprint) {
    invalidReview(
      "invalid_verified_review_candidate",
      "review/v1 target must contain the complete verified candidate contract",
    );
  }
  if (!Array.isArray(inputs.lenses) || inputs.lenses.length === 0 ||
      new Set(inputs.lenses).size !== inputs.lenses.length ||
      inputs.lenses.some((lens) => !REVIEW_LENSES.includes(lens))) {
    invalidReview(
      "invalid_review_lenses",
      "review/v1 lenses must be a non-empty unique subset of the finding lenses",
    );
  }
  if (!isRecord(explicitFacts) ||
      !Array.isArray(explicitFacts.operation_contracts) ||
      !Array.isArray(explicitFacts.validator_contracts) ||
      !explicitFacts.operation_contracts.includes(REVIEW_OPERATION_CONTRACTS.record) ||
      !explicitFacts.validator_contracts.includes(REVIEW_DELEGATE_OUTPUT_VALIDATOR)) {
    invalidReview(
      "incomplete_review_contracts",
      "review/v1 requires the registered review operation and result validator",
    );
  }
  if (!isRecord(inputs.delegation) ||
      inputs.delegation.schema !== REVIEW_BINDINGS_SCHEMA) {
    invalidReview(
      "missing_review_delegation",
      "review/v1 requires isolated finding-lens and critic routes",
    );
  }
  const bindings = validateDelegation(inputs.delegation, inputs.lenses, explicitFacts);
  const findingCap = inputs.finding_cap ?? inputs.limits?.max_findings ?? 100;
  if (!Number.isSafeInteger(findingCap) || findingCap < 1) {
    invalidReview("invalid_finding_cap", "review/v1 finding cap must be positive");
  }
  return freezeCanonical({
    target,
    lenses: [...inputs.lenses].sort(),
    delegation: bindings,
    finding_cap: findingCap,
  });
}

/**
 * Reconcile a prepared local target with the owning ReviewAuthority seal.
 * Preparation records the candidate fingerprint and the independent seal
 * watermark; launch is the first mutating boundary and must re-read both.
 */
export function reviewCandidateAuthorityIssue(target, reviewAuthority) {
  if (!isRecord(target) || target.schema !== REVIEW_TARGET_SCHEMA ||
      !validateReviewCandidate(target.candidate) ||
      target.candidate_fingerprint !== target.candidate?.candidate_fingerprint) {
    return {
      code: "invalid_verified_review_candidate",
      reason: "review target is not a complete verified candidate",
      projection: null,
    };
  }
  if (typeof reviewAuthority?.query !== "function") {
    return {
      code: "candidate_authority_unavailable",
      reason: "ReviewAuthority candidate projection is unavailable",
      projection: null,
    };
  }
  const projection = reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: target.candidate.candidate_id,
  });
  return reviewCandidateProjectionIssue(target, projection);
}

/**
 * Validate a review-record command against the candidate projection read by
 * its owning ReviewAuthority. The projection is deliberately supplied only
 * by the authority wrapper after it has read its own stream; it is not a
 * command field and cannot be caller-selected.
 */
export function reviewRecordCandidateAuthorityIssue(command, projection) {
  const target = isRecord(command) ? {
    schema: REVIEW_TARGET_SCHEMA,
    candidate: command.candidate,
    candidate_fingerprint: command.candidate_fingerprint,
    candidate_authority_watermark: command.candidate_authority_watermark,
    lifecycle_generation: command.lifecycle_generation,
  } : null;
  if (!isRecord(command) || !isDigest(command.candidate_authority_watermark)) {
    return {
      code: "invalid_candidate_authority_watermark",
      reason: "review record requires the candidate seal authority watermark",
      projection,
    };
  }
  if (!validateReviewCandidate(command.candidate) ||
      command.candidate_fingerprint !== command.candidate.candidate_fingerprint) {
    return {
      code: "invalid_verified_review_candidate",
      reason: "review record candidate is not a complete verified candidate",
      projection,
    };
  }
  return reviewCandidateProjectionIssue(target, projection);
}

export function reviewRecordSourceAuthorityIssue(command, projection) {
  if (!nonEmpty(command?.source_run_id)) {
    return { code: "review_source_authority_unavailable", reason: "review record has no source run identity" };
  }
  const effect = (projection?.effects ?? projection?.effect_intents ?? [])
    .find(({ effect_id: id }) =>
    id === command.operation_effect_id);
  if (!effect || effect.run_id !== command.source_run_id ||
      effect.operation_contract !== REVIEW_OPERATION_CONTRACTS.record ||
      effect.attempt_id !== command.operation_attempt_id ||
      effect.idempotency_key !== command.operation_idempotency_key ||
      effect.source_authority_watermark !== command.source_authority_watermark) {
    return { code: "review_source_intent_mismatch", reason: "review record is not bound to the settled RunAuthority intent" };
  }
  const input = effect.operation_input;
  const target = input?.target;
  if (!isDeepEqualDigest(target, {
    schema: REVIEW_TARGET_SCHEMA,
    candidate: command.candidate,
    candidate_fingerprint: command.candidate_fingerprint,
    candidate_authority_watermark: command.candidate_authority_watermark,
    lifecycle_generation: command.lifecycle_generation,
  }) || !isDeepEqualDigest(input?.lenses, command.summary?.enabled_lenses) ||
      !Number.isSafeInteger(input?.finding_cap) ||
      input.finding_cap !== command.summary?.finding_cap) {
    return { code: "review_source_intent_mismatch", reason: "review target or declared review inputs differ from RunAuthority" };
  }
  const accepted = input.authority_materialized_evidence?.accepted_delegates;
  if (!Array.isArray(accepted) || accepted.length !== input.delegate_evidence_card_ids?.length ||
      !isDeepEqualDigest([...accepted].map(({ card_id: id }) => id), input.delegate_evidence_card_ids)) {
    return { code: "review_source_evidence_mismatch", reason: "review evidence is not authority-materialized" };
  }
  const lensResults = {};
  for (const evidence of accepted) {
    if (evidence.card_id === "review-critic") continue;
    lensResults[evidence.card_id.replace(/^review-lens-/u, "")] =
      evidence.evidence?.validated_output ?? evidence.evidence;
  }
  const critic = accepted.find(({ card_id: id }) => id === "review-critic");
  if (!critic) return { code: "review_source_evidence_mismatch", reason: "authority-materialized critic evidence is missing" };
  let expected;
  try {
    expected = buildReviewSummary({
      candidateFingerprint: command.candidate_fingerprint,
      candidateAuthorityWatermark: command.candidate_authority_watermark,
      lifecycleGeneration: command.lifecycle_generation,
      enabledLenses: input.lenses,
      lensResults,
      criticResult: critic.evidence?.validated_output ?? critic.evidence,
      sourceAuthorityWatermark: effect.source_authority_watermark,
      findingCap: input.finding_cap,
    });
  } catch (error) {
    return {
      code: error?.code ?? "review_source_evidence_mismatch",
      reason: "RunAuthority review evidence cannot produce a valid review summary",
    };
  }
  if (!isDeepEqualDigest(expected, command.summary) ||
      !isDeepEqualDigest(expected.automated_evidence, command.automated_evidence) ||
      command.artifacts?.provenance?.run_id !== command.source_run_id) {
    return { code: "review_summary_mismatch", reason: "review summary is not recomputed from RunAuthority evidence" };
  }
  return null;
}

function reviewCandidateProjectionIssue(target, projection) {
  if (projection?.schema !== "work.review-candidate-projection/v1" ||
      projection.contract !== "work.review/v1" ||
      projection.status !== "sealed") {
    return {
      code: "candidate_authority_projection_missing",
      reason: "ReviewAuthority has no sealed exact candidate projection",
      projection,
    };
  }
  if (projection.subject_id !== target.candidate.candidate_id) {
    return {
      code: "candidate_authority_target_mismatch",
      reason: "ReviewAuthority candidate projection belongs to another candidate id",
      projection,
    };
  }
  if (projection.candidate_fingerprint !== target.candidate_fingerprint ||
      projection.candidate?.candidate_fingerprint !== target.candidate_fingerprint ||
      !isDeepEqualDigest(projection.candidate, target.candidate)) {
    return {
      code: "candidate_fingerprint_mismatch",
      reason: "ReviewAuthority candidate projection does not match the target fingerprint",
      projection,
    };
  }
  if (!isDigest(target.candidate_authority_watermark) ||
      projection.watermark !== target.candidate_authority_watermark) {
    return {
      code: "stale_candidate_authority_watermark",
      reason: "review target candidate seal watermark is stale",
      projection,
    };
  }
  return null;
}

function reviewCards(selection) {
  const common = {
    outputs: ["flow.review-result/v1"],
    success_criteria: ["delegate_observation:accepted"],
    validators: [REVIEW_DELEGATE_OUTPUT_VALIDATOR],
    data_references: [selection.target.candidate.candidate_fingerprint],
    evidence_references: [selection.target.candidate.candidate_fingerprint],
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "discover_then_dispatch_exact",
  };
  const lensCards = selection.lenses.map((lens) => {
    const binding = selection.delegation.lenses[lens];
    return {
      ...common,
      id: `review-lens-${lens}`,
      dependencies: [],
      inputs: {
        target: selection.target,
        lens,
        prompt: `Review the exact local candidate through the ${lens} finding lens and return flow.review-result/v1 JSON`,
        description: binding.description,
        wait_timeout_ms: 300_000,
        finding_lens: lens,
      },
      route: binding.route,
      executor: {
        kind: "delegate",
        contract: "flow.delegated-agent-port/v1",
      },
    };
  });
  const critic = {
    ...common,
    id: "review-critic",
    dependencies: selection.lenses.map((lens) => `review-lens-${lens}`).sort(),
    inputs: {
      target: selection.target,
      prompt: "Critique every enabled review finding lens result and return flow.review-result/v1 JSON",
      description: selection.delegation.critic.description,
      wait_timeout_ms: 300_000,
      finding_lens_join: "all_enabled",
      finding_lens_card_ids: selection.lenses.map((lens) => `review-lens-${lens}`).sort(),
    },
    route: selection.delegation.critic.route,
    executor: {
      kind: "delegate",
      contract: "flow.delegated-agent-port/v1",
    },
  };
  const record = {
    id: "review-record",
    dependencies: ["review-critic"],
    inputs: {
      target: selection.target,
      lenses: selection.lenses,
      finding_cap: selection.finding_cap,
      delegate_evidence_card_ids: [
        ...selection.lenses.map((lens) => `review-lens-${lens}`),
        "review-critic",
      ],
      receipt_owner: "ReviewAuthority",
      completion_authority: "automated_only",
    },
    outputs: ["flow.review-receipt/v1"],
    success_criteria: ["registered_operation_receipt:succeeded"],
    validators: ["flow.validator/operation-receipt/v1"],
    data_references: [selection.target.candidate.candidate_fingerprint],
    evidence_references: selection.lenses.map((lens) =>
      `review-lens-${lens}`).concat("review-critic"),
    route: null,
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "caller_idempotent",
    executor: {
      kind: "operation",
      contract: REVIEW_OPERATION_CONTRACTS.record,
      effect_classification: "caller_idempotent",
    },
  };
  return [...lensCards, critic, record];
}

function validateDelegation(delegation, lenses, explicitFacts) {
  const lensBindings = {};
  const agentIds = new Set();
  const launchKeys = new Set();
  for (const lens of lenses) {
    const binding = validateBinding(delegation.lenses?.[lens], `lens:${lens}`, explicitFacts);
    if (agentIds.has(binding.route.agent_id) || launchKeys.has(binding.route.launch_comparison_key)) {
      invalidReview("non_independent_lens_route", "review/v1 finding lenses require isolated identities");
    }
    agentIds.add(binding.route.agent_id);
    launchKeys.add(binding.route.launch_comparison_key);
    lensBindings[lens] = binding;
  }
  const critic = validateBinding(delegation.critic, "critic", explicitFacts);
  if (agentIds.has(critic.route.agent_id) || launchKeys.has(critic.route.launch_comparison_key)) {
    invalidReview("non_independent_critic_route", "review/v1 critic requires a fresh isolated identity");
  }
  return { schema: REVIEW_BINDINGS_SCHEMA, lenses: lensBindings, critic };
}

function validateBinding(binding, role, explicitFacts) {
  const description = binding?.description;
  const route = binding?.route;
  if (!isRecord(binding) || !isRecord(description) ||
      description.schema !== "drovr.delegated-agent-description/v1" ||
      !isDigest(description.description_digest) ||
      !isDigest(description.comparison_keys?.launch) ||
      !isDigest(description.comparison_keys?.effective_authority) ||
      !isDigest(description.watermark?.content_sha256) ||
      !isRecord(route) ||
      typeof route.agent_id !== "string" || route.agent_id.length === 0 ||
      route.description_digest !== description.description_digest ||
      route.launch_comparison_key !== description.comparison_keys.launch ||
      route.configuration_watermark !== description.watermark.content_sha256 ||
      !explicitFacts.validator_contracts.includes(REVIEW_DELEGATE_OUTPUT_VALIDATOR)) {
    invalidReview("invalid_review_binding", `review/v1 ${role} binding is incomplete`);
  }
  const {
    description_digest: _digest,
    legal_actions: _actions,
    ...identity
  } = description;
  if (digest(identity) !== description.description_digest) {
    invalidReview("invalid_review_binding", `review/v1 ${role} description is not digest-bound`);
  }
  return {
    description,
    route,
    validators: [REVIEW_DELEGATE_OUTPUT_VALIDATOR],
  };
}

export function createReviewOperationRegistration({ reviewAuthority } = {}) {
  if (!reviewAuthority || typeof reviewAuthority.command !== "function" ||
      typeof reviewAuthority.query !== "function") {
    throw new TypeError("review operation requires ReviewAuthority");
  }
  return {
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    validateCard(card) {
      if (card?.id !== "review-record" ||
          card.inputs?.receipt_owner !== "ReviewAuthority" ||
          card.inputs?.completion_authority !== "automated_only" ||
          card.inputs?.target?.schema !== REVIEW_TARGET_SCHEMA ||
          !validateReviewCandidate(card.inputs?.target?.candidate) ||
          card.inputs.target.candidate_fingerprint !==
            card.inputs.target.candidate.candidate_fingerprint ||
          !isDigest(card.inputs.target.candidate_fingerprint) ||
          !isDigest(card.inputs?.target?.candidate_authority_watermark) ||
          !Number.isSafeInteger(card.inputs.target.lifecycle_generation) ||
          card.inputs.target.lifecycle_generation < 1 ||
          !Array.isArray(card.inputs?.lenses) || card.inputs.lenses.length === 0 ||
          card.inputs.lenses.some((lens) => !REVIEW_LENSES.includes(lens)) ||
          new Set(card.inputs.lenses).size !== card.inputs.lenses.length ||
          !Number.isSafeInteger(card.inputs?.finding_cap) ||
          card.inputs.finding_cap < 1 ||
          !Array.isArray(card.inputs?.delegate_evidence_card_ids) ||
          card.inputs.delegate_evidence_card_ids.length === 0 ||
          card.inputs.delegate_evidence_card_ids.some((cardId) =>
            !nonEmpty(cardId)) ||
          new Set(card.inputs.delegate_evidence_card_ids).size !==
            card.inputs.delegate_evidence_card_ids.length ||
          !isDeepEqualDigest(card.inputs.delegate_evidence_card_ids, [
            ...card.inputs.lenses.map((lens) => `review-lens-${lens}`),
            "review-critic",
          ])) {
        throw new TypeError("review record operation is not bound to ReviewAuthority");
      }
    },
    invoke(intent) {
      if (intent?.operation_contract !== REVIEW_OPERATION_CONTRACTS.record ||
          !nonEmpty(intent.effect_id) ||
          !nonEmpty(intent.attempt_id) ||
          !nonEmpty(intent.idempotency_key)) {
        throw reviewValidationError(
          "review_operation_intent_mismatch",
          "review operation intent is not the reserved registered operation",
        );
      }
      const input = intent.operation_input ?? {};
      const target = input.target;
      const candidateIssue = reviewCandidateAuthorityIssue(target, reviewAuthority);
      if (candidateIssue) {
        throw reviewValidationError(candidateIssue.code, candidateIssue.reason);
      }
      const materialized = input.authority_materialized_evidence;
      const current = reviewAuthority.query({
        contract: "work.review/v1",
        subject_id: reviewSubjectId(target),
      });
      const previousWatermark = current?.schema === "flow.review-projection/v1"
        ? current.watermark
        : EMPTY_WATERMARK;
      if (current?.schema === "flow.review-projection/v1" &&
          current.source_run_id === intent.run_id &&
          current.operation_effect_id === intent.effect_id &&
          current.operation_attempt_id === intent.attempt_id &&
          current.operation_idempotency_key === intent.idempotency_key) {
        return {
          schema: "flow.effect-receipt/v1",
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
          outcome: "succeeded",
          provider_receipt: {
            schema: "flow.review-receipt/v1",
            review_id: current.subject_id,
            candidate_fingerprint: current.candidate_fingerprint,
            lifecycle_generation: current.lifecycle_generation,
            review_authority_watermark: current.watermark,
            summary: current.summary,
            artifacts: current.artifacts,
            ...reviewCompletionAuthority(),
          },
        };
      }
      const lensResults = {};
      for (const evidence of materialized?.accepted_delegates ?? []) {
        if (evidence.card_id === "review-critic") continue;
        const lens = evidence.card_id.replace(/^review-lens-/u, "");
        lensResults[lens] = evidence.evidence?.validated_output ?? evidence.evidence;
      }
      const criticEvidence = materialized?.accepted_delegates?.find(({ card_id: id }) =>
        id === "review-critic");
      if (!criticEvidence) {
        throw reviewValidationError("incomplete_lens_join", "review critic evidence is missing");
      }
      const criticResult = criticEvidence.evidence?.validated_output ?? criticEvidence.evidence;
      const summary = buildReviewSummary({
        candidateFingerprint: target.candidate.candidate_fingerprint,
        candidateAuthorityWatermark: target.candidate_authority_watermark,
        lifecycleGeneration: target.lifecycle_generation,
        enabledLenses: input.lenses,
        lensResults,
        criticResult,
        sourceAuthorityWatermark: intent.source_authority_watermark,
        findingCap: input.finding_cap,
      });
      const eventBody = {
        schema: "flow.review-record/v1",
        review_id: reviewSubjectId(target),
        candidate_fingerprint: target.candidate.candidate_fingerprint,
        candidate_authority_watermark: target.candidate_authority_watermark,
        lifecycle_generation: target.lifecycle_generation,
        candidate: target.candidate,
        summary,
        automated_evidence: summary.automated_evidence,
        source_authority_watermark: intent.source_authority_watermark,
        source_run_id: intent.run_id,
        operation_contract: intent.operation_contract,
        operation_effect_id: intent.effect_id,
        operation_attempt_id: intent.attempt_id,
        operation_idempotency_key: intent.idempotency_key,
      };
      const predictedWatermark = reviewEventWatermark({
        previousWatermark,
        event: reviewRecordWatermarkIdentity(eventBody),
      });
      const artifacts = renderReviewArtifacts({
        summary,
        watermark: predictedWatermark,
        provenance: {
          operation_contract: intent.operation_contract,
          source_run_id: intent.run_id,
          run_id: intent.run_id,
          operation_effect_id: intent.effect_id,
          operation_attempt_id: intent.attempt_id,
          operation_idempotency_key: intent.idempotency_key,
        },
      });
      const command = {
        schema: "work.review-record-command/v1",
        type: "review_record",
        contract: "work.review/v1",
        subject_id: reviewSubjectId(target),
        command_id: `review-record:${target.candidate.candidate_fingerprint}:${target.lifecycle_generation}`,
        expected_watermark: previousWatermark,
        candidate_fingerprint: target.candidate.candidate_fingerprint,
        candidate_authority_watermark: target.candidate_authority_watermark,
        lifecycle_generation: target.lifecycle_generation,
        candidate: target.candidate,
        summary,
        automated_evidence: summary.automated_evidence,
        artifacts,
        source_authority_watermark: intent.source_authority_watermark,
        source_run_id: intent.run_id,
        operation_contract: intent.operation_contract,
        operation_effect_id: intent.effect_id,
        operation_attempt_id: intent.attempt_id,
        operation_idempotency_key: intent.idempotency_key,
      };
      const receipt = reviewAuthority.command(command);
      if (receipt?.accepted !== true) {
        const error = reviewValidationError(
          receipt?.code ?? "review_authority_rejected",
          receipt?.reason ?? "ReviewAuthority rejected review evidence",
        );
        error.review_receipt = receipt;
        throw error;
      }
      const projection = reviewAuthority.query({
        contract: "work.review/v1",
        subject_id: command.subject_id,
      });
      return {
        schema: "flow.effect-receipt/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        outcome: "succeeded",
        provider_receipt: {
          schema: "flow.review-receipt/v1",
          review_id: command.subject_id,
          candidate_fingerprint: command.candidate_fingerprint,
          lifecycle_generation: command.lifecycle_generation,
          review_authority_watermark: projection.watermark,
          summary,
          artifacts,
          ...reviewCompletionAuthority(),
        },
      };
    },
  };
}

/**
 * Small authority implementation used by pure/runtime contract tests and by
 * an in-memory FlowRuntime. Durable runtimes use the Work-domain authority
 * with the same command and projection contracts.
 */
export function createInMemoryReviewAuthority({ candidateProjection = null, sourceEffectIntentReader = null } = {}) {
  const streams = new Map();
  const sealedCandidateProjection = candidateProjection?.schema ===
    "work.review-candidate-projection/v1"
    ? freezeCanonical(candidateProjection)
    : null;
  const emptyProjection = (subjectId) => ({
    schema: "flow.rejection/v1",
    operation: "query",
    code: "unknown_subject",
    reason: null,
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: EMPTY_WATERMARK,
    authority_watermark_domain: "review",
    legal_actions: [],
    subject_id: subjectId,
  });
  const authority = {
    schema: "work.review-authority/v1",
    command(command) {
      const subjectId = command?.subject_id;
      if (command?.schema !== "work.review-record-command/v1" ||
          command?.type !== "review_record" ||
          command?.contract !== "work.review/v1" || typeof subjectId !== "string") {
        return reviewRejection("invalid_review_command", command, null);
      }
      const current = queryProjection(subjectId);
      const prior = streams.get(subjectId)?.find(({ type }) =>
        type === "review_recorded");
      let repeated = null;
      try {
        if (prior?.command_receipt?.command_id === command.command_id) {
          repeated = prior.command_receipt.command_digest ===
            idempotencyCommandDigest(command)
            ? {
                accepted: true,
                replayed: true,
                authority_watermark: current.watermark,
              }
            : reviewRejection("idempotency_conflict", command, current);
        }
      } catch {
        repeated = null;
      }
      if (repeated !== null) return repeated;
      if (current.schema === "flow.rejection/v1") {
        if (command.expected_watermark !== EMPTY_WATERMARK) {
          return reviewRejection("stale_authority_watermark", command, current);
        }
      } else {
        if (command.expected_watermark !== current.watermark) {
          return reviewRejection("stale_authority_watermark", command, current);
        }
        if (current.candidate_fingerprint !== command.candidate_fingerprint ||
            current.lifecycle_generation !== command.lifecycle_generation) {
          return reviewRejection("review_target_mismatch", command, current);
        }
        return reviewRejection("idempotency_conflict", command, current);
      }
      const candidateProjection = queryCandidateProjection(command.candidate?.candidate_id);
      const candidateIssue = reviewRecordCandidateAuthorityIssue(
        command,
        candidateProjection,
      );
      if (candidateIssue) {
        return reviewRejection(
          candidateIssue.code,
          command,
          candidateIssue.projection ?? current,
        );
      }
      const sourceEffect = typeof sourceEffectIntentReader?.query === "function"
        ? sourceEffectIntentReader.query(
            command.source_run_id,
            command.operation_effect_id,
          )
        : null;
      const sourceIssue = reviewRecordSourceAuthorityIssue(command, {
        effects: sourceEffect === null ? [] : [sourceEffect],
      });
      if (sourceIssue) return reviewRejection(sourceIssue.code, command, current);
      try {
        validateReviewRecordCommand(command);
      } catch (error) {
        return reviewRejection(error.code ?? "invalid_review_record", command, current);
      }
      const body = {
        schema: "flow.review-record/v1",
        review_id: subjectId,
        candidate_fingerprint: command.candidate_fingerprint,
        candidate_authority_watermark: command.candidate_authority_watermark,
        lifecycle_generation: command.lifecycle_generation,
        candidate: command.candidate,
        summary: command.summary,
        automated_evidence: command.automated_evidence,
        artifacts: command.artifacts,
        source_authority_watermark: command.source_authority_watermark,
        ...(command.source_run_id === undefined ? {} : {
          source_run_id: command.source_run_id,
        }),
        operation_contract: command.operation_contract,
        operation_effect_id: command.operation_effect_id,
        operation_attempt_id: command.operation_attempt_id,
        operation_idempotency_key: command.operation_idempotency_key,
      };
      const watermark = reviewEventWatermark({
        previousWatermark: command.expected_watermark,
        event: reviewRecordWatermarkIdentity(body),
      });
      if (command.artifacts?.watermark !== watermark) {
        return reviewRejection("artifact_watermark_mismatch", command, current);
      }
      const commandReceipt = freezeCanonical({
        schema: "work.idempotency-receipt/v1",
        command_id: command.command_id,
        command_digest: idempotencyCommandDigest(command),
      });
      const event = {
        type: "review_recorded",
        command,
        body,
        watermark,
        command_receipt: commandReceipt,
      };
      streams.set(subjectId, [event]);
      return {
        schema: "work.command-receipt/v1",
        command_type: command.type,
        contract: command.contract,
        subject_id: subjectId,
        authority_watermark: watermark,
        accepted: true,
        created: true,
      };
    },
    query(request = {}) {
      if (request?.contract !== "work.review/v1" || typeof request.subject_id !== "string") {
        return reviewRejection("invalid_review_query", request, null, "query");
      }
      if (sealedCandidateProjection?.subject_id === request.subject_id) {
        return sealedCandidateProjection;
      }
      return queryProjection(request.subject_id);
    },
    watch(request = {}) {
      const subjectId = typeof request === "string" ? request : request.subject_id;
      return oneShot(queryProjection(subjectId));
    },
  };
  return Object.freeze(authority);

  function queryProjection(subjectId) {
    const events = streams.get(subjectId);
    if (!events) return emptyProjection(subjectId);
    const event = events[0];
    return projectReviewRecord(event.body, event.watermark, events);
  }

  function queryCandidateProjection(subjectId) {
    if (sealedCandidateProjection?.subject_id !== subjectId) {
      return emptyProjection(subjectId);
    }
    return sealedCandidateProjection;
  }
}

export function projectReviewRecord(body, watermark, events = []) {
  const commandReceipts = events
    .map((event) => event.command_receipt)
    .filter((receipt) => receipt !== undefined);
  return freezeCanonical({
    schema: "flow.review-projection/v1",
    contract: "work.review/v1",
    subject_id: body.review_id,
    watermark,
    authority_watermark: watermark,
    authority_watermark_domain: "review",
    candidate_fingerprint: body.candidate_fingerprint,
    candidate_authority_watermark: body.candidate_authority_watermark,
    lifecycle_generation: body.lifecycle_generation,
    ...(body.source_run_id === undefined ? {} : { source_run_id: body.source_run_id }),
    operation_contract: body.operation_contract,
    operation_effect_id: body.operation_effect_id,
    operation_attempt_id: body.operation_attempt_id,
    operation_idempotency_key: body.operation_idempotency_key,
    candidate: body.candidate,
    status: "automated_completed",
    posture: body.summary.posture,
    findings: body.summary.findings,
    semantic_findings: body.summary.findings,
    rendered_findings: body.summary.rendered_findings,
    cap_reasons: body.summary.cap_reasons,
    summary: body.summary,
    automated_evidence: body.automated_evidence,
    artifacts: body.artifacts,
    ...reviewCompletionAuthority(),
    append_only_event_count: events.length,
    command_receipts: commandReceipts,
    legal_actions: [],
  });
}

export function validateReviewRecordCommand(command) {
  if (!nonEmpty(command?.source_run_id)) {
    throw reviewValidationError(
      "review_source_authority_unavailable",
      "review record requires an exact RunAuthority source run",
    );
  }
  if (!nonEmpty(command.command_id) ||
      command.command_id !==
        `review-record:${command.candidate_fingerprint}:${command.lifecycle_generation}` ||
      !isDigest(command.candidate_fingerprint) ||
      !isDigest(command.candidate_authority_watermark) ||
      !Number.isSafeInteger(command.lifecycle_generation) || command.lifecycle_generation < 1 ||
      command.subject_id !== `review:${command.candidate_fingerprint}:${command.lifecycle_generation}` ||
      command.operation_contract !== REVIEW_OPERATION_CONTRACTS.record ||
      !nonEmpty(command.operation_effect_id) ||
      !nonEmpty(command.operation_attempt_id) ||
      !nonEmpty(command.operation_idempotency_key) ||
      !nonEmpty(command.source_run_id) ||
      !validateReviewCandidate(command.candidate) ||
      command.candidate.candidate_fingerprint !== command.candidate_fingerprint ||
      !isRecord(command.summary) || command.summary.schema !== "flow.review-summary/v1" ||
      command.summary.candidate_fingerprint !== command.candidate_fingerprint ||
      command.summary.candidate_authority_watermark !==
        command.candidate_authority_watermark ||
      command.summary.lifecycle_generation !== command.lifecycle_generation ||
      !isDigest(command.source_authority_watermark) ||
      !isRecord(command.automated_evidence) ||
      command.automated_evidence.schema !== "flow.review-automated-evidence/v1" ||
      !isDigest(command.automated_evidence.source_authority_watermark) ||
      command.source_authority_watermark !==
        command.automated_evidence.source_authority_watermark ||
      !isDeepEqualDigest(command.automated_evidence, command.summary.automated_evidence) ||
      !isRecord(command.artifacts) || command.artifacts.schema !== "flow.review-artifacts/v1") {
    throw reviewValidationError("invalid_review_record", "review record command is incomplete");
  }
  try {
    validateReviewSummary(command.summary, command.automated_evidence);
    normalizeReviewFindings(command.summary.findings, { source: "authority" });
    const renderedFindings = normalizeReviewFindings(
      command.summary.rendered_findings,
      { source: "authority" },
    );
    const stableFindingIds = new Set(command.summary.findings.map(
      ({ finding_id: findingId }) => findingId,
    ));
    if (renderedFindings.some(({ finding_id: findingId }) =>
      !stableFindingIds.has(findingId))) {
      throw reviewValidationError(
        "invalid_review_summary",
        "rendered findings are not retained semantic findings",
      );
    }
  } catch (error) {
    throw reviewValidationError(error.code ?? "malformed_findings", error.message);
  }
  try {
    const provenance = command.artifacts.provenance;
    if (provenance?.operation_contract !== command.operation_contract ||
        !nonEmpty(provenance?.run_id) ||
        command.source_run_id !== undefined && provenance?.run_id !== command.source_run_id ||
        provenance?.operation_effect_id !== command.operation_effect_id ||
        provenance?.operation_attempt_id !== command.operation_attempt_id ||
        provenance?.operation_idempotency_key !== command.operation_idempotency_key) {
      throw reviewValidationError(
        "review_provenance_mismatch",
        "review artifacts are not bound to the registered operation intent",
      );
    }
    const expectedArtifacts = renderReviewArtifacts({
      summary: command.summary,
      watermark: command.artifacts.watermark,
      provenance: command.artifacts.provenance,
    });
    if (!isDeepEqualDigest(expectedArtifacts, command.artifacts)) {
      throw reviewValidationError(
        "artifact_identity_mismatch",
        "review artifacts are not deterministic for the recorded summary",
      );
    }
  } catch (error) {
    throw reviewValidationError(error.code ?? "malformed_review_artifacts", error.message);
  }
}

function validateReviewSummary(summary, automatedEvidence) {
  if (!Array.isArray(summary.enabled_lenses) ||
      new Set(summary.enabled_lenses).size !== summary.enabled_lenses.length ||
      summary.enabled_lenses.some((lens) => !nonEmpty(lens)) ||
      !Array.isArray(summary.lens_results) ||
      summary.lens_results.length !== summary.enabled_lenses.length ||
      !isRecord(summary.critic_result) ||
      !isDigest(summary.candidate_authority_watermark) ||
      !Number.isSafeInteger(summary.finding_cap) || summary.finding_cap < 1 ||
      !["no_findings", "findings", "review_incomplete", "blocked"].includes(summary.posture)) {
    throw reviewValidationError("invalid_review_summary", "review summary is malformed");
  }
  const lensResults = summary.lens_results.map((result, index) => {
    const parsed = parseReviewDelegateResult(result, {
      lens: summary.enabled_lenses[index],
      role: "lens",
    });
    if (!isDeepEqualDigest(parsed, result)) {
      throw reviewValidationError("invalid_review_summary", "lens result is not canonical");
    }
    return parsed;
  });
  const criticResult = parseReviewDelegateResult(summary.critic_result, {
    role: "critic",
  });
  if (!isDeepEqualDigest(criticResult, summary.critic_result)) {
    throw reviewValidationError("invalid_review_summary", "critic result is not canonical");
  }
  const expectedAutomatedEvidence = {
    schema: "flow.review-automated-evidence/v1",
    source_authority_watermark: automatedEvidence.source_authority_watermark,
    lens_evidence: lensResults.map((result, index) => ({
      lens: summary.enabled_lenses[index],
      evidence_digest: digest(result),
    })),
    critic_evidence_digest: digest(criticResult),
  };
  if (!isDeepEqualDigest(expectedAutomatedEvidence, automatedEvidence)) {
    throw reviewValidationError(
      "automated_evidence_mismatch",
      "automated evidence is not bound to the recorded delegate results",
    );
  }
    const recomputed = buildReviewSummary({
      candidateFingerprint: summary.candidate_fingerprint,
      candidateAuthorityWatermark: summary.candidate_authority_watermark,
      lifecycleGeneration: summary.lifecycle_generation,
    enabledLenses: summary.enabled_lenses,
    lensResults: Object.fromEntries(lensResults.map((result, index) => [
      summary.enabled_lenses[index], result,
    ])),
    criticResult,
    sourceAuthorityWatermark: automatedEvidence.source_authority_watermark,
    findingCap: summary.finding_cap,
  });
  if (!isDeepEqualDigest(recomputed.findings, summary.findings) ||
      !isDeepEqualDigest(recomputed.rendered_findings, summary.rendered_findings) ||
      recomputed.posture !== summary.posture ||
      recomputed.finding_cap !== summary.finding_cap ||
      !isDeepEqualDigest(recomputed.cap_reasons, summary.cap_reasons) ||
      !isDeepEqualDigest(recomputed.automated_evidence, summary.automated_evidence)) {
    throw reviewValidationError(
      "review_summary_mismatch",
      "review summary is not recomputed from authority-settled evidence",
    );
  }
}

function reviewRejection(code, command, current, operation = "command") {
  return freezeCanonical({
    schema: "flow.rejection/v1",
    operation,
    code,
    reason: null,
    command_type: command?.type ?? null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: current?.watermark ?? EMPTY_WATERMARK,
    authority_watermark_domain: "review",
    legal_actions: current?.legal_actions ?? [],
  });
}

function oneShot(value) {
  let emitted = false;
  return {
    async next() {
      if (emitted) return { value: undefined, done: true };
      emitted = true;
      return { value, done: false };
    },
    async return() { emitted = true; return { value: undefined, done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
}

export function reviewSubjectId(target) {
  return `review:${target.candidate.candidate_fingerprint}:${target.lifecycle_generation}`;
}

export function reviewEventWatermark({ previousWatermark, event }) {
  return digest({
    schema: "flow.review-authority-watermark/v1",
    previous_watermark: previousWatermark,
    event,
  });
}

export function reviewRecordWatermarkIdentity(body) {
  if (!isRecord(body)) return body;
  const { artifacts: _artifacts, ...identity } = body;
  return identity;
}

export function reviewCompletionAuthority() {
  return Object.freeze({
    automated_completion: true,
    approval: "not_requested",
    integration_authorized: false,
    merge_authorized: false,
    tracker_completion_authorized: false,
    remote_submission_authorized: false,
  });
}

function invalidReview(reason, message) {
  throw new PredefinedFlowValidationError(reason, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function isDeepEqualDigest(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

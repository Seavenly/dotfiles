import {
  digest,
  freezeCanonical,
  idempotencyCommandDigest,
} from "./canonical.mjs";
import { isDeepStrictEqual } from "node:util";
import { operationEffectIdentity } from "./effect-identity.mjs";
import { PredefinedFlowValidationError } from "./plan-compiler.mjs";
import {
  buildReviewSummary,
  normalizeReviewFindings,
  normalizeReviewDiagrams,
  normalizeReviewOrientation,
  REVIEW_COVERAGE_REASON_MAX_LENGTH,
  REVIEW_URGENCY_PRESETS,
  normalizeReviewUrgencyFloor,
  parseReviewDelegateResult,
  renderReviewArtifacts,
  reviewValidationError,
} from "./review-rendering.mjs";
import { validateReviewCandidate } from "./review-candidate.mjs";
import {
  SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
} from "./authority-bindings.mjs";
import {
  DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA,
  DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
} from "./delegate-input-envelope.mjs";

export { validateReviewCandidate };

export const REVIEW_OPERATION_CONTRACTS = Object.freeze({
  record: "flow.operation/review-record/v1",
});

export const REVIEW_HUMAN_COMMAND_SCHEMA =
  "work.review-human-command/v1";
export const REVIEW_OPERATOR_INPUT_SCHEMA =
  "flow.review-operator-input/v1";
export const REVIEW_INBOX_QUERY_CONTRACT = "work.review-inbox/v1";
export const REVIEW_INBOX_PROJECTION_SCHEMA =
  "flow.review-inbox-projection/v1";
export const REVIEW_INBOX_WATERMARK_SCHEMA =
  "flow.review-inbox-watermark/v1";
export const REVIEW_SESSION_SCHEMA = "flow.review-session/v1";
export const REVIEW_HUMAN_EVENT_SCHEMA = "flow.review-human-event/v1";
// The public projection schema is intentionally unchanged.  This private
// fold marker lets the durable authority distinguish a projection written by
// the pre-human-review reducer from one written by the current reducer.
export const REVIEW_PROJECTION_FOLD_CONTRACT =
  "flow.review-projection-fold/v2";
export const REVIEW_LEGACY_PROJECTION_FOLD_CONTRACT =
  "flow.review-projection/v1";
const REVIEW_ACCEPTED_COMMAND_SCHEMA = "flow.review-accepted-command/v1";
export const REVIEW_INTEGRATION_EVIDENCE_SCHEMA =
  "flow.review-integration-evidence/v1";
export const REVIEW_HUMAN_ACTIONS = Object.freeze([
  "review_session_start",
  "review_comment",
  "review_disposition",
  "review_approval",
  "review_supersession",
  "review_integration",
]);
export const REVIEW_DISPOSITIONS = Object.freeze([
  "accept",
  "request_changes",
  "dismiss",
  "defer",
]);

const REVIEW_HUMAN_COMMAND_COMMON_KEYS = Object.freeze([
  "schema",
  "type",
  "contract",
  "command_id",
  "subject_id",
  "review_id",
  "target_fingerprint",
  "candidate_fingerprint",
  "candidate_authority_watermark",
  "lifecycle_generation",
  "expected_watermark",
  "expected_generation",
]);
const REVIEW_HUMAN_COMMAND_ROOT_KEYS = Object.freeze([
  ...REVIEW_HUMAN_COMMAND_COMMON_KEYS,
  "session_id",
  "comment_id",
  "body",
  "finding_id",
  "disposition",
  "decision",
  "operator_input",
  "replacement",
  "evidence",
]);

/**
 * GitHub review creation remains a separate, one-shot effect from the local
 * ReviewAuthority record.  Keeping the contract next to the semantic review
 * graph lets both targets share lenses, critic joining, rendering, and
 * evidence provenance while the Forge Adapter owns only remote mechanics.
 */
export const GITHUB_REVIEW_OPERATION_CONTRACTS = Object.freeze({
  pending: "flow.operation/github-review-pending/v1",
});

export const GITHUB_REVIEW_TARGET_SCHEMA =
  "flow.review-github-pull-request/v1";

export const GITHUB_REVIEW_SNAPSHOT_SCHEMA =
  "flow.github-pull-request-snapshot/v1";

export const GITHUB_REVIEW_RECEIPT_VALIDATOR =
  "flow.validator/github-review-receipt/v1";

export const GITHUB_REVIEW_PROVIDER_RECEIPT_SCHEMA =
  "flow.github-review-receipt/v1";

export const GITHUB_REVIEW_RECORD_COMMAND_SCHEMA =
  "work.github-review-record-command/v1";
export const GITHUB_REVIEW_RECORD_SCHEMA = "flow.github-review-record/v1";

export const GITHUB_REVIEW_PENDING_CHECKPOINT_ID =
  "review-github-pending-checkpoint";

export const REVIEW_OPERATION_REGISTRATION_POLICY =
  "review_authority_owned_builtin_reserved";

export const REVIEW_DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/review-result/v1";

export const REVIEW_CANDIDATE_CURRENCY_STATUSES = Object.freeze([
  "sealed",
  "stale",
  "blocked",
]);

export const REVIEW_CANDIDATE_LIFECYCLE_STATUSES = Object.freeze([
  "sealed",
  "superseded",
  "abandoned",
]);

export const REVIEW_CANDIDATE_CURRENCY_BLOCKING_REASONS = Object.freeze([
  "workspace_authority_unavailable",
  "workspace_mutation_epoch_moved",
  "workspace_dirty",
  "unresolved_effect",
  "workspace_tainted",
  "artifact_uncertain",
  "artifact_unavailable",
  "git_retention_unavailable",
  "git_retention_mismatch",
  "artifact_handoff_pin_missing",
  "artifact_handoff_pin_mismatch",
  "handoff_unavailable",
  "handoff_inactive",
  "handoff_uncertain",
  "handoff_not_current",
  "handoff_workspace_mismatch",
  "handoff_artifact_mismatch",
  "handoff_git_retention_mismatch",
  "candidate_lifecycle_superseded",
  "candidate_lifecycle_abandoned",
]);

const GITHUB_REVIEW_SAFE_OBSERVATION_CODES = new Set([
  "github_review_adapter_incomplete",
  "github_review_adapter_unavailable",
  "github_review_checkpoint_draft_mismatch",
  "github_review_creation_unavailable",
  "github_review_listing_incomplete",
  "github_review_listing_invalid",
  "github_review_listing_unavailable",
  "github_review_observation_incomplete",
  "github_review_operation_intent_mismatch",
  "github_review_receipt_ambiguous",
  "github_review_receipt_unresolved",
  "github_review_target_moved",
  "github_review_target_observation_unavailable",
]);

const REVIEW_TERMINAL_DISPOSITION_SCHEMA =
  "flow.review-terminal-disposition/v1";
const REVIEW_COVERAGE_STATUSES = Object.freeze([
  "produced",
  "degraded",
  "unavailable",
]);
const REVIEW_COVERAGE_RANK = Object.freeze({
  produced: 0,
  degraded: 1,
  unavailable: 2,
});

export function sanitizeGitHubReviewProviderObservation(value) {
  if (!isRecord(value)) return null;
  if (value.schema === GITHUB_REVIEW_PROVIDER_RECEIPT_SCHEMA) {
    return sanitizeGitHubReviewProviderReceipt(value);
  }
  if (value.schema !== "flow.github-review-observation/v1") return null;
  const result = { schema: value.schema };
  if (GITHUB_REVIEW_SAFE_OBSERVATION_CODES.has(value.code)) {
    result.code = value.code;
  }
  if (GITHUB_REVIEW_SAFE_OBSERVATION_CODES.has(value.provider_error_code)) {
    result.provider_error_code = value.provider_error_code;
  }
  const safeReason = GITHUB_REVIEW_SAFE_OBSERVATION_CODES.has(value.code)
    ? value.code
    : GITHUB_REVIEW_SAFE_OBSERVATION_CODES.has(value.provider_error_code)
      ? value.provider_error_code
      : null;
  if (safeReason !== null) result.reason = safeReason;
  for (const key of ["pending_review_count", "matching_review_count"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) {
      result[key] = value[key];
    }
  }
  if (typeof value.complete === "boolean") result.complete = value.complete;
  return result;
}

function sanitizeGitHubReviewProviderReceipt(value) {
  const requiredStrings = [
    "review_id",
    "target_fingerprint",
    "target_authority_watermark",
    "draft_digest",
    "effect_id",
    "idempotency_key",
    "marker",
  ];
  if (value.action !== "create_pending_review" ||
      value.state !== "pending" ||
      value.submitted !== false ||
      requiredStrings.some((key) => !nonEmpty(value[key])) ||
      !isRecord(value.repository) ||
      !nonEmpty(value.repository.owner) ||
      !nonEmpty(value.repository.name) ||
      !Number.isSafeInteger(value.pull_request_number) ||
      !nonEmpty(value.commit_id) ||
      !isRecord(value.provider_review) ||
      value.provider_review.state !== "pending" ||
      value.provider_review.submitted !== false) {
    return null;
  }
  return {
    schema: GITHUB_REVIEW_PROVIDER_RECEIPT_SCHEMA,
    action: "create_pending_review",
    review_id: value.review_id,
    target_fingerprint: value.target_fingerprint,
    target_authority_watermark: value.target_authority_watermark,
    draft_digest: value.draft_digest,
    effect_id: value.effect_id,
    idempotency_key: value.idempotency_key,
    state: "pending",
    submitted: false,
    marker: value.marker,
    repository: {
      owner: value.repository.owner,
      name: value.repository.name,
    },
    pull_request_number: value.pull_request_number,
    commit_id: value.commit_id,
    provider_review: {
      review_id: nonEmpty(value.provider_review.review_id)
        ? value.provider_review.review_id
        : value.review_id,
      state: "pending",
      submitted: false,
    },
  };
}

export const REVIEW_LENSES = Object.freeze([
  "security",
  "correctness",
  "tests",
  "style",
  "observability",
]);

export function githubPendingEffectIdentity({ runId } = {}) {
  return operationEffectIdentity({
    runId,
    cardId: "review-github-pending",
    operationContract: GITHUB_REVIEW_OPERATION_CONTRACTS.pending,
  });
}

const REVIEW_DEFINITION_SCHEMA = "flow.predefined-definition/v1";
const REVIEW_SELECTION_SCHEMA = "flow.review-request/v1";
const REVIEW_TARGET_SCHEMA = "flow.review-local-candidate/v1";
const REVIEW_BINDINGS_SCHEMA = "flow.review-delegation-bindings/v1";
const GITHUB_PENDING_REQUEST_SCHEMA = "flow.github-pending-review-request/v1";
const REVIEW_NEGATIVE_OUTCOME =
  "automated completion is not approval and cannot integrate, merge, complete a tracker, or submit a remote review";

const PROMISED_OUTCOMES = Object.freeze([
  "one exact verified review target receives every selected finding lens and one fresh critic",
  "stable findings, posture, evidence, and deterministic review artifacts are retained",
]);

const TRUST_POSTURE = Object.freeze({
  schema: "flow.review-trust-posture/v1",
  evidence: "isolated_delegates_and_registered_review_authority",
  completion: "automated_not_approval",
  target: "exact_local_candidate_or_github_snapshot_only",
});

export function createReviewDefinition() {
  return {
    schema: REVIEW_DEFINITION_SCHEMA,
    id: "review/v1",
    contract: "flow.definition/review/v1",
    promised_outcomes: [...PROMISED_OUTCOMES],
    negative_outcomes: [REVIEW_NEGATIVE_OUTCOME],
    trust_posture: { ...TRUST_POSTURE },
    required_authorities: SHIPPED_PREDEFINED_AUTHORITY_REQUIREMENTS,
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
      commands: [
        "cancel",
        "delegate_execute",
        "operation_execute",
        "terminal_disposition",
        ...(selection.create_pending_review ? ["checkpoint_decision"] : []),
      ],
      capabilities: [],
      mutations: [
        REVIEW_OPERATION_CONTRACTS.record,
        ...(selection.create_pending_review
          ? [GITHUB_REVIEW_OPERATION_CONTRACTS.pending]
          : []),
      ],
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
  const targetKind = reviewTargetKind(target);
  if (targetKind === "local") {
    if (!Number.isSafeInteger(target.lifecycle_generation) ||
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
  } else if (targetKind === "github") {
    try {
      validateGitHubReviewTarget(target);
    } catch (error) {
      invalidReview(
        error.code ?? "invalid_review_target",
        error.message ?? "review/v1 GitHub target is incomplete",
      );
    }
  } else {
    invalidReview(
      "invalid_review_target",
      "review/v1 requires one exact local candidate or GitHub pull-request snapshot",
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
  if (targetKind === "local" &&
      (!Array.isArray(explicitFacts.resource_claims) ||
       !explicitFacts.resource_claims.some((claim) =>
         reviewWorkspaceClaimMatches(claim, target.candidate.workspace)))) {
    invalidReview(
      "missing_review_workspace_authority",
      "local review requires the exact WorkspaceAuthority resource fact",
    );
  }
  const findingCap = inputs.finding_cap ?? inputs.limits?.max_findings ?? 100;
  if (!Number.isSafeInteger(findingCap) || findingCap < 1) {
    invalidReview("invalid_finding_cap", "review/v1 finding cap must be positive");
  }
  const urgency = inputs.urgency ?? inputs.urgency_preset ?? "standard";
  if (!Object.hasOwn(REVIEW_URGENCY_PRESETS, urgency)) {
    invalidReview("invalid_review_urgency", "review/v1 urgency must be hotfix, fast, or standard");
  }
  let urgencyFloor;
  try {
    urgencyFloor = normalizeReviewUrgencyFloor(inputs.urgency_floor ?? urgency);
  } catch (error) {
    invalidReview(
      "invalid_urgency_floor",
      "review/v1 urgency_floor is not a recognized urgency tier or preset",
    );
  }
  let orientation;
  let diagrams;
  try {
    orientation = normalizeReviewOrientation(inputs.orientation);
    diagrams = normalizeReviewDiagrams(inputs.diagrams);
  } catch (error) {
    invalidReview(
      error.code ?? "malformed_review_supplement",
      error.message,
    );
  }
  const createPendingReview = wantsPendingGitHubReview(inputs);
  if (createPendingReview && targetKind !== "github") {
    invalidReview(
      "invalid_github_review_target",
      "pending GitHub review creation requires an exact GitHub target",
    );
  }
  if (createPendingReview &&
      !explicitFacts.operation_contracts.includes(
        GITHUB_REVIEW_OPERATION_CONTRACTS.pending,
      )) {
    invalidReview(
      "incomplete_github_review_contracts",
      "pending GitHub review creation requires its registered operation",
    );
  }
  if (createPendingReview &&
      !explicitFacts.validator_contracts.includes(GITHUB_REVIEW_RECEIPT_VALIDATOR)) {
    invalidReview(
      "incomplete_github_review_contracts",
      "pending GitHub review creation requires its provider receipt validator",
    );
  }
  return freezeCanonical({
    target,
    target_kind: targetKind,
    lenses: [...inputs.lenses].sort(),
    delegation: bindings,
    finding_cap: findingCap,
    urgency,
    urgency_floor: urgencyFloor,
    orientation,
    diagrams,
    create_pending_review: createPendingReview,
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
  const target = command.target ?? {
    schema: REVIEW_TARGET_SCHEMA,
    candidate: command.candidate,
    candidate_fingerprint: command.candidate_fingerprint,
    candidate_authority_watermark: command.candidate_authority_watermark,
    lifecycle_generation: command.lifecycle_generation,
  };
  const targetFingerprint = reviewTargetFingerprint(target);
  const targetAuthorityWatermark = reviewTargetAuthorityWatermark(target);
  if (!targetFingerprint || !targetAuthorityWatermark ||
      !isDeepEqualDigest(input?.target, target) ||
      !isDeepEqualDigest(input?.lenses, command.summary?.enabled_lenses) ||
      !Number.isSafeInteger(input?.finding_cap) ||
      input.finding_cap !== command.summary?.finding_cap ||
      input.urgency_floor !== command.summary?.urgency_floor ||
      !isDeepEqualDigest(input.orientation ?? null, command.summary?.orientation) ||
      !isDeepEqualDigest(input.diagrams ?? [], command.summary?.diagrams)) {
    return { code: "review_source_intent_mismatch", reason: "review target or declared review inputs differ from RunAuthority" };
  }
  const accepted = input.authority_materialized_evidence?.accepted_delegates;
  if (!Array.isArray(accepted) || accepted.length !== input.delegate_evidence_card_ids?.length ||
      !isDeepEqualDigest([...accepted].map(({ card_id: id }) => id), input.delegate_evidence_card_ids)) {
    return { code: "review_source_evidence_mismatch", reason: "review evidence is not authority-materialized" };
  }
  const lensResults = {};
  let criticResult;
  const invalidDelegateEvidence = [];
  try {
    for (const evidence of accepted) {
      if (evidence.card_id === "review-critic") continue;
      try {
        lensResults[evidence.card_id.replace(/^review-lens-/u, "")] =
          materializeReviewDelegateResult(evidence);
      } catch (error) {
        const fallback = reviewEvidenceFallbackEntry(
          command.evidence_validation,
          evidence,
          error,
        );
        if (fallback === null) {
          return {
            code: error?.code ?? "review_source_evidence_mismatch",
            reason: "authority-materialized review evidence is malformed",
          };
        }
        invalidDelegateEvidence.push(fallback);
        lensResults[evidence.card_id.replace(/^review-lens-/u, "")] =
          unavailableReviewDelegateResult();
      }
    }
    const critic = accepted.find(({ card_id: id }) => id === "review-critic");
    if (!critic) {
      return { code: "review_source_evidence_mismatch", reason: "authority-materialized critic evidence is missing" };
    }
    try {
      criticResult = materializeReviewDelegateResult(critic);
    } catch (error) {
      const fallback = reviewEvidenceFallbackEntry(
        command.evidence_validation,
        critic,
        error,
      );
      if (fallback === null) {
        return {
          code: error?.code ?? "review_source_evidence_mismatch",
          reason: "authority-materialized review evidence is malformed",
        };
      }
      invalidDelegateEvidence.push(fallback);
      criticResult = unavailableReviewDelegateResult();
    }
  } catch (error) {
    return {
      code: error?.code ?? "review_source_evidence_mismatch",
      reason: "authority-materialized review evidence is malformed",
    };
  }
  const evidenceValidationIssue = reviewEvidenceValidationIssue(
    command.evidence_validation,
    invalidDelegateEvidence,
  );
  if (evidenceValidationIssue !== null) {
    return evidenceValidationIssue;
  }
  let expected;
  try {
    expected = buildReviewSummary({
      candidateFingerprint: targetFingerprint,
      candidateAuthorityWatermark: targetAuthorityWatermark,
      lifecycleGeneration: command.lifecycle_generation,
      enabledLenses: input.lenses,
      lensResults,
      criticResult,
      sourceAuthorityWatermark: effect.source_authority_watermark,
      findingCap: input.finding_cap,
      urgencyFloor: input.urgency_floor,
      orientation: input.orientation,
      diagrams: input.diagrams,
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

/**
 * Replace delegate self-declared coverage with the terminal disposition
 * materialized by RunAuthority. A normal successful settlement is explicitly
 * produced; only an authority disposition may make a participant degraded or
 * unavailable.
 */
export function materializeReviewDelegateResult(acceptedDelegate) {
  const evidence = acceptedDelegate?.evidence;
  const output = evidence?.validated_output ?? evidence;
  const cardId = acceptedDelegate?.card_id;
  const lens = typeof cardId === "string" && cardId.startsWith("review-lens-")
    ? cardId.slice("review-lens-".length)
    : null;
  const value = parseReviewDelegateResult(output, {
    lens,
    role: lens === null ? "critic" : "lens",
  });
  const selfCoverage = materializedReviewCoverage(value.coverage ??
    value.terminal_disposition, "delegate");
  const disposition = evidence?.authority_terminal_disposition;
  let authorityCoverage = null;
  if (disposition !== undefined) {
    if (!isRecord(disposition) ||
        disposition.schema !== REVIEW_TERMINAL_DISPOSITION_SCHEMA ||
        disposition.authority !== "RunAuthority" ||
        !REVIEW_COVERAGE_STATUSES.includes(disposition.status) ||
        disposition.status !== "produced" &&
          !isSafeReviewReason(disposition.reason)) {
      throw reviewValidationError(
        "malformed_review_coverage",
        "review terminal disposition is not authority materialized",
      );
    }
    authorityCoverage = {
      status: disposition.status,
      reason: disposition.status === "produced" ? null : disposition.reason,
    };
  }
  const effectiveCoverage = combineReviewCoverage(
    selfCoverage,
    authorityCoverage,
    value.posture,
  );
  const posture = value.posture ??
    (effectiveCoverage.status === "produced" ? "no_findings" : "review_incomplete");
  return {
    ...value,
    posture: posture === "blocked"
      ? "blocked"
      : effectiveCoverage.status === "produced"
        ? posture
        : "review_incomplete",
    coverage: {
      schema: "flow.review-coverage/v1",
      ...effectiveCoverage,
    },
  };
}

function candidateLifecycleStatus(projection) {
  const status = projection?.lifecycle_status ??
    projection?.candidate_lifecycle_status ?? projection?.status;
  return REVIEW_CANDIDATE_LIFECYCLE_STATUSES.includes(status)
    ? status
    : "sealed";
}

function terminalCandidateLifecycleProjection(projection) {
  const lifecycleStatus = candidateLifecycleStatus(projection);
  if (lifecycleStatus === "sealed") return projection;
  return freezeCanonical({
    ...projection,
    status: "stale",
    lifecycle_status: lifecycleStatus,
    current: false,
    evidence_currency: "stale",
    blocking_reasons: [`candidate_lifecycle_${lifecycleStatus}`],
    legal_actions: [],
  });
}

function reviewCandidateProjectionIssue(target, projection) {
  const lifecycleStatus = candidateLifecycleStatus(projection);
  if (projection?.schema !== "work.review-candidate-projection/v1" ||
      projection.contract !== "work.review/v1" ||
      !REVIEW_CANDIDATE_CURRENCY_STATUSES.includes(projection.status) &&
        !REVIEW_CANDIDATE_LIFECYCLE_STATUSES.includes(projection.status)) {
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
  if (lifecycleStatus !== "sealed") {
    return {
      code: "candidate_lifecycle_terminal",
      reason: `candidate lifecycle is ${lifecycleStatus} and cannot authorize review`,
      projection,
    };
  }
  if (projection.status === "stale") {
    return {
      code: "candidate_workspace_moved",
      reason: "the candidate workspace mutation epoch is no longer current",
      projection,
    };
  }
  if (projection.status === "blocked") {
    return {
      code: "candidate_workspace_blocked",
      reason: "the candidate workspace or artifact state is blocking review",
      projection,
    };
  }
  return null;
}

/**
 * Reconcile a sealed candidate against the current Work-domain subjects.
 * Candidate and review streams retain their original evidence; this derived
 * view only fences that evidence when the workspace or retained bytes have
 * moved, become dirty, or become uncertain.
 */
export function projectReviewCandidateCurrency(
  projection,
  workspace,
  artifacts = [],
  observations = null,
) {
  if (projection?.schema !== "work.review-candidate-projection/v1") {
    return projection;
  }
  const candidateWorkspace = projection.candidate?.workspace ?? projection.workspace;
  const lifecycleStatus = candidateLifecycleStatus(projection);
  const reasons = [];
  if (lifecycleStatus !== "sealed") {
    reasons.push(`candidate_lifecycle_${lifecycleStatus}`);
  }
  if (!isRecord(workspace) || workspace.schema !== "work.workspace-projection/v1") {
    reasons.push("workspace_authority_unavailable");
  } else {
    const workspaceFingerprint = isRecord(workspace.git)
      ? digest({ git: workspace.git })
      : null;
    if (workspaceFingerprint === null) {
      reasons.push("workspace_authority_unavailable");
    }
    if (workspaceFingerprint !== null &&
        (workspace.subject_id !== candidateWorkspace?.subject_id ||
          workspace.generation !== candidateWorkspace?.generation ||
          workspace.mutation_epoch !== candidateWorkspace?.mutation_epoch ||
          workspaceFingerprint !== candidateWorkspace?.fingerprint)) {
      reasons.push("workspace_mutation_epoch_moved");
    }
    if (workspace.git?.clean !== true) reasons.push("workspace_dirty");
    if (workspace.taint !== null) {
      reasons.push(workspace.taint?.reason === "effect_outcome_uncertain"
        ? "unresolved_effect"
        : workspace.taint?.reason === "workspace_dirty"
          ? "workspace_dirty"
          : "workspace_tainted");
    }
  }
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || artifact.schema !== "work.artifact-projection/v1" ||
        artifact.status === "uncertain") {
      reasons.push("artifact_uncertain");
    } else if (artifact.status === "collected" ||
               artifact.byte_availability !== "available") {
      reasons.push("artifact_unavailable");
    }
  }
  const retentionObservation = observations?.git_retention_observation ?? null;
  if (observations !== null) {
    const retention = projection.candidate?.git_retention ?? projection.git_retention;
    if (!isRecord(retentionObservation) ||
        retentionObservation.schema !== "flow.git-retention-observation/v1" ||
        retentionObservation.available !== true) {
      reasons.push("git_retention_unavailable");
    } else if (retentionObservation.repository_id !== retention?.repository_id ||
        retentionObservation.commit_sha !== retention?.commit_sha ||
        retentionObservation.tree_sha !== retention?.tree_sha ||
        retentionObservation.retention_ref !== retention?.retention_ref) {
      reasons.push("git_retention_mismatch");
    }
    const handoffIssue = observations.handoff_issue ?? null;
    if (handoffIssue !== null) {
      reasons.push(handoffIssue);
    } else {
      const handoff = observations.handoff;
      const handoffReasonsBeforeStatus = reasons.length;
      if (handoff?.status === "uncertain") {
        reasons.push("handoff_uncertain");
      } else if (handoff?.status !== "active") {
        reasons.push("handoff_inactive");
      }
      if (observations.handoff_workspace_matches === false) {
        reasons.push("handoff_workspace_mismatch");
      }
      if (observations.handoff_artifacts_match === false) {
        reasons.push("handoff_artifact_mismatch");
      }
      if (observations.handoff_git_retention_matches === false) {
        reasons.push("handoff_git_retention_mismatch");
      }
      // Handoff subject availability also reflects an unrelated consumer's
      // mutation claim. Candidate currency has already compared the exact
      // workspace identity above; only retained bytes and Git availability
      // are currentness gates here.
      if (handoff?.status === "active" &&
          (handoff.byte_availability !== "available" ||
           handoff.git_availability !== "available") &&
          handoffReasonsBeforeStatus === 0 &&
          reasons.length === handoffReasonsBeforeStatus) {
        reasons.push("handoff_not_current");
      }
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  const moved = uniqueReasons.includes("workspace_mutation_epoch_moved");
  const derivedStatus = moved ? "stale" : uniqueReasons.length > 0 ? "blocked" : "sealed";
  const status = lifecycleStatus === "sealed" ? derivedStatus : "stale";
  const current = lifecycleStatus === "sealed" && status === "sealed";
  return freezeCanonical({
    ...projection,
    status,
    current,
    evidence_currency: current ? "current" : "stale",
    ...(lifecycleStatus === "sealed" ? {} : {
      lifecycle_status: lifecycleStatus,
    }),
    workspace_authority_watermark: workspace?.watermark ?? null,
    workspace_generation: workspace?.generation ?? null,
    workspace_mutation_epoch: workspace?.mutation_epoch ?? null,
    workspace_fingerprint: isRecord(workspace?.git)
      ? digest({ git: workspace.git })
      : null,
    ...(observations === null ? {} : {
      artifact_authority_watermarks: artifacts.map((artifact) =>
        artifact?.watermark ?? null),
      git_retention_observation: retentionObservation,
      git_retention_observation_watermark: retentionObservation === null
        ? null
        : digest(retentionObservation),
      handoff_authority_watermark: observations.handoff?.authority_watermark ?? null,
      handoff_observation_watermark: observations.handoff?.watermark ?? null,
      handoff_status: observations.handoff?.status ?? null,
    }),
    blocking_reasons: uniqueReasons,
    // A replacement candidate is required after movement. No command can
    // safely invent its identity, so the stale/blocked projection is closed.
    legal_actions: [],
  });
}

/**
 * Apply the same current-workspace fence to a recorded review projection.
 * The review event and artifacts remain historical, while authorization is
 * removed from the disposable projection until a fresh candidate is sealed.
 */
export function projectReviewCurrency(
  projection,
  workspace,
  artifacts = [],
  observations = null,
  candidateLifecycleProjection = null,
) {
  const lifecycleStatus = candidateLifecycleStatus(
    candidateLifecycleProjection ?? projection,
  );
  if (projection?.schema !== "flow.review-projection/v1" ||
      projection.current !== true && lifecycleStatus === "sealed") return projection;
  const candidateLifecycle = {
    schema: "work.review-candidate-projection/v1",
    contract: "work.review/v1",
    candidate: projection.candidate,
    workspace: projection.candidate?.workspace,
    git_retention: projection.candidate?.git_retention,
    status: lifecycleStatus,
    ...(lifecycleStatus === "sealed" ? {} : {
      lifecycle_status: lifecycleStatus,
    }),
    legal_actions: [],
  };
  const candidateProjection = lifecycleStatus !== "sealed" &&
      workspace === null && observations === null
    ? terminalCandidateLifecycleProjection(candidateLifecycle)
    : projectReviewCandidateCurrency(
      candidateLifecycle,
      workspace,
      artifacts,
      observations,
    );
  if (candidateProjection.status === "sealed") {
    return freezeCanonical({
      ...projection,
      ...(lifecycleStatus === "sealed" ? {} : {
        candidate_lifecycle_status: lifecycleStatus,
      }),
      workspace_authority_watermark: candidateProjection.workspace_authority_watermark,
      workspace_generation: candidateProjection.workspace_generation,
      workspace_mutation_epoch: candidateProjection.workspace_mutation_epoch,
      workspace_fingerprint: candidateProjection.workspace_fingerprint,
      ...(observations === null ? {} : {
        artifact_authority_watermarks:
          candidateProjection.artifact_authority_watermarks,
        git_retention_observation: candidateProjection.git_retention_observation,
        git_retention_observation_watermark:
          candidateProjection.git_retention_observation_watermark,
        handoff_authority_watermark: candidateProjection.handoff_authority_watermark,
        handoff_observation_watermark:
          candidateProjection.handoff_observation_watermark,
        handoff_status: candidateProjection.handoff_status,
      }),
      blocking_reasons: [],
    });
  }
  return freezeCanonical({
    ...projection,
    ...(lifecycleStatus === "sealed" ? {} : {
      candidate_lifecycle_status: lifecycleStatus,
    }),
    status: "stale",
    current: false,
    evidence_currency: "stale",
    workspace_authority_watermark: candidateProjection.workspace_authority_watermark ?? null,
    workspace_generation: candidateProjection.workspace_generation ?? null,
    workspace_mutation_epoch: candidateProjection.workspace_mutation_epoch ?? null,
    workspace_fingerprint: candidateProjection.workspace_fingerprint ?? null,
    ...(observations === null ? {} : {
      artifact_authority_watermarks:
        candidateProjection.artifact_authority_watermarks,
      git_retention_observation: candidateProjection.git_retention_observation,
      git_retention_observation_watermark:
        candidateProjection.git_retention_observation_watermark,
      handoff_authority_watermark: candidateProjection.handoff_authority_watermark,
      handoff_observation_watermark:
        candidateProjection.handoff_observation_watermark,
      handoff_status: candidateProjection.handoff_status,
    }),
    blocking_reasons: candidateProjection.blocking_reasons,
    approval: "ineligible",
    approval_eligible: false,
    submission_pending: false,
    submission_eligible: false,
    integration_eligible: false,
    integration_authorized: false,
    merge_eligible: false,
    merge_authorized: false,
    tracker_completion_eligible: false,
    tracker_completion_authorized: false,
    remote_submission_authorized: false,
    // Movement is handled by a new candidate run; this projection exposes no
    // caller-shaped refresh that could authorize stale evidence.
    legal_actions: [],
  });
}

/**
 * Return the semantic target kind without consulting a provider.  The target
 * is immutable preparation input; provider reads happen only at the effect
 * boundary in the Forge Adapter below.
 */
export function reviewTargetKind(target) {
  if (target?.schema === REVIEW_TARGET_SCHEMA) return "local";
  if (target?.schema === GITHUB_REVIEW_TARGET_SCHEMA) return "github";
  return null;
}

export function reviewTargetFingerprint(target) {
  if (reviewTargetKind(target) === "local") {
    return target.candidate_fingerprint;
  }
  if (reviewTargetKind(target) === "github") {
    return target.snapshot_fingerprint;
  }
  return null;
}

export function reviewTargetAuthorityWatermark(target) {
  if (reviewTargetKind(target) === "local") {
    return target.candidate_authority_watermark;
  }
  if (reviewTargetKind(target) === "github") {
    return target.target_authority_watermark;
  }
  return null;
}

export function validateGitHubReviewTarget(target) {
  if (!isRecord(target) || target.schema !== GITHUB_REVIEW_TARGET_SCHEMA) {
    throw reviewValidationError(
      "invalid_github_review_target",
      "GitHub review target must use the exact pull-request target schema",
    );
  }
  const repository = target.repository;
  const snapshot = target.snapshot;
  const repositoryValid = isRecord(repository) &&
    nonEmpty(repository.owner) && nonEmpty(repository.name);
  if (!repositoryValid ||
      !Number.isSafeInteger(target.pull_request_number) ||
      target.pull_request_number < 1 ||
      !Number.isSafeInteger(target.lifecycle_generation) ||
      target.lifecycle_generation < 1 ||
      !isDigest(target.target_authority_watermark) ||
      !isRecord(snapshot) ||
      snapshot.schema !== GITHUB_REVIEW_SNAPSHOT_SCHEMA ||
      snapshot.state !== "open" ||
      !validGitSha(snapshot.base_sha) ||
      !validGitSha(snapshot.head_sha) ||
      !isDigest(snapshot.diff_sha256) ||
      !isDigest(target.snapshot_fingerprint) ||
      target.snapshot_fingerprint !== digest(snapshot) ||
      !isDeepEqualDigest(snapshot.repository, repository) ||
      snapshot.pull_request_number !== target.pull_request_number) {
    throw reviewValidationError(
      "invalid_github_review_target",
      "GitHub review target must bind one open repository, pull request, and exact snapshot",
    );
  }
  return true;
}

function wantsPendingGitHubReview(inputs) {
  const request = inputs?.pending_review;
  if (request === undefined) return false;
  if (!isRecord(request) ||
      Object.keys(request).length !== 2 ||
      request.schema !== GITHUB_PENDING_REQUEST_SCHEMA ||
      request.mode !== "create_pending_unsubmitted") {
    invalidReview(
      "invalid_github_pending_request",
      "pending GitHub review request must be the exact versioned pending-only shape",
    );
  }
  return true;
}

function validGitSha(value) {
  return /^[0-9a-f]{40}$/u.test(value ?? "");
}

function reviewCards(selection) {
  const targetFingerprint = reviewTargetFingerprint(selection.target);
  const workspaceClaim = reviewWorkspaceClaim(selection);
  const common = {
    outputs: ["flow.review-result/v1"],
    success_criteria: ["delegate_observation:accepted"],
    validators: [REVIEW_DELEGATE_OUTPUT_VALIDATOR],
    data_references: [targetFingerprint],
    evidence_references: [targetFingerprint],
    limits: { max_attempts: 1 },
    resource_claims: workspaceClaim === null ? [] : [workspaceClaim],
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
        prompt: `Review the exact review target through the ${lens} finding lens and return flow.review-result/v1 JSON`,
        description: binding.description,
        wait_timeout_ms: 300_000,
        finding_lens: lens,
        task_inputs: reviewDelegateTaskInputs(selection, {
          lens,
          role: "lens",
        }),
        resource_references: reviewResourceSelections(selection),
        output_requirements: reviewDelegateOutputRequirements(),
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
      prompt: "Critique every enabled review finding lens result for the exact review target and return flow.review-result/v1 JSON",
      description: selection.delegation.critic.description,
      wait_timeout_ms: 300_000,
      finding_lens_join: "all_enabled",
      finding_lens_card_ids: selection.lenses.map((lens) => `review-lens-${lens}`).sort(),
      task_inputs: reviewDelegateTaskInputs(selection, {
        role: "critic",
      }),
      resource_references: reviewResourceSelections(selection),
      output_requirements: reviewDelegateOutputRequirements(),
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
      urgency_floor: selection.urgency_floor,
      orientation: selection.orientation,
      diagrams: selection.diagrams,
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
    data_references: [targetFingerprint],
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
  if (!selection.create_pending_review) return [...lensCards, critic, record];

  const checkpoint = {
    id: GITHUB_REVIEW_PENDING_CHECKPOINT_ID,
    dependencies: [record.id],
    inputs: {
      operation_card_id: "review-github-pending",
      target: selection.target,
      draft: {
        schema: GITHUB_PENDING_REQUEST_SCHEMA,
        mode: "create_pending_unsubmitted",
        target_fingerprint: targetFingerprint,
      },
      required_checkpoint_binding_schema: "flow.checkpoint-binding/v1",
      prompt: "Confirm creation of one exact unsubmitted pending GitHub review draft",
      completion_authority: "pending_only_no_submission",
    },
    outputs: ["flow.checkpoint-decision/v1"],
    success_criteria: ["operator_decision:accept_or_decline"],
    validators: ["flow.validator/checkpoint-decision/v1"],
    data_references: [targetFingerprint],
    evidence_references: [record.id],
    route: null,
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "checkpoint",
    executor: {
      kind: "checkpoint",
      contract: "flow.checkpoint/confirmation/v1",
    },
  };
  const pending = {
    id: "review-github-pending",
    dependencies: [checkpoint.id],
    inputs: {
      target: selection.target,
      draft: checkpoint.inputs.draft,
      delegate_evidence_card_ids: [],
      operation_evidence_card_ids: [record.id],
      provider_receipt_validator: GITHUB_REVIEW_RECEIPT_VALIDATOR,
      completion_authority: "pending_only_no_submission",
      receipt_owner: "GitHubReviewAdapter",
    },
    outputs: ["flow.github-review-receipt/v1"],
    success_criteria: ["registered_operation_receipt:succeeded"],
    validators: ["flow.validator/operation-receipt/v1"],
    data_references: [targetFingerprint],
    evidence_references: [record.id],
    route: null,
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "one_shot_uncertain",
    executor: {
      kind: "operation",
      contract: GITHUB_REVIEW_OPERATION_CONTRACTS.pending,
      effect_classification: "one_shot_uncertain",
    },
  };
  return [...lensCards, critic, record, checkpoint, pending];
}

function reviewDelegateTaskInputs(selection, { lens, role }) {
  return {
    schema: "flow.delegate-task-inputs/v1",
    flow: "review/v1",
    role,
    ...(lens === undefined ? {} : { lens }),
    ...(role === "critic" ? { lenses: [...selection.lenses] } : {}),
    target: selection.target,
  };
}

function reviewWorkspaceClaim(selection) {
  if (selection.target_kind !== "local") return null;
  const workspace = selection.target.candidate.workspace;
  return {
    kind: "workspace",
    id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: workspace.fingerprint,
  };
}

function reviewWorkspaceClaimMatches(claim, workspace) {
  return isRecord(claim) &&
    claim.kind === "workspace" &&
    claim.id === workspace.subject_id &&
    claim.generation === workspace.generation &&
    claim.mutation_epoch === workspace.mutation_epoch &&
    claim.fingerprint === workspace.fingerprint;
}

function reviewResourceSelections(selection) {
  const workspace = reviewWorkspaceClaim(selection);
  if (workspace === null) return [];
  return [{
    schema: DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA,
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: workspace.id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: workspace.fingerprint,
    access: "read_only",
    authority_binding_id: "resource:facts",
  }];
}

function reviewDelegateOutputRequirements() {
  return {
    schema: DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
    format: "canonical-json",
    schemas: ["flow.review-result/v1"],
    validator_contracts: [REVIEW_DELEGATE_OUTPUT_VALIDATOR],
  };
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

export function createReviewOperationRegistration({
  reviewAuthority,
  githubReviewAuthority = createInMemoryGitHubReviewAuthority(),
} = {}) {
  if (!reviewAuthority || typeof reviewAuthority.command !== "function" ||
      typeof reviewAuthority.query !== "function") {
    throw new TypeError("review operation requires ReviewAuthority");
  }
  return {
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    validateCard(card) {
      const target = card?.inputs?.target;
      const isGitHubTarget = reviewTargetKind(target) === "github";
      const targetValid = isGitHubTarget
        ? (() => {
            try {
              validateGitHubReviewTarget(target);
              return true;
            } catch {
              return false;
            }
          })()
        : target?.schema === REVIEW_TARGET_SCHEMA &&
          validateReviewCandidate(target?.candidate) &&
          target.candidate_fingerprint === target.candidate.candidate_fingerprint &&
          isDigest(target.candidate_fingerprint) &&
          isDigest(target.candidate_authority_watermark) &&
          Number.isSafeInteger(target.lifecycle_generation) &&
          target.lifecycle_generation >= 1;
      if (card?.id !== "review-record" ||
          card.inputs?.receipt_owner !== "ReviewAuthority" ||
          card.inputs?.completion_authority !== "automated_only" ||
          !targetValid ||
          isGitHubTarget &&
            (card.inputs.receipt_owner !== "ReviewAuthority" ||
             target.schema !== GITHUB_REVIEW_TARGET_SCHEMA) ||
          !Array.isArray(card.inputs?.lenses) || card.inputs.lenses.length === 0 ||
          card.inputs.lenses.some((lens) => !REVIEW_LENSES.includes(lens)) ||
          new Set(card.inputs.lenses).size !== card.inputs.lenses.length ||
          !Number.isSafeInteger(card.inputs?.finding_cap) ||
          card.inputs.finding_cap < 1 ||
          !isReviewUrgencyFloor(card.inputs?.urgency_floor) ||
          !isReviewSupplements(card.inputs?.orientation, card.inputs?.diagrams) ||
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
      if (reviewTargetKind(target) === "github") {
        return invokeGitHubReviewRecord({
          intent,
          input,
          target,
          githubReviewAuthority,
        });
      }
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
      const invalidDelegateEvidence = [];
      for (const evidence of materialized?.accepted_delegates ?? []) {
        if (evidence.card_id === "review-critic") continue;
        const lens = evidence.card_id.replace(/^review-lens-/u, "");
        try {
          lensResults[lens] = materializeReviewDelegateResult(evidence);
        } catch {
          const evidenceDigest = safeDigest(evidence);
          if (evidenceDigest === null) {
            throw reviewValidationError(
              "review_source_evidence_mismatch",
              "authority-materialized review evidence is not canonical",
            );
          }
          invalidDelegateEvidence.push({
            card_id: evidence.card_id,
            evidence_digest: evidenceDigest,
            reason: "independent_validation_failed",
          });
          lensResults[lens] = unavailableReviewDelegateResult();
        }
      }
      const criticEvidence = materialized?.accepted_delegates?.find(({ card_id: id }) =>
        id === "review-critic");
      if (!criticEvidence) {
        throw reviewValidationError("incomplete_lens_join", "review critic evidence is missing");
      }
      let criticResult;
      try {
        criticResult = materializeReviewDelegateResult(criticEvidence);
      } catch {
        const evidenceDigest = safeDigest(criticEvidence);
        if (evidenceDigest === null) {
          throw reviewValidationError(
            "review_source_evidence_mismatch",
            "authority-materialized review evidence is not canonical",
          );
        }
        invalidDelegateEvidence.push({
          card_id: criticEvidence.card_id,
          evidence_digest: evidenceDigest,
          reason: "independent_validation_failed",
        });
        criticResult = unavailableReviewDelegateResult();
      }
      const summary = buildReviewSummary({
        candidateFingerprint: target.candidate.candidate_fingerprint,
        candidateAuthorityWatermark: target.candidate_authority_watermark,
        lifecycleGeneration: target.lifecycle_generation,
        enabledLenses: input.lenses,
        lensResults,
        criticResult,
        sourceAuthorityWatermark: intent.source_authority_watermark,
        findingCap: input.finding_cap,
        urgencyFloor: input.urgency_floor,
        orientation: input.orientation,
        diagrams: input.diagrams,
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
        ...(invalidDelegateEvidence.length === 0 ? {} : {
          evidence_validation: {
            invalid_delegate_evidence: invalidDelegateEvidence,
          },
        }),
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

function buildAuthorityReviewSummary({ intent, input, target }) {
  const materialized = input.authority_materialized_evidence;
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
  return buildReviewSummary({
    candidateFingerprint: reviewTargetFingerprint(target),
    candidateAuthorityWatermark: reviewTargetAuthorityWatermark(target),
    lifecycleGeneration: target.lifecycle_generation,
    enabledLenses: input.lenses,
    lensResults,
    criticResult: criticEvidence.evidence?.validated_output ?? criticEvidence.evidence,
    sourceAuthorityWatermark: intent.source_authority_watermark,
    findingCap: input.finding_cap,
  });
}

function invokeGitHubReviewRecord({
  intent,
  input,
  target,
  githubReviewAuthority,
}) {
  try {
    validateGitHubReviewTarget(target);
  } catch (error) {
    throw reviewValidationError(
      error.code ?? "invalid_github_review_target",
      error.message ?? "GitHub review target is invalid",
    );
  }
  const summary = buildAuthorityReviewSummary({ intent, input, target });
  const subjectId = reviewSubjectId(target);
  const current = githubReviewAuthority.query({
    contract: "work.review/v1",
    subject_id: subjectId,
  });
  if (current?.schema === "flow.review-projection/v1" &&
      current.source_run_id === intent.run_id &&
      current.operation_effect_id === intent.effect_id &&
      current.operation_attempt_id === intent.attempt_id &&
      current.operation_idempotency_key === intent.idempotency_key) {
    return githubReviewEffectReceipt(intent, current);
  }
  const body = {
    schema: "flow.github-review-record/v1",
    review_id: subjectId,
    target,
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    lifecycle_generation: target.lifecycle_generation,
    summary,
    automated_evidence: summary.automated_evidence,
    source_authority_watermark: intent.source_authority_watermark,
    source_run_id: intent.run_id,
    operation_contract: intent.operation_contract,
    operation_effect_id: intent.effect_id,
    operation_attempt_id: intent.attempt_id,
    operation_idempotency_key: intent.idempotency_key,
  };
  const previousWatermark = current?.schema === "flow.review-projection/v1"
    ? current.watermark
    : EMPTY_WATERMARK;
  const watermark = reviewEventWatermark({
    previousWatermark,
    event: body,
  });
  const artifacts = renderReviewArtifacts({
    summary,
    watermark,
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
    schema: GITHUB_REVIEW_RECORD_COMMAND_SCHEMA,
    type: "github_review_record",
    contract: "work.review/v1",
    subject_id: subjectId,
    command_id: `github-review-record:${target.snapshot_fingerprint}:${target.lifecycle_generation}`,
    expected_watermark: previousWatermark,
    target,
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    lifecycle_generation: target.lifecycle_generation,
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
  const receipt = githubReviewAuthority.command(command);
  if (receipt?.accepted !== true) {
    const error = reviewValidationError(
      receipt?.code ?? "github_review_authority_rejected",
      receipt?.reason ?? "GitHub review authority rejected review evidence",
    );
    error.review_receipt = receipt;
    throw error;
  }
  const projection = githubReviewAuthority.query({
    contract: "work.review/v1",
    subject_id: subjectId,
  });
  return githubReviewEffectReceipt(intent, projection);
}

function githubReviewEffectReceipt(intent, projection) {
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: {
      schema: "flow.review-receipt/v1",
      review_id: projection.subject_id,
      target_kind: "github",
      target_fingerprint: projection.target_fingerprint,
      lifecycle_generation: projection.lifecycle_generation,
      review_authority_watermark: projection.watermark,
      summary: projection.summary,
      artifacts: projection.artifacts,
      ...reviewCompletionAuthority(),
    },
  };
}

async function invokeGitHubPendingReview({
  provider,
  intent,
}) {
  const input = intent?.operation_input ?? {};
  const target = input.target;
  assertGitHubPendingIntent(intent, target);
  const forge = requireGitHubForge(provider);
  const current = await observeGitHubPullRequest(forge, target);
  if (!current.exact) {
    throw githubReviewEffectError(
      current.code ?? "github_review_target_moved",
      current.reason ?? "GitHub pull-request target no longer matches the exact snapshot",
      { target_observation: current.observation ?? null },
    );
  }
  const draft = input.checkpoint_binding?.draft;
  const expectedDraft = buildGitHubPendingDraft({ input, intent, target });
  if (!isDeepEqualDigest(draft, expectedDraft) ||
      input.checkpoint_binding.draft_digest !== digest(draft)) {
    throw githubReviewEffectError(
      "github_review_checkpoint_draft_mismatch",
      "GitHub pending-review effect is not bound to the durable approved exact draft",
    );
  }
  const listing = await listGitHubPendingReviews(forge, target);
  if (!listing.complete) throw githubReviewEffectError(
    "github_review_listing_incomplete",
    "GitHub pending-review listing is incomplete",
  );
  const matches = matchingGitHubPendingReviews(listing.reviews, {
    target,
    intent,
    draftDigest: digest(draft),
  });
  if (matches.length > 1) throw githubReviewEffectError(
    "github_review_receipt_ambiguous",
    "multiple pending GitHub reviews match the exact flow identity",
    { attachProviderObservation: false },
  );
  if (matches.length === 1) {
    return githubPendingEffectReceipt(intent, target, input, matches[0], draft);
  }
  // Revalidate immediately before the sole provider mutation.  The listing
  // itself is not an authority for target identity and may have raced with a
  // pull-request update.
  const beforeCreate = await observeGitHubPullRequest(forge, target);
  if (!beforeCreate.exact) {
    throw githubReviewEffectError(
      beforeCreate.code ?? "github_review_target_moved",
      beforeCreate.reason ?? "GitHub pull-request target no longer matches the exact snapshot",
      { target_observation: beforeCreate.observation ?? null },
    );
  }
  const created = await createGitHubPendingReview(forge, {
    schema: "flow.github-pending-review-create-request/v1",
    target,
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    repository: target.repository,
    pull_request_number: target.pull_request_number,
    commit_id: target.snapshot.head_sha,
    expected_snapshot: target.snapshot,
    draft,
    draft_digest: digest(draft),
    marker: githubReviewMarker(intent),
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    submitted: false,
  });
  const review = exactGitHubPendingReview(created, {
    target,
    intent,
    draftDigest: digest(draft),
  });
  if (!review) {
    throw githubReviewEffectError(
      "github_review_receipt_ambiguous",
      "GitHub did not return an exact unsubmitted pending-review receipt",
      { attachProviderObservation: false },
    );
  }
  return githubPendingEffectReceipt(intent, target, input, review, draft);
}

async function observeGitHubPendingReview({
  provider,
  intent,
}) {
  const target = intent?.operation_input?.target;
  try {
    assertGitHubPendingIntent(intent, target);
  } catch (error) {
    return indeterminateGitHubObservation(intent, {
      code: error.code ?? "invalid_github_review_target",
      reason: error.message,
    });
  }
  const forge = provider;
  if (!forge) return indeterminateGitHubObservation(intent, {
    code: "github_review_adapter_unavailable",
    reason: "GitHub review Forge Adapter is not configured",
  });
  let current;
  try {
    current = await observeGitHubPullRequest(forge, target);
  } catch (error) {
    return indeterminateGitHubObservation(intent, {
      code: error.code ?? "github_review_target_observation_unavailable",
      reason: error.message,
    });
  }
  if (!current.exact) {
    return indeterminateGitHubObservation(intent, {
      code: current.code ?? "github_review_target_moved",
      reason: current.reason ?? "GitHub pull-request target moved",
      target_observation: current.observation,
    });
  }
  let listing;
  try {
    listing = await listGitHubPendingReviews(forge, target);
  } catch (error) {
    return indeterminateGitHubObservation(intent, {
      code: error.code ?? "github_review_listing_unavailable",
      reason: error.message,
    });
  }
  if (!listing.complete) return indeterminateGitHubObservation(intent, {
    code: "github_review_listing_incomplete",
    reason: "GitHub pending-review listing is incomplete",
  });
  const matches = matchingGitHubPendingReviews(listing.reviews, {
    target,
    intent,
    draftDigest: pendingDraftDigest(intent),
  });
  if (matches.length !== 1) {
    return indeterminateGitHubObservation(intent, {
      code: matches.length === 0
        ? "github_review_receipt_unresolved"
        : "github_review_receipt_ambiguous",
      reason: matches.length === 0
        ? "No exact pending GitHub review receipt was found; the one-shot intent remains unresolved"
        : "Multiple exact pending GitHub review receipts were found",
      target_fingerprint: target.snapshot_fingerprint,
      target_observation: current.observation,
      pending_review_count: listing.reviews.length,
      matching_review_count: matches.length,
      complete: true,
    });
  }
  const receipt = githubPendingEffectReceipt(
    intent,
    target,
    intent.operation_input ?? {},
    matches[0],
    null,
  ).provider_receipt;
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "present",
    causation: {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    },
    provider_observation: receipt,
  };
}

function assertGitHubPendingIntent(intent, target) {
  if (intent?.operation_contract !== GITHUB_REVIEW_OPERATION_CONTRACTS.pending ||
      !nonEmpty(intent.effect_id) || !nonEmpty(intent.attempt_id) ||
      !nonEmpty(intent.idempotency_key)) {
    throw githubReviewEffectError(
      "github_review_operation_intent_mismatch",
      "GitHub pending-review effect is not bound to its registered operation",
    );
  }
  const binding = intent.operation_input?.checkpoint_binding;
  if (binding?.schema !== "flow.checkpoint-binding/v1" ||
      binding.checkpoint_id !== GITHUB_REVIEW_PENDING_CHECKPOINT_ID ||
      !isRecord(binding.draft) ||
      binding.draft.schema !== "flow.github-pending-review-draft/v1" ||
      !isDigest(binding.draft_digest) ||
      binding.draft_digest !== digest(binding.draft)) {
    throw githubReviewEffectError(
      "github_review_checkpoint_binding_missing",
      "GitHub pending-review effect is missing its durable exact checkpoint draft",
    );
  }
  try {
    validateGitHubReviewTarget(target);
  } catch (error) {
    throw githubReviewEffectError(
      error.code ?? "invalid_github_review_target",
      error.message ?? "GitHub review target is invalid",
    );
  }
}

function requireGitHubForge(provider) {
  if (!provider || typeof provider !== "object") {
    throw githubReviewEffectError(
      "github_review_adapter_unavailable",
      "GitHub review Forge Adapter is not configured",
    );
  }
  return provider;
}

async function observeGitHubPullRequest(forge, target) {
  if (typeof forge?.observePullRequest !== "function") throw githubReviewEffectError(
    "github_review_adapter_incomplete",
    "GitHub Forge Adapter must expose observePullRequest",
  );
  const request = githubTargetRequest(target);
  let raw;
  try {
    raw = await forge.observePullRequest(request);
  } catch (error) {
    throw githubProviderError(
      error,
      "github_review_target_observation_unavailable",
      "GitHub pull-request observation was unavailable",
    );
  }
  const observation = raw?.snapshot ?? raw?.pull_request ?? raw;
  const observedTargetAuthorityWatermark = raw?.target_authority_watermark ??
    observation?.target_authority_watermark;
  if (!isDigest(observedTargetAuthorityWatermark)) {
    return {
      exact: false,
      code: "github_review_observation_incomplete",
      reason: "GitHub pull-request observation omitted the target authority watermark",
      observation,
    };
  }
  const match = githubSnapshotMatches(target, observation, raw);
  return match.exact
    ? { exact: true, observation }
    : {
        exact: false,
        code: match.code ?? "github_review_target_moved",
        reason: match.reason ??
          "GitHub pull-request target differs from the prepared snapshot",
        observation,
      };
}

async function listGitHubPendingReviews(forge, target) {
  if (typeof forge?.listPendingReviews !== "function") throw githubReviewEffectError(
    "github_review_adapter_incomplete",
    "GitHub Forge Adapter must expose listPendingReviews",
  );
  let raw;
  try {
    raw = await forge.listPendingReviews(githubTargetRequest(target));
  } catch (error) {
    throw githubProviderError(
      error,
      "github_review_listing_unavailable",
      "GitHub pending-review listing was unavailable",
    );
  }
  if (Array.isArray(raw)) throw githubReviewEffectError(
    "github_review_listing_invalid",
    "GitHub pending-review listing must be an object with complete: true",
  );
  if (!isRecord(raw) || !Array.isArray(raw.reviews)) {
    throw githubReviewEffectError(
      "github_review_listing_invalid",
      "GitHub pending-review listing is malformed",
    );
  }
  return { reviews: raw.reviews, complete: raw.complete === true };
}

async function createGitHubPendingReview(forge, request) {
  if (typeof forge?.createPendingReview !== "function") throw githubReviewEffectError(
    "github_review_adapter_incomplete",
    "GitHub Forge Adapter must expose createPendingReview",
  );
  try {
    return await forge.createPendingReview(request);
  } catch (error) {
    throw githubProviderError(
      error,
      "github_review_creation_unavailable",
      "GitHub pending-review creation was unavailable",
    );
  }
}

function githubTargetRequest(target) {
  return {
    schema: "flow.github-pull-request-observation-request/v1",
    target,
    repository: target.repository,
    pull_request_number: target.pull_request_number,
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    expected_snapshot: target.snapshot,
  };
}

function githubSnapshotMatches(target, observation, raw) {
  if (!isRecord(observation)) return { exact: false };
  if (raw?.target_fingerprint !== undefined &&
      raw.target_fingerprint !== target.snapshot_fingerprint) {
    return { exact: false };
  }
  const observedTargetAuthorityWatermark = raw?.target_authority_watermark ??
    observation.target_authority_watermark;
  if (observedTargetAuthorityWatermark !== target.target_authority_watermark) {
    return { exact: false };
  }
  if (observation.snapshot_fingerprint !== undefined &&
      observation.snapshot_fingerprint !== target.snapshot_fingerprint) {
    return { exact: false };
  }
  if (observation.snapshot_digest !== undefined &&
      observation.snapshot_digest !== target.snapshot_fingerprint) {
    return { exact: false };
  }
  if (observation.state !== undefined && observation.state !== "open") {
    return { exact: false };
  }
  const snapshot = observation.schema === GITHUB_REVIEW_SNAPSHOT_SCHEMA
    ? observation
    : observation.snapshot ?? observation;
  if (snapshot.schema === GITHUB_REVIEW_SNAPSHOT_SCHEMA) {
    try {
      return { exact: digest(snapshot) === target.snapshot_fingerprint };
    } catch {
      return {
        exact: false,
        code: "github_review_observation_incomplete",
        reason: "GitHub pull-request snapshot contains non-canonical data",
      };
    }
  }
  const repository = snapshot.repository ?? observation.repository;
  const number = snapshot.pull_request_number ?? snapshot.number ??
    observation.pull_request_number ?? observation.number;
  const baseSha = snapshot.base_sha ?? snapshot.base?.sha ?? observation.base_sha;
  const headSha = snapshot.head_sha ?? snapshot.head?.sha ?? observation.head_sha;
  const diffSha = snapshot.diff_sha256 ?? observation.diff_sha256;
  return {
    exact: isDeepEqualDigest(repository, target.repository) &&
      number === target.pull_request_number &&
      baseSha === target.snapshot.base_sha &&
      headSha === target.snapshot.head_sha &&
      diffSha === target.snapshot.diff_sha256 &&
      (snapshot.state ?? observation.state) === "open",
  };
}

function matchingGitHubPendingReviews(reviews, {
  target,
  intent,
  draftDigest: expectedDraftDigest,
}) {
  return reviews.map((review) => exactGitHubPendingReview(review, {
    target,
    intent,
    draftDigest: expectedDraftDigest,
  })).filter(Boolean);
}

export function buildGitHubPendingDraft({ input = null, intent = null, target, summary = null, marker = null }) {
  const evidence = input?.authority_materialized_evidence?.operation_receipts?.[0]
    ?.receipt?.provider_receipt ??
    input?.authority_materialized_evidence?.operation_receipts?.[0]
      ?.receipt ?? null;
  const settledSummary = summary ?? evidence?.summary;
  if (!isRecord(settledSummary) || settledSummary.schema !== "flow.review-summary/v1") {
    throw githubReviewEffectError(
      "github_review_summary_missing",
      "pending GitHub review requires the settled semantic review summary",
    );
  }
  return freezeCanonical({
    schema: "flow.github-pending-review-draft/v1",
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    lifecycle_generation: target.lifecycle_generation,
    summary: settledSummary,
    body: renderGitHubPendingReviewBody({
      summary: settledSummary,
      target,
      marker: marker ?? githubReviewMarker(intent),
    }),
  });
}

function renderGitHubPendingReviewBody({ summary, target, marker }) {
  return [
    `<!-- ${marker} -->`,
    "Automated review draft - not submitted.",
    `Target snapshot: ${target.snapshot_fingerprint}`,
    `Review posture: ${summary.posture}`,
    ...summary.rendered_findings.map((finding) =>
      `- [${finding.urgency}] ${finding.summary}: ${finding.detail}`),
  ].join("\n");
}

function pendingDraftDigest(intent) {
  const binding = intent?.operation_input?.checkpoint_binding;
  if (isDigest(binding?.draft_digest)) return binding.draft_digest;
  return null;
}

function githubReviewMarker(intent) {
  return `flow-github-review:${intent.idempotency_key}`;
}

function normalizeCreatedGitHubReview(review) {
  const value = review?.review ?? review;
  if (!isRecord(value)) return null;
  const rawState = value.state ?? value.status;
  const stateValue = typeof rawState === "string"
    ? rawState.toLowerCase()
    : rawState;
  const submitted = typeof value.submitted === "boolean"
    ? value.submitted
    : stateValue === "submitted" ? true : null;
  const state = stateValue === "pending" ? "pending" :
    stateValue === "submitted" ? "submitted" : null;
  const rawReviewId = value.review_id ?? value.id ?? value.node_id;
  const reviewId = rawReviewId === undefined || rawReviewId === null
    ? null
    : String(rawReviewId);
  if (!nonEmpty(reviewId) || state === null) return null;
  return {
    ...value,
    review_id: reviewId,
    submitted,
    state,
    marker: value.marker ?? value.flow_marker ?? extractGitHubReviewMarker(value.body),
    target_fingerprint: value.target_fingerprint ?? value.targetFingerprint,
    target_authority_watermark: value.target_authority_watermark ??
      value.targetAuthorityWatermark,
    draft_digest: value.draft_digest ?? value.draftDigest,
    repository: value.repository ?? value.repo,
    pull_request_number: value.pull_request_number ??
      value.pullRequestNumber ?? value.number,
    commit_id: value.commit_id ?? value.commit_sha ?? value.head_sha ??
      value.headSha ?? value.head?.sha,
  };
}

function exactGitHubPendingReview(review, { target, intent, draftDigest }) {
  const normalized = normalizeCreatedGitHubReview(review);
  if (!normalized || normalized.state !== "pending" ||
      normalized.submitted !== false ||
      normalized.marker !== githubReviewMarker(intent) ||
      normalized.target_fingerprint !== target.snapshot_fingerprint ||
      normalized.target_authority_watermark !== target.target_authority_watermark ||
      normalized.draft_digest !== draftDigest ||
      !isDeepEqualDigest(normalized.repository, target.repository) ||
      normalized.pull_request_number !== target.pull_request_number ||
      normalized.commit_id !== target.snapshot.head_sha) {
    return null;
  }
  return normalized;
}

function extractGitHubReviewMarker(body) {
  if (typeof body !== "string") return null;
  return body.match(/<!--\s*(flow-github-review:[^\s]+)\s*-->/u)?.[1] ?? null;
}

function githubPendingEffectReceipt(intent, target, input, review, draft = null) {
  const normalized = normalizeCreatedGitHubReview(review);
  if (!normalized) throw githubReviewEffectError(
    "github_review_receipt_ambiguous",
    "GitHub pending review identity is incomplete",
    { attachProviderObservation: false },
  );
  const expectedDraftDigest = draft
    ? digest(draft)
    : isDigest(normalized.draft_digest)
      ? normalized.draft_digest
      : pendingDraftDigest({ ...intent, operation_input: input });
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: {
      schema: GITHUB_REVIEW_PROVIDER_RECEIPT_SCHEMA,
      action: "create_pending_review",
      review_id: normalized.review_id,
      target_fingerprint: target.snapshot_fingerprint,
      target_authority_watermark: target.target_authority_watermark,
      draft_digest: expectedDraftDigest,
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      state: "pending",
      submitted: false,
      marker: githubReviewMarker(intent),
      repository: target.repository,
      pull_request_number: target.pull_request_number,
      commit_id: target.snapshot.head_sha,
      provider_review: normalized,
    },
  };
}

function indeterminateGitHubObservation(intent, observation) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: {
      schema: "flow.github-review-observation/v1",
      ...observation,
    },
  };
}

function githubProviderError(error, fallbackCode, fallbackMessage) {
  const providerCode = nonEmpty(error?.code) ? error.code : null;
  const code = providerCode === "github_review_receipt_ambiguous"
    ? providerCode
    : fallbackCode;
  const message = nonEmpty(error?.message) ? error.message : fallbackMessage;
  return githubReviewEffectError(code, message, {
    attachProviderObservation: code !== "github_review_receipt_ambiguous",
    ...(providerCode === null || providerCode === "github_review_receipt_ambiguous"
      ? {}
      : { provider_error_code: providerCode }),
  });
}

function githubReviewEffectError(code, message, details = {}) {
  const {
    attachProviderObservation = true,
    provider_observation: providerObservation,
    ...errorDetails
  } = details;
  const error = new Error(message);
  error.code = code;
  Object.assign(error, errorDetails);
  if (attachProviderObservation) {
    error.provider_observation = providerObservation ?? {
      schema: "flow.github-review-observation/v1",
      code,
      reason: message,
      ...Object.fromEntries(Object.entries(errorDetails).filter(([, value]) =>
        isCanonicalValue(value))),
    };
  }
  return error;
}

/**
 * Build the Forge-bound pending review Adapter.  The full mechanism is kept
 * behind this registration so plan and lifecycle code never call a provider
 * directly.  Invocation and reconciliation are added below; this shape is
 * intentionally the same registered-operation contract used by every other
 * external effect.
 */
export function createGitHubReviewOperationRegistration({
  forge,
} = {}) {
  const provider = forge ?? null;
  return {
    schema: "flow.registered-operation/v1",
    classification: "one_shot_uncertain",
    provider_receipt_validator: GITHUB_REVIEW_RECEIPT_VALIDATOR,
    validateReceipt(receipt) {
      return receipt?.schema === GITHUB_REVIEW_PROVIDER_RECEIPT_SCHEMA &&
        receipt.submitted === false &&
        receipt.state === "pending" &&
        receipt.action === "create_pending_review" &&
        isDigest(receipt.target_fingerprint) &&
        isDigest(receipt.target_authority_watermark) &&
        isDigest(receipt.draft_digest) &&
        nonEmpty(receipt.marker) &&
        isRecord(receipt.repository) &&
        nonEmpty(receipt.repository.owner) &&
        nonEmpty(receipt.repository.name) &&
        Number.isSafeInteger(receipt.pull_request_number) &&
        validGitSha(receipt.commit_id) &&
        nonEmpty(receipt.review_id) &&
        isRecord(receipt.provider_review) &&
        receipt.provider_review.state === "pending" &&
        receipt.provider_review.submitted === false;
    },
    validateCard(card) {
      if (card?.id !== "review-github-pending" ||
          card.executor?.contract !== GITHUB_REVIEW_OPERATION_CONTRACTS.pending ||
          card.executor?.effect_classification !== "one_shot_uncertain" ||
          card.inputs?.completion_authority !== "pending_only_no_submission" ||
          card.inputs?.provider_receipt_validator !== GITHUB_REVIEW_RECEIPT_VALIDATOR ||
          reviewTargetKind(card.inputs?.target) !== "github") {
        throw new TypeError("GitHub pending review operation is not bound to an exact target");
      }
      try {
        validateGitHubReviewTarget(card.inputs.target);
      } catch {
        throw new TypeError("GitHub pending review operation target is incomplete");
      }
      if (card.inputs.draft?.schema !== "flow.github-pending-review-request/v1" ||
          card.inputs.draft.mode !== "create_pending_unsubmitted" ||
          card.inputs.draft.target_fingerprint !== card.inputs.target.snapshot_fingerprint ||
          !isDeepEqualDigest(card.data_references, [card.inputs.target.snapshot_fingerprint]) ||
          !isDeepEqualDigest(card.evidence_references, ["review-record"]) ||
          card.inputs.receipt_owner !== "GitHubReviewAdapter") {
        throw new TypeError("GitHub pending review operation is not bound to the trusted pending-only contract");
      }
    },
    async invoke(intent) {
      return invokeGitHubPendingReview({
        provider,
        intent,
      });
    },
    async observe(intent) {
      return observeGitHubPendingReview({ provider, intent });
    },
    sanitizeProviderObservation: sanitizeGitHubReviewProviderObservation,
  };
}

/**
 * Small authority implementation used by pure/runtime contract tests and by
 * an in-memory FlowRuntime. Durable runtimes use the Work-domain authority
 * with the same command and projection contracts.
 */
export function createInMemoryReviewAuthority({
  candidateProjection = null,
  sourceEffectIntentReader = null,
  targetObservationAdapter = null,
  workspaceProjection = null,
  artifactProjections = [],
  currencyObservations = null,
} = {}) {
  const streams = new Map();
  const staticCandidateProjection = typeof candidateProjection === "function"
    ? null
    : candidateProjection?.schema === "work.review-candidate-projection/v1"
      ? freezeCanonical(candidateProjection)
      : null;
  const candidateProjectionReader = typeof candidateProjection === "function"
    ? candidateProjection
    : () => staticCandidateProjection;
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
      const events = streams.get(subjectId) ?? [];
      const current = queryProjection(subjectId);
      const authorityObservation = isReviewTargetInvalidationCommand(command)
        ? observeReviewTarget(command, current)
        : null;
      if (isReviewTargetInvalidationCommand(command)) {
        const prior = events.find(({ command_receipt: receipt }) =>
          receipt?.command_id === command.command_id);
        if (prior !== undefined) {
          try {
            if (prior.command_receipt.command_digest === idempotencyCommandDigest(command)) {
              return {
                accepted: true,
                replayed: true,
                authority_watermark: current.watermark,
              };
            }
          } catch {
            // Fall through to the typed idempotency conflict.
          }
          return reviewRejection("idempotency_conflict", command, current);
        }
        const built = buildReviewTargetInvalidationEvent({
          command,
          current,
          authorityObservation,
        });
        if (built.issue !== undefined) {
          return reviewRejection(built.issue, command, current);
        }
        streams.set(subjectId, [
          ...events,
          {
            ...built.event.payload,
          },
        ]);
        return {
          schema: "work.command-receipt/v1",
          command_type: command.type,
          contract: command.contract,
          subject_id: subjectId,
          authority_watermark: built.watermark,
          accepted: true,
          created: true,
        };
      }
      if (isReviewTargetRefreshCommand(command)) {
        const prior = events.find(({ command_receipt: receipt }) =>
          receipt?.command_id === command.command_id);
        if (prior !== undefined) {
          try {
            if (prior.command_receipt.command_digest === idempotencyCommandDigest(command)) {
              return {
                accepted: true,
                replayed: true,
                authority_watermark: current.watermark,
              };
            }
          } catch {
            // Fall through to the typed idempotency conflict.
          }
          return reviewRejection("idempotency_conflict", command, current);
        }
        const built = buildReviewTargetRefreshEvent({
          command,
          current,
          authorityObservation: current.invalidation?.observation ?? null,
        });
        if (built.issue !== undefined) {
          return reviewRejection(built.issue, command, current);
        }
        streams.set(subjectId, [
          ...events,
          {
            ...built.event.payload,
          },
        ]);
        return {
          schema: "work.command-receipt/v1",
          command_type: command.type,
          contract: command.contract,
          subject_id: subjectId,
          authority_watermark: built.watermark,
          accepted: true,
          created: true,
        };
      }
      if (isReviewHumanCommand(command)) {
        const prior = events.find(({ command_receipt: receipt }) =>
          receipt?.command_id === command.command_id);
        if (prior !== undefined) {
          try {
            if (prior.command_receipt.command_digest === idempotencyCommandDigest(command)) {
              return {
                accepted: true,
                replayed: true,
                authority_watermark: current.watermark,
              };
            }
          } catch {
            // Fall through to the typed idempotency conflict.
          }
          return reviewRejection("idempotency_conflict", command, current);
        }
        const built = buildReviewHumanEvent({ command, current });
        if (built.issue !== undefined) {
          return reviewRejection(built.issue, command, current);
        }
        streams.set(subjectId, [
          ...events,
          built.event.payload,
        ]);
        return {
          schema: "work.command-receipt/v1",
          command_type: command.type,
          contract: command.contract,
          subject_id: subjectId,
          authority_watermark: built.watermark,
          accepted: true,
          created: true,
        };
      }
      if (command?.schema !== "work.review-record-command/v1" ||
          command?.type !== "review_record" ||
          command?.contract !== "work.review/v1" || typeof subjectId !== "string") {
        return reviewRejection("invalid_review_command", command, null);
      }
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
      const {
        evidence_validation: _evidenceValidation,
        git_observation: _gitObservation,
        human_authority_validation: _humanAuthorityValidation,
        ...canonicalCommand
      } = command;
      const event = {
        type: "review_recorded",
        command: freezeCanonical(canonicalCommand),
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
      if (request?.contract === REVIEW_INBOX_QUERY_CONTRACT) {
        const reviews = [];
        for (const [subjectId, records] of streams) {
          const first = records[0]?.payload ?? records[0];
          if (first?.type === "review_recorded" ||
              first?.type === "github_review_recorded") {
            reviews.push(queryProjection(subjectId));
          }
        }
        const candidates = [];
        const candidate = currentCandidateProjection();
        if (candidate !== null) candidates.push(candidate);
        return projectReviewInbox({ candidates, reviews });
      }
      if (request?.contract !== "work.review/v1" || typeof request.subject_id !== "string") {
        return reviewRejection("invalid_review_query", request, null, "query");
      }
      if (readSealedCandidateProjection()?.subject_id === request.subject_id) {
        return currentCandidateProjection();
      }
      return queryProjection(request.subject_id);
    },
    watch(request = {}) {
      if (request?.contract === REVIEW_INBOX_QUERY_CONTRACT) {
        return oneShot(authority.query(request));
      }
      const subjectId = typeof request === "string" ? request : request.subject_id;
      return oneShot(queryProjection(subjectId));
    },
  };
  return Object.freeze(authority);

  function queryProjection(subjectId) {
    const events = streams.get(subjectId);
    if (!events) return emptyProjection(subjectId);
    const event = events[0];
    const watermark = reviewAuthorityEventWatermark(events);
    const projection = projectReviewRecord(event.body, watermark, events);
    // Preserve the legacy in-memory authority shape when no current Work
    // observations were registered. Durable authorities opt into the fence
    // by registering at least the workspace or artifact observation seam.
    const hasArtifactObservation = typeof artifactProjections === "function" ||
      Array.isArray(artifactProjections) && artifactProjections.length > 0;
    const candidateProjection = readSealedCandidateProjection();
    if (workspaceProjection === null && !hasArtifactObservation) {
      return candidateLifecycleStatus(candidateProjection) === "sealed"
        ? projection
        : projectReviewCurrency(
          projection,
          null,
          [],
          null,
          candidateProjection,
        );
    }
    return projectReviewCurrency(
      projection,
      currentWorkspaceProjection(),
      currentArtifactProjections(),
      currencyObservations,
      candidateProjection,
    );
  }

  function queryCandidateProjection(subjectId) {
    const candidateProjection = readSealedCandidateProjection();
    if (candidateProjection?.subject_id !== subjectId) {
      return emptyProjection(subjectId);
    }
    return currentCandidateProjection();
  }

  function currentCandidateProjection() {
    const candidateProjection = readSealedCandidateProjection();
    const hasArtifactObservation = typeof artifactProjections === "function" ||
      Array.isArray(artifactProjections) && artifactProjections.length > 0;
    if (workspaceProjection === null && !hasArtifactObservation) {
      return terminalCandidateLifecycleProjection(candidateProjection);
    }
    return projectReviewCandidateCurrency(
      candidateProjection,
      currentWorkspaceProjection(),
      currentArtifactProjections(),
      currencyObservations,
    );
  }

  function readSealedCandidateProjection() {
    const projection = candidateProjectionReader();
    return projection?.schema === "work.review-candidate-projection/v1"
      ? freezeCanonical(projection)
      : null;
  }

  function currentWorkspaceProjection() {
    return typeof workspaceProjection === "function"
      ? workspaceProjection()
      : workspaceProjection;
  }

  function currentArtifactProjections() {
    return typeof artifactProjections === "function"
      ? artifactProjections()
      : artifactProjections;
  }

  function observeReviewTarget(command, current) {
    if (targetObservationAdapter === null) return null;
    try {
      const observation = typeof targetObservationAdapter === "function"
        ? targetObservationAdapter({ command, review: current })
        : targetObservationAdapter.observe({ command, review: current });
      return observation === null || observation === undefined
        ? null
        : freezeCanonical(observation);
    } catch {
      return null;
    }
  }
}

/**
 * ReviewAuthority's provider-neutral companion for GitHub snapshots.  It
 * records the same immutable semantic summary as a local review while keeping
 * the Forge pending-review effect separate.  The latter can therefore remain
 * unresolved without making an unrelated provider review look like a receipt.
 */
export function createInMemoryGitHubReviewAuthority({
  sourceEffectIntentReader = null,
} = {}) {
  const streams = new Map();
  const authority = {
    schema: "work.github-review-authority/v1",
    command(command) {
      if (command?.schema !== GITHUB_REVIEW_RECORD_COMMAND_SCHEMA ||
          command?.type !== "github_review_record" ||
          command?.contract !== "work.review/v1" ||
          typeof command.subject_id !== "string") {
        return reviewRejection("invalid_github_review_command", command, null);
      }
      let targetValid = false;
      try {
        validateGitHubReviewTarget(command.target);
        targetValid = command.target_fingerprint === command.target.snapshot_fingerprint &&
          command.target_authority_watermark === command.target.target_authority_watermark;
      } catch {
        targetValid = false;
      }
      if (!targetValid ||
          command.subject_id !== reviewSubjectId(command.target) ||
          !nonEmpty(command.command_id) ||
          !nonEmpty(command.source_run_id) ||
          !nonEmpty(command.operation_effect_id) ||
          !nonEmpty(command.operation_attempt_id) ||
          !nonEmpty(command.operation_idempotency_key)) {
        return reviewRejection("invalid_github_review_record", command, null);
      }
      if (typeof sourceEffectIntentReader?.query !== "function") {
        return reviewRejection(
          "review_source_intent_mismatch",
          command,
          null,
        );
      }
      const sourceEffect = sourceEffectIntentReader.query(
        command.source_run_id,
        command.operation_effect_id,
      );
      const sourceIssue = reviewRecordSourceAuthorityIssue(command, {
        effects: sourceEffect === null ? [] : [sourceEffect],
      });
      if (sourceIssue) return reviewRejection(sourceIssue.code, command, null);
      try {
        validateGitHubReviewRecordCommand(command);
      } catch (error) {
        return reviewRejection(error.code ?? "invalid_github_review_record", command, null);
      }
      const current = queryProjection(command.subject_id);
      const prior = streams.get(command.subject_id)?.[0] ?? null;
      if (prior?.command_receipt?.command_id === command.command_id) {
        return prior.command_receipt.command_digest === idempotencyCommandDigest(command)
          ? { accepted: true, replayed: true, authority_watermark: current.watermark }
          : reviewRejection("idempotency_conflict", command, current);
      }
      const expected = current.schema === "flow.rejection/v1"
        ? EMPTY_WATERMARK
        : current.watermark;
      if (command.expected_watermark !== expected) {
        return reviewRejection("stale_authority_watermark", command, current);
      }
      if (current.schema !== "flow.rejection/v1") {
        return reviewRejection("idempotency_conflict", command, current);
      }
      if (command.artifacts?.schema !== "flow.review-artifacts/v1" ||
          command.summary?.schema !== "flow.review-summary/v1" ||
          !isDeepEqualDigest(command.summary.automated_evidence, command.automated_evidence)) {
        return reviewRejection("invalid_github_review_record", command, current);
      }
      const body = {
        schema: GITHUB_REVIEW_RECORD_SCHEMA,
        review_id: command.subject_id,
        target: command.target,
        target_fingerprint: command.target_fingerprint,
        target_authority_watermark: command.target_authority_watermark,
        lifecycle_generation: command.lifecycle_generation,
        summary: command.summary,
        automated_evidence: command.automated_evidence,
        artifacts: command.artifacts,
        source_authority_watermark: command.source_authority_watermark,
        source_run_id: command.source_run_id,
        operation_contract: command.operation_contract,
        operation_effect_id: command.operation_effect_id,
        operation_attempt_id: command.operation_attempt_id,
        operation_idempotency_key: command.operation_idempotency_key,
      };
      const watermark = reviewEventWatermark({
        previousWatermark: command.expected_watermark,
        event: githubReviewRecordWatermarkIdentity(body),
      });
      if (command.artifacts.watermark !== watermark) {
        return reviewRejection("artifact_watermark_mismatch", command, current);
      }
      const commandReceipt = freezeCanonical({
        schema: "work.idempotency-receipt/v1",
        command_id: command.command_id,
        command_digest: idempotencyCommandDigest(command),
      });
      streams.set(command.subject_id, [{
        type: "github_review_recorded",
        body,
        watermark,
        command_receipt: commandReceipt,
      }]);
      return {
        schema: "work.command-receipt/v1",
        command_type: command.type,
        contract: command.contract,
        subject_id: command.subject_id,
        authority_watermark: watermark,
        accepted: true,
        created: true,
      };
    },
    query(request = {}) {
      if (request?.contract !== "work.review/v1" ||
          typeof request.subject_id !== "string") {
        return reviewRejection("invalid_review_query", request, null, "query");
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
    if (!events) {
      return reviewRejection(
        "unknown_subject",
        { subject_id: subjectId },
        { watermark: EMPTY_WATERMARK, legal_actions: [] },
        "query",
      );
    }
    return projectGitHubReviewRecord(events[0].body, events[0].watermark, events);
  }
}

export function projectGitHubReviewRecord(body, watermark, events = []) {
  const firstEvent = events[0]?.payload ?? events[0];
  if (firstEvent?.type === "github_review_recorded") {
    validateReviewHumanEventRecords(events, body);
  } else if (REVIEW_HUMAN_ACTIONS.includes(firstEvent?.type) ||
      firstEvent?.type === "review_target_invalidated" ||
      firstEvent?.type === "review_target_refresh_acknowledged") {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "GitHub review projection cannot accept local review events",
    );
  }
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
    target_kind: "github",
    target: body.target,
    target_fingerprint: body.target_fingerprint,
    candidate_fingerprint: body.target_fingerprint,
    target_authority_watermark: body.target_authority_watermark,
    candidate_authority_watermark: body.target_authority_watermark,
    lifecycle_generation: body.lifecycle_generation,
    source_run_id: body.source_run_id,
    operation_contract: body.operation_contract,
    operation_effect_id: body.operation_effect_id,
    operation_attempt_id: body.operation_attempt_id,
    operation_idempotency_key: body.operation_idempotency_key,
    summary: body.summary,
    automated_evidence: body.automated_evidence,
    artifacts: body.artifacts,
    status: "automated_completed",
    current: true,
    evidence_currency: "current",
    posture: body.summary.posture,
    findings: body.summary.findings,
    semantic_findings: body.summary.findings,
    rendered_findings: body.summary.rendered_findings,
    cap_reasons: body.summary.cap_reasons,
    urgency_floor: body.summary.urgency_floor,
    orientation: body.summary.orientation ?? null,
    diagrams: body.summary.diagrams ?? [],
    coverage: body.summary.coverage,
    merge_ready: body.summary.merge_ready,
    remote_review: {
      provider: "github",
      status: "not_created",
      submitted: false,
      target_fingerprint: body.target_fingerprint,
    },
    ...reviewCompletionAuthority(),
    append_only_event_count: events.length,
    command_receipts: commandReceipts,
    legal_actions: [],
  });
}

function githubReviewRecordWatermarkIdentity(body) {
  if (!isRecord(body)) return body;
  const { artifacts: _artifacts, ...identity } = body;
  return identity;
}

export function projectReviewRecord(
  body,
  watermark,
  events = [],
) {
  if (events.length > 0) validateReviewHumanEventRecords(events, body);
  const summary = isRecord(body?.summary) ? body.summary : {};
  const invalidationEvent = events
    .map((event) => event?.payload ?? event)
    .find(({ type }) => type === "review_target_invalidated");
  const invalidation = invalidationEvent?.invalidation ?? null;
  const refreshEvent = events
    .map((event) => event?.payload ?? event)
    .find(({ type }) => type === "review_target_refresh_acknowledged");
  const refresh = refreshEvent?.refresh ?? null;
  const humanState = reviewHumanState(events);
  const current = invalidation === null && humanState.supersession === null;
  const commandReceipts = events
    .map((event) => (event?.payload ?? event).command_receipt)
    .filter((receipt) => receipt !== undefined);
  const refreshAction = invalidation === null || refresh !== null ? [] : [{
    schema: "work.review-target-refresh-command/v1",
    type: "review_target_refresh",
    contract: "work.review/v1",
    command_id: reviewTargetRefreshCommandId({
      subjectId: body.review_id,
      observedCandidateFingerprint: invalidation.observed_candidate_fingerprint,
      observedLifecycleGeneration: invalidation.observed_lifecycle_generation,
      observedMutationEpoch: invalidation.observed_mutation_epoch,
    }),
    subject_id: body.review_id,
    expected_watermark: watermark,
    prior_candidate_fingerprint: invalidation.prior_candidate_fingerprint,
    prior_lifecycle_generation: invalidation.prior_lifecycle_generation,
    observed_candidate_fingerprint: invalidation.observed_candidate_fingerprint,
    observed_lifecycle_generation: invalidation.observed_lifecycle_generation,
    ...(invalidation.prior_mutation_epoch === undefined ? {} : {
      prior_mutation_epoch: invalidation.prior_mutation_epoch,
    }),
    ...(invalidation.observed_mutation_epoch === undefined ? {} : {
      observed_mutation_epoch: invalidation.observed_mutation_epoch,
    }),
    ...(invalidation.observation === undefined ? {} : {
      authority_observation: invalidation.observation,
    }),
  }];
  /*
   * This command is the only legal post-invalidation acknowledgement. It
  * records that the observed target facts were retained without making the
  * stale review current or authorizing any downstream action.
  */
  const humanFields = humanState.hasEvents
    ? humanProjectionFields(humanState, watermark)
    : {};
  const humanLegalActions = current
    ? reviewHumanLegalActions({
        subject_id: body.review_id,
        target_fingerprint: body.candidate_fingerprint,
        candidate_fingerprint: body.candidate_fingerprint,
        candidate_authority_watermark: body.candidate_authority_watermark,
        lifecycle_generation: body.lifecycle_generation,
        watermark,
        current,
        status: "automated_completed",
        ...humanFields,
      })
    : [];
  const projection = {
    schema: "flow.review-projection/v1",
    contract: "work.review/v1",
    subject_id: body.review_id,
    watermark,
    authority_watermark: watermark,
    authority_watermark_domain: "review",
    target_fingerprint: body.candidate_fingerprint,
    candidate_fingerprint: body.candidate_fingerprint,
    target_authority_watermark: body.candidate_authority_watermark,
    candidate_authority_watermark: body.candidate_authority_watermark,
    lifecycle_generation: body.lifecycle_generation,
    ...(body.source_run_id === undefined ? {} : { source_run_id: body.source_run_id }),
    ...(body.operation_contract === undefined ? {} : {
      operation_contract: body.operation_contract,
    }),
    ...(body.operation_effect_id === undefined ? {} : {
      operation_effect_id: body.operation_effect_id,
    }),
    ...(body.operation_attempt_id === undefined ? {} : {
      operation_attempt_id: body.operation_attempt_id,
    }),
    ...(body.operation_idempotency_key === undefined ? {} : {
      operation_idempotency_key: body.operation_idempotency_key,
    }),
    ...(body.candidate === undefined ? {} : { candidate: body.candidate }),
    status: current ? "automated_completed" : "stale",
    current,
    evidence_currency: current ? "current" : "stale",
    ...(invalidation === null ? {} : {
      invalidation,
      observed_candidate_fingerprint: invalidation.observed_candidate_fingerprint,
      observed_lifecycle_generation: invalidation.observed_lifecycle_generation,
      ...(invalidation.prior_mutation_epoch === undefined ? {} : {
        prior_mutation_epoch: invalidation.prior_mutation_epoch,
      }),
      ...(invalidation.observed_mutation_epoch === undefined ? {} : {
        observed_mutation_epoch: invalidation.observed_mutation_epoch,
      }),
    }),
    ...(refresh === null ? {} : { refresh }),
    ...(summary.posture === undefined ? {} : { posture: summary.posture }),
    findings: summary.findings ?? [],
    semantic_findings: summary.findings ?? [],
    rendered_findings: summary.rendered_findings ?? [],
    cap_reasons: summary.cap_reasons ?? [],
    urgency_floor: summary.urgency_floor ?? "info",
    orientation: summary.orientation ?? null,
    diagrams: summary.diagrams ?? [],
    ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
    ...(summary.merge_ready === undefined ? {} : { merge_ready: summary.merge_ready }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.automated_evidence === undefined ? {} : {
      automated_evidence: body.automated_evidence,
    }),
    ...(body.artifacts === undefined ? {} : { artifacts: body.artifacts }),
    ...reviewCompletionAuthority(),
    append_only_event_count: events.length,
    command_receipts: commandReceipts,
    ...humanFields,
    // Target invalidation is terminal for every authorization domain. Apply
    // this fence after human composition so prior approval or integration
    // cannot restore stale-target authority.
    ...(current ? {} : {
      status: "stale",
      current: false,
      evidence_currency: "stale",
      approval: "ineligible",
      approval_eligible: false,
      submission_pending: false,
      submission_eligible: false,
      integration_eligible: false,
      integration_authorized: false,
      merge_eligible: false,
      merge_authorized: false,
      tracker_completion_eligible: false,
      tracker_completion_authorized: false,
      remote_submission_authorized: false,
    }),
    legal_actions: current ? humanLegalActions : refreshAction,
  };
  return freezeCanonical(projection);
}

/**
 * Reconstruct the fold shape emitted before the human review projection was
 * added.  This is deliberately a narrow compatibility helper for durable
 * migration: callers must still compare its canonical bytes and digest with
 * the stored fold before accepting an upgrade.
 */
export function legacyReviewProjectionFold(fold, events = []) {
  if (!isRecord(fold) || fold.schema !== "flow.review-projection/v1") {
    return null;
  }
  const payloads = events.map((record) => record?.payload ?? record);
  if (payloads.some((payload) => REVIEW_HUMAN_ACTIONS.includes(payload?.type))) {
    return null;
  }
  const legacy = { ...fold };
  if (fold.target_kind === "github") {
    for (const key of [
      "current",
      "evidence_currency",
      "urgency_floor",
      "orientation",
      "diagrams",
      "coverage",
      "merge_ready",
    ]) delete legacy[key];
    return freezeCanonical(legacy);
  }
  if (fold.target_kind !== undefined && fold.target_kind !== "local") {
    return null;
  }
  delete legacy.target_fingerprint;
  delete legacy.target_authority_watermark;
  if (fold.current === true && payloads.length > 0) {
    legacy.legal_actions = [];
  }
  return freezeCanonical(legacy);
}

function reviewHumanState(events) {
  const state = {
    hasEvents: false,
    reviewGeneration: 0,
    session: null,
    comments: [],
    dispositions: [],
    approval: null,
    supersession: null,
    integration: null,
  };
  for (const record of events) {
    const payload = record?.payload ?? record;
    if (!REVIEW_HUMAN_ACTIONS.includes(payload?.type) ||
        !isRecord(payload?.event)) continue;
    const event = payload.event;
    state.hasEvents = true;
    state.reviewGeneration = event.review_generation;
    if (payload.type === "review_session_start") {
      state.session = event.session;
    } else if (payload.type === "review_comment") {
      state.comments.push(event.comment);
    } else if (payload.type === "review_disposition") {
      state.dispositions.push(event.disposition);
    } else if (payload.type === "review_approval") {
      state.approval = event.approval;
    } else if (payload.type === "review_supersession") {
      state.supersession = event.supersession;
    } else if (payload.type === "review_integration") {
      state.integration = event.integration;
    }
  }
  return state;
}

function humanProjectionFields(state, reviewAuthorityWatermark) {
  const session = state.session === null
    ? null
    : {
        ...state.session,
        review_authority_watermark: reviewAuthorityWatermark,
      };
  const approval = state.approval === null
    ? "not_requested"
    : state.approval.decision === "approve"
      ? "approved"
      : "revoked";
  const eligibility = reviewHumanActionEligibility({
    session,
    approval,
    integration: state.integration,
  });
  return {
    review_generation: state.reviewGeneration,
    review_authority_watermark: reviewAuthorityWatermark,
    session,
    comments: state.comments,
    approval_eligible: eligibility.approvalEligible,
    dispositions: state.dispositions,
    ...(state.approval === null ? {} : {
      approval,
      approval_receipt: state.approval,
    }),
    ...(state.integration === null ? {} : {
      integration: state.integration,
      integration_authorized: state.approval?.decision === "approve",
    }),
    integration_eligible: eligibility.integrationEligible,
    // Supersession is terminal for human review. Apply it after integration
    // composition so no later state can restore authorization or eligibility.
    ...(state.supersession === null ? {} : {
      human_status: "superseded",
      supersession: state.supersession,
      current: false,
      evidence_currency: "stale",
      approval: "ineligible",
      approval_eligible: false,
      submission_pending: false,
      submission_eligible: false,
      integration_eligible: false,
      integration_authorized: false,
      merge_eligible: false,
      merge_authorized: false,
      tracker_completion_eligible: false,
      tracker_completion_authorized: false,
      remote_submission_authorized: false,
    }),
  };
}

function reviewHumanActionEligibility({ session, approval, integration }) {
  const hasSession = session !== null && session !== undefined;
  const hasIntegration = integration !== null && integration !== undefined;
  const approvalDecision = !hasSession
    ? null
    : approval !== "approved"
      ? "approve"
      : hasIntegration
        ? null
        : "revoke";
  return {
    approvalDecision,
    approvalEligible: approvalDecision === "approve",
    integrationEligible: hasSession && approval === "approved" &&
      !hasIntegration,
  };
}

function reviewSessionStartAction({
  reviewId,
  candidateFingerprint,
  lifecycleGeneration,
  candidateAuthorityWatermark,
  expectedWatermark,
  expectedGeneration,
}) {
  return {
    schema: REVIEW_HUMAN_COMMAND_SCHEMA,
    type: "review_session_start",
    contract: "work.review/v1",
    command_id: `review-session-start:${reviewId}`,
    subject_id: reviewId,
    review_id: reviewId,
    target_fingerprint: candidateFingerprint,
    candidate_fingerprint: candidateFingerprint,
    candidate_authority_watermark: candidateAuthorityWatermark,
    lifecycle_generation: lifecycleGeneration,
    expected_watermark: expectedWatermark,
    expected_generation: expectedGeneration,
    operator_input: reviewOperatorInput({
      action: "review_session_start",
      required: ["session_id"],
    }),
  };
}

function reviewOperatorInput({ action, required, optional = [], details = {} }) {
  return {
    schema: REVIEW_OPERATOR_INPUT_SCHEMA,
    action,
    required,
    ...(optional.length === 0 ? {} : { optional }),
    ...details,
  };
}

function validReviewOperatorInput(input, action) {
  const definitions = {
    review_session_start: {
      required: ["session_id"],
    },
    review_comment: {
      required: ["comment_id", "body"],
    },
    review_disposition: {
      required: ["disposition"],
      optional: ["finding_id"],
      allowed_dispositions: [...REVIEW_DISPOSITIONS],
    },
    review_supersession: {
      required: ["replacement"],
      replacement: {
        required: ["candidate_fingerprint", "lifecycle_generation"],
      },
    },
    review_integration: {
      required: ["evidence"],
      evidence_schema: REVIEW_INTEGRATION_EVIDENCE_SCHEMA,
    },
  };
  const definition = definitions[action];
  if (definition === undefined || !isRecord(input) ||
      input.schema !== REVIEW_OPERATOR_INPUT_SCHEMA ||
      input.action !== action ||
      !Array.isArray(input.required) ||
      !isDeepStrictEqual(input.required, definition.required)) {
    return false;
  }
  const optional = definition.optional ?? [];
  if (optional.length === 0) {
    if (Object.hasOwn(input, "optional")) return false;
  } else if (!isDeepStrictEqual(input.optional, optional)) {
    return false;
  }
  if (definition.allowed_dispositions !== undefined &&
      !isDeepStrictEqual(input.allowed_dispositions,
        definition.allowed_dispositions)) {
    return false;
  }
  if (definition.evidence_schema !== undefined &&
      input.evidence_schema !== definition.evidence_schema) {
    return false;
  }
  if (definition.replacement !== undefined &&
      !isDeepStrictEqual(input.replacement, definition.replacement)) {
    return false;
  }
  const optionalKeys = [
    ...(optional.length === 0 ? [] : ["optional"]),
    ...(definition.allowed_dispositions === undefined
      ? []
      : ["allowed_dispositions"]),
    ...(definition.evidence_schema === undefined ? [] : ["evidence_schema"]),
    ...(definition.replacement === undefined ? [] : ["replacement"]),
  ];
  return hasExactKeys(
    input,
    ["schema", "action", "required"],
    optionalKeys,
  );
}

function validReviewHumanCommandShape(command) {
  if (!isRecord(command) || !REVIEW_HUMAN_ACTIONS.includes(command.type) ||
      !hasExactKeys(command, REVIEW_HUMAN_COMMAND_COMMON_KEYS,
        REVIEW_HUMAN_COMMAND_ROOT_KEYS.filter((key) =>
          !REVIEW_HUMAN_COMMAND_COMMON_KEYS.includes(key)))) {
    return false;
  }
  const materialized = {
    review_session_start: {
      required: ["session_id"],
    },
    review_comment: {
      required: ["session_id", "comment_id", "body"],
    },
    review_disposition: {
      required: ["session_id", "disposition"],
      optional: ["finding_id"],
    },
    review_approval: {
      required: ["session_id", "decision"],
    },
    review_supersession: {
      required: ["session_id", "replacement"],
    },
    review_integration: {
      required: ["session_id", "evidence"],
    },
  }[command.type];
  const hasOperatorInput = Object.hasOwn(command, "operator_input");
  if (hasOperatorInput) {
    if (command.type === "review_approval" ||
        !hasExactKeys(command, [
          ...REVIEW_HUMAN_COMMAND_COMMON_KEYS,
          ...(command.type === "review_session_start" ? [] : ["session_id"]),
          "operator_input",
        ]) ||
        !validReviewOperatorInput(command.operator_input, command.type)) {
      return false;
    }
    return true;
  }
  if (command.type === "review_session_start") {
    return hasExactKeys(command, [
      ...REVIEW_HUMAN_COMMAND_COMMON_KEYS,
      "session_id",
    ]);
  }
  return hasExactKeys(
    command,
    [...REVIEW_HUMAN_COMMAND_COMMON_KEYS, ...materialized.required],
    materialized.optional ?? [],
  );
}

function reviewHumanLegalActions(review, candidate = null) {
  if (!isRecord(review) || review.current !== true ||
      ["stale", "superseded"].includes(review.status) ||
      review.human_status === "superseded") return [];
  const targetFingerprint = review.target_fingerprint ?? review.candidate_fingerprint;
  const lifecycleGeneration = review.lifecycle_generation;
  const candidateAuthorityWatermark = review.candidate_authority_watermark ??
    candidate?.watermark ?? null;
  const base = {
    schema: REVIEW_HUMAN_COMMAND_SCHEMA,
    contract: "work.review/v1",
    subject_id: review.subject_id,
    review_id: review.subject_id,
    target_fingerprint: targetFingerprint,
    candidate_fingerprint: targetFingerprint,
    candidate_authority_watermark: candidateAuthorityWatermark,
    lifecycle_generation: lifecycleGeneration,
    expected_watermark: review.watermark,
    expected_generation: review.review_generation ?? 0,
  };
  if (review.session === null || review.session === undefined) {
    return [reviewSessionStartAction({
      reviewId: review.subject_id,
      candidateFingerprint: targetFingerprint,
      lifecycleGeneration,
      candidateAuthorityWatermark,
      expectedWatermark: review.watermark,
      expectedGeneration: review.review_generation ?? 0,
    })];
  }
  const session = { session_id: review.session.session_id };
  const eligibility = reviewHumanActionEligibility({
    session: review.session,
    approval: review.approval,
    integration: review.integration,
  });
  const actions = [{
    ...base,
    ...session,
    type: "review_comment",
    command_id: `review-comment:${review.subject_id}:${base.expected_generation + 1}`,
    operator_input: reviewOperatorInput({
      action: "review_comment",
      required: ["comment_id", "body"],
    }),
  }, {
    ...base,
    ...session,
    type: "review_disposition",
    command_id: `review-disposition:${review.subject_id}:${base.expected_generation + 1}`,
    operator_input: reviewOperatorInput({
      action: "review_disposition",
      required: ["disposition"],
      optional: ["finding_id"],
      details: { allowed_dispositions: [...REVIEW_DISPOSITIONS] },
    }),
  }];
  if (eligibility.approvalDecision === "approve") {
    actions.push({
      ...base,
      ...session,
      type: "review_approval",
      command_id: `review-approval:${review.subject_id}:${base.expected_generation + 1}`,
      decision: "approve",
    });
  } else if (eligibility.approvalDecision === "revoke") {
    actions.push({
      ...base,
      ...session,
      type: "review_approval",
      command_id: `review-revoke-approval:${review.subject_id}:${base.expected_generation + 1}`,
      decision: "revoke",
    });
  }
  actions.push({
    ...base,
    ...session,
    type: "review_supersession",
    command_id: `review-supersession:${review.subject_id}:${base.expected_generation + 1}`,
    operator_input: reviewOperatorInput({
      action: "review_supersession",
      required: ["replacement"],
      details: {
        replacement: {
          required: ["candidate_fingerprint", "lifecycle_generation"],
        },
      },
    }),
  });
  if (eligibility.integrationEligible) {
    actions.push({
      ...base,
      ...session,
      type: "review_integration",
      command_id: `review-integration:${review.subject_id}:${base.expected_generation + 1}`,
      operator_input: reviewOperatorInput({
        action: "review_integration",
        required: ["evidence"],
        details: { evidence_schema: "flow.review-integration-evidence/v1" },
      }),
    });
  }
  return actions;
}

export function reviewHumanCommandIssue(command, current) {
  if (!isReviewHumanCommand(command) ||
      !validReviewHumanCommandShape(command)) {
    return "invalid_review_human_command";
  }
  if (current?.schema !== "flow.review-projection/v1") return "unknown_subject";
  if (current.target_kind !== undefined && current.target_kind !== "local") {
    return "review_target_not_local";
  }
  if (!nonEmpty(command.command_id) ||
      !nonEmpty(command.review_id) ||
      command.review_id !== current.subject_id ||
      command.subject_id !== current.subject_id) {
    return "invalid_review_human_command";
  }
  const candidateFingerprint = command.target_fingerprint ??
    command.candidate_fingerprint;
  if (!isDigest(candidateFingerprint) ||
      candidateFingerprint !== current.candidate_fingerprint ||
      command.candidate_fingerprint !== candidateFingerprint ||
      command.target_fingerprint !== candidateFingerprint ||
      !isDigest(command.candidate_authority_watermark) ||
      command.candidate_authority_watermark !== current.candidate_authority_watermark ||
      !Number.isSafeInteger(command.lifecycle_generation) ||
      command.lifecycle_generation < 1 ||
      command.lifecycle_generation !== current.lifecycle_generation ||
      !Number.isSafeInteger(command.expected_generation) ||
      command.expected_generation < 0 ||
      command.expected_generation !== (current.review_generation ?? 0)) {
    return command.expected_generation !== (current.review_generation ?? 0)
      ? "stale_review_generation"
      : "review_target_mismatch";
  }
  if (command.expected_watermark !== current.watermark) {
    return "stale_authority_watermark";
  }
  if (current.current !== true || current.status === "stale") {
    return "review_target_not_current";
  }
  const hasSession = current.session !== null && current.session !== undefined;
  if (command.type === "review_session_start") {
    if (hasSession) return "review_session_already_started";
    if (!nonEmpty(command.session_id)) return "invalid_review_session";
    return null;
  }
  if (!hasSession || command.session_id !== current.session.session_id) {
    return "review_session_required";
  }
  if (command.type === "review_comment") {
    if (!nonEmpty(command.comment_id) ||
        typeof command.body !== "string" || command.body.length === 0 ||
        command.body.length > 16_384) {
      return "invalid_review_comment";
    }
    if ((current.comments ?? []).some(({ comment_id: commentId }) =>
      commentId === command.comment_id)) {
      return "review_comment_already_recorded";
    }
    return null;
  }
  if (command.type === "review_disposition") {
    if (!REVIEW_DISPOSITIONS.includes(command.disposition) ||
        Object.hasOwn(command, "finding_id") &&
          !nonEmpty(command.finding_id)) {
      return "invalid_review_disposition";
    }
    const findingId = command.finding_id ?? null;
    if (findingId !== null &&
        (!Array.isArray(current.findings) ||
         !current.findings.some(({ finding_id: surfacedFindingId }) =>
           surfacedFindingId === findingId))) {
      return "review_finding_not_surfaced";
    }
    if ((current.dispositions ?? []).some((entry) =>
      (entry.finding_id ?? null) === findingId)) {
      return "review_disposition_already_recorded";
    }
    return null;
  }
  if (command.type === "review_approval") {
    if (current.integration !== undefined && current.integration !== null) {
      return "review_approval_after_integration";
    }
    if (!["approve", "revoke"].includes(command.decision)) {
      return "invalid_review_approval";
    }
    const approval = current.approval ?? "not_requested";
    if (command.decision === "approve" && approval === "approved") {
      return "review_approval_already_granted";
    }
    if (command.decision === "revoke" && approval !== "approved") {
      return "review_approval_not_active";
    }
    return null;
  }
  if (command.type === "review_supersession") {
    const replacement = command.replacement;
    if (hasExactKeys(replacement, [
      "candidate_fingerprint",
      "lifecycle_generation",
    ]) &&
      isDigest(replacement.candidate_fingerprint) &&
      Number.isSafeInteger(replacement.lifecycle_generation) &&
      replacement.lifecycle_generation >= 1) {
      return replacement.candidate_fingerprint === current.candidate_fingerprint &&
        replacement.lifecycle_generation === current.lifecycle_generation
        ? "review_self_supersession"
        : null;
    }
    return "invalid_review_supersession";
  }
  if (command.type === "review_integration") {
    const evidence = command.evidence;
    if (!validateReviewIntegrationEvidence(evidence, {
      candidateFingerprint: current.candidate_fingerprint,
      lifecycleGeneration: current.lifecycle_generation,
    })) {
      return "invalid_review_integration";
    }
    if (current.integration !== undefined && current.integration !== null) {
      return "review_integration_already_recorded";
    }
    if (current.approval !== "approved") return "review_approval_required";
    return null;
  }
  return "invalid_review_human_command";
}

export function validateReviewIntegrationEvidence(
  evidence,
  { candidateFingerprint = undefined, lifecycleGeneration = undefined } = {},
) {
  if (!isRecord(evidence) ||
      !hasExactKeys(evidence, [
        "schema",
        "candidate_fingerprint",
        "lifecycle_generation",
      ]) ||
      evidence.schema !== REVIEW_INTEGRATION_EVIDENCE_SCHEMA ||
      !isDigest(evidence.candidate_fingerprint) ||
      !Number.isSafeInteger(evidence.lifecycle_generation) ||
      evidence.lifecycle_generation < 1 ||
      candidateFingerprint !== undefined &&
        evidence.candidate_fingerprint !== candidateFingerprint ||
      lifecycleGeneration !== undefined &&
        evidence.lifecycle_generation !== lifecycleGeneration) {
    return false;
  }
  return true;
}

export function buildReviewHumanEvent({ command, current }) {
  const issue = reviewHumanCommandIssue(command, current);
  if (issue !== null) return { issue };
  const reviewGeneration = current.review_generation ?? 0;
  const acceptedCommand = reviewAcceptedCommandIdentity(command);
  const commandReceipt = freezeCanonical({
    schema: "work.idempotency-receipt/v1",
    command_id: command.command_id,
    command_digest: idempotencyCommandDigest(command),
  });
  const base = {
    schema: REVIEW_HUMAN_EVENT_SCHEMA,
    review_id: current.subject_id,
    target_fingerprint: current.candidate_fingerprint,
    candidate_authority_watermark: current.candidate_authority_watermark,
    lifecycle_generation: current.lifecycle_generation,
    accepted_command: acceptedCommand,
    command_receipt_digest: reviewCommandReceiptDigest(commandReceipt),
    expected_watermark: current.watermark,
    expected_generation: reviewGeneration,
    review_generation: reviewGeneration + 1,
  };
  let event = base;
  if (command.type === "review_session_start") {
    event = {
      ...base,
      session: {
        schema: REVIEW_SESSION_SCHEMA,
        session_id: command.session_id,
        review_id: current.subject_id,
        target_fingerprint: current.candidate_fingerprint,
        candidate_authority_watermark: current.candidate_authority_watermark,
        lifecycle_generation: current.lifecycle_generation,
      },
    };
  } else if (command.type === "review_comment") {
    event = {
      ...base,
      comment: {
        schema: "flow.review-comment/v1",
        comment_id: command.comment_id,
        session_id: command.session_id,
        body: command.body,
      },
    };
  } else if (command.type === "review_disposition") {
    event = {
      ...base,
      disposition: {
        schema: "flow.review-disposition/v1",
        session_id: command.session_id,
        ...(command.finding_id === undefined ? {} : {
          finding_id: command.finding_id,
        }),
        disposition: command.disposition,
      },
    };
  } else if (command.type === "review_approval") {
    event = {
      ...base,
      approval: {
        schema: "flow.review-approval/v1",
        session_id: command.session_id,
        decision: command.decision,
      },
    };
  } else if (command.type === "review_supersession") {
    event = {
      ...base,
      supersession: {
        schema: "flow.review-supersession/v1",
        session_id: command.session_id,
        replacement: command.replacement,
      },
    };
  } else if (command.type === "review_integration") {
    const evidence = command.evidence;
    event = {
      ...base,
      integration: {
        schema: "flow.review-integration/v1",
        session_id: command.session_id,
        evidence,
        evidence_digest: digest(evidence),
      },
    };
  }
  const watermark = reviewEventWatermark({
    previousWatermark: current.watermark,
    event,
  });
  return {
    event: {
      contract: "work.review-event/v1",
      payload: {
        type: command.type,
        event: freezeCanonical(event),
        watermark,
        command_receipt: commandReceipt,
      },
    },
    watermark,
  };
}

/**
 * Build the disposable operator view of ReviewAuthority subjects. The inbox
 * has no state of its own: callers may discard it and obtain the same view by
 * asking the authority again. Each item retains the exact candidate/review
 * watermarks used to authorize any subsequent command.
 */
export function projectReviewInbox({
  candidates = [],
  reviews = [],
} = {}) {
  const candidateById = new Map(
    candidates
      .filter((candidate) => candidate?.schema === "work.review-candidate-projection/v1")
      .map((candidate) => [candidate.subject_id, candidate]),
  );
  const reviewItems = reviews
    .filter((review) => review?.schema === "flow.review-projection/v1")
    .map((review) => {
      const candidate = candidateById.get(review.candidate?.candidate_id) ??
        candidateById.get(review.subject_id);
      return reviewInboxItem({ review, candidate });
    });
  const reviewedCandidateIds = new Set(reviewItems.map(({ candidate }) =>
    candidate?.subject_id ?? candidate?.candidate?.candidate_id ?? null));
  const candidateItems = candidates
    .filter((candidate) =>
      candidate?.schema === "work.review-candidate-projection/v1" &&
      !reviewedCandidateIds.has(candidate.subject_id))
    .map((candidate) => reviewInboxItem({ candidate }));
  const items = [...reviewItems, ...candidateItems]
    .sort((left, right) => canonicalStringCompare(left.review_id, right.review_id));
  const subjectWatermarks = [
    ...candidates
      .filter((candidate) =>
        candidate?.schema === "work.review-candidate-projection/v1")
      .map((candidate) => reviewInboxSubjectWatermark(
        "candidate",
        candidate.subject_id,
        candidate.watermark,
      )),
    ...reviews
      .filter((review) => review?.schema === "flow.review-projection/v1")
      .map((review) => reviewInboxSubjectWatermark(
        "review",
        review.subject_id,
        review.watermark,
      )),
  ].sort((left, right) => canonicalStringCompare(left.stream_id, right.stream_id));
  const projectionDigest = digest({
    schema: "flow.review-inbox-visible-snapshot/v1",
    items,
  });
  const watermarkRecord = {
    schema: REVIEW_INBOX_WATERMARK_SCHEMA,
    projection_digest: projectionDigest,
    subject_watermarks: subjectWatermarks,
  };
  const authorityWatermark = digest(watermarkRecord);
  return freezeCanonical({
    schema: REVIEW_INBOX_PROJECTION_SCHEMA,
    contract: REVIEW_INBOX_QUERY_CONTRACT,
    authority: "ReviewAuthority",
    watermark: authorityWatermark,
    authority_watermark: authorityWatermark,
    authority_watermark_domain: "review",
    watermark_schema: REVIEW_INBOX_WATERMARK_SCHEMA,
    projection_digest: projectionDigest,
    subject_watermarks: subjectWatermarks,
    items,
    legal_actions: [],
  });
}

function reviewInboxSubjectWatermark(streamKind, subjectId, watermark) {
  return {
    stream_kind: streamKind,
    stream_id: `work:work.review/v1:${subjectId}`,
    subject_id: subjectId,
    watermark,
  };
}

function canonicalStringCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function reviewInboxItem({ review = null, candidate = null } = {}) {
  const reviewId = review?.subject_id ??
    candidate?.review_id ??
    candidate?.candidate?.candidate_id ?? null;
  const candidateValue = review?.candidate ?? candidate?.candidate ?? null;
  const candidateFingerprint = review?.candidate_fingerprint ??
    candidate?.candidate_fingerprint ?? candidateValue?.candidate_fingerprint ?? null;
  const lifecycleGeneration = review?.lifecycle_generation ??
    candidate?.candidate?.lifecycle_generation ?? null;
  const candidateProjection = candidate === null ? null : {
    ...candidate,
    legal_actions: [],
  };
  const localReview = review?.target_kind === undefined ||
    review?.target_kind === "local";
  const reviewLegalActions = localReview &&
      Array.isArray(review?.legal_actions) &&
      review.legal_actions.length > 0
    ? review.legal_actions
    : localReview ? reviewHumanLegalActions(review, candidate) : [];
  const reviewProjection = review === null ? null : {
    ...review,
    legal_actions: reviewLegalActions,
  };
  const reviewAuthorityWatermark = review?.watermark ?? null;
  const candidateAuthorityWatermark = candidate?.watermark ??
    review?.candidate_authority_watermark ?? null;
  const legalActions = reviewProjection?.legal_actions ??
    (localReview && review !== null && review.current === true
      ? [reviewSessionStartAction({
          reviewId,
          candidateFingerprint,
          lifecycleGeneration,
          candidateAuthorityWatermark,
          expectedWatermark: reviewAuthorityWatermark ?? EMPTY_WATERMARK,
          expectedGeneration: review?.review_generation ?? 0,
        })]
      : []);
  return {
    schema: "flow.review-inbox-item/v1",
    review_id: reviewId,
    candidate_id: candidateValue?.candidate_id ?? candidate?.subject_id ?? null,
    candidate_fingerprint: candidateFingerprint,
    lifecycle_generation: lifecycleGeneration,
    candidate_authority_watermark: candidateAuthorityWatermark,
    review_authority_watermark: reviewAuthorityWatermark,
    candidate: candidateProjection,
    review: reviewProjection,
    status: reviewProjection?.status ?? candidate?.status ?? "unknown",
    current: reviewProjection?.current ?? candidate?.current ?? false,
    legal_actions: legalActions,
  };
}

export function validateReviewRecordCommand(command) {
  if (command?.schema === GITHUB_REVIEW_RECORD_COMMAND_SCHEMA) {
    return validateGitHubReviewRecordCommand(command);
  }
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
    normalizeReviewFindings(command.summary.findings, {
      source: "authority",
      urgencyFloor: command.summary.urgency_floor,
    });
    const renderedFindings = normalizeReviewFindings(
      command.summary.rendered_findings,
      { source: "authority", urgencyFloor: command.summary.urgency_floor },
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

export function validateGitHubReviewRecordCommand(command) {
  const target = command?.target;
  const targetFingerprint = reviewTargetFingerprint(target);
  const targetAuthorityWatermark = reviewTargetAuthorityWatermark(target);
  if (!nonEmpty(command?.source_run_id) ||
      command.schema !== GITHUB_REVIEW_RECORD_COMMAND_SCHEMA ||
      command.type !== "github_review_record" ||
      command.contract !== "work.review/v1" ||
      command.command_id !==
        `github-review-record:${targetFingerprint}:${command.lifecycle_generation}` ||
      command.subject_id !== reviewSubjectId(target) ||
      !targetFingerprint ||
      command.target_fingerprint !== targetFingerprint ||
      command.target_authority_watermark !== targetAuthorityWatermark ||
      !Number.isSafeInteger(command.lifecycle_generation) ||
      command.lifecycle_generation < 1 ||
      command.lifecycle_generation !== target?.lifecycle_generation ||
      command.operation_contract !== REVIEW_OPERATION_CONTRACTS.record ||
      !nonEmpty(command.operation_effect_id) ||
      !nonEmpty(command.operation_attempt_id) ||
      !nonEmpty(command.operation_idempotency_key) ||
      !isDigest(command.source_authority_watermark) ||
      !isRecord(command.summary) ||
      command.summary.schema !== "flow.review-summary/v1" ||
      command.summary.candidate_fingerprint !== targetFingerprint ||
      command.summary.candidate_authority_watermark !== targetAuthorityWatermark ||
      command.summary.lifecycle_generation !== command.lifecycle_generation ||
      !isRecord(command.automated_evidence) ||
      command.automated_evidence.schema !== "flow.review-automated-evidence/v1" ||
      !isDigest(command.automated_evidence.source_authority_watermark) ||
      command.source_authority_watermark !==
        command.automated_evidence.source_authority_watermark ||
      !isDeepEqualDigest(command.automated_evidence, command.summary.automated_evidence) ||
      !isRecord(command.artifacts) ||
      command.artifacts.schema !== "flow.review-artifacts/v1") {
    throw reviewValidationError(
      "invalid_github_review_record",
      "GitHub review record command is incomplete",
    );
  }
  try {
    validateGitHubReviewTarget(target);
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
    throw reviewValidationError(error.code ?? "malformed_github_review_record", error.message);
  }
  try {
    const provenance = command.artifacts.provenance;
    if (provenance?.operation_contract !== command.operation_contract ||
        !nonEmpty(provenance?.run_id) ||
        provenance.run_id !== command.source_run_id ||
        provenance.operation_effect_id !== command.operation_effect_id ||
        provenance.operation_attempt_id !== command.operation_attempt_id ||
        provenance.operation_idempotency_key !== command.operation_idempotency_key) {
      throw reviewValidationError(
        "review_provenance_mismatch",
        "GitHub review artifacts are not bound to the registered operation intent",
      );
    }
    const expectedArtifacts = renderReviewArtifacts({
      summary: command.summary,
      watermark: command.artifacts.watermark,
      provenance,
    });
    if (!isDeepEqualDigest(expectedArtifacts, command.artifacts)) {
      throw reviewValidationError(
        "artifact_identity_mismatch",
        "GitHub review artifacts are not deterministic for the recorded summary",
      );
    }
  } catch (error) {
    throw reviewValidationError(error.code ?? "malformed_github_review_artifacts", error.message);
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
      !isReviewUrgencyFloor(summary.urgency_floor) ||
      !isReviewSupplements(summary.orientation, summary.diagrams) ||
      !isRecord(summary.coverage) ||
      summary.coverage.schema !== "flow.review-coverage/v1" ||
      typeof summary.coverage.complete !== "boolean" ||
      !Array.isArray(summary.coverage.lenses) ||
      summary.merge_ready !== false ||
      !["no_findings", "findings", "review_incomplete", "blocked"].includes(summary.posture)) {
    throw reviewValidationError("invalid_review_summary", "review summary is malformed");
  }
  const lensResults = summary.lens_results.map((result, index) => {
    const parsed = parseReviewDelegateResult(result, {
      lens: summary.enabled_lenses[index],
      role: "lens",
      urgencyFloor: summary.urgency_floor,
    });
    if (!isDeepEqualDigest(parsed, result)) {
      throw reviewValidationError("invalid_review_summary", "lens result is not canonical");
    }
    return parsed;
  });
  const criticResult = parseReviewDelegateResult(summary.critic_result, {
    role: "critic",
    urgencyFloor: summary.urgency_floor,
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
    urgencyFloor: summary.urgency_floor,
    orientation: summary.orientation,
    diagrams: summary.diagrams,
  });
  if (!isDeepEqualDigest(recomputed.findings, summary.findings) ||
      !isDeepEqualDigest(recomputed.rendered_findings, summary.rendered_findings) ||
      recomputed.posture !== summary.posture ||
      !isDeepEqualDigest(recomputed.coverage, summary.coverage) ||
      recomputed.urgency_floor !== summary.urgency_floor ||
      recomputed.merge_ready !== summary.merge_ready ||
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

export function isReviewTargetInvalidationCommand(command) {
  return command?.schema === "work.review-target-invalidation-command/v1" &&
    command.type === "review_target_invalidated" &&
    command.contract === "work.review/v1";
}

export function isReviewTargetRefreshCommand(command) {
  return command?.schema === "work.review-target-refresh-command/v1" &&
    command.type === "review_target_refresh" &&
    command.contract === "work.review/v1";
}

export function isReviewHumanCommand(command) {
  return command?.schema === REVIEW_HUMAN_COMMAND_SCHEMA &&
    command.contract === "work.review/v1" &&
    REVIEW_HUMAN_ACTIONS.includes(command.type);
}

export function reviewTargetInvalidationIssue(
  command,
  current,
  authorityObservation = null,
) {
  if (!hasExactKeys(command, [
    "schema",
    "type",
    "contract",
    "command_id",
    "subject_id",
    "expected_watermark",
    "prior_candidate_fingerprint",
    "prior_lifecycle_generation",
    "observed_candidate_fingerprint",
    "observed_lifecycle_generation",
    "reason",
  ], ["prior_mutation_epoch", "observed_mutation_epoch"])) {
    return "invalid_review_target_invalidation";
  }
  if (current?.schema !== "flow.review-projection/v1") return "unknown_subject";
  if (command.expected_watermark !== current.watermark) {
    return "stale_authority_watermark";
  }
  if (current.current === false || current.status === "stale") {
    return "review_already_invalidated";
  }
  const priorMutationEpoch = current.candidate?.workspace?.mutation_epoch;
  const hasMutationEpoch = Object.hasOwn(command, "prior_mutation_epoch") ||
    Object.hasOwn(command, "observed_mutation_epoch");
  const mutationEpochsValid = hasCompleteMutationEpochPair(command) &&
    (!hasMutationEpoch ||
      Number.isSafeInteger(command.prior_mutation_epoch ?? priorMutationEpoch) &&
      (command.prior_mutation_epoch ?? priorMutationEpoch) >= 1 &&
      Number.isSafeInteger(command.observed_mutation_epoch) &&
      command.observed_mutation_epoch >= 1 &&
      (command.prior_mutation_epoch === undefined ||
        command.prior_mutation_epoch === priorMutationEpoch));
  const targetMoved = reviewTargetMovement(command);
  if (command.subject_id !== current.subject_id ||
      !isDigest(command.prior_candidate_fingerprint) ||
      command.prior_candidate_fingerprint !== current.candidate_fingerprint ||
      !Number.isSafeInteger(command.prior_lifecycle_generation) ||
      command.prior_lifecycle_generation !== current.lifecycle_generation ||
      !isDigest(command.observed_candidate_fingerprint) ||
      !Number.isSafeInteger(command.observed_lifecycle_generation) ||
      command.observed_lifecycle_generation < 1 ||
      !mutationEpochsValid ||
      !targetMoved ||
      command.reason !== "target_moved" ||
      command.command_id !== reviewTargetInvalidationCommandId(command)) {
    return "invalid_review_target_invalidation";
  }
  const observationIssue = reviewTargetObservationIssue(
    command,
    current,
    authorityObservation,
  );
  if (observationIssue !== null) return observationIssue;
  return null;
}

export function reviewTargetRefreshIssue(
  command,
  current,
  authorityObservation = null,
) {
  if (!hasExactKeys(command, [
    "schema",
    "type",
    "contract",
    "command_id",
    "subject_id",
    "expected_watermark",
    "prior_candidate_fingerprint",
    "prior_lifecycle_generation",
    "observed_candidate_fingerprint",
    "observed_lifecycle_generation",
    "authority_observation",
  ], ["prior_mutation_epoch", "observed_mutation_epoch"]) ||
      !hasCompleteMutationEpochPair(command) ||
      command.schema !== "work.review-target-refresh-command/v1" ||
      command.type !== "review_target_refresh" ||
      command.contract !== "work.review/v1" ||
      !nonEmpty(command.command_id) ||
      !nonEmpty(command.subject_id) ||
      !isDigest(command.expected_watermark) ||
      !isDigest(command.prior_candidate_fingerprint) ||
      !Number.isSafeInteger(command.prior_lifecycle_generation) ||
      command.prior_lifecycle_generation < 1 ||
      !isDigest(command.observed_candidate_fingerprint) ||
      !Number.isSafeInteger(command.observed_lifecycle_generation) ||
      command.observed_lifecycle_generation < 1) {
    return "invalid_review_target_refresh";
  }
  if (current?.schema !== "flow.review-projection/v1") return "unknown_subject";
  if (command.expected_watermark !== current.watermark) {
    return "stale_authority_watermark";
  }
  const invalidation = current.invalidation;
  if (current.current !== false || current.status !== "stale" ||
      !isRecord(invalidation)) {
    return "review_target_not_stale";
  }
  if (command.subject_id !== current.subject_id ||
      command.prior_candidate_fingerprint !== invalidation.prior_candidate_fingerprint ||
      command.prior_lifecycle_generation !== invalidation.prior_lifecycle_generation ||
      command.observed_candidate_fingerprint !== invalidation.observed_candidate_fingerprint ||
      command.observed_lifecycle_generation !== invalidation.observed_lifecycle_generation ||
      command.prior_mutation_epoch !== invalidation.prior_mutation_epoch ||
      command.observed_mutation_epoch !== invalidation.observed_mutation_epoch ||
      command.command_id !== reviewTargetRefreshCommandId({
        subjectId: command.subject_id,
        observedCandidateFingerprint: command.observed_candidate_fingerprint,
        observedLifecycleGeneration: command.observed_lifecycle_generation,
        observedMutationEpoch: command.observed_mutation_epoch,
    })) {
    return "invalid_review_target_refresh";
  }
  const trustedObservation = invalidation.observation ?? null;
  if (reviewTargetObservationShapeIssue(trustedObservation) !== null ||
      !isDeepEqualDigest(command.authority_observation, trustedObservation) ||
      authorityObservation !== null &&
        !isDeepEqualDigest(authorityObservation, trustedObservation)) {
    return "invalid_review_target_refresh";
  }
  const observation = authorityObservation ?? trustedObservation;
  if (reviewTargetObservationIssue(command, current, observation) !== null) {
    return "invalid_review_target_refresh";
  }
  if (observation === null) return "review_target_observation_unavailable";
  return null;
}

export function buildReviewTargetObservation({
  subjectId,
  candidateId,
  candidateFingerprint,
  lifecycleGeneration,
  mutationEpoch,
  authorityWatermark,
  source = "named_mechanism_observation",
}) {
  const observation = {
    schema: "flow.review-target-observation/v1",
    subject_id: subjectId,
    candidate_id: candidateId,
    candidate_fingerprint: candidateFingerprint,
    lifecycle_generation: lifecycleGeneration,
    ...(mutationEpoch === undefined ? {} : { mutation_epoch: mutationEpoch }),
    authority_watermark: authorityWatermark,
    source,
  };
  const canonical = {
    ...observation,
    evidence_digest: digest(observation),
  };
  if (reviewTargetObservationShapeIssue(canonical) !== null) {
    throw reviewValidationError(
      "invalid_review_target_observation",
      "review target observation is not canonical",
    );
  }
  return freezeCanonical(canonical);
}

function isReviewUrgencyFloor(value) {
  try {
    return normalizeReviewUrgencyFloor(value) === value;
  } catch {
    return false;
  }
}

function isReviewSupplements(orientation, diagrams) {
  try {
    return isDeepEqualDigest(normalizeReviewOrientation(orientation), orientation) &&
      isDeepEqualDigest(normalizeReviewDiagrams(diagrams), diagrams);
  } catch {
    return false;
  }
}

function reviewTargetObservationIssue(command, current, observation) {
  if (observation === null || observation === undefined) {
    return "review_target_observation_unavailable";
  }
  const shapeIssue = reviewTargetObservationShapeIssue(observation);
  if (shapeIssue !== null) return shapeIssue;
  const commandHasMutationEpoch = Object.hasOwn(
    command,
    "observed_mutation_epoch",
  );
  const observationHasMutationEpoch = Object.hasOwn(
    observation,
    "mutation_epoch",
  );
  if (observation.subject_id !== current.subject_id ||
      observation.candidate_id !== current.candidate?.candidate_id ||
      observation.candidate_fingerprint !== command.observed_candidate_fingerprint ||
      observation.lifecycle_generation !== command.observed_lifecycle_generation ||
      commandHasMutationEpoch !== observationHasMutationEpoch ||
      commandHasMutationEpoch &&
        observation.mutation_epoch !== command.observed_mutation_epoch) {
    return "review_target_observation_mismatch";
  }
  return null;
}

function reviewTargetObservationShapeIssue(observation) {
  if (!hasExactKeys(observation, [
    "schema",
    "subject_id",
    "candidate_id",
    "candidate_fingerprint",
    "lifecycle_generation",
    "authority_watermark",
    "source",
    "evidence_digest",
  ], ["mutation_epoch"]) ||
      observation.schema !== "flow.review-target-observation/v1" ||
      !nonEmpty(observation.subject_id) ||
      !nonEmpty(observation.candidate_id) ||
      !isDigest(observation.candidate_fingerprint) ||
      !Number.isSafeInteger(observation.lifecycle_generation) ||
      observation.lifecycle_generation < 1 ||
      Object.hasOwn(observation, "mutation_epoch") &&
        (!Number.isSafeInteger(observation.mutation_epoch) ||
         observation.mutation_epoch < 1) ||
      !isDigest(observation.authority_watermark) ||
      !["candidate_projection", "named_mechanism_observation"].includes(observation.source) ||
      !isDigest(observation.evidence_digest)) {
    return "invalid_review_target_observation";
  }
  const { evidence_digest: _evidenceDigest, ...identity } = observation;
  if (digest(identity) !== observation.evidence_digest) {
    return "invalid_review_target_observation";
  }
  return null;
}

function hasCompleteMutationEpochPair(value) {
  return Object.hasOwn(value, "prior_mutation_epoch") ===
    Object.hasOwn(value, "observed_mutation_epoch");
}

function reviewTargetMovement(value) {
  return value.observed_candidate_fingerprint !==
      value.prior_candidate_fingerprint ||
    value.observed_lifecycle_generation !== value.prior_lifecycle_generation ||
    Object.hasOwn(value, "prior_mutation_epoch") &&
      value.observed_mutation_epoch !== value.prior_mutation_epoch;
}

function reviewTargetInvalidationCommandId(command) {
  const suffix = command.observed_mutation_epoch === undefined
    ? ""
    : `:${command.observed_mutation_epoch}`;
  return `review-target-invalidate:${command.subject_id}:${command.observed_candidate_fingerprint}:${command.observed_lifecycle_generation}${suffix}`;
}

function reviewTargetRefreshCommandId({
  subjectId,
  observedCandidateFingerprint,
  observedLifecycleGeneration,
  observedMutationEpoch,
}) {
  const suffix = observedMutationEpoch === undefined
    ? ""
    : `:${observedMutationEpoch}`;
  return `review-target-refresh:${subjectId}:${observedCandidateFingerprint}:${observedLifecycleGeneration}${suffix}`;
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
  return reviewTargetKind(target) === "github"
    ? `review:github:${target.snapshot_fingerprint}:${target.lifecycle_generation}`
    : `review:${target.candidate.candidate_fingerprint}:${target.lifecycle_generation}`;
}

export function reviewEventWatermark({ previousWatermark, event }) {
  return digest({
    schema: "flow.review-authority-watermark/v1",
    previous_watermark: previousWatermark,
    event,
  });
}

/**
 * Build target movement events in one place so in-memory and SQLite
 * ReviewAuthority implementations share the same validation, payload, and
 * chained watermark semantics.
 */
export function buildReviewTargetInvalidationEvent({
  command,
  current,
  authorityObservation = null,
}) {
  const issue = reviewTargetInvalidationIssue(
    command,
    current,
    authorityObservation,
  );
  if (issue !== null) return { issue };
  const invalidation = freezeCanonical({
    schema: "flow.review-target-invalidation/v1",
    subject_id: command.subject_id,
    prior_candidate_fingerprint: command.prior_candidate_fingerprint,
    prior_lifecycle_generation: command.prior_lifecycle_generation,
    observed_candidate_fingerprint: command.observed_candidate_fingerprint,
    observed_lifecycle_generation: command.observed_lifecycle_generation,
    ...(command.prior_mutation_epoch === undefined ? {} : {
      prior_mutation_epoch: command.prior_mutation_epoch,
    }),
    ...(command.observed_mutation_epoch === undefined ? {} : {
      observed_mutation_epoch: command.observed_mutation_epoch,
    }),
    reason: command.reason,
    ...(authorityObservation === null ? {} : {
      observation: authorityObservation,
    }),
  });
  const watermark = reviewEventWatermark({
    previousWatermark: current.watermark,
    event: invalidation,
  });
  return {
    event: {
      contract: "work.review-event/v1",
      payload: {
        type: "review_target_invalidated",
        invalidation,
        watermark,
        command_receipt: {
          schema: "work.idempotency-receipt/v1",
          command_id: command.command_id,
          command_digest: idempotencyCommandDigest(command),
        },
      },
    },
    watermark,
  };
}

export function buildReviewTargetRefreshEvent({
  command,
  current,
  authorityObservation = null,
}) {
  const resolvedObservation = authorityObservation ?? current?.invalidation?.observation ?? null;
  const issue = reviewTargetRefreshIssue(
    command,
    current,
    resolvedObservation,
  );
  if (issue !== null) return { issue };
  const refresh = freezeCanonical({
    schema: "flow.review-target-refresh/v1",
    subject_id: command.subject_id,
    prior_candidate_fingerprint: command.prior_candidate_fingerprint,
    prior_lifecycle_generation: command.prior_lifecycle_generation,
    observed_candidate_fingerprint: command.observed_candidate_fingerprint,
    observed_lifecycle_generation: command.observed_lifecycle_generation,
    ...(command.prior_mutation_epoch === undefined ? {} : {
      prior_mutation_epoch: command.prior_mutation_epoch,
    }),
    ...(command.observed_mutation_epoch === undefined ? {} : {
      observed_mutation_epoch: command.observed_mutation_epoch,
    }),
    ...(resolvedObservation === null ? {} : {
      observation: resolvedObservation,
    }),
  });
  const watermark = reviewEventWatermark({
    previousWatermark: current.watermark,
    event: refresh,
  });
  return {
    event: {
      contract: "work.review-event/v1",
      payload: {
        type: "review_target_refresh_acknowledged",
        refresh,
        watermark,
        command_receipt: {
          schema: "work.idempotency-receipt/v1",
          command_id: command.command_id,
          command_digest: idempotencyCommandDigest(command),
        },
      },
    },
    watermark,
  };
}

export function reviewAuthorityEventWatermark(records) {
  if (!Array.isArray(records)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review authority event records are not an array",
    );
  }
  validateReviewHumanEventRecords(records);
  let previousWatermark = EMPTY_WATERMARK;
  for (const payload of records) {
    let event;
    try {
      event = reviewEventWatermarkIdentityForPayload(payload);
    } catch (error) {
      throw reviewAuthorityIntegrityError(
        error.reason ?? "malformed_event",
        error.message,
      );
    }
    let expected;
    try {
      expected = reviewEventWatermark({ previousWatermark, event });
    } catch (error) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        error.message,
      );
    }
    if (payload?.watermark !== expected) {
      throw reviewAuthorityIntegrityError(
        "watermark_chain_conflict",
        "review authority event watermark chain is invalid",
      );
    }
    previousWatermark = expected;
  }
  return previousWatermark;
}

function validateReviewRecordedEvent(payload, previousWatermark) {
  if (!hasExactKeys(payload, [
    "type",
    "body",
    "watermark",
  ], ["command", "command_receipt"]) ||
      payload.type !== "review_recorded" ||
      !isDigest(payload.watermark) ||
      payload.command !== undefined && payload.command_receipt === undefined ||
      payload.command_receipt !== undefined &&
        !validReviewCommandReceipt(payload.command_receipt)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review record event envelope is malformed",
    );
  }
  const body = payload.body;
  if (!hasExactKeys(body, [
    "schema",
    "review_id",
    "candidate_fingerprint",
    "candidate_authority_watermark",
    "lifecycle_generation",
    "candidate",
    "summary",
    "automated_evidence",
    "artifacts",
    "source_authority_watermark",
    "source_run_id",
    "operation_contract",
    "operation_effect_id",
    "operation_attempt_id",
    "operation_idempotency_key",
  ]) || body.schema !== "flow.review-record/v1") {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review record event body is malformed",
    );
  }
  if (payload.command_receipt === undefined) {
    validateLegacyReviewRecordedBody(body, previousWatermark, payload.watermark);
    return;
  }
  const command = payload.command ?? reviewRecordCommandFromEvent(
    body,
    payload.command_receipt,
    previousWatermark,
  );
  const commandKeys = [
    "schema",
    "type",
    "contract",
    "command_id",
    "subject_id",
    "expected_watermark",
    "candidate_fingerprint",
    "candidate_authority_watermark",
    "lifecycle_generation",
    "candidate",
    "summary",
    "automated_evidence",
    "artifacts",
    "source_authority_watermark",
    "operation_contract",
    "operation_effect_id",
    "operation_attempt_id",
    "operation_idempotency_key",
    "source_run_id",
  ];
  if (!hasExactKeys(command, commandKeys) ||
      command.expected_watermark !== previousWatermark ||
      command.command_id !== payload.command_receipt.command_id) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review record event command identity is malformed",
    );
  }
  try {
    validateReviewRecordCommand(command);
  } catch (error) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      error?.message ?? "review record event command is invalid",
    );
  }
  const expectedBody = reviewRecordBodyFromCommand(command);
  if (!isDeepStrictEqual(expectedBody, body) ||
      payload.command_receipt.command_digest !== idempotencyCommandDigest(command) ||
      body.artifacts.watermark !== payload.watermark) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review record event is not bound to its accepted command",
    );
  }
}

function validateGitHubReviewRecordedEvent(payload, previousWatermark) {
  if (!hasExactKeys(payload, [
    "type",
    "body",
    "watermark",
  ], ["command_receipt"]) ||
      payload.type !== "github_review_recorded" ||
      !isDigest(payload.watermark) ||
      payload.command_receipt !== undefined &&
        !validReviewCommandReceipt(payload.command_receipt)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "GitHub review record event envelope is malformed",
    );
  }
  const body = payload.body;
  const bodyKeys = [
    "schema",
    "review_id",
    "target",
    "target_fingerprint",
    "target_authority_watermark",
    "lifecycle_generation",
    "summary",
    "automated_evidence",
    "artifacts",
    "source_authority_watermark",
    "source_run_id",
    "operation_contract",
    "operation_effect_id",
    "operation_attempt_id",
    "operation_idempotency_key",
  ];
  if (!hasExactKeys(body, bodyKeys) ||
      body.schema !== GITHUB_REVIEW_RECORD_SCHEMA) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "GitHub review record event body is malformed",
    );
  }
  const command = githubReviewRecordCommandFromEvent(
    body,
    payload.command_receipt,
    previousWatermark,
  );
  try {
    validateGitHubReviewRecordCommand(command);
  } catch (error) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      error?.message ?? "GitHub review record event command is invalid",
    );
  }
  if (payload.command_receipt !== undefined && (
    payload.command_receipt.command_id !== command.command_id ||
    payload.command_receipt.command_digest !== idempotencyCommandDigest(command) ||
    body.artifacts.watermark !== payload.watermark
  )) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "GitHub review record event is not bound to its accepted command",
    );
  }
}

function githubReviewRecordCommandFromEvent(body, receipt, expectedWatermark) {
  const targetFingerprint = body.target_fingerprint;
  const lifecycleGeneration = body.lifecycle_generation;
  return {
    schema: GITHUB_REVIEW_RECORD_COMMAND_SCHEMA,
    type: "github_review_record",
    contract: "work.review/v1",
    command_id: receipt?.command_id ??
      `github-review-record:${targetFingerprint}:${lifecycleGeneration}`,
    subject_id: body.review_id,
    expected_watermark: expectedWatermark,
    target: body.target,
    target_fingerprint: targetFingerprint,
    target_authority_watermark: body.target_authority_watermark,
    lifecycle_generation: lifecycleGeneration,
    summary: body.summary,
    automated_evidence: body.automated_evidence,
    artifacts: body.artifacts,
    source_authority_watermark: body.source_authority_watermark,
    source_run_id: body.source_run_id,
    operation_contract: body.operation_contract,
    operation_effect_id: body.operation_effect_id,
    operation_attempt_id: body.operation_attempt_id,
    operation_idempotency_key: body.operation_idempotency_key,
  };
}

function validateLegacyReviewRecordedBody(
  body,
  previousWatermark,
  eventWatermark,
) {
  if (!isRecord(body) ||
      body.schema !== "flow.review-record/v1" ||
      !nonEmpty(body.review_id) ||
      !isDigest(body.candidate_fingerprint) ||
      !isDigest(body.candidate_authority_watermark) ||
      !Number.isSafeInteger(body.lifecycle_generation) ||
      body.lifecycle_generation < 1 ||
      body.review_id !==
        `review:${body.candidate_fingerprint}:${body.lifecycle_generation}` ||
      !validateReviewCandidate(body.candidate) ||
      body.candidate.candidate_fingerprint !== body.candidate_fingerprint ||
      !isRecord(body.summary) ||
      body.summary.schema !== "flow.review-summary/v1" ||
      body.summary.candidate_fingerprint !== body.candidate_fingerprint ||
      body.summary.candidate_authority_watermark !==
        body.candidate_authority_watermark ||
      body.summary.lifecycle_generation !== body.lifecycle_generation ||
      !isRecord(body.automated_evidence) ||
      body.automated_evidence.schema !== "flow.review-automated-evidence/v1" ||
      body.source_authority_watermark !==
        body.automated_evidence.source_authority_watermark ||
      !isDeepStrictEqual(body.automated_evidence, body.summary.automated_evidence) ||
      !isRecord(body.artifacts) ||
      body.artifacts.schema !== "flow.review-artifacts/v1" ||
      !isDigest(body.artifacts.watermark) ||
      !nonEmpty(body.operation_contract) ||
      !nonEmpty(body.operation_effect_id) ||
      !nonEmpty(body.operation_attempt_id) ||
      !nonEmpty(body.operation_idempotency_key) ||
      !nonEmpty(body.source_run_id) ||
      !isDigest(body.source_authority_watermark)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "legacy review record event body is malformed",
    );
  }
  const expectedWatermark = reviewEventWatermark({
    previousWatermark,
    event: reviewRecordWatermarkIdentity(body),
  });
  if (eventWatermark !== expectedWatermark ||
      body.artifacts.watermark !== eventWatermark) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "legacy review record event watermark is not bound to its artifacts",
    );
  }
  let normalizedSummary;
  try {
    normalizedSummary = validateLegacyReviewSummary(
      body.summary,
      body.automated_evidence,
    );
    validateLegacyReviewArtifacts(
      body.artifacts,
      body,
      normalizedSummary,
      eventWatermark,
    );
  } catch (error) {
    if (error?.code === "review_authority_integrity_failure") throw error;
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      error?.message ?? "legacy review record event body is malformed",
    );
  }
}

function validateLegacyReviewSummary(summary, automatedEvidence) {
  const optionalLegacyKeys = ["coverage", "orientation", "diagrams"];
  const requiredKeys = [
    "schema",
    "candidate_fingerprint",
    "candidate_authority_watermark",
    "lifecycle_generation",
    "enabled_lenses",
    "finding_cap",
    "urgency_floor",
    "lens_results",
    "critic_result",
    "findings",
    "rendered_findings",
    "cap_reasons",
    "posture",
    "merge_ready",
    "automated_evidence",
  ];
  if (!hasExactKeys(summary, requiredKeys, optionalLegacyKeys) ||
      summary.schema !== "flow.review-summary/v1") {
    throw new TypeError("legacy review summary has an invalid shape");
  }
  const normalized = {
    ...summary,
    orientation: summary.orientation ?? null,
    diagrams: summary.diagrams ?? [],
  };
  if (!Object.hasOwn(summary, "coverage")) {
    const lensResults = summary.lens_results.map((result, index) =>
      parseReviewDelegateResult(result, {
        lens: summary.enabled_lenses[index],
        role: "lens",
        urgencyFloor: summary.urgency_floor,
      }));
    const criticResult = parseReviewDelegateResult(summary.critic_result, {
      role: "critic",
      urgencyFloor: summary.urgency_floor,
    });
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
      urgencyFloor: summary.urgency_floor,
      orientation: normalized.orientation,
      diagrams: normalized.diagrams,
    });
    normalized.coverage = recomputed.coverage;
  }
  validateReviewSummary(normalized, automatedEvidence);
  return normalized;
}

function validateLegacyReviewArtifacts(
  artifacts,
  body,
  normalizedSummary,
  eventWatermark,
) {
  if (!hasExactKeys(artifacts, [
    "schema",
    "watermark",
    "provenance",
    "formats",
    "digests",
  ]) || artifacts.schema !== "flow.review-artifacts/v1" ||
      artifacts.watermark !== eventWatermark) {
    throw new TypeError("legacy review artifacts have an invalid shape");
  }
  const provenance = artifacts.provenance;
  const legacyArtifact = hasExactKeys(provenance, ["operation_contract"]) &&
    hasExactKeys(artifacts.formats, ["markdown"]) &&
    hasExactKeys(artifacts.digests, ["markdown"]);
  if (legacyArtifact) {
    if (provenance.operation_contract !== REVIEW_OPERATION_CONTRACTS.record ||
        typeof artifacts.formats.markdown !== "string" ||
        !isDigest(artifacts.digests.markdown) ||
        artifacts.digests.markdown !== digest(artifacts.formats.markdown)) {
      throw new TypeError("legacy review artifact identity is malformed");
    }
    return;
  }
  if (!validateReviewProvenance(provenance, body, eventWatermark)) {
    throw new TypeError("legacy review artifact provenance is malformed");
  }
  const expectedArtifacts = renderReviewArtifacts({
    summary: normalizedSummary,
    watermark: eventWatermark,
    provenance,
  });
  if (!isDeepStrictEqual(expectedArtifacts, artifacts)) {
    throw new TypeError("legacy review artifacts are not deterministic");
  }
}

function validateReviewProvenance(provenance, body, eventWatermark) {
  return hasExactKeys(provenance, [
    "schema",
    "operation_contract",
    "operation_idempotency_key",
    "run_id",
    "operation_effect_id",
    "operation_attempt_id",
    "candidate_fingerprint",
    "lifecycle_generation",
    "candidate_authority_watermark",
    "source_authority_watermark",
    "review_authority_watermark",
  ]) && provenance.schema === "flow.review-provenance/v1" &&
    provenance.operation_contract === body.operation_contract &&
    provenance.operation_idempotency_key === body.operation_idempotency_key &&
    provenance.run_id === body.source_run_id &&
    provenance.operation_effect_id === body.operation_effect_id &&
    provenance.operation_attempt_id === body.operation_attempt_id &&
    provenance.candidate_fingerprint === body.candidate_fingerprint &&
    provenance.lifecycle_generation === body.lifecycle_generation &&
    provenance.candidate_authority_watermark === body.candidate_authority_watermark &&
    provenance.source_authority_watermark === body.source_authority_watermark &&
    provenance.review_authority_watermark === eventWatermark;
}

function reviewRecordCommandFromEvent(body, receipt, expectedWatermark) {
  return {
    schema: "work.review-record-command/v1",
    type: "review_record",
    contract: "work.review/v1",
    command_id: receipt.command_id,
    subject_id: body.review_id,
    expected_watermark: expectedWatermark,
    candidate_fingerprint: body.candidate_fingerprint,
    candidate_authority_watermark: body.candidate_authority_watermark,
    lifecycle_generation: body.lifecycle_generation,
    candidate: body.candidate,
    summary: body.summary,
    automated_evidence: body.automated_evidence,
    artifacts: body.artifacts,
    source_authority_watermark: body.source_authority_watermark,
    operation_contract: body.operation_contract,
    operation_effect_id: body.operation_effect_id,
    operation_attempt_id: body.operation_attempt_id,
    operation_idempotency_key: body.operation_idempotency_key,
    source_run_id: body.source_run_id,
  };
}

function reviewRecordBodyFromCommand(command) {
  return {
    schema: "flow.review-record/v1",
    review_id: command.subject_id,
    candidate_fingerprint: command.candidate_fingerprint,
    candidate_authority_watermark: command.candidate_authority_watermark,
    lifecycle_generation: command.lifecycle_generation,
    candidate: command.candidate,
    summary: command.summary,
    automated_evidence: command.automated_evidence,
    artifacts: command.artifacts,
    source_authority_watermark: command.source_authority_watermark,
    source_run_id: command.source_run_id,
    operation_contract: command.operation_contract,
    operation_effect_id: command.operation_effect_id,
    operation_attempt_id: command.operation_attempt_id,
    operation_idempotency_key: command.operation_idempotency_key,
  };
}

export function validateReviewHumanEventRecords(records, reviewBody = undefined) {
  if (!Array.isArray(records)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review authority event records are not an array",
    );
  }
  if (records.length === 0) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review authority event stream is missing its initial review record",
    );
  }
  const firstPayload = records[0]?.payload ?? records[0];
  if (!isRecord(firstPayload)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review authority event stream has a malformed initial record",
    );
  }
  if (firstPayload.type !== "review_recorded" &&
      firstPayload.type !== "github_review_recorded") {
    throw reviewAuthorityIntegrityError(
      REVIEW_HUMAN_ACTIONS.includes(firstPayload.type) ||
        firstPayload.type === "review_target_invalidated" ||
        firstPayload.type === "review_target_refresh_acknowledged"
        ? "malformed_event"
        : "unknown_event",
      "review authority event stream must begin with a review record",
    );
  }
  const body = reviewBody ?? (
    firstPayload?.type === "review_recorded" ||
      firstPayload?.type === "github_review_recorded"
      ? firstPayload.body
      : null
  );
  let reviewGeneration = 0;
  let previousWatermark = EMPTY_WATERMARK;
  let recorded = false;
  let initialTargetKind = null;
  let session = null;
  let approval = null;
  let integrationRecorded = false;
  let superseded = false;
  let invalidated = false;
  let targetInvalidation = null;
  let targetRefresh = null;
  const commentIds = new Set();
  const dispositionIds = new Set();

  for (const record of records) {
    const payload = record?.payload ?? record;
    if (!isRecord(payload)) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review authority event payload is malformed",
      );
    }
    if (payload.type === "review_recorded" ||
        payload.type === "github_review_recorded") {
      if (recorded || targetInvalidation !== null || targetRefresh !== null) {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          "review record event is out of order",
        );
      }
      if (payload.type === "review_recorded") {
        validateReviewRecordedEvent(payload, previousWatermark);
      } else {
        validateGitHubReviewRecordedEvent(payload, previousWatermark);
      }
      recorded = true;
      initialTargetKind = payload.type === "github_review_recorded" ? "github" : "local";
      if (isDigest(payload.watermark)) previousWatermark = payload.watermark;
      continue;
    }
    if (payload.type === "review_target_invalidated") {
      if (initialTargetKind === "github") {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          "GitHub review stream cannot accept local target invalidation events",
        );
      }
      if (!recorded || targetInvalidation !== null || targetRefresh !== null ||
          superseded) {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          superseded
            ? "review target invalidation event follows supersession"
            : targetRefresh === null
              ? "review target invalidation event is duplicated or out of order"
              : "review target invalidation event follows target refresh",
        );
      }
      validateReviewTargetInvalidationEvent(payload, body, previousWatermark);
      targetInvalidation = payload.invalidation;
      invalidated = true;
      previousWatermark = payload.watermark;
      continue;
    }
    if (payload.type === "review_target_refresh_acknowledged") {
      if (initialTargetKind === "github") {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          "GitHub review stream cannot accept local target refresh events",
        );
      }
      if (!recorded || targetInvalidation === null || targetRefresh !== null) {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          targetInvalidation === null
            ? "review target refresh event has no preceding invalidation"
            : "review target refresh event is duplicated or out of order",
        );
      }
      validateReviewTargetRefreshEvent(
        payload,
        body,
        targetInvalidation,
        previousWatermark,
      );
      targetRefresh = payload.refresh;
      invalidated = true;
      previousWatermark = payload.watermark;
      continue;
    }
    if (!REVIEW_HUMAN_ACTIONS.includes(payload.type)) continue;
    if (initialTargetKind === "github") {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "GitHub review stream cannot accept local human events",
      );
    }
    if (!recorded) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event precedes the initial review record",
      );
    }
    if (!hasExactKeys(payload, [
      "type",
      "event",
      "watermark",
      "command_receipt",
    ]) || !isDigest(payload.watermark) ||
        !validReviewCommandReceipt(payload.command_receipt)) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event envelope is malformed",
      );
    }
    const event = payload.event;
    const commonKeys = [
      "schema",
      "review_id",
      "target_fingerprint",
      "candidate_authority_watermark",
      "lifecycle_generation",
      "accepted_command",
      "command_receipt_digest",
      "expected_watermark",
      "expected_generation",
      "review_generation",
    ];
    const nestedKey = {
      review_session_start: "session",
      review_comment: "comment",
      review_disposition: "disposition",
      review_approval: "approval",
      review_supersession: "supersession",
      review_integration: "integration",
    }[payload.type];
    if (!hasExactKeys(event, [...commonKeys, nestedKey]) ||
        event.schema !== REVIEW_HUMAN_EVENT_SCHEMA ||
        !nonEmpty(event.review_id) ||
        !isDigest(event.target_fingerprint) ||
        !isDigest(event.candidate_authority_watermark) ||
        !Number.isSafeInteger(event.lifecycle_generation) ||
        event.lifecycle_generation < 1 ||
        !isDigest(event.expected_watermark) ||
        event.expected_watermark !== previousWatermark ||
        !Number.isSafeInteger(event.expected_generation) ||
        event.expected_generation < 0 ||
        event.expected_generation !== reviewGeneration ||
        !Number.isSafeInteger(event.review_generation) ||
        event.review_generation !== reviewGeneration + 1) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event identity or generation is malformed",
      );
    }
    if (isRecord(body) && (
      event.review_id !== body.review_id ||
        event.target_fingerprint !== body.candidate_fingerprint ||
        event.candidate_authority_watermark !== body.candidate_authority_watermark ||
        event.lifecycle_generation !== body.lifecycle_generation
    )) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event target identity is inconsistent",
      );
    }
    if (!isDigest(event.command_receipt_digest) ||
        event.command_receipt_digest !==
          reviewCommandReceiptDigest(payload.command_receipt)) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event receipt identity is inconsistent",
      );
    }
    if (superseded || invalidated) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event follows a terminal target transition",
      );
    }

    const nested = event[nestedKey];
    if (payload.type === "review_session_start") {
      if (session !== null || !validReviewSession(nested, event)) {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          "review session event is malformed",
        );
      }
      session = nested;
    } else {
      if (session === null || nested?.session_id !== session.session_id) {
        throw reviewAuthorityIntegrityError(
          "malformed_event",
          "review human event session identity is inconsistent",
        );
      }
      if (payload.type === "review_comment") {
        if (!validReviewComment(nested) || commentIds.has(nested.comment_id)) {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review comment event is malformed",
          );
        }
        commentIds.add(nested.comment_id);
      } else if (payload.type === "review_disposition") {
        if (!validReviewDisposition(nested)) {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review disposition event is malformed",
          );
        }
        if (nested.finding_id !== undefined &&
            !surfacedReviewFindingIds(body).has(nested.finding_id)) {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review disposition event finding is not surfaced",
          );
        }
        const findingId = nested.finding_id ?? null;
        if (dispositionIds.has(findingId)) {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review disposition event is duplicated",
          );
        }
        dispositionIds.add(findingId);
      } else if (payload.type === "review_approval") {
        if (!validReviewApproval(nested) ||
            integrationRecorded ||
            nested.decision === "approve" && approval === "approve" ||
            nested.decision === "revoke" && approval !== "approve") {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review approval event is malformed",
          );
        }
        approval = nested.decision;
      } else if (payload.type === "review_supersession") {
        if (!validReviewSupersession(nested) ||
            (nested.replacement.candidate_fingerprint === body?.candidate_fingerprint &&
             nested.replacement.lifecycle_generation === body?.lifecycle_generation)) {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review supersession event is malformed",
          );
        }
        superseded = true;
      } else if (payload.type === "review_integration") {
        if (!validReviewIntegration(nested, event) ||
            integrationRecorded || approval !== "approve") {
          throw reviewAuthorityIntegrityError(
            "malformed_event",
            "review integration event is malformed",
          );
        }
        integrationRecorded = true;
      }
    }
    if (!validReviewAcceptedCommand(
      event.accepted_command,
      payload.type,
      event,
      payload.command_receipt,
    )) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event accepted command identity is inconsistent",
      );
    }
    if (!validReviewCommandReceipt(payload.command_receipt, payload.type, event)) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review human event receipt is not bound to its event",
      );
    }
    reviewGeneration = event.review_generation;
    previousWatermark = payload.watermark;
  }
}

function validateReviewTargetInvalidationEvent(payload, body, previousWatermark) {
  if (!hasExactKeys(payload, [
    "type",
    "invalidation",
    "watermark",
    "command_receipt",
  ]) || !isDigest(payload.watermark) ||
      !validReviewCommandReceipt(payload.command_receipt)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target invalidation event envelope is malformed",
    );
  }
  const invalidation = payload.invalidation;
  if (!hasExactKeys(invalidation, [
    "schema",
    "subject_id",
    "prior_candidate_fingerprint",
    "prior_lifecycle_generation",
    "observed_candidate_fingerprint",
    "observed_lifecycle_generation",
    "reason",
    "observation",
  ], ["prior_mutation_epoch", "observed_mutation_epoch"]) ||
      !hasCompleteMutationEpochPair(invalidation) ||
      invalidation.schema !== "flow.review-target-invalidation/v1" ||
      !nonEmpty(invalidation.subject_id) ||
      !isDigest(invalidation.prior_candidate_fingerprint) ||
      !Number.isSafeInteger(invalidation.prior_lifecycle_generation) ||
      invalidation.prior_lifecycle_generation < 1 ||
      !isDigest(invalidation.observed_candidate_fingerprint) ||
      !Number.isSafeInteger(invalidation.observed_lifecycle_generation) ||
      invalidation.observed_lifecycle_generation < 1 ||
      invalidation.reason !== "target_moved" ||
      !reviewTargetMovement(invalidation)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target invalidation event payload is malformed",
    );
  }
  validateReviewTargetEventIdentity(invalidation, body, "invalidation");
  validateReviewTargetObservationForEvent(invalidation, body, "invalidation");
  const command = reviewTargetInvalidationCommandFromEvent(
    invalidation,
    previousWatermark,
    payload.command_receipt.command_id,
  );
  if (payload.command_receipt.command_id !==
        reviewTargetInvalidationCommandId(command) ||
      payload.command_receipt.command_digest !== idempotencyCommandDigest(command)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target invalidation event receipt is not bound to its payload",
    );
  }
}

function validateReviewTargetRefreshEvent(
  payload,
  body,
  invalidation,
  previousWatermark,
) {
  if (!hasExactKeys(payload, [
    "type",
    "refresh",
    "watermark",
    "command_receipt",
  ]) || !isDigest(payload.watermark) ||
      !validReviewCommandReceipt(payload.command_receipt)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target refresh event envelope is malformed",
    );
  }
  const refresh = payload.refresh;
  if (!hasExactKeys(refresh, [
    "schema",
    "subject_id",
    "prior_candidate_fingerprint",
    "prior_lifecycle_generation",
    "observed_candidate_fingerprint",
    "observed_lifecycle_generation",
    "observation",
  ], ["prior_mutation_epoch", "observed_mutation_epoch"]) ||
      !hasCompleteMutationEpochPair(refresh) ||
      refresh.schema !== "flow.review-target-refresh/v1" ||
      !nonEmpty(refresh.subject_id) ||
      !isDigest(refresh.prior_candidate_fingerprint) ||
      !Number.isSafeInteger(refresh.prior_lifecycle_generation) ||
      refresh.prior_lifecycle_generation < 1 ||
      !isDigest(refresh.observed_candidate_fingerprint) ||
      !Number.isSafeInteger(refresh.observed_lifecycle_generation) ||
      refresh.observed_lifecycle_generation < 1) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target refresh event payload is malformed",
    );
  }
  validateReviewTargetEventIdentity(refresh, body, "refresh");
  validateReviewTargetObservationForEvent(refresh, body, "refresh");
  for (const field of [
    "subject_id",
    "prior_candidate_fingerprint",
    "prior_lifecycle_generation",
    "observed_candidate_fingerprint",
    "observed_lifecycle_generation",
    "prior_mutation_epoch",
    "observed_mutation_epoch",
  ]) {
    if (refresh[field] !== invalidation[field]) {
      throw reviewAuthorityIntegrityError(
        "malformed_event",
        "review target refresh event is not bound to its invalidation",
      );
    }
  }
  if (!isDeepEqualDigest(refresh.observation, invalidation.observation)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target refresh observation is not bound to its invalidation",
    );
  }
  const command = reviewTargetRefreshCommandFromEvent(
    refresh,
    previousWatermark,
    payload.command_receipt.command_id,
  );
  if (payload.command_receipt.command_id !== reviewTargetRefreshCommandId({
    subjectId: command.subject_id,
    observedCandidateFingerprint: command.observed_candidate_fingerprint,
    observedLifecycleGeneration: command.observed_lifecycle_generation,
    observedMutationEpoch: command.observed_mutation_epoch,
  }) || payload.command_receipt.command_digest !== idempotencyCommandDigest(command)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      "review target refresh event receipt is not bound to its payload",
    );
  }
}

function validateReviewTargetEventIdentity(event, body, kind) {
  const expectedSubjectId = body?.review_id;
  const expectedFingerprint = body?.candidate_fingerprint;
  const expectedLifecycleGeneration = body?.lifecycle_generation;
  if (!hasCompleteMutationEpochPair(event) ||
      body?.schema !== "flow.review-record/v1" ||
      event.subject_id !== expectedSubjectId ||
      event.prior_candidate_fingerprint !== expectedFingerprint ||
      event.prior_lifecycle_generation !== expectedLifecycleGeneration) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      `review target ${kind} event identity is inconsistent`,
    );
  }
  const priorMutationEpoch = body.candidate?.workspace?.mutation_epoch;
  const hasMutationEpoch = event.prior_mutation_epoch !== undefined ||
    event.observed_mutation_epoch !== undefined;
  if (hasMutationEpoch &&
      (!Number.isSafeInteger(event.prior_mutation_epoch) ||
       event.prior_mutation_epoch < 1 ||
       event.prior_mutation_epoch !== priorMutationEpoch ||
       !Number.isSafeInteger(event.observed_mutation_epoch) ||
       event.observed_mutation_epoch < 1)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      `review target ${kind} mutation identity is inconsistent`,
    );
  }
}

function validateReviewTargetObservationForEvent(event, body, kind) {
  const observation = event.observation;
  const expectedCandidateId = body?.candidate?.candidate_id;
  if (reviewTargetObservationShapeIssue(observation) !== null ||
      observation.subject_id !== event.subject_id ||
      observation.candidate_id !== expectedCandidateId ||
      observation.candidate_fingerprint !== event.observed_candidate_fingerprint ||
      observation.lifecycle_generation !== event.observed_lifecycle_generation ||
      (event.observed_mutation_epoch === undefined
        ? observation.mutation_epoch !== undefined
        : observation.mutation_epoch !== event.observed_mutation_epoch)) {
    throw reviewAuthorityIntegrityError(
      "malformed_event",
      `review target ${kind} observation is malformed`,
    );
  }
}

function reviewTargetInvalidationCommandFromEvent(
  invalidation,
  expectedWatermark,
  commandId,
) {
  return {
    schema: "work.review-target-invalidation-command/v1",
    type: "review_target_invalidated",
    contract: "work.review/v1",
    command_id: commandId,
    subject_id: invalidation.subject_id,
    expected_watermark: expectedWatermark,
    prior_candidate_fingerprint: invalidation.prior_candidate_fingerprint,
    prior_lifecycle_generation: invalidation.prior_lifecycle_generation,
    observed_candidate_fingerprint: invalidation.observed_candidate_fingerprint,
    observed_lifecycle_generation: invalidation.observed_lifecycle_generation,
    ...(invalidation.prior_mutation_epoch === undefined ? {} : {
      prior_mutation_epoch: invalidation.prior_mutation_epoch,
    }),
    ...(invalidation.observed_mutation_epoch === undefined ? {} : {
      observed_mutation_epoch: invalidation.observed_mutation_epoch,
    }),
    reason: invalidation.reason,
  };
}

function reviewTargetRefreshCommandFromEvent(refresh, expectedWatermark, commandId) {
  return {
    schema: "work.review-target-refresh-command/v1",
    type: "review_target_refresh",
    contract: "work.review/v1",
    command_id: commandId,
    subject_id: refresh.subject_id,
    expected_watermark: expectedWatermark,
    prior_candidate_fingerprint: refresh.prior_candidate_fingerprint,
    prior_lifecycle_generation: refresh.prior_lifecycle_generation,
    observed_candidate_fingerprint: refresh.observed_candidate_fingerprint,
    observed_lifecycle_generation: refresh.observed_lifecycle_generation,
    ...(refresh.prior_mutation_epoch === undefined ? {} : {
      prior_mutation_epoch: refresh.prior_mutation_epoch,
    }),
    ...(refresh.observed_mutation_epoch === undefined ? {} : {
      observed_mutation_epoch: refresh.observed_mutation_epoch,
    }),
    authority_observation: refresh.observation,
  };
}

function hasExactKeys(value, requiredKeys, optionalKeys = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  return requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    ownKeys.every((key) => typeof key === "string" && allowed.has(key));
}

function validReviewCommandReceipt(receipt, type = undefined, event = undefined) {
  if (!hasExactKeys(receipt, [
    "schema",
    "command_id",
    "command_digest",
  ]) || receipt.schema !== "work.idempotency-receipt/v1" ||
      !nonEmpty(receipt.command_id) || !isDigest(receipt.command_digest)) {
    return false;
  }
  if (type === undefined || event === undefined) return true;
  const command = reviewHumanCommandForEvent(receipt.command_id, type, event);
  return command !== null &&
    idempotencyCommandDigest(command) === receipt.command_digest;
}

function reviewCommandReceiptDigest(receipt) {
  return digest({
    schema: "flow.review-command-receipt-identity/v1",
    command_id: receipt.command_id,
    command_digest: receipt.command_digest,
  });
}

function reviewAcceptedCommandIdentity(command) {
  const commandDigest = idempotencyCommandDigest(command);
  return freezeCanonical({
    schema: REVIEW_ACCEPTED_COMMAND_SCHEMA,
    command_id: command.command_id,
    command_digest: commandDigest,
    action_digest: reviewHumanActionDigest(command),
  });
}

function reviewHumanActionDigest(command) {
  const {
    command_id: _commandId,
    evidence_validation: _evidenceValidation,
    git_observation: _gitObservation,
    human_authority_validation: _humanValidation,
    ...action
  } = command;
  return digest(action);
}

function validReviewAcceptedCommand(identity, type, event, receipt) {
  if (!hasExactKeys(identity, [
    "schema",
    "command_id",
    "command_digest",
    "action_digest",
  ]) || identity.schema !== REVIEW_ACCEPTED_COMMAND_SCHEMA ||
      !nonEmpty(identity.command_id) ||
      !isDigest(identity.command_digest) ||
      !isDigest(identity.action_digest) ||
      identity.command_id !== receipt.command_id ||
      identity.command_digest !== receipt.command_digest) {
    return false;
  }
  const command = reviewHumanCommandForEvent(identity.command_id, type, event);
  return command !== null &&
    idempotencyCommandDigest(command) === identity.command_digest &&
    reviewHumanActionDigest(command) === identity.action_digest;
}

function reviewHumanCommandForEvent(commandId, type, event) {
  const command = {
    schema: REVIEW_HUMAN_COMMAND_SCHEMA,
    type,
    contract: "work.review/v1",
    command_id: commandId,
    subject_id: event.review_id,
    review_id: event.review_id,
    target_fingerprint: event.target_fingerprint,
    candidate_fingerprint: event.target_fingerprint,
    candidate_authority_watermark: event.candidate_authority_watermark,
    lifecycle_generation: event.lifecycle_generation,
    expected_watermark: event.expected_watermark,
    expected_generation: event.expected_generation,
  };
  const nestedKey = {
    review_session_start: "session",
    review_comment: "comment",
    review_disposition: "disposition",
    review_approval: "approval",
    review_supersession: "supersession",
    review_integration: "integration",
  }[type];
  const nested = event[nestedKey];
  if (!isRecord(nested)) return null;
  command.session_id = nested.session_id;
  if (type === "review_session_start") {
    return command;
  }
  if (type === "review_comment") {
    command.comment_id = nested.comment_id;
    command.body = nested.body;
  } else if (type === "review_disposition") {
    if (nested.finding_id !== undefined) command.finding_id = nested.finding_id;
    command.disposition = nested.disposition;
  } else if (type === "review_approval") {
    command.decision = nested.decision;
  } else if (type === "review_supersession") {
    command.replacement = nested.replacement;
  } else if (type === "review_integration") {
    command.evidence = nested.evidence;
  }
  return command;
}

function validReviewSession(session, event) {
  return hasExactKeys(session, [
    "schema",
    "session_id",
    "review_id",
    "target_fingerprint",
    "candidate_authority_watermark",
    "lifecycle_generation",
  ]) && session.schema === REVIEW_SESSION_SCHEMA &&
    nonEmpty(session.session_id) &&
    session.review_id === event.review_id &&
    session.target_fingerprint === event.target_fingerprint &&
    session.candidate_authority_watermark === event.candidate_authority_watermark &&
    session.lifecycle_generation === event.lifecycle_generation;
}

function validReviewComment(comment) {
  return hasExactKeys(comment, [
    "schema",
    "comment_id",
    "session_id",
    "body",
  ]) && comment.schema === "flow.review-comment/v1" &&
    nonEmpty(comment.comment_id) && nonEmpty(comment.session_id) &&
    typeof comment.body === "string" && comment.body.length > 0 &&
    comment.body.length <= 16_384;
}

function validReviewDisposition(disposition) {
  return hasExactKeys(disposition, [
    "schema",
    "session_id",
    "disposition",
  ], ["finding_id"]) &&
    disposition.schema === "flow.review-disposition/v1" &&
    nonEmpty(disposition.session_id) &&
    REVIEW_DISPOSITIONS.includes(disposition.disposition) &&
    (disposition.finding_id === undefined || nonEmpty(disposition.finding_id));
}

function validReviewApproval(approval) {
  return hasExactKeys(approval, [
    "schema",
    "session_id",
    "decision",
  ]) && approval.schema === "flow.review-approval/v1" &&
    nonEmpty(approval.session_id) &&
    ["approve", "revoke"].includes(approval.decision);
}

function validReviewSupersession(supersession) {
  const replacement = supersession?.replacement;
  return hasExactKeys(supersession, [
    "schema",
    "session_id",
    "replacement",
  ]) && supersession.schema === "flow.review-supersession/v1" &&
    nonEmpty(supersession.session_id) &&
    hasExactKeys(replacement, ["candidate_fingerprint", "lifecycle_generation"]) &&
    isDigest(replacement.candidate_fingerprint) &&
    Number.isSafeInteger(replacement.lifecycle_generation) &&
    replacement.lifecycle_generation >= 1;
}

function validReviewIntegration(integration, event) {
  return hasExactKeys(integration, [
    "schema",
    "session_id",
    "evidence",
    "evidence_digest",
  ]) && integration.schema === "flow.review-integration/v1" &&
    nonEmpty(integration.session_id) &&
    validateReviewIntegrationEvidence(integration.evidence, {
      candidateFingerprint: event.target_fingerprint,
      lifecycleGeneration: event.lifecycle_generation,
    }) && isDigest(integration.evidence_digest) &&
    integration.evidence_digest === digest(integration.evidence);
}

function reviewEventWatermarkIdentityForPayload(payload) {
  if (payload?.type === "review_recorded") {
    return reviewRecordWatermarkIdentity(payload.body);
  }
  if (payload?.type === "github_review_recorded") {
    return githubReviewRecordWatermarkIdentity(payload.body);
  }
  if (payload?.type === "review_target_invalidated") return payload.invalidation;
  if (payload?.type === "review_target_refresh_acknowledged") return payload.refresh;
  if (REVIEW_HUMAN_ACTIONS.includes(payload?.type) &&
      isRecord(payload.event)) return payload.event;
  throw reviewAuthorityIntegrityError(
    "unknown_event",
    "review authority event type is unknown",
  );
}

function reviewAuthorityIntegrityError(reason, message) {
  const error = new Error(message);
  error.code = "review_authority_integrity_failure";
  error.reason = reason;
  return error;
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

function materializedReviewCoverage(candidate, role) {
  if (candidate !== undefined && candidate !== null && !isRecord(candidate)) {
    throw reviewValidationError(
      "malformed_review_coverage",
      `${role} coverage must be a canonical record`,
    );
  }
  const status = candidate?.status ?? candidate?.disposition ?? "produced";
  const reason = candidate?.reason ?? candidate?.code ?? null;
  if (!REVIEW_COVERAGE_STATUSES.includes(status) ||
      status !== "produced" && !isSafeReviewReason(reason)) {
    throw reviewValidationError(
      "malformed_review_coverage",
      `${role} coverage must be produced, degraded, or unavailable with a reason`,
    );
  }
  return {
    status,
    reason: status === "produced" ? null : reason,
  };
}

function combineReviewCoverage(delegateCoverage, authorityCoverage, posture) {
  let self = delegateCoverage;
  if (posture === "review_incomplete" && self.status === "produced") {
    self = {
      status: "degraded",
      reason: "delegate_declared_review_incomplete",
    };
  }
  const authority = authorityCoverage ?? { status: "produced", reason: null };
  const status = REVIEW_COVERAGE_RANK[self.status] >=
    REVIEW_COVERAGE_RANK[authority.status]
    ? self.status
    : authority.status;
  const equalRankAuthorityWins = authorityCoverage !== null &&
    REVIEW_COVERAGE_RANK[self.status] === REVIEW_COVERAGE_RANK[authority.status];
  return {
    status,
    reason: status === "produced"
      ? null
      : equalRankAuthorityWins
        ? authority.reason
        : REVIEW_COVERAGE_RANK[self.status] >= REVIEW_COVERAGE_RANK[status]
          ? self.reason
          : authority.reason,
  };
}

function unavailableReviewDelegateResult() {
  return {
    schema: "flow.review-result/v1",
    posture: "review_incomplete",
    findings: [],
    coverage: {
      schema: "flow.review-coverage/v1",
      status: "unavailable",
      reason: "independent_validation_failed",
    },
    evidence: null,
    cap_reasons: [],
  };
}

function surfacedReviewFindingIds(body) {
  return new Set(
    Array.isArray(body?.summary?.findings)
      ? body.summary.findings
        .map(({ finding_id: findingId }) => findingId)
        .filter((findingId) => nonEmpty(findingId))
      : [],
  );
}

function reviewEvidenceFallbackEntry(validation, acceptedDelegate, error) {
  if (!isRecord(validation) ||
      !Array.isArray(validation.invalid_delegate_evidence)) return null;
  const evidenceDigest = safeDigest(acceptedDelegate?.evidence);
  if (evidenceDigest === null) return null;
  const entry = validation.invalid_delegate_evidence.find((candidate) =>
    candidate?.card_id === acceptedDelegate?.card_id &&
    candidate?.evidence_digest === evidenceDigest &&
    candidate?.reason === "independent_validation_failed");
  if (entry === undefined || error?.code === undefined) return null;
  return {
    card_id: acceptedDelegate.card_id,
    evidence_digest: evidenceDigest,
    reason: "independent_validation_failed",
  };
}

function reviewEvidenceValidationIssue(validation, actualEntries) {
  if (actualEntries.length === 0) {
    return validation === undefined
      ? null
      : validReviewEvidenceValidation(validation)
        ? { code: "review_source_evidence_mismatch", reason: "review evidence validation marker is unexpected" }
        : { code: "review_source_evidence_mismatch", reason: "review evidence validation marker is malformed" };
  }
  if (!validReviewEvidenceValidation(validation)) {
    return {
      code: "review_source_evidence_mismatch",
      reason: "malformed review evidence has no authority validation marker",
    };
  }
  const expected = actualEntries
    .map((entry) => `${entry.card_id}:${entry.evidence_digest}:${entry.reason}`)
    .sort();
  const observed = validation.invalid_delegate_evidence
    .map((entry) => `${entry?.card_id}:${entry?.evidence_digest}:${entry?.reason}`)
    .sort();
  if (expected.length !== observed.length ||
      expected.some((entry, index) => entry !== observed[index])) {
    return {
      code: "review_source_evidence_mismatch",
      reason: "review evidence validation marker is not authority-bound",
    };
  }
  return null;
}

function validReviewEvidenceValidation(validation) {
  if (!hasExactKeys(validation, ["invalid_delegate_evidence"]) ||
      !Array.isArray(validation.invalid_delegate_evidence) ||
      validation.invalid_delegate_evidence.length === 0) {
    return false;
  }
  const cardIds = new Set();
  return validation.invalid_delegate_evidence.every((entry) => {
    if (!hasExactKeys(entry, [
      "card_id",
      "evidence_digest",
      "reason",
    ]) ||
        !nonEmpty(entry.card_id) ||
        cardIds.has(entry.card_id) ||
        !isDigest(entry.evidence_digest) ||
        entry.reason !== "independent_validation_failed") {
      return false;
    }
    cardIds.add(entry.card_id);
    return true;
  });
}

function isSafeReviewReason(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= REVIEW_COVERAGE_REASON_MAX_LENGTH &&
    value === value.trim() && !/[\r\n\u2028\u2029`<>]/u.test(value) &&
    !/^ {0,3}(?:#{1,6}(?:\s|$)|[-+*](?:\s|$)|>(?:\s|$)|~{3,}|\d+[.)](?:\s|$))/u.test(value);
}

function safeDigest(value) {
  try {
    return digest(value);
  } catch {
    return null;
  }
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

function isCanonicalValue(value) {
  try {
    digest(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

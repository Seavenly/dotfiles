import { digest, isPlainRecord } from "./canonical.mjs";

// This is the single self-contained validator for the verified candidate that
// crosses from the feature flow into review/v1. Review preparation and the
// Work-domain ReviewAuthority both use this exact shape check. The authority
// seal watermark is intentionally not part of the candidate fingerprint: it
// is a separate projection binding owned by ReviewAuthority.
export function validateReviewCandidate(candidate, subjectId = candidate?.candidate_id) {
  if (!isRecord(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "artifacts,candidate_fingerprint,candidate_id,critique,git,git_retention,schema,verification,workspace" ||
      candidate.schema !== "work.review-candidate/v1" ||
      candidate.candidate_id !== subjectId ||
      !isDigest(candidate.candidate_fingerprint) ||
      !hasExactKeys(candidate.git, ["clean", "commit_sha", "ref", "tree_sha"]) ||
      !validGitFacts(candidate.git) ||
      candidate.git.clean !== true ||
      !hasExactKeys(candidate.workspace, [
        "contract",
        "fingerprint",
        "generation",
        "mutation_epoch",
        "subject_id",
      ]) ||
      candidate.workspace.contract !== "work.workspace/v1" ||
      !nonEmpty(candidate.workspace.subject_id) ||
      !Number.isSafeInteger(candidate.workspace.generation) ||
      candidate.workspace.generation < 1 ||
      !Number.isSafeInteger(candidate.workspace.mutation_epoch) ||
      candidate.workspace.mutation_epoch < 1 ||
      candidate.workspace.fingerprint !== digest({ git: candidate.git }) ||
      !validReviewVerificationReceipt(
        candidate.verification,
        candidate.workspace,
        candidate.git,
      ) ||
      !validReviewCritiqueReceipt(candidate.critique) ||
      !Array.isArray(candidate.artifacts) ||
      candidate.artifacts.length === 0 ||
      candidate.artifacts.some((artifact) =>
        !hasExactKeys(artifact, ["artifact_schema", "digest", "generation"]) ||
        !isDigest(artifact.digest) ||
        !Number.isSafeInteger(artifact.generation) || artifact.generation < 1 ||
        !nonEmpty(artifact.artifact_schema)) ||
      !hasExactKeys(candidate.git_retention, [
        "commit_sha",
        "repository_id",
        "retention_ref",
        "schema",
        "tree_sha",
      ]) ||
      candidate.git_retention.schema !== "flow.git-retention-receipt/v1" ||
      !nonEmpty(candidate.git_retention.repository_id) ||
      candidate.git_retention.commit_sha !== candidate.git.commit_sha ||
      candidate.git_retention.tree_sha !== candidate.git.tree_sha ||
      !nonEmpty(candidate.git_retention.retention_ref)) {
    return false;
  }
  const { candidate_fingerprint: _fingerprint, ...identity } = candidate;
  return digest(identity) === candidate.candidate_fingerprint;
}

// Compatibility name used by the existing Work-domain authority call sites.
export function validReviewCandidate(subjectId, candidate) {
  return validateReviewCandidate(candidate, subjectId);
}

function validReviewVerificationReceipt(receipt, candidateWorkspace, candidateGit) {
  const identity = stripReceiptDigests(receipt);
  if (!hasExactKeys(receipt, [
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
  ]) ||
      receipt.schema !== "work.feature-verification-receipt/v1" ||
      !nonEmpty(receipt.brief_id) ||
      !nonEmpty(receipt.effect_id) ||
      !nonEmpty(receipt.attempt_id) ||
      !nonEmpty(receipt.idempotency_key) ||
      !nonEmpty(receipt.operation_contract) ||
      !isDigest(receipt.source_authority_watermark) ||
      !isDigest(receipt.selected_evidence_fingerprint) ||
      !Array.isArray(receipt.acceptance_criteria) ||
      receipt.acceptance_criteria.length === 0 ||
      receipt.acceptance_criteria.some((criterion) =>
        !hasExactKeys(criterion, ["criterion", "evidence_digest", "verdict"]) ||
        !nonEmpty(criterion.criterion) ||
        !isDigest(criterion.evidence_digest) ||
        criterion.verdict !== "passed") ||
      !hasExactKeys(receipt.workspace, [
        "fingerprint",
        "generation",
        "git",
        "mutation_epoch",
        "subject_id",
      ]) ||
      receipt.workspace.subject_id !== candidateWorkspace.subject_id ||
      !Number.isSafeInteger(receipt.workspace.generation) ||
      receipt.workspace.generation < 1 ||
      !Number.isSafeInteger(receipt.workspace.mutation_epoch) ||
      receipt.workspace.mutation_epoch < 1 ||
      !hasExactKeys(receipt.workspace.git, ["clean", "commit_sha", "ref", "tree_sha"]) ||
      !validGitFacts(receipt.workspace.git) ||
      receipt.workspace.git.clean !== true ||
      !sameCanonicalValue(receipt.workspace.git, candidateGit) ||
      receipt.workspace.fingerprint !== digest({ git: receipt.workspace.git }) ||
      !validReviewDiscriminatingEvidence(
        receipt.discriminating_evidence,
        receipt.selected_evidence_fingerprint,
        receipt.workspace.fingerprint,
      ) ||
      !isDigest(receipt.receipt_digest) ||
      !isDigest(receipt.self_digest) ||
      digest(identity) !== receipt.receipt_digest ||
      receipt.receipt_digest !== receipt.self_digest) {
    return false;
  }
  return true;
}

function validReviewDiscriminatingEvidence(
  evidence,
  selectedFingerprint,
  postMutationFingerprint,
) {
  if (evidence?.kind === "safe_baseline") {
    return hasExactKeys(evidence, [
      "distinguished",
      "kind",
      "post_mutation_fingerprint",
      "schema",
      "selected_fingerprint",
    ]) && evidence.schema === "flow.feature-discriminating-evidence/v1" &&
      evidence.selected_fingerprint === selectedFingerprint &&
      evidence.post_mutation_fingerprint === postMutationFingerprint &&
      evidence.selected_fingerprint !== evidence.post_mutation_fingerprint &&
      evidence.distinguished === true;
  }
  return hasExactKeys(evidence, [
    "assertion_receipt_digest",
    "kind",
    "non_destructive",
    "post_mutation_fingerprint",
    "satisfied",
    "schema",
    "selected_fingerprint",
  ]) && evidence.schema === "flow.feature-discriminating-evidence/v1" &&
    evidence.kind === "compensating_assertion" &&
    evidence.selected_fingerprint === selectedFingerprint &&
    evidence.post_mutation_fingerprint === postMutationFingerprint &&
    isDigest(evidence.assertion_receipt_digest) &&
    evidence.non_destructive === true && evidence.satisfied === true;
}

function validReviewCritiqueReceipt(receipt) {
  const identity = stripReceiptDigests(receipt);
  return hasExactKeys(receipt, [
    "delegate_evidence",
    "effect_id",
    "findings",
    "idempotency_key",
    "operation_contract",
    "receipt_digest",
    "schema",
    "self_digest",
    "source_authority_watermark",
  ]) && receipt.schema === "work.feature-critique-receipt/v1" &&
    nonEmpty(receipt.effect_id) &&
    nonEmpty(receipt.idempotency_key) &&
    nonEmpty(receipt.operation_contract) &&
    isDigest(receipt.source_authority_watermark) &&
    hasExactKeys(receipt.delegate_evidence, [
      "attempt_id",
      "card_id",
      "effect_id",
      "evidence",
      "idempotency_key",
      "source_authority_watermark",
    ]) &&
    nonEmpty(receipt.delegate_evidence.card_id) &&
    nonEmpty(receipt.delegate_evidence.effect_id) &&
    nonEmpty(receipt.delegate_evidence.attempt_id) &&
    nonEmpty(receipt.delegate_evidence.idempotency_key) &&
    isDigest(receipt.delegate_evidence.source_authority_watermark) &&
    receipt.delegate_evidence.evidence !== undefined &&
    Array.isArray(receipt.findings) &&
    receipt.findings.every((finding) => isRecord(finding) &&
      finding.classification !== "blocking") &&
    isDigest(receipt.receipt_digest) &&
    isDigest(receipt.self_digest) &&
    digest(identity) === receipt.receipt_digest &&
    receipt.receipt_digest === receipt.self_digest;
}

function validGitFacts(git) {
  return /^[0-9a-f]{40,64}$/u.test(git?.commit_sha ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(git?.tree_sha ?? "") &&
    nonEmpty(git?.ref) && typeof git.clean === "boolean";
}

function stripReceiptDigests(receipt) {
  if (!isRecord(receipt)) return null;
  const {
    receipt_digest: _receiptDigest,
    self_digest: _selfDigest,
    ...identity
  } = receipt;
  return identity;
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join(",") ===
    [...keys].sort().join(",");
}

function sameCanonicalValue(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function isRecord(value) {
  return isPlainRecord(value);
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

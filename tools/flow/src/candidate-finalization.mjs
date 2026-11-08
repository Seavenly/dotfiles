import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";

export const FEATURE_FINALIZATION_BINDING_SCHEMA =
  "flow.feature-finalization-binding/v1";
export const FEATURE_CANDIDATE_VIEW_SCHEMA =
  "flow.feature-candidate-view/v1";
export const FEATURE_PUBLICATION_SCHEMA =
  "flow.resource-handoff-publication/v1";

export function featureCandidateViewFromCapture(captureBinding) {
  const capture = captureBinding?.content;
  const resolvedCandidateId = isPlainRecord(captureBinding) &&
      isDigest(captureBinding.result_identity)
    ? `candidate:${captureBinding.result_identity.slice("sha256:".length)}`
    : null;
  if (!isPlainRecord(capture) ||
      capture.schema !== "work.feature-capture-receipt/v1" ||
      !isPlainRecord(capture.workspace) || !isPlainRecord(capture.git) ||
      !Array.isArray(capture.artifacts) || capture.artifacts.length === 0 ||
      !nonEmpty(resolvedCandidateId) ||
      !isDigest(captureBinding?.binding_digest) ||
      !isDigest(captureBinding?.content_digest) ||
      !isDigest(captureBinding?.result_identity) ||
      !capture.artifacts.every(validCaptureArtifact)) {
    return null;
  }
  return freezeCanonical({
    schema: FEATURE_CANDIDATE_VIEW_SCHEMA,
    candidate_id: resolvedCandidateId,
    capture_binding_digest: captureBinding.binding_digest,
    capture_content_digest: captureBinding.content_digest,
    capture_result_identity: captureBinding.result_identity,
    git: capture.git,
    workspace: {
      contract: "work.workspace/v1",
      subject_id: capture.workspace.subject_id,
      generation: capture.workspace.generation,
      mutation_epoch: capture.workspace.mutation_epoch,
      fingerprint: capture.workspace.fingerprint,
    },
    artifacts: capture.artifacts.map((artifact) => ({
      artifact_schema: artifact.artifact_schema,
      digest: artifact.digest,
      generation: 1,
    })),
  });
}

/**
 * Derive the seal inputs from one authority-owned capture record.  The
 * selected finalization is only a policy template; workspace, Git, artifact,
 * and candidate identities come from the settled capture content.
 */
export function deriveFeatureFinalization({
  captureBinding,
  capturePolicy,
  selectedWorkspace,
  legacyFinalization,
} = {}) {
  const capture = captureBinding?.content;
  if (!isPlainRecord(capture) ||
      capture.schema !== "work.feature-capture-receipt/v1" ||
      !isPlainRecord(capture.workspace) ||
      !isPlainRecord(capture.git) ||
      !Array.isArray(capture.artifacts) || capture.artifacts.length === 0) {
    return derivationFailure("feature_finalization_capture_invalid");
  }
  const policy = isPlainRecord(capturePolicy) ? capturePolicy : {};
  const selected = isPlainRecord(selectedWorkspace) ? selectedWorkspace : {};
  const legacyPublication = isPlainRecord(legacyFinalization?.publication)
    ? legacyFinalization.publication
    : null;
  const expectedGit = selected.git ??
    policy.starting_git ?? legacyPublication?.workspace?.expected_git;
  if (!validGit(expectedGit) || expectedGit.clean !== true) {
    return derivationFailure("feature_finalization_start_git_missing");
  }
  if (selected.subject_id !== capture.workspace.subject_id ||
      (selected.generation !== policy.starting_workspace?.generation &&
        policy.starting_workspace?.generation !== undefined) ||
      (selected.mutation_epoch !== policy.starting_workspace?.mutation_epoch &&
        policy.starting_workspace?.mutation_epoch !== undefined) ||
      digest({ git: expectedGit }) !== selected.fingerprint ||
      digest({ git: expectedGit }) === digest({ git: capture.git }) ||
      capture.git.clean !== true ||
      capture.workspace.fingerprint !== digest({ git: capture.git }) ||
      capture.workspace.generation <= selected.generation ||
      capture.workspace.mutation_epoch <= selected.mutation_epoch) {
    return derivationFailure("feature_finalization_capture_stale");
  }
  if (legacyPublication !== null &&
      (!isDeepEqual(legacyPublication.workspace?.promoted_git, capture.git) ||
       legacyPublication.workspace?.promoted_generation !==
         capture.workspace.generation ||
       legacyPublication.workspace?.promoted_mutation_epoch !==
         capture.workspace.mutation_epoch ||
       !Array.isArray(legacyPublication.artifacts) ||
       legacyPublication.artifacts.length !== capture.artifacts.length ||
       legacyPublication.artifacts.some((artifact, index) =>
         artifact?.digest !== capture.artifacts[index]?.digest))) {
    return derivationFailure("feature_finalization_capture_mismatch");
  }
  const publicationPolicy = isPlainRecord(policy.publication_policy)
    ? policy.publication_policy
    : {};
  const publication = {
    schema: FEATURE_PUBLICATION_SCHEMA,
    workspace: {
      subject_id: capture.workspace.subject_id,
      expected_generation: selected.generation,
      expected_mutation_epoch: selected.mutation_epoch,
      expected_git: expectedGit,
      promoted_generation: capture.workspace.generation,
      promoted_mutation_epoch: capture.workspace.mutation_epoch,
      promoted_git: capture.git,
      disposition: policy.disposition ??
        legacyPublication?.workspace?.disposition ?? "retained_for_handoff",
    },
    artifacts: capture.artifacts.map(({ digest: artifactDigest }) => ({
      digest: artifactDigest,
      expected_generation: 1,
    })),
    subject: publicationPolicy.subject ?? legacyPublication?.subject ?? {
      contract: "work.workspace/v1",
      subject_id: capture.workspace.subject_id,
    },
    allowed_consumer_operations:
      publicationPolicy.allowed_consumer_operations ??
      legacyPublication?.allowed_consumer_operations ?? ["read_workspace"],
    consumer_operation_authority:
      publicationPolicy.consumer_operation_authority ??
      legacyPublication?.consumer_operation_authority ?? [{
        operation: "read_workspace",
        access: "read_only",
      }],
    authority_envelope: publicationPolicy.authority_envelope ??
      legacyPublication?.authority_envelope ?? { capabilities: ["repository:read"] },
    retention: policy.retention ?? legacyPublication?.retention ?? "local_candidate",
    cleanup_obligations: publicationPolicy.cleanup_obligations ??
      legacyPublication?.cleanup_obligations ?? ["retain_artifact_bytes"],
    intended_consumer: publicationPolicy.intended_consumer ??
      legacyPublication?.intended_consumer ?? null,
  };
  const candidateId = `candidate:${captureBinding.result_identity.slice("sha256:".length)}`;
  if (!nonEmpty(candidateId) ||
      !validPublicationPolicy(publication) ||
      !capture.artifacts.every(validCaptureArtifact)) {
    return derivationFailure("feature_finalization_policy_invalid");
  }
  const finalization = freezeCanonical({
    schema: FEATURE_FINALIZATION_BINDING_SCHEMA,
    candidate_id: candidateId,
    publication,
  });
  const candidate = featureCandidateViewFromCapture(captureBinding);
  if (candidate === null) return derivationFailure("feature_candidate_capture_invalid");
  return Object.freeze({
    finalization,
    publication: finalization.publication,
    candidate,
    finalization_digest: digest(finalization),
  });
}

function validPublicationPolicy(publication) {
  return isPlainRecord(publication.subject) &&
    publication.subject.contract === "work.workspace/v1" &&
    publication.subject.subject_id === publication.workspace.subject_id &&
    Array.isArray(publication.allowed_consumer_operations) &&
    publication.allowed_consumer_operations.length > 0 &&
    Array.isArray(publication.consumer_operation_authority) &&
    publication.consumer_operation_authority.length ===
      publication.allowed_consumer_operations.length &&
    isPlainRecord(publication.authority_envelope) &&
    nonEmpty(publication.retention) &&
    Array.isArray(publication.cleanup_obligations) &&
    (publication.intended_consumer === null ||
      typeof publication.intended_consumer === "string");
}

function isDeepEqual(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function validCaptureArtifact(artifact) {
  return isPlainRecord(artifact) && nonEmpty(artifact.artifact_schema) &&
    isDigest(artifact.digest) && Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0;
}

function validGit(git) {
  return isPlainRecord(git) &&
    /^[0-9a-f]{40,64}$/u.test(git.commit_sha ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(git.tree_sha ?? "") &&
    nonEmpty(git.ref) && typeof git.clean === "boolean";
}

function derivationFailure(code) {
  return { code };
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  digest,
  freezeCanonical,
} from "../../../tools/flow/src/canonical.mjs";
import {
  createFeatureCaptureOperation,
  AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
  FEATURE_CAPTURE_RECEIPT_VALIDATOR,
  FEATURE_CRITERION_EVIDENCE_SCHEMA,
  FEATURE_CRITIQUE_OUTPUT_SCHEMA,
  FEATURE_OPERATION_CONTRACTS,
  FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
  validateFeatureCaptureReceipt,
  validateFeatureVerificationReceipt,
} from "../../../tools/flow/src/feature-flow.mjs";
import {
  getArtifactAuthority,
  getWorkspaceAuthority,
} from "../../../tools/flow/src/work-authority.mjs";
import { createRejection } from "../../../tools/flow/src/rejection.mjs";

export {
  AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA,
  FEATURE_CRITIQUE_OUTPUT_SCHEMA,
};

const CAPTURE_ARTIFACT_SCHEMA = "flow.feature-candidate-archive/v1";
const CAPTURE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const CAPTURE_ARCHIVE_TIMEOUT_MS = 30_000;
const FEATURE_CRITIQUE_MAX_BYTES = 128 * 1024;
const FEATURE_CRITIQUE_MAX_FINDINGS = 64;
const FEATURE_CRITIQUE_MAX_SUMMARY_BYTES = 4 * 1024;
const FEATURE_CRITIQUE_MAX_DETAIL_BYTES = 8 * 1024;

/**
 * Build the host-owned feature operation registrations.  This module only
 * adapts admitted intents to Git and Work-domain mechanisms.  Lifecycle and
 * publication policy remain owned by RunAuthority.
 */
export function createProductionFeatureOperations({
  resolveWorkspace,
  gitWorkspaceObservationAdapter,
  gitRetentionAdapter,
} = {}) {
  if (typeof resolveWorkspace !== "function") {
    throw new TypeError("production feature operations require workspace resolution");
  }
  if (typeof gitWorkspaceObservationAdapter?.observe !== "function") {
    throw new TypeError("production feature operations require Git observation");
  }
  if (typeof gitRetentionAdapter?.retain !== "function") {
    throw new TypeError("production feature operations require Git retention");
  }

  let runAuthority = null;
  const authorityRef = {
    get value() {
      if (runAuthority === null) {
        throw new TypeError("production feature operations are not authority-bound");
      }
      return runAuthority;
    },
  };

  const captureImplementation = createFeatureCaptureOperation({
    observe(intent) {
      return observeCapture({
        intent,
        resolveWorkspace,
        gitWorkspaceObservationAdapter,
      });
    },
    storeArtifacts({ intent, artifacts }) {
      return storeCaptureArtifacts({
        intent,
        artifacts,
        artifactAuthority: getArtifactAuthority({
          runAuthority: authorityRef.value,
        }),
      });
    },
  });
  const capture = Object.freeze({
    ...captureImplementation,
    // The generic capture operation keeps an in-memory receipt cache and an
    // async reconciliation hook. Production recovery must instead consult
    // durable Git and ArtifactAuthority synchronously before admitting a
    // rebooted effect.
    observe(intent) {
      return observeDurableCapture({
        intent,
        resolveWorkspace,
        gitWorkspaceObservationAdapter,
        artifactAuthority: getArtifactAuthority({
          runAuthority: authorityRef.value,
        }),
      });
    },
    reconcile(intent) {
      return observeDurableCapture({
        intent,
        resolveWorkspace,
        gitWorkspaceObservationAdapter,
        artifactAuthority: getArtifactAuthority({
          runAuthority: authorityRef.value,
        }),
      });
    },
  });

  const operations = {
    [FEATURE_OPERATION_CONTRACTS.setup]: unavailableOperation(
      FEATURE_OPERATION_CONTRACTS.setup,
    ),
    [FEATURE_OPERATION_CONTRACTS.test]: unavailableOperation(
      FEATURE_OPERATION_CONTRACTS.test,
    ),
    [FEATURE_OPERATION_CONTRACTS.capture]: capture,
    [FEATURE_OPERATION_CONTRACTS.verify]: createVerificationOperation({
      resolveWorkspace,
      gitWorkspaceObservationAdapter,
    }),
    [FEATURE_OPERATION_CONTRACTS.seal]: createSealOperation({
      resolveWorkspace,
      gitRetentionAdapter,
    }),
  };

  return Object.freeze({
    operations: Object.freeze(operations),
    bindAuthority(authority) {
      if (runAuthority !== null && runAuthority !== authority) {
        throw new TypeError("production feature operations already have an authority");
      }
      runAuthority = authority;
    },
  });
}

/**
 * Register and claim the selected workspace before RunAuthority admits a
 * feature run.  The returned rollback is used when the later lifecycle launch
 * validation rejects, so an unsuccessful launch cannot strand a claim.
 */
export function prepareProductionFeatureLaunch({
  request,
  runAuthority,
  workspaceRepositories,
  resolveWorkspace,
  gitWorkspaceObservationAdapter,
  operations,
} = {}) {
  const prepared = request?.prepared;
  if (prepared?.kind !== "predefined" ||
      prepared.definition?.id !== "feature/v1") {
    return null;
  }
  const runId = derivedRunId(prepared);
  const existing = safeRunQuery(runAuthority, runId);
  if (existing?.schema === "flow.run-projection/v1") return null;

  const missingOperation = prepared.graph?.cards?.find((card) =>
    card.executor?.kind === "operation" &&
    (!registeredOperation(operations, card.executor.contract) ||
      typeof registeredOperation(operations, card.executor.contract).invoke !==
        "function"));
  if (missingOperation !== undefined) {
    return launchRejection({
      request,
      code: "production_operation_unavailable",
      reason: missingOperation.executor.contract,
      runAuthority,
    });
  }

  const inputs = prepared.selection?.inputs;
  const selectedWorkspace = inputs?.workspace;
  const repository = workspaceRepositories?.get(selectedWorkspace?.subject_id) ??
    resolveWorkspace?.(selectedWorkspace?.subject_id);
  if (!isRecord(selectedWorkspace) || repository === undefined) {
    return launchRejection({
      request,
      code: "feature_workspace_unavailable",
      reason: "prepared feature workspace is not registered by production preparation",
      runAuthority,
    });
  }
  const startingGit = selectedWorkspace.git;
  let gitObservation;
  try {
    gitObservation = observeGit({
      workspace: repository,
      gitWorkspaceObservationAdapter,
    });
  } catch (error) {
    return launchRejection({
      request,
      code: "workspace_git_observation_unavailable",
      reason: error?.message ?? "starting workspace Git observation failed",
      runAuthority,
    });
  }
  if (digest({ git: gitObservation }) !== digest({ git: startingGit }) ||
      gitObservation.clean !== true) {
    return launchRejection({
      request,
      code: "workspace_fingerprint_changed",
      reason: "starting workspace Git facts no longer match the prepared run",
      runAuthority,
    });
  }

  let workspaceAuthority;
  try {
    workspaceAuthority = runAuthority === null || runAuthority === undefined
      ? null
      : getWorkspaceAuthority({ runAuthority });
  } catch (error) {
    return launchRejection({
      request,
      code: "durable_work_authority_required",
      reason: error?.message ?? "WorkspaceAuthority is unavailable",
      runAuthority,
    });
  }
  const subjectId = selectedWorkspace.subject_id;
  const query = { contract: "work.workspace/v1", subject_id: subjectId };
  let projection = workspaceAuthority.query(query);
  if (projection?.schema === "work.rejection/v1" &&
      projection.code !== "unknown_subject") {
    return launchRejection({
      request,
      code: projection.code ?? "workspace_registration_unavailable",
      reason: "WorkspaceAuthority rejected the workspace projection query",
      runAuthority,
    });
  }
  if (projection?.schema !== "work.workspace-projection/v1") {
    const registrationCommand = {
      schema: "work.workspace-register-command/v1",
      command_id: `workspace-register:${subjectId}`,
      type: "workspace_register",
      contract: "work.workspace/v1",
      subject_id: subjectId,
      expected_generation: 0,
      registration: {
        repository: { canonical_id: repository.repository_id },
        workspace: {
          canonical_id: subjectId,
          canonical_path: repository.path,
        },
        git: startingGit,
        mutation_epoch: selectedWorkspace.mutation_epoch,
        disposition: "producer_owned",
      },
      git_observation: {
        schema: "work.git-observation/v1",
        git: startingGit,
      },
    };
    const registrationReceipt = workspaceAuthority.command(registrationCommand);
    if (registrationReceipt?.accepted !== true) {
      return launchRejection({
        request,
        code: registrationReceipt?.code ?? "workspace_registration_rejected",
        reason: "WorkspaceAuthority rejected workspace registration",
        runAuthority,
      });
    }
    projection = workspaceAuthority.query(query);
  }
  if (!matchingStartingWorkspace(
    projection,
    subjectId,
    repository,
    selectedWorkspace,
    startingGit,
  )) {
    return launchRejection({
      request,
      code: "workspace_registration_conflict",
      reason: "registered workspace does not match the prepared Git fence",
      runAuthority,
    });
  }

  const operationsForClaim = workspaceClaimOperations(prepared, subjectId);
  const claim = {
    claim_id: `claim:${runId}`,
    holder: runId,
    operations: operationsForClaim,
  };
  const existingClaim = projection.claims?.[0];
  let claimPrepared = false;
  if (existingClaim !== undefined) {
    if (!sameCanonicalValue(existingClaim, claim)) {
      return launchRejection({
        request,
        code: "workspace_already_claimed",
        reason: "workspace is already claimed by another run",
        runAuthority,
      });
    }
    claimPrepared = true;
  } else {
    const claimReceipt = workspaceAuthority.command({
      schema: "work.workspace-claim-command/v1",
      command_id: `workspace-claim:${runId}`,
      type: "workspace_claim",
      contract: "work.workspace/v1",
      subject_id: subjectId,
      expected_generation: projection.generation,
      expected_watermark: projection.watermark,
      expected_fingerprint: digest({ git: startingGit }),
      git_observation: {
        schema: "work.git-observation/v1",
        git: startingGit,
      },
      claim,
    });
    if (claimReceipt?.accepted !== true) {
      return launchRejection({
        request,
        code: claimReceipt?.code ?? "workspace_claim_rejected",
        reason: "WorkspaceAuthority rejected the production workspace claim",
        runAuthority,
      });
    }
    claimPrepared = true;
  }

  let rolledBack = false;
  return {
    accepted: true,
    rollback() {
      if (rolledBack || !claimPrepared) return;
      rolledBack = true;
      const current = workspaceAuthority.query(query);
      if (current?.schema !== "work.workspace-projection/v1" ||
          !sameCanonicalValue(current.claims?.[0], claim)) return;
      workspaceAuthority.command({
        schema: "work.workspace-claim-release-command/v1",
        command_id: `workspace-claim-release:${runId}`,
        type: "workspace_claim_release",
        contract: "work.workspace/v1",
        subject_id: subjectId,
        expected_watermark: current.watermark,
        claim_id: claim.claim_id,
        holder: claim.holder,
      });
      // A registration is intentionally retained. It is factual durable
      // state, unlike a claim, and makes the next identical launch replayable.
    },
  };
}

function derivedRunId(prepared) {
  const bundleDigest = prepared?.bundle_digest;
  if (typeof bundleDigest !== "string" ||
      !bundleDigest.startsWith("sha256:")) return null;
  return `run:${bundleDigest.slice("sha256:".length)}`;
}

function safeRunQuery(runAuthority, runId) {
  if (runId === null || typeof runAuthority?.query !== "function") return null;
  try {
    return runAuthority.query(runId);
  } catch {
    return null;
  }
}

function launchRejection({ request, code, reason, runAuthority }) {
  let host = null;
  try {
    host = runAuthority?.query?.();
  } catch {
    // The rejection remains fail closed even if the host projection is also
    // unavailable.
  }
  return createRejection({
    operation: "launch",
    code,
    reason,
    bundleDigest: request?.prepared?.bundle_digest ?? null,
    authorityWatermark: host?.watermark ?? null,
    authorityWatermarkDomain: "host",
  });
}

function registeredOperation(operations, contract) {
  if (operations instanceof Map) return operations.get(contract);
  return operations?.[contract];
}

function matchingStartingWorkspace(
  projection,
  subjectId,
  repository,
  selectedWorkspace,
  startingGit,
) {
  return projection?.schema === "work.workspace-projection/v1" &&
    projection.contract === "work.workspace/v1" &&
    projection.subject_id === subjectId &&
    projection.generation === selectedWorkspace.generation &&
    projection.mutation_epoch === selectedWorkspace.mutation_epoch &&
    projection.repository?.canonical_id === repository.repository_id &&
    projection.workspace?.canonical_id === subjectId &&
    projection.workspace?.canonical_path === repository.path &&
    sameCanonicalValue(projection.git, startingGit) &&
    projection.disposition !== "cleaned";
}

function workspaceClaimOperations(prepared, subjectId) {
  const cards = prepared?.graph?.cards ?? [];
  const operationIds = cards
    .filter((card) => card.resource_claims?.some((claim) =>
      claim.kind === "workspace" && claim.id === subjectId))
    .map((card) => card.id)
    .filter((cardId, index, all) => all.indexOf(cardId) === index);
  if (!operationIds.includes("handoff_publication")) {
    operationIds.push("handoff_publication");
  }
  return operationIds;
}

function sameCanonicalValue(left, right) {
  try {
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function unavailableOperation(contract) {
  return Object.freeze({
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    invoke() {
      const error = new TypeError(
        `production operation is not implemented: ${contract}`,
      );
      error.code = "production_operation_unavailable";
      throw error;
    },
  });
}

function observeCapture({
  intent,
  resolveWorkspace,
  gitWorkspaceObservationAdapter,
}) {
  const workspace = resolveIntentWorkspace(intent, resolveWorkspace);
  const startingWorkspace = intent.operation_input?.workspace;
  const git = observeGit({
    workspace,
    gitWorkspaceObservationAdapter,
  });
  if (git.clean !== true) {
    throw featureOperationError(
      "feature_capture_workspace_dirty",
      "feature capture requires a clean post-mutation workspace",
    );
  }
  const bytes = archiveGit(workspace.path, git.commit_sha);
  const descriptor = {
    artifact_schema: CAPTURE_ARTIFACT_SCHEMA,
    bytes_digest: bytesDigest(bytes),
    digest: bytesDigest(bytes),
    size: bytes.length,
  };
  const receipt = createCaptureReceipt({
    intent,
    startingWorkspace,
    git,
    descriptor,
  });
  return {
    receipt,
    artifacts: [{
      artifact_schema: CAPTURE_ARTIFACT_SCHEMA,
      bytes,
    }],
  };
}

function createCaptureReceipt({ intent, startingWorkspace, git, descriptor }) {
  const receiptIdentity = {
    schema: "work.feature-capture-receipt/v1",
    operation_contract: FEATURE_OPERATION_CONTRACTS.capture,
    outcome: "captured",
    effect_id: intent.effect_id,
    attempt_id: intent.attempt_id,
    idempotency_key: intent.idempotency_key,
    source_authority_watermark: intent.source_authority_watermark,
    git,
    workspace: {
      subject_id: startingWorkspace.subject_id,
      generation: startingWorkspace.generation + 1,
      mutation_epoch: startingWorkspace.mutation_epoch + 1,
      fingerprint: digest({ git }),
      git,
    },
    artifacts: [descriptor],
  };
  const receiptDigest = digest(receiptIdentity);
  const receipt = freezeCanonical({
    ...receiptIdentity,
    receipt_digest: receiptDigest,
    self_digest: receiptDigest,
  });
  if (validateFeatureCaptureReceipt(receipt, intent) !== true) {
    throw featureOperationError(
      "feature_capture_receipt_invalid",
      "feature capture receipt failed its strict provider contract",
    );
  }
  return receipt;
}

function observeDurableCapture({
  intent,
  resolveWorkspace,
  gitWorkspaceObservationAdapter,
  artifactAuthority,
}) {
  try {
    const startingWorkspace = intent?.operation_input?.workspace;
    if (!isRecord(startingWorkspace) ||
        typeof startingWorkspace.subject_id !== "string" ||
        typeof startingWorkspace.fingerprint !== "string") {
      return unavailableCaptureObservation(intent, "capture_starting_workspace_invalid");
    }
    const workspace = resolveIntentWorkspace(intent, resolveWorkspace);
    const git = observeGit({
      workspace,
      gitWorkspaceObservationAdapter,
    });
    if (git.clean !== true ||
        digest({ git }) === digest({ git: startingWorkspace.git })) {
      return unavailableCaptureObservation(intent, "capture_git_fence_unproven");
    }
    const bytes = archiveGit(workspace.path, git.commit_sha);
    const descriptor = {
      artifact_schema: CAPTURE_ARTIFACT_SCHEMA,
      bytes_digest: bytesDigest(bytes),
      digest: bytesDigest(bytes),
      size: bytes.length,
    };
    const projection = artifactAuthority?.query?.({
      contract: "work.artifact/v1",
      subject_id: descriptor.digest,
    });
    if (projection?.schema === "work.rejection/v1" &&
        projection.code === "unknown_subject") {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: {
          schema: "flow.provider-observation/v1",
          found: false,
          proof: "artifact_authority_exact_absence",
        },
      };
    }
    if (!durableCaptureArtifactMatches(projection, descriptor, intent)) {
      return unavailableCaptureObservation(
        intent,
        "capture_artifact_authority_proof_unavailable",
      );
    }
    const receipt = createCaptureReceipt({
      intent,
      startingWorkspace,
      git,
      descriptor,
    });
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
  } catch (error) {
    return unavailableCaptureObservation(
      intent,
      typeof error?.code === "string" ? error.code : "capture_probe_failed",
    );
  }
}

function durableCaptureArtifactMatches(projection, descriptor, intent) {
  return projection?.schema === "work.artifact-projection/v1" &&
    projection.contract === "work.artifact/v1" &&
    projection.subject_id === descriptor.digest &&
    projection.digest === descriptor.digest &&
    projection.artifact_schema === descriptor.artifact_schema &&
    projection.size === descriptor.size &&
    projection.byte_availability === "available" &&
    projection.status === "retained" &&
    projection.provenance?.producer?.run_id === intent.run_id &&
    projection.pins?.some((pin) =>
      pin?.holder === "run" && pin.id === intent.run_id);
}

function unavailableCaptureObservation(intent, reason) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent?.effect_id,
    idempotency_key: intent?.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: {
      schema: "flow.provider-observation/v1",
      status: "unavailable",
      reason: safeObservationReason(reason),
    },
  };
}

function safeObservationReason(value) {
  return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/u.test(value)
    ? value
    : "capture_probe_failed";
}

function storeCaptureArtifacts({ intent, artifacts, artifactAuthority }) {
  const retention = intent.operation_input?.capture_policy?.retention ??
    "local_candidate";
  for (const artifact of artifacts) {
    const evidence = digest({
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      artifact: artifact.digest,
    });
    const command = {
      schema: "work.artifact-record-command/v1",
      command_id: `artifact-record:${artifact.digest}`,
      type: "artifact_record",
      contract: "work.artifact/v1",
      subject_id: artifact.digest,
      expected_generation: 0,
      artifact: {
        digest: artifact.digest,
        artifact_schema: artifact.artifact_schema,
        size: artifact.size,
        provenance: {
          producer: {
            run_id: intent.run_id,
            evidence,
          },
          validator: {
            contract: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
            receipt: evidence,
          },
        },
        classification: "internal",
        retention,
        pins: [{ holder: "run", id: intent.run_id }],
      },
      bytes_base64: Buffer.from(artifact.bytes).toString("base64"),
    };
    const receipt = artifactAuthority.command(command);
    if (receipt?.accepted !== true) return receipt;
  }
  return { accepted: true };
}

function createVerificationOperation({
  resolveWorkspace,
  gitWorkspaceObservationAdapter,
}) {
  return Object.freeze({
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
    validateReceipt: validateFeatureVerificationReceipt,
    async invoke(intent) {
      const workspace = resolveIntentWorkspace(intent, resolveWorkspace);
      const git = observeGit({
        workspace,
        gitWorkspaceObservationAdapter,
      });
      if (git.clean !== true) {
        throw featureOperationError(
          "feature_verification_workspace_dirty",
          "feature verification requires a clean post-mutation workspace",
        );
      }
      const operationInput = intent.operation_input;
      const startingWorkspace = operationInput.workspace;
      const selectedEvidence = operationInput.verification?.baseline ??
        operationInput.verification?.compensating_assertion;
      if (selectedEvidence === undefined) {
        throw featureOperationError(
          "feature_verification_evidence_missing",
          "feature verification requires a selected baseline or assertion",
        );
      }
      const criterionEvidence = featureCriterionEvidenceFromIntent(intent);
      if (criterionEvidence === null) {
        throw featureOperationError(
          "feature_verification_criterion_evidence_invalid",
          "feature verification requires exact independent criterion evidence",
        );
      }
      const workspaceIdentity = {
        subject_id: startingWorkspace.subject_id,
        generation: startingWorkspace.generation,
        mutation_epoch: startingWorkspace.mutation_epoch,
        fingerprint: digest({ git }),
        git,
      };
      const acceptanceCriteria = criterionEvidence.criteria.map((evidence) => {
        assertCriterionEvidenceMatchesGit(workspace, git, evidence);
        return {
          criterion: evidence.criterion,
          evidence_digest: digest({
            brief_id: operationInput.brief.id,
            criterion: evidence.criterion,
            evidence: {
              kind: evidence.kind,
              target: evidence.target,
              expected: evidence.expected,
            },
            observed: {
              commit_sha: git.commit_sha,
              tree_sha: git.tree_sha,
            },
          }),
          verdict: "passed",
        };
      });
      const discriminating = operationInput.verification?.baseline !== undefined
        ? {
            schema: "flow.feature-discriminating-evidence/v1",
            kind: "safe_baseline",
            selected_fingerprint: selectedEvidence.fingerprint,
            post_mutation_fingerprint: workspaceIdentity.fingerprint,
            distinguished: selectedEvidence.fingerprint !==
              workspaceIdentity.fingerprint,
          }
        : {
            schema: "flow.feature-discriminating-evidence/v1",
            kind: "compensating_assertion",
            selected_fingerprint: selectedEvidence.fingerprint,
            post_mutation_fingerprint: workspaceIdentity.fingerprint,
            assertion_receipt_digest: digest({
              assertion: selectedEvidence.assertion,
              post_mutation_fingerprint: workspaceIdentity.fingerprint,
            }),
            non_destructive: selectedEvidence.non_destructive === true,
            satisfied: selectedEvidence.non_destructive === true,
            distinguished: selectedEvidence.fingerprint !==
              workspaceIdentity.fingerprint,
          };
      const identity = {
        acceptance_criteria: acceptanceCriteria,
        attempt_id: intent.attempt_id,
        brief_id: operationInput.brief.id,
        discriminating_evidence: discriminating,
        effect_id: intent.effect_id,
        ...(criterionEvidence.source === "critique" ? {
          independent_critique_digest: criterionEvidence.source_digest,
        } : {}),
        idempotency_key: intent.idempotency_key,
        operation_contract: FEATURE_OPERATION_CONTRACTS.verify,
        selected_evidence_fingerprint: selectedEvidence.fingerprint,
        source_authority_watermark: intent.source_authority_watermark,
        workspace: workspaceIdentity,
        schema: "work.feature-verification-receipt/v1",
      };
      const receiptDigest = digest(identity);
      const providerReceipt = freezeCanonical({
        ...identity,
        receipt_digest: receiptDigest,
        self_digest: receiptDigest,
      });
      if (validateFeatureVerificationReceipt(providerReceipt, intent) !== true) {
        throw featureOperationError(
          "feature_verification_receipt_invalid",
          "feature verification receipt failed its strict provider contract",
        );
      }
      return operationReceipt(intent, providerReceipt);
    },
  });
}

function createSealOperation({ resolveWorkspace, gitRetentionAdapter }) {
  return Object.freeze({
    schema: "flow.registered-operation/v1",
    classification: "caller_idempotent",
    async invoke(intent) {
      const operationInput = intent.operation_input;
      const candidateView = operationInput.authority_materialized_candidate;
      const materialized = operationInput.authority_materialized_evidence;
      const critiqueEvidence = materialized?.accepted_delegates?.find(({ card_id }) =>
        card_id === operationInput.authority_materialized_critique_binding?.card_id);
      const verification = materialized?.operation_receipts?.find(({ receipt }) =>
        receipt?.provider_receipt?.operation_contract ===
          FEATURE_OPERATION_CONTRACTS.verify)?.receipt?.provider_receipt;
      if (candidateView?.schema !== "flow.feature-candidate-view/v1" ||
          critiqueEvidence === undefined || verification === undefined) {
        throw featureOperationError(
          "feature_seal_authority_evidence_missing",
          "feature seal requires authority-materialized candidate, verify, and critique evidence",
        );
      }
      const critiqueOutput = parseCritiqueEvidence(
        critiqueEvidence,
        operationInput.brief?.acceptance,
        operationInput.authority_materialized_critique_input,
      );
      if (critiqueOutput === null ||
          verification.independent_critique_digest !==
            critiqueOutput.digest ||
          critiqueOutput.findings.some(({ classification }) =>
            classification === "blocking") ||
          critiqueOutput.criteria.some(({ verdict }) => verdict !== "passed")) {
        throw featureOperationError(
          "feature_seal_critique_invalid",
          "feature seal requires an exact independent, non-blocking critique",
        );
      }
      const critiqueIdentity = {
        schema: "work.feature-critique-receipt/v1",
        delegate_evidence: critiqueEvidence,
        findings: critiqueOutput.findings,
        operation_contract: intent.operation_contract,
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        source_authority_watermark: intent.source_authority_watermark,
      };
      const critiqueDigest = digest(critiqueIdentity);
      const critique = freezeCanonical({
        ...critiqueIdentity,
        receipt_digest: critiqueDigest,
        self_digest: critiqueDigest,
      });
      const workspace = resolveIntentWorkspace(intent, resolveWorkspace);
      const retention = gitRetentionAdapter.retain({
        repository_id: workspace.repository_id,
        git: candidateView.git,
      });
      const candidateIdentity = {
        schema: "work.review-candidate/v1",
        candidate_id: candidateView.candidate_id,
        git: candidateView.git,
        workspace: candidateView.workspace,
        verification,
        critique,
        artifacts: candidateView.artifacts,
        git_retention: retention,
      };
      const candidate = {
        ...candidateIdentity,
        candidate_fingerprint: digest(candidateIdentity),
      };
      const providerReceipt = freezeCanonical({
        schema: "flow.feature-seal-receipt/v1",
        review_candidate: candidate,
        publication_digest: digest(operationInput.publication),
        git_retention: retention,
      });
      return operationReceipt(intent, providerReceipt);
    },
  });
}

function featureCriterionEvidenceFromIntent(intent) {
  const operationInput = intent?.operation_input;
  const independent = operationInput?.independent_critique === true;
  const accepted = operationInput?.authority_materialized_evidence
    ?.accepted_delegates?.find(({ card_id: cardId }) => cardId ===
      (independent ? "feature-critique" : "feature-apply"));
  const output = accepted?.evidence?.validated_output;
  if (typeof output !== "string") return null;
  if (independent) {
    if (!validCritiqueInputBinding(
      operationInput?.authority_materialized_critique_input,
      accepted.card_id,
    )) return null;
    const critique = validateFeatureCritiqueOutput(output, {
      expectedCriteria: operationInput?.brief?.acceptance,
      candidateDigest: operationInput?.authority_materialized_critique_input
        ?.candidate_digest,
      predecessorEvidenceDigest:
        operationInput?.authority_materialized_critique_input
          ?.predecessor_evidence_digest,
      requireAuthorityBinding: true,
    });
    if (critique === null ||
        critique.criteria.some(({ verdict }) => verdict !== "passed")) {
      return null;
    }
    return {
      criteria: critique.criteria.map(({ criterion, evidence }) => ({
        criterion,
        ...evidence,
      })),
      source: "critique",
      source_digest: digest(critique),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  return validateFeatureCriterionEvidence(
    parsed?.feature_evidence,
    operationInput?.brief?.acceptance,
  );
}

function parseCritiqueEvidence(accepted, expectedCriteria, critiqueInput) {
  const output = accepted?.evidence?.validated_output;
  if (typeof output !== "string") return null;
  if (!validCritiqueInputBinding(critiqueInput, accepted?.card_id)) return null;
  const critique = validateFeatureCritiqueOutput(output, {
    expectedCriteria,
    candidateDigest: critiqueInput?.candidate_digest,
    predecessorEvidenceDigest: critiqueInput?.predecessor_evidence_digest,
    requireAuthorityBinding: true,
  });
  if (critique === null) return null;
  return {
    ...critique,
    digest: digest(critique),
  };
}

export function validateFeatureCriterionEvidence(evidence, expectedCriteria) {
  if (!isRecord(evidence) ||
      Object.keys(evidence).sort().join(",") !== "criteria,schema" ||
      evidence.schema !== FEATURE_CRITERION_EVIDENCE_SCHEMA ||
      !Array.isArray(expectedCriteria) ||
      !Array.isArray(evidence.criteria) ||
      evidence.criteria.length !== expectedCriteria.length) {
    return null;
  }
  const criteria = evidence.criteria.map((entry, index) => {
    if (!isRecord(entry) ||
        Object.keys(entry).sort().join(",") !==
          "criterion,expected,kind,target" ||
        entry.criterion !== expectedCriteria[index] ||
        entry.kind !== "git_file_equals" ||
        !safeRepositoryRelativePath(entry.target) ||
        typeof entry.expected !== "string" ||
        Buffer.byteLength(entry.expected, "utf8") > 1_048_576) {
      return null;
    }
    return entry;
  });
  return criteria.some((entry) => entry === null)
    ? null
    : { schema: evidence.schema, criteria };
}

/**
 * Validate the independent critique delegate's complete canonical output.
 *
 * The outer delegate envelope remains the registered result schema. The
 * embedded critique is deliberately a small, closed contract so the seal
 * operation can retain findings and criterion evidence without interpreting
 * arbitrary prose or trusting apply's selected bytes. When taskInputs are
 * supplied, the digest is checked against the exact task input object that
 * was transmitted to the delegate. Independent critique input digests are
 * carried both in that task input and in the result so registered operations
 * can re-check the exact authority materialization before accepting verdicts.
 */
export function validateFeatureCritiqueOutput(
  output,
  {
    taskInputs = undefined,
    expectedCriteria = undefined,
    candidateDigest = undefined,
    predecessorEvidenceDigest = undefined,
    requireAuthorityBinding = false,
  } = {},
) {
  if (typeof output !== "string" ||
      Buffer.byteLength(output, "utf8") > FEATURE_CRITIQUE_MAX_BYTES) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
    if (JSON.stringify(freezeCanonical(parsed)) !== output) return null;
  } catch {
    return null;
  }
  if (!isRecord(parsed) ||
      Object.keys(parsed).sort().join(",") !==
        "feature_critique,observation,schema" ||
      parsed.schema !== "flow.delegate-evidence/v1" ||
      typeof parsed.observation !== "string" ||
      Buffer.byteLength(parsed.observation, "utf8") > 2 * 1024 ||
      !isRecord(parsed.feature_critique)) {
    return null;
  }
  const critique = parsed.feature_critique;
  if (Object.keys(critique).sort().join(",") !==
        "candidate_digest,criteria,findings,predecessor_evidence_digest,schema,task_inputs_digest" ||
      critique.schema !== FEATURE_CRITIQUE_OUTPUT_SCHEMA ||
      !isDigest(critique.candidate_digest) ||
      !isDigest(critique.predecessor_evidence_digest) ||
      !isDigest(critique.task_inputs_digest) ||
      !Array.isArray(critique.criteria) ||
      !Array.isArray(critique.findings) ||
      critique.findings.length > FEATURE_CRITIQUE_MAX_FINDINGS) {
    return null;
  }
  if (requireAuthorityBinding &&
      (!isDigest(candidateDigest) || !isDigest(predecessorEvidenceDigest))) {
    return null;
  }
  if (candidateDigest !== undefined &&
      critique.candidate_digest !== candidateDigest) {
    return null;
  }
  if (predecessorEvidenceDigest !== undefined &&
      critique.predecessor_evidence_digest !== predecessorEvidenceDigest) {
    return null;
  }
  if (taskInputs !== undefined) {
    let taskInputDigest;
    try {
      taskInputDigest = digest(taskInputs);
    } catch {
      return null;
    }
    if (taskInputDigest !== critique.task_inputs_digest ||
        taskInputs.candidate_digest !== critique.candidate_digest ||
        taskInputs.predecessor_evidence_digest !==
          critique.predecessor_evidence_digest) {
      return null;
    }
  }
  if (!Array.isArray(expectedCriteria) ||
      critique.criteria.length !== expectedCriteria.length ||
      critique.criteria.some((entry, index) => {
        if (!isRecord(entry) ||
            Object.keys(entry).sort().join(",") !==
              "criterion,evidence,evidence_digest,verdict" ||
            entry.criterion !== expectedCriteria[index] ||
            !["passed", "failed"].includes(entry.verdict) ||
            !isDigest(entry.evidence_digest) ||
            !isRecord(entry.evidence)) return true;
        const evidence = validateFeatureCriterionEvidence({
          schema: FEATURE_CRITERION_EVIDENCE_SCHEMA,
          criteria: [{
            criterion: entry.criterion,
            ...entry.evidence,
          }],
        }, [entry.criterion]);
        return evidence === null ||
          digest({
            criterion: entry.criterion,
            evidence: entry.evidence,
            verdict: entry.verdict,
          }) !==
            entry.evidence_digest;
      })) {
    return null;
  }
  const findingIds = new Set();
  let previousFindingId = null;
  for (const finding of critique.findings) {
    if (!validFeatureCritiqueFinding(finding) ||
        findingIds.has(finding.finding_id) ||
        previousFindingId !== null && finding.finding_id <= previousFindingId) {
      return null;
    }
    findingIds.add(finding.finding_id);
    previousFindingId = finding.finding_id;
  }
  return {
    schema: critique.schema,
    candidate_digest: critique.candidate_digest,
    predecessor_evidence_digest: critique.predecessor_evidence_digest,
    task_inputs_digest: critique.task_inputs_digest,
    criteria: critique.criteria,
    findings: critique.findings,
  };
}

export function materializedEvidenceDigest(value) {
  if (!isRecord(value) || !isDigest(value.evidence_digest)) return null;
  const { evidence_digest: _evidenceDigest, ...identity } = value;
  try {
    return digest(identity) === value.evidence_digest
      ? value.evidence_digest
      : null;
  } catch {
    return null;
  }
}

function validCritiqueInputBinding(binding, cardId) {
  if (!isRecord(binding) ||
      Object.keys(binding).sort().join(",") !==
        "binding_digest,candidate_digest,card_id,predecessor_evidence_digest,schema" ||
      binding.schema !== AUTHORITY_CRITIQUE_INPUT_BINDING_SCHEMA ||
      typeof cardId !== "string" ||
      binding.card_id !== cardId ||
      !isDigest(binding.candidate_digest) ||
      !isDigest(binding.predecessor_evidence_digest) ||
      !isDigest(binding.binding_digest)) return false;
  const { binding_digest: _bindingDigest, ...identity } = binding;
  try {
    return digest(identity) === binding.binding_digest;
  } catch {
    return false;
  }
}

function validFeatureCritiqueFinding(finding) {
  if (!isRecord(finding) ||
      Object.keys(finding).sort().join(",") !==
        "classification,detail,finding_id,summary" ||
      !["blocking", "non_blocking"].includes(finding.classification) ||
      typeof finding.summary !== "string" ||
      typeof finding.detail !== "string" ||
      finding.summary.length === 0 || finding.detail.length === 0 ||
      Buffer.byteLength(finding.summary, "utf8") >
        FEATURE_CRITIQUE_MAX_SUMMARY_BYTES ||
      Buffer.byteLength(finding.detail, "utf8") >
        FEATURE_CRITIQUE_MAX_DETAIL_BYTES ||
      !/^finding:[0-9a-f]{64}$/u.test(finding.finding_id)) {
    return false;
  }
  return digest({
    classification: finding.classification,
    detail: finding.detail,
    summary: finding.summary,
  }) === `sha256:${finding.finding_id.slice("finding:".length)}`;
}

function assertCriterionEvidenceMatchesGit(workspace, git, evidence) {
  let actual;
  try {
    actual = execFileSync(
      "git",
      ["-C", workspace.path, "show", `${git.commit_sha}:${evidence.target}`],
      { encoding: null, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw featureOperationError(
      "feature_verification_criterion_evidence_unavailable",
      `feature criterion evidence target is absent: ${evidence.target}`,
      { cause: error },
    );
  }
  if (!actual.equals(Buffer.from(evidence.expected, "utf8"))) {
    throw featureOperationError(
      "feature_verification_criterion_evidence_mismatch",
      `feature criterion evidence does not match Git: ${evidence.criterion}`,
    );
  }
}

function safeRepositoryRelativePath(value) {
  return typeof value === "string" &&
    value.length > 0 && value.length <= 512 &&
    value === value.trim() &&
    !value.startsWith("/") && !value.startsWith("\\") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." ||
      segment === "..") &&
    !value.includes("\0") &&
    !value.startsWith("-");
}

function resolveIntentWorkspace(intent, resolveWorkspace) {
  const subjectId = intent.operation_input?.workspace?.subject_id;
  const workspace = resolveWorkspace(subjectId);
  if (!workspace) {
    throw featureOperationError(
      "feature_workspace_unavailable",
      `feature workspace is not registered: ${subjectId}`,
    );
  }
  return workspace;
}

function observeGit({ workspace, gitWorkspaceObservationAdapter }) {
  const observation = gitWorkspaceObservationAdapter.observe({
    repository_id: workspace.repository_id,
    workspace_path: workspace.path,
    ref: workspace.ref,
  });
  if (observation?.schema !== "work.git-observation/v1" ||
      !validGit(observation.git)) {
    throw featureOperationError(
      "feature_git_observation_invalid",
      "feature operation Git observation is invalid",
    );
  }
  return observation.git;
}

function archiveGit(repositoryPath, commitSha) {
  try {
    return execFileSync(
      "git",
      ["-C", repositoryPath, "archive", "--format=tar", commitSha],
      {
        encoding: null,
        maxBuffer: CAPTURE_ARCHIVE_MAX_BYTES,
        timeout: CAPTURE_ARCHIVE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    if (error?.code === "ENOBUFS" ||
        error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw featureOperationError(
        "feature_capture_artifact_oversize",
        "feature capture archive exceeds the bounded artifact size",
        { cause: error },
      );
    }
    if (error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM") {
      throw featureOperationError(
        "feature_capture_artifact_timeout",
        "feature capture archive exceeded its bounded Git timeout",
        { cause: error },
      );
    }
    throw featureOperationError(
      "feature_capture_artifact_unavailable",
      "feature capture could not archive the observed Git commit",
      { cause: error },
    );
  }
}

function operationReceipt(intent, providerReceipt) {
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: providerReceipt,
  };
}

function bytesDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function featureOperationError(code, message, options) {
  const error = new TypeError(message, options);
  error.code = code;
  return error;
}

function validGit(git) {
  return isRecord(git) &&
    Object.keys(git).sort().join(",") === "clean,commit_sha,ref,tree_sha" &&
    /^[0-9a-f]{40,64}$/u.test(git.commit_sha ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(git.tree_sha ?? "") &&
    typeof git.ref === "string" && git.ref.length > 0 &&
    typeof git.clean === "boolean";
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

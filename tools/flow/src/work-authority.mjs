import { isDeepStrictEqual } from "node:util";

import { digest, freezeCanonical } from "./canonical.mjs";

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;
const attachedAuthorities = new WeakMap();

export function getWorkspaceAuthority({ runAuthority } = {}) {
  return getAttachedAuthority(runAuthority, "workspace");
}

export function getArtifactAuthority({ runAuthority } = {}) {
  return getAttachedAuthority(runAuthority, "artifact");
}

export function getResourceHandoffAuthority({ runAuthority } = {}) {
  return getAttachedAuthority(runAuthority, "handoff");
}

export function attachWorkAuthorities(runAuthority, authorities) {
  if (attachedAuthorities.has(runAuthority) ||
      authorities?.workspace?.schema !== "work.workspace-authority/v1" ||
      authorities?.artifact?.schema !== "work.artifact-authority/v1" ||
      authorities?.handoff?.schema !== "flow.resource-handoff-authority/v1") {
    throw new TypeError("invalid durable Work-domain authority attachment");
  }
  attachedAuthorities.set(runAuthority, authorities);
}

export function buildHumanAuthorityBinding(command, action) {
  return freezeCanonical({
    action,
    command_id: command.command_id,
    subject_id: command.subject_id,
    expected_watermark: command.expected_watermark,
    action_digest: digest({
      action,
      evidence: command.evidence ?? null,
      replacement: command.replacement ?? null,
      scope: command.scope ?? null,
    }),
  });
}

export function decideWorkCommand(current, command) {
  const repeated = repeatedWorkCommand(current, command);
  if (repeated !== null) return repeated;
  if (command?.schema === "work.workspace-register-command/v1" &&
      command.type === "workspace_register") {
    return decideWorkspaceRegistration(current, command);
  }
  if (command?.schema === "work.artifact-record-command/v1" &&
      command.type === "artifact_record") {
    return decideArtifactRegistration(current, command);
  }
  if (command?.schema === "work.workspace-claim-command/v1" &&
      command.type === "workspace_claim") {
    return decideWorkspaceClaim(current, command);
  }
  if (command?.schema === "work.workspace-claim-release-command/v1" &&
      command.type === "workspace_claim_release") {
    return decideWorkspaceClaimRelease(current, command);
  }
  if (command?.schema === "work.workspace-taint-command/v1" &&
      command.type === "workspace_taint") {
    return decideWorkspaceTaint(current, command);
  }
  if (command?.schema === "work.workspace-taint-disposition-command/v1" &&
      command.type === "workspace_taint_disposition") {
    return decideWorkspaceTaintDisposition(current, command);
  }
  if (command?.schema === "work.workspace-risk-acceptance-command/v1" &&
      command.type === "workspace_risk_acceptance") {
    return decideWorkspaceRiskAcceptance(current, command);
  }
  if (command?.schema === "flow.resource-handoff-disposition-command/v1" &&
      command.type === "resource_handoff_disposition") {
    return decideHandoffDisposition(current, command);
  }
  return reject(command, "unsupported_command", current);
}

function getAttachedAuthority(runAuthority, name) {
  const authority = attachedAuthorities.get(runAuthority)?.[name];
  if (!authority) {
    throw new TypeError(`durable ${name} authority is unavailable`);
  }
  return authority;
}

export function workStreamIdentity(contract, subjectId) {
  if (!["work.workspace/v1", "work.artifact/v1", "flow.resource-handoff/v1"]
    .includes(contract) || typeof subjectId !== "string" || subjectId.length === 0) {
    return null;
  }
  const kinds = {
    "work.workspace/v1": "workspace",
    "work.artifact/v1": "artifact",
    "flow.resource-handoff/v1": "handoff",
  };
  return {
    streamId: `work:${contract}:${subjectId}`,
    streamKind: kinds[contract],
  };
}

export function foldWorkStream(streamKind, subjectId, records, watermark) {
  if (streamKind === "workspace") {
    const registration = records[0]?.payload;
    if (registration?.type !== "workspace_registered") {
      throw new Error("workspace authority stream is missing registration");
    }
    let generation = 1;
    let mutationEpoch = registration.registration.mutation_epoch;
    let git = registration.registration.git;
    let gitObservation = registration.git_observation;
    let disposition = registration.registration.disposition;
    let claims = [];
    let taint = null;
    const riskAcceptances = [];
    const commandReceipts = [];
    let cleanupReceipt = null;
    for (const { payload } of records.slice(1)) {
      if (payload.type === "workspace_promoted") {
        generation = payload.generation;
        mutationEpoch = payload.mutation_epoch;
        git = payload.git;
        gitObservation = payload.git_observation;
        disposition = payload.disposition;
        claims = [];
        taint = null;
      } else if (payload.type === "workspace_claimed") {
        claims = [payload.claim];
        if (payload.command_receipt) commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "workspace_claim_released") {
        claims = [];
        if (payload.command_receipt) commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "workspace_tainted") {
        taint = {
          status: "tainted",
          reason: payload.taint.reason,
          evidence_digest: payload.taint.evidence_digest,
          source_effect_id: payload.taint.source_effect_id ?? null,
        };
        if (payload.command_receipt) commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "workspace_taint_cleared") {
        taint = null;
        if (payload.command_receipt) commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "workspace_reset") {
        generation = payload.replacement.generation;
        mutationEpoch = payload.replacement.mutation_epoch;
        git = payload.replacement.git;
        gitObservation = payload.git_observation;
        disposition = payload.replacement.disposition;
        claims = [];
        taint = null;
        commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "workspace_risk_accepted") {
        riskAcceptances.push(payload.acceptance);
        if (payload.command_receipt) commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "workspace_cleaned") {
        disposition = "cleaned";
        claims = [];
        taint = null;
        cleanupReceipt = payload.cleanup_receipt;
      } else if (payload.type === "workspace_handoff_retention_released") {
        if (payload.expected_generation === generation &&
            payload.expected_fingerprint === digest({ git })) {
          disposition = "released";
        }
      }
    }
    const legalActions = claims.map((claim) => ({
      schema: "work.workspace-claim-release-command/v1",
      command_id: `workspace-claim-release:${claim.claim_id}:${watermark}`,
      type: "workspace_claim_release",
      contract: "work.workspace/v1",
      subject_id: subjectId,
      expected_watermark: watermark,
      claim_id: claim.claim_id,
      holder: claim.holder,
    }));
    if (taint !== null) legalActions.push(
      {
        schema: "work.legal-next-action/v1",
        type: "workspace_taint_disposition",
        subject_id: subjectId,
        expected_watermark: watermark,
        allowed_dispositions: [
          "evidence_backed_adoption",
          "proven_absence",
          "replacement_known_generation",
          "abandonment",
          "retirement",
          "destructive_reset",
        ],
      },
      {
        schema: "work.legal-next-action/v1",
        type: "workspace_risk_acceptance",
        subject_id: subjectId,
        expected_watermark: watermark,
      },
    );
    return freezeCanonical({
      schema: "work.workspace-projection/v1",
      contract: "work.workspace/v1",
      subject_id: subjectId,
      watermark,
      generation,
      registration_generation: 1,
      mutation_epoch: mutationEpoch,
      repository: registration.registration.repository,
      workspace: registration.registration.workspace,
      git,
      git_observation: gitObservation,
      disposition,
      claims,
      taint,
      risk_acceptances: riskAcceptances,
      command_receipts: commandReceipts,
      cleanup_receipt: cleanupReceipt,
      registration_receipt: registration.registration_receipt,
      legal_actions: legalActions,
    });
  }
  if (streamKind === "artifact") {
    const recorded = records[0]?.payload;
    if (recorded?.type !== "artifact_recorded") {
      throw new Error("artifact authority stream is missing registration");
    }
    const pins = new Map(recorded.artifact.pins.map((pin) => [digest(pin), pin]));
    let status = "retained";
    let collectionReceipt = null;
    let collectionEffectId = null;
    for (const { payload } of records.slice(1)) {
      if (payload.type === "artifact_pins_transferred") {
        for (const pin of payload.remove) pins.delete(digest(pin));
        for (const pin of payload.add) pins.set(digest(pin), pin);
      } else if (payload.type === "artifact_collected") {
        pins.clear();
        status = "collected";
        collectionReceipt = payload.cleanup_receipt;
        collectionEffectId = null;
      } else if (payload.type === "artifact_collection_started") {
        status = "uncertain";
        collectionEffectId = payload.effect_id;
      }
    }
    return freezeCanonical({
      schema: "work.artifact-projection/v1",
      contract: "work.artifact/v1",
      subject_id: subjectId,
      watermark,
      generation: 1,
      digest: recorded.artifact.digest,
      artifact_schema: recorded.artifact.artifact_schema,
      size: recorded.artifact.size,
      provenance: recorded.artifact.provenance,
      classification: recorded.artifact.classification,
      retention: recorded.artifact.retention,
      status,
      pins: [...pins.values()].sort((left, right) =>
        digest(left).localeCompare(digest(right))),
      byte_availability: recorded.byte_availability,
      registration_receipt: recorded.registration_receipt,
      collection_receipt: collectionReceipt,
      collection_effect_id: collectionEffectId,
      legal_actions: [],
    });
  }
  if (streamKind === "handoff") {
    const activated = records[0]?.payload;
    if (activated?.type !== "resource_handoff_activated") {
      throw new Error("resource handoff stream is missing activation");
    }
    const handoffDigest = digest(activated.handoff);
    const consumerPins = [];
    const mutationAuthorizations = [];
    let mutationAuthorizationCount = 0;
    let mutationClaim = null;
    let status = "active";
    let retention = activated.handoff.retention;
    let cleanupObligations = activated.handoff.cleanup_obligations;
    let cleanupEffectId = null;
    let cleanupReceipt = null;
    const commandReceipts = [];
    for (const { payload } of records.slice(1)) {
      if (payload.type === "resource_handoff_pinned") {
        consumerPins.push({
          run_id: payload.consumer_run_id,
          operations: payload.operations,
          binding_digest: payload.binding_digest,
        });
        if (payload.mutation_claim) mutationClaim = payload.mutation_claim;
      } else if (payload.type === "consumer_handoff_rechecked") {
        mutationAuthorizationCount += 1;
        mutationAuthorizations.splice(0, mutationAuthorizations.length,
          payload.authorization);
      } else if (payload.type === "resource_handoff_consumer_released") {
        const index = consumerPins.findIndex(({ run_id: runId }) =>
          runId === payload.consumer_run_id);
        if (index !== -1) consumerPins.splice(index, 1);
        if (mutationClaim?.holder === payload.consumer_run_id) mutationClaim = null;
      } else if (payload.type === "resource_handoff_retired") {
        status = "retired";
        retention = "collectable";
        cleanupObligations = [];
        commandReceipts.push(payload.command_receipt);
      } else if (payload.type === "resource_handoff_cleanup_started") {
        status = "uncertain";
        cleanupEffectId = payload.effect_id;
      } else if (payload.type === "resource_handoff_cleaned") {
        status = "cleaned";
        cleanupEffectId = null;
        cleanupReceipt = payload.cleanup_receipt;
      }
    }
    const legalActions = consumerPins.map((pin) => ({
      schema: "flow.legal-next-action/v1",
      type: "execute_bound_consumer_operation",
      consumer_run_id: pin.run_id,
      operations: pin.operations,
      binding_digest: pin.binding_digest,
      expected_watermark: watermark,
    }));
    return freezeCanonical({
      schema: "flow.resource-handoff-projection/v1",
      contract: "flow.resource-handoff/v1",
      subject_id: subjectId,
      watermark,
      generation: 1,
      ...activated.handoff,
      handoff_digest: handoffDigest,
      status,
      retention,
      cleanup_obligations: cleanupObligations,
      consumer_pins: consumerPins,
      mutation_claim: mutationClaim,
      mutation_authorizations: mutationAuthorizations,
      mutation_authorization_count: mutationAuthorizationCount,
      cleanup_effect_id: cleanupEffectId,
      cleanup_receipt: cleanupReceipt,
      command_receipts: commandReceipts,
      legal_actions: legalActions,
    });
  }
  throw new Error("work authority stream contract is unknown");
}

export function withHandoffObservations(
  projection,
  workspace,
  artifacts,
  gitObservation,
  consumerObservations,
) {
  const subjectExact = workspace?.generation === projection.subject.generation &&
    digest({ git: workspace.git }) === projection.subject.fingerprint;
  const matchingMutationClaim = projection.mutation_claim !== null &&
    workspace?.claims.length === 1 &&
    workspace.claims[0].holder === projection.mutation_claim.holder &&
    workspace.claims[0].claim_id === projection.mutation_claim.claim_id;
  const subjectSafe = subjectExact && workspace.taint === null &&
    (workspace.claims.length === 0 || matchingMutationClaim);
  const artifactsExact = artifacts.length === projection.artifacts.length &&
    artifacts.every((artifact, index) =>
      artifact?.digest === projection.artifacts[index].digest &&
      artifact.generation === projection.artifacts[index].generation);
  const byteAvailability = artifactsExact && artifacts.every(
    ({ byte_availability: availability }) => availability === "available",
  ) ? "available" : "missing";
  const gitAvailable = gitObservation?.available === true &&
    gitObservation.commit_sha === projection.git_retention.commit_sha &&
    gitObservation.tree_sha === projection.git_retention.tree_sha;
  const watermark = digest({
    schema: "flow.resource-handoff-observation-watermark/v1",
    handoff_watermark: projection.watermark,
    workspace_watermark: workspace?.watermark ?? null,
    artifact_watermarks: artifacts.map((artifact) => artifact?.watermark ?? null),
    subject_exact: subjectExact,
    byte_availability: byteAvailability,
    git_retention_observation: gitObservation,
    consumer_observations: consumerObservations,
  });
  const legalActions = subjectSafe && artifactsExact && gitAvailable &&
      byteAvailability === "available"
    ? projection.legal_actions.map((action) => ({
        ...action,
        expected_watermark: watermark,
      }))
    : [];
  return freezeCanonical({
    ...projection,
    authority_watermark: projection.watermark,
    watermark,
    subject_availability: subjectSafe && gitAvailable
      ? "exact"
      : subjectExact && gitAvailable
        ? "uncertain"
        : "stale",
    byte_availability: byteAvailability,
    git_availability: gitAvailable ? "available" : "missing",
    legal_actions: legalActions,
  });
}

export function buildHandoffPublication({
  artifacts,
  intent,
  publication,
  receipt,
  workspace,
  gitObservation,
}) {
  validateHandoffPublicationAuthority({
    artifacts,
    gitObservation,
    intent,
    publication,
    workspace,
  });
  if (receipt?.provider_receipt?.publication_digest !== digest(publication) ||
      !validGitRetentionReceipt(
        receipt?.provider_receipt?.git_retention,
        workspace,
        publication,
      )) {
    throw new TypeError("resource handoff receipt does not match publication");
  }
  const handoffBody = {
    subject: {
      contract: publication.subject.contract,
      subject_id: publication.subject.subject_id,
      generation: publication.workspace.promoted_generation,
      fingerprint: digest({ git: publication.workspace.promoted_git }),
    },
    producer: {
      run_id: intent.run_id,
      effect_id: intent.effect_id,
      evidence_digest: digest(receipt),
    },
    artifacts: artifacts.map((artifact) => ({
      digest: artifact.digest,
      generation: artifact.generation,
    })),
    associated_workspace: {
      subject_id: workspace.subject_id,
      generation: publication.workspace.promoted_generation,
      git: publication.workspace.promoted_git,
    },
    git_retention: receipt.provider_receipt.git_retention,
    allowed_consumer_operations: publication.allowed_consumer_operations,
    consumer_operation_authority: publication.consumer_operation_authority,
    authority_envelope: publication.authority_envelope,
    retention: publication.retention,
    cleanup_obligations: publication.cleanup_obligations,
    intended_consumer: publication.intended_consumer ?? null,
  };
  const handoffId = `handoff:${digest(handoffBody).slice("sha256:".length)}`;
  const handoff = freezeCanonical({ handoff_id: handoffId, ...handoffBody });
  return {
    handoff,
    workspaceEvent: {
      contract: "work.workspace-event/v1",
      payload: {
        type: "workspace_promoted",
        generation: publication.workspace.promoted_generation,
        mutation_epoch: publication.workspace.promoted_mutation_epoch,
        git: publication.workspace.promoted_git,
        git_observation: gitObservation,
        disposition: publication.workspace.disposition,
      },
    },
    artifactEvents: artifacts.map((artifact) => ({
      contract: "work.artifact-event/v1",
      payload: {
        type: "artifact_pins_transferred",
        remove: [{ holder: "run", id: intent.run_id }],
        add: [{ holder: "handoff", id: handoffId }],
      },
    })),
    handoffEvent: {
      contract: "flow.resource-handoff-event/v1",
      payload: { type: "resource_handoff_activated", handoff },
    },
  };
}

export function validateHandoffPublicationAuthority({
  artifacts,
  intent,
  publication,
  workspace,
  gitObservation,
}) {
  if (publication?.schema !== "flow.resource-handoff-publication/v1" ||
      gitObservation?.schema !== "work.git-observation/v1" ||
      !isDeepStrictEqual(gitObservation.git, publication?.workspace?.promoted_git) ||
      workspace?.schema !== "work.workspace-projection/v1" ||
      workspace.subject_id !== publication.workspace?.subject_id ||
      workspace.generation !== publication.workspace.expected_generation ||
      workspace.mutation_epoch !== publication.workspace.expected_mutation_epoch ||
      digest(workspace.git) !== digest(publication.workspace.expected_git) ||
      publication.workspace.promoted_generation !== workspace.generation + 1 ||
      !Number.isSafeInteger(publication.workspace.promoted_mutation_epoch) ||
      publication.workspace.promoted_mutation_epoch <= workspace.mutation_epoch ||
      !validGitFacts(publication.workspace.promoted_git) ||
      !nonEmpty(publication.workspace.disposition) ||
      publication.subject?.contract !== "work.workspace/v1" ||
      publication.subject.subject_id !== workspace.subject_id ||
      workspace.taint !== null && !(
        workspace.taint.reason === "handoff_publication_in_flight" &&
        workspace.taint.source_effect_id === intent.effect_id &&
        workspace.taint.evidence_digest === digest(intent)
      ) ||
      workspace.claims.length !== 1 ||
      workspace.claims[0].holder !== intent.run_id ||
      !workspace.claims[0].operations.includes("handoff_publication") ||
      !intent.resource_claims?.some((claim) =>
        claim.kind === "workspace" && claim.id === workspace.subject_id) ||
      !Array.isArray(publication.artifacts) || publication.artifacts.length === 0 ||
      artifacts.length !== publication.artifacts.length ||
      artifacts.some((artifact, index) =>
        artifact?.schema !== "work.artifact-projection/v1" ||
        artifact.digest !== publication.artifacts[index].digest ||
        artifact.generation !== publication.artifacts[index].expected_generation ||
        artifact.byte_availability !== "available" ||
        !artifact.pins.some(({ holder, id }) =>
          holder === "run" && id === intent.run_id)) ||
      !Array.isArray(publication.allowed_consumer_operations) ||
      publication.allowed_consumer_operations.length === 0 ||
      !validConsumerOperationAuthority(publication) ||
      !isRecord(publication.authority_envelope) ||
      !nonEmpty(publication.retention) ||
      !Array.isArray(publication.cleanup_obligations)) {
    throw new TypeError("resource handoff publication does not match authority");
  }
}

export function buildConsumerHandoffBinding({ handoff, claim, runId }) {
  const mutatingOperations = claim?.operations?.filter((operation) =>
    consumerOperationAccess(handoff, operation) === "mutation") ?? [];
  if (claim?.kind !== "resource_handoff" || claim.id !== handoff?.handoff_id ||
      claim.digest !== handoff.handoff_digest ||
      !Array.isArray(claim.operations) || claim.operations.length === 0 ||
      claim.operations.some((operation) =>
        !handoff.allowed_consumer_operations.includes(operation)) ||
      claim.operations.some((operation) =>
        consumerOperationAccess(handoff, operation) === null) ||
      handoff.intended_consumer !== null && handoff.intended_consumer !== runId ||
      handoff.subject_availability !== "exact" ||
      handoff.byte_availability !== "available" ||
      handoff.git_availability !== "available" ||
      mutatingOperations.length > 0 && handoff.mutation_claim !== null) {
    throw new TypeError("prepared consumer handoff binding is not exact");
  }
  const binding = freezeCanonical({
    schema: "flow.resource-handoff-consumer-binding/v1",
    consumer_run_id: runId,
    handoff_id: handoff.handoff_id,
    handoff_digest: handoff.handoff_digest,
    operations: [...new Set(claim.operations)].sort(),
    subject: handoff.subject,
    artifacts: handoff.artifacts,
    authority_envelope: handoff.authority_envelope,
    preparation_watermark: handoff.watermark,
  });
  const mutationClaim = mutatingOperations.length === 0 ? null : freezeCanonical({
    claim_id: `handoff-mutation:${handoff.handoff_id}:${runId}`,
    holder: runId,
    operations: mutatingOperations,
  });
  return {
    binding,
    handoffEvent: {
      contract: "flow.resource-handoff-event/v1",
      payload: {
        type: "resource_handoff_pinned",
        consumer_run_id: runId,
        operations: binding.operations,
        binding_digest: digest(binding),
        mutation_claim: mutationClaim,
      },
    },
    workspaceEvent: mutationClaim === null ? null : {
      contract: "work.workspace-event/v1",
      payload: { type: "workspace_claimed", claim: mutationClaim },
    },
    artifactEvents: handoff.artifacts.map(() => ({
      contract: "work.artifact-event/v1",
      payload: {
        type: "artifact_pins_transferred",
        remove: [],
        add: [{ holder: "run", id: runId }],
      },
    })),
  };
}

export function buildConsumerMutationAuthorization({ handoff, intent }) {
  const request = intent?.operation_input?.resource_handoff;
  const pin = handoff?.consumer_pins.find(({ run_id: runId }) =>
    runId === intent.run_id);
  const cardClaim = intent?.resource_claims?.find((claim) =>
    claim.kind === "resource_handoff" &&
    claim.id === handoff?.handoff_id &&
    claim.digest === handoff?.handoff_digest &&
    claim.operations?.includes(request?.operation));
  if (request?.handoff_id !== handoff?.handoff_id ||
      request.handoff_digest !== handoff.handoff_digest ||
      !cardClaim ||
      !pin?.operations.includes(request.operation) ||
      !handoff.allowed_consumer_operations.includes(request.operation) ||
      consumerOperationAccess(handoff, request.operation) === "mutation" &&
        (handoff.mutation_claim?.holder !== intent.run_id ||
         !handoff.mutation_claim.operations.includes(request.operation)) ||
      handoff.subject_availability !== "exact" ||
      handoff.byte_availability !== "available" ||
      handoff.git_availability !== "available") {
    throw new TypeError("consumer mutation is not authorized by the exact handoff");
  }
  return freezeCanonical({
    schema: "flow.resource-handoff-mutation-authorization/v1",
    consumer_run_id: intent.run_id,
    effect_id: intent.effect_id,
    operation: request.operation,
    handoff_id: handoff.handoff_id,
    handoff_digest: handoff.handoff_digest,
    subject: handoff.subject,
    artifacts: handoff.artifacts,
    authority_envelope: handoff.authority_envelope,
    recheck_watermark: handoff.watermark,
  });
}

export function withArtifactAvailability(projection, byteAvailability) {
  if (projection.schema !== "work.artifact-projection/v1" ||
      projection.byte_availability === byteAvailability) return projection;
  const watermark = digest({
    schema: "work.artifact-observation-watermark/v1",
    authority_watermark: projection.watermark,
    byte_availability: byteAvailability,
  });
  return freezeCanonical({ ...projection, watermark, byte_availability: byteAvailability });
}

export function buildWorkspaceCleanupPreview(projection, gitObservation) {
  if (projection?.schema !== "work.workspace-projection/v1" ||
      gitObservation?.schema !== "work.git-observation/v1") {
    throw new TypeError("workspace cleanup requires exact authority observations");
  }
  const effects = [{
    type: "remove_workspace",
    canonical_path: projection.workspace.canonical_path,
    repository_id: projection.repository.canonical_id,
  }];
  const refusalReasons = [];
  if (projection.claims.length > 0) refusalReasons.push("active_claim");
  if (gitObservation.git?.clean !== true) refusalReasons.push("dirty");
  if (projection.taint !== null) refusalReasons.push("uncertain");
  if (String(projection.disposition).includes("retained")) {
    refusalReasons.push("retained");
  } else if (!["retired", "abandoned", "released"].includes(
    projection.disposition,
  )) {
    refusalReasons.push("active");
  }
  if (digest(gitObservation.git) !== digest(projection.git)) {
    refusalReasons.push("changed_fingerprint");
  }
  const watermark = digest({
    schema: "work.workspace-cleanup-observation-watermark/v1",
    authority_watermark: projection.watermark,
    git_observation: gitObservation,
  });
  return cleanupProjection({
    schema: "work.workspace-cleanup-preview/v1",
    actionType: "workspace_cleanup",
    authorityWatermark: projection.watermark,
    contract: "work.workspace/v1",
    effects,
    refusalReasons,
    subjectId: projection.subject_id,
    watermark,
  });
}

export function buildArtifactCollectionPreview(projection) {
  if (projection?.schema !== "work.artifact-projection/v1") {
    throw new TypeError("artifact collection requires exact authority");
  }
  const effects = [{
    type: "remove_artifact_bytes",
    digest: projection.digest,
    size: projection.size,
  }];
  const refusalReasons = [];
  if (projection.pins.length > 0) refusalReasons.push("pinned");
  if (!["ephemeral", "collectable"].includes(projection.retention)) {
    refusalReasons.push("retained");
  }
  if (projection.byte_availability !== "available") {
    refusalReasons.push("missing_bytes");
  }
  if (projection.status === "uncertain") refusalReasons.push("uncertain");
  if (projection.status === "collected") refusalReasons.push("already_collected");
  const watermark = digest({
    schema: "work.artifact-collection-observation-watermark/v1",
    authority_watermark: projection.watermark,
    byte_availability: projection.byte_availability,
  });
  return cleanupProjection({
    schema: "work.artifact-collection-preview/v1",
    actionType: "artifact_collection",
    authorityWatermark: projection.watermark,
    contract: "work.artifact/v1",
    effects,
    refusalReasons,
    subjectId: projection.subject_id,
    watermark,
  });
}

function cleanupProjection({
  actionType,
  authorityWatermark,
  contract,
  effects,
  refusalReasons,
  schema,
  subjectId,
  watermark,
}) {
  const previewIdentity = {
    subject_id: subjectId,
    authority_watermark: authorityWatermark,
    observation_watermark: watermark,
    effects,
    refusal_reasons: refusalReasons,
  };
  const previewDigest = digest(previewIdentity);
  return freezeCanonical({
    schema,
    subject_id: subjectId,
    watermark,
    authority_watermark: authorityWatermark,
    eligibility: refusalReasons.length === 0 ? "eligible" : "refused",
    refusal_reasons: refusalReasons,
    effects,
    legal_actions: refusalReasons.length === 0 ? [{
      schema: "work.legal-next-action/v1",
      type: actionType,
      execution: "registered_operation",
      operation_contract: "flow.operation/resource-cleanup/v1",
      subject_id: subjectId,
      expected_watermark: watermark,
      preview_digest: previewDigest,
      operation_input: {
        resource_cleanup: {
          schema: "flow.resource-cleanup-request/v1",
          contract,
          subject_id: subjectId,
          expected_watermark: watermark,
          preview_digest: previewDigest,
        },
      },
    }] : [],
  });
}

export function buildHandoffCleanupPreview(projection) {
  if (projection?.schema !== "flow.resource-handoff-projection/v1") {
    throw new TypeError("handoff cleanup requires exact authority");
  }
  const effects = [
    {
      type: "release_git_retention",
      repository_id: projection.git_retention.repository_id,
      retention_ref: projection.git_retention.retention_ref,
    },
    {
      type: "release_artifact_pins",
      digests: projection.artifacts.map(({ digest: artifactDigest }) => artifactDigest),
    },
    {
      type: "release_workspace_retention",
      subject_id: projection.subject.subject_id,
      generation: projection.subject.generation,
    },
  ];
  const refusalReasons = [];
  if (projection.status !== "retired") {
    refusalReasons.push(projection.status === "active"
      ? "active_handoff"
      : projection.status === "uncertain"
        ? "uncertain"
        : "already_cleaned");
  }
  if (projection.consumer_pins.length > 0) refusalReasons.push("consumer_pins");
  if (projection.cleanup_obligations.length > 0) {
    refusalReasons.push("cleanup_obligations");
  }
  if (!["ephemeral", "collectable"].includes(projection.retention)) {
    refusalReasons.push("retained");
  }
  const watermark = digest({
    schema: "flow.resource-handoff-cleanup-watermark/v1",
    authority_watermark: projection.watermark,
    effects,
    refusal_reasons: refusalReasons,
  });
  return cleanupProjection({
    schema: "flow.resource-handoff-cleanup-preview/v1",
    actionType: "resource_handoff_cleanup",
    authorityWatermark: projection.watermark,
    contract: "flow.resource-handoff/v1",
    effects,
    refusalReasons,
    subjectId: projection.subject_id,
    watermark,
  });
}

function decideHandoffDisposition(current, command) {
  if (current?.schema !== "flow.resource-handoff-projection/v1" ||
      command.expected_watermark !== current?.watermark) {
    return reject(command, "stale_authority_watermark", current);
  }
  if (current.status !== "active" || current.consumer_pins.length > 0 ||
      command.disposition !== "retired" ||
      command.evidence?.schema !== "flow.resource-handoff-disposition-evidence/v1" ||
      command.evidence.kind !== "cleanup_obligations_discharged" ||
      !isDigest(command.evidence.digest) ||
      !isDeepStrictEqual(command.evidence.cleanup_obligations,
        current.cleanup_obligations) ||
      command.evidence_validation?.schema !==
        "flow.resource-handoff-disposition-validation/v1" ||
      command.evidence_validation.valid !== true ||
      command.evidence_validation.subject_id !== current.subject_id ||
      command.evidence_validation.handoff_digest !== current.handoff_digest ||
      command.evidence_validation.cleanup_obligations_digest !==
        digest(current.cleanup_obligations) ||
      command.evidence_validation.evidence_digest !== command.evidence.digest) {
    return reject(command, "handoff_disposition_evidence_required", current);
  }
  return {
    accepted: true,
    streamKind: "handoff",
    event: {
      contract: "flow.resource-handoff-event/v1",
      payload: {
        type: "resource_handoff_retired",
        evidence: command.evidence,
        evidence_validation: command.evidence_validation,
        command_receipt: workIdempotencyReceipt(command),
      },
    },
  };
}

function consumerOperationAccess(handoff, operation) {
  return handoff?.consumer_operation_authority?.find((entry) =>
    entry.operation === operation)?.access ?? null;
}

function validConsumerOperationAuthority(publication) {
  if (!Array.isArray(publication.consumer_operation_authority) ||
      publication.consumer_operation_authority.length !==
        publication.allowed_consumer_operations.length ||
      publication.consumer_operation_authority.some((entry) =>
        !publication.allowed_consumer_operations.includes(entry?.operation) ||
        !["read_only", "mutation"].includes(entry?.access))) return false;
  const operations = publication.consumer_operation_authority
    .map(({ operation }) => operation);
  return new Set(operations).size === publication.allowed_consumer_operations.length &&
    publication.allowed_consumer_operations.every((operation) =>
      operations.includes(operation));
}

export function workRejection(operation, code, {
  command = null,
  current = null,
  contract = command?.contract ?? null,
  subjectId = command?.subject_id ?? null,
} = {}) {
  return freezeCanonical({
    schema: "work.rejection/v1",
    operation,
    code,
    contract,
    subject_id: subjectId,
    authority_watermark: current?.watermark ?? EMPTY_WATERMARK,
    legal_actions: current?.legal_actions ?? [],
  });
}

function decideWorkspaceRegistration(current, command) {
  if (current !== null) return repeatedRegistration(current, command);
  if (command.contract !== "work.workspace/v1" ||
      command.expected_generation !== 0 || !nonEmpty(command.command_id) ||
      !validWorkspaceRegistration(command.subject_id, command.registration)) {
    return reject(command, "invalid_workspace_registration", current);
  }
  const registrationReceipt = registrationReceiptFor(command);
  return {
    accepted: true,
    streamKind: "workspace",
    event: {
      contract: "work.workspace-event/v1",
      payload: {
        type: "workspace_registered",
        registration: command.registration,
        git_observation: command.git_observation,
        registration_receipt: registrationReceipt,
      },
    },
  };
}

function decideArtifactRegistration(current, command) {
  if (current !== null) return repeatedRegistration(current, command);
  if (command.contract !== "work.artifact/v1" ||
      command.expected_generation !== 0 || !nonEmpty(command.command_id) ||
      !validArtifact(command.subject_id, command.artifact) ||
      typeof command.bytes_base64 !== "string") {
    return reject(command, "invalid_artifact_record", current);
  }
  const registrationReceipt = registrationReceiptFor(command);
  return {
    accepted: true,
    streamKind: "artifact",
    artifactBytes: command.bytes_base64,
    event: {
      contract: "work.artifact-event/v1",
      payload: {
        type: "artifact_recorded",
        artifact: command.artifact,
        byte_availability: "available",
        registration_receipt: registrationReceipt,
      },
    },
  };
}

function decideWorkspaceClaim(current, command) {
  if (current?.schema !== "work.workspace-projection/v1" ||
      !nonEmpty(command.command_id) || !validWorkspaceClaim(command.claim)) {
    return reject(command, "invalid_workspace_claim", current);
  }
  if (command.expected_generation !== current.generation) {
    return reject(command, "stale_subject_generation", current);
  }
  if (current.taint !== null) {
    return reject(command, "workspace_tainted", current);
  }
  if (command.expected_watermark !== current.watermark) {
    return reject(command, "stale_authority_watermark", current);
  }
  if (command.expected_fingerprint !== digest({ git: current.git })) {
    return reject(command, "workspace_fingerprint_changed", current);
  }
  if (command.git_observation?.schema !== "work.git-observation/v1" ||
      !isDeepStrictEqual(command.git_observation.git, current.git)) {
    return reject(command, "workspace_fingerprint_changed", current);
  }
  if (current.claims.length > 0) {
    const [existing] = current.claims;
    if (isDeepStrictEqual(existing, command.claim)) {
      return { accepted: true, replayed: true, streamKind: null, event: null };
    }
    return reject(command, "workspace_already_claimed", current);
  }
  return {
    accepted: true,
    streamKind: "workspace",
    event: {
      contract: "work.workspace-event/v1",
      payload: {
        type: "workspace_claimed",
        claim: command.claim,
        command_receipt: workIdempotencyReceipt(command),
      },
    },
  };
}

function decideWorkspaceClaimRelease(current, command) {
  if (current?.schema !== "work.workspace-projection/v1" ||
      command.expected_watermark !== current?.watermark) {
    return reject(command, "stale_authority_watermark", current);
  }
  const [claim] = current.claims;
  if (!claim || claim.claim_id !== command.claim_id ||
      claim.holder !== command.holder || !nonEmpty(command.command_id)) {
    return reject(command, "workspace_claim_release_mismatch", current);
  }
  return {
    accepted: true,
    streamKind: "workspace",
    event: {
      contract: "work.workspace-event/v1",
      payload: {
        type: "workspace_claim_released",
        claim_id: claim.claim_id,
        holder: claim.holder,
        command_receipt: workIdempotencyReceipt(command),
      },
    },
  };
}

function decideWorkspaceTaint(current, command) {
  if (current?.schema !== "work.workspace-projection/v1" ||
      !nonEmpty(command.command_id) ||
      command.expected_watermark !== current.watermark ||
      !nonEmpty(command.taint?.reason) || !isDigest(command.taint?.evidence_digest)) {
    return reject(command,
      command?.expected_watermark !== current?.watermark
        ? "stale_authority_watermark"
        : "invalid_workspace_taint",
      current);
  }
  if (current.taint !== null) {
    return reject(command, "workspace_already_tainted", current);
  }
  return {
    accepted: true,
    streamKind: "workspace",
    event: {
      contract: "work.workspace-event/v1",
      payload: {
        type: "workspace_tainted",
        taint: command.taint,
        command_receipt: workIdempotencyReceipt(command),
      },
    },
  };
}

function decideWorkspaceTaintDisposition(current, command) {
  if (current?.schema !== "work.workspace-projection/v1") {
    return reject(command, "unknown_workspace", current);
  }
  if (command.expected_watermark !== current.watermark) {
    return reject(command, "stale_authority_watermark", current);
  }
  if (current.taint === null) {
    return reject(command, "workspace_not_tainted", current);
  }
  const evidenceKinds = {
    evidence_backed_adoption: "exact_provider_adoption",
    proven_absence: "provider_absence",
    replacement_known_generation: "replacement_receipt",
    abandonment: "abandonment_receipt",
    retirement: "retirement_receipt",
  };
  const allowed = [...Object.keys(evidenceKinds), "destructive_reset"];
  if (!allowed.includes(command.disposition)) {
    return reject(command, "invalid_taint_disposition", current);
  }
  if (command.disposition === "destructive_reset" &&
      !validHumanAuthority(command, "destructive_reset")) {
    return reject(command, "fresh_human_authority_required", current);
  }
  const expectedEvidenceKind = command.disposition === "destructive_reset"
    ? "destructive_reset_receipt"
    : evidenceKinds[command.disposition];
  if (command.evidence?.schema !== "work.taint-disposition-evidence/v1" ||
      command.evidence.kind !== expectedEvidenceKind ||
      !isDigest(command.evidence.digest) ||
      command.evidence_validation?.schema !==
        "work.taint-disposition-validation/v1" ||
      command.evidence_validation.valid !== true ||
      command.evidence_validation.subject_id !== current.subject_id ||
      command.evidence_validation.taint_evidence_digest !==
        current.taint.evidence_digest ||
      command.evidence_validation.disposition !== command.disposition ||
      command.evidence_validation.evidence_digest !== command.evidence.digest) {
    return reject(command, "taint_disposition_evidence_required", current);
  }
  if (command.disposition === "destructive_reset" &&
      (command.replacement?.generation !== current.generation + 1 ||
       !Number.isSafeInteger(command.replacement?.mutation_epoch) ||
       command.replacement.mutation_epoch <= current.mutation_epoch ||
       !validGitFacts(command.replacement.git) ||
       !nonEmpty(command.replacement.disposition) ||
       command.git_observation?.schema !== "work.git-observation/v1" ||
       !isDeepStrictEqual(command.git_observation.git, command.replacement.git))) {
    return reject(command, "destructive_reset_replacement_required", current);
  }
  return {
    accepted: true,
    streamKind: "workspace",
    event: {
      contract: "work.workspace-event/v1",
      payload: {
        type: command.disposition === "destructive_reset"
          ? "workspace_reset"
          : "workspace_taint_cleared",
        disposition: command.disposition,
        evidence: command.evidence,
        human_authority: command.human_authority,
        evidence_validation: command.evidence_validation,
        command_receipt: workIdempotencyReceipt(command),
        ...(command.disposition === "destructive_reset" ? {
          replacement: command.replacement,
          git_observation: command.git_observation,
        } : {}),
      },
    },
  };
}

function decideWorkspaceRiskAcceptance(current, command) {
  if (current?.schema !== "work.workspace-projection/v1" ||
      command.expected_watermark !== current?.watermark) {
    return reject(command, "stale_authority_watermark", current);
  }
  if (current.taint === null || !Array.isArray(command.scope) ||
      command.scope.length === 0 || !command.scope.every(nonEmpty)) {
    return reject(command, "invalid_risk_acceptance", current);
  }
  if (!validHumanAuthority(command, "risk_acceptance")) {
    return reject(command, "fresh_human_authority_required", current);
  }
  return {
    accepted: true,
    streamKind: "workspace",
    event: {
      contract: "work.workspace-event/v1",
      payload: {
        type: "workspace_risk_accepted",
        acceptance: {
          scope: command.scope,
          human_authority: command.human_authority,
          human_authority_validation: command.human_authority_validation,
        },
        command_receipt: workIdempotencyReceipt(command),
      },
    },
  };
}

function validHumanAuthority(command, action) {
  const authority = command.human_authority;
  const binding = buildHumanAuthorityBinding(command, action);
  const validation = command.human_authority_validation;
  return authority?.schema === "work.human-authority/v1" &&
    authority.action === action && authority.command_id === command.command_id &&
    authority.subject_id === command.subject_id &&
    authority.expected_watermark === command.expected_watermark &&
    authority.binding_digest === digest(binding) &&
    validation?.schema === "work.human-authority-validation/v1" &&
    validation.valid === true && validation.binding_digest === digest(binding) &&
    validation.authority_digest === digest(authority);
}

function repeatedWorkCommand(current, command) {
  if (!current || !nonEmpty(command?.command_id) ||
      !Array.isArray(current.command_receipts)) return null;
  const receipt = current.command_receipts.find(({ command_id: commandId }) =>
    commandId === command.command_id);
  if (!receipt) return null;
  return receipt.command_digest === commandDigest(command)
    ? { accepted: true, replayed: true, streamKind: null, event: null }
    : reject(command, "idempotency_conflict", current);
}

function workIdempotencyReceipt(command) {
  return freezeCanonical({
    schema: "work.idempotency-receipt/v1",
    command_id: command.command_id,
    command_digest: commandDigest(command),
  });
}

function repeatedRegistration(current, command) {
  const receipt = current.registration_receipt;
  if (receipt?.command_id === command?.command_id &&
      receipt.command_digest === commandDigest(command)) {
    return { accepted: true, replayed: true, streamKind: null, event: null };
  }
  return reject(
    command,
    receipt?.command_id === command?.command_id
      ? "idempotency_conflict"
      : "stale_subject_generation",
    current,
  );
}

function registrationReceiptFor(command) {
  return freezeCanonical({
    schema: "work.idempotency-receipt/v1",
    command_id: command.command_id,
    command_digest: commandDigest(command),
  });
}

function commandDigest(command) {
  if (!isRecord(command)) return safeDigest(command);
  const {
    evidence_validation: ignoredEvidenceValidation,
    git_observation: ignoredGitObservation,
    human_authority_validation: ignoredHumanValidation,
    ...requestedCommand
  } = command;
  return safeDigest(requestedCommand);
}

function safeDigest(value) {
  try {
    return digest(value);
  } catch {
    return null;
  }
}

function validWorkspaceRegistration(subjectId, registration) {
  const git = registration?.git;
  return registration?.workspace?.canonical_id === subjectId &&
    nonEmpty(registration.workspace.canonical_path) &&
    nonEmpty(registration.repository?.canonical_id) &&
    Number.isSafeInteger(registration.mutation_epoch) &&
    registration.mutation_epoch > 0 &&
    nonEmpty(registration.disposition) &&
    validGitFacts(git);
}

function validGitFacts(git) {
  return /^[0-9a-f]{40,64}$/u.test(git?.commit_sha ?? "") &&
    /^[0-9a-f]{40,64}$/u.test(git?.tree_sha ?? "") &&
    nonEmpty(git?.ref) && typeof git.clean === "boolean";
}

function validArtifact(subjectId, artifact) {
  return artifact?.digest === subjectId && isDigest(subjectId) &&
    nonEmpty(artifact.artifact_schema) && Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0 && isRecord(artifact.provenance?.producer) &&
    isRecord(artifact.provenance?.validator) &&
    nonEmpty(artifact.classification) && nonEmpty(artifact.retention) &&
    Array.isArray(artifact.pins) && artifact.pins.length > 0 &&
    artifact.pins.every((pin) => nonEmpty(pin?.holder) && nonEmpty(pin?.id));
}

function validWorkspaceClaim(claim) {
  return nonEmpty(claim?.claim_id) && nonEmpty(claim?.holder) &&
    Array.isArray(claim.operations) && claim.operations.length > 0 &&
    claim.operations.every(nonEmpty);
}

function validGitRetentionReceipt(receipt, workspace, publication) {
  return receipt?.schema === "flow.git-retention-receipt/v1" &&
    receipt.repository_id === workspace?.repository?.canonical_id &&
    receipt.commit_sha === publication?.workspace?.promoted_git?.commit_sha &&
    receipt.tree_sha === publication?.workspace?.promoted_git?.tree_sha &&
    nonEmpty(receipt.retention_ref);
}

function reject(command, code, current) {
  return workRejection("command", code, { command, current });
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

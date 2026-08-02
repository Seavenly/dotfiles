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

export function decideWorkCommand(current, command) {
  if (command?.schema === "work.workspace-register-command/v1" &&
      command.type === "workspace_register") {
    return decideWorkspaceRegistration(current, command);
  }
  if (command?.schema === "work.artifact-record-command/v1" &&
      command.type === "artifact_record") {
    return decideArtifactRegistration(current, command);
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
    for (const { payload } of records.slice(1)) {
      if (payload.type === "workspace_promoted") {
        generation = payload.generation;
        mutationEpoch = payload.mutation_epoch;
        git = payload.git;
        gitObservation = payload.git_observation;
        disposition = payload.disposition;
      }
    }
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
      registration_receipt: registration.registration_receipt,
      legal_actions: [],
    });
  }
  if (streamKind === "artifact") {
    const recorded = records[0]?.payload;
    if (recorded?.type !== "artifact_recorded") {
      throw new Error("artifact authority stream is missing registration");
    }
    const pins = new Map(recorded.artifact.pins.map((pin) => [digest(pin), pin]));
    for (const { payload } of records.slice(1)) {
      if (payload.type !== "artifact_pins_transferred") continue;
      for (const pin of payload.remove) pins.delete(digest(pin));
      for (const pin of payload.add) pins.set(digest(pin), pin);
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
      pins: [...pins.values()].sort((left, right) =>
        digest(left).localeCompare(digest(right))),
      byte_availability: recorded.byte_availability,
      registration_receipt: recorded.registration_receipt,
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
    for (const { payload } of records.slice(1)) {
      if (payload.type === "resource_handoff_pinned") {
        consumerPins.push({
          run_id: payload.consumer_run_id,
          operations: payload.operations,
          binding_digest: payload.binding_digest,
        });
      } else if (payload.type === "consumer_handoff_rechecked") {
        mutationAuthorizations.push(payload.authorization);
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
      status: "active",
      consumer_pins: consumerPins,
      mutation_authorizations: mutationAuthorizations,
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
  const legalActions = subjectExact && artifactsExact && gitAvailable &&
      byteAvailability === "available"
    ? projection.legal_actions.map((action) => ({
        ...action,
        expected_watermark: watermark,
      }))
    : [];
  return freezeCanonical({
    ...projection,
    watermark,
    subject_availability: subjectExact && gitAvailable ? "exact" : "stale",
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
  if (publication?.schema !== "flow.resource-handoff-publication/v1" ||
      receipt?.provider_receipt?.publication_digest !== digest(publication) ||
      !validGitRetentionReceipt(
        receipt?.provider_receipt?.git_retention,
        workspace,
        publication,
      ) ||
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
      !isRecord(publication.authority_envelope) ||
      !nonEmpty(publication.retention) ||
      !Array.isArray(publication.cleanup_obligations)) {
    throw new TypeError("resource handoff publication does not match authority");
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

export function buildConsumerHandoffBinding({ handoff, claim, runId }) {
  if (claim?.kind !== "resource_handoff" || claim.id !== handoff?.handoff_id ||
      claim.digest !== handoff.handoff_digest ||
      !Array.isArray(claim.operations) || claim.operations.length === 0 ||
      claim.operations.some((operation) =>
        !handoff.allowed_consumer_operations.includes(operation)) ||
      handoff.intended_consumer !== null && handoff.intended_consumer !== runId ||
      handoff.subject_availability !== "exact" ||
      handoff.byte_availability !== "available" ||
      handoff.git_availability !== "available") {
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
  return {
    binding,
    handoffEvent: {
      contract: "flow.resource-handoff-event/v1",
      payload: {
        type: "resource_handoff_pinned",
        consumer_run_id: runId,
        operations: binding.operations,
        binding_digest: digest(binding),
      },
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
  if (request?.handoff_id !== handoff?.handoff_id ||
      request.handoff_digest !== handoff.handoff_digest ||
      !pin?.operations.includes(request.operation) ||
      !handoff.allowed_consumer_operations.includes(request.operation) ||
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
  if (!isRecord(command) || command.git_observation === undefined) {
    return safeDigest(command);
  }
  const { git_observation: ignored, ...requestedCommand } = command;
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

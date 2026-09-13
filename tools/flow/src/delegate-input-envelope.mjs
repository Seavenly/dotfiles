import { createHash } from "node:crypto";

import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";
import { normalizeAuthorityBindings } from "./authority-bindings.mjs";
import {
  createEvidenceSafetyRequest,
  validateDelegateEvidenceSafety,
  validateEvidenceSafety,
} from "./evidence-safety.mjs";

export const DELEGATE_INPUT_ENVELOPE_SCHEMA =
  "flow.delegate-input-envelope/v1";
export const DELEGATE_TASK_INPUTS_SCHEMA =
  "flow.delegate-task-inputs/v1";
export const DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA =
  "flow.delegate-output-requirements/v1";
export const DELEGATE_EXECUTION_RESOURCE_SCHEMA =
  "flow.delegate-execution-resource-reference/v1";
export const DELEGATE_EXECUTION_RESOURCE_SELECTION_SCHEMA =
  "flow.delegate-execution-resource-selection/v1";
export const DELEGATE_EXECUTION_AUTHORITY_SCHEMA =
  "flow.delegate-execution-authority/v1";

/** Digest the exact UTF-8 bytes handed to a delegated runtime. */
export function digestDelegateInputBytes(bytes) {
  if (typeof bytes !== "string") {
    throw new DelegateInputEnvelopeError(
      "invalid_serialized_envelope",
      "delegate input bytes must be a string",
    );
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const INPUT_KINDS = new Set(["initial", "steering"]);
const RESOURCE_AUTHORITIES = new Map([
  ["workspace", "WorkspaceAuthority"],
  ["artifact", "ArtifactAuthority"],
]);
const RESOURCE_KINDS = new Set(["workspace", "artifact"]);
export const DELEGATE_RESOURCE_CONTRACTS = Object.freeze({
  workspace: "work.workspace/v1",
  artifact: "work.artifact/v1",
});
const RESOURCE_ACCESS = new Set(["read_only", "mutation"]);
const MUTATING_CAPABILITIES = new Set([
  "workspace-write",
  "auto",
  "unrestricted",
]);
const FORBIDDEN_KEYS = new Set([
  "ambient_transcript",
  "capability_secret",
  "credentials",
  "credential",
  "cwd",
  "credential_store",
  "environment",
  "full_bundle",
  "prepared_bundle",
  "prepared",
  "bundle",
  "path",
  "paths",
  "workspace_path",
  "working_directory",
  "transcript",
]);
const AUTHORITY_WATERMARK_SCHEMAS = new Set([
  "drovr.turn-authority-watermark/v1",
  "drovr.agent-authority-watermark/v1",
]);

/**
 * Build the one transport value shared by every delegated Flow role.
 *
 * The returned value is immutable and contains only caller-selected task
 * inputs, authority-owned resource references, accepted predecessor evidence,
 * and output requirements. `envelope_digest` binds that canonical value
 * without making a self-referential digest. Use serializeDelegateInputEnvelope
 * for the exact bytes handed to a harness.
 */
export function materializeDelegateInputEnvelope({
  attemptId,
  inputKey,
  sequence,
  inputKind = "initial",
  instructions,
  taskInputs = {},
  resourceReferences = [],
  executionAuthority,
  predecessorEvidence,
  outputRequirements,
} = {}) {
  requireNonEmptyString(attemptId, "attempt_id");
  requireNonEmptyString(inputKey, "input_key");
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new DelegateInputEnvelopeError(
      "invalid_sequence",
      "delegate input sequence must be a positive safe integer",
    );
  }
  if (!INPUT_KINDS.has(inputKind)) {
    throw new DelegateInputEnvelopeError(
      "invalid_input_kind",
      "delegate input kind must be initial or steering",
    );
  }
  requireNonEmptyString(instructions, "instructions");
  validateDelegateInputInstructions(instructions);
  validateDelegateTaskInputs(taskInputs);
  const resources = normalizeResourceReferences(resourceReferences);
  const authority = normalizeExecutionAuthority(executionAuthority, resources);
  const requirements = normalizeOutputRequirements(outputRequirements);
  const evidence = predecessorEvidence === undefined
    ? undefined
    : normalizePredecessorEvidence(predecessorEvidence);
  const identity = {
    schema: DELEGATE_INPUT_ENVELOPE_SCHEMA,
    attempt_id: attemptId,
    input_key: inputKey,
    sequence,
    input_kind: inputKind,
    instructions,
    task_inputs: taskInputs,
    resource_references: resources,
    execution_authority: authority,
    ...(evidence === undefined ? {} : { predecessor_evidence: evidence }),
    output_requirements: requirements,
  };
  return freezeCanonical({
    ...identity,
    envelope_digest: digest(identity),
  });
}

/**
 * Serialize an envelope exactly once. The payload digest is calculated from
 * the canonical bytes, so port and settlement code can compare what was
 * actually transmitted rather than a re-created prompt description.
 */
export function serializeDelegateInputEnvelope(envelope) {
  const canonical = assertEnvelope(envelope);
  const bytes = JSON.stringify(canonical);
  return Object.freeze({
    envelope: canonical,
    bytes,
    payload_sha256: digestDelegateInputBytes(bytes),
    // Keep the JS spelling available to callers that use the helper outside
    // the wire contract; requests and settlement records use snake_case.
    payloadSha256: digestDelegateInputBytes(bytes),
  });
}

export function parseDelegateInputEnvelope(bytes) {
  if (typeof bytes !== "string" || bytes.length === 0) {
    throw new DelegateInputEnvelopeError(
      "invalid_serialized_envelope",
      "delegate input bytes must be a non-empty string",
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(bytes);
  } catch {
    throw new DelegateInputEnvelopeError(
      "invalid_serialized_envelope",
      "delegate input bytes must be canonical JSON",
    );
  }
  const serialized = serializeDelegateInputEnvelope(envelope);
  if (serialized.bytes !== bytes) {
    throw new DelegateInputEnvelopeError(
      "non_canonical_envelope",
      "delegate input bytes must use canonical JSON serialization",
    );
  }
  return serialized;
}

export class DelegateInputEnvelopeError extends TypeError {
  constructor(reason, message) {
    super(message);
    this.name = "DelegateInputEnvelopeError";
    this.reason = reason;
  }
}

/**
 * Validate caller-selected task context before it reaches a delegate.
 * Preparation reuses this guard so invalid selections cannot become effects;
 * materialization keeps the same check as transport-time defense in depth.
 */
export function validateDelegateTaskInputs(taskInputs) {
  if (!isPlainRecord(taskInputs) ||
      taskInputs.schema !== DELEGATE_TASK_INPUTS_SCHEMA) {
    throw new DelegateInputEnvelopeError(
      "invalid_task_inputs",
      "delegate task inputs must use the versioned task-input schema",
    );
  }
  assertTransferableShape(taskInputs, "task_inputs");
  validateDelegateTransferValue(taskInputs, "task_inputs");
  return taskInputs;
}

/** Validate the caller-selected instruction string at the transport seam. */
export function validateDelegateInputInstructions(instructions) {
  requireNonEmptyString(instructions, "instructions");
  validateDelegateTransferValue(instructions, "instructions");
  return instructions;
}

/**
 * Apply the shared issue-79 policy to caller-selected delegate material.
 * Rejections intentionally expose only the stable safety code; rejected input
 * bytes and fragments must never be copied into a transport error.
 */
function validateDelegateTransferValue(value, field) {
  let request;
  try {
    request = createEvidenceSafetyRequest({
      classification: "delegate_evidence",
      allowed_use: ["delegate_transfer"],
      // Issue-79 treats a generic `id` key as potentially sensitive.  A
      // delegate task-input schema explicitly carries ordinary domain IDs;
      // scan those under a neutral structural key while still scanning every
      // ID value for credentials, paths, and encodings.
      input: field === "task_inputs"
        ? projectDelegateTaskInputSafety(value)
        : value,
    });
  } catch (error) {
    throw new DelegateInputEnvelopeError(
      "unsafe_delegate_input",
      `delegate ${field} failed evidence safety: ${error?.reason ?? "invalid_input"}`,
    );
  }
  const validation = validateEvidenceSafety(request);
  if (!validation.accepted) {
    throw new DelegateInputEnvelopeError(
      "unsafe_delegate_input",
      `delegate ${field} failed evidence safety: ${validation.rejection.code}`,
    );
  }
}

function projectDelegateTaskInputSafety(value) {
  if (Array.isArray(value)) return value.map(projectDelegateTaskInputSafety);
  if (!isPlainRecord(value)) return value;
  const isAuthorityWatermark =
    AUTHORITY_WATERMARK_SCHEMAS.has(value.schema);
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    const projectedKey = key === "id"
      ? "identifier"
      : isAuthorityWatermark && key === "authority"
      ? "authority_label"
      : key;
    if (Object.hasOwn(projected, projectedKey)) {
      throw new DelegateInputEnvelopeError(
        "unsafe_delegate_input",
        "delegate task_inputs contain duplicate identifier fields",
      );
    }
    projected[projectedKey] = projectDelegateTaskInputSafety(child);
  }
  return projected;
}

/** Validate the output schemas selected for a delegate card or envelope. */
export function validateDelegateOutputSchemas(schemas) {
  if (!Array.isArray(schemas) || schemas.length === 0 ||
      schemas.some((schema) =>
        typeof schema !== "string" || schema.length === 0)) {
    throw new DelegateInputEnvelopeError(
      "invalid_output_requirements",
      "delegate output requirements must name canonical JSON schemas",
    );
  }
  if (new Set(schemas).size !== schemas.length) {
    throw new DelegateInputEnvelopeError(
      "duplicate_output_schema",
      "delegate output schemas must be unique",
    );
  }
  return schemas;
}

/** Validate the validator contracts selected for a delegate envelope. */
export function validateDelegateValidatorContracts(validatorContracts) {
  if (!Array.isArray(validatorContracts) ||
      validatorContracts.some((contract) =>
        typeof contract !== "string" || contract.length === 0)) {
    throw new DelegateInputEnvelopeError(
      "invalid_output_requirements",
      "delegate output requirements must name canonical JSON schemas",
    );
  }
  if (new Set(validatorContracts).size !== validatorContracts.length) {
    throw new DelegateInputEnvelopeError(
      "duplicate_output_validator",
      "delegate output validators must be unique",
    );
  }
  return validatorContracts;
}

/** Validate and normalize the complete output requirement selection. */
export function validateDelegateOutputRequirements(requirements) {
  return normalizeOutputRequirements(requirements);
}

function assertEnvelope(envelope) {
  if (!isPlainRecord(envelope) ||
      envelope.schema !== DELEGATE_INPUT_ENVELOPE_SCHEMA ||
      !isDigest(envelope.envelope_digest)) {
    throw new DelegateInputEnvelopeError(
      "invalid_envelope",
      "delegate input envelope is incomplete",
    );
  }
  if (!hasOnlyKeys(envelope, [
        "schema",
        "attempt_id",
        "input_key",
        "sequence",
        "input_kind",
        "instructions",
        "task_inputs",
        "resource_references",
        "execution_authority",
        "predecessor_evidence",
        "output_requirements",
        "envelope_digest",
      ])) {
    throw new DelegateInputEnvelopeError(
      "unknown_envelope_field",
      "delegate input envelope contains an unknown field",
    );
  }
  const { envelope_digest: _digest, ...identity } = envelope;
  if (digest(identity) !== envelope.envelope_digest) {
    throw new DelegateInputEnvelopeError(
      "envelope_digest_mismatch",
      "delegate input envelope digest does not bind its canonical identity",
    );
  }
  const normalized = materializeDelegateInputEnvelope({
    attemptId: envelope.attempt_id,
    inputKey: envelope.input_key,
    sequence: envelope.sequence,
    inputKind: envelope.input_kind,
    instructions: envelope.instructions,
    taskInputs: envelope.task_inputs,
    resourceReferences: envelope.resource_references,
    executionAuthority: envelope.execution_authority,
    ...(Object.hasOwn(envelope, "predecessor_evidence") ? {
      predecessorEvidence: envelope.predecessor_evidence,
    } : {}),
    outputRequirements: envelope.output_requirements,
  });
  if (JSON.stringify(normalized) !== JSON.stringify(freezeCanonical(envelope))) {
    throw new DelegateInputEnvelopeError(
      "non_canonical_envelope",
      "delegate input envelope is not the exact normalized shape",
    );
  }
  return normalized;
}

function normalizeResourceReferences(resources) {
  if (!Array.isArray(resources)) {
    throw new DelegateInputEnvelopeError(
      "invalid_resource_references",
      "delegate resource references must be an array",
    );
  }
  const normalized = resources.map((resource) => {
    if (!isPlainRecord(resource) ||
        resource.schema !== DELEGATE_EXECUTION_RESOURCE_SCHEMA ||
        !RESOURCE_KINDS.has(resource.kind) ||
        typeof resource.authority !== "string" ||
        resource.authority.length === 0 ||
        typeof resource.contract !== "string" ||
        resource.contract.length === 0 ||
        typeof resource.subject_id !== "string" ||
        resource.subject_id.length === 0 ||
        resource.generation !== undefined &&
          (!Number.isSafeInteger(resource.generation) || resource.generation < 1) ||
        resource.mutation_epoch !== undefined &&
          (!Number.isSafeInteger(resource.mutation_epoch) ||
            resource.mutation_epoch < 0) ||
        resource.operation !== undefined &&
          (typeof resource.operation !== "string" ||
            resource.operation.length === 0) ||
        resource.access === "mutation" &&
          (typeof resource.operation !== "string" ||
            resource.operation.length === 0) ||
        !isDigest(resource.fingerprint) ||
        !RESOURCE_ACCESS.has(resource.access) ||
        !isPlainRecord(resource.authority_binding) ||
        resource.authority_binding.schema !==
          "flow.required-authority-binding/v1" ||
        typeof resource.authority_binding.id !== "string" ||
        resource.authority_binding.id.length === 0 ||
        typeof resource.authority_binding.contract !== "string" ||
        resource.authority_binding.contract.length === 0 ||
        !isPlainRecord(resource.authority_binding.provider_identity) ||
        typeof resource.authority_binding.provider_identity.id !== "string" ||
        resource.authority_binding.provider_identity.id.length === 0 ||
        !isPlainRecord(resource.authority_binding.observation)) {
      throw new DelegateInputEnvelopeError(
        "invalid_resource_references",
        "delegate resource references must bind exact owning authority facts",
      );
    }
    if (!hasOnlyKeys(resource, [
          "schema",
          "kind",
          "authority",
          "contract",
          "subject_id",
          "generation",
          "mutation_epoch",
          "fingerprint",
          "access",
          "operation",
          "authority_binding",
        ])) {
      throw new DelegateInputEnvelopeError(
        "unknown_resource_field",
        "delegate resource reference contains an unknown field",
      );
    }
    const expectedAuthority = RESOURCE_AUTHORITIES.get(resource.kind);
    if (expectedAuthority !== undefined && resource.authority !== expectedAuthority) {
      throw new DelegateInputEnvelopeError(
        "resource_authority_mismatch",
        "delegate resource reference does not name its owning authority",
      );
    }
    if (resource.contract !== DELEGATE_RESOURCE_CONTRACTS[resource.kind]) {
      throw new DelegateInputEnvelopeError(
        "resource_contract_mismatch",
        "delegate resource reference does not name its kind contract",
      );
    }
    let authorityBinding;
    try {
      [authorityBinding] = normalizeAuthorityBindings([
        resource.authority_binding,
      ]);
    } catch {
      throw new DelegateInputEnvelopeError(
        "invalid_resource_authority_binding",
        "delegate resource reference must carry an exact authority binding",
      );
    }
    const allowed = {
      schema: DELEGATE_EXECUTION_RESOURCE_SCHEMA,
      kind: resource.kind,
      authority: resource.authority,
      contract: resource.contract,
      subject_id: resource.subject_id,
      fingerprint: resource.fingerprint,
      access: resource.access,
      authority_binding: authorityBinding,
      ...(resource.generation === undefined ? {} : {
        generation: resource.generation,
      }),
      ...(resource.mutation_epoch === undefined ? {} : {
        mutation_epoch: resource.mutation_epoch,
      }),
      ...(resource.operation === undefined ? {} : {
        operation: resource.operation,
      }),
    };
    assertTransferableShape(allowed, "resource_references");
    return allowed;
  });
  const identities = normalized.map((resource) => digest(resource));
  if (new Set(identities).size !== identities.length) {
    throw new DelegateInputEnvelopeError(
      "duplicate_resource_reference",
      "delegate resource references must be unique",
    );
  }
  return normalized;
}

function normalizeExecutionAuthority(authority, resources) {
  if (!isPlainRecord(authority) ||
      authority.schema !== DELEGATE_EXECUTION_AUTHORITY_SCHEMA ||
      authority.owner !== "RunAuthority" ||
      typeof authority.capability !== "string" ||
      authority.capability.length === 0 ||
      !isDigest(authority.effective_authority_digest) ||
      !Array.isArray(authority.capability_envelope_ids) ||
      authority.capability_envelope_ids.some((id) =>
        typeof id !== "string" || id.length === 0)) {
    throw new DelegateInputEnvelopeError(
      "invalid_execution_authority",
      "delegate execution authority must name RunAuthority and accepted capabilities",
    );
  }
  if (!hasOnlyKeys(authority, [
        "schema",
        "owner",
        "capability",
        "effective_authority_digest",
        "capability_envelope_ids",
      ])) {
    throw new DelegateInputEnvelopeError(
      "unknown_execution_authority_field",
      "delegate execution authority contains an unknown field",
    );
  }
  const unique = [...new Set(authority.capability_envelope_ids)];
  if (unique.length !== authority.capability_envelope_ids.length) {
    throw new DelegateInputEnvelopeError(
      "duplicate_capability_binding",
      "delegate capability envelope identities must be unique",
    );
  }
  if (resources.some(({ access }) => access === "mutation") &&
      !MUTATING_CAPABILITIES.has(authority.capability)) {
    throw new DelegateInputEnvelopeError(
      "resource_access_mismatch",
      "execution authority cannot select mutation resources",
    );
  }
  // A resource reference's owning authority remains separate from Flow's
  // capability decision. This check only enforces that the selected list is
  // canonical; it never copies the capability envelope or its secrets.
  if (!Array.isArray(resources)) throw new DelegateInputEnvelopeError(
    "invalid_resource_references",
    "delegate resource references must be normalized before authority",
  );
  return {
    schema: DELEGATE_EXECUTION_AUTHORITY_SCHEMA,
    owner: "RunAuthority",
    capability: authority.capability,
    effective_authority_digest: authority.effective_authority_digest,
    capability_envelope_ids: [...unique].sort(),
  };
}

function normalizeOutputRequirements(requirements) {
  if (!isPlainRecord(requirements) ||
      requirements.schema !== DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA ||
      requirements.format !== "canonical-json") {
    throw new DelegateInputEnvelopeError(
      "invalid_output_requirements",
      "delegate output requirements must name canonical JSON schemas",
    );
  }
  if (!hasOnlyKeys(requirements, [
        "schema",
        "format",
        "schemas",
        "validator_contracts",
      ])) {
    throw new DelegateInputEnvelopeError(
      "unknown_output_requirement_field",
      "delegate output requirements contain an unknown field",
    );
  }
  validateDelegateOutputSchemas(requirements.schemas);
  validateDelegateValidatorContracts(requirements.validator_contracts);
  return {
    schema: DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
    format: "canonical-json",
    schemas: [...requirements.schemas],
    validator_contracts: [...requirements.validator_contracts],
  };
}

function normalizePredecessorEvidence(evidence) {
  if (!isPlainRecord(evidence) ||
      !["flow.authority-materialized-evidence/v1",
        "flow.authority-materialized-delegate-evidence/v1"].includes(
        evidence.schema,
      )) {
    throw new DelegateInputEnvelopeError(
      "invalid_predecessor_evidence",
      "delegate predecessor evidence must be an authority-materialized envelope",
    );
  }
  if (evidence.schema === "flow.authority-materialized-delegate-evidence/v1" &&
      !hasOnlyKeys(evidence, ["schema", "accepted_delegates"])) {
    throw new DelegateInputEnvelopeError(
      "unknown_predecessor_evidence_field",
      "delegate predecessor evidence contains an unknown field",
    );
  }
  if (evidence.schema === "flow.authority-materialized-delegate-evidence/v1") {
    validateAcceptedDelegateEntries(evidence.accepted_delegates);
  }
  if (evidence.schema === "flow.authority-materialized-evidence/v1" &&
      !hasOnlyKeys(evidence, [
        "schema",
        "evidence_digest",
        "accepted_delegates",
        "operation_receipts",
        "verify_receipt",
      ])) {
    throw new DelegateInputEnvelopeError(
      "unknown_predecessor_evidence_field",
      "delegate predecessor evidence contains an unknown field",
    );
  }
  if (evidence.schema === "flow.authority-materialized-evidence/v1") {
    if (Object.hasOwn(evidence, "accepted_delegates")) {
      validateAcceptedDelegateEntries(evidence.accepted_delegates);
    }
    if (Object.hasOwn(evidence, "operation_receipts")) {
      validateOperationReceiptEntries(evidence.operation_receipts);
    }
    if (Object.hasOwn(evidence, "verify_receipt") &&
        !isPlainRecord(evidence.verify_receipt)) {
      throw new DelegateInputEnvelopeError(
        "invalid_predecessor_evidence",
        "delegate predecessor evidence verify receipt must be an object",
      );
    }
  }
  assertTransferableShape(evidence, "predecessor_evidence");
  if (evidence.schema === "flow.authority-materialized-evidence/v1") {
    const { evidence_digest: _digest, ...identity } = evidence;
    if (!isDigest(evidence.evidence_digest) ||
        digest(identity) !== evidence.evidence_digest) {
      throw new DelegateInputEnvelopeError(
        "invalid_predecessor_evidence_digest",
        "delegate predecessor evidence digest is not self-bound",
      );
    }
  }
  return evidence;
}

function validateAcceptedDelegateEntries(entries) {
  if (!Array.isArray(entries) || entries.some((entry) =>
      !isPlainRecord(entry) ||
      !hasOnlyKeys(entry, [
        "card_id",
        "effect_id",
        "attempt_id",
        "idempotency_key",
        "source_authority_watermark",
        "evidence",
      ]) ||
      !nonEmptyString(entry.card_id) ||
      !nonEmptyString(entry.effect_id) ||
      !nonEmptyString(entry.attempt_id) ||
      !nonEmptyString(entry.idempotency_key) ||
      !isDigest(entry.source_authority_watermark) ||
      !isPlainRecord(entry.evidence) ||
      !isDelegateEvidenceSafetyValid(entry.evidence))) {
    throw new DelegateInputEnvelopeError(
      "invalid_predecessor_evidence",
      "delegate predecessor evidence accepted delegates have invalid provenance",
    );
  }
}

function isDelegateEvidenceSafetyValid(providerReceipt) {
  if (providerReceipt.schema !== "flow.delegate-evidence/v1" ||
      typeof providerReceipt.validated_output !== "string" ||
      !isPlainRecord(providerReceipt.evidence_safety_receipt) ||
      !isPlainRecord(providerReceipt.evidence_safety_binding)) {
    return false;
  }
  const expected = validateDelegateEvidenceSafety(
    providerReceipt.validated_output,
    { classification: providerReceipt.evidence_safety_receipt.classification },
  );
  return expected.accepted === true &&
    JSON.stringify(expected.receipt) ===
      JSON.stringify(providerReceipt.evidence_safety_receipt) &&
    JSON.stringify(expected.binding) ===
      JSON.stringify(providerReceipt.evidence_safety_binding);
}

function validateOperationReceiptEntries(entries) {
  if (!Array.isArray(entries) || entries.some((entry) =>
      !isPlainRecord(entry) ||
      !hasOnlyKeys(entry, [
        "card_id",
        "effect_id",
        "attempt_id",
        "idempotency_key",
        "source_authority_watermark",
        "receipt",
      ]) ||
      !nonEmptyString(entry.card_id) ||
      !nonEmptyString(entry.effect_id) ||
      !nonEmptyString(entry.attempt_id) ||
      !nonEmptyString(entry.idempotency_key) ||
      !isDigest(entry.source_authority_watermark) ||
      !isPlainRecord(entry.receipt))) {
    throw new DelegateInputEnvelopeError(
      "invalid_predecessor_evidence",
      "delegate predecessor evidence operation receipts have invalid provenance",
    );
  }
}

function assertTransferableShape(value, context) {
  visit(value, context, new Set());
}

function visit(value, context, ancestors) {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    throw new DelegateInputEnvelopeError(
      "cyclic_input",
      `${context} must not contain cycles`,
    );
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((child) => visit(child, context, ancestors));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizeTransferableKey(key);
      if (FORBIDDEN_KEYS.has(normalizedKey) ||
          /(?:password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/iu
            .test(normalizedKey)) {
        throw new DelegateInputEnvelopeError(
          "forbidden_input_material",
          `${context} contains forbidden material`,
        );
      }
      if (normalizedKey === "graph" || normalizedKey === "explicit_facts" ||
          normalizedKey === "bundle_digest" ||
          normalizedKey === "confirmation_digest") {
        throw new DelegateInputEnvelopeError(
          "full_bundle_forbidden",
          `${context} must not carry the prepared bundle`,
        );
      }
      visit(child, context, ancestors);
    }
  }
  ancestors.delete(value);
}

function normalizeTransferableKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DelegateInputEnvelopeError(
      `invalid_${field}`,
      `delegate ${field} must be a non-empty string`,
    );
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function hasOnlyKeys(value, allowedKeys) {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(value);
  return keys.length === Object.keys(value).length &&
    keys.every((key) => typeof key === "string" && allowed.has(key));
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

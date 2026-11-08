import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

import { digest } from "./canonical.mjs";

export const FEATURE_CAPTURE_OPERATION_CONTRACT =
  "flow.operation/feature-capture/v1";
export const FEATURE_CAPTURE_RECEIPT_SCHEMA =
  "work.feature-capture-receipt/v1";
export const FEATURE_CAPTURE_RECEIPT_VALIDATOR =
  "flow.validator/feature-capture-receipt/v1";

const RECEIPT_KEYS = Object.freeze([
  "artifacts",
  "attempt_id",
  "effect_id",
  "git",
  "idempotency_key",
  "operation_contract",
  "outcome",
  "receipt_digest",
  "schema",
  "self_digest",
  "source_authority_watermark",
  "workspace",
]);

const ARTIFACT_KEYS = Object.freeze([
  "artifact_schema",
  "bytes_digest",
  "digest",
  "size",
]);

const GIT_KEYS = Object.freeze([
  "clean",
  "commit_sha",
  "ref",
  "tree_sha",
]);

const WORKSPACE_KEYS = Object.freeze([
  "fingerprint",
  "generation",
  "git",
  "mutation_epoch",
  "subject_id",
]);

/**
 * Build the trusted registered operation used by feature/v1 capture cards.
 * The provider observes the post mutation workspace and returns the strict
 * receipt that RunAuthority records as the producer result.
 */
export function createFeatureCaptureOperation({
  observe,
  storeArtifacts,
  reconcile,
} = {}) {
  if (typeof observe !== "function") {
    throw new TypeError("feature capture operation requires an observer");
  }
  if (storeArtifacts !== undefined && typeof storeArtifacts !== "function") {
    throw new TypeError("feature capture artifact storage must be a function");
  }
  if (reconcile !== undefined && typeof reconcile !== "function") {
    throw new TypeError("feature capture operation reconciliation must be a function");
  }
  const capturedReceipts = new Map();
  const receiptKey = (intent) => [
    intent?.effect_id,
    intent?.idempotency_key,
  ].join("\0");
  const reconcileReceipt = async (intent) => {
    const discovered = capturedReceipts.get(receiptKey(intent)) ??
      await reconcile?.(intent);
    if (discovered?.schema === "flow.effect-observation/v1") {
      return discovered;
    }
    const providerReceipt = discovered?.receipt ?? discovered;
    if (providerReceipt === undefined || providerReceipt === null) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "indeterminate",
        causation: null,
        provider_observation: {
          schema: "flow.feature-capture-reconciliation/v1",
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
          presence: "indeterminate",
        },
      };
    }
    return {
      schema: "flow.effect-observation/v1",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      presence: "present",
      causation: {
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
      },
      provider_observation: providerReceipt,
    };
  };
  return Object.freeze({
    schema: "flow.registered-operation/v1",
    classification: "reconcilable",
    provider_receipt_validator: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    validateReceipt: validateFeatureCaptureReceipt,
    observe: reconcileReceipt,
    reconcile: reconcileReceipt,
    async invoke(intent) {
      const observed = await observe(intent);
      const providerReceipt = observed?.receipt ?? observed;
      const rawArtifacts = observed?.receipt === undefined
        ? undefined
        : observed.artifacts;
      if (!Array.isArray(rawArtifacts) || rawArtifacts.length === 0) {
        throw captureError(
          "feature_capture_artifact_bytes_missing",
          "feature capture must return the observed artifact bytes",
        );
      }
      if (typeof storeArtifacts !== "function") {
        throw captureError(
          "feature_capture_artifact_storage_missing",
          "feature capture requires authority-owned artifact storage",
        );
      }
      if (validateFeatureCaptureReceipt(providerReceipt, intent) !== true) {
        throw captureError(
          "feature_capture_receipt_invalid",
          "feature capture receipt failed its strict provider contract",
        );
      }
      const artifacts = observedArtifacts(providerReceipt, rawArtifacts);
      const storageReceipt = await storeArtifacts({ intent, artifacts });
      if (storageReceipt?.accepted === false || storageReceipt === false) {
        throw captureError(
          "feature_capture_artifact_storage_rejected",
          "authority-owned artifact storage rejected the capture",
        );
      }
      capturedReceipts.set(receiptKey(intent), providerReceipt);
      return {
        schema: "flow.effect-receipt/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        outcome: "succeeded",
        provider_receipt: providerReceipt,
      };
    },
  });
}

/**
 * Validate one post mutation feature capture at the registered-operation
 * boundary. Candidate Git and artifact identities are accepted only from the
 * provider receipt created after the capture intent is admitted.
 */
export function validateFeatureCaptureReceipt(receipt, intent) {
  const startingWorkspace = intent?.operation_input?.workspace;
  const identity = stripReceiptDigests(receipt);
  return isRecord(receipt) &&
    exactKeys(receipt, RECEIPT_KEYS) &&
    receipt.schema === FEATURE_CAPTURE_RECEIPT_SCHEMA &&
    receipt.operation_contract === FEATURE_CAPTURE_OPERATION_CONTRACT &&
    receipt.outcome === "captured" &&
    receipt.effect_id === intent?.effect_id &&
    receipt.attempt_id === intent?.attempt_id &&
    receipt.idempotency_key === intent?.idempotency_key &&
    receipt.source_authority_watermark === intent?.source_authority_watermark &&
    isDigest(receipt.source_authority_watermark) &&
    validGit(receipt.git) &&
    receipt.git.clean === true &&
    validWorkspace(receipt.workspace, startingWorkspace) &&
    isDeepStrictEqual(receipt.workspace.git, receipt.git) &&
    receipt.workspace.fingerprint === digest({ git: receipt.git }) &&
    receipt.workspace.fingerprint !== startingWorkspace?.fingerprint &&
    Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 &&
    receipt.artifacts.every(validArtifact) &&
    new Set(receipt.artifacts.map(({ digest: value }) => value)).size ===
      receipt.artifacts.length &&
    isDigest(receipt.receipt_digest) &&
    isDigest(receipt.self_digest) &&
    receipt.receipt_digest === receipt.self_digest &&
    digest(identity) === receipt.receipt_digest;
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

function validArtifact(artifact) {
  return isRecord(artifact) &&
    exactKeys(artifact, ARTIFACT_KEYS) &&
    isDigest(artifact.digest) &&
    artifact.bytes_digest === artifact.digest &&
    nonEmpty(artifact.artifact_schema) &&
    Number.isSafeInteger(artifact.size) && artifact.size >= 0;
}

function observedArtifacts(receipt, rawArtifacts) {
  if (!isRecord(receipt) || !Array.isArray(receipt.artifacts) ||
      receipt.artifacts.length !== rawArtifacts.length) {
    throw captureError(
      "feature_capture_artifact_descriptor_mismatch",
      "capture artifact descriptors do not match observed bytes",
    );
  }
  return rawArtifacts.map((rawArtifact, index) => {
    if (!isRecord(rawArtifact) || !nonEmpty(rawArtifact.artifact_schema) ||
        !(Buffer.isBuffer(rawArtifact.bytes) ||
          rawArtifact.bytes instanceof Uint8Array)) {
      throw captureError(
        "feature_capture_artifact_bytes_invalid",
        "capture artifact bytes are not a byte sequence",
      );
    }
    const bytes = Buffer.from(rawArtifact.bytes);
    const bytesDigest = byteDigest(bytes);
    const observed = receipt.artifacts[index];
    if (!isRecord(observed) ||
        observed.artifact_schema !== rawArtifact.artifact_schema ||
        observed.digest !== bytesDigest ||
        observed.bytes_digest !== bytesDigest ||
        observed.size !== bytes.length) {
      throw captureError(
        "feature_capture_artifact_descriptor_mismatch",
        "capture artifact descriptors do not match observed bytes",
      );
    }
    return {
      artifact_schema: rawArtifact.artifact_schema,
      bytes,
      bytes_digest: bytesDigest,
      digest: bytesDigest,
      size: bytes.length,
    };
  });
}

function byteDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function captureError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function validWorkspace(workspace, startingWorkspace) {
  return isRecord(workspace) &&
    exactKeys(workspace, WORKSPACE_KEYS) &&
    nonEmpty(workspace.subject_id) &&
    workspace.subject_id === startingWorkspace?.subject_id &&
    Number.isSafeInteger(workspace.generation) && workspace.generation >= 1 &&
    Number.isSafeInteger(workspace.mutation_epoch) &&
      workspace.mutation_epoch >= 1 &&
    isRecord(workspace.git) &&
    workspace.generation > (startingWorkspace?.generation ?? 0) &&
    workspace.mutation_epoch > (startingWorkspace?.mutation_epoch ?? -1);
}

function validGit(git) {
  return isRecord(git) && exactKeys(git, GIT_KEYS) &&
    typeof git.commit_sha === "string" && /^[0-9a-f]{40,64}$/u.test(git.commit_sha) &&
    typeof git.tree_sha === "string" && /^[0-9a-f]{40,64}$/u.test(git.tree_sha) &&
    nonEmpty(git.ref) && typeof git.clean === "boolean";
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

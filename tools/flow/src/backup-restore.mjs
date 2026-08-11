import { canonicalize, digest, freezeCanonical } from "./canonical.mjs";
import { createRejection } from "./rejection.mjs";

export const BACKUP_MANIFEST_SCHEMA = "flow.backup-manifest/v1";
export const BACKUP_RECEIPT_SCHEMA = "flow.backup-receipt/v1";
export const BACKUP_INTENT_SCHEMA = "flow.backup-intent/v1";
export const BACKUP_RECONCILIATION_OBSERVATION_SCHEMA =
  "flow.backup-reconciliation-observation/v1";
export const BACKUP_PROVIDER_EVIDENCE_SCHEMA =
  "flow.backup-provider-evidence/v1";
export const DROVR_HANDOFF_RECEIPT_SCHEMA =
  "flow.drovr-handoff-receipt/v1";
export const RESTORE_INTENT_SCHEMA = "flow.restore-intent/v1";
export const RESTORE_RECEIPT_SCHEMA = "flow.restore-receipt/v1";
export const RESTORE_BARRIER_SCHEMA = "flow.restore-barrier-projection/v1";

// These component names are deliberately closed. A restore that does not
// account for one of them cannot be admitted, even when the remaining
// components happen to match.
export const BACKUP_COMPONENTS = Object.freeze([
  "replacement_authority",
  "artifacts",
  "legacy_roots",
  "external_pointers",
  "drovr_obligations",
]);

// Restore names the six system-boundary domains independently even though
// their deterministic backup values are grouped into the public manifest
// categories above. This keeps physical Git and filesystem evidence visible
// rather than treating them as an incidental property of a database stream.
export const RESTORE_EVIDENCE_DOMAINS = Object.freeze([
  "database_streams",
  "artifact_state",
  "git_state",
  "filesystem_state",
  "external_effects",
  "drovr_obligations",
]);

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

export function createBackupManifest(observation) {
  const normalized = normalizeBackupObservation(observation);
  const body = {
    schema: BACKUP_MANIFEST_SCHEMA,
    version: 1,
    replacement_authority: normalized.replacement_authority,
    artifacts: normalized.artifacts,
    legacy_roots: normalized.legacy_roots,
    external_pointers: normalized.external_pointers,
    drovr_obligations: normalized.drovr_obligations,
  };
  return freezeCanonical({
    ...body,
    manifest_digest: digest(body),
  });
}

export function validateBackupManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      manifest.schema !== BACKUP_MANIFEST_SCHEMA ||
      manifest.version !== 1 ||
      !Object.hasOwn(manifest, "manifest_digest")) {
    throw invalidBackup("invalid_backup_manifest");
  }
  let normalized;
  try {
    normalized = createBackupManifest(manifest);
  } catch {
    throw invalidBackup("invalid_backup_manifest");
  }
  if (normalized.manifest_digest !== manifest.manifest_digest ||
      !sameCanonicalKeys(manifest, normalized)) {
    throw invalidBackup("backup_manifest_digest_mismatch");
  }
  validateManifestStructure(normalized);
  return normalized;
}

export function normalizeBackupObservation(observation) {
  if (observation === null || typeof observation !== "object" ||
      Array.isArray(observation)) {
    throw invalidBackup("backup_observation_unavailable");
  }
  for (const component of BACKUP_COMPONENTS) {
    if (!Object.hasOwn(observation, component)) {
      throw invalidBackup(`backup_observation_missing_${component}`);
    }
  }
  try {
    return freezeCanonical({
      replacement_authority: normalizeReplacementAuthority(
        observation.replacement_authority,
      ),
      artifacts: normalizeCollection(observation.artifacts),
      legacy_roots: normalizeCollection(observation.legacy_roots),
      external_pointers: normalizeCollection(observation.external_pointers, "effect_id"),
      drovr_obligations: normalizeCollection(observation.drovr_obligations, "turn_id"),
    });
  } catch (error) {
    if (error?.code === "invalid_backup_observation") throw error;
    throw invalidBackup("backup_observation_corrupt");
  }
}

export function reconcileBackupObservation(manifest, observation) {
  const expected = validateBackupManifest(manifest);
  const components = BACKUP_COMPONENTS.map((component) => {
    const result = reconcileEvidence(
      component,
      expected[component],
      observation?.[component],
    );
    return {
      component,
      ...result,
    };
  });
  const evidenceDomains = RESTORE_EVIDENCE_DOMAINS.map((domain) => {
    const expectedValue = evidenceDomainValue(expected, domain, false);
    const candidate = evidenceDomainValue(observation, domain, true);
    const result = reconcileEvidence(domain, expectedValue, candidate);
    return {
      domain,
      ...result,
    };
  });
  return freezeCanonical({
    schema: "flow.restore-reconciliation/v1",
    manifest_digest: expected.manifest_digest,
    components,
    evidence_domains: evidenceDomains,
    complete: components.every(({ status }) => status === "reconciled") &&
      evidenceDomains.every(({ status }) => status === "reconciled"),
    reconciliation_digest: digest({
      schema: "flow.restore-reconciliation/v1",
      manifest_digest: expected.manifest_digest,
      components,
      evidence_domains: evidenceDomains,
    }),
  });
}

function reconcileEvidence(name, expectedValue, candidate) {
  const expectedDigest = expectedValue === undefined
    ? null
    : digest(expectedValue);
  let normalizedCandidate;
  try {
    normalizedCandidate = normalizeReconciliationValue(candidate);
  } catch {
    normalizedCandidate = {
      status: "corrupt",
      digest: null,
      reason: "evidence_corrupt",
    };
  }
  const semantic = semanticEvidence(name, expectedValue, candidate);
  if (semantic !== null) {
    return {
      expected_digest: semantic.expected_digest ?? expectedDigest,
      observed_digest: semantic.observed_digest ?? normalizedCandidate.digest,
      status: semantic.status,
      ...(semantic.status === "reconciled" ? {} : {
        reason: semantic.reason,
      }),
    };
  }
  const status = expectedDigest === null
    ? "indeterminate"
    : normalizedCandidate.status === "missing"
      ? "missing_evidence"
      : normalizedCandidate.status === "corrupt"
        ? "corrupt_evidence"
        : normalizedCandidate.status === "indeterminate"
          ? "indeterminate"
          : normalizedCandidate.digest === expectedDigest
            ? "reconciled"
            : candidate === undefined
              ? "missing_evidence"
              : "mismatch";
  return {
    expected_digest: expectedDigest,
    observed_digest: normalizedCandidate.digest,
    status,
    ...(status === "reconciled" ? {} : {
      reason: normalizedCandidate.reason ??
        (expectedDigest === null ? "manifest_evidence_missing" : status),
    }),
  };
}

function semanticEvidence(name, expectedValue, candidate) {
  if (name === "replacement_authority") {
    if (candidate === undefined) {
      return {
        status: "missing_evidence",
        reason: "replacement_authority_evidence_missing",
      };
    }
    const candidateIssue = replacementAuthorityIssue(candidate);
    if (candidateIssue !== null) {
      return {
        status: "corrupt_evidence",
        reason: `replacement_authority_${candidateIssue}`,
      };
    }
    let normalizedCandidate;
    try {
      normalizedCandidate = normalizeReplacementAuthority(candidate);
    } catch {
      return {
        status: "corrupt_evidence",
        reason: "replacement_authority_identity_corrupt",
      };
    }
    return digest(normalizedCandidate) === digest(expectedValue)
      ? {
          status: "reconciled",
          expected_digest: digest(expectedValue),
          observed_digest: digest(normalizedCandidate),
        }
      : {
          status: "mismatch",
          expected_digest: digest(expectedValue),
          observed_digest: digest(normalizedCandidate),
          reason: "replacement_authority_identity_mismatch",
        };
  }
  if (name === "database_streams") {
    const expectedIssue = databaseStreamIssue(expectedValue);
    const candidateIssue = databaseStreamIssue(candidate);
    if (expectedIssue === "missing") {
      if (candidateIssue !== null) {
        return {
          status: candidateIssue === "missing"
            ? "missing_evidence"
            : "corrupt_evidence",
          reason: candidateIssue === "missing"
            ? "database_stream_evidence_missing"
            : `database_stream_${candidateIssue}`,
        };
      }
      return {
        status: "indeterminate",
        reason: "database_stream_manifest_missing",
        expected_digest: null,
        observed_digest: digest(candidate),
      };
    }
    if (expectedIssue !== null) {
      return {
        status: "corrupt_evidence",
        reason: `database_stream_${expectedIssue}_in_manifest`,
      };
    }
    if (candidateIssue !== null) {
      return {
        status: candidateIssue === "missing"
          ? "missing_evidence"
          : "corrupt_evidence",
        reason: candidateIssue === "missing"
          ? "database_stream_evidence_missing"
          : `database_stream_${candidateIssue}`,
      };
    }
    const expectedById = new Map(expectedValue.map((entry) => [entry.id, entry]));
    const candidateById = new Map(candidate.map((entry) => [entry.id, entry]));
    if (expectedById.size !== candidateById.size ||
        [...expectedById].some(([id, entry]) =>
          candidateById.get(id)?.suffix !== entry.suffix)) {
      return {
        status: "mismatch",
        reason: "database_stream_identity_mismatch",
      };
    }
    return {
      status: "reconciled",
      expected_digest: digest(expectedValue),
      observed_digest: digest(normalizeCollection(candidate, "id")),
    };
  }
  if (name === "filesystem_state") {
    return reconcileIdentityCollectionEvidence(
      expectedValue,
      candidate,
      "path",
      "filesystem_state",
      filesystemStateIssue,
    );
  }
  if (name === "legacy_roots") {
    return reconcileIdentityCollectionEvidence(
      expectedValue,
      candidate,
      "path",
      "legacy_root",
      legacyRootIssue,
    );
  }
  if (name === "git_state") {
    if (gitStateIssue(expectedValue) !== null) {
      return {
        status: "corrupt_evidence",
        reason: `git_state_${gitStateIssue(expectedValue)}_in_manifest`,
      };
    }
    const candidateIssue = gitStateIssue(candidate);
    if (candidateIssue !== null) {
      return {
        status: candidate === undefined ? "missing_evidence" : "corrupt_evidence",
        reason: candidate === undefined
          ? "git_state_evidence_missing"
          : `git_state_${candidateIssue}`,
      };
    }
    return digest(expectedValue) === digest(candidate)
      ? { status: "reconciled", expected_digest: digest(expectedValue), observed_digest: digest(candidate) }
      : { status: "mismatch", reason: "git_state_mismatch" };
  }
  if (name === "artifacts" || name === "artifact_state") {
    const expectedIssue = artifactIssue(expectedValue);
    if (expectedIssue !== null && expectedIssue !== "missing") {
      return {
        status: "corrupt_evidence",
        reason: `artifact_${expectedIssue}_in_manifest`,
      };
    }
    const candidateIssue = artifactIssue(candidate);
    if (candidateIssue !== null) {
      return {
        status: candidateIssue === "missing"
          ? "missing_evidence"
          : "corrupt_evidence",
        reason: candidateIssue === "missing"
          ? "artifact_evidence_missing"
          : `artifact_${candidateIssue}`,
      };
    }
    const normalizedExpected = normalizeCollection(expectedValue, "digest");
    const normalizedCandidate = normalizeCollection(candidate, "digest");
    const expectedByDigest = new Map(
      normalizedExpected.map((entry) => [entry.digest, entry]),
    );
    const candidateByDigest = new Map(
      normalizedCandidate.map((entry) => [entry.digest, entry]),
    );
    if (expectedByDigest.size !== candidateByDigest.size) {
      return {
        status: "mismatch",
        reason: "artifact_identity_mismatch",
      };
    }
    for (const [artifactDigest, expectedEntry] of expectedByDigest) {
      const candidateEntry = candidateByDigest.get(artifactDigest);
      if (!candidateEntry) {
        return {
          status: "missing_evidence",
          reason: "artifact_evidence_missing",
        };
      }
      if (digest(candidateEntry) !== digest(expectedEntry)) {
        return {
          status: "mismatch",
          reason: "artifact_identity_mismatch",
        };
      }
    }
    return {
      status: "reconciled",
      expected_digest: digest(normalizedExpected),
      observed_digest: digest(normalizedCandidate),
    };
  }
  if (["external_effects", "external_pointers"].includes(name)) {
    return reconcileSettlementEvidence(
      expectedValue,
      candidate,
      "effect_id",
      "external_effect",
    );
  }
  if (name === "drovr_obligations") {
    return reconcileSettlementEvidence(
      expectedValue,
      candidate,
      "turn_id",
      "drovr_obligation",
    );
  }
  return null;
}

function reconcileIdentityCollectionEvidence(
  expectedValue,
  candidate,
  identityKey,
  kind,
  issue,
) {
  if (expectedValue === undefined || expectedValue === null) return null;
  const expectedIssue = issue(expectedValue);
  if (expectedIssue !== null) {
    return {
      status: "corrupt_evidence",
      reason: `${kind}_${expectedIssue}_in_manifest`,
    };
  }
  if (candidate === undefined) {
    return {
      status: "missing_evidence",
      reason: `${kind}_evidence_missing`,
    };
  }
  const candidateIssue = issue(candidate);
  if (candidateIssue !== null) {
    return {
      status: "corrupt_evidence",
      reason: `${kind}_${candidateIssue}`,
    };
  }
  const normalizedExpected = normalizeCollection(expectedValue, identityKey);
  const normalizedCandidate = normalizeCollection(candidate, identityKey);
  const expectedByIdentity = new Map(normalizedExpected.map((entry) => [
    entry[identityKey],
    entry,
  ]));
  const candidateByIdentity = new Map(normalizedCandidate.map((entry) => [
    entry[identityKey],
    entry,
  ]));
  if (expectedByIdentity.size !== candidateByIdentity.size ||
      [...expectedByIdentity].some(([identity, entry]) =>
        digest(candidateByIdentity.get(identity)) !== digest(entry))) {
    return {
      status: "mismatch",
      expected_digest: digest(normalizedExpected),
      observed_digest: digest(normalizedCandidate),
      reason: `${kind}_identity_mismatch`,
    };
  }
  return {
    status: "reconciled",
    expected_digest: digest(normalizedExpected),
    observed_digest: digest(normalizedCandidate),
  };
}

function databaseStreamIssue(value) {
  if (value === undefined || value === null) return "missing";
  if (!Array.isArray(value)) return "records_corrupt";
  const ids = new Set();
  for (const stream of value) {
    if (stream === null || typeof stream !== "object" || Array.isArray(stream) ||
        typeof stream.id !== "string" || stream.id.length === 0) {
      return "identity_corrupt";
    }
    if (ids.has(stream.id)) return "duplicate";
    ids.add(stream.id);
    if (typeof stream.suffix !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(stream.suffix)) {
      return "suffix_corrupt";
    }
  }
  return null;
}

function replacementAuthorityIssue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "identity_corrupt";
  }
  if (Object.hasOwn(value, "database_streams") &&
      databaseStreamIssue(value.database_streams) !== null) {
    return `database_stream_${databaseStreamIssue(value.database_streams)}`;
  }
  if (Object.hasOwn(value, "filesystem_state") &&
      filesystemStateIssue(value.filesystem_state) !== null) {
    return `filesystem_state_${filesystemStateIssue(value.filesystem_state)}`;
  }
  if (Object.hasOwn(value, "git_state") &&
      gitStateIssue(value.git_state) !== null) {
    return `git_state_${gitStateIssue(value.git_state)}`;
  }
  return null;
}

function legacyRootIssue(value) {
  if (!Array.isArray(value)) return "records_corrupt";
  const paths = new Set();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" ||
        Array.isArray(entry) || typeof entry.path !== "string" ||
        entry.path.length === 0 || paths.has(entry.path) ||
        typeof entry.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) {
      return "identity_corrupt";
    }
    paths.add(entry.path);
  }
  return null;
}

function artifactIssue(value) {
  if (value === undefined || value === null) return "missing";
  if (!Array.isArray(value)) return "records_corrupt";
  const digests = new Set();
  for (const artifact of value) {
    if (artifact === null || typeof artifact !== "object" ||
        Array.isArray(artifact) ||
        typeof artifact.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) {
      return "identity_corrupt";
    }
    if (digests.has(artifact.digest)) return "duplicate";
    digests.add(artifact.digest);
    if (typeof artifact.bytes_digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(artifact.bytes_digest)) {
      return "bytes_digest_corrupt";
    }
    if (artifact.byte_availability !== "available") {
      return "bytes_unavailable";
    }
  }
  return null;
}

function validateManifestStructure(manifest) {
  const authority = manifest.replacement_authority;
  if (authority === null || typeof authority !== "object" ||
      Array.isArray(authority) || Object.hasOwn(authority, "git") ||
      Object.hasOwn(authority, "filesystem") ||
      databaseStreamIssue(authority.database_streams) !== null ||
      gitStateIssue(authority.git_state) !== null ||
      filesystemStateIssue(authority.filesystem_state) !== null) {
    throw invalidBackup("invalid_backup_manifest");
  }
  if (artifactIssue(manifest.artifacts) !== null ||
      !validManifestSettlementEntries(manifest.external_pointers, "effect_id") ||
      !validManifestSettlementEntries(manifest.drovr_obligations, "turn_id") ||
      manifest.legacy_roots.some((entry) =>
        entry === null || typeof entry !== "object" ||
        typeof entry.path !== "string" || entry.path.length === 0 ||
        typeof entry.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest))) {
    throw invalidBackup("invalid_backup_manifest");
  }
}

function validManifestSettlementEntries(value, identityKey) {
  return validSettlementEntries(value, identityKey) && value.every((entry) =>
    entry.receipt === undefined ||
      validateSettlementReceipt(entry.receipt, entry, identityKey) === "present",
  );
}

function filesystemStateIssue(value) {
  if (!Array.isArray(value)) return "records_corrupt";
  const paths = new Set();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" ||
        typeof entry.path !== "string" || entry.path.length === 0 ||
        paths.has(entry.path) || typeof entry.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) {
      return "identity_corrupt";
    }
    paths.add(entry.path);
  }
  return null;
}

function gitStateIssue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "identity_corrupt";
  }
  for (const field of ["commit", "tree"]) {
    if (typeof value[field] !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(value[field])) {
      return "identity_corrupt";
    }
  }
  if (typeof value.clean !== "boolean") return "state_corrupt";
  return null;
}

function reconcileSettlementEvidence(
  expectedValue,
  candidate,
  identityKey,
  kind,
) {
  if (!validSettlementEntries(expectedValue, identityKey)) {
    return {
      status: "corrupt_evidence",
      reason: `${kind}_identity_corrupt_in_manifest`,
    };
  }
  if (!Array.isArray(candidate)) {
    return {
      status: candidate === undefined ? "missing_evidence" : "corrupt_evidence",
      reason: candidate === undefined
        ? `${kind}_evidence_missing`
        : `${kind}_identity_corrupt`,
    };
  }
  const expectedByIdentity = new Map(
    expectedValue.map((entry) => [entry[identityKey], entry]),
  );
  if (expectedByIdentity.size !== expectedValue.length) {
    return {
      status: "corrupt_evidence",
      reason: `${kind}_identity_duplicate_in_manifest`,
    };
  }
  const candidateByIdentity = new Map();
  for (const entry of candidate) {
    if (!validSettlementEntry(entry, identityKey) ||
        candidateByIdentity.has(entry[identityKey])) {
      return {
        status: "corrupt_evidence",
        reason: `${kind}_identity_corrupt`,
      };
    }
    candidateByIdentity.set(entry[identityKey], entry);
  }
  if (candidateByIdentity.size !== expectedByIdentity.size) {
    return {
      status: "mismatch",
      reason: `${kind}_identity_mismatch`,
    };
  }
  for (const [identity, expectedEntry] of expectedByIdentity) {
    const candidateEntry = candidateByIdentity.get(identity);
    if (!candidateEntry) {
      return {
        status: "missing_evidence",
        reason: `${kind}_evidence_missing`,
      };
    }
    if (digest(withoutReceipt(expectedEntry)) !==
        digest(withoutReceipt(candidateEntry))) {
      return {
        status: "mismatch",
        reason: `${kind}_identity_mismatch`,
      };
    }
    const expectedReceipt = settlementReceipt(expectedEntry);
    const candidateReceipt = settlementReceipt(candidateEntry);
    const expectedReceiptStatus = validateSettlementReceipt(
      expectedReceipt,
      expectedEntry,
      identityKey,
    );
    if (expectedReceiptStatus === "corrupt") {
      return {
        status: "corrupt_evidence",
        reason: `${kind}_receipt_corrupt_in_manifest`,
      };
    }
    const candidateReceiptStatus = validateSettlementReceipt(
      candidateReceipt,
      candidateEntry,
      identityKey,
    );
    if (candidateReceiptStatus === "missing") {
      return {
        status: "missing_evidence",
        reason: `${kind}_receipt_missing`,
      };
    }
    if (candidateReceiptStatus === "corrupt") {
      return {
        status: "corrupt_evidence",
        reason: `${kind}_receipt_corrupt`,
      };
    }
    if (expectedReceiptStatus === "present" &&
        digest(expectedReceipt) !== digest(candidateReceipt)) {
      return {
        status: "mismatch",
        reason: `${kind}_receipt_mismatch`,
      };
    }
  }
  const normalizedExpected = normalizeCollection(expectedValue, identityKey);
  const normalizedCandidate = normalizeCollection(candidate, identityKey);
  return {
    status: "reconciled",
    expected_digest: digest(normalizedExpected),
    observed_digest: digest(normalizedCandidate),
  };
}

function validSettlementEntries(value, identityKey) {
  return Array.isArray(value) && value.every((entry) =>
    validSettlementEntry(entry, identityKey));
}

function validSettlementEntry(entry, identityKey) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry[identityKey] !== "string" || entry[identityKey].length === 0) {
    return false;
  }
  if (identityKey === "effect_id") {
    return typeof entry.provider === "string" && entry.provider.length > 0 &&
      typeof entry.pointer === "string" && entry.pointer.length > 0 &&
      typeof entry.idempotency_key === "string" &&
      entry.idempotency_key.length > 0;
  }
  return entry.disposition === "retire" ||
    entry.disposition === "handoff" &&
      typeof entry.durable_holder === "string" &&
      entry.durable_holder.length > 0;
}

function withoutReceipt(entry) {
  const { receipt: _receipt, ...identity } = entry;
  return identity;
}

function settlementReceipt(entry) {
  return Object.hasOwn(entry, "receipt") ? entry.receipt : undefined;
}

function validateSettlementReceipt(receipt, entry, identityKey) {
  const identity = entry[identityKey];
  if (receipt === undefined || receipt === null) return "missing";
  if (receipt === null || typeof receipt !== "object" ||
      Array.isArray(receipt) || receipt[identityKey] !== identity) {
    return "corrupt";
  }
  if (identityKey === "effect_id") {
    if (receipt.schema !== "flow.external-effect-receipt/v1" ||
        receipt.idempotency_key !== entry.idempotency_key ||
        typeof receipt.provider_receipt_id !== "string" ||
        receipt.provider_receipt_id.length === 0 ||
        !["succeeded", "failed", "cancelled"].includes(receipt.outcome)) {
      return "corrupt";
    }
  } else if (entry.disposition === "retire") {
    if (receipt.schema !== "flow.drovr-retirement-receipt/v1" ||
        receipt.disposition !== entry.disposition ||
        typeof receipt.retirement_receipt_id !== "string" ||
        receipt.retirement_receipt_id.length === 0 ||
        receipt.outcome !== "retired") {
      return "corrupt";
    }
  } else if (
    receipt.schema !== DROVR_HANDOFF_RECEIPT_SCHEMA ||
    receipt.disposition !== entry.disposition ||
    receipt.durable_holder !== entry.durable_holder ||
    typeof receipt.handoff_receipt_id !== "string" ||
    receipt.handoff_receipt_id.length === 0 ||
    receipt.outcome !== "handed_off"
  ) {
    return "corrupt";
  }
  try {
    canonicalize(receipt);
  } catch {
    return "corrupt";
  }
  return "present";
}

export function initialRestoreBarrier() {
  return freezeCanonical({
    schema: RESTORE_BARRIER_SCHEMA,
    state: "idle",
    active: false,
    manifest: null,
    manifest_digest: null,
    intent: null,
    applied_receipt: null,
    reconciliation: null,
    failure: null,
    watermark: EMPTY_WATERMARK,
    legal_actions: [],
  });
}

export function initialBackupProjection() {
  return freezeCanonical({
    schema: "flow.backup-projection/v1",
    state: "idle",
    active: false,
    intent: null,
    manifest: null,
    manifest_digest: null,
    receipt: null,
    reconciliation: null,
    failure: null,
    watermark: EMPTY_WATERMARK,
    legal_actions: [],
  });
}

export function createBackupIntent(manifest) {
  const validated = validateBackupManifest(manifest);
  const operationId = digest({
    schema: BACKUP_INTENT_SCHEMA,
    operation: "backup_create",
    manifest_digest: validated.manifest_digest,
  });
  return freezeCanonical({
    schema: BACKUP_INTENT_SCHEMA,
    operation: "backup_create",
    operation_id: operationId,
    idempotency_key: operationId,
    manifest: validated,
    manifest_digest: validated.manifest_digest,
  });
}

export function createRestoreIntent(manifest) {
  const validated = validateBackupManifest(manifest);
  const identity = {
    schema: RESTORE_INTENT_SCHEMA,
    operation: "restore",
    manifest_digest: validated.manifest_digest,
  };
  const operationId = digest(identity);
  return freezeCanonical({
    ...identity,
    operation_id: operationId,
    idempotency_key: operationId,
    manifest: validated,
  });
}

export function reduceHostRecoveryEvent(state, payload) {
  const current = state ?? {
    backup: initialBackupProjection(),
    restore: initialRestoreBarrier(),
  };
  if (payload?.type === "backup_intent_recorded") {
    const intent = validateBackupIntent(payload.intent);
    return {
      ...current,
      backup: {
        schema: "flow.backup-projection/v1",
        state: "reconciling",
        active: true,
        intent,
        manifest: intent.manifest,
        manifest_digest: intent.manifest_digest,
        receipt: null,
        reconciliation: null,
        failure: null,
        watermark: EMPTY_WATERMARK,
        legal_actions: [],
      },
    };
  }
  if (payload?.type === "backup_receipt_recorded") {
    if (current.backup?.active !== true || !current.backup.intent) {
      throw invalidBackup("backup_receipt_without_intent");
    }
    const receipt = validateBackupReceipt(
      payload.receipt,
      current.backup.intent.manifest_digest,
      current.backup.intent,
    );
    return {
      ...current,
      backup: {
        ...current.backup,
        state: "completed",
        active: false,
        receipt,
        failure: null,
      },
    };
  }
  if (payload?.type === "backup_reconciled") {
    if (current.backup?.active !== true || !current.backup.intent) {
      throw invalidBackup("backup_reconciliation_corrupt");
    }
    const observation = validateBackupReconciliationObservation(
      payload.observation,
      current.backup.intent,
    );
    if (observation.status !== "absent") {
      throw invalidBackup("backup_reconciliation_corrupt");
    }
    return {
      ...current,
      backup: {
        ...current.backup,
        state: "retryable",
        active: false,
        receipt: null,
        reconciliation: observation,
        failure: null,
      },
    };
  }
  if (payload?.type === "backup_created") {
    throw invalidBackup("backup_created_event_unsupported");
  }
  if (payload?.type === "restore_barrier_entered") {
    const manifest = validateBackupManifest(payload.manifest);
    const intent = validateRestoreIntent(payload.intent);
    if (intent.manifest_digest !== manifest.manifest_digest) {
      throw invalidBackup("restore_intent_manifest_mismatch");
    }
    if (current.restore?.active === true) {
      throw invalidBackup("restore_barrier_repeated");
    }
    const components = BACKUP_COMPONENTS.map((component) => ({
      component,
      expected_digest: digest(manifest[component]),
      observed_digest: null,
      status: "pending",
      reason: "awaiting_reconciliation",
    }));
    return {
      ...current,
      restore: {
        schema: RESTORE_BARRIER_SCHEMA,
        state: "reconciling",
        active: true,
        manifest,
        manifest_digest: manifest.manifest_digest,
        intent,
        applied_receipt: null,
        reconciliation: null,
        failure: null,
        watermark: EMPTY_WATERMARK,
        legal_actions: [],
        components,
        evidence_domains: RESTORE_EVIDENCE_DOMAINS.map((domain) => ({
          domain,
          expected_digest: null,
          observed_digest: null,
          status: "pending",
          reason: "awaiting_reconciliation",
        })),
      },
    };
  }
  if (payload?.type === "restore_applied") {
    const receipt = validateRestoreReceipt(
      payload.receipt,
      current.restore?.manifest_digest,
      current.restore?.intent,
    );
    if (current.restore?.active !== true) {
      throw invalidBackup("restore_receipt_without_barrier");
    }
    return {
      ...current,
      restore: {
        ...current.restore,
        applied_receipt: receipt,
      },
    };
  }
  if (payload?.type === "restore_reconciled") {
    if (current.restore?.active !== true) {
      throw invalidBackup("restore_reconciliation_without_barrier");
    }
    const reconciliation = validateReconciliation(
      payload.reconciliation,
      current.restore.manifest_digest,
    );
    return {
      ...current,
      restore: {
        ...current.restore,
        state: reconciliation.complete ? "ready" : "failed",
        active: true,
        reconciliation,
        failure: reconciliation.complete
          ? null
          : {
              schema: "flow.restore-failure/v1",
              boundary: "host_restore",
              components: [
                ...reconciliation.components
                  .filter(({ status }) => status !== "reconciled")
                  .map(({ component, status, reason }) => ({
                    component,
                    status,
                    reason,
                  })),
                ...reconciliation.evidence_domains
                  .filter(({ status }) => status !== "reconciled")
                  .map(({ domain, status, reason }) => ({
                    component: domain,
                    status,
                    reason,
                  })),
              ],
            },
        components: reconciliation.components,
        evidence_domains: reconciliation.evidence_domains,
      },
    };
  }
  if (payload?.type === "restore_admitted") {
    if (current.restore?.active !== true ||
        current.restore.state !== "ready") {
      throw invalidBackup("restore_admission_out_of_order");
    }
    const receipt = validateRestoreAdmissionReceipt(
      payload.receipt,
      current.restore.manifest_digest,
      current.restore.intent,
      current.restore.reconciliation?.reconciliation_digest,
    );
    return {
      ...current,
      restore: {
        ...current.restore,
        state: "admitted",
        active: false,
        admission_receipt: receipt,
        legal_actions: [],
      },
    };
  }
  return current;
}

export function projectHostRecovery(recovery, hostWatermark) {
  const state = recovery?.restore ?? initialRestoreBarrier();
  const restore = {
    ...state,
    watermark: hostWatermark,
    legal_actions: restoreLegalActions(state, hostWatermark),
  };
  const backup = recovery?.backup ?? initialBackupProjection();
  const projectedBackup = {
    ...backup,
    watermark: hostWatermark,
    legal_actions: backupLegalActions(backup, hostWatermark),
  };
  return freezeCanonical({
    ...recovery,
    legal_actions: state.active
      ? restore.legal_actions
      : projectedBackup.legal_actions,
    backup: projectedBackup,
    restore,
  });
}

function restoreLegalActions(state, watermark) {
  if (!state?.active) return [];
  if (state.state === "ready") {
    return [{
      schema: "flow.command/v1",
      type: "restore_admit",
      expected_watermark: watermark,
    }];
  }
  return [{
    schema: "flow.command/v1",
    type: "restore_reconcile",
    expected_watermark: watermark,
  }];
}

function backupLegalActions(state, watermark) {
  if (state?.state === "reconciling" || state?.state === "failed") {
    return [{
      schema: "flow.command/v1",
      type: "backup_reconcile",
      expected_watermark: watermark,
    }];
  }
  if (state?.state === "retryable") {
    return [{
      schema: "flow.command/v1",
      type: "backup_create",
      expected_watermark: watermark,
    }];
  }
  return [];
}

export function isBackupRestoreCommand(command) {
  return [
    "backup_create",
    "backup_reconcile",
    "restore",
    "restore_reconcile",
    "restore_admit",
  ].includes(command?.type);
}

export function assertProjectedHostAction(command, projection) {
  const action = (projection?.legal_actions ?? []).find(({ type }) =>
    type === command?.type);
  if (!action || digest(action) !== digest(command)) {
    throw backupError(
      "host_action_not_projected",
      "host command is not the exact currently projected action",
    );
  }
  return action;
}

export function snapshotBackupRestoreAdapter(adapter) {
  if (adapter === null || adapter === undefined) {
    return createFailClosedBackupRestoreAdapter();
  }
  if (typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("backup restore Adapter must be an object");
  }
  const methods = {};
  for (const name of [
    "observeBackup",
    "observeRestore",
    "createBackup",
    "restore",
    "reconcile",
  ]) {
    if (typeof adapter[name] === "function") {
      methods[name] = adapter[name].bind(adapter);
    }
  }
  return Object.freeze(methods);
}

export function createFailClosedBackupRestoreAdapter() {
  return Object.freeze({
    observe() {
      throw backupError(
        "backup_observation_unavailable",
        "backup restore Adapter did not provide host observations",
      );
    },
  });
}

export function observeBackupState(adapter, context = {}) {
  const observer = adapter.observeBackup;
  if (typeof observer !== "function") {
    throw backupError("backup_observation_unavailable", "host observation is unavailable");
  }
  return normalizeBackupObservation(observer({
    ...context,
    purpose: context.purpose ?? "backup",
  }));
}

export function observeRestoreState(adapter, context = {}) {
  const observer = adapter.observeRestore;
  if (typeof observer !== "function") {
    throw backupError("restore_observation_unavailable", "restore observation is unavailable");
  }
  return observer({
    ...context,
    purpose: "restore",
  });
}

export function createBackupThroughAdapter(adapter, manifest, context = {}) {
  const writer = adapter.createBackup;
  if (typeof writer !== "function") {
    throw backupError("backup_writer_unavailable", "backup writer is unavailable");
  }
  const providerReceipt = writer({
    ...context,
    purpose: "backup",
    manifest,
    manifest_bytes: serializeBackupManifest(manifest),
  });
  return createBackupReceipt(manifest, providerReceipt, context.intent);
}

export function createBackupReceipt(manifest, providerReceipt, intent = null) {
  if (providerReceipt === null || typeof providerReceipt !== "object" ||
      Array.isArray(providerReceipt) ||
      providerReceipt.manifest_digest !== manifest.manifest_digest ||
      (intent !== null && (
        providerReceipt.operation_id !== undefined &&
        providerReceipt.operation_id !== intent.operation_id ||
        providerReceipt.idempotency_key !== undefined &&
        providerReceipt.idempotency_key !== intent.idempotency_key
      ))) {
    throw backupError(
      "backup_receipt_invalid",
      "backup writer did not return an identity-bound receipt",
    );
  }
  return freezeCanonical({
    schema: BACKUP_RECEIPT_SCHEMA,
    manifest_digest: manifest.manifest_digest,
    ...(intent === null ? {} : {
      operation_id: intent.operation_id,
      idempotency_key: intent.idempotency_key,
    }),
    provider_receipt: providerReceipt,
  });
}

export function reconcileBackupThroughAdapter(adapter, intent, context = {}) {
  const reconciler = adapter.reconcile;
  if (typeof reconciler !== "function") {
    throw backupError(
      "backup_reconciliation_unavailable",
      "backup reconciliation Adapter is unavailable",
    );
  }
  const result = reconciler({
    ...context,
    purpose: "backup",
    intent,
    manifest: intent.manifest,
  });
  const observation = validateBackupReconciliationObservation(result, intent);
  if (observation.status === "absent" || observation.status === "present") {
    return observation;
  }
  throw backupError(
    "backup_reconciliation_invalid",
    "backup reconciliation did not prove presence or safe absence",
  );
}

function validateBackupReconciliationObservation(observation, intent) {
  if (observation === null || typeof observation !== "object" ||
      Array.isArray(observation) ||
      observation.schema !== BACKUP_RECONCILIATION_OBSERVATION_SCHEMA ||
      observation.operation !== "backup_create" ||
      observation.operation_id !== intent?.operation_id ||
      observation.idempotency_key !== intent?.idempotency_key ||
      observation.manifest_digest !== intent?.manifest_digest ||
      !["absent", "present"].includes(observation.status) ||
      observation.provider_evidence === null ||
      typeof observation.provider_evidence !== "object" ||
      Array.isArray(observation.provider_evidence)) {
    throw backupError(
      "backup_reconciliation_invalid",
      "backup reconciliation observation is not identity-bound",
    );
  }
  const evidence = observation.provider_evidence;
  if (evidence.schema !== BACKUP_PROVIDER_EVIDENCE_SCHEMA ||
      typeof evidence.provider !== "string" || evidence.provider.length === 0 ||
      typeof evidence.proof_id !== "string" || evidence.proof_id.length === 0 ||
      evidence.outcome !== observation.status ||
      Object.keys(evidence).sort().join(",") !==
        "outcome,proof_id,provider,schema") {
    throw backupError(
      "backup_reconciliation_invalid",
      "backup reconciliation provider evidence is not closed",
    );
  }
  const observationKeys = Object.keys(observation).sort().join(",");
  if (observation.status === "absent") {
    if (observation.safe_to_retry !== true ||
        observationKeys !==
          "idempotency_key,manifest_digest,operation,operation_id,provider_evidence,safe_to_retry,schema,status") {
      throw backupError(
        "backup_reconciliation_invalid",
        "backup absence is not an exact safe absence observation",
      );
    }
    return freezeCanonical(observation);
  }
  if (observationKeys !==
      "idempotency_key,manifest_digest,operation,operation_id,provider_evidence,receipt,schema,status") {
    throw backupError(
      "backup_reconciliation_invalid",
      "backup presence is not an exact reconciliation observation",
    );
  }
  let receipt;
  try {
    receipt = observation.receipt?.schema === BACKUP_RECEIPT_SCHEMA
      ? validateBackupReceipt(observation.receipt, intent.manifest_digest, intent)
      : createBackupReceipt(intent.manifest, observation.receipt, intent);
  } catch {
    throw backupError(
      "backup_reconciliation_invalid",
      "backup presence does not carry an identity-bound receipt",
    );
  }
  return freezeCanonical({
    ...observation,
    receipt,
  });
}

export function serializeBackupManifest(manifest) {
  const validated = validateBackupManifest(manifest);
  return Buffer.from(JSON.stringify(validated), "utf8");
}

export function applyRestoreThroughAdapter(
  adapter,
  manifest,
  intent,
  context = {},
) {
  const restorer = adapter.restore;
  if (typeof restorer !== "function") return null;
  const providerReceipt = restorer({
    ...context,
    purpose: "restore",
    manifest,
    intent,
    operation_id: intent.operation_id,
    idempotency_key: intent.idempotency_key,
  });
  if (providerReceipt === null || typeof providerReceipt !== "object" ||
      Array.isArray(providerReceipt)) {
    throw backupError(
      "restore_receipt_invalid",
      "restore Adapter did not return an identity-bound receipt",
    );
  }
  return freezeCanonical({
    schema: RESTORE_RECEIPT_SCHEMA,
    manifest_digest: manifest.manifest_digest,
    operation_id: intent.operation_id,
    idempotency_key: intent.idempotency_key,
    provider_receipt: providerReceipt,
  });
}

export function executeHostRecoveryCommand({
  command = {},
  before,
  recoveryAdapter,
  append,
  read,
  publish = () => {},
  effectsInFlight = 0,
  unresolvedRunEffects = () => [],
  beforeMutation = () => {},
}) {
  const type = command?.type;
  const current = () => read();
  const reject = (operation, code, reason = null, projection = current()) =>
    createRejection({
      operation,
      code,
      reason,
      commandType: typeof type === "string" ? type : null,
      authorityWatermark: projection?.watermark ?? EMPTY_WATERMARK,
      authorityWatermarkDomain: "host",
      legalActions: projection?.legal_actions ??
        projection?.restore?.legal_actions ??
        projection?.backup?.legal_actions ?? [],
    });
  const mutationReject = (projection = current()) => reject(
    "command",
    "host_reconciliation_required",
    null,
    projection,
  );
  const record = (payload) => {
    const result = append(payload);
    if (result?.schema === "flow.rejection/v1") return result;
    publish();
    return null;
  };
  const projectedActionFailure = (operation, projection, error) => reject(
    operation,
    error?.code === "host_action_not_projected" &&
      typeof command.expected_watermark === "string" &&
      command.expected_watermark !== projection?.watermark
      ? "stale_authority_watermark"
      : error?.code ?? "host_action_not_projected",
    null,
    projection,
  );

  if (!isBackupRestoreCommand(command)) {
    return reject("command", "unsupported_host_command", null, before);
  }
  if (type === "backup_create") {
    if (before.restore?.active === true || before.backup?.active === true) {
      return mutationReject(before);
    }
    let manifest;
    let intent;
    if (before.backup?.state === "retryable") {
      try {
        assertProjectedHostAction(command, before.backup);
      } catch (error) {
        return projectedActionFailure("backup", before, error);
      }
      intent = before.backup.intent;
      manifest = intent.manifest;
    } else {
      try {
        manifest = createBackupManifest(observeBackupState(recoveryAdapter));
        intent = createBackupIntent(manifest);
      } catch (error) {
        return reject(
          "backup",
          error?.code ?? "backup_creation_failed",
          error?.message ?? null,
          before,
        );
      }
    }
    try {
      beforeMutation();
    } catch (error) {
      return reject(
        "backup",
        error?.code ?? "backup_creation_failed",
        error?.message ?? null,
        current(),
      );
    }
    const intentResult = record({ type: "backup_intent_recorded", intent });
    if (intentResult) return intentResult;
    let receipt;
    try {
      beforeMutation();
      receipt = createBackupThroughAdapter(recoveryAdapter, manifest, {
        intent,
        operation_id: intent.operation_id,
      });
    } catch (error) {
      return reject(
        "backup",
        error?.code ?? "backup_creation_failed",
        error?.message ?? null,
        current(),
      );
    }
    const receiptResult = record({ type: "backup_receipt_recorded", receipt });
    if (receiptResult) return receiptResult;
    const after = current();
    return freezeCanonical({
      schema: "flow.command-receipt/v1",
      command_type: type,
      run_id: null,
      authority_watermark: after.watermark,
      accepted: true,
      manifest,
      receipt,
    });
  }
  if (type === "backup_reconcile") {
    const state = before.backup;
    if (!state?.active || !state.intent) {
      return reject("backup", "backup_reconciliation_not_active", null, before);
    }
    try {
      assertProjectedHostAction(command, state);
    } catch (error) {
      return projectedActionFailure("backup", before, error);
    }
    let reconciliation;
    try {
      reconciliation = reconcileBackupThroughAdapter(
        recoveryAdapter,
        state.intent,
      );
    } catch (error) {
      return reject(
        "backup",
        error?.code ?? "backup_reconciliation_failed",
        error?.message ?? null,
        before,
      );
    }
    const result = reconciliation.status === "present"
      ? record({
          type: "backup_receipt_recorded",
          receipt: reconciliation.receipt,
        })
      : record({
          type: "backup_reconciled",
          observation: reconciliation,
        });
    if (result) return result;
    const after = current();
    return freezeCanonical({
      schema: "flow.command-receipt/v1",
      command_type: type,
      run_id: null,
      authority_watermark: after.watermark,
      accepted: true,
      reconciliation,
    });
  }
  if (type === "restore") {
    let manifest;
    let intent;
    try {
      manifest = validateBackupManifest(command.manifest);
      intent = createRestoreIntent(manifest);
    } catch (error) {
      return reject(
        "restore",
        error?.code ?? "invalid_backup_manifest",
        error?.message ?? null,
        before,
      );
    }
    if (hasUnresolvedBackup(before.backup)) {
      const backupProjection = {
        ...before,
        legal_actions: before.backup?.legal_actions ?? [],
      };
      try {
        assertProjectedHostAction(command, backupProjection);
      } catch (error) {
        return projectedActionFailure("restore", backupProjection, error);
      }
    }
    if (before.restore?.active === true) {
      if (before.restore.manifest_digest === manifest.manifest_digest) {
        return freezeCanonical({
          schema: "flow.command-receipt/v1",
          command_type: type,
          run_id: null,
          authority_watermark: before.watermark,
          accepted: false,
        });
      }
      return mutationReject(before);
    }
    if (typeof recoveryAdapter.restore !== "function") {
      return reject(
        "restore",
        "restore_writer_unavailable",
        "restore writer is unavailable",
        before,
      );
    }
    const entered = record({
      type: "restore_barrier_entered",
      manifest,
      intent,
    });
    if (entered) return entered;
    let appliedReceipt = null;
    try {
      const receipt = applyRestoreThroughAdapter(
        recoveryAdapter,
        manifest,
        intent,
      );
      if (receipt !== null) {
        appliedReceipt = receipt;
        const applied = record({ type: "restore_applied", receipt });
        if (applied) return applied;
      }
    } catch (error) {
      return reject(
        "restore",
        error?.code ?? "restore_apply_failed",
        error?.message ?? null,
      );
    }
    const after = current();
    return freezeCanonical({
      schema: "flow.command-receipt/v1",
      command_type: type,
      run_id: null,
      authority_watermark: after.watermark,
      accepted: true,
      manifest_digest: manifest.manifest_digest,
      ...(appliedReceipt === null ? {} : { receipt: appliedReceipt }),
    });
  }
  if (type === "restore_reconcile") {
    const state = before.restore;
    if (!state?.active || state.state === "admitted") {
      return reject("restore", "restore_not_active", null, before);
    }
    try {
      assertProjectedHostAction(command, state);
    } catch (error) {
      return projectedActionFailure("restore", before, error);
    }
    let reconciliation;
    try {
      const observation = observeRestoreState(recoveryAdapter, {
        manifest: state.manifest,
      });
      reconciliation = reconcileBackupObservation(state.manifest, observation);
    } catch (error) {
      return reject(
        "restore",
        error?.code ?? "restore_observation_unavailable",
        error?.message ?? null,
        before,
      );
    }
    const result = record({ type: "restore_reconciled", reconciliation });
    if (result) return result;
    const after = current();
    return freezeCanonical({
      schema: "flow.command-receipt/v1",
      command_type: type,
      run_id: null,
      authority_watermark: after.watermark,
      accepted: true,
      reconciliation,
    });
  }
  if (type === "restore_admit") {
    const state = before.restore;
    if (!state?.active || state.state !== "ready") {
      return reject(
        "restore",
        "restore_reconciliation_incomplete",
        null,
        before,
      );
    }
    try {
      assertProjectedHostAction(command, state);
    } catch (error) {
      return projectedActionFailure("restore", before, error);
    }
    if (hasUnresolvedBackup(before.backup)) {
      return reject(
        "restore",
        "backup_reconciliation_required",
        null,
        {
          ...before,
          legal_actions: before.backup?.legal_actions ?? [],
        },
      );
    }
    const inFlight = typeof effectsInFlight === "number"
      ? effectsInFlight
      : effectsInFlight?.size ?? 0;
    if (inFlight > 0) {
      return reject("restore", "host_effects_in_flight", null, before);
    }
    let durableUnresolvedEffects;
    try {
      durableUnresolvedEffects = typeof unresolvedRunEffects === "function"
        ? unresolvedRunEffects()
        : unresolvedRunEffects;
    } catch (error) {
      return reject(
        "restore",
        error?.code ?? "host_effect_reconciliation_required",
        error?.message ?? null,
        before,
      );
    }
    if (durableUnresolvedEffects.length > 0) {
      return reject("restore", "host_effects_unresolved", null, before);
    }
    let freshReconciliation;
    try {
      const observation = observeRestoreState(recoveryAdapter, {
        manifest: state.manifest,
      });
      freshReconciliation = reconcileBackupObservation(
        state.manifest,
        observation,
      );
    } catch (error) {
      return reject(
        "restore",
        error?.code ?? "restore_observation_unavailable",
        error?.message ?? null,
        before,
      );
    }
    if (freshReconciliation.reconciliation_digest !==
        state.reconciliation?.reconciliation_digest) {
      const changed = record({
        type: "restore_reconciled",
        reconciliation: freshReconciliation,
      });
      if (changed) return changed;
      return reject(
        "restore",
        "restore_reconciliation_changed",
        null,
        current(),
      );
    }
    const receipt = {
      schema: "flow.restore-admission-receipt/v1",
      manifest_digest: state.manifest_digest,
      operation_id: state.intent.operation_id,
      idempotency_key: state.intent.idempotency_key,
      reconciliation_digest: state.reconciliation?.reconciliation_digest,
    };
    const admitted = record({ type: "restore_admitted", receipt });
    if (admitted) return admitted;
    const after = current();
    return freezeCanonical({
      schema: "flow.command-receipt/v1",
      command_type: type,
      run_id: null,
      authority_watermark: after.watermark,
      accepted: true,
      receipt,
    });
  }
  return reject("restore", "unsupported_host_command", null, before);
}

function hasUnresolvedBackup(backup) {
  return backup?.active === true ||
    backup?.intent !== null && backup?.intent !== undefined &&
      !["idle", "completed"].includes(backup.state);
}

function normalizeReconciliationValue(value) {
  if (value === undefined || value === null) {
    return { status: "missing", digest: null, reason: "evidence_missing" };
  }
  if (value?.status === "missing" || value?.status === "corrupt" ||
      value?.status === "indeterminate") {
    return {
      status: value.status,
      digest: typeof value.observed_digest === "string"
        ? value.observed_digest
        : null,
      reason: value.reason ?? `${value.status}_evidence`,
    };
  }
  if (typeof value === "object" && !Array.isArray(value) &&
      typeof value.observed_digest === "string" &&
      Object.keys(value).every((key) => [
        "status", "observed_digest", "reason", "receipt",
      ].includes(key))) {
    return {
      status: value.status === "reconciled" ? "reconciled" : "indeterminate",
      digest: value.observed_digest,
      reason: value.reason,
    };
  }
  return {
    status: "observed",
    digest: digest(value),
    reason: null,
  };
}

function evidenceDomainValue(value, domain, observation) {
  if (value === undefined || value === null) return undefined;
  const exactField = {
    database_streams: "database_streams",
    artifact_state: "artifacts",
    git_state: "git_state",
    filesystem_state: "filesystem_state",
    external_effects: "external_pointers",
    drovr_obligations: "drovr_obligations",
  }[domain];
  if (exactField && Object.hasOwn(value, exactField)) {
    return value[exactField];
  }
  if (Object.hasOwn(value, "replacement_authority")) {
    const nested = evidenceDomainValue(
      value.replacement_authority,
      domain,
      false,
    );
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function normalizeCollection(value, identityKey = null) {
  if (!Array.isArray(value)) throw invalidBackup("invalid_backup_observation");
  const normalized = value.map((entry) => normalizeValue(entry));
  if (identityKey !== null) {
    const identities = new Set();
    for (const entry of normalized) {
      if (typeof entry?.[identityKey] !== "string" ||
          entry[identityKey].length === 0 ||
          identities.has(entry[identityKey])) {
        throw invalidBackup("invalid_backup_observation");
      }
      identities.add(entry[identityKey]);
    }
  }
  return normalized
    .sort((left, right) => digest(left).localeCompare(digest(right)));
}

function validateBackupReceipt(receipt, manifestDigest, intent = null) {
  if (receipt === null || typeof receipt !== "object" ||
      Array.isArray(receipt) || receipt.schema !== BACKUP_RECEIPT_SCHEMA ||
      receipt.manifest_digest !== manifestDigest ||
      (intent !== null && (
        receipt.operation_id !== intent.operation_id ||
        receipt.idempotency_key !== intent.idempotency_key
      )) ||
      receipt.provider_receipt === null ||
      typeof receipt.provider_receipt !== "object" ||
      Array.isArray(receipt.provider_receipt)) {
    throw invalidBackup("backup_receipt_corrupt");
  }
  try {
    return freezeCanonical(receipt);
  } catch {
    throw invalidBackup("backup_receipt_corrupt");
  }
}

function validateBackupIntent(intent) {
  if (intent === null || typeof intent !== "object" ||
      Array.isArray(intent) || intent.schema !== BACKUP_INTENT_SCHEMA ||
      intent.operation !== "backup_create" ||
      typeof intent.operation_id !== "string" ||
      typeof intent.manifest_digest !== "string") {
    throw invalidBackup("backup_intent_corrupt");
  }
  const manifest = validateBackupManifest(intent.manifest);
  const expectedOperationId = digest({
    schema: BACKUP_INTENT_SCHEMA,
    operation: "backup_create",
    manifest_digest: manifest.manifest_digest,
  });
  if (intent.manifest_digest !== manifest.manifest_digest ||
      intent.operation_id !== expectedOperationId ||
      intent.idempotency_key !== expectedOperationId) {
    throw invalidBackup("backup_intent_corrupt");
  }
  try {
    return freezeCanonical(intent);
  } catch {
    throw invalidBackup("backup_intent_corrupt");
  }
}

function validateRestoreIntent(intent) {
  if (intent === null || typeof intent !== "object" ||
      Array.isArray(intent) || intent.schema !== RESTORE_INTENT_SCHEMA ||
      intent.operation !== "restore" ||
      typeof intent.operation_id !== "string" ||
      typeof intent.idempotency_key !== "string") {
    throw invalidBackup("restore_intent_corrupt");
  }
  const manifest = validateBackupManifest(intent.manifest);
  const expectedIdentity = {
    schema: RESTORE_INTENT_SCHEMA,
    operation: "restore",
    manifest_digest: manifest.manifest_digest,
  };
  const expectedOperationId = digest(expectedIdentity);
  if (intent.manifest_digest !== manifest.manifest_digest ||
      intent.operation_id !== expectedOperationId ||
      intent.idempotency_key !== expectedOperationId) {
    throw invalidBackup("restore_intent_corrupt");
  }
  try {
    return freezeCanonical(intent);
  } catch {
    throw invalidBackup("restore_intent_corrupt");
  }
}

function validateRestoreReceipt(receipt, manifestDigest, intent) {
  if (receipt === null || typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      receipt.schema !== RESTORE_RECEIPT_SCHEMA ||
      receipt.manifest_digest !== manifestDigest ||
      receipt.operation_id !== intent?.operation_id ||
      receipt.idempotency_key !== intent?.idempotency_key ||
      receipt.provider_receipt === null ||
      typeof receipt.provider_receipt !== "object" ||
      Array.isArray(receipt.provider_receipt)) {
    throw invalidBackup("restore_receipt_corrupt");
  }
  try {
    return freezeCanonical(receipt);
  } catch {
    throw invalidBackup("restore_receipt_corrupt");
  }
}

function validateRestoreAdmissionReceipt(
  receipt,
  manifestDigest,
  intent,
  reconciliationDigest,
) {
  if (receipt === null || typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      receipt.schema !== "flow.restore-admission-receipt/v1" ||
      receipt.manifest_digest !== manifestDigest ||
      receipt.operation_id !== intent?.operation_id ||
      receipt.idempotency_key !== intent?.idempotency_key ||
      receipt.reconciliation_digest !== reconciliationDigest) {
    throw invalidBackup("restore_admission_receipt_corrupt");
  }
  try {
    return freezeCanonical(receipt);
  } catch {
    throw invalidBackup("restore_admission_receipt_corrupt");
  }
}

function validateReconciliation(reconciliation, manifestDigest) {
  if (reconciliation === null || typeof reconciliation !== "object" ||
      Array.isArray(reconciliation) ||
      reconciliation.schema !== "flow.restore-reconciliation/v1" ||
      reconciliation.manifest_digest !== manifestDigest ||
      !Array.isArray(reconciliation.components) ||
      !Array.isArray(reconciliation.evidence_domains) ||
      typeof reconciliation.complete !== "boolean" ||
      typeof reconciliation.reconciliation_digest !== "string") {
    throw invalidBackup("restore_reconciliation_corrupt");
  }
  const componentNames = reconciliation.components.map(({ component }) => component);
  const domainNames = reconciliation.evidence_domains.map(({ domain }) => domain);
  if (!sameStringSequence(componentNames, BACKUP_COMPONENTS) ||
      !sameStringSequence(domainNames, RESTORE_EVIDENCE_DOMAINS)) {
    throw invalidBackup("restore_reconciliation_corrupt");
  }
  for (const entry of [
    ...reconciliation.components,
    ...reconciliation.evidence_domains,
  ]) {
    if (entry === null || typeof entry !== "object" ||
        !["reconciled", "missing_evidence", "corrupt_evidence", "mismatch",
          "indeterminate"].includes(entry.status) ||
        (entry.status === "reconciled"
          ? typeof entry.expected_digest !== "string" ||
            typeof entry.observed_digest !== "string"
          : typeof entry.expected_digest !== "string" &&
            entry.expected_digest !== null)) {
      throw invalidBackup("restore_reconciliation_corrupt");
    }
  }
  const complete = [
    ...reconciliation.components,
    ...reconciliation.evidence_domains,
  ].every(({ status }) => status === "reconciled");
  if (complete !== reconciliation.complete) {
    throw invalidBackup("restore_reconciliation_corrupt");
  }
  const body = {
    schema: "flow.restore-reconciliation/v1",
    manifest_digest: manifestDigest,
    components: reconciliation.components,
    evidence_domains: reconciliation.evidence_domains,
  };
  if (digest(body) !== reconciliation.reconciliation_digest) {
    throw invalidBackup("restore_reconciliation_corrupt");
  }
  try {
    return freezeCanonical(reconciliation);
  } catch {
    throw invalidBackup("restore_reconciliation_corrupt");
  }
}

function sameStringSequence(actual, expected) {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function normalizeValue(value) {
  try {
    return canonicalize(value);
  } catch {
    throw invalidBackup("invalid_backup_observation");
  }
}

function normalizeReplacementAuthority(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBackup("invalid_backup_observation");
  }
  const normalized = normalizeValue(value);
  for (const [field, identityKey] of [
    ["database_streams", "id"],
    ["filesystem_state", "path"],
  ]) {
    if (Object.hasOwn(value, field)) {
      normalized[field] = normalizeCollection(value[field], identityKey);
    }
  }
  return canonicalize(normalized);
}

function sameCanonicalKeys(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function invalidBackup(reason) {
  return backupError(reason, `backup restore evidence is invalid: ${reason}`);
}

function backupError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

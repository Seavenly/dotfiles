import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { digestCanonical } from "./canonical-json.mjs";
import { DrovrError } from "./errors.mjs";

const KINDS = new Set(["groups", "tasks", "agents", "turns", "blocks"]);
const ORDERED_KINDS = [...KINDS];
const LOCK_SCHEMA = "drovr.registry-lock/v1";
const WATERMARK_SCHEMA = "drovr.registry-authority-watermark/v1";
const PROCESS_SCHEMA = "drovr.process-identity/v1";
const DEFAULT_LOCK_ATTEMPTS = 500;
const DEFAULT_LOCK_RETRY_MS = 10;
const LOCK_ENTRY_PATTERN = /^[a-f0-9]{64}$/u;
const LOCK_CONTENTION_ERRORS = new Set([
  "EEXIST",
  "EISDIR",
  "ENOTEMPTY",
]);
const ABANDONMENT_TYPES = new Set([
  "owner_terminated",
  "operation_failed",
  "operation_cancelled",
  "operator_disposition",
]);
export const REGISTRY_LOCK_RECOVERY_ACTIONS = Object.freeze({
  adopt: "adopt_registry_operation",
  proven_absence: "prove_registry_operation_absent",
  abandon: "abandon_registry_operation",
});
export const PUBLIC_BARE_LOCK_ABANDON_ACTION = "abandon_bare_registry_lock";
const execFileAsync = promisify(execFileCallback);

export function stateDirectory(env = process.env) {
  const stateHome =
    env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state");
  return join(stateHome, "drovr");
}

export function taskLifecycleLockKey(taskId) {
  return `task-lifecycle:${taskId}`;
}

function lockDigest(key) {
  return createHash("sha256").update(key).digest("hex");
}

export function resourceLockPath(directory, key) {
  if (!validNonEmpty(key)) {
    throw new DrovrError("registry lock resource key must be a non-empty string", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  return join(directory, "locks", lockDigest(key));
}

function ownerMarkerPath(path, lockId) {
  return join(path, `owner-${lockId}.json`);
}

function ownerDocumentPath(path) {
  return join(path, "owner.json");
}

function ownerTokenPath(path, lockId) {
  return join(dirname(path), `.${basename(path)}.${lockId}.token`);
}

function ownerClaimPath(path, lockId, processIdentity = {}) {
  const pid = processIdentity.pid ?? process.pid;
  const boot = encodeURIComponent(processIdentity.boot_id ?? "unknown");
  const start = encodeURIComponent(processIdentity.start_token ?? "unknown");
  return `${ownerTokenPath(path, lockId)}.${pid}.${boot}.${start}.${randomUUID()}.claim`;
}

function claimProcessIdentity(name, tokenName) {
  if (!name.startsWith(`${tokenName}.`) || !name.endsWith(".claim")) return null;
  const fields = name.slice(tokenName.length + 1, -".claim".length).split(".");
  if (fields.length !== 4 || !/^\d+$/u.test(fields[0])) return null;
  try {
    const [pid, boot, start] = fields;
    return {
      schema: PROCESS_SCHEMA,
      pid: Number(pid),
      boot_id: decodeURIComponent(boot),
      start_token: decodeURIComponent(start),
    };
  } catch {
    return null;
  }
}

async function ensureStateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const locks = join(directory, "locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await chmod(locks, 0o700);
  for (const kind of KINDS) {
    const path = join(directory, kind);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const launchDocuments = join(directory, "launch-documents");
  await mkdir(launchDocuments, { recursive: true, mode: 0o700 });
  await chmod(launchDocuments, 0o700);
}

function recordPath(directory, kind, id) {
  if (!KINDS.has(kind))
    throw new Error(`unknown registry record kind: ${kind}`);
  return join(directory, kind, `${id}.json`);
}

async function validatePrivateDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    throw new DrovrError(
      `unsafe registry directory ${path}: expected owner-only permissions`,
      { code: 3, outcome: "unsafe_state_permissions" },
    );
  }
  return true;
}

async function validatePrivateFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new DrovrError(
      `unsafe registry record ${path}: expected owner-only permissions`,
      { code: 3, outcome: "unsafe_state_permissions" },
    );
  }
}

export async function writeRecord(directory, kind, record) {
  await ensureStateDirectory(directory);
  const path = recordPath(directory, kind, record.id);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function writeLaunchDocument(directory, key, contents) {
  await ensureStateDirectory(directory);
  const safeKey = createHash("sha256").update(key).digest("hex");
  const path = join(directory, "launch-documents", `${safeKey}.txt`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}

export async function readRecords(directory, kind) {
  if (!KINDS.has(kind)) throw new Error(`unknown registry record kind: ${kind}`);
  if (!(await validatePrivateDirectory(directory))) return [];
  const kindDirectory = join(directory, kind);
  if (!(await validatePrivateDirectory(kindDirectory))) return [];
  let paths;
  try {
    paths = await readdir(kindDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of paths.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(directory, kind, name);
    try {
      await validatePrivateFile(path);
      records.push(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof DrovrError) throw error;
      throw new DrovrError(
        `corrupt registry record ${path}: ${error.message}`,
        {
          code: 5,
          outcome: "corrupt_registry",
        },
      );
    }
  }
  return records;
}

/**
 * Return a deterministic, read-only view of the registry generation.
 *
 * The watermark intentionally derives from records rather than directory
 * mtimes. A lock therefore binds the exact authority visible to its owner,
 * including an empty or not-yet-created registry, without initializing state
 * on query paths.
 */
function watermarkForRecords(records) {
  const kindDigests = {};
  const kindCounts = {};
  for (const kind of ORDERED_KINDS) {
    const values = records[kind] ?? [];
    records[kind] = values;
    kindDigests[`${kind}_sha256`] = digestCanonical(values);
    kindCounts[`${kind}_count`] = values.length;
  }
  const generation = {
    schema: WATERMARK_SCHEMA,
    authority: "drovr.registry",
    ...kindDigests,
    ...kindCounts,
  };
  return {
    ...generation,
    generation: digestCanonical(generation),
    registry_sha256: digestCanonical(records),
  };
}

async function readRegistryRecords(directory) {
  const records = {};
  for (const kind of ORDERED_KINDS) {
    records[kind] = await readRecords(directory, kind);
  }
  return records;
}

export async function readRegistrySnapshot(directory, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const records = await readRegistryRecords(directory);
    const authorityWatermark = watermarkForRecords(records);
    const verification = await readRegistryRecords(directory);
    if (digestCanonical(records) === digestCanonical(verification)) {
      return {
        ...records,
        authority_watermark: authorityWatermark,
      };
    }
  }
  throw new DrovrError(
    "registry changed while a read-only snapshot was being assembled",
    {
      code: 0,
      outcome: "registry_snapshot_unstable",
      details: { max_attempts: maxAttempts },
    },
  );
}

export async function registryWatermark(directory) {
  return (await readRegistrySnapshot(directory)).authority_watermark;
}

async function readText(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

function procStartTime(statContents) {
  const closeParen = statContents.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = statContents.slice(closeParen + 2).trim().split(/\s+/u);
  // The first field after the command is process state (field 3). Start time
  // is field 22, hence index 19 in this suffix.
  return fields[19] ?? null;
}

async function processIdentityForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const [bootId, statContents] = await Promise.all([
    readText("/proc/sys/kernel/random/boot_id"),
    readText(`/proc/${pid}/stat`),
  ]);
  if (statContents) {
    const startTime = procStartTime(statContents);
    if (startTime) {
      return {
        schema: PROCESS_SCHEMA,
        pid,
        ...(bootId ? { boot_id: bootId } : {}),
        start_token: startTime,
      };
    }
  }
  let processStart;
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    });
    processStart = result.stdout.trim();
  } catch {
    processStart = null;
  }
  // A platform without procfs can still establish liveness, but cannot prove
  // PID reuse. Such an observation remains explicitly unproven whenever the
  // lock carries a start token.
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return null;
    if (error.code !== "EPERM") return null;
  }
  return {
    schema: PROCESS_SCHEMA,
    pid,
    ...(bootId ? { boot_id: bootId } : {}),
    ...(processStart ? { start_token: processStart } : {}),
    host: hostname(),
  };
}

async function currentProcessIdentity() {
  return (await processIdentityForPid(process.pid)) ?? {
    schema: PROCESS_SCHEMA,
    pid: process.pid,
    host: hostname(),
  };
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function validNonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function processIdentityStatus(identity) {
  if (
    !identity ||
    typeof identity !== "object" ||
    identity.schema !== PROCESS_SCHEMA ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0
  ) {
    return "invalid";
  }
  for (const field of ["boot_id", "start_token", "host"]) {
    if (identity[field] !== undefined && !validNonEmpty(identity[field])) {
      return "invalid";
    }
  }
  return identity.start_token ? "valid" : "unproven";
}

/**
 * Build the explicit operation/authority evidence used by public mutation
 * paths. The operation ID is stable and human-correlatable for the logical
 * command/resource; the process authority separates competing invocations.
 */
export function registryOperation(kind, resource, payload) {
  if (!validNonEmpty(kind) || !validNonEmpty(resource)) {
    throw new DrovrError(
      "registry operation evidence requires a kind and resource",
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  const operation = {
    id: `drovr:${kind}:${resource}`,
    kind,
  };
  if (payload !== undefined) {
    operation.payload_digest = digestCanonical(payload);
  }
  return operation;
}

function sameOperation(left, right) {
  return left?.id === right?.id &&
    left?.kind === right?.kind &&
    (left?.payload_digest ?? null) === (right?.payload_digest ?? null);
}

export function registryLockOptions(operation, options = {}) {
  if (!operation || typeof operation !== "object") {
    throw new DrovrError(
      "registry lock options require explicit operation evidence",
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  return {
    ...options,
    operation: clone(operation),
    authorityId: options.authorityId ?? `process:${process.pid}`,
    recover: options.recover ?? recoverAbsentRegistryOperation(operation),
  };
}

/**
 * Construct adoption evidence only after the owner process is proven absent
 * and the surviving lock still names this exact public operation. Callers
 * must opt into this helper from a known lifecycle operation; it is not a
 * generic unlock decision.
 */
export function recoverAbsentRegistryOperation(operation) {
  if (!operation || typeof operation !== "object") {
    throw new DrovrError(
      "registry recovery requires explicit operation evidence",
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  return async (input) => {
    const matchingOperation = sameOperation(input.lock?.operation, operation);
    if (input.owner_status !== "absent" || !matchingOperation) {
      throw lockRecoveryError(
        "registry lock recovery requires proof that this exact operation owner is absent",
        {
          resource_key: input.resource_key,
          lock: clone(input.lock),
          owner_status: input.owner_status,
          authority_watermark: clone(input.authority_watermark),
          legal_next_actions: publicRecoveryActions(
            input.owner_status,
            input.lock,
          ),
        },
      );
    }
    return {
      action: "adopt",
      evidence: {
        kind: "continuing_operation",
        operation_id: operation.id,
        operation_kind: operation.kind,
        ...(operation.payload_digest
          ? { operation_payload_digest: operation.payload_digest }
          : {}),
        owner_status: "absent",
        process_identity: clone(input.lock.owner.process_identity),
      },
      authority_watermark: clone(input.authority_watermark),
    };
  };
}

function normalizeLockOptions(key, options = {}) {
  const operation = options.operation ?? {};
  const owner = options.owner ?? {};
  const operationId =
    options.operationId ??
    operation.id ??
    `operation:${randomUUID()}`;
  const authorityId =
    options.authorityId ??
    operation.authorityId ??
    operation.authority_id ??
    owner.authority_id ??
    `process:${process.pid}`;
  if (!validNonEmpty(operationId) || !validNonEmpty(authorityId)) {
    throw new DrovrError(
      "registry lock acquisition requires an operation and authority identity",
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  return {
    ...options,
    operationId,
    authorityId,
    processIdentity:
      options.processIdentity ?? owner.process_identity,
    operationKind: options.operationKind ?? operation.kind ?? "registry_mutation",
    operationPayloadDigest:
      options.operationPayloadDigest ?? operation.payload_digest,
  };
}

function lockDocument({
  key,
  operationId,
  operationKind,
  authorityId,
  processIdentity,
  operationPayloadDigest,
  acquisitionWatermark,
  lockId = randomUUID(),
  acquiredAt = new Date().toISOString(),
}) {
  return {
    schema: LOCK_SCHEMA,
    lock_id: lockId,
    resource_key: key,
    operation: {
      id: operationId,
      kind: operationKind,
      ...(operationPayloadDigest
        ? { payload_digest: operationPayloadDigest }
        : {}),
    },
    owner: {
      authority_id: authorityId,
      process_identity: clone(processIdentity),
    },
    acquisition_watermark: clone(acquisitionWatermark),
    // This is evidence for diagnostics only. It is never consulted for
    // liveness, recovery, or takeover.
    acquired_at: acquiredAt,
  };
}

function lockDetails({
  key,
  path,
  metadata,
  authorityWatermark,
  ownerStatus,
  legalNextActions,
}) {
  return {
    schema: LOCK_SCHEMA,
    resource_key: key,
    lock_path: path,
    lock: clone(metadata),
    owner_status: ownerStatus,
    authority_watermark: clone(authorityWatermark),
    legal_next_actions: [...legalNextActions],
  };
}

function lockRecoveryError(
  message,
  details,
  { outcome = "registry_lock_recovery_required", code = 0 } = {},
) {
  return new DrovrError(message, { code, outcome, details });
}

function releaseFailureLegalActions(metadata) {
  return [
    ...new Set([
      ...publicRecoveryActions("unproven", metadata),
      "status",
    ]),
  ];
}

async function enrichReleaseFailure(error, directory, state) {
  if (error?.outcome !== "registry_lock_release_failed") throw error;
  let authorityWatermark;
  try {
    authorityWatermark = await registryWatermark(directory);
  } catch {
    // Preserve the original release failure if the registry itself cannot be
    // read. Do not substitute the acquisition watermark for current evidence.
    throw error;
  }
  error.details = {
    ...(error.details ?? {}),
    resource_key: state.resource_key,
    lock_path: state.lock_path,
    authority_watermark: authorityWatermark,
    legal_next_actions: releaseFailureLegalActions(state.metadata),
  };
  throw error;
}

async function enrichRecoveryBlock(error, directory, state) {
  if (error?.outcome !== "registry_lock_recovery_required") throw error;
  let authorityWatermark;
  try {
    authorityWatermark = await registryWatermark(directory);
  } catch {
    throw error;
  }
  error.details = {
    ...(error.details ?? {}),
    resource_key: state.resource_key,
    lock_path: state.lock_path,
    owner_status: "unproven",
    authority_watermark: authorityWatermark,
    legal_next_actions: ["status"],
  };
  throw error;
}

async function removeOwnedLockWithEvidence(state, directory, options) {
  try {
    return await removeOwnedLock(state, options);
  } catch (error) {
    if (error?.outcome === "registry_lock_recovery_required") {
      return enrichRecoveryBlock(error, directory, state);
    }
    return enrichReleaseFailure(error, directory, state);
  }
}

async function removeBareLockWithEvidence(state, directory, options) {
  try {
    return await removeBareLock(state, options);
  } catch (error) {
    return enrichReleaseFailure(error, directory, state);
  }
}

async function writeOwnerDocument(path, metadata, fs = {}) {
  const temporary = join(
    path,
    `.owner-${metadata.lock_id}.${process.pid}.${randomUUID()}.tmp`,
  );
  const ownerPath = ownerDocumentPath(path);
  const markerPath = ownerMarkerPath(path, metadata.lock_id);
  const openImpl = fs.open ?? open;
  const renameImpl = fs.rename ?? rename;
  const chmodImpl = fs.chmod ?? chmod;
  // A token-specific marker makes release safe against a successor that
  // recreates the hashed lock directory after this owner starts releasing.
  await openImpl(markerPath, "wx", 0o600).then(async (marker) => {
    try {
      await marker.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await marker.sync();
    } finally {
      await marker.close();
    }
  });
  const handle = await openImpl(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameImpl(temporary, ownerPath);
  await chmodImpl(ownerPath, 0o600);
  await chmodImpl(markerPath, 0o600);
  return { ownerPath, markerPath };
}

function temporaryLockFilePath(directory, key) {
  return join(
    directory,
    "locks",
    `.${lockDigest(key)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function publishLock(directory, key, metadata, fs = {}) {
  const path = resourceLockPath(directory, key);
  const stagingPath = temporaryLockFilePath(directory, key);
  const openImpl = fs.open ?? open;
  const linkImpl = fs.link ?? link;
  const rmImpl = fs.rm ?? rm;
  let handle;
  try {
    handle = await openImpl(stagingPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    try {
      await rmImpl(stagingPath, { force: false });
    } catch {
      // Preserve the publication error; the staging file remains ignored.
    }
    throw error;
  }
  const tokenPath = ownerTokenPath(path, metadata.lock_id);
  let tokenPublished = false;
  try {
    // Publish the owner token first. A crash before the canonical no-replace
    // link leaves only ignored token debris, never an authoritative lock.
    await linkImpl(stagingPath, tokenPath);
    tokenPublished = true;
    // A hard link is an atomic no-replace publication. Unlike directory
    // rename, it cannot overwrite an existing empty legacy lock directory.
    await linkImpl(stagingPath, path);
  } catch (error) {
    if (tokenPublished) {
      try {
        await rmImpl(tokenPath, { force: false });
      } catch {
        // Preserve the publication error; an unreferenced token is ignored.
      }
    }
    throw error;
  } finally {
    try {
      await rmImpl(stagingPath, { force: false });
    } catch {
      // A linked staging file is harmless and is outside the lock namespace.
      // Preserve the published lock even if debris cleanup fails.
    }
  }
}

function validateLockDocument(value) {
  if (!value || typeof value !== "object" || value.schema !== LOCK_SCHEMA) {
    throw new Error("unexpected lock schema");
  }
  if (!validNonEmpty(value.lock_id) || !validNonEmpty(value.resource_key)) {
    throw new Error("lock identity is incomplete");
  }
  if (!value.operation || typeof value.operation !== "object" ||
      !validNonEmpty(value.operation.id) || !validNonEmpty(value.operation.kind)) {
    throw new Error("lock operation identity is incomplete");
  }
  if (!value.owner || typeof value.owner !== "object" ||
      !validNonEmpty(value.owner.authority_id) ||
      !value.owner.process_identity ||
      typeof value.owner.process_identity !== "object" ||
      value.owner.process_identity.schema !== PROCESS_SCHEMA ||
      typeof value.owner.process_identity.pid !== "number") {
    throw new Error("lock owner identity is incomplete");
  }
  if (!value.acquisition_watermark ||
      value.acquisition_watermark.schema !== WATERMARK_SCHEMA ||
      !validNonEmpty(value.acquisition_watermark.generation) ||
      !validNonEmpty(value.acquisition_watermark.registry_sha256)) {
    throw new Error("lock acquisition watermark is incomplete");
  }
  return value;
}

async function parseOwnerFile(path, name) {
  try {
    const ownerPath = join(path, name);
    await validatePrivateFile(ownerPath);
    const value = JSON.parse(await readFile(ownerPath, "utf8"));
    return validateLockDocument(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw lockRecoveryError(
      `corrupt registry lock owner document ${join(path, name)}`,
      { lock_path: path, owner_file: name, error: error.message },
      { outcome: "corrupt_registry", code: 5 },
    );
  }
}

async function parseLockFile(path, key) {
  try {
    await validatePrivateFile(path);
    const value = JSON.parse(await readFile(path, "utf8"));
    validateLockDocument(value);
    if (key && value.resource_key !== key) {
      throw new Error("lock resource key does not match its path");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw lockRecoveryError(
      `corrupt registry lock document ${path}`,
      { lock_path: path, error: error.message },
      { outcome: "corrupt_registry", code: 5 },
    );
  }
}

async function lockEntry(path, key = null) {
  try {
    const entry = await lstat(path);
    if (entry.isFile()) {
      return { type: "file", metadata: await parseLockFile(path, key) };
    }
    if (!entry.isDirectory()) {
      throw new DrovrError(`unsafe registry lock path ${path}`, {
        code: 3,
        outcome: "unsafe_state_permissions",
      });
    }
    if ((entry.mode & 0o077) !== 0) {
      throw new DrovrError(
        `unsafe registry lock directory ${path}: expected owner-only permissions`,
        { code: 3, outcome: "unsafe_state_permissions" },
      );
    }
    const names = await readdir(path).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let metadata = await parseOwnerFile(path, "owner.json");
    if (!metadata) {
      const marker = names
        .filter((name) => name.startsWith("owner-") && name.endsWith(".json"))
        .sort()[0];
      metadata = marker ? await parseOwnerFile(path, marker) : null;
    }
    if (metadata && key && metadata.resource_key !== key) {
      throw lockRecoveryError(
        `registry lock resource key does not match its path ${path}`,
        { lock_path: path, resource_key: metadata.resource_key, expected_resource_key: key },
        { outcome: "corrupt_registry", code: 5 },
      );
    }
    if (metadata && LOCK_ENTRY_PATTERN.test(basename(path)) &&
        lockDigest(metadata.resource_key) !== basename(path)) {
      throw lockRecoveryError(
        `registry lock path does not match its resource key ${path}`,
        { lock_path: path, resource_key: metadata.resource_key },
        { outcome: "corrupt_registry", code: 5 },
      );
    }
    return { type: "directory", metadata };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readResourceLockAtPath(path, key = null) {
  const entry = await lockEntry(path, key);
  if (!entry) return { status: "absent", resource_key: key, lock_path: path };
  return {
    status: entry.metadata ? "held" : "bare",
    resource_key: key,
    lock_path: path,
    metadata: entry.metadata,
  };
}

export async function readResourceLock(directory, key) {
  return readResourceLockAtPath(resourceLockPath(directory, key), key);
}

export async function resourceLockProjection(directory, options = {}) {
  const authorityWatermark = options.authorityWatermark ??
    await registryWatermark(directory);
  const locksDirectory = join(directory, "locks");
  if (!(await validatePrivateDirectory(locksDirectory))) {
    return {
      schema: "drovr.registry-lock-reconciliation/v1",
      status: "clear",
      authority_watermark: authorityWatermark,
      locks: [],
      legal_next_actions: ["acquire_registry_lock"],
    };
  }
  const entries = (await readdir(locksDirectory)).sort();
  const locks = [];
  for (const entry of entries) {
    // Lock publication is write-then-rename. Staging directories are not
    // resource locks and must never appear as authority in queries.
    if (!LOCK_ENTRY_PATTERN.test(entry)) continue;
    const path = join(locksDirectory, entry);
    const lock = await lockEntry(path);
    if (!lock) continue;
    const { metadata } = lock;
    let expectedEntry;
    if (metadata) {
      try {
        if (!validNonEmpty(metadata.resource_key)) {
          throw new Error("lock resource key must be a non-empty string");
        }
        expectedEntry = lockDigest(metadata.resource_key);
      } catch (error) {
        throw lockRecoveryError(
          `registry lock metadata has an invalid resource key ${path}`,
          {
            lock_path: path,
            resource_key: clone(metadata.resource_key),
            error: error.message,
          },
          { outcome: "corrupt_registry", code: 5 },
        );
      }
    }
    if (metadata && expectedEntry !== entry) {
      throw lockRecoveryError(
        `registry lock path does not match its resource key ${path}`,
        {
          lock_path: path,
          resource_key: metadata.resource_key,
          expected_entry: expectedEntry,
          observed_entry: entry,
        },
        { outcome: "corrupt_registry", code: 5 },
      );
    }
    const ownerStatus = metadata
      ? await ownerLiveness(metadata, options)
      : "unproven";
    const legalNextActions = metadata
      ? publicRecoveryActions(ownerStatus, metadata)
      : publicRecoveryActions("unproven", null);
    locks.push({
      resource_key: metadata?.resource_key ?? null,
      lock_entry: entry,
      lock_path: path,
      status: metadata ? "held" : "bare",
      owner_status: ownerStatus,
      ...(metadata
        ? {
            operation: clone(metadata.operation),
            authority_id: metadata.owner.authority_id,
            acquisition_watermark: metadata.acquisition_watermark,
          }
        : {}),
      legal_next_actions: legalNextActions,
    });
  }
  const legalNextActions = [
    ...new Set(locks.flatMap(({ legal_next_actions: actions }) => actions)),
  ];
  return {
    schema: "drovr.registry-lock-reconciliation/v1",
    status: locks.length === 0 ? "clear" : "blocked",
    authority_watermark: authorityWatermark,
    locks,
    legal_next_actions: legalNextActions.length
      ? legalNextActions
      : ["acquire_registry_lock"],
  };
}

async function ownerLiveness(metadata, options = {}) {
  const processRecord = metadata?.owner?.process_identity;
  const processStatus = processIdentityStatus(processRecord);
  if (processStatus !== "valid") return "unproven";
  if (typeof options.ownerLiveness === "function") {
    const result = await options.ownerLiveness(clone(metadata));
    if (["live", "absent", "unproven"].includes(result)) return result;
  }
  const recordedStart = processRecord.start_token;
  const observed = await processIdentityForPid(processRecord.pid);
  if (!observed) return "absent";
  if (processIdentityStatus(observed) !== "valid") return "unproven";
  if (
    processRecord.boot_id &&
    observed.boot_id &&
    processRecord.boot_id !== observed.boot_id
  ) {
    return "absent";
  }
  if (
    recordedStart &&
    observed.start_token &&
    recordedStart !== observed.start_token
  ) {
    return "absent";
  }
  if (recordedStart && !observed.start_token) {
    return "unproven";
  }
  return "live";
}

function sameWatermark(left, right) {
  return Boolean(left && right && digestCanonical(left) === digestCanonical(right));
}

function sameInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameLockDocument(left, right) {
  return Boolean(left && right) && digestCanonical(left) === digestCanonical(right);
}

async function lockFileMetadata(path, key) {
  const metadata = await parseLockFile(path, key);
  if (!metadata) return null;
  return { metadata, stat: await lstat(path) };
}

async function claimOwnerToken(state, options) {
  const metadata = state.metadata;
  const tokenPath = ownerTokenPath(state.lock_path, metadata.lock_id);
  const linkImpl = options.fs?.link ?? link;
  const renameImpl = options.fs?.rename ?? rename;
  const rmImpl = options.fs?.rm ?? rm;
  const existingClaimPath = options.releaseClaimPath;
  let canonical;
  try {
    canonical = await lockFileMetadata(state.lock_path, state.resource_key);
  } catch (error) {
    throw lockRecoveryError(
      `cannot validate registry lock for ${state.resource_key}`,
      {
        resource_key: state.resource_key,
        lock_path: state.lock_path,
        lock_id: metadata.lock_id,
        error: error.message,
      },
      { outcome: "registry_lock_release_failed", code: 5 },
    );
  }
  if (
    !canonical ||
    canonical.metadata.lock_id !== metadata.lock_id ||
    !sameLockDocument(canonical.metadata, metadata)
  ) {
    return {
      status: "successor_owner",
      resource_key: state.resource_key,
      expected_lock_id: metadata.lock_id,
      observed_lock_id: canonical?.metadata?.lock_id ?? null,
      already_released: true,
    };
  }

  let claimPath = existingClaimPath;
  if (claimPath) {
    try {
      const claim = await lockFileMetadata(claimPath, state.resource_key);
      if (claim && sameInode(claim.stat, canonical.stat) &&
          claim.metadata.lock_id === metadata.lock_id &&
          sameLockDocument(claim.metadata, metadata)) {
        return { status: "claimed", claimPath, tokenPath };
      }
    } catch {
      // A failed prior claim is reconstructed from the canonical lock below.
    }
    claimPath = null;
  }
  const claimant = await currentProcessIdentity();
  claimPath ??= ownerClaimPath(state.lock_path, metadata.lock_id, claimant);

  try {
    // A different releaser may already own the token claim. Never recreate a
    // missing token in that case: doing so would give the second releaser a
    // path to the canonical inode after the first one publishes a successor.
    if (!existingClaimPath) {
      const names = await readdir(dirname(state.lock_path)).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const claimPrefix = `${basename(tokenPath)}.`;
      for (const name of names.filter((item) => item.startsWith(claimPrefix) && item.endsWith(".claim"))) {
        const identity = claimProcessIdentity(name, basename(tokenPath));
        if (!identity) {
          throw lockRecoveryError(
            `registry lock has an unproven owner claim for ${state.resource_key}`,
            { resource_key: state.resource_key, lock_path: state.lock_path, claim: name },
            { outcome: "registry_lock_recovery_required", code: 0 },
          );
        }
        const claimantStatus = await ownerLiveness({ owner: { process_identity: identity } });
        if (claimantStatus !== "absent") {
          return {
            status: "successor_owner",
            resource_key: state.resource_key,
            expected_lock_id: metadata.lock_id,
            observed_lock_id: metadata.lock_id,
            already_released: true,
          };
        }
        await rmImpl(join(dirname(tokenPath), name), { force: false });
      }
    }
    let token;
    try {
      token = await lockFileMetadata(tokenPath, state.resource_key);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!token) {
      await linkImpl(state.lock_path, tokenPath);
      token = await lockFileMetadata(tokenPath, state.resource_key);
    }
    if (
      !token ||
      token.metadata.lock_id !== metadata.lock_id ||
      !sameLockDocument(token.metadata, metadata) ||
      !sameInode(token.stat, canonical.stat)
    ) {
      throw new Error("registry lock owner token does not bind the canonical lock");
    }
    await renameImpl(tokenPath, claimPath);
  } catch (error) {
    if (error?.outcome === "registry_lock_recovery_required") throw error;
    if (error.code === "ENOENT") {
      const current = await readResourceLockAtPath(
        state.lock_path,
        state.resource_key,
      );
      if (
        current.status === "held" &&
        current.metadata?.lock_id !== metadata.lock_id
      ) {
        return {
          status: "successor_owner",
          resource_key: state.resource_key,
          expected_lock_id: metadata.lock_id,
          observed_lock_id: current.metadata.lock_id,
          already_released: true,
        };
      }
      if (
        current.status === "held" &&
        current.metadata?.lock_id === metadata.lock_id &&
        (options.claimAttempt ?? 0) < 2
      ) {
        return claimOwnerToken(state, {
          ...options,
          releaseClaimPath: undefined,
          claimAttempt: (options.claimAttempt ?? 0) + 1,
        });
      }
      if (current.status === "absent") {
        return { status: "released", already_released: true };
      }
    }
    try {
      await rmImpl(claimPath, { force: false });
    } catch {
      // Preserve the original release failure and any owner evidence.
    }
    throw lockRecoveryError(
      `cannot claim registry lock owner token for ${state.resource_key}`,
      {
        resource_key: state.resource_key,
        lock_path: state.lock_path,
        lock_id: metadata.lock_id,
        error: error.message,
      },
      { outcome: "registry_lock_release_failed", code: 5 },
    );
  }

  const claimed = await lockFileMetadata(claimPath, state.resource_key);
  const current = await lockFileMetadata(state.lock_path, state.resource_key);
  if (
    !claimed ||
    !current ||
    claimed.metadata.lock_id !== metadata.lock_id ||
    !sameLockDocument(claimed.metadata, metadata) ||
    !sameInode(claimed.stat, current.stat) ||
    current.metadata.lock_id !== metadata.lock_id ||
    !sameLockDocument(current.metadata, metadata)
  ) {
    try {
      await rmImpl(claimPath, { force: false });
    } catch {
      // Preserve the surviving successor and report the owner mismatch.
    }
    return {
      status: "successor_owner",
      resource_key: state.resource_key,
      expected_lock_id: metadata.lock_id,
      observed_lock_id: current?.metadata?.lock_id ?? null,
      already_released: true,
    };
  }
  return { status: "claimed", claimPath, tokenPath };
}

async function removeOwnedLock(state, options = {}) {
  const { fs = {} } = options;
  const metadata = state.metadata;
  if (!metadata?.lock_id) {
    throw lockRecoveryError(
      `cannot release bare registry lock for ${state.resource_key}`,
      {
        resource_key: state.resource_key,
        lock_path: state.lock_path,
        legal_next_actions: [REGISTRY_LOCK_RECOVERY_ACTIONS.abandon],
      },
    );
  }
  const unlinkImpl = fs.rm ?? rm;
  const rmdirImpl = fs.rmdir ?? rmdir;
  let pathMetadata;
  try {
    const pathStat = await lstat(state.lock_path);
    pathMetadata = pathStat.isFile() ? "file" : "directory";
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "released", already_released: true };
    }
    throw error;
  }
  if (pathMetadata === "file") {
    const claim = await claimOwnerToken(state, {
      fs,
      releaseClaimPath: options.releaseClaimPath,
    });
    if (claim.status !== "claimed") return claim;
    options.releaseClaimPath = claim.claimPath;
    try {
      await unlinkImpl(state.lock_path, { force: false });
    } catch (error) {
      if (error.code === "ENOENT") {
        const successor = await readResourceLockAtPath(
          state.lock_path,
          state.resource_key,
        );
        return successor.status === "held" &&
          successor.metadata?.lock_id !== metadata.lock_id
          ? {
              status: "successor_owner",
              resource_key: state.resource_key,
              expected_lock_id: metadata.lock_id,
              observed_lock_id: successor.metadata.lock_id,
              already_released: true,
            }
          : { status: "released", already_released: true };
      }
      try {
        const linkImpl = fs.link ?? link;
        await linkImpl(claim.claimPath, claim.tokenPath);
      } catch {
        // Preserve the claim as durable owner evidence for a later retry.
      }
      throw lockRecoveryError(
        `cannot release registry lock for ${state.resource_key}`,
        {
          resource_key: state.resource_key,
          lock_path: state.lock_path,
          lock_id: metadata.lock_id,
          error: error.message,
        },
        { outcome: "registry_lock_release_failed", code: 5 },
      );
    }
    try {
      await unlinkImpl(claim.claimPath, { force: false });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw lockRecoveryError(
          `cannot release registry lock owner token for ${state.resource_key}`,
          {
            resource_key: state.resource_key,
            lock_path: state.lock_path,
            lock_id: metadata.lock_id,
            error: error.message,
          },
          { outcome: "registry_lock_release_failed", code: 5 },
        );
      }
    }
    return { status: "released", lock_id: metadata.lock_id };
  }
  const markerPath = ownerMarkerPath(state.lock_path, metadata.lock_id);
  try {
    await unlinkImpl(markerPath, { force: false });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "successor_owner", already_released: true };
    }
    throw lockRecoveryError(
      `cannot release registry lock for ${state.resource_key}`,
      {
        resource_key: state.resource_key,
        lock_path: state.lock_path,
        lock_id: metadata.lock_id,
        error: error.message,
      },
      { outcome: "registry_lock_release_failed", code: 5 },
    );
  }
  // Remove only files that belong to this token. A non-empty directory is
  // retained if a successor has already acquired the same resource.
  try {
    await unlinkImpl(ownerDocumentPath(state.lock_path), { force: false });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw lockRecoveryError(
        `cannot release registry lock owner document for ${state.resource_key}`,
        {
          resource_key: state.resource_key,
          lock_path: state.lock_path,
          lock_id: metadata.lock_id,
          error: error.message,
        },
        { outcome: "registry_lock_release_failed", code: 5 },
      );
    }
  }
  try {
    await rmdirImpl(state.lock_path);
  } catch (error) {
    if (["ENOTEMPTY", "EEXIST"].includes(error.code)) {
      const successor = await readResourceLockAtPath(
        state.lock_path,
        state.resource_key,
      );
      if (
        successor.status === "held" &&
        successor.metadata?.lock_id !== metadata.lock_id
      ) {
        return {
          status: "successor_owner",
          resource_key: state.resource_key,
          expected_lock_id: metadata.lock_id,
          observed_lock_id: successor.metadata.lock_id,
          already_released: true,
        };
      }
    }
    // Keep the owner evidence durable when storage rejects directory removal.
    // A later reconciliation can retry the same owner-checked release without
    // turning a release failure into an anonymous lock.
    try {
      await writeOwnerDocument(state.lock_path, metadata, fs);
    } catch {
      // The original release failure remains the authoritative result.
    }
    if (error.code === "ENOENT") {
      return { status: "released", already_released: true };
    }
    throw lockRecoveryError(
      `cannot remove registry lock directory for ${state.resource_key}`,
      {
        resource_key: state.resource_key,
        lock_path: state.lock_path,
        lock_id: metadata.lock_id,
        error: error.message,
      },
      { outcome: "registry_lock_release_failed", code: 5 },
    );
  }
  return { status: "released", lock_id: metadata.lock_id };
}

async function removeBareLock(state, { fs = {} } = {}) {
  const rmdirImpl = fs.rmdir ?? rmdir;
  try {
    await rmdirImpl(state.lock_path);
    return { status: "released", bare: true };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "released", already_released: true, bare: true };
    }
    throw lockRecoveryError(
      `cannot remove unreconciled bare registry lock for ${state.resource_key}`,
      {
        resource_key: state.resource_key,
        lock_path: state.lock_path,
        error: error.message,
        legal_next_actions: [REGISTRY_LOCK_RECOVERY_ACTIONS.abandon],
      },
      { outcome: "registry_lock_release_failed", code: 5 },
    );
  }
}

function recoveryLegalActions(ownerStatus, metadata) {
  if (ownerStatus === "live") {
    return ["wait_for_registry_lock", "reconcile_registry_lock"];
  }
  if (!metadata) return [REGISTRY_LOCK_RECOVERY_ACTIONS.abandon];
  return [
    REGISTRY_LOCK_RECOVERY_ACTIONS.adopt,
    REGISTRY_LOCK_RECOVERY_ACTIONS.proven_absence,
  ];
}

function publicRecoveryActions(ownerStatus, metadata) {
  if (ownerStatus === "live") {
    return ["status"];
  }
  if (!metadata?.operation?.kind) return [PUBLIC_BARE_LOCK_ABANDON_ACTION];
  const actionByOperation = {
    "agent.start": "agent_start",
    "agent.retire": "agent_retire",
    "agent.stage_unknown_input": "agent_staged_input",
    "agent.recover_staged_input": "agent_staged_input",
    "task.open": "task_open",
    "task.close": "task_close",
    "group.close": "group_close",
    "turn.start": "turn_start",
    "turn.dispatch": "turn_dispatch",
    "turn.wait": "turn_wait",
    "turn.send": "turn_send",
    "turn.cancel": "turn_cancel",
  };
  return [actionByOperation[metadata.operation.kind] ?? "status"];
}

function recoveryDecisionError(message, details) {
  return lockRecoveryError(message, details, {
    outcome: "registry_lock_recovery_evidence_invalid",
    code: 0,
  });
}

async function applyRecoveryDecision(
  directory,
  key,
  state,
  decision,
  options = {},
) {
  const authorityWatermark = await registryWatermark(directory);
  const details = lockDetails({
    key,
    path: state.lock_path,
    metadata: state.metadata,
    ownerStatus: state.owner_status,
    authorityWatermark,
    legalNextActions: recoveryLegalActions(state.owner_status, state.metadata),
  });
  if (!decision || typeof decision !== "object") {
    throw recoveryDecisionError("registry lock recovery requires a typed decision", details);
  }
  if (!decision.authority_watermark) {
    throw recoveryDecisionError(
      "registry lock recovery requires the exact current authority watermark",
      details,
    );
  }
  if (!sameWatermark(decision.authority_watermark, authorityWatermark)) {
    throw recoveryDecisionError(
      "registry lock recovery evidence is bound to a stale authority watermark",
      { ...details, evidence_watermark: decision.authority_watermark },
    );
  }
  const evidence = decision.evidence;
  const action = decision.action ?? decision.decision;
  if (!evidence || typeof evidence !== "object" || !validNonEmpty(evidence.kind)) {
    throw recoveryDecisionError(
      "registry lock recovery requires typed evidence",
      details,
    );
  }
  if (action === "adopt") {
    if (evidence.kind !== "continuing_operation") {
      throw recoveryDecisionError(
        "registry lock adoption requires continuing-operation evidence",
        details,
      );
    }
    if (!state.metadata?.owner?.process_identity) {
      throw recoveryDecisionError(
        "registry lock adoption requires surviving owner evidence",
        details,
      );
    }
    if (
      evidence.operation_id !== state.metadata?.operation?.id ||
      evidence.operation_kind !== state.metadata?.operation?.kind ||
      (evidence.operation_payload_digest ?? null) !==
        (state.metadata?.operation?.payload_digest ?? null) ||
      evidence.owner_status !== "absent" ||
      state.owner_status !== "absent" ||
      digestCanonical(evidence.process_identity) !==
        digestCanonical(state.metadata?.owner?.process_identity)
    ) {
      throw recoveryDecisionError(
        "registry lock adoption cannot change the owning operation",
        details,
      );
    }
    const operationId = state.metadata.operation.id;
    const authorityId = decision.authority_id ?? options.authorityId;
    if (!validNonEmpty(authorityId)) {
      throw recoveryDecisionError(
        "registry lock adoption requires the continuing authority identity",
        details,
      );
    }
    const processIdentity =
      decision.process_identity ?? options.processIdentity ?? (await currentProcessIdentity());
    const replacement = lockDocument({
      key,
      operationId,
      operationKind: state.metadata.operation.kind,
      operationPayloadDigest: state.metadata.operation.payload_digest,
      authorityId,
      processIdentity,
      acquisitionWatermark: authorityWatermark,
    });
    const released = state.metadata
      ? await removeOwnedLockWithEvidence(state, directory, options)
      : await removeBareLockWithEvidence(state, directory, options);
    if (released.status !== "released") {
      throw recoveryDecisionError(
        "registry lock adoption lost the predecessor before replacement",
        { ...details, release: released },
      );
    }
    await publishLock(directory, key, replacement, options.fs);
    return {
      status: "adopted",
      metadata: replacement,
      authority_watermark: authorityWatermark,
      legal_next_actions: ["release_registry_lock"],
    };
  }
  if (action === "proven_absence") {
    if (evidence.kind !== "operation_absence") {
      throw recoveryDecisionError(
        "registry lock release requires operation-absence evidence",
        details,
      );
    }
    if (
      !state.metadata?.owner?.process_identity ||
      evidence.operation_id !== state.metadata?.operation?.id ||
      evidence.operation_kind !== state.metadata?.operation?.kind ||
      (evidence.operation_payload_digest ?? null) !==
        (state.metadata?.operation?.payload_digest ?? null) ||
      evidence.owner_status !== "absent" ||
      state.owner_status !== "absent" ||
      digestCanonical(evidence.process_identity) !==
        digestCanonical(state.metadata?.owner?.process_identity)
    ) {
      throw recoveryDecisionError(
        "operation-absence evidence does not bind the surviving lock owner",
        details,
      );
    }
    const released = state.metadata
      ? await removeOwnedLockWithEvidence(state, directory, options)
      : await removeBareLockWithEvidence(state, directory, options);
    return {
      status: released.status === "released" ? "released" : "blocked",
      release: released,
      authority_watermark: authorityWatermark,
      legal_next_actions:
        released.status === "released"
          ? ["acquire_registry_lock"]
          : recoveryLegalActions(state.owner_status, state.metadata),
    };
  }
  if (action === "abandon") {
    if (state.metadata || state.owner_status !== "unproven") {
      throw recoveryDecisionError(
        "registry lock abandonment is legal only for a currently bare lock",
        details,
      );
    }
    if (evidence.kind !== "operator_disposition") {
      throw recoveryDecisionError(
        "registry lock abandonment requires typed operator disposition evidence",
        details,
      );
    }
    if (!validNonEmpty(evidence.decision_id)) {
      throw recoveryDecisionError(
        "registry lock abandonment requires an operator decision identity",
        details,
      );
    }
    const abandonmentType =
      decision.abandonment_type ?? decision.abandonment?.type;
    if (!ABANDONMENT_TYPES.has(abandonmentType)) {
      throw recoveryDecisionError(
        "registry lock abandonment requires a closed typed disposition",
        { ...details, allowed_abandonment_types: [...ABANDONMENT_TYPES] },
      );
    }
    const released = state.metadata
      ? await removeOwnedLockWithEvidence(state, directory, options)
      : await removeBareLockWithEvidence(state, directory, options);
    return {
      status: released.status === "released" ? "abandoned" : "blocked",
      abandonment_type: abandonmentType,
      release: released,
      authority_watermark: authorityWatermark,
      legal_next_actions:
        released.status === "released"
          ? ["acquire_registry_lock"]
          : recoveryLegalActions(state.owner_status, state.metadata),
    };
  }
  throw recoveryDecisionError(
    "registry lock recovery action is not legal",
    { ...details, requested_action: action },
  );
}

/**
 * Reconcile one surviving lock through an explicit, watermark-bound decision.
 * This function never considers lock age and never provides a generic force
 * unlock operation.
 */
export async function reconcileResourceLock(
  directory,
  key,
  decision,
  options = {},
) {
  const state = await readResourceLock(directory, key);
  if (state.status === "absent") {
    const authorityWatermark = await registryWatermark(directory);
    return {
      status: "proven_absent",
      resource_key: key,
      authority_watermark: authorityWatermark,
      legal_next_actions: ["acquire_registry_lock"],
    };
  }
  const ownerStatus = state.metadata
    ? await ownerLiveness(state.metadata, options)
    : "unproven";
  return applyRecoveryDecision(
    directory,
    key,
    { ...state, owner_status: ownerStatus },
    decision,
    options,
  );
}

export async function abandonBareRegistryLock(
  directory,
  lockEntry,
  { authorityWatermark, decisionId } = {},
) {
  if (!LOCK_ENTRY_PATTERN.test(lockEntry ?? "")) {
    throw new DrovrError("bare registry lock abandonment requires a hashed lock entry", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  if (!validNonEmpty(decisionId)) {
    throw new DrovrError(
      "bare registry lock abandonment requires a non-empty operator decision identity",
      { code: 2, outcome: "invalid_arguments" },
    );
  }
  const lockPath = join(directory, "locks", lockEntry);
  const state = await readResourceLockAtPath(lockPath);
  const currentWatermark = await registryWatermark(directory);
  const details = {
    resource_key: null,
    lock_entry: lockEntry,
    lock_path: lockPath,
    owner_status: state.status === "bare" ? "unproven" : null,
    authority_watermark: currentWatermark,
    legal_next_actions: state.status === "bare"
      ? [PUBLIC_BARE_LOCK_ABANDON_ACTION]
      : ["status"],
  };
  if (state.status !== "bare") {
    throw lockRecoveryError(
      "public bare registry lock abandonment requires a currently bare lock entry",
      details,
      { outcome: "registry_lock_recovery_evidence_invalid", code: 0 },
    );
  }
  if (!sameWatermark(authorityWatermark, currentWatermark)) {
    throw lockRecoveryError(
      "public bare registry lock abandonment requires the exact current authority watermark",
      { ...details, evidence_watermark: authorityWatermark },
      { outcome: "registry_lock_recovery_evidence_invalid", code: 0 },
    );
  }
  const result = await applyRecoveryDecision(
    directory,
    null,
    { ...state, owner_status: "unproven" },
    {
      action: "abandon",
      abandonment_type: "operator_disposition",
      evidence: { kind: "operator_disposition", decision_id: decisionId },
      authority_watermark: currentWatermark,
    },
  );
  return { ...result, lock_entry: lockEntry };
}

export async function acquireResourceLock(directory, key, options = {}) {
  const normalized = normalizeLockOptions(key, options);
  await ensureStateDirectory(directory);
  const path = resourceLockPath(directory, key);
  const fs = normalized.fs ?? {};
  for (let attempt = 0; ; attempt += 1) {
    try {
      const watermark = await registryWatermark(directory);
      const processIdentity =
        normalized.processIdentity ?? (await currentProcessIdentity());
      const metadata = lockDocument({
        key,
        operationId: normalized.operationId,
        operationKind: normalized.operationKind,
        authorityId: normalized.authorityId,
        processIdentity,
        operationPayloadDigest: normalized.operationPayloadDigest,
        acquisitionWatermark: watermark,
      });
      // Build and fsync the complete lock record before atomically linking it
      // into the resource-key namespace. A process loss during publication
      // leaves only ignored staging debris, never a bare authoritative lock.
      await publishLock(directory, key, metadata, fs);
      return {
        directory,
        path,
        metadata,
        fs,
        released: false,
      };
    } catch (error) {
      if (!LOCK_CONTENTION_ERRORS.has(error.code)) throw error;
      const state = await readResourceLock(directory, key);
      // The predecessor may have released between our no-replace publish
      // attempt and this observation. Retry from an absent state instead of
      // treating the contention race as an ownerless lock.
      if (state.status === "absent") continue;
      // A competing publisher may still be completing its atomic rename. A
      // short contention wait lets that publication become visible; exhausting
      // the wait never authorizes takeover of a bare directory.
      if (
        state.status === "bare" &&
        attempt < (normalized.maxAttempts ?? DEFAULT_LOCK_ATTEMPTS)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, normalized.retryDelayMs ?? DEFAULT_LOCK_RETRY_MS),
        );
        continue;
      }
      const ownerStatus = state.metadata
        ? await ownerLiveness(state.metadata, normalized)
        : "unproven";
      if (ownerStatus === "live") {
        if (attempt >= (normalized.maxAttempts ?? DEFAULT_LOCK_ATTEMPTS)) {
          const authorityWatermark = await registryWatermark(directory);
          throw lockRecoveryError(
            `cannot acquire registry lock for ${key}; another owner is live`,
            lockDetails({
              key,
              path,
              metadata: state.metadata,
              ownerStatus,
              authorityWatermark,
              legalNextActions: publicRecoveryActions(ownerStatus, state.metadata),
            }),
            { outcome: "registry_locked", code: 5 },
          );
        }
      } else {
        const recovery = normalized.recover ?? normalized.reconcile;
        if (!recovery) {
          const authorityWatermark = await registryWatermark(directory);
          throw lockRecoveryError(
            state.metadata
              ? `registry lock for ${key} lost its owner and requires evidence-backed recovery`
              : `registry lock for ${key} has no owner evidence and requires reconciliation`,
            lockDetails({
              key,
              path,
              metadata: state.metadata,
              ownerStatus,
              authorityWatermark,
              legalNextActions: publicRecoveryActions(ownerStatus, state.metadata),
            }),
          );
        }
        const authorityWatermark = await registryWatermark(directory);
        const decision = typeof recovery === "function"
          ? await recovery({
              lock: clone(state.metadata),
              resource_key: key,
              lock_path: path,
              owner_status: ownerStatus,
              authority_watermark: authorityWatermark,
              legal_next_actions: publicRecoveryActions(ownerStatus, state.metadata),
            })
          : recovery;
        const result = await applyRecoveryDecision(
          directory,
          key,
          { ...state, owner_status: ownerStatus },
          decision,
          normalized,
        );
        if (result.status === "adopted") {
          return {
            directory,
            path,
            metadata: result.metadata,
            fs,
            released: false,
          };
        }
        if (["released", "abandoned"].includes(result.status)) continue;
        throw lockRecoveryError(
          `registry lock for ${key} could not be reconciled`,
          result,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, normalized.retryDelayMs ?? DEFAULT_LOCK_RETRY_MS),
      );
    }
  }
}

export async function releaseResourceLock(handle) {
  if (!handle || typeof handle !== "object") {
    throw new DrovrError("registry lock release requires an acquisition handle", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  if (handle.released) return { status: "released", already_released: true };
  const expectedPath = resourceLockPath(
    handle.directory,
    handle.metadata.resource_key,
  );
  const state = await readResourceLockAtPath(
    expectedPath,
    handle.metadata.resource_key,
  );
  if (state.status === "absent") {
    handle.released = true;
    return { status: "released", already_released: true };
  }
  if (state.status !== "held" || state.metadata?.lock_id !== handle.metadata.lock_id) {
    handle.released = true;
    return {
      status: "successor_owner",
      resource_key: handle.metadata.resource_key,
      expected_lock_id: handle.metadata.lock_id,
      observed_lock_id: state.metadata?.lock_id ?? null,
      already_released: true,
    };
  }
  const releaseState = {
    resource_key: handle.metadata.resource_key,
    lock_path: expectedPath,
    metadata: handle.metadata,
  };
  const result = await removeOwnedLockWithEvidence(
    releaseState,
    handle.directory,
    handle,
  );
  if (["released", "successor_owner"].includes(result.status)) {
    handle.released = true;
  }
  return result;
}

export async function withResourceLock(directory, key, operation, options = {}) {
  if (typeof operation !== "function") {
    throw new DrovrError("registry lock operation must be a function", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  const handle = await acquireResourceLock(directory, key, options);
  let value;
  let operationError;
  try {
    value = await operation(clone(handle.metadata));
  } catch (error) {
    operationError = error;
  }
  try {
    await releaseResourceLock(handle);
  } catch (releaseError) {
    releaseError.details = {
      ...(releaseError.details ?? {}),
      ...(operationError ? { operation_error: operationError.message } : {}),
    };
    throw releaseError;
  }
  if (operationError) {
    throw operationError;
  }
  return value;
}

/**
 * Acquire a deterministic sorted lock set and release every acquired token on
 * both operation failure and partial acquisition failure.
 */
export async function withOrderedResourceLocks(
  directory,
  keys,
  operation,
  options = {},
) {
  if (!Array.isArray(keys) || keys.some((key) => !validNonEmpty(key))) {
    throw new DrovrError("registry lock keys must be non-empty strings", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  if (typeof operation !== "function") {
    throw new DrovrError("registry lock operation must be a function", {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  const uniqueKeys = [...new Set(keys)].sort();
  const handles = [];
  try {
    for (const key of uniqueKeys) {
      handles.push(await acquireResourceLock(directory, key, options));
    }
    return await operation(handles.map(({ metadata }) => clone(metadata)));
  } finally {
    let firstError;
    for (const handle of handles.reverse()) {
      try {
        await releaseResourceLock(handle);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }
}

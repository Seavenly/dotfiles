import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalize,
  digest,
  freezeCanonical,
} from "../../../tools/flow/src/canonical.mjs";
import {
  BACKUP_PROVIDER_EVIDENCE_SCHEMA,
  BACKUP_RECONCILIATION_OBSERVATION_SCHEMA,
  BACKUP_RECEIPT_SCHEMA,
  RESTORE_EVIDENCE_DOMAINS,
  validateBackupManifest,
} from "../../../tools/flow/src/backup-restore.mjs";
import {
  readAuthorityStream,
  replayAuthorityStream,
} from "../../../tools/flow/src/sqlite-authority-replay.mjs";

const PROVIDER_SCHEMA = "flow.filesystem-backup/v1";
const SNAPSHOT_SCHEMA = "flow.filesystem-backup-snapshot/v1";
const DATABASE_SNAPSHOT_SCHEMA = "flow.filesystem-backup-database-snapshot/v1";
const DROVR_STATUS_SCHEMA = "drovr.command/v1";
const DROVR_RETIREMENT_RECEIPT_SCHEMA =
  "drovr.agent-retirement-receipt/v1";
const DROVR_HANDOFF_RECEIPT_SCHEMA = "flow.drovr-handoff-receipt/v1";
const DROVR_CLI_PATH = fileURLToPath(new URL(
  "../../../tools/drovr/src/cli.mjs",
  import.meta.url,
));
const TERMINAL_DROVR_TURN_STATUSES = new Set([
  "completed",
  "cancelled",
  "interrupted",
  "unsupported_transcript",
  "uncertain",
]);
const SETTLED_EXTERNAL_EFFECT_OUTCOMES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);
const EMPTY_STREAM_DIGEST = `sha256:${"0".repeat(64)}`;
const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_FILE = "snapshot.json";
const DATABASE_FILE = "authority.sqlite";
const AUTHORITY_IGNORED_FILES = new Set([
  DATABASE_FILE,
  "authority.sqlite-shm",
  "authority.sqlite-wal",
  "authority.lock.sqlite",
  "authority.lock.sqlite-shm",
  "authority.lock.sqlite-wal",
  "owner.sock",
  "owner.json",
  "owner-errors.json",
]);
const require = createRequire(import.meta.url);
let databaseSyncConstructor = null;

function createSqliteDatabase(path, options = undefined) {
  databaseSyncConstructor ??= require("node:sqlite").DatabaseSync;
  return options === undefined
    ? new databaseSyncConstructor(path)
    : new databaseSyncConstructor(path, options);
}

/**
 * Construct the production filesystem adapter only when the caller supplies
 * an isolated absolute provider directory.  The adapter deliberately has no
 * fallback to process.cwd(), HOME, or any other ambient state.
 */
export function createProductionBackupRestoreAdapter({
  authorityDirectory,
  backupDirectory,
  repositoryRoot,
  legacyRoots = {},
  env = process.env,
  drovrStatusRunner = null,
} = {}) {
  const authorityRoot = absolutePath(authorityDirectory, "authority directory");
  const providerRoot = absolutePath(backupDirectory, "backup directory");
  const repository = absolutePath(repositoryRoot, "repository root");
  if (isContained(authorityRoot, providerRoot)) {
    throw providerError(
      "backup_store_inside_authority",
      "backup directory must be outside the authority directory",
    );
  }
  if (providerRoot === authorityRoot) {
    throw providerError(
      "backup_store_inside_authority",
      "backup directory must be outside the authority directory",
    );
  }
  assertNoSymlinkAncestors(providerRoot);
  assertNoSymlinkAncestors(authorityRoot);
  const retainedLegacyRoots = normalizeLegacyRoots(legacyRoots);
  for (const legacyRoot of retainedLegacyRoots) {
    assertNoSymlinkAncestors(legacyRoot);
  }
  if (retainedLegacyRoots.some((root) =>
    isContained(authorityRoot, root) || isContained(root, authorityRoot) ||
    isContained(providerRoot, root) || isContained(root, providerRoot))) {
    throw providerError(
      "backup_source_roots_overlap",
      "backup source roots must not overlap authority or provider state",
    );
  }
  if (isContained(providerRoot, repository) ||
      isContained(repository, providerRoot)) {
    throw providerError(
      "backup_repository_overlaps_provider",
      "backup provider state must not overlap the Git repository",
    );
  }
  assertNoSymlinkAncestors(repository);
  const drovrEnvironment = explicitDrovrEnvironment(env);
  if (drovrStatusRunner !== null && typeof drovrStatusRunner !== "function") {
    throw providerError(
      "backup_provider_configuration_invalid",
      "Drovr status runner must be a function",
    );
  }
  if (drovrStatusRunner === null && drovrEnvironment === null) {
    throw providerError(
      "backup_provider_configuration_invalid",
      "Drovr status requires an explicit isolated XDG_STATE_HOME",
    );
  }

  return Object.freeze({
    observeBackup() {
      return observeState({
        authorityRoot,
        repository,
        legacyRoots: retainedLegacyRoots,
        drovrEnvironment,
        drovrStatusRunner,
      });
    },

    createBackup({ manifest, manifest_bytes: manifestBytes, intent } = {}) {
      const validated = validateBackupManifest(manifest);
      assertManifestBytes(validated, manifestBytes);
      const observedDrovr = observeDrovrObligations({
        environment: drovrEnvironment,
        runner: drovrStatusRunner,
      });
      if (digest(observedDrovr) !== digest(validated.drovr_obligations)) {
        throw providerError(
          "backup_drovr_observation_changed",
          "Drovr state changed between observation and backup intent",
        );
      }
      assertSettledDrovrObligations(validated.drovr_obligations);
      const backupId = backupIdFor(validated.manifest_digest);
      ensurePrivateDirectory(providerRoot);
      const target = containedPath(providerRoot, backupId);
      const existing = readBackupRecord(target, validated, {
        allowMissing: true,
      });
      if (existing !== null) {
        return providerReceipt(validated, existing.snapshot_digest, intent);
      }

      const temporary = containedPath(
        providerRoot,
        `.${backupId}.${process.pid}.tmp`,
      );
      removeProviderTemporary(temporary);
      ensurePrivateDirectory(temporary);
      try {
        const snapshot = createSnapshot({
          authorityRoot,
          legacyRoots: retainedLegacyRoots,
          manifest: validated,
          destination: temporary,
        });
        writePrivateJson(
          containedPath(temporary, MANIFEST_FILE),
          validated,
        );
        writePrivateJson(
          containedPath(temporary, SNAPSHOT_FILE),
          snapshot,
        );
        chmodSync(temporary, 0o700);
        try {
          renameSync(temporary, target);
        } catch (error) {
          if (!existsSync(target)) throw error;
          const raced = readBackupRecord(target, validated, {
            allowMissing: false,
          });
          return providerReceipt(validated, raced.snapshot_digest, intent);
        }
        return providerReceipt(validated, snapshot.snapshot_digest, intent);
      } catch (error) {
        removeProviderTemporary(temporary);
        throw providerFailure(error, "backup_write_failed");
      }
    },

    reconcile({ manifest, intent } = {}) {
      const validated = validateBackupManifest(manifest);
      const target = containedPath(providerRoot, backupIdFor(
        validated.manifest_digest,
      ));
      if (!existsSync(providerRoot)) {
        return backupAbsence(validated, intent);
      }
      ensurePrivateDirectory(providerRoot);
      if (!existsSync(target)) return backupAbsence(validated, intent);
      const record = readBackupRecord(target, validated, {
        allowMissing: false,
      });
      const receipt = backupReceipt(validated, record.snapshot_digest, intent);
      return freezeCanonical({
        schema: BACKUP_RECONCILIATION_OBSERVATION_SCHEMA,
        operation: "backup_create",
        operation_id: intent?.operation_id,
        idempotency_key: intent?.idempotency_key,
        manifest_digest: validated.manifest_digest,
        status: "present",
        receipt,
        provider_evidence: {
          schema: BACKUP_PROVIDER_EVIDENCE_SCHEMA,
          provider: PROVIDER_SCHEMA,
          proof_id: `present:${validated.manifest_digest}`,
          outcome: "present",
        },
      });
    },

    restore({ manifest, intent } = {}) {
      const validated = validateBackupManifest(manifest);
      const target = containedPath(providerRoot, backupIdFor(
        validated.manifest_digest,
      ));
      ensurePrivateDirectory(providerRoot);
      const record = readBackupRecord(target, validated, {
        allowMissing: false,
      });
      const restorePlan = preflightRestore({
        authorityRoot,
        legacyRoots: retainedLegacyRoots,
        record,
      });
      if (record.snapshot.database_snapshot !== null) {
        restoreDatabaseStreams(
          containedPath(authorityRoot, DATABASE_FILE),
          record.snapshot.database_snapshot,
        );
      }
      let restoredFiles = 0;
      for (const item of restorePlan.files) {
        restoreSnapshotFile(item.source, item.bytes, item.destination);
        restoredFiles += 1;
      }
      writePrivateJsonIdempotent(containedPath(target, "restore.json"), {
        schema: "flow.filesystem-restore-marker/v1",
        manifest_digest: validated.manifest_digest,
        snapshot_digest: record.snapshot.snapshot_digest,
        restored_file_count: restoredFiles,
      });
      return freezeCanonical({
        provider: PROVIDER_SCHEMA,
        manifest_digest: validated.manifest_digest,
        operation_id: intent?.operation_id,
        idempotency_key: intent?.idempotency_key,
        restore_id: `restore:${validated.manifest_digest}`,
        restored_file_count: restoredFiles,
      });
    },

    observeRestore({ manifest } = {}) {
      const validated = validateBackupManifest(manifest);
      const target = containedPath(providerRoot, backupIdFor(
        validated.manifest_digest,
      ));
      if (!existsSync(providerRoot)) {
        throw providerError(
          "restore_source_unavailable",
          "restore provider directory is unavailable",
        );
      }
      ensurePrivateDirectory(providerRoot);
      const record = readBackupRecord(target, validated, {
        allowMissing: false,
      });
      return observeRestoredState({
        authorityRoot,
        repository,
        legacyRoots: retainedLegacyRoots,
        manifest: validated,
        snapshot: record.snapshot,
        directory: record.directory,
        drovrEnvironment,
        drovrStatusRunner,
      });
    },
  });
}

function observeState({
  authorityRoot,
  repository,
  legacyRoots,
  drovrEnvironment,
  drovrStatusRunner,
}) {
  const databasePath = containedPath(authorityRoot, DATABASE_FILE);
  const databaseStreams = readDatabaseStreams(databasePath);
  const artifacts = readArtifacts(databasePath, authorityRoot);
  const filesystemState = collectFiles(authorityRoot, {
    ignoredNames: AUTHORITY_IGNORED_FILES,
  });
  const gitState = observeGit(repository);
  const externalPointers = readExternalPointers(databasePath);
  const legacy = collectLegacyFiles(legacyRoots);
  const drovrObligations = observeDrovrObligations({
    environment: drovrEnvironment,
    runner: drovrStatusRunner,
  });
  return {
    replacement_authority: {
      database_streams: databaseStreams,
      git_state: gitState,
      filesystem_state: filesystemState,
    },
    artifacts,
    legacy_roots: legacy,
    external_pointers: externalPointers,
    drovr_obligations: drovrObligations,
  };
}

function observeRestoredState({
  authorityRoot,
  repository,
  legacyRoots,
  manifest,
  snapshot,
  directory,
  drovrEnvironment,
  drovrStatusRunner,
}) {
  const databasePath = containedPath(authorityRoot, DATABASE_FILE);
  const databaseStreams = observeRestoredDatabaseStreams(
    databasePath,
    snapshot.database_snapshot === null
      ? null
      : snapshot.database_snapshot,
    manifest.replacement_authority.database_streams,
  );
  const artifacts = readArtifacts(databasePath, authorityRoot);
  const filesystemState = collectFiles(authorityRoot, {
    ignoredNames: AUTHORITY_IGNORED_FILES,
  });
  const gitState = observeGit(repository);
  const externalPointers = readExternalPointers(databasePath);
  const legacy = collectLegacyFiles(legacyRoots);
  const drovrObligations = observeDrovrObligations({
    environment: drovrEnvironment,
    runner: drovrStatusRunner,
  });
  const observation = {
    replacement_authority: {
      database_streams: databaseStreams,
      git_state: gitState,
      filesystem_state: filesystemState,
    },
    artifacts,
    legacy_roots: legacy,
    external_pointers: externalPointers,
    drovr_obligations: drovrObligations,
  };
  // Keep all six domains explicit in the adapter contract. The generic
  // reconciliation layer derives these domains from the five components.
  if (RESTORE_EVIDENCE_DOMAINS.length !== 6) {
    throw providerError(
      "restore_observation_unavailable",
      "restore evidence domain catalog is incomplete",
    );
  }
  return observation;
}

function explicitDrovrEnvironment(env) {
  const stateHome = env?.XDG_STATE_HOME;
  if (typeof stateHome !== "string" || !isAbsolute(stateHome)) return null;
  return Object.freeze({
    ...env,
    XDG_STATE_HOME: resolve(stateHome),
  });
}

function observeDrovrObligations({ environment, runner }) {
  const status = readDrovrStatus({ environment, runner });
  const result = status.result;
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      !isRecord(result.authority_watermark) ||
      !Array.isArray(result.agents) ||
      !Array.isArray(result.turns ?? result.active_turns)) {
    throw providerError(
      "backup_drovr_observation_unavailable",
      "Drovr status did not return an authoritative registry projection",
    );
  }
  const agents = new Map();
  for (const agent of result.agents) {
    if (typeof agent?.id !== "string" || agent.id.length === 0 ||
        agents.has(agent.id)) {
      throw providerError(
        "backup_drovr_observation_unavailable",
        "Drovr status returned invalid or duplicate agent identity",
      );
    }
    agents.set(agent.id, agent);
  }

  const turns = new Map();
  const addTurn = (turn, source) => {
    if (typeof turn?.id !== "string" || turn.id.length === 0 ||
        typeof turn.agent_id !== "string" || turn.agent_id.length === 0 ||
        typeof turn.status !== "string" || turn.status.length === 0) {
      throw providerError(
        "backup_drovr_observation_unavailable",
        `Drovr status returned an invalid ${source} identity`,
      );
    }
    const existing = turns.get(turn.id);
    if (existing !== undefined &&
        (existing.agent_id !== turn.agent_id ||
         existing.status !== turn.status)) {
      // Preserve the obligation, but never select one side of contradictory
      // public evidence as proof of retirement.
      turns.set(turn.id, {
        ...existing,
        agent_id: null,
        status: "indeterminate",
        contradictory: true,
      });
      return;
    }
    turns.set(turn.id, { ...turn });
  };
  for (const turn of result.turns ?? result.active_turns) {
    addTurn(turn, "turn");
  }
  for (const turn of result.active_turns ?? []) {
    if (!turns.has(turn.id)) addTurn(turn, "active turn");
  }
  // `drovr status` intentionally projects only active turns. Retired agent
  // cleanup receipts are the public source for interrupted turns that still
  // need a retirement obligation, so bind those IDs back to their owner.
  for (const agent of agents.values()) {
    for (const interrupted of agent.cleanup_receipt?.interrupted_turns ?? []) {
      if (typeof interrupted?.id !== "string" ||
          typeof interrupted.status !== "string") continue;
      if (!turns.has(interrupted.id)) {
        turns.set(interrupted.id, {
          id: interrupted.id,
          agent_id: agent.id,
          status: interrupted.status,
        });
      }
    }
  }

  return [...turns.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((turn) => {
      const obligation = {
        turn_id: turn.id,
        disposition: "retire",
      };
      const agent = turn.agent_id === null
        ? null
        : agents.get(turn.agent_id);
      const receipt = drovrSettlementReceipt({
        turn,
        agent,
        authorityWatermark: result.authority_watermark,
      });
      const settled = receipt?.disposition === "handoff"
        ? {
            turn_id: turn.id,
            disposition: "handoff",
            durable_holder: receipt.durable_holder,
          }
        : obligation;
      return receipt === null ? settled : { ...settled, receipt };
    });
}

function readDrovrStatus({ environment, runner }) {
  if (typeof runner !== "function" && environment === null) {
    throw providerError(
      "backup_drovr_observation_unavailable",
      "Drovr status requires an explicit isolated environment",
    );
  }
  let output;
  try {
    output = typeof runner === "function"
      ? runner({ command: "status", args: ["status"], env: environment })
      : execFileSync(process.execPath, [DROVR_CLI_PATH, "status"], {
          encoding: "utf8",
          env: {
            ...environment,
            PATH: environment.PATH ?? process.env.PATH ?? "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
  } catch (error) {
    throw providerError(
      "backup_drovr_observation_unavailable",
      error?.message ?? "Drovr status command failed",
    );
  }
  let envelope;
  try {
    envelope = typeof output === "string" ? JSON.parse(output) : output;
  } catch (error) {
    throw providerError(
      "backup_drovr_observation_unavailable",
      `Drovr status returned invalid JSON: ${error.message}`,
    );
  }
  if (envelope?.schema !== DROVR_STATUS_SCHEMA ||
      envelope.command !== "status" || envelope.ok !== true) {
    throw providerError(
      "backup_drovr_observation_unavailable",
      "Drovr status command did not return a successful public result",
    );
  }
  return envelope;
}

function drovrSettlementReceipt({ turn, agent, authorityWatermark }) {
  const direct = turn.receipt ?? turn.settlement_receipt;
  if (validDrovrSettlementReceipt(direct, turn.id)) return freezeCanonical(direct);
  if (!TERMINAL_DROVR_TURN_STATUSES.has(turn.status) ||
      agent?.lifecycle_status !== "retired" ||
      !validAgentCleanupReceipt(agent.cleanup_receipt, agent.id)) {
    return null;
  }
  const interrupted = agent.cleanup_receipt.interrupted_turns.find((entry) =>
    entry.id === turn.id && entry.status === turn.status);
  if (!interrupted) return null;
  const evidence = {
    schema: "flow.drovr-retirement-evidence/v1",
    turn_id: turn.id,
    agent_id: agent.id,
    authority_watermark: authorityWatermark,
    cleanup_receipt: agent.cleanup_receipt,
  };
  return freezeCanonical({
    schema: "flow.drovr-retirement-receipt/v1",
    turn_id: turn.id,
    disposition: "retire",
    agent_id: agent.id,
    retirement_receipt_id: `drovr-retirement:${digest(evidence)
      .slice("sha256:".length)}`,
    outcome: "retired",
    drovr_watermark: authorityWatermark,
    mechanism_receipt: agent.cleanup_receipt,
  });
}

function validAgentCleanupReceipt(receipt, agentId) {
  return receipt !== null && typeof receipt === "object" &&
    !Array.isArray(receipt) &&
    receipt.schema === DROVR_RETIREMENT_RECEIPT_SCHEMA &&
    receipt.agent_id === agentId &&
    typeof receipt.recorded_at === "string" && receipt.recorded_at.length > 0 &&
    typeof receipt.proof === "string" && receipt.proof.length > 0 &&
    isRecord(receipt.observation) &&
    isRecord(receipt.pane) &&
    receipt.pane.after?.evidence === "absent" &&
    Array.isArray(receipt.interrupted_turns);
}

function validDrovrSettlementReceipt(receipt, turnId) {
  if (receipt === null || typeof receipt !== "object" ||
      Array.isArray(receipt) || receipt.turn_id !== turnId) return false;
  if (receipt.schema === "flow.drovr-retirement-receipt/v1") {
    return receipt.disposition === "retire" &&
      typeof receipt.retirement_receipt_id === "string" &&
      receipt.retirement_receipt_id.length > 0 &&
      receipt.outcome === "retired";
  }
  return receipt.schema === DROVR_HANDOFF_RECEIPT_SCHEMA &&
    receipt.disposition === "handoff" &&
    typeof receipt.durable_holder === "string" &&
    receipt.durable_holder.length > 0 &&
    typeof receipt.handoff_receipt_id === "string" &&
    receipt.handoff_receipt_id.length > 0 &&
    receipt.outcome === "handed_off";
}

function assertSettledDrovrObligations(obligations) {
  for (const obligation of obligations) {
    if (!validDrovrSettlementReceipt(obligation.receipt, obligation.turn_id) ||
        obligation.disposition !== obligation.receipt.disposition) {
      throw providerError(
        "backup_drovr_obligation_unsettled",
        `Drovr obligation is not bound to exact retirement or handoff evidence: ${obligation.turn_id}`,
      );
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createSnapshot({ authorityRoot, legacyRoots, manifest, destination }) {
  const files = [
    ...manifest.replacement_authority.filesystem_state,
    ...manifest.legacy_roots,
  ].map((entry) => ({
    path: entry.path,
    digest: entry.digest,
  }));
  const seen = new Set();
  const uniqueFiles = [];
  for (const entry of files) {
    if (!isAbsolute(entry.path)) {
      throw providerError(
        "backup_manifest_relative_path",
        "backup manifest paths must be absolute",
      );
    }
    if (seen.has(entry.path)) {
      throw providerError(
        "backup_manifest_path_conflict",
        `backup manifest repeats path: ${entry.path}`,
      );
    }
    seen.add(entry.path);
    const root = rootForPath(entry.path, authorityRoot, legacyRoots);
    if (root === null) {
      throw providerError(
        "backup_path_outside_bound_root",
        "backup manifest path is outside the bound source roots",
      );
    }
    const bytes = readContainedFile(root, entry.path);
    if (byteDigest(bytes) !== entry.digest) {
      throw providerError(
        "backup_source_changed",
        `backup source changed while it was being copied: ${entry.path}`,
      );
    }
    const fileName = digest(entry.path).slice("sha256:".length);
    const relativePath = join("files", fileName);
    const output = containedPath(destination, relativePath);
    ensurePrivateDirectory(destination);
    writePrivateBytes(output, bytes);
    uniqueFiles.push({
      path: entry.path,
      digest: entry.digest,
      relative_path: relativePath,
    });
  }

  const databasePath = containedPath(authorityRoot, DATABASE_FILE);
  let databaseSnapshot = null;
  if (manifest.replacement_authority.database_streams.length > 0) {
    databaseSnapshot = readLogicalDatabaseSnapshot(
      databasePath,
      manifest.replacement_authority.database_streams,
    );
  }
  const body = {
    schema: SNAPSHOT_SCHEMA,
    version: 1,
    files: uniqueFiles.sort((left, right) =>
      left.path.localeCompare(right.path)),
    database_snapshot: databaseSnapshot,
  };
  return freezeCanonical({
    ...body,
    snapshot_digest: digest(body),
  });
}

function readLogicalDatabaseSnapshot(databasePath, expectedStreams) {
  const database = openDatabase(databasePath);
  let transaction = false;
  try {
    database.exec("BEGIN");
    transaction = true;
    const metadata = readDatabaseMetadata(database);
    const currentStreams = database.prepare(`
      SELECT stream_id, stream_kind, generation, head_sequence, head_digest,
             fold_contract, fold_json, fold_digest
        FROM authority_streams ORDER BY stream_id ASC
    `).all().map(normalizeDatabaseStreamRow);
    const expected = expectedStreams
      .map(({ id, suffix }) => ({ stream_id: id, head_digest: suffix }))
      .sort((left, right) => left.stream_id.localeCompare(right.stream_id));
    if (currentStreams.length !== expected.length ||
        currentStreams.some(({ stream_id }) =>
          !expected.some(({ stream_id: id }) => id === stream_id))) {
      throw providerError(
        "backup_source_changed",
        "authority stream set changed before the logical backup snapshot",
      );
    }
    const currentEvents = database.prepare(`
      SELECT stream_id, sequence, generation, contract, payload_json,
             payload_digest, previous_digest, record_digest, authority_epoch,
             boot_id, process_identity
        FROM authority_events ORDER BY stream_id ASC, sequence ASC
    `).all().map(normalizeDatabaseEventRow);
    const prefixes = [];
    for (const expectedStream of expected) {
      const current = currentStreams.find(({ stream_id }) =>
        stream_id === expectedStream.stream_id);
      const events = currentEvents.filter(({ stream_id }) =>
        stream_id === expectedStream.stream_id);
      const end = expectedStream.head_digest === EMPTY_STREAM_DIGEST &&
        events.length === 0
        ? -1
        : events.findIndex(({ record_digest }) =>
          record_digest === expectedStream.head_digest);
      if (current === undefined || end < 0 ||
          end + 1 > current.head_sequence ||
          current.head_sequence !== events.length) {
        throw providerError(
          "backup_source_changed",
          `authority stream does not contain the manifest prefix: ${expectedStream.stream_id}`,
        );
      }
      prefixes.push({
        stream: {
          ...current,
          head_sequence: end + 1,
          head_digest: expectedStream.head_digest,
        },
        events: events.slice(0, end + 1),
      });
    }
    const { streams, events } = logicalSnapshotRows(metadata, prefixes);
    const body = {
      schema: DATABASE_SNAPSHOT_SCHEMA,
      version: 1,
      metadata,
      streams,
      events,
    };
    const snapshot = freezeCanonical({
      ...body,
      identity: digest(body),
    });
    database.exec("COMMIT");
    transaction = false;
    return snapshot;
  } catch (error) {
    if (transaction && database.isTransaction) database.exec("ROLLBACK");
    if (error?.code?.startsWith("backup_")) throw error;
    throw providerError(
      "backup_database_observation_unavailable",
      error?.message ?? "authority database snapshot failed",
    );
  } finally {
    database.close();
  }
}

function readDatabaseMetadata(database) {
  const metadata = database.prepare(`
    SELECT singleton, contract, schema_version, transition_release_json,
           transition_sequence
      FROM authority_metadata WHERE singleton = 1
  `).get();
  if (metadata === undefined) {
    throw providerError(
      "backup_database_observation_unavailable",
      "authority database metadata is unavailable",
    );
  }
  return normalizeDatabaseMetadata(metadata);
}

function logicalSnapshotRows(metadata, prefixes) {
  const replay = createSqliteDatabase(":memory:");
  try {
    replay.exec(`
      CREATE TABLE authority_metadata (
        singleton INTEGER PRIMARY KEY,
        contract TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        transition_release_json TEXT NOT NULL,
        transition_sequence INTEGER NOT NULL
      );
      CREATE TABLE authority_streams (
        stream_id TEXT PRIMARY KEY,
        stream_kind TEXT NOT NULL,
        generation INTEGER NOT NULL,
        head_sequence INTEGER NOT NULL,
        head_digest TEXT NOT NULL,
        fold_contract TEXT,
        fold_json TEXT,
        fold_digest TEXT
      );
      CREATE TABLE authority_events (
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        contract TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        previous_digest TEXT NOT NULL,
        record_digest TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL,
        boot_id TEXT NOT NULL,
        process_identity TEXT NOT NULL,
        PRIMARY KEY (stream_id, sequence)
      );
    `);
    replay.prepare(`
      INSERT INTO authority_metadata(
        singleton, contract, schema_version, transition_release_json,
        transition_sequence
      ) VALUES (1, ?, ?, ?, ?)
    `).run(
      metadata.contract,
      metadata.schema_version,
      metadata.transition_release_json,
      metadata.transition_sequence,
    );
    const streams = [];
    const events = [];
    for (const { stream, events: prefixEvents } of prefixes) {
      replay.prepare(`
        INSERT INTO authority_streams(
          stream_id, stream_kind, generation, head_sequence, head_digest,
          fold_contract, fold_json, fold_digest
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        stream.stream_id,
        stream.stream_kind,
        stream.generation,
        stream.head_sequence,
        stream.head_digest,
      );
      for (const event of prefixEvents) {
        replay.prepare(`
          INSERT INTO authority_events(
            stream_id, sequence, generation, contract, payload_json,
            payload_digest, previous_digest, record_digest, authority_epoch,
            boot_id, process_identity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          event.stream_id,
          event.sequence,
          event.generation,
          event.contract,
          event.payload_json,
          event.payload_digest,
          event.previous_digest,
          event.record_digest,
          event.authority_epoch,
          event.boot_id,
          event.process_identity,
        );
      }
      const replayed = replayAuthorityStream(replay, stream.stream_id, {
        verifyFold: false,
      });
      const fold = replayed.fold;
      streams.push({
        ...stream,
        fold_contract: fold.schema,
        fold_json: JSON.stringify(canonicalize(fold)),
        fold_digest: digest(fold),
      });
      events.push(...prefixEvents);
    }
    return { streams, events };
  } catch (error) {
    if (error?.code?.startsWith("backup_")) throw error;
    throw providerError(
      "backup_database_observation_unavailable",
      error?.message ?? "logical authority stream replay failed",
    );
  } finally {
    replay.close();
  }
}

function normalizeDatabaseMetadata(metadata) {
  if (Number(metadata.singleton) !== 1 ||
      typeof metadata.contract !== "string" ||
      !Number.isSafeInteger(Number(metadata.schema_version)) ||
      typeof metadata.transition_release_json !== "string" ||
      !Number.isSafeInteger(Number(metadata.transition_sequence))) {
    throw providerError(
      "backup_database_observation_unavailable",
      "authority database metadata is invalid",
    );
  }
  return {
    singleton: 1,
    contract: metadata.contract,
    schema_version: Number(metadata.schema_version),
    transition_release_json: metadata.transition_release_json,
    transition_sequence: Number(metadata.transition_sequence),
  };
}

function normalizeDatabaseStreamRow(row) {
  const normalized = {
    stream_id: row.stream_id,
    stream_kind: row.stream_kind,
    generation: Number(row.generation),
    head_sequence: Number(row.head_sequence),
    head_digest: row.head_digest,
    fold_contract: row.fold_contract,
    fold_json: row.fold_json,
    fold_digest: row.fold_digest,
  };
  if (typeof normalized.stream_id !== "string" ||
      typeof normalized.stream_kind !== "string" ||
      !Number.isSafeInteger(normalized.generation) ||
      !Number.isSafeInteger(normalized.head_sequence) ||
      typeof normalized.head_digest !== "string" ||
      normalized.fold_contract !== null &&
        typeof normalized.fold_contract !== "string" ||
      normalized.fold_json !== null && typeof normalized.fold_json !== "string" ||
      normalized.fold_digest !== null &&
        typeof normalized.fold_digest !== "string") {
    throw providerError(
      "backup_database_observation_unavailable",
      "authority stream metadata is invalid",
    );
  }
  return normalized;
}

function normalizeDatabaseEventRow(row) {
  const normalized = {
    stream_id: row.stream_id,
    sequence: Number(row.sequence),
    generation: Number(row.generation),
    contract: row.contract,
    payload_json: row.payload_json,
    payload_digest: row.payload_digest,
    previous_digest: row.previous_digest,
    record_digest: row.record_digest,
    authority_epoch: Number(row.authority_epoch),
    boot_id: row.boot_id,
    process_identity: row.process_identity,
  };
  if (typeof normalized.stream_id !== "string" ||
      !Number.isSafeInteger(normalized.sequence) ||
      !Number.isSafeInteger(normalized.generation) ||
      typeof normalized.contract !== "string" ||
      typeof normalized.payload_json !== "string" ||
      typeof normalized.payload_digest !== "string" ||
      typeof normalized.previous_digest !== "string" ||
      typeof normalized.record_digest !== "string" ||
      !Number.isSafeInteger(normalized.authority_epoch) ||
      typeof normalized.boot_id !== "string" ||
      typeof normalized.process_identity !== "string") {
    throw providerError(
      "backup_database_observation_unavailable",
      "authority event metadata is invalid",
    );
  }
  return normalized;
}

function readBackupRecord(directory, manifest, { allowMissing }) {
  if (!existsSync(directory)) {
    if (allowMissing) return null;
    throw providerError(
      "restore_source_unavailable",
      "the requested backup record is unavailable",
    );
  }
  ensurePrivateDirectory(directory);
  const storedManifest = readPrivateJson(containedPath(directory, MANIFEST_FILE));
  const storedSnapshot = readPrivateJson(containedPath(directory, SNAPSHOT_FILE));
  if (storedManifest?.manifest_digest !== manifest.manifest_digest ||
      JSON.stringify(canonicalize(storedManifest)) !==
        JSON.stringify(canonicalize(manifest))) {
    throw providerError(
      "backup_record_conflict",
      "backup record manifest does not match the requested identity",
    );
  }
  validateSnapshot(storedSnapshot, directory, manifest);
  return {
    directory,
    snapshot: storedSnapshot,
    snapshot_digest: storedSnapshot.snapshot_digest,
  };
}

function validateSnapshot(snapshot, directory, manifest) {
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || snapshot.version !== 1 ||
      typeof snapshot.snapshot_digest !== "string" ||
      digest({
        schema: snapshot.schema,
        version: snapshot.version,
        files: snapshot.files,
        database_snapshot: snapshot.database_snapshot,
      }) !== snapshot.snapshot_digest || !Array.isArray(snapshot.files) ||
      snapshot.files.some((entry) =>
      typeof entry?.path !== "string" ||
        !isAbsolute(entry.path) ||
        typeof entry?.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest) ||
        typeof entry.relative_path !== "string")) {
    throw providerError(
      "backup_record_corrupt",
      "backup snapshot metadata is invalid",
    );
  }
  const expected = new Map([
    ...manifest.replacement_authority.filesystem_state,
    ...manifest.legacy_roots,
  ].map((entry) => [entry.path, entry.digest]));
  if (expected.size !== snapshot.files.length ||
      snapshot.files.some((entry) => expected.get(entry.path) !== entry.digest)) {
    throw providerError(
      "backup_record_corrupt",
      "backup snapshot does not cover the manifest filesystem components",
    );
  }
  for (const entry of snapshot.files) {
    const source = containedPath(directory, entry.relative_path);
    const bytes = readPrivateBytes(source);
    if (byteDigest(bytes) !== entry.digest) {
      throw providerError(
        "backup_record_corrupt",
        "backup snapshot bytes do not match the manifest digest",
      );
    }
  }
  if (snapshot.database_snapshot !== null) {
    validateLogicalDatabaseSnapshot(snapshot.database_snapshot);
  }
}

function validateLogicalDatabaseSnapshot(snapshot) {
  if (snapshot?.schema !== DATABASE_SNAPSHOT_SCHEMA || snapshot.version !== 1 ||
      !isRecord(snapshot.metadata) || !Array.isArray(snapshot.streams) ||
      !Array.isArray(snapshot.events) ||
      typeof snapshot.identity !== "string" ||
      digest({
        schema: snapshot.schema,
        version: snapshot.version,
        metadata: snapshot.metadata,
        streams: snapshot.streams,
        events: snapshot.events,
      }) !== snapshot.identity) {
    throw providerError(
      "backup_record_corrupt",
      "logical authority snapshot identity is invalid",
    );
  }
  normalizeDatabaseMetadata(snapshot.metadata);
  const streams = snapshot.streams.map(normalizeDatabaseStreamRow);
  const events = snapshot.events.map(normalizeDatabaseEventRow);
  const streamIds = new Set();
  for (const stream of streams) {
    if (streamIds.has(stream.stream_id)) {
      throw providerError(
        "backup_record_corrupt",
        "logical authority snapshot contains duplicate streams",
      );
    }
    streamIds.add(stream.stream_id);
  }
  const eventKeys = new Set();
  for (const event of events) {
    const key = `${event.stream_id}:${event.sequence}`;
    if (!streamIds.has(event.stream_id) || eventKeys.has(key)) {
      throw providerError(
        "backup_record_corrupt",
        "logical authority snapshot contains invalid events",
      );
    }
    eventKeys.add(key);
  }
  for (const stream of streams) {
    const streamEvents = events
      .filter(({ stream_id }) => stream_id === stream.stream_id)
      .sort((left, right) => left.sequence - right.sequence);
    const expectedHead = streamEvents.at(-1)?.record_digest ??
      EMPTY_STREAM_DIGEST;
    if (streamEvents.length !== stream.head_sequence ||
        expectedHead !== stream.head_digest) {
      throw providerError(
        "backup_record_corrupt",
        "logical authority snapshot stream identity is inconsistent",
      );
    }
  }
  return snapshot;
}

function preflightRestore({ authorityRoot, legacyRoots, record }) {
  const files = record.snapshot.files.map((entry) => {
    if (!isAbsolute(entry.path)) {
      throw providerError(
        "restore_manifest_relative_path",
        "restore manifest paths must be absolute",
      );
    }
    const destination = permittedRestorePath(
      entry.path,
      authorityRoot,
      legacyRoots,
    );
    validateRestoreTarget(destination, rootForPath(
      entry.path,
      authorityRoot,
      legacyRoots,
    ));
    const source = containedPath(record.directory, entry.relative_path);
    const bytes = readPrivateBytes(source);
    if (byteDigest(bytes) !== entry.digest) {
      throw providerError(
        "restore_source_corrupt",
        "restore source bytes do not match the retained manifest",
      );
    }
    return { source, bytes, destination };
  });
  if (record.snapshot.database_snapshot !== null) {
    preflightDatabaseRestore(
      containedPath(authorityRoot, DATABASE_FILE),
      record.snapshot.database_snapshot,
    );
  }
  return { files };
}

function validateRestoreTarget(destination, root) {
  assertNoSymlinkAncestors(destination);
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw providerError(
      "restore_target_symlink",
      "restore refuses to follow a target symlink",
    );
  }
  if (existsSync(destination) && !lstatSync(destination).isFile()) {
    throw providerError(
      "restore_target_unsupported",
      "restore target must be a regular file",
    );
  }
  const boundRoot = root ?? resolve(destination, "..");
  let current = resolve(destination, "..");
  while (isContained(boundRoot, current)) {
    if (existsSync(current)) {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() ||
          (metadata.mode & 0o077) !== 0) {
        throw providerError(
          "restore_target_not_private",
          "restore target ancestors must be owner-private directories",
        );
      }
    }
    if (current === boundRoot) break;
    current = resolve(current, "..");
  }
}

function restoreSnapshotFile(source, bytes, destination) {
  assertNoSymlinkAncestors(destination);
  const parent = resolve(destination, "..");
  ensurePrivateDirectory(parent);
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw providerError(
      "restore_target_symlink",
      "restore refuses to follow a target symlink",
    );
  }
  const temporary = `${destination}.${process.pid}.restore.tmp`;
  removeProviderTemporary(temporary);
  writePrivateBytes(temporary, bytes);
  renameSync(temporary, destination);
}

function permittedRestorePath(path, authorityRoot, legacyRoots) {
  if (!isAbsolute(path)) {
    throw providerError(
      "restore_manifest_relative_path",
      "restore manifest paths must be absolute",
    );
  }
  const root = rootForPath(path, authorityRoot, legacyRoots);
  if (root === null) {
    throw providerError(
      "restore_path_outside_bound_root",
      "restore refuses a path outside the bound isolated roots",
    );
  }
  return containedPath(root, relative(root, resolve(path)));
}

function rootForPath(path, authorityRoot, legacyRoots) {
  if (!isAbsolute(path)) return null;
  const resolved = resolve(path);
  if (isContained(authorityRoot, resolved)) return authorityRoot;
  return legacyRoots.find((root) => isContained(root, resolved)) ?? null;
}

function collectLegacyFiles(legacyRoots) {
  return legacyRoots.flatMap((root) => collectFiles(root));
}

function collectFiles(root, { ignoredNames = new Set() } = {}) {
  if (!existsSync(root)) return [];
  assertPrivateSourceDirectory(root);
  const result = [];
  visitDirectory(root, root, ignoredNames, result);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function visitDirectory(root, current, ignoredNames, result) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const path = containedPath(root, relative(root, join(current, entry.name)));
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw providerError(
        "backup_source_symlink",
        "backup refuses to traverse a source symlink",
      );
    }
    if (metadata.isDirectory()) {
      visitDirectory(root, path, ignoredNames, result);
      continue;
    }
    if (!metadata.isFile()) {
      throw providerError(
        "backup_source_unsupported",
        "backup encountered a non-regular source entry",
      );
    }
    result.push({ path, digest: byteDigest(readFileSync(path)) });
  }
}

function readArtifacts(databasePath, authorityRoot) {
  const database = openDatabase(databasePath);
  try {
    const rows = database.prepare(`
      SELECT stream_id FROM authority_streams
       WHERE stream_kind = 'artifact'
       ORDER BY stream_id ASC
    `).all();
    const artifacts = [];
    for (const row of rows) {
      const stream = readAuthorityStream(database, row.stream_id);
      const artifact = stream?.fold;
      if (typeof artifact?.digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) {
        throw providerError(
          "backup_artifact_observation_unavailable",
          "artifact authority returned an invalid identity",
        );
      }
      const path = containedPath(
        authorityRoot,
        join("artifacts", artifact.digest.slice("sha256:".length)),
      );
      if (!existsSync(path)) {
        throw providerError(
          "backup_artifact_bytes_unavailable",
          "retained artifact bytes are unavailable",
        );
      }
      const bytes = readContainedFile(authorityRoot, relative(authorityRoot, path));
      if (bytes.length !== artifact.size || byteDigest(bytes) !== artifact.digest) {
        throw providerError(
          "backup_artifact_bytes_unavailable",
          "retained artifact bytes do not match authority identity",
        );
      }
      artifacts.push({
        digest: artifact.digest,
        bytes_digest: artifact.digest,
        byte_availability: "available",
      });
    }
    return artifacts;
  } finally {
    database.close();
  }
}

function readExternalPointers(databasePath) {
  const database = openDatabase(databasePath);
  try {
    const rows = database.prepare(`
      SELECT stream_id FROM authority_streams
       WHERE stream_kind = 'run'
       ORDER BY stream_id ASC
    `).all();
    const pointers = [];
    for (const row of rows) {
      const stream = readAuthorityStream(database, row.stream_id);
      for (const effect of stream?.fold?.effects ?? []) {
        const receipt = externalReceipt(effect);
        if (receipt === null) {
          throw providerError(
            "backup_external_effect_unsettled",
            "backup requires exact receipts for retained external effects",
          );
        }
        pointers.push({
          effect_id: effect.effect_id,
          provider: effect.operation_contract,
          pointer: effect.effect_id,
          idempotency_key: effect.idempotency_key,
          receipt,
        });
      }
    }
    return pointers;
  } finally {
    database.close();
  }
}

function externalReceipt(effect) {
  const receipt = effect?.receipt;
  const providerReceiptId = receipt?.provider_receipt?.provider_receipt_id;
  if (!SETTLED_EXTERNAL_EFFECT_OUTCOMES.has(receipt?.outcome) ||
      typeof providerReceiptId !== "string" || providerReceiptId.length === 0) {
    return null;
  }
  return {
    schema: "flow.external-effect-receipt/v1",
    effect_id: effect.effect_id,
    idempotency_key: effect.idempotency_key,
    provider_receipt_id: providerReceiptId,
    outcome: receipt.outcome,
  };
}

function readDatabaseStreams(databasePath) {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(`
      SELECT stream_id AS id, head_digest AS suffix
        FROM authority_streams ORDER BY stream_id ASC
    `).all().map(({ id, suffix }) => {
      if (typeof id !== "string" || typeof suffix !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(suffix)) {
        throw providerError(
          "backup_database_observation_unavailable",
          "authority stream identity is invalid",
        );
      }
      return { id, suffix };
    });
  } finally {
    database.close();
  }
}

function observeRestoredDatabaseStreams(
  targetPath,
  databaseSnapshot,
  expected,
) {
  if (!existsSync(targetPath) || databaseSnapshot === null) {
    return readDatabaseStreamsIfPresent(targetPath);
  }
  const target = openDatabase(targetPath);
  try {
    const targetRows = readDatabaseStreamsFrom(target);
    const expectedIds = new Set(expected.map(({ id }) => id));
    const targetIds = new Set(targetRows.map(({ id }) => id));
    if (expectedIds.size !== targetIds.size ||
        [...expectedIds].some((id) => !targetIds.has(id))) return targetRows;
    for (const stream of expected) {
      if (stream.id === "host:admission") continue;
      const source = databaseSnapshot.events
        .filter(({ stream_id }) => stream_id === stream.id)
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ record_digest }) => record_digest);
      const current = readEventDigests(target, stream.id);
      if (!hasExpectedPrefix(source, current, stream.suffix)) {
        return targetRows;
      }
    }
    return expected;
  } finally {
    target.close();
  }
}

function preflightDatabaseRestore(targetPath, databaseSnapshot) {
  if (!existsSync(targetPath)) {
    throw providerError(
      "restore_database_unavailable",
      "restore authority database is unavailable",
    );
  }
  validateLogicalDatabaseSnapshot(databaseSnapshot);
  const target = openDatabase(targetPath);
  try {
    const targetMetadata = readDatabaseMetadata(target);
    if (targetMetadata.contract !== databaseSnapshot.metadata.contract ||
        targetMetadata.schema_version !== databaseSnapshot.metadata.schema_version) {
      throw providerError(
        "restore_database_conflict",
        "restore authority database schema does not match the retained snapshot",
      );
    }
    const targetStreams = new Map(
      target.prepare(`
        SELECT stream_id FROM authority_streams ORDER BY stream_id ASC
      `).all().map(({ stream_id }) => [stream_id, true]),
    );
    for (const stream of databaseSnapshot.streams) {
      if (stream.stream_id === "host:admission" ||
          !targetStreams.has(stream.stream_id)) continue;
      const source = databaseSnapshot.events
        .filter(({ stream_id }) => stream_id === stream.stream_id)
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ record_digest }) => record_digest);
      const current = readEventDigests(target, stream.stream_id);
      if (!hasExpectedPrefix(source, current, stream.head_digest)) {
        throw providerError(
          "restore_database_stream_conflict",
          `restore refuses a divergent existing stream: ${stream.stream_id}`,
        );
      }
    }
  } finally {
    target.close();
  }
}

function restoreDatabaseStreams(targetPath, databaseSnapshot) {
  if (!existsSync(targetPath)) {
    throw providerError(
      "restore_database_unavailable",
      "restore authority database is unavailable",
    );
  }
  const target = openWritableDatabase(targetPath);
  try {
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const stream of databaseSnapshot.streams) {
        if (stream.stream_id === "host:admission") continue;
        const current = target.prepare(`
          SELECT * FROM authority_streams WHERE stream_id = ?
        `).get(stream.stream_id);
        if (current !== undefined) {
          // The preflight established that the current stream contains the
          // retained prefix. Keep any later events and make retry a no-op.
          continue;
        }
        target.prepare(`
          INSERT INTO authority_streams(
            stream_id, stream_kind, generation, head_sequence, head_digest,
            fold_contract, fold_json, fold_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          stream.stream_id,
          stream.stream_kind,
          stream.generation,
          stream.head_sequence,
          stream.head_digest,
          stream.fold_contract,
          stream.fold_json,
          stream.fold_digest,
        );
        const events = databaseSnapshot.events
          .filter(({ stream_id }) => stream_id === stream.stream_id)
          .sort((left, right) => left.sequence - right.sequence);
        for (const event of events) {
          target.prepare(`
            INSERT INTO authority_events(
              stream_id, sequence, generation, contract, payload_json,
              payload_digest, previous_digest, record_digest, authority_epoch,
              boot_id, process_identity
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            event.stream_id,
            event.sequence,
            event.generation,
            event.contract,
            event.payload_json,
            event.payload_digest,
            event.previous_digest,
            event.record_digest,
            event.authority_epoch,
            event.boot_id,
            event.process_identity,
          );
        }
      }
      target.exec("COMMIT");
    } catch (error) {
      if (target.isTransaction) target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
  }
}

function hasExpectedPrefix(source, target, expectedSuffix) {
  const sourceIndex = source.findIndex((recordDigest) =>
    recordDigest === expectedSuffix);
  if (sourceIndex < 0 || target.length <= sourceIndex) return false;
  return source.slice(0, sourceIndex + 1).every((recordDigest, index) =>
    recordDigest === target[index]);
}

function readDatabaseStreamsIfPresent(path) {
  return existsSync(path) ? readDatabaseStreams(path) : [];
}

function readDatabaseStreamsFrom(database) {
  return database.prepare(`
    SELECT stream_id AS id, head_digest AS suffix
      FROM authority_streams ORDER BY stream_id ASC
  `).all();
}

function readEventDigests(database, streamId) {
  return database.prepare(`
    SELECT record_digest FROM authority_events
     WHERE stream_id = ? ORDER BY sequence ASC
  `).all(streamId).map(({ record_digest }) => record_digest);
}

function observeGit(repository) {
  let commit;
  let tree;
  let clean;
  try {
    commit = git(repository, ["rev-parse", "HEAD"]);
    tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
    clean = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
  } catch (error) {
    throw providerFailure(error, "backup_git_observation_unavailable");
  }
  return {
    commit: digest({ git_object: commit }),
    tree: digest({ git_tree: tree }),
    clean,
  };
}

function git(repository, args) {
  const { execFileSync } = require("node:child_process");
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function openDatabase(path) {
  if (!existsSync(path)) {
    throw providerError(
      "backup_database_observation_unavailable",
      "authority database is unavailable",
    );
  }
  try {
    const database = createSqliteDatabase(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 0");
    return database;
  } catch (error) {
    throw providerFailure(error, "backup_database_observation_unavailable");
  }
}

function openWritableDatabase(path) {
  if (!existsSync(path)) {
    throw providerError(
      "restore_database_unavailable",
      "authority database is unavailable",
    );
  }
  try {
    const database = createSqliteDatabase(path);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;");
    return database;
  } catch (error) {
    throw providerFailure(error, "restore_database_unavailable");
  }
}

function normalizeLegacyRoots(legacyRoots) {
  if (legacyRoots === null || typeof legacyRoots !== "object" ||
      Array.isArray(legacyRoots)) return [];
  return [...new Set(Object.values(legacyRoots)
    .filter((root) => typeof root === "string" && root.length > 0)
    .map((root) => absolutePath(root, "legacy root")))].sort();
}

function absolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw providerError(
      "backup_provider_configuration_invalid",
      `${label} must be an absolute path`,
    );
  }
  return resolve(value);
}

function assertManifestBytes(manifest, bytes) {
  const expected = Buffer.from(JSON.stringify(manifest), "utf8");
  if (!Buffer.isBuffer(bytes) || !bytes.equals(expected)) {
    throw providerError(
      "backup_manifest_bytes_invalid",
      "backup manifest bytes are not the canonical manifest",
    );
  }
}

function assertPrivateSourceDirectory(path) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw providerError(
      "backup_source_directory_invalid",
      "backup source root is not a real directory",
    );
  }
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0) {
    throw providerError(
      "backup_store_not_private",
      "backup provider state must be an owner-private directory",
    );
  }
  return path;
}

function writePrivateJson(path, value) {
  writePrivateBytes(path, Buffer.from(JSON.stringify(canonicalize(value)), "utf8"));
}

function writePrivateJsonIdempotent(path, value) {
  const bytes = Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
  const parent = resolve(path, "..");
  ensurePrivateDirectory(parent);
  if (existsSync(path)) {
    assertPrivateMarker(path);
    if (!readFileSync(path).equals(bytes)) {
      throw providerError(
        "restore_marker_conflict",
        "restore marker is bound to a different manifest or snapshot",
      );
    }
    return;
  }
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    assertPrivateMarker(path);
    if (!readFileSync(path).equals(bytes)) {
      throw providerError(
        "restore_marker_conflict",
        "restore marker is bound to a different manifest or snapshot",
      );
    }
  }
}

function assertPrivateMarker(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw providerError(
      "restore_marker_unavailable",
      error?.message ?? "restore marker is unavailable",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0) {
    throw providerError(
      "restore_marker_not_private",
      "restore marker must be an owner-private regular file",
    );
  }
}

function readPrivateJson(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw providerError(
        "backup_record_not_private",
        "backup provider record must be an owner-private file",
      );
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code?.startsWith("backup_")) throw error;
    throw providerFailure(error, "backup_record_corrupt");
  }
}

function writePrivateBytes(path, bytes) {
  const parent = resolve(path, "..");
  ensurePrivateDirectory(parent);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function readPrivateBytes(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw providerError(
        "backup_record_not_private",
        "backup provider bytes must be an owner-private file",
      );
    }
    return readFileSync(path);
  } catch (error) {
    if (error?.code?.startsWith("backup_")) throw error;
    throw providerFailure(error, "backup_record_corrupt");
  }
}

function readContainedFile(root, path) {
  const target = containedPath(root, path);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw providerError(
      "backup_source_file_invalid",
      "backup source is not a regular file",
    );
  }
  return readFileSync(target);
}

function containedPath(root, path) {
  const target = resolve(root, path);
  if (!isContained(resolve(root), target)) {
    throw providerError(
      "backup_path_outside_bound_root",
      "backup provider path escaped its bound root",
    );
  }
  return target;
}

function isContained(root, target) {
  const remainder = relative(resolve(root), resolve(target));
  return remainder === "" || remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

function assertNoSymlinkAncestors(path) {
  const absolute = resolve(path);
  const ancestors = [];
  let current = absolute;
  while (current !== resolve(current, "..")) {
    ancestors.push(current);
    current = resolve(current, "..");
  }
  for (const ancestor of ancestors.reverse()) {
    if (!existsSync(ancestor)) continue;
    if (lstatSync(ancestor).isSymbolicLink()) {
      throw providerError(
        "backup_path_symlink",
        "backup provider refuses a symlinked path ancestor",
      );
    }
  }
}

function removeProviderTemporary(path) {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

function backupIdFor(manifestDigest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(manifestDigest)) {
    throw providerError(
      "backup_manifest_identity_invalid",
      "backup manifest digest is invalid",
    );
  }
  return manifestDigest.slice("sha256:".length);
}

function providerReceipt(manifest, snapshotDigest, intent) {
  return freezeCanonical({
    provider: PROVIDER_SCHEMA,
    manifest_digest: manifest.manifest_digest,
    snapshot_digest: snapshotDigest,
    backup_id: `backup:${manifest.manifest_digest}`,
    ...(intent?.operation_id === undefined ? {} : {
      operation_id: intent.operation_id,
    }),
    ...(intent?.idempotency_key === undefined ? {} : {
      idempotency_key: intent.idempotency_key,
    }),
  });
}

function backupReceipt(manifest, snapshotDigest, intent) {
  return freezeCanonical({
    schema: BACKUP_RECEIPT_SCHEMA,
    manifest_digest: manifest.manifest_digest,
    operation_id: intent?.operation_id,
    idempotency_key: intent?.idempotency_key,
    provider_receipt: providerReceipt(manifest, snapshotDigest, intent),
  });
}

function backupAbsence(manifest, intent) {
  return freezeCanonical({
    schema: BACKUP_RECONCILIATION_OBSERVATION_SCHEMA,
    operation: "backup_create",
    operation_id: intent?.operation_id,
    idempotency_key: intent?.idempotency_key,
    manifest_digest: manifest.manifest_digest,
    status: "absent",
    safe_to_retry: true,
    provider_evidence: {
      schema: BACKUP_PROVIDER_EVIDENCE_SCHEMA,
      provider: PROVIDER_SCHEMA,
      proof_id: `absent:${manifest.manifest_digest}`,
      outcome: "absent",
    },
  });
}

function byteDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function providerFailure(error, fallbackCode) {
  if (error?.code?.startsWith("backup_") ||
      error?.code === "restore_source_unavailable" ||
      error?.code === "restore_path_outside_bound_root" ||
      error?.code === "restore_target_symlink" ||
      error?.code === "restore_source_corrupt") return error;
  return providerError(fallbackCode, error?.message ?? fallbackCode);
}

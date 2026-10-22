import { canonicalize, digest, freezeCanonical } from "./canonical.mjs";
import {
  initialBackupProjection,
  initialRestoreBarrier,
  reduceHostRecoveryEvent,
} from "./backup-restore.mjs";
import { foldRun } from "./run-projection.mjs";
import { foldWorkStream } from "./work-authority.mjs";
import {
  legacyReviewProjectionFold,
  REVIEW_LEGACY_PROJECTION_FOLD_CONTRACT,
  REVIEW_PROJECTION_FOLD_CONTRACT,
} from "./review-flow.mjs";

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

export function readAuthorityStream(database, streamId) {
  const stream = database.prepare(`
    SELECT * FROM authority_streams WHERE stream_id = ?
  `).get(streamId);
  if (!stream) return null;
  // Inspectors may open a store before a mutable owner has had a chance to
  // run the narrow review-fold migration.  The compatibility path below is
  // still an exact replay/fold comparison and never writes to the database.
  return replayAuthorityStream(database, streamId, {
    allowLegacyReviewFold: true,
  });
}

export function replayAuthorityStream(
  database,
  streamId,
  { verifyFold = true, allowLegacyReviewFold = false } = {},
) {
  const metadata = database.prepare(`
    SELECT contract FROM authority_metadata WHERE singleton = 1
  `).get();
  if (metadata?.contract !== "flow.sqlite-authority-store/v1") {
    integrityFailure("unknown_contract", "authority store contract is unknown");
  }
  const stream = database.prepare(`
    SELECT * FROM authority_streams WHERE stream_id = ?
  `).get(streamId);
  const rows = database.prepare(`
    SELECT * FROM authority_events WHERE stream_id = ? ORDER BY sequence
  `).all(streamId);
  if (rows.length < Number(stream.head_sequence)) {
    integrityFailure("omission", "authority stream event is missing");
  }
  if (rows.length > Number(stream.head_sequence)) {
    integrityFailure("duplication", "authority stream event is duplicated");
  }
  let previousDigest = EMPTY_WATERMARK;
  const records = rows.map((row, index) => {
    const sequence = index + 1;
    if (Number(row.generation) !== Number(stream.generation)) {
      integrityFailure(
        "stale_generation",
        "authority event cites a stale stream generation",
      );
    }
    if (Number(row.sequence) !== sequence ||
        row.previous_digest !== previousDigest) {
      integrityFailure("reordering", "authority stream order is corrupt");
    }
    if (row.contract !== expectedEventContract(stream.stream_kind)) {
      integrityFailure("unknown_contract", "authority event contract is unknown");
    }
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      integrityFailure("corrupt_json", "authority event JSON is corrupt");
    }
    if (JSON.stringify(canonicalize(payload)) !== row.payload_json ||
        digest(payload) !== row.payload_digest) {
      integrityFailure("digest_conflict", "authority event payload digest conflicts");
    }
    const record = {
      schema: "flow.authority-event-record/v1",
      stream_id: row.stream_id,
      sequence,
      generation: Number(row.generation),
      contract: row.contract,
      payload,
      payload_digest: row.payload_digest,
      previous_digest: row.previous_digest,
      authority_epoch: Number(row.authority_epoch),
      boot_id: row.boot_id,
      process_identity: row.process_identity,
    };
    if (digest(record) !== row.record_digest) {
      integrityFailure("digest_conflict", "authority event record digest conflicts");
    }
    previousDigest = row.record_digest;
    return record;
  });
  if (records.length !== Number(stream.head_sequence) ||
      previousDigest !== stream.head_digest) {
    integrityFailure("digest_conflict", "authority stream head conflicts");
  }

  const fold = reduceAuthorityStream(stream, records);
  if (verifyFold) {
    const foldJson = JSON.stringify(canonicalize(fold));
    const expectedFoldContract = stream.stream_kind === "review"
      && fold.schema === "flow.review-projection/v1"
      ? REVIEW_PROJECTION_FOLD_CONTRACT
      : fold.schema;
    let foldMatches = stream.fold_contract === expectedFoldContract &&
      stream.fold_json === foldJson &&
      stream.fold_digest === digest(fold);
    if (!foldMatches && allowLegacyReviewFold &&
        stream.stream_kind === "review" &&
        stream.fold_contract === REVIEW_LEGACY_PROJECTION_FOLD_CONTRACT) {
      const storedFold = parseStoredFold(stream);
      const legacyFold = legacyReviewProjectionFold(fold, records);
      // Some stores were written by the current reducer before the private
      // v2 marker was introduced. Accept either exact shape read-only; the
      // mutable startup migration will normalize the marker atomically.
      foldMatches = storedFoldMatches(stream, storedFold, fold) ||
        legacyFold !== null && storedFoldMatches(stream, storedFold, legacyFold);
    }
    if (!foldMatches) {
      integrityFailure(
        "fold_mismatch",
        "transactional authority fold does not match replay",
      );
    }
  }
  return {
    authorityEventStreamDigest: stream.stream_kind === "run"
      ? digest({
        schema: "flow.run-authority-stream/v1",
        run_id: stream.stream_id,
        events: runEventsFromRecords(records),
      })
      : null,
    fold: freezeCanonical(fold),
    generation: Number(stream.generation),
    lastBootId: records.at(-1)?.boot_id ?? null,
    records,
  };
}

/**
 * Upgrade only durable review projection folds written before the human
 * review projection existed.  Event rows and stream identity remain
 * append-only; the old fold is accepted only when it exactly matches the
 * deterministic legacy shape reconstructed from those events.
 */
export function migrateReviewProjectionFolds(database) {
  const rows = database.prepare(`
    SELECT stream_id FROM authority_streams WHERE stream_kind = 'review'
    ORDER BY stream_id
  `).all();
  const ownsTransaction = !database.isTransaction;
  if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
  let migrated = 0;
  try {
    for (const { stream_id: streamId } of rows) {
      const replayed = replayAuthorityStream(database, streamId, {
        verifyFold: false,
      });
      if (replayed.fold.schema !== "flow.review-projection/v1") {
        // The migration is scoped to review projections, but every other
        // review stream still gets its ordinary fold-integrity check here so
        // corruption cannot be hidden by the compatibility pass.
        replayAuthorityStream(database, streamId);
        continue;
      }

      const stream = database.prepare(`
        SELECT * FROM authority_streams WHERE stream_id = ?
      `).get(streamId);
      const currentJson = JSON.stringify(canonicalize(replayed.fold));
      const currentDigest = digest(replayed.fold);
      if (stream.fold_contract === REVIEW_PROJECTION_FOLD_CONTRACT) {
        if (stream.fold_json !== currentJson ||
            stream.fold_digest !== currentDigest) {
          integrityFailure(
            "fold_mismatch",
            "transactional authority fold does not match replay",
          );
        }
        continue;
      }
      if (stream.fold_contract !== REVIEW_LEGACY_PROJECTION_FOLD_CONTRACT) {
        integrityFailure(
          "fold_mismatch",
          "review projection fold contract is unknown",
        );
      }
      const storedFold = parseStoredFold(stream);
      // A store may have been written by the current reducer before this
      // private marker was introduced.  Preserve its already-current shape
      // while upgrading only the contract marker.
      if (storedFoldMatches(stream, storedFold, replayed.fold)) {
        database.prepare(`
          UPDATE authority_streams
             SET fold_contract = ?
           WHERE stream_id = ?
        `).run(REVIEW_PROJECTION_FOLD_CONTRACT, streamId);
        migrated += 1;
        continue;
      }
      const legacyFold = legacyReviewProjectionFold(
        replayed.fold,
        replayed.records,
      );
      if (legacyFold === null ||
          !storedFoldMatches(stream, storedFold, legacyFold)) {
        integrityFailure(
          "fold_mismatch",
          "transactional authority fold does not match legacy replay",
        );
      }
      database.prepare(`
        UPDATE authority_streams
           SET fold_contract = ?, fold_json = ?, fold_digest = ?
         WHERE stream_id = ?
      `).run(REVIEW_PROJECTION_FOLD_CONTRACT, currentJson, currentDigest, streamId);
      migrated += 1;
    }
    if (ownsTransaction) database.exec("COMMIT");
    return migrated;
  } catch (error) {
    if (ownsTransaction && database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function parseStoredFold(stream) {
  if (typeof stream.fold_json !== "string") {
    integrityFailure(
      "fold_mismatch",
      "transactional authority fold is missing",
    );
  }
  try {
    const fold = JSON.parse(stream.fold_json);
    if (JSON.stringify(canonicalize(fold)) !== stream.fold_json ||
        digest(fold) !== stream.fold_digest) {
      integrityFailure(
        "fold_mismatch",
        "transactional authority fold digest conflicts",
      );
    }
    return fold;
  } catch (error) {
    if (error?.name === "AuthorityIntegrityError") throw error;
    integrityFailure(
      "fold_mismatch",
      "transactional authority fold is corrupt",
    );
  }
}

function storedFoldMatches(stream, storedFold, expectedFold) {
  const expectedJson = JSON.stringify(canonicalize(expectedFold));
  return stream.fold_json === expectedJson &&
    stream.fold_digest === digest(expectedFold) &&
    JSON.stringify(canonicalize(storedFold)) === expectedJson;
}

function reduceAuthorityStream(stream, records) {
  if (stream.stream_kind === "host_admission") {
    let authorityEpoch = 0;
    let bootId = null;
    let declaredCapacity = null;
    let processIdentity = null;
    const activeRuns = new Set();
    let recovery = null;
    for (const { payload } of records) {
      if (payload.type === "authority_acquired") {
        authorityEpoch = payload.authority_epoch;
        bootId = payload.boot_id;
        declaredCapacity = payload.declared_capacity;
        processIdentity = payload.process_identity;
      } else if (payload.type === "run_capacity_reserved") {
        activeRuns.add(payload.run_id);
      } else if (payload.type === "run_capacity_released") {
        activeRuns.delete(payload.run_id);
      }
      if (isHostRecoveryEvent(payload)) {
        recovery ??= {
          backup: initialBackupProjection(),
          restore: initialRestoreBarrier(),
        };
        try {
          recovery = reduceHostRecoveryEvent(recovery, payload);
        } catch {
          integrityFailure(
            "corrupt_recovery_state",
            "host restore state cannot be replayed",
          );
        }
      }
    }
    return freezeCanonical({
      schema: "flow.host-admission-fold/v1",
      watermark: stream.head_digest,
      authority_epoch: authorityEpoch,
      boot_id: bootId,
      declared_capacity: declaredCapacity,
      process_identity: processIdentity,
      active_runs: [...activeRuns].sort(),
      ...(recovery === null ? {} : {
        backup: recovery.backup,
        restore: recovery.restore,
      }),
    });
  }
  if (stream.stream_kind === "host_runs") {
    return freezeCanonical({
      schema: "flow.run-index-projection/v1",
      watermark: stream.head_digest,
      runs: records.map(({ payload }) => payload.run_id).sort(),
    });
  }
  if (stream.stream_kind === "run") {
    const launch = records[0]?.payload;
    if (launch?.type !== "run_launched" || !launch.prepared) {
      integrityFailure(
        "missing_launch_event",
        "run authority stream is missing its launch event",
      );
    }
    const run = {
      run_id: stream.stream_id,
      prepared: launch.prepared,
      ...(launch.lineage === undefined ? {} : { lineage: launch.lineage }),
      events: runEventsFromRecords(records),
    };
    return foldRun(run, { watermark: stream.head_digest });
  }
  if (["workspace", "artifact", "review", "handoff"].includes(stream.stream_kind)) {
    const subjectId = stream.stream_id.split(":").slice(2).join(":");
    return foldWorkStream(
      stream.stream_kind,
      subjectId,
      records,
      stream.head_digest,
    );
  }
  integrityFailure("unknown_contract", "authority stream contract is unknown");
}

function isHostRecoveryEvent(payload) {
  return [
    "backup_created",
    "backup_intent_recorded",
    "backup_receipt_recorded",
    "backup_reconciled",
    "restore_barrier_entered",
    "restore_applied",
    "restore_reconciled",
    "restore_admitted",
  ].includes(payload?.type);
}

export function runEventsFromRecords(records) {
  return records.map(({ payload }) => {
    const { prepared: _prepared, ...event } = payload;
    return event;
  });
}

function expectedEventContract(streamKind) {
  const contracts = {
    host_admission: "flow.host-admission-event/v1",
    host_runs: "flow.host-run-event/v1",
    run: "flow.run-event/v1",
    workspace: "work.workspace-event/v1",
    artifact: "work.artifact-event/v1",
    review: "work.review-event/v1",
    handoff: "flow.resource-handoff-event/v1",
  };
  const contract = contracts[streamKind];
  if (!contract) {
    integrityFailure("unknown_contract", "authority stream contract is unknown");
  }
  return contract;
}

export class AuthorityIntegrityError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "AuthorityIntegrityError";
    this.reason = reason;
  }
}

function integrityFailure(reason, message) {
  throw new AuthorityIntegrityError(reason, message);
}

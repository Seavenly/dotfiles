import { isDeepStrictEqual } from "node:util";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  acquireAuthorityLock,
  assertAuthorityEpoch as assertAuthorityEpochFence,
  assertMutationFence as assertMutationFenceState,
  AuthorityFenceError,
} from "./authority-fence.mjs";
import {
  canonicalize,
  digest,
  freezeCanonical,
} from "./canonical.mjs";
import { decideLifecycle } from "./lifecycle-kernel.mjs";
import { createHostAuthorityIdentityAdapter } from "./host-authority-identity.mjs";
import { validateLaunchRequest } from "./launch-validation.mjs";
import {
  createOneShotWatcher,
  createProjectionWatcher,
} from "./projection-watcher.mjs";
import { createRejection } from "./rejection.mjs";
import {
  buildRebootRevalidation,
  createFailClosedRebootObservationAdapter,
} from "./reboot-revalidation.mjs";
import { foldRun, projectRun, runWatermark } from "./run-projection.mjs";
import {
  AuthorityIntegrityError,
  readAuthorityStream,
  replayAuthorityStream,
} from "./sqlite-authority-replay.mjs";

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;
const require = createRequire(import.meta.url);
let databaseConstructor = null;

export function createInMemoryRunAuthority() {
  const runs = new Map();
  const bundleRuns = new Map();
  const authorityEvents = [];
  const watchers = new Map();

  return Object.freeze({
    launch(request = {}) {
      const validation = validateLaunchRequest(request);
      if (!validation.accepted) {
        return launchRejection(
          validation.code,
          validation.prepared,
          authorityEvents,
          validation.reason,
        );
      }
      const { prepared, closedFacts } = validation;

      const existingRunId = bundleRuns.get(prepared.bundle_digest);
      if (existingRunId) return launchReceipt(runs.get(existingRunId), false);

      const runId = `run:${prepared.bundle_digest.slice("sha256:".length)}`;
      const initialRun = {
        run_id: runId,
        prepared,
        events: [
          {
            type: "run_launched",
            bundle_digest: prepared.bundle_digest,
            plan_fingerprint: prepared.plan_fingerprint,
            confirmation_digest: prepared.confirmation_digest,
            closed_fact_observation_digest: digest(closedFacts),
          },
        ],
      };
      const run = freezeCanonical({
        ...initialRun,
        launch_watermark: runWatermark(initialRun),
      });
      runs.set(runId, run);
      bundleRuns.set(prepared.bundle_digest, runId);
      authorityEvents.push({
        type: "run_launched",
        run_id: runId,
        bundle_digest: prepared.bundle_digest,
      });
      return launchReceipt(run, true);
    },

    command(command) {
      const run = runs.get(command?.run_id);
      if (!run) {
        return unknownRunRejection(
          "command",
          command?.run_id,
          authorityEvents,
          command?.type,
        );
      }
      const fold = foldRun(run);
      const decision = decideLifecycle(fold, command);
      if (decision.schema === "flow.rejection/v1") {
        return freezeCanonical(decision);
      }

      const updatedRun = freezeCanonical({
        ...run,
        events: [...run.events, ...decision.events],
      });
      runs.set(run.run_id, updatedRun);
      const projection = projectRun(foldRun(updatedRun));
      for (const watcher of watchers.get(run.run_id) ?? []) {
        watcher.publish(projection);
      }
      return freezeCanonical({
        schema: "flow.command-receipt/v1",
        command_type: command.type,
        run_id: run.run_id,
        authority_watermark: projection.watermark,
        accepted: true,
      });
    },

    query(runId) {
      if (runId !== undefined) {
        const run = runs.get(runId);
        if (!run) return unknownRunRejection("query", runId, authorityEvents);
        return projectRun(foldRun(run));
      }
      return freezeCanonical({
        schema: "flow.run-index-projection/v1",
        watermark: authorityWatermark(authorityEvents),
        runs: [...runs.keys()].sort(),
      });
    },

    watch(runId) {
      const run = runs.get(runId);
      if (!run) {
        return createOneShotWatcher(
          unknownRunRejection("watch", runId, authorityEvents),
        );
      }
      const watcher = createProjectionWatcher({
        initialProjection: projectRun(foldRun(run)),
        close: () => {
        const runWatchers = watchers.get(runId);
        runWatchers?.delete(watcher);
        if (runWatchers?.size === 0) watchers.delete(runId);
        },
      });
      const runWatchers = watchers.get(runId) ?? new Set();
      runWatchers.add(watcher);
      watchers.set(runId, runWatchers);
      return watcher;
    },
  });
}

export function createDurableRunAuthority({
  authorityDirectory,
  access = "mutate",
  beforeEffect = () => {},
  declaredCapacity = 4,
  hostIdentityAdapter = createHostAuthorityIdentityAdapter(),
  lifecycleKernel = decideLifecycle,
  rebootObservationAdapter = createFailClosedRebootObservationAdapter(),
} = {}) {
  if (typeof authorityDirectory !== "string" || authorityDirectory.length === 0) {
    throw new TypeError("durable run authority requires an authority directory");
  }
  if (typeof hostIdentityAdapter?.observe !== "function") {
    throw new TypeError("durable run authority requires a host identity Adapter");
  }
  if (!["inspect", "mutate"].includes(access)) {
    throw new TypeError("durable run authority access must be inspect or mutate");
  }
  if (!Number.isSafeInteger(declaredCapacity) || declaredCapacity < 1) {
    throw new TypeError("durable run authority capacity must be a positive integer");
  }
  if (typeof beforeEffect !== "function") {
    throw new TypeError("durable run authority beforeEffect must be a function");
  }
  if (typeof lifecycleKernel !== "function") {
    throw new TypeError("durable run authority lifecycleKernel must be a function");
  }
  if (typeof rebootObservationAdapter?.observe !== "function") {
    throw new TypeError(
      "durable run authority requires a reboot observation Adapter",
    );
  }
  const hostIdentity = hostIdentityAdapter.observe();
  if (hostIdentity?.schema !== "flow.host-authority-identity/v1" ||
      typeof hostIdentity.boot_id !== "string" ||
      hostIdentity.boot_id.length === 0 ||
      typeof hostIdentity.process_identity !== "string" ||
      hostIdentity.process_identity.length === 0) {
    throw new TypeError("host identity Adapter returned an invalid observation");
  }
  const bootId = hostIdentity.boot_id;
  const processIdentity = hostIdentity.process_identity;
  const fenceRun = (database, stream) => fencedRunFold(
    database,
    stream,
    rebootObservationAdapter,
  );

  const databasePath = join(authorityDirectory, "authority.sqlite");
  const lockPath = join(authorityDirectory, "authority.lock.sqlite");
  const watchers = new Map();
  const effectsInFlight = new Set();
  let lockDatabase = null;
  let authorityEpoch = null;
  let closed = false;

  if (access === "mutate") {
    mkdirSync(authorityDirectory, { recursive: true, mode: 0o700 });
    lockDatabase = acquireAuthorityLock({
      createDatabase,
      lockPath,
      processIdentity,
    });
    if (lockDatabase) {
      let database = null;
      try {
        database = openAuthorityDatabase(databasePath);
        initializeAuthoritySchema(database);
        authorityEpoch = acquireAuthorityEpoch(database, {
          bootId,
          declaredCapacity,
          processIdentity,
        });
      } catch (error) {
        if (lockDatabase.isTransaction) lockDatabase.exec("ROLLBACK");
        lockDatabase.close();
        lockDatabase = null;
        throw error;
      } finally {
        database?.close();
      }
    }
  }

  return Object.freeze({
    launch(request = {}) {
      assertOpen();
      if (!lockDatabase) {
        return durableMutationRejection(
          "launch",
          null,
          databasePath,
          null,
          fenceRun,
        );
      }
      const validation = validateLaunchRequest(request);
      if (!validation.accepted) {
        return durableLaunchRejection(
          validation.code,
          validation.prepared,
          databasePath,
          validation.reason,
        );
      }
      const { prepared, closedFacts } = validation;

      const runId = `run:${prepared.bundle_digest.slice("sha256:".length)}`;
      const database = openAuthorityDatabase(databasePath);
      try {
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const existing = readStream(database, runId);
        if (existing) {
          return durableLaunchReceipt(database, existing, false, fenceRun);
        }

        database.exec("BEGIN IMMEDIATE");
        try {
          assertAuthorityEpoch(database, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
          const admission = readStream(database, "host:admission").fold;
          if (admission.active_runs.length >= admission.declared_capacity) {
            database.exec("ROLLBACK");
            return durableLaunchRejection(
              "host_capacity_exhausted",
              prepared,
              databasePath,
            );
          }
          appendAuthorityEvents(database, {
            streamId: runId,
            streamKind: "run",
            events: [{
              contract: "flow.run-event/v1",
              payload: {
                type: "run_launched",
                prepared,
                bundle_digest: prepared.bundle_digest,
                plan_fingerprint: prepared.plan_fingerprint,
                confirmation_digest: prepared.confirmation_digest,
                closed_fact_observation_digest: digest(closedFacts),
              },
            }],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          appendAuthorityEvents(database, {
            streamId: "host:runs",
            streamKind: "host_runs",
            events: [{
              contract: "flow.host-run-event/v1",
              payload: {
                type: "run_registered",
                run_id: runId,
                bundle_digest: prepared.bundle_digest,
              },
            }],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          appendAuthorityEvents(database, {
            streamId: "host:admission",
            streamKind: "host_admission",
            events: [{
              contract: "flow.host-admission-event/v1",
              payload: {
                type: "run_capacity_reserved",
                run_id: runId,
              },
            }],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return durableLaunchReceipt(
          database,
          readStream(database, runId),
          true,
          fenceRun,
        );
      } catch (error) {
        if (!(error instanceof AuthorityIntegrityError)) throw error;
        return authorityIntegrityRejection("launch", error.reason);
      } finally {
        database.close();
      }
    },

    command(command) {
      assertOpen();
      if (!lockDatabase) {
        return durableMutationRejection(
          "command",
          command?.run_id,
          databasePath,
          command?.type,
          fenceRun,
        );
      }
      const database = openAuthorityDatabase(databasePath);
      try {
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const stream = readStream(database, command?.run_id);
        if (!stream) {
          return durableUnknownRunRejection(
            "command",
            command?.run_id,
            database,
            command?.type,
          );
        }
        const decision = lifecycleKernel(
          fenceRun(database, stream),
          command,
        );
        if (decision.schema === "flow.rejection/v1") {
          return freezeCanonical(decision);
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          assertAuthorityEpoch(database, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
          const current = readStream(database, command.run_id);
          const currentFold = fenceRun(database, current);
          const currentDecision = lifecycleKernel(currentFold, command);
          if (currentDecision.schema === "flow.rejection/v1") {
            database.exec("ROLLBACK");
            return freezeCanonical(currentDecision);
          }
          const deferredEvents = currentDecision.events.filter(({ type }) =>
            ["run_declined", "run_succeeded"].includes(type));
          const immediateEvents = currentDecision.events.filter(({ type }) =>
            !["run_declined", "run_succeeded"].includes(type));
          const effectIntents = currentDecision.effect_intents.map((intent) =>
            bindEffectIntent(intent, {
              authorityEpoch,
              bootId,
              command,
              decision: currentDecision,
              deferredEvents,
              prepared: current.records[0].payload.prepared,
              runId: command.run_id,
            }));
          appendAuthorityEvents(database, {
            streamId: command.run_id,
            streamKind: "run",
            events: [
              ...(effectIntents.length === 0
                ? currentDecision.events
                : immediateEvents).map((payload) => ({
                contract: "flow.run-event/v1",
                payload,
              })),
              ...effectIntents.map((intent) => ({
                contract: "flow.run-event/v1",
                payload: { type: "effect_intent_recorded", intent },
              })),
            ],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          if (effectIntents.length === 0 && currentDecision.events.some(({ type }) =>
            ["run_declined", "run_succeeded"].includes(type))) {
            appendAuthorityEvents(database, {
              streamId: "host:admission",
              streamKind: "host_admission",
              events: [{
                contract: "flow.host-admission-event/v1",
                payload: {
                  type: "run_capacity_released",
                  run_id: command.run_id,
                },
              }],
              authorityEpoch,
              bootId,
              processIdentity,
            });
          }
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
        const projection = projectRun(fenceRun(
          database,
          readStream(database, command.run_id),
        ));
        for (const watcher of watchers.get(command.run_id) ?? []) {
          watcher.publish(projection);
        }
        const receipt = {
          schema: "flow.command-receipt/v1",
          command_type: command.type,
          run_id: command.run_id,
          authority_watermark: projection.watermark,
          accepted: true,
        };
        const recordedIntents = readRecordedEffectIntents(
          database,
          command.run_id,
          command,
        );
        return freezeCanonical(recordedIntents.length === 0
          ? receipt
          : { ...receipt, effect_intents: recordedIntents });
      } catch (error) {
        if (!(error instanceof AuthorityIntegrityError)) throw error;
        return authorityIntegrityRejection(
          "command",
          error.reason,
          command?.run_id,
        );
      } finally {
        database.close();
      }
    },

    query(runId) {
      assertOpen();
      if (!databaseExists(databasePath)) {
        if (runId !== undefined) {
          return unknownRunRejection("query", runId, []);
        }
        return freezeCanonical({
          schema: "flow.run-index-projection/v1",
          watermark: EMPTY_WATERMARK,
          runs: [],
        });
      }
      const database = openAuthorityDatabase(databasePath, { readOnly: true });
      try {
        try {
          if (runId !== undefined) {
            const stream = readStream(database, runId);
            if (!stream) {
              return durableUnknownRunRejection("query", runId, database);
            }
            return projectRun(fenceRun(database, stream));
          }
          const hostStream = readStream(database, "host:runs");
          const host = hostStream?.fold ?? freezeCanonical({
            schema: "flow.run-index-projection/v1",
            watermark: EMPTY_WATERMARK,
            runs: [],
          });
          const admission = readStream(database, "host:admission")?.fold;
          return fencedHostProjection(host, admission, declaredCapacity);
        } catch (error) {
          if (!(error instanceof AuthorityIntegrityError)) throw error;
          return authorityIntegrityRejection("query", error.reason, runId);
        }
      } finally {
        database.close();
      }
    },

    watch(runId) {
      assertOpen();
      const initial = this.query(runId);
      if (initial.schema === "flow.rejection/v1") {
        return createOneShotWatcher(initial);
      }
      const watcher = createProjectionWatcher({
        initialProjection: initial,
        readProjection: () => this.query(runId),
        close: () => {
          const runWatchers = watchers.get(runId);
          runWatchers?.delete(watcher);
          if (runWatchers?.size === 0) watchers.delete(runId);
        },
      });
      const runWatchers = watchers.get(runId) ?? new Set();
      runWatchers.add(watcher);
      watchers.set(runId, runWatchers);
      return watcher;
    },

    async invokeEffect(intent, adapter) {
      assertOpen();
      if (typeof adapter?.invoke !== "function") {
        throw new TypeError("effect adapter must expose invoke");
      }
      const dispatchKey = [
        intent?.run_id,
        intent?.effect_id,
        intent?.idempotency_key,
      ].join("\0");
      if (effectsInFlight.has(dispatchKey)) {
        throw new AuthorityFenceError(
          "effect_dispatch_in_progress",
          "effect intent is already being dispatched by this authority",
        );
      }
      effectsInFlight.add(dispatchKey);
      const database = openAuthorityDatabase(databasePath);
      try {
        const stream = typeof intent?.run_id === "string"
          ? readStream(database, intent.run_id)
          : null;
        const recorded = stream?.records.some(({ payload }) =>
          ["effect_intent_recorded", "effect_intent_adopted"].includes(
            payload.type,
          ) &&
          isDeepStrictEqual(payload.intent, intent));
        if (!recorded) {
          throw new AuthorityFenceError(
            "unrecorded_effect_intent",
            "effect intent was not durably recorded by RunAuthority",
          );
        }
        if (stream.records.some(({ payload }) =>
          payload.type === "effect_receipt_recorded" &&
          payload.effect_id === intent.effect_id)) {
          throw new AuthorityFenceError(
            "effect_already_recorded",
            "effect already has a durable receipt",
          );
        }
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        let effectiveIntent = intent;
        if (intent.authority_boot_id !== bootId) {
          throw new AuthorityFenceError(
            "stale_authority_epoch",
            "effects cannot be adopted across a host reboot",
          );
        }
        if (intent.authority_epoch !== authorityEpoch) {
          if (!["read_only", "caller_idempotent"].includes(
            intent.classification,
          )) {
            throw new AuthorityFenceError(
              "effect_reconciliation_required",
              "effect classification cannot be retried during recovery",
            );
          }
          effectiveIntent = adoptEffectIntent(database, intent, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
        }
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        beforeEffect(effectiveIntent);
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const result = await adapter.invoke(effectiveIntent);
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        database.exec("BEGIN IMMEDIATE");
        try {
          assertAuthorityEpoch(database, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
          const current = readStream(database, effectiveIntent.run_id);
          const unresolved = unresolvedEffectIds(current);
          unresolved.delete(effectiveIntent.effect_id);
          const deferredEvents = unresolved.size === 0
            ? effectiveIntent.deferred_events
            : [];
          appendAuthorityEvents(database, {
            streamId: effectiveIntent.run_id,
            streamKind: "run",
            events: [
              {
                contract: "flow.run-event/v1",
                payload: {
                  type: "effect_receipt_recorded",
                  effect_id: effectiveIntent.effect_id,
                  idempotency_key: effectiveIntent.idempotency_key,
                },
              },
              ...deferredEvents.map((payload) => ({
                contract: "flow.run-event/v1",
                payload,
              })),
            ],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          if (deferredEvents.some(({ type }) =>
            ["run_declined", "run_succeeded"].includes(type))) {
            appendAuthorityEvents(database, {
              streamId: "host:admission",
              streamKind: "host_admission",
              events: [{
                contract: "flow.host-admission-event/v1",
                payload: {
                  type: "run_capacity_released",
                  run_id: effectiveIntent.run_id,
                },
              }],
              authorityEpoch,
              bootId,
              processIdentity,
            });
          }
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
        return result;
      } finally {
        database.close();
        effectsInFlight.delete(dispatchKey);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      for (const runWatchers of watchers.values()) {
        for (const watcher of runWatchers) watcher.return();
      }
      watchers.clear();
      if (lockDatabase) {
        if (lockDatabase.isTransaction) lockDatabase.exec("ROLLBACK");
        lockDatabase.close();
        lockDatabase = null;
      }
    },
  });

  function assertOpen() {
    if (closed) throw new Error("durable run authority is closed");
  }
}

function openAuthorityDatabase(databasePath, { readOnly = false } = {}) {
  const database = createDatabase(databasePath, { readOnly });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
  if (!readOnly) {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  }
  return database;
}

function initializeAuthoritySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS authority_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      contract TEXT NOT NULL
    );
    INSERT OR IGNORE INTO authority_metadata(singleton, contract)
      VALUES (1, 'flow.sqlite-authority-store/v1');

    CREATE TABLE IF NOT EXISTS authority_streams (
      stream_id TEXT PRIMARY KEY,
      stream_kind TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
      head_digest TEXT NOT NULL,
      fold_contract TEXT,
      fold_json TEXT,
      fold_digest TEXT
    );

    CREATE TABLE IF NOT EXISTS authority_events (
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      generation INTEGER NOT NULL CHECK (generation > 0),
      contract TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      previous_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch > 0),
      boot_id TEXT NOT NULL,
      process_identity TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence),
      FOREIGN KEY (stream_id) REFERENCES authority_streams(stream_id)
    );

    CREATE TRIGGER IF NOT EXISTS authority_events_no_update
      BEFORE UPDATE ON authority_events
      BEGIN SELECT RAISE(ABORT, 'authority events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS authority_events_no_delete
      BEFORE DELETE ON authority_events
      BEGIN SELECT RAISE(ABORT, 'authority events are append-only'); END;
  `);
}

function acquireAuthorityEpoch(database, {
  bootId,
  declaredCapacity,
  processIdentity,
}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const admission = readStream(database, "host:admission");
    if (admission && admission.fold.declared_capacity !== declaredCapacity) {
      throw new Error("declared authority capacity conflicts with durable state");
    }
    const authorityEpoch = (admission?.fold.authority_epoch ?? 0) + 1;
    appendAuthorityEvents(database, {
      streamId: "host:admission",
      streamKind: "host_admission",
      events: [{
        contract: "flow.host-admission-event/v1",
        payload: {
          type: "authority_acquired",
          authority_epoch: authorityEpoch,
          boot_id: bootId,
          declared_capacity: declaredCapacity,
          process_identity: processIdentity,
        },
      }],
      authorityEpoch,
      bootId,
      processIdentity,
    });
    database.exec("COMMIT");
    return authorityEpoch;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function appendAuthorityEvents(database, {
  streamId,
  streamKind,
  events,
  authorityEpoch,
  bootId,
  processIdentity,
}) {
  let stream = database.prepare(`
    SELECT * FROM authority_streams WHERE stream_id = ?
  `).get(streamId);
  if (!stream) {
    database.prepare(`
      INSERT INTO authority_streams(
        stream_id, stream_kind, generation, head_sequence, head_digest
      ) VALUES (?, ?, 1, 0, ?)
    `).run(streamId, streamKind, EMPTY_WATERMARK);
    stream = database.prepare(`
      SELECT * FROM authority_streams WHERE stream_id = ?
    `).get(streamId);
  }
  if (stream.stream_kind !== streamKind) {
    throw new Error("authority stream kind conflict");
  }

  let sequence = Number(stream.head_sequence);
  let previousDigest = stream.head_digest;
  for (const event of events) {
    sequence += 1;
    const payload = canonicalize(event.payload);
    const payloadJson = JSON.stringify(payload);
    const payloadDigest = digest(payload);
    const record = {
      schema: "flow.authority-event-record/v1",
      stream_id: streamId,
      sequence,
      generation: Number(stream.generation),
      contract: event.contract,
      payload,
      payload_digest: payloadDigest,
      previous_digest: previousDigest,
      authority_epoch: authorityEpoch,
      boot_id: bootId,
      process_identity: processIdentity,
    };
    const recordDigest = digest(record);
    database.prepare(`
      INSERT INTO authority_events(
        stream_id, sequence, generation, contract, payload_json,
        payload_digest, previous_digest, record_digest, authority_epoch,
        boot_id, process_identity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      streamId,
      sequence,
      Number(stream.generation),
      event.contract,
      payloadJson,
      payloadDigest,
      previousDigest,
      recordDigest,
      authorityEpoch,
      bootId,
      processIdentity,
    );
    previousDigest = recordDigest;
  }
  database.prepare(`
    UPDATE authority_streams
       SET head_sequence = ?, head_digest = ?
     WHERE stream_id = ?
  `).run(sequence, previousDigest, streamId);

  const replayed = replayStream(database, streamId, { verifyFold: false });
  const foldJson = JSON.stringify(canonicalize(replayed.fold));
  database.prepare(`
    UPDATE authority_streams
       SET fold_contract = ?, fold_json = ?, fold_digest = ?
     WHERE stream_id = ?
  `).run(replayed.fold.schema, foldJson, digest(replayed.fold), streamId);
}

function readStream(database, streamId) {
  return readAuthorityStream(database, streamId);
}

function replayStream(database, streamId, options) {
  return replayAuthorityStream(database, streamId, options);
}

function assertMutationFence(lockDatabase, database, expected) {
  assertMutationFenceState({
    database,
    expected,
    lockDatabase,
    readAdmission,
  });
}

function assertAuthorityEpoch(database, expected) {
  assertAuthorityEpochFence({ database, expected, readAdmission });
}

function readAdmission(database) {
  return readStream(database, "host:admission")?.fold;
}

function bindEffectIntent(intent, {
  authorityEpoch,
  bootId,
  command,
  decision,
  deferredEvents,
  prepared,
  runId,
}) {
  if (intent?.schema !== "flow.effect-intent/v1" ||
      typeof intent.effect_id !== "string" || intent.effect_id.length === 0 ||
      typeof intent.idempotency_key !== "string" ||
      intent.idempotency_key.length === 0 ||
      typeof intent.attempt_id !== "string" || intent.attempt_id.length === 0 ||
      ![
        "read_only",
        "caller_idempotent",
        "reconcilable",
        "one_shot_uncertain",
      ].includes(intent.classification) ||
      typeof intent.operation_contract !== "string" ||
      intent.operation_contract.length === 0 ||
      !(intent.route_binding === null ||
        (typeof intent.route_binding === "object" &&
          !Array.isArray(intent.route_binding)))) {
    throw new TypeError(
      "lifecycle decisions must emit identified, idempotent effect intents",
    );
  }
  const facts = prepared.explicit_facts;
  return freezeCanonical({
    ...intent,
    run_id: runId,
    decision_digest: digest(decision),
    command_digest: digest(command),
    deferred_events: deferredEvents,
    authority_epoch: authorityEpoch,
    authority_boot_id: bootId,
    catalog_fingerprint: facts.catalog_fingerprint,
    route_snapshot: facts.route_snapshot,
    capability_envelopes: facts.capability_envelopes,
    operation_contracts: facts.operation_contracts,
    validator_contracts: facts.validator_contracts,
    resource_claims: facts.resource_claims,
    time_facts: [],
    subject_generations: [],
  });
}

function adoptEffectIntent(database, intent, {
  authorityEpoch,
  bootId,
  processIdentity,
}) {
  const priorIntentDigest = digest(intent);
  const existing = readStream(database, intent.run_id).records
    .find(({ payload }) =>
      payload.type === "effect_intent_adopted" &&
      payload.prior_intent_digest === priorIntentDigest &&
      payload.intent.authority_epoch === authorityEpoch &&
      payload.intent.authority_boot_id === bootId);
  if (existing) return existing.payload.intent;

  const adopted = freezeCanonical({
    ...intent,
    authority_epoch: authorityEpoch,
    authority_boot_id: bootId,
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    assertAuthorityEpoch(database, {
      authorityEpoch,
      bootId,
      processIdentity,
    });
    appendAuthorityEvents(database, {
      streamId: intent.run_id,
      streamKind: "run",
      events: [{
        contract: "flow.run-event/v1",
        payload: {
          type: "effect_intent_adopted",
          prior_intent_digest: priorIntentDigest,
          intent: adopted,
        },
      }],
      authorityEpoch,
      bootId,
      processIdentity,
    });
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
  return adopted;
}

function readRecordedEffectIntents(database, runId, command) {
  const commandDigest = digest(command);
  return readStream(database, runId).records
    .filter(({ payload }) =>
      payload.type === "effect_intent_recorded" &&
      payload.intent.command_digest === commandDigest)
    .map(({ payload }) => payload.intent);
}

function unresolvedEffectIds(stream) {
  const unresolved = new Set(stream.records
    .filter(({ payload }) => [
      "effect_intent_recorded",
      "effect_intent_adopted",
    ].includes(payload.type))
    .map(({ payload }) => payload.intent.effect_id));
  for (const { payload } of stream.records) {
    if (payload.type === "effect_receipt_recorded") {
      unresolved.delete(payload.effect_id);
    }
  }
  return unresolved;
}


function authorityIntegrityRejection(operation, reason, runId = null) {
  return createRejection({
    operation,
    code: "authority_integrity_failure",
    reason,
    runId: runId ?? null,
    authorityWatermark: null,
    authorityWatermarkDomain: runId ? "run" : "host",
  });
}

function durableLaunchReceipt(database, stream, created, fenceRun) {
  const fold = fenceRun(database, stream);
  return freezeCanonical({
    schema: "flow.launch-receipt/v1",
    run_id: fold.run_id,
    bundle_digest: fold.bundle_digest,
    plan_fingerprint: fold.plan_fingerprint,
    launch_watermark: fold.watermark,
    authority_watermark: fold.watermark,
    created,
  });
}

function fencedRunFold(database, stream, rebootObservationAdapter) {
  const admission = readStream(database, "host:admission")?.fold;
  if (!admission) throw new Error("authority admission stream is missing");
  const suspendedAfterReboot = stream.fold.phase === "active" &&
    stream.lastBootId !== admission.boot_id;
  const revalidation = suspendedAfterReboot
    ? rebootRevalidation(stream, rebootObservationAdapter)
    : null;
  const watermark = digest({
    schema: "flow.fenced-run-watermark/v1",
    stream_watermark: stream.fold.watermark,
    stream_generation: stream.generation,
    authority_epoch: admission.authority_epoch,
    authority_boot_id: admission.boot_id,
    ...(revalidation === null ? {} : {
      reboot_revalidation_digest: digest(revalidation),
    }),
  });
  const legalActions = suspendedAfterReboot
    ? [{
        schema: "flow.command/v1",
        type: "reboot_admission",
        run_id: stream.fold.run_id,
        expected_watermark: watermark,
        authority_epoch: admission.authority_epoch,
        authority_boot_id: admission.boot_id,
        expected_generation: stream.generation,
        revalidation,
      }]
    : stream.fold.legal_actions.map((action) => ({
        ...action,
        expected_watermark: watermark,
      }));
  return freezeCanonical({
    ...stream.fold,
    watermark,
    admission: suspendedAfterReboot ? "suspended_after_reboot" : "admitted",
    authority_epoch: admission.authority_epoch,
    authority_boot_id: admission.boot_id,
    stream_generation: stream.generation,
    ...(revalidation === null ? {} : { reboot_revalidation: revalidation }),
    legal_actions: legalActions,
  });
}

function rebootRevalidation(stream, adapter) {
  const prepared = stream.records[0].payload.prepared;
  const receipts = new Set(stream.records
    .filter(({ payload }) => payload.type === "effect_receipt_recorded")
    .map(({ payload }) => payload.effect_id));
  const unresolvedEffects = stream.records
    .filter(({ payload }) => [
      "effect_intent_recorded",
      "effect_intent_adopted",
    ].includes(payload.type))
    .map(({ payload }) => payload.intent)
    .filter(({ effect_id: effectId }) => !receipts.has(effectId));
  return buildRebootRevalidation({
    adapter,
    prepared,
    unresolvedEffects,
  });
}

function durableUnknownRunRejection(operation, runId, database, commandType) {
  const host = durableHostProjection(database);
  return createRejection({
    operation,
    code: "unknown_run",
    commandType: commandType ?? null,
    runId: runId ?? null,
    authorityWatermark: host.watermark,
    authorityWatermarkDomain: "host",
  });
}

function durableMutationRejection(
  operation,
  runId,
  databasePath,
  commandType,
  fenceRun,
) {
  let authorityWatermark = EMPTY_WATERMARK;
  let legalActions = [];
  let bundleDigest = null;
  if (databaseExists(databasePath)) {
    const database = openAuthorityDatabase(databasePath, { readOnly: true });
    try {
      try {
        const stream = runId ? readStream(database, runId) : null;
        const host = durableHostProjection(database);
        const runFold = stream ? fenceRun(database, stream) : null;
        authorityWatermark = runFold?.watermark ?? host.watermark ??
          EMPTY_WATERMARK;
        legalActions = runFold?.legal_actions ?? [];
        bundleDigest = runFold?.bundle_digest ?? null;
      } catch (error) {
        if (!(error instanceof AuthorityIntegrityError)) throw error;
        return authorityIntegrityRejection(operation, error.reason, runId);
      }
    } finally {
      database.close();
    }
  }
  return createRejection({
    operation,
    code: "mutation_authority_unavailable",
    commandType: commandType ?? null,
    runId: runId ?? null,
    bundleDigest,
    authorityWatermark,
    authorityWatermarkDomain: runId ? "run" : "host",
    legalActions,
  });
}

function durableLaunchRejection(
  code,
  prepared,
  databasePath,
  reason = null,
) {
  let authorityWatermark = EMPTY_WATERMARK;
  if (databaseExists(databasePath)) {
    const database = openAuthorityDatabase(databasePath, { readOnly: true });
    try {
      try {
        authorityWatermark = durableHostProjection(database).watermark;
      } catch (error) {
        if (!(error instanceof AuthorityIntegrityError)) throw error;
        return authorityIntegrityRejection("launch", error.reason);
      }
    } finally {
      database.close();
    }
  }
  return createRejection({
    operation: "launch",
    code,
    reason,
    bundleDigest: prepared?.bundle_digest ?? null,
    authorityWatermark,
    authorityWatermarkDomain: "host",
  });
}

function durableHostProjection(database) {
  const host = readStream(database, "host:runs")?.fold ?? freezeCanonical({
    schema: "flow.run-index-projection/v1",
    watermark: EMPTY_WATERMARK,
    runs: [],
  });
  const admission = readStream(database, "host:admission")?.fold ?? null;
  return fencedHostProjection(host, admission, admission?.declared_capacity ?? 0);
}

function fencedHostProjection(host, admission, fallbackCapacity) {
  return freezeCanonical({
    ...host,
    watermark: digest({
      schema: "flow.fenced-host-watermark/v1",
      run_index_watermark: host.watermark,
      admission_watermark: admission?.watermark ?? EMPTY_WATERMARK,
    }),
    authority_epoch: admission?.authority_epoch ?? 0,
    authority_boot_id: admission?.boot_id ?? null,
    admission: {
      active_runs: admission?.active_runs.length ?? 0,
      declared_capacity: admission?.declared_capacity ?? fallbackCapacity,
    },
  });
}

function databaseExists(databasePath) {
  try {
    const database = createDatabase(databasePath, {
      open: false,
      readOnly: true,
    });
    database.open();
    database.close();
    return true;
  } catch {
    return false;
  }
}

function createDatabase(path, options) {
  databaseConstructor ??= require("node:sqlite").DatabaseSync;
  return options === undefined
    ? new databaseConstructor(path)
    : new databaseConstructor(path, options);
}

function launchReceipt(run, created) {
  return freezeCanonical({
    schema: "flow.launch-receipt/v1",
    run_id: run.run_id,
    bundle_digest: run.prepared.bundle_digest,
    plan_fingerprint: run.prepared.plan_fingerprint,
    launch_watermark: run.launch_watermark,
    authority_watermark: runWatermark(run),
    created,
  });
}

function unknownRunRejection(operation, runId, authorityEvents, commandType) {
  return createRejection({
    operation,
    code: "unknown_run",
    commandType: commandType ?? null,
    runId: runId ?? null,
    authorityWatermark: authorityWatermark(authorityEvents),
    authorityWatermarkDomain: "host",
  });
}

function launchRejection(code, prepared, authorityEvents, reason = null) {
  return createRejection({
    operation: "launch",
    code,
    reason,
    bundleDigest: prepared?.bundle_digest ?? null,
    authorityWatermark: authorityWatermark(authorityEvents),
    authorityWatermarkDomain: "host",
  });
}

function authorityWatermark(events) {
  if (events.length === 0) return EMPTY_WATERMARK;
  return digest({
    schema: "flow.host-run-authority-stream/v1",
    events,
  });
}

import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  acquireAuthorityLock,
  assertAuthorityEpoch as assertAuthorityEpochFence,
  assertMutationFence as assertMutationFenceState,
  AuthorityFenceError,
} from "./authority-fence.mjs";
import {
  CanonicalValueError,
  canonicalize,
  digest,
  freezeCanonical,
} from "./canonical.mjs";
import { decideLifecycle } from "./lifecycle-kernel.mjs";
import {
  effectClassPolicy,
  normalizeEffectObservation,
  validateEffectObservation,
} from "./operation-effects.mjs";
import { createHostAuthorityIdentityAdapter } from "./host-authority-identity.mjs";
import {
  createFailClosedGitRetentionAdapter,
  createFailClosedGitWorkspaceObservationAdapter,
} from "./git-retention-adapter.mjs";
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
import { deriveChildRunId } from "./subrun-effects.mjs";
import {
  AuthorityIntegrityError,
  readAuthorityStream,
  replayAuthorityStream,
  runEventsFromRecords,
} from "./sqlite-authority-replay.mjs";
import {
  AUTHORITY_SCHEMA_RELEASE,
  CURRENT_AUTHORITY_SCHEMA_VERSION,
  initializeAuthoritySchema as initializeStoreSchema,
  readAuthoritySchemaCompatibility,
  transitionAuthoritySchema,
  uninitializedAuthoritySchemaCompatibility,
} from "./authority-schema.mjs";
import {
  attachRunEffectIntentReader,
  attachWorkAuthorities,
  buildArtifactCollectionPreview,
  buildConsumerHandoffBinding,
  buildConsumerMutationAuthorization,
  buildHandoffCleanupPreview,
  buildHandoffPublication,
  buildHumanAuthorityBinding,
  buildWorkspaceCleanupPreview,
  decideWorkCommand,
  validateHandoffPublicationAuthority,
  withHandoffObservations,
  withArtifactAvailability,
  workRejection,
  workStreamIdentity,
  workspaceEffectAuthorityIssue,
} from "./work-authority.mjs";
import {
  reviewRecordCandidateAuthorityIssue,
  reviewRecordSourceAuthorityIssue,
} from "./review-flow.mjs";
import {
  executeHostRecoveryCommand,
  initialBackupProjection,
  initialRestoreBarrier,
  isBackupRestoreCommand,
  projectHostRecovery,
  snapshotBackupRestoreAdapter,
  reduceHostRecoveryEvent,
} from "./backup-restore.mjs";

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;
const EFFECT_INTENT_EVENT_TYPES = new Set([
  "effect_intent_recorded",
  "effect_intent_adopted",
]);
const DEFERRED_EFFECT_EVENT_TYPES = new Set([
  "delegate_completed",
  "operation_completed",
  "run_declined",
  "run_succeeded",
]);
const require = createRequire(import.meta.url);
let databaseConstructor = null;

export function createInMemoryRunAuthority({ backupRestoreAdapter = null } = {}) {
  const runs = new Map();
  const bundleRuns = new Map();
  const authorityEvents = [];
  const watchers = new Map();
  const hostWatchers = new Set();
  const recoveryAdapter = snapshotBackupRestoreAdapter(backupRestoreAdapter);
  const hostRecoveryEvents = [];
  let hostRecovery = {
    backup: initialBackupProjection(),
    restore: initialRestoreBarrier(),
  };
  let childLaunchLineage = null;

  const hostProjection = () => {
    const watermark = authorityWatermark([
      ...authorityEvents,
      ...hostRecoveryEvents,
    ]);
    const base = {
      schema: "flow.run-index-projection/v1",
      watermark,
      runs: [...runs.keys()].sort(),
    };
    const recovery = projectHostRecovery(hostRecovery, watermark);
    return freezeCanonical({ ...base, watermark, ...recovery });
  };

  const publishHost = () => {
    const projection = hostProjection();
    for (const watcher of hostWatchers) watcher.publish(projection);
    for (const [runId, runWatchers] of watchers) {
      const run = runs.get(runId);
      if (!run) continue;
      const runProjection = projectRunWithHostBarrier(
        projectRun({
          authorityEventStreamDigest: runWatermark(run),
          fold: foldRun(run),
          events: run.events,
        }),
        projection,
      );
      for (const watcher of runWatchers) watcher.publish(runProjection);
    }
  };

  const appendHostRecovery = (payload) => {
    hostRecoveryEvents.push(payload);
    hostRecovery = reduceHostRecoveryEvent(hostRecovery, payload);
    publishHost();
    return hostProjection();
  };

  const hostMutationRejection = (operation, commandType = null) => {
    const host = hostProjection();
    return createRejection({
      operation,
      code: "host_reconciliation_required",
      commandType,
      authorityWatermark: host.watermark,
      authorityWatermarkDomain: "host",
      legalActions: host.legal_actions ?? host.restore?.legal_actions ??
        host.backup?.legal_actions ?? [],
    });
  };

  const hostCommand = (command = {}) => {
    const before = hostProjection();
    return executeHostRecoveryCommand({
      command,
      before,
      recoveryAdapter,
      append: appendHostRecovery,
      read: hostProjection,
      beforeMutation: () => {
        if (hostProjection().restore?.active === true) {
          throw new AuthorityFenceError(
            "host_reconciliation_required",
            "backup mutation is fenced by the host restore barrier",
          );
        }
      },
    });
  };

  const runAuthority = Object.freeze({
    launch(request = {}) {
      if (hostProjection().restore?.active === true) {
        return hostMutationRejection("launch");
      }
      const lineage = childLaunchLineage;
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

      const existingRunId = lineage === null
        ? bundleRuns.get(prepared.bundle_digest)
        : null;
      if (existingRunId) return launchReceipt(runs.get(existingRunId), false);

      const runId = lineage === null
        ? `run:${prepared.bundle_digest.slice("sha256:".length)}`
        : deriveChildRunId(lineage);
      if (lineage !== null && runs.has(runId)) {
        return launchReceipt(runs.get(runId), false);
      }
      const runOwnership = lineage === null
        ? topLevelRunOwnership()
        : childRunOwnership(lineage.parent_run_id);
      if (runOwnership.scope === "child" &&
          prepared.explicit_facts.tracker_binding !== undefined) {
        return launchRejection(
          "tracker_mutation_not_owned",
          prepared,
          authorityEvents,
        );
      }
      const initialRun = {
        run_id: runId,
        ...(lineage === null ? {} : { lineage }),
        prepared,
        events: [
          {
            type: "run_launched",
            bundle_digest: prepared.bundle_digest,
            plan_fingerprint: prepared.plan_fingerprint,
            confirmation_digest: prepared.confirmation_digest,
            closed_fact_observation_digest: digest(closedFacts),
            ...(lineage === null ? {} : { lineage }),
            run_ownership: runOwnership,
          },
          ...prepared.explicit_facts.block_observations.map((observation) => ({
            type: "card_blocked",
            card_id: observation.card_id,
            block: observation.block,
            observation_digest: observation.evidence_digest,
          })),
        ],
      };
      const run = freezeCanonical({
        ...initialRun,
        launch_watermark: runWatermark(initialRun),
      });
      runs.set(runId, run);
      if (lineage === null) bundleRuns.set(prepared.bundle_digest, runId);
      authorityEvents.push({
        type: "run_launched",
        run_id: runId,
        bundle_digest: prepared.bundle_digest,
      });
      publishHost();
      return launchReceipt(run, true);
    },

    launchChild({
      parent_run_id: parentRunId,
      card_id: cardId,
      card_identity: cardIdentity,
      revision_ordinal: revisionOrdinal,
      launch_request: launchRequest,
    }) {
      const lineage = childLineage(
        parentRunId,
        cardId,
        cardIdentity,
        revisionOrdinal,
      );
      const parent = runs.get(parentRunId);
      if (!validChildLaunchParent(parent, lineage, launchRequest)) {
        const projection = parent ? projectInMemoryRun(parent) : null;
        return createRejection({
          operation: "launch",
          code: "subrun_not_actionable",
          runId: parentRunId,
          authorityWatermark: projection?.watermark ??
            authorityWatermark(authorityEvents),
          authorityWatermarkDomain: projection ? "run" : "host",
          legalActions: projection?.legal_actions ?? [],
        });
      }
      childLaunchLineage = lineage;
      let receipt;
      try {
        receipt = this.launch(launchRequest);
      } finally {
        childLaunchLineage = null;
      }
      if (receipt?.schema !== "flow.launch-receipt/v1") return receipt;
      this.recordSubrunAdmission(lineage);
      return receipt;
    },

    recordSubrunAdmission(lineage) {
      if (hostProjection().restore?.active === true) {
        return hostMutationRejection(
          "subrun_admission",
          "subrun_admission",
        );
      }
      const childRunId = deriveChildRunId(lineage);
      const parent = runs.get(lineage.parent_run_id);
      const child = runs.get(childRunId);
      if (!validRecordedSubrunAdmission(parent, child, lineage)) {
        const projection = parent ? projectInMemoryRun(parent) : null;
        return createRejection({
          operation: "subrun_admission",
          code: "subrun_admission_unproven",
          runId: lineage.parent_run_id,
          authorityWatermark: projection?.watermark ??
            authorityWatermark(authorityEvents),
          authorityWatermarkDomain: projection ? "run" : "host",
          legalActions: projection?.legal_actions ?? [],
        });
      }
      if (!parent.events.some(({ type, child_run_id: recordedChildId }) =>
        type === "subrun_admitted" && recordedChildId === childRunId)) {
        const updatedParent = freezeCanonical({
          ...parent,
          events: [...parent.events, {
            type: "subrun_admitted",
            card_id: lineage.card_id,
            child_run_id: childRunId,
            child_watermark: runWatermark(child),
          }],
        });
        runs.set(lineage.parent_run_id, updatedParent);
        const projection = projectInMemoryRun(updatedParent);
        for (const watcher of watchers.get(lineage.parent_run_id) ?? []) {
          watcher.publish(projection);
        }
      }
      return projectInMemoryRun(runs.get(lineage.parent_run_id));
    },

    command(command) {
      if (isBackupRestoreCommand(command)) return hostCommand(command);
      if (hostProjection().restore?.active === true) {
        return hostMutationRejection("command", command?.type);
      }
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
      let decision;
      try {
        decision = decideLifecycle(fold, command);
      } catch (error) {
        if (!(error instanceof CanonicalValueError)) throw error;
        return createRejection({
          operation: "command",
          code: "invalid_command",
          reason: error.reason,
          commandType: stringOrNull(command?.type),
          runId: run.run_id,
          bundleDigest: fold.bundle_digest,
          authorityWatermark: fold.watermark,
          authorityWatermarkDomain: "run",
          legalActions: fold.legal_actions,
        });
      }
      if (decision.schema === "flow.rejection/v1") {
        return freezeCanonical(decision);
      }

      const updatedRun = freezeCanonical({
        ...run,
        events: [...run.events, ...decision.events],
      });
      runs.set(run.run_id, updatedRun);
      const projection = projectRun({
        authorityEventStreamDigest: runWatermark(updatedRun),
        fold: foldRun(updatedRun),
        events: updatedRun.events,
      });
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
        return projectRunWithHostBarrier(projectRun({
          authorityEventStreamDigest: runWatermark(run),
          fold: foldRun(run),
          events: run.events,
        }), hostProjection());
      }
      return hostProjection();
    },

    watch(runId) {
      const run = runs.get(runId);
      if (!run) {
        return createOneShotWatcher(
          unknownRunRejection("watch", runId, authorityEvents),
        );
      }
      const watcher = createProjectionWatcher({
        initialProjection: projectRunWithHostBarrier(projectRun({
          authorityEventStreamDigest: runWatermark(run),
          fold: foldRun(run),
          events: run.events,
        }), hostProjection()),
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

    watchHost() {
      const watcher = createProjectionWatcher({
        initialProjection: hostProjection(),
        close: () => hostWatchers.delete(watcher),
      });
      hostWatchers.add(watcher);
      return watcher;
    },

    hostCommand,
  });
  attachRunEffectIntentReader(runAuthority, Object.freeze({
    schema: "flow.run-effect-intent-reader/v1",
    query(runId, effectId) {
      const run = runs.get(runId);
      const effect = run === undefined
        ? null
        : foldRun(run).effects.find(({ effect_id: id }) => id === effectId) ?? null;
      return effect === null ? null : freezeCanonical(effect);
    },
  }));
  return runAuthority;
}

export function createDurableRunAuthority({
  afterCancellationCommit = () => {},
  afterChildLaunchCommit = () => {},
  authorityDirectory,
  access = "mutate",
  afterSchemaTransitionCommit = () => {},
  backupRestoreAdapter = null,
  beforeEffect = () => {},
  beforeHandoffCommit = () => {},
  beforeIntentCommit = () => {},
  beforeSchemaTransitionCommit = () => {},
  declaredCapacity = 4,
  gitRetentionAdapter = createFailClosedGitRetentionAdapter(),
  gitWorkspaceObservationAdapter = createFailClosedGitWorkspaceObservationAdapter(),
  hostIdentityAdapter = createHostAuthorityIdentityAdapter(),
  lifecycleKernel = decideLifecycle,
  beforeCancellationCommit = () => {},
  rebootObservationAdapter = createFailClosedRebootObservationAdapter(),
  workEvidenceAdapter = createFailClosedWorkEvidenceAdapter(),
  runOwnershipAdapter = createTopLevelRunOwnershipAdapter(),
} = {}) {
  if (typeof authorityDirectory !== "string" || authorityDirectory.length === 0) {
    throw new TypeError("durable run authority requires an authority directory");
  }
  if (typeof hostIdentityAdapter?.observe !== "function") {
    throw new TypeError("durable run authority requires a host identity Adapter");
  }
  if (typeof gitRetentionAdapter?.observe !== "function") {
    throw new TypeError("durable run authority requires a Git retention Adapter");
  }
  if (typeof gitWorkspaceObservationAdapter?.observe !== "function") {
    throw new TypeError("durable run authority requires a workspace Git Adapter");
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
  if (typeof beforeHandoffCommit !== "function") {
    throw new TypeError(
      "durable run authority beforeHandoffCommit must be a function",
    );
  }
  if (typeof afterChildLaunchCommit !== "function") {
    throw new TypeError(
      "durable run authority child-launch hook must be a function",
    );
  }
  if (typeof afterCancellationCommit !== "function" ||
      typeof beforeCancellationCommit !== "function") {
    throw new TypeError(
      "durable run authority cancellation hooks must be functions",
    );
  }
  if (typeof beforeIntentCommit !== "function") {
    throw new TypeError(
      "durable run authority beforeIntentCommit must be a function",
    );
  }
  if (typeof afterSchemaTransitionCommit !== "function") {
    throw new TypeError(
      "durable run authority post-transition hook must be a function",
    );
  }
  if (typeof beforeSchemaTransitionCommit !== "function") {
    throw new TypeError(
      "durable run authority schema transition hook must be a function",
    );
  }
  if (typeof lifecycleKernel !== "function") {
    throw new TypeError("durable run authority lifecycleKernel must be a function");
  }
  if (typeof rebootObservationAdapter?.observe !== "function") {
    throw new TypeError(
      "durable run authority requires a reboot observation Adapter",
    );
  }
  if (typeof workEvidenceAdapter?.validate !== "function") {
    throw new TypeError("durable run authority requires a Work evidence Adapter");
  }
  if (typeof runOwnershipAdapter?.observe !== "function") {
    throw new TypeError("durable run authority requires a run ownership Adapter");
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
  const recoveryAdapter = snapshotBackupRestoreAdapter(backupRestoreAdapter);
  const fenceRun = (database, stream) => fencedRunFold(
    database,
    stream,
    rebootObservationAdapter,
  );

  const databasePath = join(authorityDirectory, "authority.sqlite");
  const lockPath = join(authorityDirectory, "authority.lock.sqlite");
  const watchers = new Map();
  const effectsInFlight = new Map();
  let lockDatabase = null;
  let authorityEpoch = null;
  let authoritySchemaCompatibility = null;
  let sameBootRecoveryRunIds = new Set();
  let childLaunchLineage = null;
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
        authoritySchemaCompatibility = initializeStoreSchema(database, {
          afterCommit: afterSchemaTransitionCommit,
          beforeCommit: beforeSchemaTransitionCommit,
        });
        if (authoritySchemaCompatibility.status === "compatible") {
          const previousAdmission = readAdmission(database);
          // Active runs retain capacity until unresolved effects settle. Any
          // future release path must preserve that recovery-coverage invariant.
          if (previousAdmission?.boot_id === bootId) {
            sameBootRecoveryRunIds = new Set(previousAdmission.active_runs);
            const runIndex = readStream(database, "host:runs")?.fold;
            for (const runId of runIndex?.runs ?? []) {
              const stream = readStream(database, runId);
              if (stream?.lastBootId === bootId &&
                  stream.fold.legal_actions.some((action) =>
                    action.type === "recovery" &&
                    ["delegate", "delegate_cancellation"].includes(
                      stream.fold.effects.find(({ effect_id: effectId }) =>
                        effectId === action.effect_id)?.effect_kind,
                    ))) {
                sameBootRecoveryRunIds.add(runId);
              }
            }
          }
          authorityEpoch = acquireAuthorityEpoch(database, {
            bootId,
            declaredCapacity,
            processIdentity,
          });
        } else if (authoritySchemaCompatibility.status === "incompatible") {
          if (lockDatabase.isTransaction) lockDatabase.exec("ROLLBACK");
          lockDatabase.close();
          lockDatabase = null;
        }
      } catch (error) {
        if (lockDatabase?.isTransaction) lockDatabase.exec("ROLLBACK");
        lockDatabase?.close();
        lockDatabase = null;
        throw error;
      } finally {
        database?.close();
      }
    }
  }

  function publishHostProjection() {
    const projection = authorityMethods.query();
    for (const watcher of watchers.get(undefined) ?? []) {
      watcher.publish(projection);
    }
    for (const [runId, runWatchers] of watchers) {
      if (runId === undefined) continue;
      const runProjection = authorityMethods.query(runId);
      if (runProjection?.schema === "flow.rejection/v1") continue;
      for (const watcher of runWatchers) watcher.publish(runProjection);
    }
  }

  function hostCommand(command = {}) {
    assertOpen();
    if (!isBackupRestoreCommand(command)) {
      const host = authorityMethods.query();
      return hostCommandRejection(
        "command",
        "unsupported_host_command",
        null,
        host,
      );
    }
    if (authoritySchemaCompatibility?.status === "incompatible") {
      return schemaCompatibilityRejection(
        "command",
        authoritySchemaCompatibility,
        null,
        command?.type,
      );
    }
    if (authoritySchemaCompatibility?.status === "transition_required") {
      return schemaTransitionRequiredRejection(
        "command",
        databasePath,
        null,
        null,
        command?.type,
      );
    }
    if (!lockDatabase) {
      return durableMutationRejection(
        "command",
        null,
        databasePath,
        command?.type,
        fenceRun,
      );
    }
    const readHost = () => {
      const database = openAuthorityDatabase(databasePath, { readOnly: true });
      try {
        return durableHostProjection(database);
      } finally {
        database.close();
      }
    };
    let before;
    try {
      before = readHost();
    } catch (error) {
      const integrity = authorityIntegrityError(error);
      if (!integrity) throw error;
      return authorityIntegrityRejection("command", integrity.reason);
    }
    return executeHostRecoveryCommand({
      command,
      before,
      recoveryAdapter,
      append: appendDurableHostRecoveryEvent,
      read: readHost,
      publish: publishHostProjection,
      effectsInFlight,
      unresolvedRunEffects: () => {
        const database = openAuthorityDatabase(databasePath, { readOnly: true });
        try {
          return durableUnresolvedRunEffects(database);
        } finally {
          database.close();
        }
      },
      beforeMutation: () => {
        const database = openAuthorityDatabase(databasePath, { readOnly: true });
        try {
          assertDurableHostRestoreClear(
            database,
            "backup mutation is fenced by the host restore barrier",
          );
        } finally {
          database.close();
        }
      },
    });
  }
  function appendDurableHostRecoveryEvent(payload) {
    const database = openAuthorityDatabase(databasePath);
    try {
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
        appendAuthorityEvents(database, {
          streamId: "host:admission",
          streamKind: "host_admission",
          events: [{
            contract: "flow.host-admission-event/v1",
            payload,
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
    } catch (error) {
      if (error instanceof AuthorityFenceError) {
        return durableMutationRejection(
          "restore",
          null,
          databasePath,
          payload?.type,
          fenceRun,
        );
      }
      const integrity = authorityIntegrityError(error);
      if (!integrity) throw error;
      return authorityIntegrityRejection("restore", integrity.reason);
    } finally {
      database.close();
    }
    return null;
  }

  const authorityMethods = {
    hostCommand,
    pendingSameBootRecoveryRunIds() {
      return Object.freeze([...sameBootRecoveryRunIds].sort());
    },

    completeSameBootRecovery(runId) {
      sameBootRecoveryRunIds.delete(runId);
    },
    launch(request = {}) {
      const lineage = childLaunchLineage;
      assertOpen();
      if (authoritySchemaCompatibility?.status === "incompatible") {
        return schemaCompatibilityRejection(
          "launch",
          authoritySchemaCompatibility,
          null,
          null,
          request?.prepared?.bundle_digest ?? null,
        );
      }
      if (authoritySchemaCompatibility?.status === "transition_required") {
        return schemaTransitionRequiredRejection(
          "launch",
          databasePath,
          request?.prepared?.bundle_digest ?? null,
        );
      }
      if (!lockDatabase) {
        return durableMutationRejection(
          "launch",
          null,
          databasePath,
          null,
          fenceRun,
        );
      }
      let hostBeforeLaunch;
      try {
        hostBeforeLaunch = durableHostProjectionFromPath(databasePath);
      } catch (error) {
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection("launch", integrity.reason);
      }
      if (hostBeforeLaunch.restore?.active === true) {
        return hostCommandRejection(
          "launch",
          "host_reconciliation_required",
          null,
          hostBeforeLaunch,
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

      const runId = lineage === null
        ? `run:${prepared.bundle_digest.slice("sha256:".length)}`
        : deriveChildRunId(lineage);
      let database = null;
      try {
        database = openAuthorityDatabase(databasePath);
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const existing = readStream(database, runId);
        if (existing) {
          return durableLaunchReceipt(database, existing, false, fenceRun);
        }
        const runOwnership = lineage === null
          ? observeRunOwnership(runOwnershipAdapter, prepared)
          : childRunOwnership(lineage.parent_run_id);
        assertDurableHostRestoreClear(
          database,
          "launch observation is fenced by the host restore barrier",
        );
        if (runOwnership.scope !== "top_level" &&
            prepared.explicit_facts.tracker_binding !== undefined) {
          return durableLaunchRejection(
            "tracker_mutation_not_owned",
            prepared,
            databasePath,
          );
        }
        let consumerBindings;
        try {
          consumerBindings = prepareConsumerHandoffBindings(
            database,
            authorityDirectory,
            gitRetentionAdapter,
            prepared,
            runId,
          );
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          return durableLaunchRejection(
            error.code === "forbidden_latest_resource_selection"
              ? error.code
              : "invalid_resource_handoff_binding",
            prepared,
            databasePath,
          );
        }
        assertDurableHostRestoreClear(
          database,
          "consumer handoff preparation is fenced by the host restore barrier",
        );

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
          assertDurableHostRestoreClear(
            database,
            "launch commit is fenced by the host restore barrier",
          );
          appendAuthorityEvents(database, {
            streamId: runId,
            streamKind: "run",
            events: [
              {
                contract: "flow.run-event/v1",
                payload: {
                  type: "run_launched",
                  prepared,
                  bundle_digest: prepared.bundle_digest,
                  plan_fingerprint: prepared.plan_fingerprint,
                  confirmation_digest: prepared.confirmation_digest,
                  closed_fact_observation_digest: digest(closedFacts),
                  ...(lineage === null ? {} : { lineage }),
                  run_ownership: runOwnership,
                },
              },
              ...prepared.explicit_facts.block_observations.map(
                (observation) => ({
                  contract: "flow.run-event/v1",
                  payload: {
                    type: "card_blocked",
                    card_id: observation.card_id,
                    block: observation.block,
                    observation_digest: observation.evidence_digest,
                  },
                }),
              ),
              ...consumerBindings.map(({ binding }) => ({
                contract: "flow.run-event/v1",
                payload: {
                  type: "resource_handoff_bound",
                  handoff_id: binding.handoff_id,
                  handoff_digest: binding.handoff_digest,
                  binding_digest: digest(binding),
                  operations: binding.operations,
                },
              })),
            ],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          appendConsumerHandoffBindings(database, consumerBindings, {
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
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
        return durableLaunchReceipt(
          database,
          readStream(database, runId),
          true,
          fenceRun,
        );
      } catch (error) {
        if (error instanceof AuthorityFenceError) {
          return durableMutationRejection(
            "launch",
            null,
            databasePath,
            null,
            fenceRun,
            prepared.bundle_digest,
            "host_reconciliation_required",
          );
        }
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection("launch", integrity.reason);
      } finally {
        database?.close();
      }
    },

    launchChild({
      parent_run_id: parentRunId,
      card_id: cardId,
      card_identity: cardIdentity,
      revision_ordinal: revisionOrdinal,
      launch_request: launchRequest,
    }) {
      const lineage = childLineage(
        parentRunId,
        cardId,
        cardIdentity,
        revisionOrdinal,
      );
      const parent = this.query(parentRunId);
      if (parent?.schema !== "flow.run-projection/v1" ||
          parent.phase !== "active" ||
          parent.admission !== "admitted" ||
          parent.current_revision.ordinal !== revisionOrdinal ||
          !parent.subruns.some(({ card_id: linkedCardId,
            card_identity: linkedIdentity,
            revision_ordinal: linkedOrdinal }) =>
            linkedCardId === cardId && linkedIdentity === cardIdentity &&
              linkedOrdinal === revisionOrdinal) ||
          !parent.active_plan.cards.some(({ executor, id }) =>
            id === cardId && executor.kind === "subrun") ||
          digest(parent.active_plan.cards.find(({ id }) => id === cardId)) !==
            cardIdentity ||
          !isDeepStrictEqual(parent.active_plan.cards.find(
            ({ id }) => id === cardId,
          ).inputs.child_launch_request, launchRequest)) {
        return createRejection({
          operation: "launch",
          code: "subrun_not_actionable",
          runId: parentRunId,
          authorityWatermark: parent?.watermark ?? null,
          authorityWatermarkDomain: "run",
          legalActions: parent?.legal_actions ?? [],
        });
      }
      childLaunchLineage = lineage;
      let receipt;
      try {
        receipt = this.launch(launchRequest);
      } finally {
        childLaunchLineage = null;
      }
      if (receipt?.schema !== "flow.launch-receipt/v1") return receipt;
      afterChildLaunchCommit({
        parent_run_id: parentRunId,
        child_run_id: receipt.run_id,
      });
      this.recordSubrunAdmission(lineage);
      return receipt;
    },

    recordSubrunAdmission(lineage) {
      assertOpen();
      const hostBeforeAdmission = durableHostProjectionFromPath(databasePath);
      if (hostBeforeAdmission.restore?.active === true) {
        return hostCommandRejection(
          "subrun_admission",
          "host_reconciliation_required",
          null,
          hostBeforeAdmission,
        );
      }
      if (authoritySchemaCompatibility?.status === "incompatible") {
        return schemaCompatibilityRejection(
          "subrun_admission",
          authoritySchemaCompatibility,
          lineage?.parent_run_id,
        );
      }
      if (authoritySchemaCompatibility?.status === "transition_required") {
        return schemaTransitionRequiredRejection(
          "subrun_admission",
          databasePath,
          null,
          lineage?.parent_run_id,
        );
      }
      if (!lockDatabase) {
        return durableMutationRejection(
          "subrun_admission",
          lineage?.parent_run_id,
          databasePath,
          null,
          fenceRun,
        );
      }
      const childRunId = deriveChildRunId(lineage);
      const parent = this.query(lineage.parent_run_id);
      const child = this.query(childRunId);
      if (!validRecordedSubrunAdmission(parent, child, lineage)) {
        return createRejection({
          operation: "subrun_admission",
          code: "subrun_admission_unproven",
          runId: lineage.parent_run_id,
          authorityWatermark: parent?.watermark ?? null,
          authorityWatermarkDomain: "run",
          legalActions: parent?.legal_actions ?? [],
        });
      }
      const database = openAuthorityDatabase(databasePath);
      try {
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        database.exec("BEGIN IMMEDIATE");
        assertAuthorityEpoch(database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const stream = readStream(database, lineage.parent_run_id);
        if (!stream.records.some(({ payload }) =>
          payload.type === "subrun_admitted" &&
          payload.child_run_id === childRunId)) {
          appendAuthorityEvents(database, {
            streamId: lineage.parent_run_id,
            streamKind: "run",
            events: [{
              contract: "flow.run-event/v1",
              payload: {
                type: "subrun_admitted",
                card_id: lineage.card_id,
                child_run_id: childRunId,
                child_watermark: child.watermark,
              },
            }],
            authorityEpoch,
            bootId,
            processIdentity,
          });
        }
        database.exec("COMMIT");
        const projection = projectFencedRun(
          database,
          readStream(database, lineage.parent_run_id),
          fenceRun,
        );
        for (const watcher of watchers.get(lineage.parent_run_id) ?? []) {
          watcher.publish(projection);
        }
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        if (error instanceof AuthorityFenceError) {
          return durableMutationRejection(
            "subrun_admission",
            lineage.parent_run_id,
            databasePath,
            null,
            fenceRun,
          );
        }
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection(
          "subrun_admission",
          integrity.reason,
          lineage.parent_run_id,
        );
      } finally {
        database.close();
      }
      return this.query(lineage.parent_run_id);
    },

    command(command) {
      assertOpen();
      if (authoritySchemaCompatibility?.status === "incompatible") {
        return schemaCompatibilityRejection(
          "command",
          authoritySchemaCompatibility,
          command?.run_id,
          command?.type,
        );
      }
      if (authoritySchemaCompatibility?.status === "transition_required") {
        if (command?.type !== "recovery" ||
            command?.recovery !== "authority_schema_transition") {
          return schemaTransitionRequiredRejection(
            "command",
            databasePath,
            null,
            command?.run_id,
            command?.type,
          );
        }
        return applySchemaTransitionCommand(command);
      }
      if (!lockDatabase) {
        return durableMutationRejection(
          "command",
          command?.run_id,
          databasePath,
          command?.type,
          fenceRun,
        );
      }
      let hostBeforeCommand;
      try {
        hostBeforeCommand = durableHostProjectionFromPath(databasePath);
      } catch (error) {
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection("command", integrity.reason,
          command?.run_id);
      }
      if (hostBeforeCommand.restore?.active === true) {
        return hostCommandRejection(
          "command",
          "host_reconciliation_required",
          null,
          hostBeforeCommand,
        );
      }
      let database = null;
      try {
        database = openAuthorityDatabase(databasePath);
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
        const fold = fenceRun(database, stream);
        let canonicalCommand;
        let commandDigest;
        try {
          canonicalCommand = canonicalize(command);
          commandDigest = digest(canonicalCommand);
        } catch (error) {
          if (!(error instanceof CanonicalValueError)) throw error;
          return invalidCommandRejection(fold, command);
        }
        const decision = lifecycleKernel(fold, canonicalCommand);
        if (decision.schema === "flow.rejection/v1") {
          return freezeCanonical(decision);
        }
        let committedDecision;
        let cancellationBoundary = null;
        database.exec("BEGIN IMMEDIATE");
        try {
          assertAuthorityEpoch(database, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
          const current = readStream(database, canonicalCommand.run_id);
          const currentFold = fenceRun(database, current);
          const currentDecision = lifecycleKernel(
            currentFold,
            canonicalCommand,
          );
          if (currentDecision.schema === "flow.rejection/v1") {
            database.exec("ROLLBACK");
            return freezeCanonical(currentDecision);
          }
          committedDecision = currentDecision;
          const cancellationEvent = currentDecision.events.find(
            ({ type }) => type === "run_cancelled",
          );
          if (cancellationEvent) {
            cancellationBoundary = freezeCanonical({
              schema: "flow.cancellation-commit-boundary/v1",
              run_id: canonicalCommand.run_id,
              command_digest: commandDigest,
              resource_dispositions: cancellationEvent.resource_dispositions,
            });
          }
          const deferredEvents = currentDecision.events.filter(({ type }) =>
            DEFERRED_EFFECT_EVENT_TYPES.has(type));
          const immediateEvents = currentDecision.events.filter(({ type }) =>
            !DEFERRED_EFFECT_EVENT_TYPES.has(type));
          const effectIntents = currentDecision.effect_intents.map((intent) =>
            bindEffectIntent(intent, {
              authorityEpoch,
              bootId,
              commandDigest,
              decision: currentDecision,
              deferredEvents,
              prepared: current.records[0].payload.prepared,
              runOwnership: currentFold.run_ownership,
              runId: canonicalCommand.run_id,
            }));
          appendAuthorityEvents(database, {
            streamId: canonicalCommand.run_id,
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
          if (effectIntents.length > 0) {
            beforeIntentCommit({
              run_id: canonicalCommand.run_id,
              effect_intents: effectIntents,
            });
          }
          const terminalEvent = currentDecision.events.find(({ type }) =>
            ["run_cancelled", "run_declined", "run_succeeded"].includes(type));
          const terminalCommitsImmediately = terminalEvent?.type ===
              "run_cancelled" || effectIntents.length === 0;
          if (terminalEvent && terminalCommitsImmediately) {
            appendTerminalConsumerHandoffReleases(database, {
              prepared: current.records[0].payload.prepared,
              runId: canonicalCommand.run_id,
              terminalEvent,
            }, {
              authorityEpoch,
              bootId,
              processIdentity,
            });
          }
          if (terminalEvent && terminalCommitsImmediately) {
            appendAuthorityEvents(database, {
              streamId: "host:admission",
              streamKind: "host_admission",
              events: [{
                contract: "flow.host-admission-event/v1",
                payload: {
                  type: "run_capacity_released",
                  run_id: canonicalCommand.run_id,
                },
              }],
              authorityEpoch,
              bootId,
              processIdentity,
            });
          }
          if (cancellationBoundary) {
            beforeCancellationCommit(cancellationBoundary);
          }
          database.exec("COMMIT");
          if (cancellationBoundary) {
            afterCancellationCommit(cancellationBoundary);
          }
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
        const projection = projectFencedRun(database, readStream(
          database,
          canonicalCommand.run_id,
        ), fenceRun);
        for (const watcher of watchers.get(canonicalCommand.run_id) ?? []) {
          watcher.publish(projection);
        }
        const receipt = {
          schema: "flow.command-receipt/v1",
          command_type: canonicalCommand.type,
          run_id: canonicalCommand.run_id,
          authority_watermark: projection.watermark,
          accepted: true,
        };
        const recordedIntents = readRecordedEffectIntents(
          database,
          canonicalCommand.run_id,
          commandDigest,
        );
        const dispatchedIntents = [
          ...recordedIntents,
          ...(committedDecision.recovery_intents ?? []),
        ];
        return freezeCanonical(dispatchedIntents.length === 0
          ? receipt
          : { ...receipt, effect_intents: dispatchedIntents });
      } catch (error) {
        if (error instanceof AuthorityFenceError) {
          return durableMutationRejection(
            "command",
            command?.run_id,
            databasePath,
            command?.type,
            fenceRun,
          );
        }
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection(
          "command",
          integrity.reason,
          command?.run_id,
        );
      } finally {
        database?.close();
      }
    },

    workCommand(command) {
      assertOpen();
      if (authoritySchemaCompatibility?.status !== "compatible" || !lockDatabase) {
        return workRejection("command", "mutation_authority_unavailable", { command });
      }
      let hostBeforeWorkCommand;
      try {
        hostBeforeWorkCommand = durableHostProjectionFromPath(databasePath);
      } catch (error) {
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return workRejection("command", "authority_integrity_failure", {
          command,
        });
      }
      if (hostBeforeWorkCommand.restore?.active === true) {
        return workRejection(
          "command",
          "host_reconciliation_required",
          {
            command,
            current: {
              watermark: hostBeforeWorkCommand.watermark,
              legal_actions: hostBeforeWorkCommand.legal_actions ??
                hostBeforeWorkCommand.restore?.legal_actions ??
                hostBeforeWorkCommand.backup?.legal_actions ?? [],
            },
          },
        );
      }
      const identity = workStreamIdentity(command?.contract, command?.subject_id);
      if (!identity) return workRejection("command", "invalid_command", { command });
      let database = null;
      try {
        database = openAuthorityDatabase(databasePath);
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const currentProjection = readStream(database, identity.streamId)?.fold ?? null;
        if (currentProjection?.schema === "work.workspace-projection/v1" &&
            command.type === "workspace_claim") {
          let observation;
          try {
            observation = gitWorkspaceObservationAdapter.observe({
              repository_id: currentProjection.repository.canonical_id,
              workspace_path: currentProjection.workspace.canonical_path,
              ref: currentProjection.git.ref,
            });
          } catch {
            return workRejection("command", "workspace_git_observation_unavailable", {
              command,
              current: currentProjection,
            });
          }
          assertDurableHostRestoreClear(
            database,
            "workspace Git observation is fenced by the host restore barrier",
          );
          command = freezeCanonical({ ...command, git_observation: observation });
        }
        if (currentProjection?.schema === "work.workspace-projection/v1" &&
            command.disposition === "destructive_reset") {
          let observation;
          try {
            observation = gitWorkspaceObservationAdapter.observe({
              repository_id: currentProjection.repository.canonical_id,
              workspace_path: currentProjection.workspace.canonical_path,
              ref: command.replacement?.git?.ref,
            });
          } catch {
            return workRejection("command", "workspace_git_observation_unavailable", {
              command,
              current: currentProjection,
            });
          }
          assertDurableHostRestoreClear(
            database,
            "workspace Git observation is fenced by the host restore barrier",
          );
          command = freezeCanonical({ ...command, git_observation: observation });
        }
        if (currentProjection?.schema === "work.workspace-projection/v1" &&
            command.type === "workspace_taint_disposition") {
          let validation;
          try {
            validation = workEvidenceAdapter.validate({
              workspace: currentProjection,
              command,
            });
          } catch {
            validation = null;
          }
          assertDurableHostRestoreClear(
            database,
            "work evidence validation is fenced by the host restore barrier",
          );
          command = freezeCanonical({
            ...command,
            evidence_validation: validation,
          });
        }
        if (currentProjection?.schema === "flow.resource-handoff-projection/v1" &&
            command.type === "resource_handoff_disposition") {
          let validation;
          try {
            validation = workEvidenceAdapter.validate({
              handoff: currentProjection,
              command,
            });
          } catch {
            validation = null;
          }
          assertDurableHostRestoreClear(
            database,
            "handoff evidence validation is fenced by the host restore barrier",
          );
          command = freezeCanonical({ ...command, evidence_validation: validation });
        }
        if (currentProjection?.schema === "work.workspace-projection/v1" &&
            (command.type === "workspace_risk_acceptance" ||
             command.disposition === "destructive_reset")) {
          command = freezeCanonical({
            ...command,
            human_authority_validation: validateHumanWorkAuthority(
              database,
              command,
              fenceRun,
            ),
          });
        }
        const structuralDecision = evaluateWorkCommand(database, identity, command);
        if (structuralDecision.schema === "work.rejection/v1") {
          return structuralDecision;
        }
        if (currentProjection === null && command.type === "workspace_register") {
          let observation;
          try {
            observation = gitWorkspaceObservationAdapter.observe({
              repository_id: command.registration?.repository?.canonical_id,
              workspace_path: command.registration?.workspace?.canonical_path,
              ref: command.registration?.git?.ref,
            });
          } catch {
            return workRejection("command", "workspace_git_observation_unavailable", {
              command,
            });
          }
          assertDurableHostRestoreClear(
            database,
            "workspace Git observation is fenced by the host restore barrier",
          );
          if (observation?.schema !== "work.git-observation/v1" ||
              !isDeepStrictEqual(observation.git, command.registration?.git)) {
            return workRejection("command", "workspace_git_facts_mismatch", { command });
          }
          command = freezeCanonical({ ...command, git_observation: observation });
        }
        if (isReviewRecordCommand(command)) {
          const sourceIssue = reviewSourceCommandIssue(database, command);
          if (sourceIssue) {
            return workRejection("command", sourceIssue.code, {
              command,
              current: sourceIssue.projection,
            });
          }
        }
        const decision = evaluateWorkCommand(
          database,
          identity,
          command,
        );
        if (decision.schema === "work.rejection/v1") return decision;
        if (decision.replayed) {
          return workCommandReceipt(command, currentProjection, false);
        }
        if (isReviewRecordCommand(command)) {
          const candidateIssue = reviewCandidateCommandIssue(database, command);
          if (candidateIssue) {
            return workRejection("command", candidateIssue.code, {
              command,
              current: candidateIssue.projection,
            });
          }
          const sourceIssue = reviewSourceCommandIssue(database, command);
          if (sourceIssue) {
            return workRejection("command", sourceIssue.code, {
              command,
              current: sourceIssue.projection,
            });
          }
        }
        let createdArtifactPath = null;
        if (decision.artifactBytes !== undefined) {
          try {
            createdArtifactPath = storeArtifactBytes(
              authorityDirectory,
              command.artifact,
              decision.artifactBytes,
            );
          } catch (error) {
            return workRejection(
              "command",
              error instanceof TypeError
                ? "artifact_bytes_mismatch"
                : error.code === "artifact_bytes_conflict"
                  ? "artifact_bytes_conflict"
                  : "artifact_storage_unavailable",
              { command },
            );
          }
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          assertAuthorityEpoch(database, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
          const committed = evaluateWorkCommand(
            database,
            identity,
            command,
          );
          if (committed.schema === "work.rejection/v1") {
            database.exec("ROLLBACK");
            if (createdArtifactPath) unlinkSync(createdArtifactPath);
            return committed;
          }
          if (committed.replayed) {
            database.exec("ROLLBACK");
            if (createdArtifactPath) unlinkSync(createdArtifactPath);
            return workCommandReceipt(command, currentProjection, false);
          }
          if (isReviewRecordCommand(command)) {
            const candidateIssue = reviewCandidateCommandIssue(database, command);
            if (candidateIssue) {
              database.exec("ROLLBACK");
              if (createdArtifactPath) unlinkSync(createdArtifactPath);
              return workRejection("command", candidateIssue.code, {
                command,
                current: candidateIssue.projection,
              });
            }
            const sourceIssue = reviewSourceCommandIssue(database, command);
            if (sourceIssue) {
              database.exec("ROLLBACK");
              if (createdArtifactPath) unlinkSync(createdArtifactPath);
              return workRejection("command", sourceIssue.code, {
                command,
                current: sourceIssue.projection,
              });
            }
          }
          assertDurableHostRestoreClear(
            database,
            "work mutation is fenced by the host restore barrier",
          );
          appendAuthorityEvents(database, {
            streamId: identity.streamId,
            streamKind: committed.streamKind,
            events: [committed.event],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          if (createdArtifactPath) unlinkSync(createdArtifactPath);
          throw error;
        }
        const projection = queryWorkProjection(
          database,
          authorityDirectory,
          identity,
          gitRetentionAdapter,
        );
        return workCommandReceipt(command, projection, true);
      } catch (error) {
        if (error instanceof AuthorityFenceError) {
          return workRejection(
            "command",
            error.code === "host_reconciliation_required"
              ? "host_reconciliation_required"
              : "mutation_authority_unavailable",
            { command },
          );
        }
        throw error;
      } finally {
        database?.close();
      }
    },

    workQuery(request) {
      assertOpen();
      const identity = workStreamIdentity(request?.contract, request?.subject_id);
      if (!identity || !databaseExists(databasePath)) {
        return workRejection("query", "unknown_subject", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      const database = openAuthorityDatabase(databasePath, { readOnly: true });
      try {
        const stream = readStream(database, identity.streamId);
        if (!stream) {
          return workRejection("query", "unknown_subject", {
            contract: request.contract,
            subjectId: request.subject_id,
          });
        }
        return queryWorkProjection(
          database,
          authorityDirectory,
          identity,
          gitRetentionAdapter,
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
        return fencedHostProjection(freezeCanonical({
          schema: "flow.run-index-projection/v1",
          watermark: EMPTY_WATERMARK,
          runs: [],
        }), null, 0, uninitializedAuthoritySchemaCompatibility());
      }
      let database = null;
      try {
        database = openAuthorityDatabase(databasePath, { readOnly: true });
        const compatibility = readAuthoritySchemaCompatibility(database);
        if (compatibility.status === "incompatible") {
          return runId === undefined
            ? incompatibleHostProjection(compatibility)
            : schemaCompatibilityRejection(
                "query",
                compatibility,
                runId,
              );
        }
        if (runId !== undefined) {
          const stream = readStream(database, runId);
          if (!stream) {
            return durableUnknownRunRejection("query", runId, database);
          }
          const projection = projectFencedRun(database, stream, fenceRun);
          const transitioned = compatibility.status === "transition_required"
            ? transitionRequiredRunProjection(projection, compatibility)
            : projection;
          return projectRunWithHostBarrier(
            transitioned,
            durableHostProjection(database),
          );
        }
        const hostStream = readStream(database, "host:runs");
        const host = hostStream?.fold ?? freezeCanonical({
          schema: "flow.run-index-projection/v1",
          watermark: EMPTY_WATERMARK,
          runs: [],
        });
        const admission = readStream(database, "host:admission")?.fold;
        return fencedHostProjection(
          host,
          admission,
          0,
          readAuthoritySchemaCompatibility(database),
        );
      } catch (error) {
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection("query", integrity.reason, runId);
      } finally {
        database?.close();
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
      if (!lockDatabase) {
        throw new AuthorityFenceError(
          "mutation_authority_unavailable",
          "effect runner does not hold mutation authority",
        );
      }
      const reconciliation = adapter?.reconciliation ?? null;
      const settleCancelled = adapter?.settleCancelled === true;
      if (![null, "adopt_present", "invoke_absent", "settle_absent"].includes(
        reconciliation,
      ) || !["adopt_present", "settle_absent"].includes(reconciliation) &&
          typeof adapter?.invoke !== "function") {
        throw new TypeError("effect adapter must expose invoke");
      }
      const dispatchKey = [
        intent?.run_id,
        intent?.effect_id,
        intent?.idempotency_key,
      ].join("\0");
      if (!readEffectRecoveryState(databasePath, intent).intentRecorded) {
        throw new AuthorityFenceError(
          "unrecorded_effect_intent",
          "effect intent was not durably recorded by RunAuthority",
        );
      }
      while (effectsInFlight.has(dispatchKey)) {
        const inFlight = effectsInFlight.get(dispatchKey);
        const recovery = readEffectRecoveryState(databasePath, intent);
        if (!recovery.recoveryRequested) {
          throw new AuthorityFenceError(
            "effect_dispatch_in_progress",
            "effect intent is already being dispatched by this authority",
          );
        }
        await inFlight.settled;
        const settled = readEffectRecoveryState(databasePath, intent);
        if (settled.receiptRecorded) return settled.receipt;
      }
      const dispatch = deferredEffectDispatch();
      effectsInFlight.set(dispatchKey, dispatch);
      let database = null;
      try {
        database = openAuthorityDatabase(databasePath);
        assertDurableHostRestoreClear(database);
        const stream = typeof intent?.run_id === "string"
          ? readStream(database, intent.run_id)
          : null;
        const recorded = stream?.records.some(({ payload }) =>
          EFFECT_INTENT_EVENT_TYPES.has(payload.type) &&
          isDeepStrictEqual(payload.intent, intent));
        if (!recorded) {
          throw new AuthorityFenceError(
            "unrecorded_effect_intent",
            "effect intent was not durably recorded by RunAuthority",
          );
        }
        assertEffectRunAdmitted(stream, bootId);
        if (settleCancelled &&
            !["delegate", "delegate_cancellation"].includes(intent.effect_kind)) {
          throw new AuthorityFenceError(
            "invalid_cancelled_settlement",
            "cancelled settlement is reserved for delegated resources",
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
        let latestObservation = null;
        let latestObservationIndex = -1;
        let latestInvocationIndex = -1;
        stream.records.forEach(({ payload }, index) => {
          if (payload.type === "effect_observation_recorded" &&
              payload.effect_id === intent.effect_id) {
            latestObservation = payload.observation;
            latestObservationIndex = index;
          } else if (payload.type === "effect_invocation_started" &&
              payload.effect_id === intent.effect_id) {
            latestInvocationIndex = index;
          }
        });
        const observedPresence = validateEffectObservation(
          latestObservation,
          intent,
        );
        const observationIsFresh = latestObservationIndex > latestInvocationIndex;
        if (reconciliation === "adopt_present" &&
            (observedPresence !== "present" || !observationIsFresh)) {
          throw new AuthorityFenceError(
            "effect_presence_not_proven",
            "effect adoption requires exact durable presence evidence",
          );
        }
        if (reconciliation === "invoke_absent" &&
            (intent.classification !== "reconcilable" ||
             observedPresence !== "absent" || !observationIsFresh)) {
          throw new AuthorityFenceError(
            "effect_absence_not_proven",
            "effect reinvocation requires exact durable absence evidence",
          );
        }
        if (reconciliation === "settle_absent" &&
            (observedPresence !== "absent" || !observationIsFresh ||
             stream.fold.phase !== "cancelled")) {
          throw new AuthorityFenceError(
            "effect_absence_not_proven",
            "cancelled effect settlement requires exact durable absence evidence",
          );
        }
        const previouslyInvoked = stream.records.some(({ payload }) =>
          payload.type === "effect_invocation_started" &&
          payload.effect_id === intent.effect_id);
        let effectiveIntent = intent;
        const crossedBootBoundary = intent.authority_boot_id !== bootId;
        const effectPolicy = effectClassPolicy(intent.classification);
        const crossBootRecoveryAllowed = reconciliation === null
          ? effectPolicy?.can_repeat_across_epoch === true
          : ["adopt_present", "invoke_absent", "settle_absent"].includes(
              reconciliation,
            );
        if (crossedBootBoundary && !crossBootRecoveryAllowed) {
          throw new AuthorityFenceError(
            "stale_authority_epoch",
            "effects require exact reconciliation across a host reboot",
          );
        }
        if (crossedBootBoundary || intent.authority_epoch !== authorityEpoch) {
          if (!effectPolicy?.can_repeat_across_epoch &&
              reconciliation === null) {
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
        if (previouslyInvoked &&
            !effectPolicy?.can_repeat_across_epoch &&
            reconciliation === null) {
          throw new AuthorityFenceError(
            "effect_reconciliation_required",
            "effect classification requires reconciliation before repetition",
          );
        }
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        let result;
        if (reconciliation === "settle_absent") {
          result = {
            schema: "flow.effect-receipt/v1",
            effect_id: effectiveIntent.effect_id,
            idempotency_key: effectiveIntent.idempotency_key,
            outcome: "not_created",
            provider_receipt: latestObservation.provider_observation,
          };
        } else if (reconciliation === "adopt_present") {
          result = {
            schema: "flow.effect-receipt/v1",
            effect_id: effectiveIntent.effect_id,
            idempotency_key: effectiveIntent.idempotency_key,
            outcome: "succeeded",
            provider_receipt: latestObservation.provider_observation,
          };
        } else {
          // This must remain the first await in invokeEffect. It lets command()
          // return its intent-commit watermark before invocation-start advances it.
          await Promise.resolve();
          const admissionStream = readStream(database, effectiveIntent.run_id);
          if (settleCancelled && admissionStream.fold.phase !== "cancelled") {
            throw new AuthorityFenceError(
              "cancelled_settlement_not_actionable",
              "delegate cancellation settlement requires cancelled authority",
            );
          }
          if (!settleCancelled && admissionStream.fold.phase !== "active") {
            throw new AuthorityFenceError(
              "attempt_disposed",
              "terminal run authority fenced effect admission",
            );
          }
          assertDurableHostRestoreClear(database);
          if (!settleCancelled ||
              effectiveIntent.effect_kind === "delegate_cancellation") {
            recordEffectInvocationStarted(database, effectiveIntent, {
              authorityDirectory,
              authorityEpoch,
              bootId,
              gitRetentionAdapter,
              gitWorkspaceObservationAdapter,
              processIdentity,
            });
            beforeEffect(effectiveIntent);
            assertDurableHostRestoreClear(
              database,
              "effect admission is fenced by the host restore barrier",
            );
          }
          assertDurableHostRestoreClear(
            database,
            "effect invocation is fenced by the host restore barrier",
          );
          assertMutationFence(lockDatabase, database, {
            authorityEpoch,
            bootId,
            processIdentity,
          });
          assertEffectWorkspaceAuthority(database, effectiveIntent);
          result = await adapter.invoke(effectiveIntent);
        }
        assertDurableHostRestoreClear(
          database,
          "effect receipt publication is fenced by the host restore barrier",
        );
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const publicationRequest = effectiveIntent.operation_input?.publication;
        if (publicationRequest !== undefined) {
          const retentionReceipt = result?.provider_receipt?.git_retention;
          const retentionObservation = gitRetentionAdapter.observe(retentionReceipt);
          if (retentionObservation?.available !== true ||
              retentionObservation.commit_sha !== retentionReceipt?.commit_sha ||
              retentionObservation.tree_sha !== retentionReceipt?.tree_sha ||
              retentionObservation.retention_ref !== retentionReceipt?.retention_ref) {
            throw new TypeError("Git retention was not independently observed");
          }
        }
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
          const effectSucceeded = result?.outcome !== "quarantined";
          let deferredEvents = unresolved.size === 0 && effectSucceeded &&
              current.fold.phase === "active"
            ? pendingDeferredEvents(current, effectiveIntent)
            : [];
          deferredEvents = settleSubrunTerminalEvents(
            deferredEvents,
            effectiveIntent,
            result,
          );
          const publication = effectiveIntent.operation_input?.publication === undefined
            ? null
            : prepareHandoffPublication(
                database,
                authorityDirectory,
                gitRetentionAdapter,
                gitWorkspaceObservationAdapter,
                {
                intent: effectiveIntent,
                publication: effectiveIntent.operation_input.publication,
                receipt: result,
                },
              );
          let reviewCandidateReference = null;
          if (publication !== null) {
            assertDurableHostRestoreClear(
              database,
              "handoff publication observations are fenced by the host restore barrier",
            );
            reviewCandidateReference = appendHandoffPublication(
              database,
              publication,
              {
                authorityEpoch,
                bootId,
                processIdentity,
              },
            );
            beforeHandoffCommit({
              run_id: effectiveIntent.run_id,
              handoff: publication.handoff,
            });
          }
          const cleanup = effectiveIntent.operation_input?.resource_cleanup;
          if (cleanup !== undefined) {
            appendResourceCleanupCompletion(database, effectiveIntent, result, {
              authorityEpoch,
              bootId,
              processIdentity,
            });
          }
          const deferredTerminalEvent = deferredEvents.find(({ type }) =>
            ["run_cancelled", "run_declined", "run_succeeded"].includes(type));
          if (effectSucceeded && deferredTerminalEvent) {
            appendTerminalConsumerHandoffReleases(database, {
              prepared: current.records[0].payload.prepared,
              runId: effectiveIntent.run_id,
              terminalEvent: deferredTerminalEvent,
            }, {
              authorityEpoch,
              bootId,
              processIdentity,
            });
          }
          assertDurableHostRestoreClear(
            database,
            "effect and handoff commit is fenced by the host restore barrier",
          );
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
                  ...(result === undefined ? {} : { receipt: result }),
                },
              },
              ...(publication === null ? [] : [{
                contract: "flow.run-event/v1",
                payload: {
                  type: "resource_handoff_published",
                  handoff_id: publication.handoff.handoff_id,
                  handoff_watermark: queryWorkProjection(
                    database,
                    authorityDirectory,
                    workStreamIdentity(
                      "flow.resource-handoff/v1",
                      publication.handoff.handoff_id,
                    ),
                    gitRetentionAdapter,
                  ).watermark,
                },
              }]),
              ...(reviewCandidateReference === null ? [] : [{
                contract: "flow.run-event/v1",
                payload: {
                  type: "review_candidate_referenced",
                  candidate_id: reviewCandidateReference.candidate_id,
                  candidate_fingerprint: reviewCandidateReference.candidate_fingerprint,
                  review_authority_watermark:
                    reviewCandidateReference.review_authority_watermark,
                },
              }]),
              ...(result?.outcome === "quarantined" ? [{
                contract: "flow.run-event/v1",
                payload: {
                  type: "delegate_output_quarantined",
                  effect_id: effectiveIntent.effect_id,
                  attempt_id: effectiveIntent.attempt_id,
                  card_id: effectiveIntent.card_id,
                  quarantine_record: result.provider_receipt,
                },
              }] : []),
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
        dispatch.resolve();
        return result;
      } catch (error) {
        dispatch.resolve();
        throw error;
      } finally {
        database?.close();
        if (effectsInFlight.get(dispatchKey) === dispatch) {
          effectsInFlight.delete(dispatchKey);
        }
      }
    },

    async recordEffectObservation(intent, observation) {
      assertOpen();
      if (!lockDatabase) {
        throw new AuthorityFenceError(
          "mutation_authority_unavailable",
          "effect observer does not hold mutation authority",
        );
      }
      const database = openAuthorityDatabase(databasePath);
      try {
        assertDurableHostRestoreClear(
          database,
          "effect observations are fenced by the host restore barrier",
        );
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const stream = readStream(database, intent?.run_id);
        const recorded = stream?.records.some(({ payload }) =>
          EFFECT_INTENT_EVENT_TYPES.has(payload.type) &&
          isDeepStrictEqual(payload.intent, intent));
        if (!recorded) {
          throw new AuthorityFenceError(
            "unrecorded_effect_intent",
            "effect observation is not bound to a recorded intent",
          );
        }
        assertEffectRunAdmitted(stream, bootId);
        if (stream.records.some(({ payload }) =>
          payload.type === "effect_receipt_recorded" &&
          payload.effect_id === intent.effect_id)) {
          throw new AuthorityFenceError(
            "effect_already_recorded",
            "effect already has a durable receipt",
          );
        }
        if (!["active", "cancelled"].includes(stream.fold.phase)) {
          throw new AuthorityFenceError(
            "run_terminal",
            "effect observations cannot mutate a settled terminal run",
          );
        }
        const normalizedObservation = normalizeEffectObservation(
          observation,
          intent,
        );
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
                type: "effect_observation_recorded",
                effect_id: intent.effect_id,
                observation: normalizedObservation,
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
        const projection = projectFencedRun(database, readStream(
          database,
          intent.run_id,
        ), fenceRun);
        for (const watcher of watchers.get(intent.run_id) ?? []) {
          watcher.publish(projection);
        }
        return normalizedObservation;
      } finally {
        database.close();
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
  };

  function assertOpen() {
    if (closed) throw new Error("durable run authority is closed");
  }

  function applySchemaTransitionCommand(command) {
    if (!lockDatabase) {
      return durableMutationRejection(
        "command",
        null,
        databasePath,
        command?.type,
        fenceRun,
      );
    }
    const database = openAuthorityDatabase(databasePath);
    try {
      const before = durableHostProjection(database);
      const expectedCommand = before.legal_actions[0];
      if (!isDeepStrictEqual(command, expectedCommand)) {
        return createRejection({
          operation: "command",
          code: "stale_authority_schema_transition",
          reason: "schema transition command differs from current authority",
          commandType: typeof command?.type === "string" ? command.type : null,
          runId: stringOrNull(command?.run_id),
          authorityWatermark: before.watermark,
          authorityWatermarkDomain: "host",
          legalActions: before.legal_actions,
        });
      }
      authoritySchemaCompatibility = transitionAuthoritySchema(database, {
        afterCommit: afterSchemaTransitionCommit,
        beforeCommit: beforeSchemaTransitionCommit,
        expectedWatermark: authoritySchemaCompatibility.watermark,
      });
      if (authoritySchemaCompatibility.status !== "compatible") {
        return schemaTransitionRequiredRejection("command", databasePath);
      }
      // Version-one stores predate registered effect intents, so this
      // transition-time epoch acquisition has no same-boot recovery snapshot.
      authorityEpoch = acquireAuthorityEpoch(database, {
        bootId,
        declaredCapacity,
        processIdentity,
      });
      const after = durableHostProjection(database);
      return freezeCanonical({
        schema: "flow.command-receipt/v1",
        command_type: "recovery",
        run_id: null,
        authority_watermark: after.watermark,
        accepted: true,
      });
    } finally {
      database.close();
    }
  }

  const workCommand = authorityMethods.workCommand;
  const workQuery = authorityMethods.workQuery;
  const workspaceAuthority = Object.freeze({
    schema: "work.workspace-authority/v1",
    command(command) {
      if (![
        "work.workspace-register-command/v1",
        "work.workspace-claim-command/v1",
        "work.workspace-claim-release-command/v1",
        "work.workspace-taint-command/v1",
        "work.workspace-taint-disposition-command/v1",
        "work.workspace-risk-acceptance-command/v1",
      ]
        .includes(command?.schema) ||
          command.contract !== "work.workspace/v1") {
        return workRejection("command", "invalid_workspace_command", { command });
      }
      return workCommand(command);
    },
    query(request) {
      if (request?.contract !== "work.workspace/v1") {
        return workRejection("query", "invalid_workspace_query", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      return workQuery(request);
    },
    previewCleanup(request) {
      const projection = this.query(request);
      if (projection?.schema !== "work.workspace-projection/v1") {
        return projection;
      }
      let observation;
      try {
        observation = gitWorkspaceObservationAdapter.observe({
          repository_id: projection.repository.canonical_id,
          workspace_path: projection.workspace.canonical_path,
          ref: projection.git.ref,
        });
      } catch {
        return workRejection("cleanup_preview", "workspace_git_observation_unavailable", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      return buildWorkspaceCleanupPreview(projection, observation);
    },
  });
  const artifactAuthority = Object.freeze({
    schema: "work.artifact-authority/v1",
    command(command) {
      if (command?.schema !== "work.artifact-record-command/v1" ||
          command.contract !== "work.artifact/v1") {
        return workRejection("command", "invalid_artifact_command", { command });
      }
      return workCommand(command);
    },
    query(request) {
      if (request?.contract !== "work.artifact/v1") {
        return workRejection("query", "invalid_artifact_query", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      return workQuery(request);
    },
    previewCollection(request) {
      const projection = this.query(request);
      return projection?.schema === "work.artifact-projection/v1"
        ? buildArtifactCollectionPreview(projection)
        : projection;
    },
  });
  const reviewAuthority = Object.freeze({
    schema: "work.review-authority/v1",
    command(command) {
      if (![
        "work.review-candidate-seal-command/v1",
        "work.review-record-command/v1",
      ].includes(command?.schema) ||
          command.contract !== "work.review/v1") {
        return workRejection("command", "invalid_review_command", { command });
      }
      if (command.schema === "work.review-record-command/v1") {
        return workCommand(command);
      }
      return workRejection(
        "command",
        "review_candidate_seal_requires_run_authority",
        { command },
      );
    },
    query(request) {
      if (request?.contract !== "work.review/v1") {
        return workRejection("query", "invalid_review_query", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      return workQuery(request);
    },
    watch(request) {
      return createOneShotWatcher(workQuery({
        contract: "work.review/v1",
        subject_id: request?.subject_id,
      }));
    },
  });
  const handoffAuthority = Object.freeze({
    schema: "flow.resource-handoff-authority/v1",
    command(command) {
      if (command?.schema !== "flow.resource-handoff-disposition-command/v1" ||
          command.contract !== "flow.resource-handoff/v1") {
        return workRejection("command", "invalid_handoff_command", { command });
      }
      return workCommand(command);
    },
    query(request) {
      if (request?.contract !== "flow.resource-handoff/v1") {
        return workRejection("query", "invalid_handoff_query", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      return workQuery(request);
    },
    previewCleanup(request) {
      const projection = this.query(request);
      return projection?.schema === "flow.resource-handoff-projection/v1"
        ? buildHandoffCleanupPreview(projection)
        : projection;
    },
  });
  delete authorityMethods.workCommand;
  delete authorityMethods.workQuery;
  const runAuthority = Object.freeze(authorityMethods);
  attachRunEffectIntentReader(runAuthority, Object.freeze({
    schema: "flow.run-effect-intent-reader/v1",
    query(runId, effectId) {
      assertOpen();
      if (!databaseExists(databasePath)) return null;
      const database = openAuthorityDatabase(databasePath, { readOnly: true });
      try {
        const effect = readStream(database, runId)?.fold?.effects
          ?.find(({ effect_id: id }) => id === effectId) ?? null;
        return effect === null ? null : freezeCanonical(effect);
      } finally {
        database.close();
      }
    },
  }));
  attachWorkAuthorities(runAuthority, Object.freeze({
    workspace: workspaceAuthority,
    artifact: artifactAuthority,
    review: reviewAuthority,
    handoff: handoffAuthority,
  }));
  return runAuthority;
}

function openAuthorityDatabase(databasePath, { readOnly = false } = {}) {
  let database = null;
  try {
    database = createDatabase(databasePath, { readOnly });
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
    if (!readOnly) {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    }
    return database;
  } catch (error) {
    database?.close();
    throw authorityIntegrityError(error) ?? error;
  }
}

function deferredEffectDispatch() {
  let resolve;
  const settled = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { settled, resolve };
}

function readEffectRecoveryState(databasePath, intent) {
  const database = openAuthorityDatabase(databasePath, { readOnly: true });
  try {
    const stream = typeof intent?.run_id === "string"
      ? readStream(database, intent.run_id)
      : null;
    const intentRecorded = Boolean(stream?.records.some(({ payload }) =>
      EFFECT_INTENT_EVENT_TYPES.has(payload.type) &&
      isDeepStrictEqual(payload.intent, intent)));
    const recoveryRequested = Boolean(stream?.records.some(({ payload }) =>
      payload.type === "effect_recovery_requested" &&
      payload.effect_id === intent.effect_id));
    const receiptEvent = stream?.records.find(({ payload }) =>
      payload.type === "effect_receipt_recorded" &&
      payload.effect_id === intent.effect_id);
    return {
      intentRecorded,
      recoveryRequested,
      receiptRecorded: receiptEvent !== undefined,
      receipt: receiptEvent?.payload?.receipt,
    };
  } finally {
    database.close();
  }
}

function queryWorkProjection(
  database,
  authorityDirectory,
  identity,
  gitRetentionAdapter,
) {
  const projection = readStream(database, identity.streamId).fold;
  if (projection.schema === "work.artifact-projection/v1") {
    return withArtifactAvailability(
      projection,
      artifactBytesAvailable(authorityDirectory, projection) ? "available" : "missing",
    );
  }
  if (projection.schema !== "flow.resource-handoff-projection/v1") {
    return projection;
  }
  const workspaceIdentity = workStreamIdentity(
    "work.workspace/v1",
    projection.associated_workspace.subject_id,
  );
  const workspace = readStream(database, workspaceIdentity.streamId)?.fold ?? null;
  const artifacts = projection.artifacts.map(({ digest: artifactDigest }) => {
    const artifactIdentity = workStreamIdentity("work.artifact/v1", artifactDigest);
    const stream = readStream(database, artifactIdentity.streamId);
    return stream
      ? queryWorkProjection(
          database,
          authorityDirectory,
          artifactIdentity,
          gitRetentionAdapter,
        )
      : null;
  });
  const consumerObservations = projection.legal_actions.map((action) => {
    const consumerStream = readStream(database, action.consumer_run_id);
    if (!consumerStream) {
      return { run_id: action.consumer_run_id, watermark: null, actionable: false };
    }
    const consumer = projectRun({
      authorityEventStreamDigest: consumerStream.authorityEventStreamDigest,
      fold: consumerStream.fold,
      events: runEventsFromRecords(consumerStream.records),
    });
    const operationCardIds = consumer.legal_actions
      .filter(({ type }) => type === "operation_execute")
      .filter(({ card_id: cardId }) => {
        const card = consumer.active_plan.cards.find(({ id }) => id === cardId);
        const request = card?.inputs?.resource_handoff;
        return request?.handoff_id === projection.handoff_id &&
          request.handoff_digest === projection.handoff_digest &&
          action.operations.includes(request.operation);
      })
      .map(({ card_id: cardId }) => cardId)
      .sort();
    return {
      run_id: action.consumer_run_id,
      watermark: consumer.watermark,
      actionable: operationCardIds.length > 0,
      operation_card_ids: operationCardIds,
    };
  });
  const actionableRuns = new Set(consumerObservations
    .filter(({ actionable }) => actionable)
    .map(({ run_id: runId }) => runId));
  const currentProjection = {
    ...projection,
    legal_actions: projection.legal_actions.filter(({ consumer_run_id: runId }) =>
      actionableRuns.has(runId)),
  };
  return withHandoffObservations(
    currentProjection,
    workspace,
    artifacts,
    gitRetentionAdapter.observe(projection.git_retention),
    consumerObservations,
  );
}

function workCommandReceipt(command, projection, created) {
  return freezeCanonical({
    schema: "work.command-receipt/v1",
    command_type: command.type,
    contract: command.contract,
    subject_id: command.subject_id,
    authority_watermark: projection.watermark,
    accepted: true,
    created,
  });
}

function evaluateWorkCommand(database, identity, command) {
  const current = readStream(database, identity.streamId)?.fold ?? null;
  return decideWorkCommand(current, command);
}

function isReviewRecordCommand(command) {
  return command?.schema === "work.review-record-command/v1" &&
    command.type === "review_record" && command.contract === "work.review/v1";
}

function reviewCandidateCommandIssue(database, command) {
  const candidateIdentity = workStreamIdentity(
    "work.review/v1",
    command.candidate?.candidate_id,
  );
  const candidateProjection = candidateIdentity
    ? readStream(database, candidateIdentity.streamId)?.fold ?? null
    : null;
  return reviewRecordCandidateAuthorityIssue(command, candidateProjection);
}

function reviewSourceCommandIssue(database, command) {
  const stream = typeof command?.source_run_id === "string"
    ? readStream(database, command.source_run_id)
    : null;
  const issue = reviewRecordSourceAuthorityIssue(command, stream?.fold ?? null);
  return issue ? { ...issue, projection: stream?.fold ?? null } : null;
}

function prepareHandoffPublication(
  database,
  authorityDirectory,
  gitRetentionAdapter,
  gitWorkspaceObservationAdapter,
  {
  intent,
  publication,
  receipt,
  },
) {
  const authority = handoffPublicationAuthorityContext(
    database,
    authorityDirectory,
    gitRetentionAdapter,
    gitWorkspaceObservationAdapter,
    intent,
    publication,
  );
  return buildHandoffPublication({
    ...authority,
    intent,
    publication,
    receipt,
  });
}

function handoffPublicationAuthorityContext(
  database,
  authorityDirectory,
  gitRetentionAdapter,
  gitWorkspaceObservationAdapter,
  intent,
  publication,
) {
  const workspaceIdentity = workStreamIdentity(
    "work.workspace/v1",
    publication?.workspace?.subject_id,
  );
  if (!workspaceIdentity) {
    throw new TypeError("resource handoff publication has no workspace identity");
  }
  const workspaceStream = readStream(database, workspaceIdentity.streamId);
  const gitObservation = gitWorkspaceObservationAdapter.observe({
    repository_id: workspaceStream?.fold?.repository?.canonical_id,
    workspace_path: workspaceStream?.fold?.workspace?.canonical_path,
    ref: publication?.workspace?.promoted_git?.ref,
  });
  const artifacts = (publication.artifacts ?? []).map(({ digest: artifactDigest }) => {
    const identity = workStreamIdentity("work.artifact/v1", artifactDigest);
    if (!identity) return null;
    const stream = readStream(database, identity.streamId);
    return stream
      ? queryWorkProjection(
          database,
          authorityDirectory,
          identity,
          gitRetentionAdapter,
        )
      : null;
  });
  const authority = {
    artifacts,
    intent,
    publication,
    workspace: workspaceStream?.fold ?? null,
    gitObservation,
  };
  validateHandoffPublicationAuthority(authority);
  return authority;
}

function resourceCleanupAuthorityContext(
  database,
  authorityDirectory,
  gitRetentionAdapter,
  gitWorkspaceObservationAdapter,
  intent,
) {
  const request = intent?.operation_input?.resource_cleanup;
  if (request?.schema !== "flow.resource-cleanup-request/v1") {
    throw new TypeError("resource cleanup request is invalid");
  }
  const identity = workStreamIdentity(request.contract, request.subject_id);
  if (!identity || !["workspace", "artifact", "handoff"].includes(identity.streamKind) ||
      !readStream(database, identity.streamId)) {
    throw new TypeError("resource cleanup subject is unavailable");
  }
  const projection = queryWorkProjection(
    database,
    authorityDirectory,
    identity,
    gitRetentionAdapter,
  );
  const preview = identity.streamKind === "workspace"
    ? buildWorkspaceCleanupPreview(
        projection,
        gitWorkspaceObservationAdapter.observe({
          repository_id: projection.repository.canonical_id,
          workspace_path: projection.workspace.canonical_path,
          ref: projection.git.ref,
        }),
      )
    : identity.streamKind === "artifact"
      ? buildArtifactCollectionPreview(projection)
      : buildHandoffCleanupPreview(projection);
  const action = preview.legal_actions[0];
  const sameInFlightEffect = identity.streamKind === "workspace"
    ? projection.taint?.reason === "resource_cleanup_in_flight" &&
      projection.taint.source_effect_id === intent.effect_id
    : identity.streamKind === "artifact"
      ? projection.status === "uncertain" &&
        projection.collection_effect_id === intent.effect_id
      : projection.status === "uncertain" &&
        projection.cleanup_effect_id === intent.effect_id;
  if (!sameInFlightEffect && (preview.eligibility !== "eligible" ||
      !isDeepStrictEqual(action?.operation_input?.resource_cleanup, request))) {
    throw new TypeError("resource cleanup authority is stale or unsafe");
  }
  return { identity, preview };
}

function appendResourceCleanupCompletion(database, intent, receipt, fence) {
  const request = intent.operation_input.resource_cleanup;
  const providerReceipt = receipt?.provider_receipt?.resource_cleanup;
  if (receipt?.outcome !== "succeeded" ||
      providerReceipt?.schema !== "flow.resource-cleanup-receipt/v1" ||
      providerReceipt.outcome !== "removed" ||
      !isDeepStrictEqual(providerReceipt.request, request)) {
    throw new TypeError("resource cleanup receipt does not match its request");
  }
  const identity = workStreamIdentity(request.contract, request.subject_id);
  const current = readStream(database, identity.streamId)?.fold;
  if (identity.streamKind === "workspace" &&
      (current?.taint?.reason !== "resource_cleanup_in_flight" ||
       current.taint.source_effect_id !== intent.effect_id ||
       current.taint.evidence_digest !== digest(intent))) {
    throw new TypeError("workspace cleanup authority changed after invocation");
  }
  if (identity.streamKind === "artifact" &&
      (current?.status !== "uncertain" ||
       current.collection_effect_id !== intent.effect_id ||
       current.pins.length > 0)) {
    throw new TypeError("artifact cleanup authority changed after invocation");
  }
  if (identity.streamKind === "handoff" &&
      (current?.status !== "uncertain" ||
       current.cleanup_effect_id !== intent.effect_id ||
       current.consumer_pins.length > 0)) {
    throw new TypeError("handoff cleanup authority changed after invocation");
  }
  if (identity.streamKind === "handoff") {
    for (const artifact of current.artifacts) {
      const artifactIdentity = workStreamIdentity("work.artifact/v1", artifact.digest);
      appendAuthorityEvents(database, {
        streamId: artifactIdentity.streamId,
        streamKind: artifactIdentity.streamKind,
        events: [{
          contract: "work.artifact-event/v1",
          payload: {
            type: "artifact_pins_transferred",
            remove: [{ holder: "handoff", id: current.handoff_id }],
            add: [],
          },
        }],
        ...fence,
      });
    }
    const workspaceIdentity = workStreamIdentity(
      "work.workspace/v1",
      current.associated_workspace.subject_id,
    );
    appendAuthorityEvents(database, {
      streamId: workspaceIdentity.streamId,
      streamKind: workspaceIdentity.streamKind,
      events: [{
        contract: "work.workspace-event/v1",
        payload: {
          type: "workspace_handoff_retention_released",
          expected_generation: current.associated_workspace.generation,
          expected_fingerprint: digest({ git: current.associated_workspace.git }),
        },
      }],
      ...fence,
    });
  }
  appendAuthorityEvents(database, {
    streamId: identity.streamId,
    streamKind: identity.streamKind,
    events: [{
      contract: identity.streamKind === "workspace"
        ? "work.workspace-event/v1"
        : identity.streamKind === "artifact"
          ? "work.artifact-event/v1"
          : "flow.resource-handoff-event/v1",
      payload: identity.streamKind === "workspace"
        ? {
            type: "workspace_cleaned",
            cleanup_receipt: providerReceipt,
          }
        : identity.streamKind === "artifact" ? {
            type: "artifact_collected",
            cleanup_receipt: providerReceipt,
          } : {
            type: "resource_handoff_cleaned",
            cleanup_receipt: providerReceipt,
          },
    }],
    ...fence,
  });
}

function appendHandoffPublication(database, publication, fence) {
  let reviewCandidateReference = null;
  if (publication.reviewEvent !== null) {
    const reviewIdentity = workStreamIdentity(
      "work.review/v1",
      publication.reviewEvent.payload.candidate.candidate_id,
    );
    if (!reviewIdentity || readStream(database, reviewIdentity.streamId)) {
      throw new Error("review candidate identity is already active");
    }
    appendAuthorityEvents(database, {
      streamId: reviewIdentity.streamId,
      streamKind: reviewIdentity.streamKind,
      events: [publication.reviewEvent],
      ...fence,
    });
    const reviewStream = readStream(database, reviewIdentity.streamId);
    reviewCandidateReference = {
      candidate_id: publication.reviewEvent.payload.candidate.candidate_id,
      candidate_fingerprint:
        publication.reviewEvent.payload.candidate.candidate_fingerprint,
      review_authority_watermark: reviewStream.fold.watermark,
    };
  }
  const workspaceIdentity = workStreamIdentity(
    "work.workspace/v1",
    publication.handoff.associated_workspace.subject_id,
  );
  appendAuthorityEvents(database, {
    streamId: workspaceIdentity.streamId,
    streamKind: workspaceIdentity.streamKind,
    events: [publication.workspaceEvent],
    ...fence,
  });
  publication.handoff.artifacts.forEach((artifact, index) => {
    const identity = workStreamIdentity("work.artifact/v1", artifact.digest);
    appendAuthorityEvents(database, {
      streamId: identity.streamId,
      streamKind: identity.streamKind,
      events: [publication.artifactEvents[index]],
      ...fence,
    });
  });
  const handoffIdentity = workStreamIdentity(
    "flow.resource-handoff/v1",
    publication.handoff.handoff_id,
  );
  if (readStream(database, handoffIdentity.streamId)) {
    throw new Error("resource handoff identity is already active");
  }
  appendAuthorityEvents(database, {
    streamId: handoffIdentity.streamId,
    streamKind: handoffIdentity.streamKind,
    events: [publication.handoffEvent],
    ...fence,
  });
  return reviewCandidateReference;
}

function prepareConsumerHandoffBindings(
  database,
  authorityDirectory,
  gitRetentionAdapter,
  prepared,
  runId,
) {
  if (prepared.explicit_facts.resource_claims.some((claim) =>
    claim?.kind === "resource_handoff" && claim.id === "latest")) {
    const error = new TypeError("latest resource handoff selection is forbidden");
    error.code = "forbidden_latest_resource_selection";
    throw error;
  }
  const claimsByHandoff = new Map();
  for (const claim of prepared.explicit_facts.resource_claims
    .filter(({ kind }) => kind === "resource_handoff")) {
    const existing = claimsByHandoff.get(claim.id);
    if (existing && existing.digest !== claim.digest) {
      throw new TypeError("prepared consumer handoff claims disagree on identity");
    }
    claimsByHandoff.set(claim.id, {
      ...claim,
      operations: [...new Set([
        ...(existing?.operations ?? []),
        ...claim.operations,
      ])].sort(),
    });
  }
  return [...claimsByHandoff.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((claim) => {
      const cardOperations = [...new Set(prepared.graph.cards.flatMap((card) =>
        (card.resource_claims ?? [])
          .filter((cardClaim) =>
            cardClaim.kind === "resource_handoff" && cardClaim.id === claim.id &&
            cardClaim.digest === claim.digest)
          .flatMap((cardClaim) => cardClaim.operations ?? [])))].sort();
      const requestedOperations = [...new Set(prepared.graph.cards
        .map((card) => card.inputs?.resource_handoff)
        .filter((request) => request?.handoff_id === claim.id &&
          request.handoff_digest === claim.digest)
        .map((request) => request.operation))].sort();
      if (!isDeepStrictEqual(cardOperations, claim.operations) ||
          requestedOperations.some((operation) =>
            !cardOperations.includes(operation))) {
        throw new TypeError("consumer handoff claims exceed exact card authority");
      }
      const identity = workStreamIdentity("flow.resource-handoff/v1", claim.id);
      if (!identity || !readStream(database, identity.streamId)) {
        throw new TypeError("prepared consumer handoff does not exist");
      }
      const handoff = queryWorkProjection(
        database,
        authorityDirectory,
        identity,
        gitRetentionAdapter,
      );
      return {
        ...buildConsumerHandoffBinding({ handoff, claim, runId }),
        handoff,
      };
    });
}

function appendConsumerHandoffBindings(database, bindings, fence) {
  for (const binding of bindings) {
    const handoffIdentity = workStreamIdentity(
      "flow.resource-handoff/v1",
      binding.handoff.handoff_id,
    );
    appendAuthorityEvents(database, {
      streamId: handoffIdentity.streamId,
      streamKind: handoffIdentity.streamKind,
      events: [binding.handoffEvent],
      ...fence,
    });
    if (binding.workspaceEvent !== null) {
      const workspaceIdentity = workStreamIdentity(
        "work.workspace/v1",
        binding.handoff.associated_workspace.subject_id,
      );
      const workspace = readStream(database, workspaceIdentity.streamId)?.fold;
      if (workspace?.claims.length > 0) {
        throw new TypeError("consumer mutation workspace is already claimed");
      }
      appendAuthorityEvents(database, {
        streamId: workspaceIdentity.streamId,
        streamKind: workspaceIdentity.streamKind,
        events: [binding.workspaceEvent],
        ...fence,
      });
    }
    binding.handoff.artifacts.forEach((artifact, index) => {
      const artifactIdentity = workStreamIdentity("work.artifact/v1", artifact.digest);
      appendAuthorityEvents(database, {
        streamId: artifactIdentity.streamId,
        streamKind: artifactIdentity.streamKind,
        events: [binding.artifactEvents[index]],
        ...fence,
      });
    });
  }
}

function appendConsumerHandoffRelease(database, {
  effectId = null,
  handoffId,
  runId: holderRunId,
}, fence) {
  const handoffIdentity = workStreamIdentity(
    "flow.resource-handoff/v1",
    handoffId,
  );
  const handoff = readStream(database, handoffIdentity.streamId)?.fold;
  const pin = handoff?.consumer_pins.find(({ run_id: runId }) =>
    runId === holderRunId);
  if (!pin) return;
  appendAuthorityEvents(database, {
    streamId: handoffIdentity.streamId,
    streamKind: handoffIdentity.streamKind,
    events: [{
      contract: "flow.resource-handoff-event/v1",
      payload: {
        type: "resource_handoff_consumer_released",
        consumer_run_id: holderRunId,
        effect_id: effectId,
      },
    }],
    ...fence,
  });
  for (const artifact of handoff.artifacts) {
    const artifactIdentity = workStreamIdentity("work.artifact/v1", artifact.digest);
    appendAuthorityEvents(database, {
      streamId: artifactIdentity.streamId,
      streamKind: artifactIdentity.streamKind,
      events: [{
        contract: "work.artifact-event/v1",
        payload: {
          type: "artifact_pins_transferred",
          remove: [{ holder: "run", id: holderRunId }],
          add: [],
        },
      }],
      ...fence,
    });
  }
  if (handoff.mutation_claim?.holder === holderRunId) {
    const workspaceIdentity = workStreamIdentity(
      "work.workspace/v1",
      handoff.associated_workspace.subject_id,
    );
    appendAuthorityEvents(database, {
      streamId: workspaceIdentity.streamId,
      streamKind: workspaceIdentity.streamKind,
      events: [{
        contract: "work.workspace-event/v1",
        payload: {
          type: "workspace_claim_released",
          claim_id: handoff.mutation_claim.claim_id,
          holder: holderRunId,
        },
      }],
      ...fence,
    });
  }
}

function appendTerminalConsumerHandoffReleases(database, {
  prepared,
  runId,
  terminalEvent,
}, fence) {
  const releasableHandoffIds = terminalEvent.type === "run_cancelled"
    ? terminalEvent.resource_dispositions
      .filter(({ claim }) => claim.kind === "resource_handoff")
      .reduce((releasable, { claim, disposition }) => {
        const existing = releasable.get(claim.id) ?? true;
        releasable.set(claim.id, existing && disposition === "released");
        return releasable;
      }, new Map())
    : new Map(prepared.explicit_facts.resource_claims
      .filter(({ kind }) => kind === "resource_handoff")
      .map(({ id }) => [id, true]));
  const handoffIds = [...releasableHandoffIds.entries()]
    .filter(([, releasable]) => releasable)
    .map(([handoffId]) => handoffId);
  for (const handoffId of handoffIds) {
    appendConsumerHandoffRelease(database, { handoffId, runId }, fence);
  }
}

function storeArtifactBytes(authorityDirectory, artifact, encodedBytes) {
  const bytes = Buffer.from(encodedBytes, "base64");
  if (bytes.toString("base64") !== encodedBytes || bytes.length !== artifact.size ||
      byteDigest(bytes) !== artifact.digest) {
    throw new TypeError("artifact bytes do not match immutable artifact identity");
  }
  const directory = join(authorityDirectory, "artifacts");
  const path = join(directory, artifact.digest.slice("sha256:".length));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (!existing.equals(bytes)) {
      const error = new Error("artifact digest already names different retained bytes");
      error.code = "artifact_bytes_conflict";
      throw error;
    }
    return null;
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}

function artifactBytesAvailable(authorityDirectory, artifact) {
  const path = join(
    authorityDirectory,
    "artifacts",
    artifact.digest.slice("sha256:".length),
  );
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return bytes.length === artifact.size && byteDigest(bytes) === artifact.digest;
}

function byteDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
    if (database.isTransaction) database.exec("ROLLBACK");
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

function assertEffectWorkspaceAuthority(database, intent) {
  const workspaceClaims = (intent?.resource_claims ?? [])
    .filter(({ kind }) => kind === "workspace");
  const fullClaims = workspaceClaims.filter((claim) =>
    typeof claim.id === "string" && claim.id.length > 0 &&
    Number.isSafeInteger(claim.generation) && claim.generation >= 1 &&
    Number.isSafeInteger(claim.mutation_epoch) && claim.mutation_epoch >= 0 &&
    typeof claim.fingerprint === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(claim.fingerprint));
  if (fullClaims.length === 0) return;
  if (fullClaims.length !== workspaceClaims.length) {
    throw new AuthorityFenceError(
      "workspace_claim_incomplete",
      "effect mixes exact and partial workspace claims",
    );
  }
  for (const claim of fullClaims) {
    const identity = workStreamIdentity("work.workspace/v1", claim.id);
    const projection = identity
      ? readStream(database, identity.streamId)?.fold ?? null
      : null;
    const issue = workspaceEffectAuthorityIssue(projection, claim, intent);
    if (issue !== null) {
      throw new AuthorityFenceError(
        issue,
        "effect workspace authority changed before Adapter invocation",
      );
    }
  }
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
  commandDigest,
  decision,
  deferredEvents,
  prepared,
  runOwnership,
  runId,
}) {
  const facts = prepared.explicit_facts;
  const resourceClaims = intent?.resource_claims;
  if (intent?.schema !== "flow.effect-intent/v1" ||
      typeof intent.effect_id !== "string" || intent.effect_id.length === 0 ||
      typeof intent.idempotency_key !== "string" ||
      intent.idempotency_key.length === 0 ||
      typeof intent.attempt_id !== "string" || intent.attempt_id.length === 0 ||
      !effectClassPolicy(intent.classification) ||
      typeof intent.operation_contract !== "string" ||
      intent.operation_contract.length === 0 ||
      !Array.isArray(resourceClaims) ||
      !resourceClaims.every((claim) => facts.resource_claims.some(
        (declared) => digest(declared) === digest(claim),
      )) ||
      !(intent.route_binding === null ||
        (typeof intent.route_binding === "object" &&
          !Array.isArray(intent.route_binding)))) {
    throw new TypeError(
      "lifecycle decisions must emit identified, idempotent effect intents",
    );
  }
  return freezeCanonical({
    ...intent,
    run_id: runId,
    decision_digest: digest(decision),
    command_digest: commandDigest,
    deferred_events: deferredEvents,
    authority_epoch: authorityEpoch,
    authority_boot_id: bootId,
    catalog_fingerprint: facts.catalog_fingerprint,
    route_snapshot: facts.route_snapshot,
    capability_envelopes: facts.capability_envelopes,
    operation_contracts: facts.operation_contracts,
    validator_contracts: facts.validator_contracts,
    ...(facts.tracker_binding === undefined ? {} : {
      tracker_binding: facts.tracker_binding,
      run_ownership: runOwnership,
    }),
    resource_claims: resourceClaims,
    time_facts: facts.time_facts,
    subject_generations: facts.subject_generations,
  });
}

export function createTopLevelRunOwnershipAdapter() {
  return Object.freeze({ observe: topLevelRunOwnership });
}

function topLevelRunOwnership() {
  return {
    schema: "flow.run-ownership/v1",
    scope: "top_level",
    parent_run_id: null,
  };
}

function childRunOwnership(parentRunId) {
  return freezeCanonical({
    schema: "flow.run-ownership/v1",
    scope: "child",
    parent_run_id: parentRunId,
  });
}

function observeRunOwnership(adapter, prepared) {
  const ownership = adapter.observe({ prepared });
  if (ownership?.schema !== "flow.run-ownership/v1" ||
      !["top_level", "child"].includes(ownership.scope) ||
      (ownership.scope === "top_level" && ownership.parent_run_id !== null) ||
      (ownership.scope === "child" &&
        (typeof ownership.parent_run_id !== "string" ||
         ownership.parent_run_id.length === 0)) ||
      Object.keys(ownership).length !== 3) {
    throw new TypeError("run ownership Adapter returned an invalid observation");
  }
  return freezeCanonical(ownership);
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

function recordEffectInvocationStarted(database, intent, {
  authorityDirectory,
  authorityEpoch,
  bootId,
  gitRetentionAdapter,
  gitWorkspaceObservationAdapter,
  processIdentity,
}) {
  const publication = intent.operation_input?.publication;
  let publicationAuthority = null;
  if (publication !== undefined) {
    publicationAuthority = handoffPublicationAuthorityContext(
      database,
      authorityDirectory,
      gitRetentionAdapter,
      gitWorkspaceObservationAdapter,
      intent,
      publication,
    );
  }
  let cleanupAuthority = null;
  if (intent.operation_input?.resource_cleanup !== undefined) {
    cleanupAuthority = resourceCleanupAuthorityContext(
      database,
      authorityDirectory,
      gitRetentionAdapter,
      gitWorkspaceObservationAdapter,
      intent,
    );
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    assertAuthorityEpoch(database, {
      authorityEpoch,
      bootId,
      processIdentity,
    });
    assertDurableHostRestoreClear(database);
    if (publicationAuthority !== null) {
      const identity = workStreamIdentity(
        "work.workspace/v1",
        publicationAuthority.workspace.subject_id,
      );
      appendAuthorityEvents(database, {
        streamId: identity.streamId,
        streamKind: identity.streamKind,
        events: [{
          contract: "work.workspace-event/v1",
          payload: {
            type: "workspace_tainted",
            taint: {
              reason: "handoff_publication_in_flight",
              evidence_digest: digest(intent),
              source_effect_id: intent.effect_id,
            },
          },
        }],
        authorityEpoch,
        bootId,
        processIdentity,
      });
    }
    if (cleanupAuthority !== null) {
      appendAuthorityEvents(database, {
        streamId: cleanupAuthority.identity.streamId,
        streamKind: cleanupAuthority.identity.streamKind,
        events: [{
          contract: cleanupAuthority.identity.streamKind === "workspace"
            ? "work.workspace-event/v1"
            : cleanupAuthority.identity.streamKind === "artifact"
              ? "work.artifact-event/v1"
              : "flow.resource-handoff-event/v1",
          payload: cleanupAuthority.identity.streamKind === "workspace"
            ? {
                type: "workspace_tainted",
                taint: {
                  reason: "resource_cleanup_in_flight",
                  evidence_digest: digest(intent),
                  source_effect_id: intent.effect_id,
                },
              }
            : cleanupAuthority.identity.streamKind === "artifact" ? {
                type: "artifact_collection_started",
                effect_id: intent.effect_id,
                evidence_digest: digest(intent),
              } : {
                type: "resource_handoff_cleanup_started",
                effect_id: intent.effect_id,
                evidence_digest: digest(intent),
              },
        }],
        authorityEpoch,
        bootId,
        processIdentity,
      });
    }
    const handoffRequest = intent.operation_input?.resource_handoff;
    if (handoffRequest !== undefined) {
      const handoffIdentity = workStreamIdentity(
        "flow.resource-handoff/v1",
        handoffRequest.handoff_id,
      );
      if (!handoffIdentity || !readStream(database, handoffIdentity.streamId)) {
        throw new TypeError("consumer mutation handoff is unavailable");
      }
      const handoff = queryWorkProjection(
        database,
        authorityDirectory,
        handoffIdentity,
        gitRetentionAdapter,
      );
      const authorization = buildConsumerMutationAuthorization({
        handoff,
        intent,
      });
      appendAuthorityEvents(database, {
        streamId: handoffIdentity.streamId,
        streamKind: handoffIdentity.streamKind,
        events: [{
          contract: "flow.resource-handoff-event/v1",
          payload: { type: "consumer_handoff_rechecked", authorization },
        }],
        authorityEpoch,
        bootId,
        processIdentity,
      });
    }
    appendAuthorityEvents(database, {
      streamId: intent.run_id,
      streamKind: "run",
      events: [{
        contract: "flow.run-event/v1",
        payload: {
          type: "effect_invocation_started",
          effect_id: intent.effect_id,
          authority_epoch: authorityEpoch,
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
}

function readRecordedEffectIntents(database, runId, commandDigest) {
  return readStream(database, runId).records
    .filter(({ payload }) =>
      payload.type === "effect_intent_recorded" &&
      payload.intent.command_digest === commandDigest)
    .map(({ payload }) => payload.intent);
}

function pendingDeferredEvents(stream, settlingIntent) {
  const events = [];
  const seen = new Set();
  const successfulEffects = new Set(stream.records
    .filter(({ payload }) => payload.type === "effect_receipt_recorded" &&
      payload.receipt?.outcome !== "quarantined")
    .map(({ payload }) => payload.effect_id));
  successfulEffects.add(settlingIntent.effect_id);
  for (const { payload } of stream.records) {
    if (!EFFECT_INTENT_EVENT_TYPES.has(payload.type) ||
        !successfulEffects.has(payload.intent.effect_id)) continue;
    for (const event of payload.intent.deferred_events) {
      const eventDigest = digest(event);
      if (seen.has(eventDigest)) continue;
      seen.add(eventDigest);
      events.push(event);
    }
  }
  return events;
}

function settleSubrunTerminalEvents(events, intent, receipt) {
  if (intent.operation_contract !== "flow.subrun/create-and-observe/v1" ||
      receipt?.provider_receipt?.child_phase === "succeeded" ||
      events.length === 0) {
    return events;
  }
  return [
    ...events.filter(({ type }) =>
      !["operation_completed", "run_succeeded"].includes(type)),
    {
      type: "subrun_failed",
      card_id: intent.card_id,
      attempt_id: intent.attempt_id,
      child_run_id: receipt.provider_receipt.child_run_id,
      child_phase: receipt.provider_receipt.child_phase,
    },
    { type: "run_declined" },
  ];
}

function unresolvedEffectIds(stream) {
  const unresolved = new Set(stream.records
    .filter(({ payload }) => EFFECT_INTENT_EVENT_TYPES.has(payload.type))
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

function invalidCommandRejection(fold, command) {
  return createRejection({
    operation: "command",
    code: "invalid_command",
    commandType: typeof command?.type === "string" ? command.type : null,
    runId: typeof command?.run_id === "string" ? command.run_id : null,
    bundleDigest: fold.bundle_digest,
    authorityWatermark: fold.watermark,
    authorityWatermarkDomain: "run",
    legalActions: fold.legal_actions,
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
  const hostRestoreBarrier = admission?.restore?.active === true;
  if (!admission) throw new Error("authority admission stream is missing");
  const suspendedAfterReboot = stream.fold.phase === "active" &&
    !hasCurrentBootAdmission(stream, admission.boot_id);
  const revalidation = suspendedAfterReboot
    ? rebootRevalidation(stream, rebootObservationAdapter, admission.boot_id)
    : null;
  const watermark = digest({
    schema: "flow.fenced-run-watermark/v1",
    stream_watermark: stream.fold.watermark,
    stream_generation: stream.generation,
    authority_epoch: admission.authority_epoch,
    authority_boot_id: admission.boot_id,
  });
  const legalActions = hostRestoreBarrier
    ? []
    : suspendedAfterReboot
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
  const trackerProgress = stream.fold.tracker_progress;
  const trackerEffectIds = new Set(stream.fold.effects
    .filter(({ card_id: cardId }) =>
      cardId === trackerProgress?.operation_card_id)
    .map(({ effect_id: effectId }) => effectId));
  return freezeCanonical({
    ...stream.fold,
    watermark,
    admission: hostRestoreBarrier
      ? "suspended_host_reconciliation"
      : suspendedAfterReboot
      ? "suspended_after_reboot"
      : stream.fold.phase === "active" ? "admitted" : "released",
    authority_epoch: admission.authority_epoch,
    authority_boot_id: admission.boot_id,
    stream_generation: stream.generation,
    ...(revalidation === null ? {} : { reboot_revalidation: revalidation }),
    legal_actions: legalActions,
    ...(trackerProgress === undefined ? {} : {
      tracker_progress: {
        ...trackerProgress,
        authority_watermark: watermark,
        legal_next_actions: legalActions.filter((action) =>
          action.card_id === trackerProgress.operation_card_id ||
          trackerEffectIds.has(action.effect_id)),
      },
    }),
  });
}

function assertEffectRunAdmitted(stream, currentBootId) {
  if (stream.fold.phase === "active" &&
      !hasCurrentBootAdmission(stream, currentBootId)) {
    throw new AuthorityFenceError(
      "run_requires_reboot_admission",
      "effect authority requires explicit admission after reboot",
    );
  }
}

function hasCurrentBootAdmission(stream, currentBootId) {
  const crossedBootBoundary = stream.records.some(({ boot_id: recordBootId }) =>
    recordBootId !== currentBootId);
  return !crossedBootBoundary || stream.records.some(({ boot_id: recordBootId,
    payload }) => recordBootId === currentBootId &&
    payload.type === "run_admitted_after_reboot");
}

function projectFencedRun(database, stream, fenceRun) {
  return projectRun({
    authorityEventStreamDigest: stream.authorityEventStreamDigest,
    fold: fenceRun(database, stream),
    events: runEventsFromRecords(stream.records),
  });
}

function rebootRevalidation(stream, adapter, currentBootId) {
  const prepared = stream.records[0].payload.prepared;
  const currentFacts = {
    resource_claims: stream.fold.resource_claims,
    limits: stream.fold.limits,
    elapsed_seconds: stream.fold.elapsed_seconds,
  };
  const receipts = new Set(stream.records
    .filter(({ payload }) => payload.type === "effect_receipt_recorded")
    .map(({ payload }) => payload.effect_id));
  const reconstruction = reconstructRebootEffects(stream);
  return buildRebootRevalidation({
    adapter,
    currentBootId,
    currentFacts,
    prepared,
    unresolvedEffects: reconstruction.effects.filter((intent) =>
      intent !== null && typeof intent === "object" &&
      !receipts.has(intent.effect_id)),
    unresolvedEffectsValid: reconstruction.valid,
  });
}

function reconstructRebootEffects(stream) {
  const effects = new Map();
  let valid = true;
  for (const { payload } of stream.records) {
    if (!EFFECT_INTENT_EVENT_TYPES.has(payload.type)) continue;
    const intent = payload.intent;
    const existing = effects.get(intent?.effect_id);
    if (existing && !sameEffectIntentIdentity(existing.intent, intent)) {
      valid = false;
    }
    if (!existing || payload.type === "effect_intent_adopted" ||
        existing.type !== "effect_intent_adopted") {
      effects.set(intent?.effect_id, { type: payload.type, intent });
    }
  }
  return { effects: [...effects.values()].map(({ intent }) => intent), valid };
}

function sameEffectIntentIdentity(left, right) {
  try {
    return digest(effectIntentIdentity(left)) === digest(effectIntentIdentity(right));
  } catch {
    return false;
  }
}

function effectIntentIdentity(intent) {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
    return null;
  }
  const {
    authority_epoch: _authorityEpoch,
    authority_boot_id: _authorityBootId,
    ...identity
  } = intent;
  return identity;
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
  fallbackBundleDigest = null,
  rejectionCode = "mutation_authority_unavailable",
) {
  let authorityWatermark = EMPTY_WATERMARK;
  let legalActions = [];
  let bundleDigest = fallbackBundleDigest;
  if (databaseExists(databasePath)) {
    let database = null;
    try {
      database = openAuthorityDatabase(databasePath, { readOnly: true });
      const stream = runId ? readStream(database, runId) : null;
      const host = durableHostProjection(database);
      const runFold = stream ? fenceRun(database, stream) : null;
      authorityWatermark = runFold?.watermark ?? host.watermark ??
        EMPTY_WATERMARK;
      legalActions = runFold?.legal_actions ?? [];
      if (!runId) legalActions = host.legal_actions ?? [];
      bundleDigest = runFold?.bundle_digest ?? null;
    } catch (error) {
      const integrity = authorityIntegrityError(error);
      if (!integrity) throw error;
      return authorityIntegrityRejection(operation, integrity.reason, runId);
    } finally {
      database?.close();
    }
  }
  return createRejection({
    operation,
    code: rejectionCode,
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
    let database = null;
    try {
      database = openAuthorityDatabase(databasePath, { readOnly: true });
      authorityWatermark = durableHostProjection(database).watermark;
    } catch (error) {
      const integrity = authorityIntegrityError(error);
      if (!integrity) throw error;
      return authorityIntegrityRejection("launch", integrity.reason);
    } finally {
      database?.close();
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
  const authoritySchema = readAuthoritySchemaCompatibility(database);
  if (authoritySchema.status === "incompatible") {
    return incompatibleHostProjection(authoritySchema);
  }
  const host = readStream(database, "host:runs")?.fold ?? freezeCanonical({
    schema: "flow.run-index-projection/v1",
    watermark: EMPTY_WATERMARK,
    runs: [],
  });
  const admission = readStream(database, "host:admission")?.fold ?? null;
  return fencedHostProjection(
    host,
    admission,
    admission?.declared_capacity ?? 0,
    authoritySchema,
  );
}

function assertDurableHostRestoreClear(
  database,
  message = "external effects are fenced by the host restore barrier",
) {
  if (durableHostProjection(database).restore?.active === true) {
    throw new AuthorityFenceError("host_reconciliation_required", message);
  }
}

function durableHostProjectionFromPath(databasePath) {
  if (!databaseExists(databasePath)) {
    return freezeCanonical({
      schema: "flow.run-index-projection/v1",
      watermark: EMPTY_WATERMARK,
      runs: [],
    });
  }
  const database = openAuthorityDatabase(databasePath, { readOnly: true });
  try {
    return durableHostProjection(database);
  } finally {
    database.close();
  }
}

function durableUnresolvedRunEffects(database) {
  const runIds = readStream(database, "host:runs")?.fold?.runs ?? [];
  return runIds.flatMap((runId) => {
    const effects = readStream(database, runId)?.fold?.effects ?? [];
    return effects
      .filter(({ receipt, status }) => receipt === null &&
        !["abandoned", "not_created", "quarantined"].includes(status))
      .map(({ effect_id: effectId, status }) => ({
        run_id: runId,
        effect_id: effectId,
        status,
      }));
  });
}

function incompatibleHostProjection(authoritySchema) {
  const watermark = digest({
    schema: "flow.fenced-host-watermark/v1",
    run_index_watermark: null,
    admission_watermark: null,
    authority_schema_watermark: authoritySchema.watermark,
  });
  return freezeCanonical({
    schema: "flow.run-index-projection/v1",
    watermark,
    runs: [],
    authority_epoch: 0,
    authority_boot_id: null,
    admission: { active_runs: 0, declared_capacity: 0 },
    authority_schema: authoritySchema,
    legal_actions: [],
  });
}

function transitionRequiredRunProjection(projection, authoritySchema) {
  const watermark = digest({
    schema: "flow.transition-required-run-watermark/v1",
    run_watermark: projection.watermark,
    authority_schema_watermark: authoritySchema.watermark,
  });
  const views = Object.fromEntries(Object.entries(projection.views).map(
    ([name, view]) => [name, {
      ...view,
      authority_watermark: watermark,
      legal_actions: [],
    }],
  ));
  return freezeCanonical({
    ...projection,
    watermark,
    legal_actions: [],
    views,
  });
}

function schemaCompatibilityRejection(
  operation,
  compatibility,
  runId = null,
  commandType = null,
  bundleDigest = null,
) {
  return createRejection({
    operation,
    code: "authority_schema_incompatible",
    reason: "authority store contract or schema version is incompatible",
    commandType: commandType ?? null,
    runId: runId ?? null,
    bundleDigest: bundleDigest ?? null,
    authorityWatermark: incompatibleHostProjection(compatibility).watermark,
    authorityWatermarkDomain: "host",
  });
}

function fencedHostProjection(host, admission, fallbackCapacity, authoritySchema) {
  const watermark = digest({
    schema: "flow.fenced-host-watermark/v1",
    run_index_watermark: host.watermark,
    admission_watermark: admission?.watermark ?? EMPTY_WATERMARK,
    authority_schema_watermark: authoritySchema.watermark,
  });
  const recovery = projectHostRecovery({
    backup: admission?.backup ?? initialBackupProjection(),
    restore: admission?.restore ?? initialRestoreBarrier(),
  }, watermark);
  return freezeCanonical({
    ...host,
    watermark,
    authority_epoch: admission?.authority_epoch ?? 0,
    authority_boot_id: admission?.boot_id ?? null,
    admission: {
      active_runs: admission?.active_runs.length ?? 0,
      declared_capacity: admission?.declared_capacity ?? fallbackCapacity,
    },
    authority_schema: authoritySchema,
    ...recovery,
    legal_actions: authoritySchema.status === "transition_required"
      ? [{
          schema: "flow.command/v1",
          type: "recovery",
          recovery: "authority_schema_transition",
          from_version: authoritySchema.version,
          to_version: CURRENT_AUTHORITY_SCHEMA_VERSION,
          transition_release: AUTHORITY_SCHEMA_RELEASE,
          expected_watermark: watermark,
        }]
      : admission?.restore?.active === true
      ? recovery.restore.legal_actions
      : recovery.legal_actions,
  });
}

function schemaTransitionRequiredRejection(
  operation,
  databasePath,
  bundleDigest = null,
  runId = null,
  commandType = null,
) {
  const database = openAuthorityDatabase(databasePath, { readOnly: true });
  try {
    const host = durableHostProjection(database);
    return createRejection({
      operation,
      code: "authority_schema_transition_required",
      reason: "authority schema must transition before mutation",
      bundleDigest,
      runId: stringOrNull(runId),
      commandType: stringOrNull(commandType),
      authorityWatermark: host.watermark,
      authorityWatermarkDomain: "host",
      legalActions: host.legal_actions,
    });
  } finally {
    database.close();
  }
}

function databaseExists(databasePath) {
  return existsSync(databasePath);
}

function childLineage(parentRunId, cardId, cardIdentity, revisionOrdinal) {
  if (typeof parentRunId !== "string" || !parentRunId ||
      typeof cardId !== "string" || !cardId ||
      !/^sha256:[0-9a-f]{64}$/.test(cardIdentity ?? "") ||
      !Number.isInteger(revisionOrdinal) || revisionOrdinal < 0) {
    throw new TypeError("child run lineage is incomplete");
  }
  return freezeCanonical({
    schema: "flow.child-run-lineage/v1",
    parent_run_id: parentRunId,
    card_id: cardId,
    card_identity: cardIdentity,
    revision_ordinal: revisionOrdinal,
  });
}

function validChildLaunchParent(parent, lineage, launchRequest) {
  if (!parent) return false;
  const fold = foldRun(parent);
  return fold.phase === "active" &&
    fold.current_revision.ordinal === lineage.revision_ordinal &&
    fold.active_plan.cards.some(({ executor, id }) =>
      id === lineage.card_id && executor.kind === "subrun") &&
    digest(fold.active_plan.cards.find(({ id }) => id === lineage.card_id)) ===
      lineage.card_identity &&
    isDeepStrictEqual(fold.active_plan.cards.find(
      ({ id }) => id === lineage.card_id,
    ).inputs.child_launch_request, launchRequest) &&
    fold.subruns.some(({ card_id: cardId, card_identity: cardIdentity,
      revision_ordinal: revisionOrdinal }) =>
      cardId === lineage.card_id && cardIdentity === lineage.card_identity &&
        revisionOrdinal === lineage.revision_ordinal);
}

function validRecordedSubrunAdmission(parentRun, childRun, lineage) {
  if (!parentRun || !childRun) return false;
  const parent = parentRun.schema === "flow.run-projection/v1"
    ? parentRun
    : projectInMemoryRun(parentRun);
  const recordedLineage = childRun.schema === "flow.run-projection/v1"
    ? childRun.parent
    : childRun.lineage;
  const childRunId = deriveChildRunId(lineage);
  return ["active", "cancelled"].includes(parent.phase) &&
    parent.admission !== "suspended_after_reboot" &&
    recordedLineage?.schema === "flow.child-run-lineage/v1" &&
    recordedLineage.parent_run_id === lineage.parent_run_id &&
    recordedLineage.card_id === lineage.card_id &&
    recordedLineage.card_identity === lineage.card_identity &&
    recordedLineage.revision_ordinal === lineage.revision_ordinal &&
    (childRun.run_id === childRunId) &&
    parent.subruns.some(({ card_id: cardId, card_identity: cardIdentity,
      revision_ordinal: revisionOrdinal, child_run_id: linkedChildId }) =>
      cardId === lineage.card_id && cardIdentity === lineage.card_identity &&
      revisionOrdinal === lineage.revision_ordinal &&
      linkedChildId === childRunId);
}

function projectInMemoryRun(run) {
  return projectRun({
    authorityEventStreamDigest: runWatermark(run),
    fold: foldRun(run),
    events: run.events,
  });
}

function projectRunWithHostBarrier(projection, hostProjection) {
  if (hostProjection?.restore?.active !== true) return projection;
  const marker = freezeCanonical({
    schema: "flow.host-reconciliation-marker/v1",
    admission: "required",
    state: hostProjection.restore.state,
    active: true,
    watermark: hostProjection.watermark,
    legal_actions: hostProjection.legal_actions ??
      hostProjection.restore.legal_actions ?? [],
  });
  const views = Object.fromEntries(Object.entries(projection.views).map(
    ([name, view]) => [name, {
      ...view,
      host_reconciliation: marker,
      legal_actions: [],
    }],
  ));
  return freezeCanonical({
    ...projection,
    host_reconciliation: marker,
    legal_actions: [],
    ...(projection.tracker_progress === undefined ? {} : {
      tracker_progress: {
        ...projection.tracker_progress,
        host_reconciliation: marker,
        legal_next_actions: [],
      },
    }),
    views,
  });
}

function authorityIntegrityError(error) {
  if (error instanceof AuthorityIntegrityError) return error;
  if (error?.code !== "ERR_SQLITE_ERROR") return null;
  return new AuthorityIntegrityError(
    error.errcode === 26 ? "corrupt_store" : "store_unavailable",
    error.message,
  );
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
    commandType: stringOrNull(commandType),
    runId: stringOrNull(runId),
    authorityWatermark: authorityWatermark(authorityEvents),
    authorityWatermarkDomain: "host",
  });
}

function launchRejection(code, prepared, authorityEvents, reason = null) {
  return createRejection({
    operation: "launch",
    code,
    reason,
    bundleDigest: stringOrNull(prepared?.bundle_digest),
    authorityWatermark: authorityWatermark(authorityEvents),
    authorityWatermarkDomain: "host",
  });
}

function hostCommandRejection(operation, code, reason, hostProjection) {
  return createRejection({
    operation,
    code,
    reason,
    authorityWatermark: hostProjection?.watermark ?? EMPTY_WATERMARK,
    authorityWatermarkDomain: "host",
    legalActions: hostProjection?.legal_actions ??
      hostProjection?.restore?.legal_actions ??
      hostProjection?.backup?.legal_actions ?? [],
  });
}

function validateHumanWorkAuthority(database, command, fenceRun) {
  const authority = command.human_authority;
  const binding = buildHumanAuthorityBinding(
    command,
    command.type === "workspace_risk_acceptance"
      ? "risk_acceptance"
      : "destructive_reset",
  );
  if (authority?.schema !== "work.human-authority/v1" ||
      authority.binding_digest !== digest(binding) ||
      typeof authority.run_id !== "string" ||
      typeof authority.checkpoint_id !== "string") {
    return null;
  }
  const stream = readStream(database, authority.run_id);
  const checkpoint = stream?.fold?.active_plan?.cards.find(({ id }) =>
    id === authority.checkpoint_id);
  const approved = stream?.records.some(({ payload }) =>
    payload.type === "checkpoint_decided" &&
    payload.checkpoint_id === authority.checkpoint_id &&
    payload.decision === "approve");
  const valid = stream?.fold?.phase === "succeeded" && approved === true &&
    fenceRun(database, stream).watermark === authority.run_watermark &&
    isDeepStrictEqual(checkpoint?.inputs?.human_authority, binding);
  return freezeCanonical({
    schema: "work.human-authority-validation/v1",
    valid,
    binding_digest: digest(binding),
    authority_digest: digest(authority),
    run_id: authority.run_id,
    checkpoint_id: authority.checkpoint_id,
    run_watermark: authority.run_watermark,
  });
}

function createFailClosedWorkEvidenceAdapter() {
  return Object.freeze({
    validate() {
      return freezeCanonical({
        schema: "work.taint-disposition-validation/v1",
        valid: false,
        subject_id: null,
        taint_evidence_digest: null,
        disposition: null,
        evidence_digest: null,
      });
    },
  });
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}
function authorityWatermark(events) {
  if (events.length === 0) return EMPTY_WATERMARK;
  return digest({
    schema: "flow.host-run-authority-stream/v1",
    events,
  });
}

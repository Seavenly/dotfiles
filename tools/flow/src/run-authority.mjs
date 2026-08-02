import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
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
import {
  AUTHORITY_SCHEMA_RELEASE,
  CURRENT_AUTHORITY_SCHEMA_VERSION,
  initializeAuthoritySchema as initializeStoreSchema,
  readAuthoritySchemaCompatibility,
  transitionAuthoritySchema,
  uninitializedAuthoritySchemaCompatibility,
} from "./authority-schema.mjs";
import { TRACKER_PROGRESS_CONTRACT } from "./github-tracker-progress.mjs";

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
            run_ownership: topLevelRunOwnership(),
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
  afterCancellationCommit = () => {},
  authorityDirectory,
  access = "mutate",
  afterSchemaTransitionCommit = () => {},
  beforeEffect = () => {},
  beforeIntentCommit = () => {},
  beforeSchemaTransitionCommit = () => {},
  declaredCapacity = 4,
  hostIdentityAdapter = createHostAuthorityIdentityAdapter(),
  lifecycleKernel = decideLifecycle,
  beforeCancellationCommit = () => {},
  rebootObservationAdapter = createFailClosedRebootObservationAdapter(),
  runOwnershipAdapter = createTopLevelRunOwnershipAdapter(),
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
  let authoritySchemaCompatibility = null;
  let sameBootRecoveryRunIds = new Set();
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

  return Object.freeze({
    pendingSameBootRecoveryRunIds() {
      return Object.freeze([...sameBootRecoveryRunIds].sort());
    },

    completeSameBootRecovery(runId) {
      sameBootRecoveryRunIds.delete(runId);
    },

    launch(request = {}) {
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
        const runOwnership = observeRunOwnership(runOwnershipAdapter, prepared);
        if (runOwnership.scope !== "top_level" && prepared.graph.cards.some(
          ({ executor }) => executor.contract === TRACKER_PROGRESS_CONTRACT,
        )) {
          return durableLaunchRejection(
            "tracker_mutation_not_owned",
            prepared,
            databasePath,
          );
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
            ],
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
          );
        }
        const integrity = authorityIntegrityError(error);
        if (!integrity) throw error;
        return authorityIntegrityRejection("launch", integrity.reason);
      } finally {
        database?.close();
      }
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
            ["operation_completed", "run_declined", "run_succeeded"].includes(type));
          const immediateEvents = currentDecision.events.filter(({ type }) =>
            !["operation_completed", "run_declined", "run_succeeded"].includes(type));
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
          if (effectIntents.length === 0 && currentDecision.events.some(({ type }) =>
            ["run_cancelled", "run_declined", "run_succeeded"].includes(type))) {
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
        const projection = projectRun(fenceRun(
          database,
          readStream(database, canonicalCommand.run_id),
        ));
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
          const projection = projectRun(fenceRun(database, stream));
          return compatibility.status === "transition_required"
            ? transitionRequiredRunProjection(projection, compatibility)
            : projection;
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
      if (![null, "adopt_present", "invoke_absent"].includes(reconciliation) ||
          reconciliation !== "adopt_present" &&
          typeof adapter?.invoke !== "function") {
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
        const previouslyInvoked = stream.records.some(({ payload }) =>
          payload.type === "effect_invocation_started" &&
          payload.effect_id === intent.effect_id);
        let effectiveIntent = intent;
        if (intent.authority_boot_id !== bootId) {
          throw new AuthorityFenceError(
            "stale_authority_epoch",
            "effects cannot be adopted across a host reboot",
          );
        }
        if (intent.authority_epoch !== authorityEpoch) {
          if (!effectClassPolicy(intent.classification)?.can_repeat_across_epoch &&
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
            !effectClassPolicy(intent.classification)?.can_repeat_across_epoch &&
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
        if (reconciliation === "adopt_present") {
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
          if (admissionStream.fold.phase !== "active") {
            throw new AuthorityFenceError(
              "attempt_disposed",
              "terminal run authority fenced effect admission",
            );
          }
          recordEffectInvocationStarted(database, effectiveIntent, {
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
          result = await adapter.invoke(effectiveIntent);
        }
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
          const deferredEvents = unresolved.size === 0 &&
              current.fold.phase === "active"
            ? pendingDeferredEvents(current)
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
                  ...(result === undefined ? {} : { receipt: result }),
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
        assertMutationFence(lockDatabase, database, {
          authorityEpoch,
          bootId,
          processIdentity,
        });
        const stream = readStream(database, intent?.run_id);
        const recorded = stream?.records.some(({ payload }) =>
          ["effect_intent_recorded", "effect_intent_adopted"].includes(
            payload.type,
          ) && isDeepStrictEqual(payload.intent, intent));
        if (!recorded) {
          throw new AuthorityFenceError(
            "unrecorded_effect_intent",
            "effect observation is not bound to a recorded intent",
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
        const projection = projectRun(fenceRun(
          database,
          readStream(database, intent.run_id),
        ));
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
  });

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
    time_facts: [],
    subject_generations: [],
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
  authorityEpoch,
  bootId,
  processIdentity,
}) {
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

function pendingDeferredEvents(stream) {
  // One operation currently bounds this to one settlement flush. Filter events
  // already in the stream before the future multi-operation slice removes it.
  const events = [];
  const seen = new Set();
  for (const { payload } of stream.records) {
    if (!["effect_intent_recorded", "effect_intent_adopted"].includes(
      payload.type,
    )) continue;
    for (const event of payload.intent.deferred_events) {
      const eventDigest = digest(event);
      if (seen.has(eventDigest)) continue;
      seen.add(eventDigest);
      events.push(event);
    }
  }
  return events;
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
  const trackerProgress = stream.fold.tracker_progress;
  const trackerEffectIds = new Set(stream.fold.effects
    .filter(({ card_id: cardId }) =>
      cardId === trackerProgress?.operation_card_id)
    .map(({ effect_id: effectId }) => effectId));
  return freezeCanonical({
    ...stream.fold,
    watermark,
    admission: suspendedAfterReboot ? "suspended_after_reboot" : "admitted",
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
  fallbackBundleDigest = null,
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
  return freezeCanonical({
    ...projection,
    watermark,
    legal_actions: [],
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
      : [],
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

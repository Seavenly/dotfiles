import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import {
  attachWorkAuthorities,
  buildConsumerHandoffBinding,
  buildConsumerMutationAuthorization,
  buildHandoffPublication,
  decideWorkCommand,
  withHandoffObservations,
  withArtifactAvailability,
  workRejection,
  workStreamIdentity,
} from "./work-authority.mjs";

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
  authorityDirectory,
  access = "mutate",
  afterSchemaTransitionCommit = () => {},
  beforeEffect = () => {},
  beforeHandoffCommit = () => {},
  beforeIntentCommit = () => {},
  beforeSchemaTransitionCommit = () => {},
  declaredCapacity = 4,
  gitRetentionAdapter = createFailClosedGitRetentionAdapter(),
  gitWorkspaceObservationAdapter = createFailClosedGitWorkspaceObservationAdapter(),
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

  const authorityMethods = {
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
        let consumerBindings;
        try {
          consumerBindings = prepareConsumerHandoffBindings(
            database,
            authorityDirectory,
            gitRetentionAdapter,
            prepared,
            runId,
          );
        } catch {
          return durableLaunchRejection(
            "invalid_resource_handoff_binding",
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
            ["run_declined", "run_succeeded"].includes(type))) {
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
          database.exec("COMMIT");
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

    workCommand(command) {
      assertOpen();
      if (authoritySchemaCompatibility?.status !== "compatible" || !lockDatabase) {
        return workRejection("command", "mutation_authority_unavailable", { command });
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
          if (observation?.schema !== "work.git-observation/v1" ||
              !isDeepStrictEqual(observation.git, command.registration?.git)) {
            return workRejection("command", "workspace_git_facts_mismatch", { command });
          }
          command = freezeCanonical({ ...command, git_observation: observation });
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
        if (decision.artifactBytes !== undefined) {
          storeArtifactBytes(
            authorityDirectory,
            command.artifact,
            decision.artifactBytes,
          );
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
            return committed;
          }
          appendAuthorityEvents(database, {
            streamId: identity.streamId,
            streamKind: committed.streamKind,
            events: [committed.event],
            authorityEpoch,
            bootId,
            processIdentity,
          });
          for (const [index, artifactEvent] of
            (committed.artifactEvents ?? []).entries()) {
            const artifact = queryWorkProjection(
              database,
              authorityDirectory,
              identity,
              gitRetentionAdapter,
            ).artifacts[index];
            const artifactIdentity = workStreamIdentity(
              "work.artifact/v1",
              artifact.digest,
            );
            appendAuthorityEvents(database, {
              streamId: artifactIdentity.streamId,
              streamKind: artifactIdentity.streamKind,
              events: [artifactEvent],
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
        const projection = queryWorkProjection(
          database,
          authorityDirectory,
          identity,
          gitRetentionAdapter,
        );
        return workCommandReceipt(command, projection, true);
      } catch (error) {
        if (error instanceof AuthorityFenceError) {
          return workRejection("command", "mutation_authority_unavailable", { command });
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
          recordEffectInvocationStarted(database, effectiveIntent, {
            authorityDirectory,
            authorityEpoch,
            bootId,
            gitRetentionAdapter,
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
          const deferredEvents = unresolved.size === 0
            ? pendingDeferredEvents(current)
            : [];
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
          if (publication !== null) {
            appendHandoffPublication(database, publication, {
              authorityEpoch,
              bootId,
              processIdentity,
            });
            beforeHandoffCommit({
              run_id: effectiveIntent.run_id,
              handoff: publication.handoff,
            });
          }
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
        if (stream.fold.phase !== "active") {
          // Receipts currently settle every effect before terminal transition.
          // Retain this invariant fence in case later terminal paths diverge.
          throw new AuthorityFenceError(
            "run_terminal",
            "effect observations cannot mutate a terminal run",
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
      if (command?.schema !== "work.workspace-register-command/v1" ||
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
  });
  const handoffAuthority = Object.freeze({
    schema: "flow.resource-handoff-authority/v1",
    query(request) {
      if (request?.contract !== "flow.resource-handoff/v1") {
        return workRejection("query", "invalid_handoff_query", {
          contract: request?.contract ?? null,
          subjectId: request?.subject_id ?? null,
        });
      }
      return workQuery(request);
    },
  });
  delete authorityMethods.workCommand;
  delete authorityMethods.workQuery;
  const runAuthority = Object.freeze(authorityMethods);
  attachWorkAuthorities(runAuthority, Object.freeze({
    workspace: workspaceAuthority,
    artifact: artifactAuthority,
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
    const consumer = projectRun(consumerStream.fold);
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
  return buildHandoffPublication({
    artifacts,
    intent,
    publication,
    receipt,
    workspace: workspaceStream?.fold ?? null,
    gitObservation,
  });
}

function appendHandoffPublication(database, publication, fence) {
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
}

function prepareConsumerHandoffBindings(
  database,
  authorityDirectory,
  gitRetentionAdapter,
  prepared,
  runId,
) {
  return prepared.explicit_facts.resource_claims
    .filter(({ kind }) => kind === "resource_handoff")
    .map((claim) => {
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
      throw new Error("artifact digest already names different retained bytes");
    }
    return;
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
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
    resource_claims: resourceClaims,
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

function recordEffectInvocationStarted(database, intent, {
  authorityDirectory,
  authorityEpoch,
  bootId,
  gitRetentionAdapter,
  processIdentity,
}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    assertAuthorityEpoch(database, {
      authorityEpoch,
      bootId,
      processIdentity,
    });
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

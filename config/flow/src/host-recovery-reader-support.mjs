import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  createDurableRunAuthority,
} from "../../../tools/flow/src/run-authority.mjs";
import {
  createDrovrDelegatedAgentPort,
} from "../../../tools/flow/src/drovr-delegated-agent-port.mjs";
import {
  preparedObservation,
} from "../../../tools/flow/src/reboot-revalidation.mjs";
import {
  createFlowRuntime as createCoreFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import {
  closeFlowRuntime,
  createFlowRuntime as createProductionFlowRuntime,
  flowRuntimeMutationAuthority,
} from "./runtime.mjs";
import {
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  isolatedQualificationEnvironment,
} from "./host-recovery-qualification.mjs";
import {
  createProductionComposition,
} from "./production-composition.mjs";

export const HOST_RECOVERY_READER_SUPPORT_SCHEMA =
  "flow.host-recovery-reader-support/v1";

const PROJECTION_QUERY = Object.freeze({
  schema: "flow.query/v1",
  query: "review_inbox",
});
const PROJECTION_WATCH = Object.freeze({
  schema: "flow.watch/v1",
  query: "review_inbox",
});
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LATENCY_MS = 300_000;

export class HostRecoveryReaderSupportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "HostRecoveryReaderSupportError";
    this.code = code;
  }
}

/**
 * Qualify query/watch and projection reconstruction against one disposable
 * authority.  Public query and watch observations remain public-process
 * evidence.  The read-only reopen and the optional history seed are reported
 * separately as deterministic supporting evidence and never relabelled as a
 * host process proof.
 *
 * `publicCommandRunner` must execute the pinned public launcher and return
 * `{ command, output }`, where `output` is the parsed JSON emitted by that
 * launcher.  The function intentionally has no fallback that fabricates a
 * public response.
 */
export async function runProjectionRebuildReaderSupport(options = {}) {
  const context = validateReaderContext(options, "projection_rebuild_readers");
  const startedAt = now(options.clock);
  const commands = [];
  let ownerStarted = false;
  let status = "blocked";
  let reason = null;
  let seed = null;
  let query = null;
  let watch = null;
  let proof = null;
  let cleanupError = null;

  try {
    seed = await runHistorySeed(context, options);
    if (seed.status !== "pass") {
      reason = seed.reason ?? "projection_history_seed_blocked";
      await stopSupportOwner(context, options, commands, ownerStarted, () => {
        ownerStarted = false;
      });
      return readerSupportResult({
        context,
        startedAt,
        commands,
        seed,
        query,
        watch,
        proof,
        status,
        reason,
        cleanup: cleanupResult(ownerStarted, null),
      });
    }

    const start = await invokePublic(context, options, "start", ["start", "--json"]);
    commands.push(start.command);
    ownerStarted = start.output?.already_running !== true;

    query = await invokePublic(context, options, "query", [
      "query", "--input", JSON.stringify(PROJECTION_QUERY), "--json",
    ]);
    commands.push(query.command);
    assertPublicProjection(query.output, "query");

    watch = await invokePublic(context, options, "watch", [
      "watch", "--input", JSON.stringify(PROJECTION_WATCH), "--json",
    ]);
    commands.push(watch.command);
    assertPublicProjection(watch.output, "watch");

    const rebuilt = await rebuildReadOnlyViews(context, options, seed);
    proof = makeProjectionProof({ query, watch, rebuilt, seed });
    const publicOutputs = {
      query: attachProof(query.output, {
        query: proof.query,
        rebuild: proof.rebuild,
        views: proof.views,
        latency: proof.latency,
      }),
      watch: attachProof(watch.output, { watch: proof.watch }),
    };
    const complete = Object.values(proof).every((value) => value !== null) &&
      proof.query.observed === true &&
      proof.watch.observed === true &&
      proof.rebuild.without_mutation_lock === true &&
      proof.views.count >= 2 &&
      proof.latency.samples.length >= 2;
    if (!complete) {
      reason = "projection_rebuild_proof_incomplete";
    } else {
      status = "pass";
    }
    await stopSupportOwner(context, options, commands, ownerStarted, () => {
      ownerStarted = false;
    });
    return readerSupportResult({
      context,
      startedAt,
      commands,
      seed,
      query,
      watch,
      proof,
      publicOutputs,
      status,
      reason,
      cleanup: cleanupResult(ownerStarted, null),
    });
  } catch (error) {
    reason = error?.code ?? "projection_reader_support_failed";
    try {
      await stopSupportOwner(context, options, commands, ownerStarted, () => {
        ownerStarted = false;
      });
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    return readerSupportResult({
      context,
      startedAt,
      commands,
      seed,
      query,
      watch,
      proof,
      status: "blocked",
      reason,
      detail: safeMessage(error),
      cleanup: cleanupResult(ownerStarted, cleanupError),
    });
  }
}

async function stopSupportOwner(context, options, commands, ownerStarted, markStopped) {
  if (ownerStarted !== true || options.stopOwner === false) return;
  const stop = await invokePublic(context, options, "stop", ["stop", "--json"]);
  commands.push(stop.command);
  markStopped();
}

/**
 * Run the scenario-8 acceptance check without rebooting the host.  The
 * durable authority and production FlowRuntime perform observation and
 * admission.  Only the host boot identity and reboot boundary are deterministic
 * supporting adapters; the result explicitly records that actual reboot is
 * deferred to issue 47.
 */
export async function runSuspendedRunAdmissionSupport(options = {}) {
  const context = validateReaderContext(options, "suspended_run_admission");
  const startedAt = now(options.clock);
  let firstAuthority = null;
  let secondAuthority = null;
  let seedRuntime = null;
  let productionRuntime = null;
  let status = "blocked";
  let reason = null;
  let detail = null;
  let operations = [];
  let observations = {
    suspended: null,
    admission: null,
    reboot: null,
  };
  let result = null;
  const cleanupFailures = [];

  try {
    if (options.actualReboot === true) {
      throw new HostRecoveryReaderSupportError(
        "actual_reboot_deferred",
        "actual host reboot is deferred to issue 47",
      );
    }
    const authorityDirectory = context.isolation.authority_directory;
    const oldBootId = options.oldBootId ?? "issue-46-support-boot-old";
    const newBootId = options.newBootId ?? "issue-46-support-boot-new";
    if (oldBootId === newBootId) {
      throw new HostRecoveryReaderSupportError(
        "boot_identity_not_distinct",
        "suspended admission requires distinct simulated boot identities",
      );
    }
    if (existsSync(join(authorityDirectory, "authority.sqlite"))) {
      throw new HostRecoveryReaderSupportError(
        "authority_root_not_disposable",
        "suspended admission refuses a pre-existing authority database",
      );
    }

    firstAuthority = createDurableRunAuthority({
      authorityDirectory,
      ...productionSupportAuthorityOptions({
        authorityDirectory,
        environment: context.environment,
        hostIdentityAdapter: deterministicHostIdentity(oldBootId, "seed"),
      }),
    });
    seedRuntime = createCoreFlowRuntime({
      runAuthority: firstAuthority,
      autonomous: false,
    });
    const prepared = seedRuntime.prepare(suspendedCheckpointProposal(oldBootId));
    if (prepared?.schema !== "flow.prepared-run/v1") {
      throw new HostRecoveryReaderSupportError(
        "suspended_seed_prepare_failed",
        "the deterministic checkpoint seed did not produce a prepared run",
      );
    }
    const launch = seedRuntime.launch(confirmedDynamicLaunchRequest(prepared));
    if (launch?.schema !== "flow.launch-receipt/v1" ||
        typeof launch.run_id !== "string") {
      throw new HostRecoveryReaderSupportError(
        "suspended_seed_launch_failed",
        "the deterministic checkpoint seed did not create a flow run",
      );
    }
    operations.push(operationFact("seed_launch", "deterministic_supporting_check"));
    firstAuthority.close();
    firstAuthority = null;
    seedRuntime = null;

    secondAuthority = createDurableRunAuthority({
      authorityDirectory,
      ...productionSupportAuthorityOptions({
        authorityDirectory,
        environment: context.environment,
        hostIdentityAdapter: deterministicHostIdentity(newBootId, "admission"),
        rebootObservationAdapter: deterministicRebootObservation(newBootId),
      }),
    });
    productionRuntime = createProductionFlowRuntime({
      env: context.environment,
      runAuthority: secondAuthority,
      authorityDirectory,
      autonomous: false,
    });

    const before = timedRuntimeQuery(
      productionRuntime,
      { run_id: launch.run_id },
      "query_suspended",
    );
    operations.push(before.operation);
    const suspended = before.value;
    const admissionAction = suspended?.legal_actions?.find(({ type }) =>
      type === "reboot_admission");
    if (suspended?.schema !== "flow.run-projection/v1" ||
        suspended.admission !== "suspended_after_reboot" ||
        typeof suspended.authority_boot_id !== "string" ||
        suspended.authority_boot_id !== newBootId ||
        admissionAction === undefined) {
      throw new HostRecoveryReaderSupportError(
        "suspended_projection_invalid",
        "production runtime did not expose a suspended run and explicit reboot admission",
      );
    }

    const watcher = productionRuntime.watch({ run_id: launch.run_id });
    let watched;
    try {
      watched = await timedWatchFirst(watcher, "watch_suspended");
    } finally {
      await closeWatcher(watcher);
    }
    operations.push(watched.operation);
    const watchProjection = watched.value;
    if (watchProjection?.schema !== "flow.run-projection/v1" ||
        watchProjection.admission !== "suspended_after_reboot") {
      throw new HostRecoveryReaderSupportError(
        "suspended_watch_invalid",
        "production runtime watch did not expose the suspended projection",
      );
    }

    const receipt = timedRuntimeCommand(
      productionRuntime,
      admissionAction,
      "reboot_admission",
    );
    operations.push(receipt.operation);
    if (receipt.value?.schema !== "flow.command-receipt/v1" ||
        receipt.value.accepted !== true ||
        receipt.value.command_type !== "reboot_admission") {
      throw new HostRecoveryReaderSupportError(
        "reboot_admission_rejected",
        "production runtime rejected the explicit simulated reboot admission",
      );
    }
    const after = productionRuntime.query({ run_id: launch.run_id });
    if (after?.admission !== "admitted") {
      throw new HostRecoveryReaderSupportError(
        "reboot_admission_not_projected",
        "production runtime did not project the admitted run",
      );
    }

    const actionIdentity = typeof admissionAction.action_id === "string"
      ? admissionAction.action_id
      : canonicalDigest(admissionAction);
    observations = {
      suspended: {
        observed: true,
        run_id: launch.run_id,
        admission: suspended.admission,
        prior_boot_id: oldBootId,
        current_boot_id: newBootId,
        simulated_boot: true,
        provenance: "production_runtime",
      },
      admission: {
        explicit: true,
        run_id: launch.run_id,
        command_type: receipt.value.command_type,
        action_identity: actionIdentity,
        simulated_boot: true,
        provenance: "production_runtime",
      },
      reboot: {
        actual_reboot: false,
        deferred: true,
        simulated: true,
        boot_identity_observed: true,
        deferred_issue: "47",
        provenance: "deterministic_supporting_check",
      },
    };
    status = "pass";
    result = suspendedSupportResult({
      context,
      startedAt,
      launch,
      suspended,
      receipt: receipt.value,
      watch: watchProjection,
      observations,
      operations,
      status,
      reason,
      detail,
    });
  } catch (error) {
    reason = error?.code ?? "suspended_admission_support_failed";
    detail = safeMessage(error);
    result = suspendedSupportResult({
      context,
      startedAt,
      launch: null,
      suspended: null,
      receipt: null,
      watch: null,
      observations,
      operations,
      status: "blocked",
      reason,
      detail,
    });
  } finally {
    if (productionRuntime !== null) {
      try {
        closeFlowRuntime(productionRuntime);
      } catch (error) {
        cleanupFailures.push({
          code: "production_runtime_close_failed",
          detail: safeMessage(error),
        });
      }
    }
    for (const [name, authority] of [
      ["seed_authority", firstAuthority],
      ["admission_authority", secondAuthority],
    ]) {
      if (authority === null) continue;
      try {
        authority.close();
      } catch (error) {
        cleanupFailures.push({
          code: `${name}_close_failed`,
          detail: safeMessage(error),
        });
      }
    }
  }
  if (result === null) {
    result = suspendedSupportResult({
      context,
      startedAt,
      launch: null,
      suspended: null,
      receipt: null,
      watch: null,
      observations,
      operations,
      status: "blocked",
      reason: "suspended_admission_support_failed",
      detail: "support did not produce a result",
    });
  }
  if (cleanupFailures.length > 0) {
    result.cleanup = {
      ...result.cleanup,
      disposition: "blocked",
      unresolved_obligations: cleanupFailures,
    };
    if (result.result.disposition === "pass") {
      result.result = {
        disposition: "blocked",
        reason: "cleanup_unverified",
      };
    }
  }
  return result;
}

export const runScenario7ProjectionRebuildReadersSupport =
  runProjectionRebuildReaderSupport;
export const runScenario8SuspendedRunAdmissionSupport =
  runSuspendedRunAdmissionSupport;

async function runHistorySeed(context, options) {
  if (typeof options.historySeeder === "function") {
    const value = await options.historySeeder({
      isolation: context.isolation,
      environment: context.environment,
      rawRoot: context.rawRoot,
      timeoutMs: context.timeoutMs,
      signal: options.signal,
    });
    return validateHistorySeed(value);
  }
  if (options.seedHistory === false) {
    return {
      status: "blocked",
      reason: "realistic_history_seed_required",
      provenance: "none",
      run_ids: [],
      history_entries: 0,
    };
  }
  return seedProjectionHistory(context);
}

/**
 * Seed two active checkpoint runs into a fresh isolated authority.  This is
 * intentionally a supporting setup only. It never crosses into the public
 * observation fields and refuses to touch a pre-existing authority database.
 */
export function seedProjectionHistory({ isolation, environment } = {}) {
  const authorityDirectory = isolation?.authority_directory;
  if (!isAbsolute(authorityDirectory)) {
    throw new HostRecoveryReaderSupportError(
      "authority_directory_required",
      "projection history seeding requires an absolute authority directory",
    );
  }
  if (existsSync(join(authorityDirectory, "authority.sqlite"))) {
    return {
      status: "blocked",
      reason: "authority_root_not_disposable",
      provenance: "deterministic_supporting_check",
      run_ids: [],
      history_entries: 0,
    };
  }
  const bootId = "issue-46-reader-seed-boot";
  const productionEnvironment = environment ??
    isolatedQualificationEnvironment(isolation);
  let authority = null;
  try {
    authority = createDurableRunAuthority({
      authorityDirectory,
      ...productionSupportAuthorityOptions({
        authorityDirectory,
        environment: productionEnvironment,
        hostIdentityAdapter: deterministicHostIdentity(bootId, "reader-seed"),
      }),
    });
    const runtime = createCoreFlowRuntime({
      runAuthority: authority,
      autonomous: false,
    });
    const runIds = [];
    for (const fingerprintDigit of ["7", "8"]) {
      const proposal = readerHistoryProposal({ bootId, fingerprintDigit });
      const prepared = runtime.prepare(proposal);
      if (prepared?.schema !== "flow.prepared-run/v1") {
        return {
          status: "blocked",
          reason: "history_seed_prepare_failed",
          provenance: "deterministic_supporting_check",
          run_ids: runIds,
          history_entries: runIds.length,
        };
      }
      const launch = runtime.launch(confirmedDynamicLaunchRequest(prepared));
      if (launch?.schema !== "flow.launch-receipt/v1") {
        return {
          status: "blocked",
          reason: "history_seed_launch_failed",
          provenance: "deterministic_supporting_check",
          run_ids: runIds,
          history_entries: runIds.length,
        };
      }
      runIds.push(launch.run_id);
    }
    return {
      status: runIds.length === 2 ? "pass" : "blocked",
      reason: runIds.length === 2 ? null : "history_seed_incomplete",
      provenance: "deterministic_supporting_check",
      run_ids: runIds,
      history_entries: runIds.length,
      environment_bound: environment !== undefined,
    };
  } finally {
    authority?.close();
  }
}

async function rebuildReadOnlyViews(context, options, seed) {
  const createRuntime = options.inspectRuntimeFactory ?? createProductionFlowRuntime;
  const closeRuntime = options.inspectRuntimeCloser ?? closeFlowRuntime;
  const runtimeOptions = {
    env: context.environment,
    authorityDirectory: context.isolation.authority_directory,
    authorityOptions: { access: "inspect" },
    autonomous: false,
    ...(options.inspectRuntimeOptions ?? {}),
  };
  let first = null;
  let second = null;
  try {
    const beforeStart = performance.now();
    first = createRuntime(runtimeOptions);
    const before = await collectViews(first, context.timeoutMs);
    const beforeDuration = elapsedMs(beforeStart);
    const beforeMutationAuthority = flowRuntimeMutationAuthority(first);
    await closeRuntime(first);
    first = null;

    const afterStart = performance.now();
    second = createRuntime(runtimeOptions);
    const after = await collectViews(second, context.timeoutMs);
    const afterDuration = elapsedMs(afterStart);
    const afterMutationAuthority = flowRuntimeMutationAuthority(second);
    await closeRuntime(second);
    second = null;

    const beforeIdentities = projectionIdentities(before.views);
    const afterIdentities = projectionIdentities(after.views);
    const identityStable = JSON.stringify(beforeIdentities) ===
      JSON.stringify(afterIdentities);
    const mutationLockObserved = typeof beforeMutationAuthority === "boolean" &&
      typeof afterMutationAuthority === "boolean";
    const mutationLockAcquired = mutationLockObserved &&
      (beforeMutationAuthority === true || afterMutationAuthority === true);
    const noMutationLock = mutationLockObserved &&
      beforeMutationAuthority === false &&
      afterMutationAuthority === false;
    const historyEntries = Math.max(
      before.host?.runs?.length ?? 0,
      after.host?.runs?.length ?? 0,
    );
    return {
      status: noMutationLock && identityStable && before.views.length >= 2 &&
        historyEntries >= 2 ? "pass" : "blocked",
      reason: noMutationLock && identityStable && before.views.length >= 2 &&
        historyEntries >= 2 ? null : "projection_rebuild_support_incomplete",
      before,
      after,
      without_mutation_lock: noMutationLock,
      mutation_lock_acquired: mutationLockAcquired,
      mutation_lock_observed: mutationLockObserved,
      projection_identity_stable: identityStable,
      rebuild_count: 1,
      views: {
        count: after.views.length,
        view_ids: after.views.map(({ id }) => id),
        identities: afterIdentities,
      },
      latency: {
        samples: [beforeDuration, afterDuration],
        history_entries: historyEntries,
        seed_history_entries: seed?.history_entries ?? 0,
        max_latency_ms: Math.max(beforeDuration, afterDuration),
      },
      provenance: "deterministic_supporting_check",
    };
  } finally {
    if (first !== null) await closeRuntime(first).catch(() => {});
    if (second !== null) await closeRuntime(second).catch(() => {});
  }
}

async function collectViews(runtime, timeoutMs) {
  const host = runtime.query({});
  const inbox = runtime.query(PROJECTION_QUERY);
  const views = [
    { id: "host:run-index", value: host },
    { id: "review:inbox", value: inbox },
  ];
  for (const runId of host?.runs ?? []) {
    if (views.length >= 4) break;
    const projection = runtime.query({ run_id: runId });
    if (projection?.schema === "flow.run-projection/v1") {
      views.push({ id: `run:${runId}`, value: projection });
    }
  }
  if (views.some(({ value }) => value === null || value === undefined)) {
    throw new HostRecoveryReaderSupportError(
      "projection_view_missing",
      "read-only runtime did not rebuild every required projection",
    );
  }
  await Promise.resolve(timeoutMs);
  return { host, inbox, views };
}

function makeProjectionProof({ query, watch, rebuilt, seed }) {
  const queryWatermark = extractWatermark(query.output);
  const watchWatermark = extractWatermark(watch.output);
  return {
    query: {
      observed: queryWatermark !== null,
      watermark: queryWatermark,
      provenance: "public_process",
    },
    watch: {
      observed: watchWatermark !== null,
      watermark: watchWatermark,
      provenance: "public_process",
    },
    rebuild: {
      without_mutation_lock: rebuilt.without_mutation_lock === true,
      mutation_lock_acquired: rebuilt.mutation_lock_acquired === true,
      mutation_lock_observed: rebuilt.mutation_lock_observed === true,
      projection_identity_stable: rebuilt.projection_identity_stable === true,
      rebuild_count: rebuilt.rebuild_count,
      provenance: rebuilt.provenance,
    },
    views: {
      ...rebuilt.views,
      provenance: rebuilt.provenance,
    },
    latency: {
      ...rebuilt.latency,
      provenance: rebuilt.provenance,
      history_seed_provenance: seed?.provenance ?? "none",
    },
  };
}

function readerSupportResult({
  context,
  startedAt,
  commands,
  seed,
  query,
  watch,
  proof,
  publicOutputs = null,
  status,
  reason,
  detail = null,
  cleanup,
}) {
  return {
    schema: HOST_RECOVERY_READER_SUPPORT_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: "projection_rebuild_readers",
    execution_kind: "live_public_process",
    provenance: {
      query: "public_process",
      watch: "public_process",
      rebuild: "deterministic_supporting_check",
      history_seed: seed?.provenance ?? "none",
    },
    commands,
    outputs: publicOutputs,
    proof,
    seed,
    cleanup,
    result: { disposition: status, reason: reason ?? null },
    ...(detail === null ? {} : { detail }),
    started_at: startedAt,
    finished_at: now(context.clock),
  };
}

function suspendedSupportResult({
  context,
  startedAt,
  launch,
  suspended,
  receipt,
  watch,
  observations,
  operations,
  status,
  reason,
  detail,
}) {
  return {
    schema: HOST_RECOVERY_READER_SUPPORT_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: "suspended_run_admission",
    execution_kind: "deterministic_supporting_check",
    provenance: {
      suspended: "production_runtime",
      admission: "production_runtime",
      reboot: "deterministic_supporting_check",
    },
    operations,
    launch,
    outputs: {
      query: suspended === null ? null : attachProof(suspended, {
        suspended: observations.suspended,
      }),
      command: receipt === null ? null : attachProof(receipt, {
        admission: observations.admission,
      }),
      watch: watch === null ? null : attachProof(watch, {
        reboot: observations.reboot,
      }),
    },
    observations,
    cleanup: {
      disposition: "complete",
      owned_resources: [{
        kind: "isolated_authority",
        identity_ref: "isolation/authority",
      }],
      unresolved_obligations: [],
      supporting_only: true,
    },
    result: { disposition: status, reason: reason ?? null },
    ...(detail === null ? {} : { detail }),
    started_at: startedAt,
    finished_at: now(context.clock),
  };
}

function validateReaderContext(options, scenarioId) {
  const isolation = options.isolation;
  if (!isRecord(isolation) || !isAbsolute(isolation.worktree_root) ||
      !isAbsolute(isolation.authority_directory) || typeof isolation.run_id !== "string") {
    throw new HostRecoveryReaderSupportError(
      "isolation_required",
      `${scenarioId} support requires one explicit absolute isolation contract`,
    );
  }
  const rawRoot = assertExternalQualificationRoot(options.rawRoot, {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  if (typeof options.publicCommandRunner !== "function" &&
      scenarioId === "projection_rebuild_readers") {
    throw new HostRecoveryReaderSupportError(
      "public_command_runner_required",
      "projection reader support requires the pinned public command runner",
    );
  }
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_LATENCY_MS) {
    throw new HostRecoveryReaderSupportError(
      "timeout_invalid",
      "reader support timeout must be between 100 and 300000 milliseconds",
    );
  }
  return Object.freeze({
    isolation,
    rawRoot,
    timeoutMs,
    clock: options.clock,
    environment: options.environment ?? isolatedQualificationEnvironment(isolation),
  });
}

async function invokePublic(context, options, kind, args) {
  const began = performance.now();
  const raw = await options.publicCommandRunner({
    scenario_id: "projection_rebuild_readers",
    kind,
    args,
    isolation: context.isolation,
    rawRoot: context.rawRoot,
    timeoutMs: context.timeoutMs,
    signal: options.signal,
  });
  const command = raw?.command ?? raw?.invocation;
  if (!isRecord(command) || typeof command.id !== "string") {
    throw new HostRecoveryReaderSupportError(
      "public_command_record_invalid",
      `${kind} did not return a command identity`,
    );
  }
  if (command.command_kind !== undefined && command.command_kind !== kind) {
    throw new HostRecoveryReaderSupportError(
      "public_command_kind_invalid",
      `${kind} returned command kind ${command.command_kind ?? "unknown"}`,
    );
  }
  if (command.timed_out === true ||
      (command.signal !== null && command.signal !== undefined) ||
      (Number.isInteger(command.exit_code) && command.exit_code !== 0)) {
    throw new HostRecoveryReaderSupportError(
      "public_command_failed",
      `${kind} did not complete successfully`,
    );
  }
  const output = raw.output ?? raw.response ?? raw.result ?? raw.payload;
  if (!isRecord(output) && !Array.isArray(output)) {
    throw new HostRecoveryReaderSupportError(
      "public_command_output_missing",
      `${kind} did not return structured JSON output`,
    );
  }
  const commandDuration = Number.isSafeInteger(command.duration_ms) &&
    command.duration_ms >= 0
    ? command.duration_ms
    : elapsedMs(began);
  return {
    command: structuredClone(command),
    output: structuredClone(output),
    duration_ms: commandDuration,
  };
}

function assertPublicProjection(output, operation) {
  const values = Array.isArray(output) ? output : [output];
  if (values.length === 0 || values.some((value) => !isRecord(value))) {
    throw new HostRecoveryReaderSupportError(
      `${operation}_output_invalid`,
      `${operation} did not return a structured projection`,
    );
  }
  const observed = values.some((value) => extractWatermark(value) !== null);
  if (!observed) {
    throw new HostRecoveryReaderSupportError(
      `${operation}_watermark_missing`,
      `${operation} projection did not carry an authority watermark`,
    );
  }
}

function attachProof(output, proof) {
  if (Array.isArray(output)) {
    if (output.length !== 1) {
      return output.map((value, index) => index === 0
        ? attachProof(value, proof)
        : value);
    }
    return [attachProof(output[0], proof)];
  }
  return { ...structuredClone(output), proof };
}

function projectionIdentities(views) {
  return views.map(({ id, value }) => ({
    id,
    schema: value?.schema ?? null,
    watermark: extractWatermark(value),
    digest: canonicalDigest(durableProjectionIdentity(value)),
  }));
}

function durableProjectionIdentity(value) {
  if (Array.isArray(value)) return value.map(durableProjectionIdentity);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "current")
    .map(([key, nested]) => [key, durableProjectionIdentity(nested)]));
}

function timedRuntimeQuery(runtime, request, kind) {
  const started = performance.now();
  const value = runtime.query(request);
  return {
    value,
    operation: operationFact(kind, "production_runtime", elapsedMs(started)),
  };
}

async function timedWatchFirst(watcher, kind) {
  const started = performance.now();
  const next = await watcher.next();
  if (next?.done === true || next?.value === undefined) {
    throw new HostRecoveryReaderSupportError(
      "runtime_watch_empty",
      "production runtime watch ended before publishing a suspended projection",
    );
  }
  return {
    value: next.value,
    operation: operationFact(kind, "production_runtime", elapsedMs(started)),
  };
}

function timedRuntimeCommand(runtime, command, kind) {
  const started = performance.now();
  const value = runtime.command(command);
  return {
    value,
    operation: operationFact(kind, "production_runtime", elapsedMs(started)),
  };
}

async function closeWatcher(watcher) {
  if (typeof watcher?.return === "function") await watcher.return();
}

function operationFact(kind, provenance, durationMs = 0) {
  return {
    kind,
    provenance,
    duration_ms: Math.max(0, Math.round(durationMs)),
  };
}

function cleanupResult(ownerStarted, error) {
  return {
    disposition: error === null && ownerStarted === false ? "complete" : "blocked",
    owner_stopped: ownerStarted === false,
    unresolved_obligations: error === null && ownerStarted === false
      ? []
      : [{ code: "owner_cleanup_unverified", detail: safeMessage(error) }],
  };
}

function validateHistorySeed(value) {
  if (!isRecord(value) || !["pass", "blocked"].includes(value.status) ||
      typeof value.provenance !== "string" || !Array.isArray(value.run_ids) ||
      !Number.isSafeInteger(value.history_entries) || value.history_entries < 0) {
    throw new HostRecoveryReaderSupportError(
      "history_seed_result_invalid",
      "history seed did not return the required structured result",
    );
  }
  return structuredClone(value);
}

function readerHistoryProposal({ bootId, fingerprintDigit }) {
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards: [{
        id: "observe-projection",
        executor: {
          kind: "checkpoint",
          contract: "flow.checkpoint/confirmation/v1",
        },
        dependencies: [],
        inputs: { prompt: "Retain one projection history entry" },
        outputs: [],
        success_criteria: ["decision:approve"],
        validators: ["flow.validator/checkpoint-decision/v1"],
        data_references: [],
        evidence_references: [],
        route: null,
        limits: {},
        resource_claims: [],
        recovery: "human_decision",
      }],
    },
    requested_authority: {
      commands: ["checkpoint_decision"],
      capabilities: [],
      mutations: [],
    },
    explicit_facts: {
      catalog_fingerprint: `sha256:${fingerprintDigit.repeat(64)}`,
      route_snapshot: {
        watermark: `sha256:${"2".repeat(64)}`,
        bindings: [],
      },
      capability_envelopes: [],
      operation_contracts: [],
      validator_contracts: ["flow.validator/checkpoint-decision/v1"],
      block_observations: [],
      time_facts: deterministicTimeFacts(bootId),
      subject_generations: [],
      elapsed_seconds: 0,
      limits: {
        max_cards: 1,
        max_revisions: 0,
        max_cards_per_revision: 0,
        max_capabilities: 0,
        max_resources: 0,
        max_elapsed_seconds: 0,
      },
      resource_claims: [],
    },
  };
}

function suspendedCheckpointProposal(bootId) {
  return readerHistoryProposal({
    bootId,
    fingerprintDigit: "9",
  });
}

function confirmedDynamicLaunchRequest(prepared) {
  return {
    prepared,
    confirmation: {
      schema: "flow.dynamic-plan-confirmation-decision/v1",
      decision: "accept",
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    },
    closed_facts: {
      schema: "flow.closed-fact-observation/v1",
      bundle_digest: prepared.bundle_digest,
      facts: structuredClone(prepared.explicit_facts),
    },
  };
}

function productionSupportAuthorityOptions({
  authorityDirectory,
  environment,
  hostIdentityAdapter,
  rebootObservationAdapter = undefined,
}) {
  const composition = createProductionComposition({
    delegatedAgentPort: createDrovrDelegatedAgentPort({
      dependencies: { env: environment },
    }),
    env: environment,
    authorityDirectory,
    legacyRoots: {},
    authorityOptions: {
      hostIdentityAdapter,
      ...(rebootObservationAdapter === undefined
        ? {}
        : { rebootObservationAdapter }),
    },
  });
  return composition.authorityOptions;
}

function deterministicHostIdentity(bootId, role) {
  return {
    observe() {
      return {
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: `issue-46-reader-support:${role}`,
      };
    },
  };
}

function deterministicRebootObservation(bootId) {
  return {
    observe({ prepared }) {
      const observation = preparedObservation(prepared);
      return {
        ...observation,
        time_facts: observation.time_facts.map((fact) => fact.kind === "boot"
          ? { ...fact, boot_id: bootId }
          : fact),
      };
    },
  };
}

function deterministicTimeFacts(bootId) {
  return [
    {
      schema: "flow.time-fact/v1",
      kind: "wall_clock",
      value_ms: 1_700_000_000_000,
      uncertainty_ms: 0,
      clock_source_id: "wall:issue-46-reader-support",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "suspend_excluding_monotonic",
      value_ns: "1000000000",
      uncertainty_ns: "0",
      clock_source_id: "mono:issue-46-reader-support",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "boot",
      boot_id: bootId,
    },
    {
      schema: "flow.time-fact/v1",
      kind: "clock_source",
      identity: "clockset:issue-46-reader-support:v1",
    },
  ];
}

function extractWatermark(value) {
  if (!isRecord(value)) return null;
  if (typeof value.watermark === "string") return value.watermark;
  if (typeof value.authority_watermark === "string") return value.authority_watermark;
  return null;
}

function elapsedMs(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function now(clock) {
  return typeof clock === "function" ? clock() : new Date().toISOString();
}

function safeMessage(error) {
  return error?.message ?? String(error);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

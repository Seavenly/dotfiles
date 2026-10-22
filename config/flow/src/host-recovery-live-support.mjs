import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  isolatedQualificationEnvironment,
  runPinnedPublicCommand,
} from "./host-recovery-qualification.mjs";
import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  acquireResourceLock,
  writeRecord,
  readResourceLock,
  releaseAbsentRegistryLock,
  resourceLockPath,
  resourceLockProjection,
  stateDirectory,
} from "../../../tools/drovr/src/registry.mjs";
import {
  closeFlowRuntime,
  createFlowRuntime,
} from "./runtime.mjs";
import { flowRuntimeAuthority } from "./production-runtime.mjs";
import { getArtifactAuthority } from "../../../tools/flow/src/work-authority.mjs";
import {
  createFlowRuntime as createCoreFlowRuntime,
  stopAutonomousFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import { createDrovrDelegatedAgentPort } from "../../../tools/flow/src/drovr-delegated-agent-port.mjs";
import { createProductionComposition } from "./production-composition.mjs";

const execFileAsync = promisify(execFile);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const LOCK_SCHEMA = "drovr.registry-lock/v1";
const SUPPORT_SCHEMA = "flow.host-recovery-live-support/v1";
const DROVR_CLI_PATH = fileURLToPath(new URL("../../../tools/drovr/src/cli.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
const DROVR_STATUS_ENVIRONMENT_KEYS = new Set([
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TZ",
]);

export class LiveSupportConfigurationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "LiveSupportConfigurationError";
    this.code = code;
  }
}

/**
 * Bind live support to one already-created qualification isolation.
 *
 * This adapter is deliberately a source of observations, not a source of
 * scenario assertions. Public commands are executed by the pinned launcher;
 * native observations are derived from process/filesystem facts. A provider
 * preflight never claims that a delegate turn was dispatched.
 */
export function createIssue46LiveSupport({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  drovrBinary = undefined,
} = {}) {
  validateSupportInputs({ entrypoints, isolation, rawRoot, timeoutMs });
  const root = assertExternalQualificationRoot(rawRoot, {
    worktreeRoot: isolation.worktree_root,
    label: "rawRoot",
  });
  assertQualificationPathDisjoint(root, {
    worktreeRoot: isolation.worktree_root,
    isolation,
    label: "rawRoot",
  });
  const observations = [];
  const commandResults = [];
  let lockProbePromise = null;

  async function commandRunner(request = {}) {
    if (!Array.isArray(request.args) || request.args.length === 0) {
      throw new LiveSupportConfigurationError(
        "public_command_arguments_invalid",
        "live support requires the exact public launcher argument vector",
      );
    }
    const command = await runPinnedPublicCommand({
      entrypoints,
      isolation,
      args: request.args,
      logDirectory: join(root, "logs"),
      timeoutMs: boundedTimeout(request.timeoutMs, timeoutMs),
    });
    const output = await parsePublicOutput(command, root);
    const result = Object.freeze({ command, output });
    commandResults.push(result);
    observations.push({
      kind: request.kind ?? request.args[0],
      command_id: command.id,
      output_schema: output?.schema ?? null,
      output_watermark: extractWatermark(output),
      command_exit: command.exit_code,
      command_signal: command.signal,
      observed_at: command.finished_at,
    });
    return result;
  }

  return Object.freeze({
    schema: SUPPORT_SCHEMA,
    version: 1,
    commandRunner,
    commandObservations() {
      return structuredClone(observations);
    },
    commandResults() {
      return structuredClone(commandResults);
    },
    async toolRunner(request = {}) {
      const operation = request.operation;
      if (operation === "headless_captures") return headlessCaptureSources({ commandResults, isolation });
      if (operation === "lock_owner_termination" || operation === "lock_reconciliation" ||
          operation === "negative_age_takeover" || operation === "negative_force_takeover") {
        lockProbePromise ??= runDrovrRegistryLockProbe({
          nodePath: entrypoints.node.path,
          registryModulePath: join(isolation.worktree_root, "tools/drovr/src/registry.mjs"),
          rawRoot: root,
          registryDirectory: join(isolation.drovr_config_directory, "registry"),
          ...request.lock_options,
        });
        const probe = await lockProbePromise;
        if (operation === "lock_owner_termination") return probe;
        if (operation === "lock_reconciliation") return probe.reconciliation;
        if (operation === "negative_age_takeover") return probe.negative_age;
        return probe.negative_force;
      }
      if (["producer_exit", "tuicr_consumer", "flowruntime_review", "owner_restart_rebuild"].includes(operation)) {
        return observeTuicrFacts({
          entrypoints,
          isolation,
          rawRoot: root,
          timeoutMs,
          ...(request.tuicr_options ?? {}),
        });
      }
      throw new LiveSupportConfigurationError(
        "native_tool_operation_unsupported",
        `live support has no native adapter for ${operation ?? "unknown"}`,
      );
    },
    observeNativeDelegate(options = {}) {
      return observeNativeDelegate({
        entrypoints,
        isolation,
        rawRoot: root,
        timeoutMs,
        drovrBinary,
        ...options,
      });
    },
    headlessCaptureSources() {
      return headlessCaptureSources({ commandResults, isolation });
    },
    projectionFacts() {
      return projectionFacts({ commandResults });
    },
    tuicrFacts(options = {}) {
      return observeTuicrFacts({
        entrypoints,
        isolation,
        rawRoot: root,
        timeoutMs,
        ...options,
      });
    },
    suspendedAdmissionFacts(options = {}) {
      return observeSuspendedAdmissionFacts({
        commandResults,
        ...options,
      });
    },
    async runDrovrRegistryLockProbe(options = {}) {
      return runDrovrRegistryLockProbe({
        nodePath: entrypoints.node.path,
        registryModulePath: join(isolation.worktree_root, "tools/drovr/src/registry.mjs"),
        rawRoot: root,
        ...options,
      });
    },
    async runProductionBackupRestoreProbe(options = {}) {
      return runProductionBackupRestoreProbe({
        authorityDirectory: isolation.authority_directory,
        backupDirectory: isolation.backup_directory,
        repositoryRoot: isolation.repository_root,
        drovrConfigDirectory: isolation.drovr_config_directory,
        rawRoot: root,
        env: isolatedQualificationEnvironment(isolation),
        ...options,
      });
    },
  });
}

/**
 * Run one exact public command through the existing pinned process seam and
 * parse only its persisted stdout. This is the adapter expected by the
 * scenario drivers; it does not turn an exit code into proof.
 */
export const createIssue46PublicCommandRunner = createIssue46LiveSupport;

/**
 * Probe configured Drovr/Herdr compatibility without dispatching a turn.
 * `invocation_count: 0` is intentional: qualification readiness is not a
 * native delegate effect and cannot satisfy scenario 1 or 2 by itself.
 */
export async function observeNativeDelegate({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  drovrBinary = undefined,
  model = "gpt-5.6-luna",
  effort = "low",
  harness = "codex",
  capability = "read-only",
} = {}) {
  validateSupportInputs({ entrypoints, isolation, rawRoot, timeoutMs });
  const selectedDrovr = drovrBinary ?? entrypoints.drovr?.path;
  if (typeof selectedDrovr !== "string" || !isAbsolute(selectedDrovr)) {
    return nativeDelegateBlock("native Drovr launcher path is unavailable");
  }
  try {
    const metadata = await lstat(selectedDrovr);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      return nativeDelegateBlock("native Drovr launcher is not executable");
    }
  } catch (error) {
    return nativeDelegateBlock(`native Drovr launcher is unavailable: ${error.message}`);
  }
  const startedAt = new Date().toISOString();
  const args = [
    "describe",
    "--harness", harness,
    "--model", model,
    "--effort", effort,
    "--capability", capability,
    "--caller-metadata",
    JSON.stringify({
      schema: "flow.live-qualification-observation/v1",
      run_id: isolation.run_id,
      purpose: "issue-46-native-readiness",
    }),
  ];
  let result;
  try {
    result = await execFileAsync(entrypoints.node.path, [selectedDrovr, ...args], {
      cwd: isolation.worktree_root,
      env: isolatedQualificationEnvironment(isolation),
      timeout: boundedTimeout(timeoutMs, DEFAULT_TIMEOUT_MS),
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (error) {
    return nativeDelegateBlock(
      `native delegate preflight failed before dispatch: ${safeErrorMessage(error)}`,
      {
        command: canonicalCommand(entrypoints.node.path, selectedDrovr, args),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        exit_code: Number.isInteger(error.code) ? error.code : null,
        stderr_sha256: sha256(Buffer.from(error.stderr ?? "")),
      },
    );
  }
  const stdout = String(result.stdout ?? "");
  const parsed = parseJsonLines(stdout);
  const qualified = parsed?.schema === "drovr.command/v1" &&
    parsed.ok === true &&
    ["qualified", "ready", "compatible"].includes(
      parsed.result?.compatibility?.status,
    );
  const transcript = {
    command: canonicalCommand(entrypoints.node.path, selectedDrovr, args),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: 0,
    stdout_sha256: sha256(Buffer.from(stdout)),
    result_schema: parsed?.schema ?? null,
    compatibility_status: parsed?.result?.compatibility?.status ?? null,
  };
  return Object.freeze({
    schema: "flow.native-delegate-observation/v1",
    status: qualified ? "ready" : "blocked",
    provider_identity: qualified
      ? parsed.result.compatibility.integration ?? "drovr/qualified"
      : "drovr/preflight",
    watermark: `sha256:${sha256(Buffer.from(JSON.stringify(transcript)))}`,
    invocation_count: 0,
    dispatch_attempted: false,
    reason: qualified
      ? "native delegate dispatch is required for scenario proof; readiness is not an invocation"
      : "native Drovr qualification did not produce a qualified launch",
    transcript,
  });
}

/**
 * Exercise one isolated Drovr registry owner and reconcile it only after a
 * kernel-observable SIGKILL and exact process-identity absence proof.
 */
export async function runDrovrRegistryLockProbe({
  nodePath,
  registryModulePath,
  registryDirectory,
  rawRoot,
  resourceKey = "issue-46-live-registry-lock",
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof nodePath !== "string" || !isAbsolute(nodePath) ||
      typeof registryModulePath !== "string" || !isAbsolute(registryModulePath) ||
      typeof registryDirectory !== "string" || !isAbsolute(registryDirectory) ||
      typeof rawRoot !== "string" || !isAbsolute(rawRoot)) {
    throw new LiveSupportConfigurationError(
      "drovr_lock_inputs_invalid",
      "Drovr lock support requires absolute Node, module, registry, and raw paths",
    );
  }
  assertDisposableRoot(registryDirectory, "registryDirectory");
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await chmod(registryDirectory, 0o700);
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  const moduleUrl = pathToFileURL(registryModulePath).href;
  const operation = {
    id: `drovr:issue-46-lock:${resourceKey}`,
    kind: "issue_46_lock_probe",
  };
  const script = `
    import { acquireResourceLock } from ${JSON.stringify(moduleUrl)};
    const directory = process.env.ISSUE46_REGISTRY_DIRECTORY;
    const key = process.env.ISSUE46_REGISTRY_KEY;
    const handle = await acquireResourceLock(directory, key, {
      operation: ${JSON.stringify(operation)},
      authorityId: "issue-46-live-owner",
    });
    process.stdout.write(JSON.stringify({
      ready: true,
      pid: process.pid,
      metadata: handle.metadata,
    }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(nodePath, ["--input-type=module", "--eval", script], {
    cwd: dirname(registryModulePath),
    env: {
      ...process.env,
      XDG_STATE_HOME: dirname(registryDirectory),
      ISSUE46_REGISTRY_DIRECTORY: registryDirectory,
      ISSUE46_REGISTRY_KEY: resourceKey,
      HOME: rawRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = observeChildExit(child);
  const stdout = collectStream(child.stdout);
  const stderr = collectStream(child.stderr);
  const ready = await waitForReady(stdout, timeoutMs);
  const metadata = ready?.metadata;
  if (!ready?.ready || !isRecord(metadata) || metadata.schema !== LOCK_SCHEMA) {
    child.kill("SIGKILL");
    await exitPromise;
    throw new LiveSupportConfigurationError(
      "drovr_lock_owner_unavailable",
      `isolated Drovr lock owner did not publish a valid lock: ${stderr.value()}`,
    );
  }
  const lockPath = resourceLockPath(registryDirectory, resourceKey);
  const lockBefore = await readResourceLock(registryDirectory, resourceKey);
  if (lockBefore.status !== "held" || lockBefore.metadata?.lock_id !== metadata.lock_id) {
    child.kill("SIGKILL");
    await exitPromise;
    throw new LiveSupportConfigurationError(
      "drovr_lock_publication_mismatch",
      "isolated Drovr owner published a lock with an unexpected identity",
    );
  }
  const killAccepted = child.kill("SIGKILL");
  const exit = await exitPromise;
  const terminationSignal = exit.signal ?? (killAccepted ? "SIGKILL" : null);
  const processIdentity = canonicalDigest(metadata.owner?.process_identity);
  const projectionAfterKill = await resourceLockProjection(registryDirectory);
  const lockAfterKill = projectionAfterKill.locks.find((lock) =>
    lock.resource_key === resourceKey);
  if (terminationSignal !== "SIGKILL" || lockAfterKill?.owner_status !== "absent") {
    throw new LiveSupportConfigurationError(
      "drovr_lock_absence_unproven",
      `SIGKILL did not produce an exact absent-owner lock projection (signal=${terminationSignal}, status=${lockAfterKill?.owner_status ?? "missing"})`,
    );
  }
  const authorityWatermark = projectionAfterKill.authority_watermark;
  const negativeAge = await negativeTakeoverAttempt({
    registryDirectory,
    resourceKey,
    operation,
    mode: "age",
  });
  const negativeForce = await negativeTakeoverAttempt({
    registryDirectory,
    resourceKey,
    operation,
    mode: "force",
  });
  const release = await releaseAbsentRegistryLock(
    registryDirectory,
    lockAfterKill.lock_entry,
    {
      lockId: metadata.lock_id,
      authorityWatermark,
      decisionId: `issue-46-lock-release:${resourceKey}`,
    },
  );
  const finalProjection = await resourceLockProjection(registryDirectory);
  await removeExactDirectory(registryDirectory);
  const cleanup = cleanupReceipt({
    registryDirectory,
    lockPath,
    finalProjection,
    registryRemoved: !(await pathExists(registryDirectory)),
    completedAt: new Date().toISOString(),
  });
  return Object.freeze({
    schema: "flow.drovr-lock-live-observation/v1",
    registry_directory: registryDirectory,
    resource_key: resourceKey,
    lock_id: metadata.lock_id,
    authority_watermark: `sha256:${canonicalDigest(authorityWatermark).slice("sha256:".length)}`,
    owner_killed: true,
    termination_signal: terminationSignal,
    owner_status: "absent",
    process_absence: {
      status: "absent",
      process_identity: processIdentity,
      pid: metadata.owner?.process_identity?.pid ?? null,
      observed_exit_signal: terminationSignal,
    },
    lock_projection: projectionAfterKill,
    reconciliation: {
      reconciled: release.status === "released" && finalProjection.locks.length === 0,
      recovery_action: "release_absent_registry_lock",
      status: release.status,
      lock_id: metadata.lock_id,
      resource_key: resourceKey,
      legal_next_actions: release.legal_next_actions ?? ["acquire_registry_lock"],
      authority_watermark: authorityWatermark,
      absence_proof: release.absence_proof,
    },
    negative_age: negativeAge,
    negative_force: negativeForce,
    child: {
      pid: ready.pid,
      exit_signal: terminationSignal,
      stderr_sha256: sha256(Buffer.from(stderr.value())),
    },
    cleanup,
  });
}

/**
 * Exercise the configured production backup provider against disposable state.
 * The authority root is the only destructive target. The Git repository,
 * provider snapshot, and Drovr configuration remain intact until the caller's
 * explicit qualification cleanup disposition.
 */
export async function runProductionBackupRestoreProbe({
  authorityDirectory,
  backupDirectory,
  repositoryRoot,
  drovrConfigDirectory,
  rawRoot,
  env = {},
  drovrStatusRunner = undefined,
} = {}) {
  const inputs = {
    authorityDirectory,
    backupDirectory,
    repositoryRoot,
    drovrConfigDirectory,
    rawRoot,
  };
  for (const [name, path] of Object.entries(inputs)) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new LiveSupportConfigurationError(
        "backup_probe_path_invalid",
        `${name} must be an absolute path`,
      );
    }
  }
  for (const [name, path] of Object.entries({
    authorityDirectory,
    backupDirectory,
    repositoryRoot,
    drovrConfigDirectory,
  })) {
    assertDisposableRoot(path, name);
  }
  const statusSandboxDirectory = join(drovrConfigDirectory, "status-sandbox");
  assertDisposableRoot(statusSandboxDirectory, "drovrStatusSandboxDirectory");
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  const environment = {
    ...sanitizedDrovrStatusEnvironment(env, statusSandboxDirectory),
    FLOW_AUTHORITY_DIRECTORY: authorityDirectory,
    FLOW_BACKUP_DIRECTORY: backupDirectory,
    FLOW_REPOSITORY_ROOT: repositoryRoot,
    DROVR_CONFIG_DIR: drovrConfigDirectory,
  };
  const drovrSeed = await seedDrovrObligationState(stateDirectory(environment));
  // Direct registry writes are setup-only. The production qualification must
  // observe that setup through the pinned public `drovr status` command; a
  // closure over the seed would merely compare fabricated state to itself.
  const statusRunner = drovrStatusRunner ?? ((request = {}) =>
    runPinnedDrovrStatus(request.env ?? environment));
  const backupOperationContract = "flow.operation/issue-46-backup-seed/v1";
  const backupOperationRegistration = {
    [backupOperationContract]: {
      classification: "caller_idempotent",
      invoke(intent) {
        return {
          schema: "flow.effect-receipt/v1",
          effect_id: intent.effect_id,
          idempotency_key: intent.idempotency_key,
          outcome: "succeeded",
          provider_receipt: {
            schema: "flow.provider-receipt/v1",
            record: "issue-46-backup-seed",
            operation_effect_id: intent.effect_id,
            provider_receipt_id: `backup-seed:${intent.effect_id}`,
            outcome: "succeeded",
          },
        };
      },
    },
  };
  let runtime = null;
  let restoreRuntime = null;
  let manifest = null;
  let backup = null;
  let loss = null;
  let cleanup;
  try {
    const drovrStatus = statusRunner({
      command: "status",
      args: ["status"],
      env: environment,
    });
    if (drovrStatus instanceof Promise) {
      throw new LiveSupportConfigurationError(
        "backup_drovr_observation_async",
        "Drovr status observation must return the synchronous public CLI result",
      );
    }
    const observedTurns = [
      ...(drovrStatus?.result?.active_turns ?? []),
      ...(drovrStatus?.result?.turns ?? []),
    ];
    const observedSeed = observedTurns.find(({ id }) => id === drovrSeed.turn_id);
    if (drovrStatus?.schema !== "drovr.command/v1" ||
        drovrStatus.command !== "status" || drovrStatus.ok !== true ||
        observedSeed?.id !== drovrSeed.turn_id || observedSeed.status !== "working") {
      return productionBackupBlock("backup_drovr_seed_not_observed_by_public_status", {
        drovr_status: drovrStatus,
        drovr_seed: drovrSeed.setup,
      });
    }
    runtime = createFlowRuntime({
      env: environment,
      authorityDirectory,
      authorityOptions: { drovrStatusRunner: statusRunner },
      registeredOperations: backupOperationRegistration,
      autonomous: false,
    });
    await seedRetainedBackupState({
      runtime,
      authorityDirectory,
      operationContract: backupOperationContract,
      operationRegistration: backupOperationRegistration,
      environment,
    });
    backup = runtime.command({ type: "backup_create" });
    if (backup?.accepted !== true || !isRecord(backup.manifest) ||
        backup.manifest.schema !== "flow.backup-manifest/v1") {
      return productionBackupBlock(
        "production_backup_command_rejected",
        { backup },
      );
    }
    manifest = backup.manifest;
    const beforeFiles = await listDisposableFiles(authorityDirectory);
    if (beforeFiles.length === 0) {
      return productionBackupBlock(
        "production_backup_recorded_no_disposable_state",
        { manifest_digest: manifest.manifest_digest },
      );
    }
    const gitBefore = await observeGitState(repositoryRoot);
    const backupProjection = runtime.query({ schema: "flow.query/v1", query: "backup" });
    closeFlowRuntime(runtime);
    runtime = null;
    await removeExactDirectory(authorityDirectory);
    loss = {
      destructive_loss: true,
      disposable_only: !(await pathExists(authorityDirectory)),
      protected_state_intact: await protectedStateIntact({
        repositoryRoot,
        gitBefore,
        backupDirectory,
        manifest,
      }),
      lost_paths: beforeFiles,
    };
    if (!loss.disposable_only || !loss.protected_state_intact) {
      return productionBackupBlock("protected_state_changed_or_loss_unproven", { loss });
    }
    restoreRuntime = createFlowRuntime({
      env: environment,
      authorityDirectory,
      authorityOptions: { drovrStatusRunner: statusRunner },
      autonomous: false,
    });
    const restored = restoreRuntime.command({ type: "restore", manifest });
    if (restored?.accepted !== true || restored.receipt?.provider_receipt?.restore_id === undefined) {
      return productionBackupBlock("production_restore_command_rejected", {
        loss,
        restored,
      });
    }
    const reconciling = restoreRuntime.query({ schema: "flow.query/v1", query: "restore" });
    const reconcileAction = reconciling.legal_actions?.find(({ type }) => type === "restore_reconcile");
    if (!reconcileAction) {
      return productionBackupBlock("restore_reconciliation_action_missing", {
        loss,
        restored,
        reconciling,
      });
    }
    const reconciled = restoreRuntime.command(reconcileAction);
    const reconciliation = reconciled?.reconciliation;
    const ready = restoreRuntime.query({ schema: "flow.query/v1", query: "restore" });
    const admissionAction = ready.legal_actions?.find(({ type }) => type === "restore_admit");
    if (!admissionAction) {
      return productionBackupBlock("restore_admission_action_missing", {
        loss,
        restored,
        reconciliation,
      });
    }
    const admitted = restoreRuntime.command(admissionAction);
    const admittedProjection = restoreRuntime.query({ schema: "flow.query/v1", query: "restore" });
    const providerReceipt = backup.receipt?.provider_receipt;
    const nonEmptyDomains = backupEvidenceDomainPopulation(manifest);
    const provider = {
      schema: "flow.filesystem-backup/v1",
      status: "available",
      provider_identity: providerReceipt?.provider ?? "flow.filesystem-backup/v1",
      watermark: backup.authority_watermark,
      manifest_digest: manifest.manifest_digest,
      snapshot_digest: providerReceipt?.snapshot_digest ?? null,
      backup_id: providerReceipt?.backup_id ?? null,
    };
    const domains = reconciliation?.evidence_domains ?? [];
    const proof = {
      backup: {
        production_backup: provider.status === "available" &&
          provider.provider_identity === "flow.filesystem-backup/v1" &&
          provider.snapshot_digest !== null,
        provider: provider.provider_identity,
        manifest_digest: provider.manifest_digest,
        snapshot_digest: provider.snapshot_digest,
        backup_id: provider.backup_id,
        watermark: backup.authority_watermark,
        legal_actions: backupProjection.legal_actions ?? [],
      },
      loss,
      restore: {
        restored: restored.accepted === true,
        manifest_digest: manifest.manifest_digest,
        restore_id: restored.receipt.provider_receipt.restore_id,
        watermark: restored.authority_watermark,
      },
      reconciliation: {
        domains_reconciled: domains.filter(({ status }) => status === "reconciled").length,
        complete: reconciliation?.complete === true,
        non_empty_domains: nonEmptyDomains,
        all_domains_non_empty: Object.values(nonEmptyDomains).every(Boolean),
        manifest_digest: reconciliation?.manifest_digest ?? null,
        domains,
        watermark: reconciled.authority_watermark,
      },
      drovr_status: {
        observed: true,
        command: "drovr status",
        turn_id: drovrSeed.turn_id,
        status: observedSeed.status,
        provenance: "public_process",
        output_digest: canonicalDigest(drovrStatus),
      },
      admission: {
        retained_result_admitted: admitted.accepted === true && admittedProjection.state === "admitted",
        manifest_digest: manifest.manifest_digest,
        result_digest: admitted.receipt?.reconciliation_digest ?? reconciliation?.reconciliation_digest ?? null,
        explicit: true,
        watermark: admitted.authority_watermark,
      },
    };
    const status = proof.backup.production_backup && proof.loss.destructive_loss &&
      proof.loss.disposable_only && proof.loss.protected_state_intact &&
      proof.restore.restored && proof.reconciliation.domains_reconciled === 6 &&
      proof.reconciliation.complete && proof.reconciliation.all_domains_non_empty &&
      proof.admission.retained_result_admitted
      ? "pass"
      : "blocked";
    closeFlowRuntime(restoreRuntime);
    restoreRuntime = null;
    cleanup = await completeAuthorityCleanup(authorityDirectory, {
      statusSandboxDirectory,
    });
    return {
      schema: "flow.production-backup-live-observation/v1",
      status,
      provider,
      manifest,
      proof,
      authority_directory: authorityDirectory,
      backup_directory: backupDirectory,
      repository_root: repositoryRoot,
      cleanup,
      reason: status === "pass" ? null : "production_backup_restore_proof_incomplete",
    };
  } catch (error) {
    return productionBackupBlock(
      error?.code ?? "production_backup_probe_failed",
      { detail: safeErrorMessage(error), manifest_digest: manifest?.manifest_digest ?? null },
    );
  } finally {
    if (runtime !== null) closeFlowRuntime(runtime);
    if (restoreRuntime !== null) {
      closeFlowRuntime(restoreRuntime);
      try {
        await completeAuthorityCleanup(authorityDirectory, {
          statusSandboxDirectory,
        });
      } catch {
        // The returned proof remains truthful; the caller retains the exact
        // authority path as an explicit cleanup obligation.
      }
    }
    if (await pathExists(authorityDirectory) || await pathExists(statusSandboxDirectory)) {
      try {
        await completeAuthorityCleanup(authorityDirectory, {
          statusSandboxDirectory,
        });
      } catch {
        // Preserve a blocked result; the caller owns the retained exact path.
      }
    }
  }
}

function backupEvidenceDomainPopulation(manifest) {
  return {
    database_streams: Array.isArray(manifest?.replacement_authority?.database_streams) &&
      manifest.replacement_authority.database_streams.length > 0,
    artifact_state: Array.isArray(manifest?.artifacts) && manifest.artifacts.length > 0,
    git_state: isRecord(manifest?.replacement_authority?.git_state) &&
      typeof manifest.replacement_authority.git_state.commit === "string" &&
      typeof manifest.replacement_authority.git_state.tree === "string",
    filesystem_state: Array.isArray(manifest?.replacement_authority?.filesystem_state) &&
      manifest.replacement_authority.filesystem_state.length > 0,
    external_effects: Array.isArray(manifest?.external_pointers) &&
      manifest.external_pointers.length > 0,
    drovr_obligations: Array.isArray(manifest?.drovr_obligations) &&
      manifest.drovr_obligations.length > 0,
  };
}

async function seedDrovrObligationState(registryDirectory) {
  const turnId = "turn:issue-46-backup-retained";
  const authorityWatermark = {
    schema: "drovr.registry-authority-watermark/v1",
    generation: `sha256:${"b".repeat(64)}`,
    registry_sha256: `sha256:${"c".repeat(64)}`,
  };
  const receipt = {
    schema: "flow.drovr-handoff-receipt/v1",
    turn_id: turnId,
    disposition: "handoff",
    durable_holder: "issue-46-retained-backup",
    handoff_receipt_id: "handoff:issue-46-retained-backup",
    outcome: "handed_off",
  };
  await writeRecord(registryDirectory, "turns", {
    schema: "drovr.turn/v1",
    id: turnId,
    task_id: "task:issue-46-backup",
    agent_id: "agent:issue-46-backup",
    // This active turn is the retained obligation which the real public
    // status command must expose. The direct registry write is setup-only.
    status: "working",
    inputs: [{ sequence: 1, text: "retained backup obligation" }],
    receipt,
  });
  return {
    status: {
      schema: "drovr.command/v1",
      command: "status",
      ok: true,
      result: {
        authority_watermark: authorityWatermark,
        agents: [],
        turns: [{
          id: turnId,
          task_id: "task:issue-46-backup",
          agent_id: "agent:issue-46-backup",
          status: "working",
          receipt,
        }],
      },
    },
    turn_id: turnId,
    setup: {
      method: "direct_registry_write_setup_only",
      turn_id: turnId,
      expected_status: "working",
    },
  };
}

function runPinnedDrovrStatus(environment) {
  const stdout = execFileSync(process.execPath, [DROVR_CLI_PATH, "status"], {
    cwd: dirname(DROVR_CLI_PATH),
    env: {
      ...environment,
    },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new LiveSupportConfigurationError(
      "backup_drovr_observation_invalid",
      `pinned drovr status returned invalid JSON: ${error.message}`,
    );
  }
}

function sanitizedDrovrStatusEnvironment(input, statusSandboxDirectory) {
  const inherited = Object.fromEntries(
    Object.entries(input ?? {}).filter(([key, value]) =>
      DROVR_STATUS_ENVIRONMENT_KEYS.has(key) && typeof value === "string"),
  );
  const privateRoot = resolve(statusSandboxDirectory);
  return {
    ...inherited,
    HOME: join(privateRoot, "drovr-status-home"),
    TMPDIR: join(privateRoot, "drovr-status-tmp"),
    XDG_STATE_HOME: join(privateRoot, "drovr-status-state"),
  };
}

async function seedRetainedBackupState({
  runtime,
  authorityDirectory,
  operationContract,
  operationRegistration,
  environment,
}) {
  const authority = flowRuntimeAuthority(runtime);
  const artifactAuthority = getArtifactAuthority({ runAuthority: authority });
  if (artifactAuthority?.schema !== "work.artifact-authority/v1") {
    throw new LiveSupportConfigurationError(
      "backup_artifact_authority_unavailable",
      "production backup qualification could not access the retained artifact authority",
    );
  }
  const artifactBytes = Buffer.from("issue-46 retained artifact\n", "utf8");
  const artifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  const artifactDirectory = join(authorityDirectory, "artifacts");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(artifactDirectory, artifactDigest.slice("sha256:".length)), artifactBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const artifactReceipt = artifactAuthority.command({
    schema: "work.artifact-record-command/v1",
    command_id: `artifact-record:${artifactDigest}`,
    type: "artifact_record",
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
    expected_generation: 0,
    artifact: {
      digest: artifactDigest,
      artifact_schema: "flow.issue-46-retained-artifact/v1",
      size: artifactBytes.length,
      provenance: {
        producer: { run_id: "run:issue-46-backup-seed", evidence: artifactDigest },
        validator: { contract: "flow.issue-46-backup-validator/v1", receipt: artifactDigest },
      },
      classification: "internal",
      retention: "durable_handoff",
      pins: [{ holder: "run", id: "run:issue-46-backup-seed" }],
    },
    bytes_base64: artifactBytes.toString("base64"),
  });
  if (artifactReceipt?.accepted !== true) {
    throw new LiveSupportConfigurationError(
      "backup_artifact_seed_rejected",
      "production backup qualification could not retain its artifact seed",
    );
  }

  const seedRuntime = createCoreFlowRuntime({
    runAuthority: authority,
    ...(() => {
      const composition = createProductionComposition({
        delegatedAgentPort: createDrovrDelegatedAgentPort({
          dependencies: { env: environment },
        }),
        env: environment,
        authorityDirectory,
        legacyRoots: {},
        authorityOptions: {},
        registeredOperations: operationRegistration,
      });
      return {
        registeredOperations: composition.operations,
        registeredAuthorities: composition.authorities,
        predefinedDefinitions: composition.definitions,
        delegateOutputValidators: composition.validators,
      };
    })(),
    autonomous: true,
  });
  try {
    const authorityProjection = seedRuntime.query({});
    const bootId = authorityProjection?.authority_boot_id;
    if (typeof bootId !== "string" || bootId.length === 0) {
      throw new LiveSupportConfigurationError(
        "backup_external_effect_boot_identity_unavailable",
        "production backup qualification could not observe the authority boot identity",
      );
    }
    const registered = seedRuntime.prepare(backupSeedProposal({
      contract: operationContract,
      bootId,
    }));
    if (registered?.schema !== "flow.prepared-run/v1") {
      throw new LiveSupportConfigurationError(
        "backup_external_effect_prepare_rejected",
        "production backup qualification could not prepare its external-effect seed",
      );
    }
    const launch = seedRuntime.launch(confirmedBackupLaunchRequest(registered));
    if (launch?.schema !== "flow.launch-receipt/v1") {
      throw new LiveSupportConfigurationError(
        "backup_external_effect_launch_rejected",
        "production backup qualification could not launch its external-effect seed",
      );
    }
    const action = seedRuntime.query({ run_id: launch.run_id }).legal_actions?.find(({ type }) =>
      type === "operation_execute");
    if (!action || seedRuntime.command(action)?.accepted !== true) {
      throw new LiveSupportConfigurationError(
        "backup_external_effect_command_rejected",
        "production backup qualification could not settle its external-effect seed",
      );
    }
    const settled = await waitForSettledEffect(seedRuntime, launch.run_id);
    if (settled?.effects?.[0]?.status !== "succeeded" ||
        settled.effects[0].receipt?.provider_receipt?.provider_receipt_id === undefined ||
        settled.effects[0].receipt?.provider_receipt?.record !== "issue-46-backup-seed") {
      throw new LiveSupportConfigurationError(
        "backup_external_effect_unsettled",
        "production backup qualification external-effect seed did not settle with a receipt",
      );
    }
  } finally {
    stopAutonomousFlowRuntime(seedRuntime);
  }
}

function backupSeedProposal({ contract, bootId }) {
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards: [{
        id: "seed-external-effect",
        executor: { kind: "operation", contract, effect_classification: "caller_idempotent" },
        dependencies: [],
        inputs: { value: "issue-46-retained-external-effect" },
        outputs: ["receipt"],
        success_criteria: ["receipt:succeeded"],
        validators: ["flow.validator/operation-receipt/v1"],
        data_references: [],
        evidence_references: [],
        route: { adapter: "issue-46-backup-seed" },
        limits: { max_attempts: 1 },
        resource_claims: [{ kind: "issue-46-backup-effect", id: "retained" }],
        recovery: "caller_idempotent",
      }],
    },
    requested_authority: {
      commands: ["operation_execute"],
      capabilities: [],
      mutations: [contract],
    },
    explicit_facts: {
      catalog_fingerprint: `sha256:${"d".repeat(64)}`,
      route_snapshot: { watermark: `sha256:${"e".repeat(64)}`, bindings: [] },
      capability_envelopes: [],
      operation_contracts: [contract],
      validator_contracts: ["flow.validator/operation-receipt/v1"],
      block_observations: [],
      time_facts: [
        {
          schema: "flow.time-fact/v1",
          kind: "wall_clock",
          value_ms: Date.now(),
          uncertainty_ms: 0,
          clock_source_id: "wall:issue-46-backup-seed",
        },
        {
          schema: "flow.time-fact/v1",
          kind: "suspend_excluding_monotonic",
          value_ns: `${BigInt(Date.now()) * 1_000_000n}`,
          uncertainty_ns: "0",
          clock_source_id: "mono:issue-46-backup-seed",
        },
        { schema: "flow.time-fact/v1", kind: "boot", boot_id: bootId },
        { schema: "flow.time-fact/v1", kind: "clock_source", identity: "clockset:issue-46-backup-seed:v1" },
      ],
      subject_generations: [],
      elapsed_seconds: 0,
      limits: {
        max_cards: 1,
        max_revisions: 0,
        max_cards_per_revision: 0,
        max_capabilities: 0,
        max_resources: 1,
        max_elapsed_seconds: 300,
      },
      resource_claims: [{ kind: "issue-46-backup-effect", id: "retained" }],
    },
  };
}

function confirmedBackupLaunchRequest(prepared) {
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

async function waitForSettledEffect(runtime, runId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const projection = runtime.query({ run_id: runId });
    if (["succeeded", "failed", "uncertain", "cancelled"].includes(projection?.effects?.[0]?.status)) {
      return projection;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  return runtime.query({ run_id: runId });
}

function productionBackupBlock(reason, details = {}) {
  return {
    schema: "flow.production-backup-live-observation/v1",
    status: "blocked",
    reason,
    provider: null,
    proof: {},
    ...details,
  };
}

async function completeAuthorityCleanup(authorityDirectory, {
  statusSandboxDirectory = undefined,
} = {}) {
  const ownedResources = [
    { kind: "isolated_authority", identity_ref: authorityDirectory },
    ...(statusSandboxDirectory === undefined
      ? []
      : [{ kind: "isolated_drovr_status_sandbox", identity_ref: statusSandboxDirectory }]),
  ];
  for (const resource of ownedResources) {
    if (await pathExists(resource.identity_ref)) {
      await removeExactDirectory(resource.identity_ref);
    }
    if (await pathExists(resource.identity_ref)) {
      throw new LiveSupportConfigurationError(
        "destructive_cleanup_unproven",
        `owned cleanup resource remains after removal: ${resource.identity_ref}`,
      );
    }
  }
  return {
    disposition: "complete",
    owned_resources: ownedResources,
    resource_dispositions: ownedResources.map((resource) => ({
      ...resource,
      disposition: "removed",
      proof: "absent_after_cleanup",
    })),
    unresolved_obligations: [],
    completed_at: new Date().toISOString(),
  };
}

async function protectedStateIntact({ repositoryRoot, gitBefore, backupDirectory, manifest }) {
  const gitAfter = await observeGitState(repositoryRoot);
  const backupPath = join(backupDirectory, manifest.manifest_digest.slice("sha256:".length));
  return gitBefore.commit === gitAfter.commit &&
    gitBefore.tree === gitAfter.tree &&
    gitAfter.clean === true &&
    await pathExists(backupPath);
}

async function observeGitState(repositoryRoot) {
  const [commit, tree, status] = await Promise.all([
    execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }),
    execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }),
    execFileAsync("git", ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }),
  ]);
  return {
    commit: commit.stdout.trim(),
    tree: tree.stdout.trim(),
    clean: status.stdout.trim() === "",
  };
}

async function listDisposableFiles(root, current = root, output = []) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new LiveSupportConfigurationError(
        "backup_source_symlink",
        `production backup state contains a symlink: ${path}`,
      );
    }
    if (entry.isDirectory()) await listDisposableFiles(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path));
  }
  return output.sort();
}

async function removeExactDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LiveSupportConfigurationError(
      "destructive_target_invalid",
      `refusing to remove non-directory or symlink target: ${path}`,
    );
  }
  await rm(path, { recursive: true, force: false });
  if (await pathExists(path)) {
    throw new LiveSupportConfigurationError(
      "destructive_cleanup_unproven",
      `disposable directory remains after removal: ${path}`,
    );
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function validateSupportInputs({ entrypoints, isolation, rawRoot, timeoutMs }) {
  if (!isRecord(entrypoints) || !isRecord(entrypoints.node) ||
      !isAbsolute(entrypoints.node.path) || !isRecord(entrypoints.launcher) ||
      !isAbsolute(entrypoints.launcher.path)) {
    throw new LiveSupportConfigurationError(
      "pinned_entrypoints_required",
      "live support requires absolute pinned Node and launcher entrypoints",
    );
  }
  if (!isRecord(isolation) || typeof isolation.worktree_root !== "string" ||
      !isAbsolute(isolation.worktree_root) || typeof isolation.run_id !== "string") {
    throw new LiveSupportConfigurationError(
      "isolation_required",
      "live support requires one explicit qualification isolation",
    );
  }
  if (typeof rawRoot !== "string" || !isAbsolute(rawRoot)) {
    throw new LiveSupportConfigurationError(
      "raw_root_required",
      "live support requires an absolute external raw root",
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new LiveSupportConfigurationError(
      "timeout_invalid",
      `live support timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}ms`,
    );
  }
}

async function parsePublicOutput(command, rawRoot) {
  const path = command.logs?.stdout?.path;
  if (typeof path !== "string") return null;
  try {
    return parseJsonLines(await readFile(join(rawRoot, "logs", path), "utf8"));
  } catch {
    return null;
  }
}

function parseJsonLines(value) {
  const parsed = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { schema: "flow.unparsed-public-output/v1", text: line };
      }
    });
  return parsed.length === 1 ? parsed[0] ?? null : parsed;
}

function nativeDelegateBlock(reason, details = {}) {
  const content = { schema: "flow.native-delegate-observation/v1", status: "blocked", ...details };
  return Object.freeze({
    ...content,
    provider_identity: "drovr/unavailable",
    watermark: `sha256:${sha256(Buffer.from(JSON.stringify(content)))}`,
    invocation_count: 0,
    dispatch_attempted: false,
    reason: `${reason}; native delegate dispatch is not attempted by read-only support`,
  });
}

function canonicalCommand(nodePath, drovrPath, args) {
  return {
    argv: [nodePath, drovrPath, ...args],
    node_path: nodePath,
    drovr_path: drovrPath,
    args: [...args],
  };
}

function headlessCaptureSources({ commandResults, isolation }) {
  const byKind = new Map(commandResults.map(({ command, output }) => [command.command_kind, output]));
  const values = new Map([
    ["terminal", terminalValue(commandResults)],
    ["status", byKind.get("status")],
    ["checkpoint", byKind.get("query")?.views?.operator ?? byKind.get("query")?.checkpoint],
    ["candidate", byKind.get("query")?.candidate ?? byKind.get("query")?.candidate_view],
    ["review", byKind.get("query")?.review ?? byKind.get("query")?.review_projection ?? byKind.get("query")],
    ["graph", byKind.get("query")?.views?.graph],
    ["timeline", byKind.get("query")?.views?.timeline],
    ["tuicr", byKind.get("query")?.tuicr],
  ]);
  const missing = [...values.entries()]
    .filter(([, value]) => value === undefined || value === null)
    .map(([kind]) => kind);
  if (missing.length > 0) {
    return {
      status: "blocked",
      reason: "headless_capture_forms_not_publicly_observed",
      missing,
      provenance: "native_provider",
      isolation_run_id: isolation.run_id,
    };
  }
  const digests = new Set();
  const captures = [];
  for (const [kind, value] of values) {
    const bytes = Buffer.from(`${JSON.stringify({ kind, value })}\n`);
    const sha = `sha256:${sha256(bytes)}`;
    if (digests.has(sha)) {
      return {
        status: "blocked",
        reason: "headless_capture_forms_not_distinct",
        duplicate: kind,
      };
    }
    digests.add(sha);
    const watermark = extractWatermark(value);
    if (!DIGEST.test(watermark ?? "")) {
      return {
        status: "blocked",
        reason: "headless_capture_watermark_missing",
        missing_watermark: kind,
      };
    }
    captures.push({
      kind,
      format: typeof value === "string" ? "text" : "json",
      value: structuredClone(value),
      watermark,
      legal_actions: legalActionStatus(value),
      legibility: "pass",
      provenance: "native_provider",
      sha256: sha,
    });
  }
  // These values came from the public process command seam. They are useful
  // diagnostic candidates, but the catalog's native_provider provenance must
  // come from an independent headless capture process. Never relabel public
  // output as native evidence merely to satisfy the scenario predicate.
  return {
    status: "blocked",
    reason: "headless_capture_requires_independent_native_capture",
    provenance: "public_process",
    candidate_captures: captures,
  };
}

function terminalValue(commandResults) {
  const result = commandResults.find(({ command }) => command.command_kind === "status") ??
    commandResults[0];
  if (!result) return undefined;
  return {
    schema: "flow.headless-terminal-capture/v1",
    command: result.command.argv,
    output: result.output,
    watermark: extractWatermark(result.output),
  };
}

function projectionFacts({ commandResults }) {
  const query = commandResults.find(({ command }) => command.command_kind === "query");
  const watch = commandResults.find(({ command }) => command.command_kind === "watch");
  const samples = [query, watch]
    .map(({ command }) => command.duration_ms)
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  const queryValue = query?.output;
  const watchValue = watch?.output;
  const viewValues = queryValue?.views ?? {};
  const viewIds = Object.keys(viewValues).filter((id) => viewValues[id] !== null);
  const queryObserved = Boolean(extractWatermark(queryValue));
  const watchObserved = Boolean(extractWatermark(watchValue));
  return {
    status: queryObserved && watchObserved && samples.length >= 2 && viewIds.length >= 2
      ? "pass"
      : "blocked",
    proof: {
      query: { observed: queryObserved, watermark: extractWatermark(queryValue) },
      watch: { observed: watchObserved, watermark: extractWatermark(watchValue) },
      rebuild: {
        without_mutation_lock: false,
        mutation_lock_acquired: null,
        projection_identity_stable: false,
        rebuild_count: 0,
      },
      views: { count: viewIds.length, view_ids: viewIds },
      latency: { samples, history_entries: viewIds.length },
    },
    reason: queryObserved && watchObserved && samples.length >= 2 && viewIds.length >= 2
      ? null
      : "projection_rebuild_requires_runtime_view-rebuild_observation",
  };
}

async function observeTuicrFacts({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  tuicrBinary = undefined,
} = {}) {
  const binary = tuicrBinary;
  if (typeof binary !== "string" || !isAbsolute(binary)) {
    return {
      status: "blocked",
      reason: "tuicr_binary_not_bound",
      producer_exited: false,
      disposition: false,
      stale_action: false,
      rebuild: false,
    };
  }
  try {
    const result = await execFileAsync(binary, ["--version"], {
      cwd: isolation.worktree_root,
      env: isolatedQualificationEnvironment(isolation),
      timeout: boundedTimeout(timeoutMs, DEFAULT_TIMEOUT_MS),
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return {
      status: "blocked",
      reason: "tuicr_review_projection_not_observed",
      binary,
      version: String(result.stdout).trim(),
      stdout_sha256: sha256(Buffer.from(result.stdout)),
      producer_exited: false,
      disposition: false,
      stale_action: false,
      rebuild: false,
      raw_root: rawRoot,
      node_path: entrypoints.node.path,
    };
  } catch (error) {
    return {
      status: "blocked",
      reason: "tuicr_process_unavailable",
      error_code: error.code ?? null,
      producer_exited: false,
      disposition: false,
      stale_action: false,
      rebuild: false,
    };
  }
}

function observeSuspendedAdmissionFacts({ commandResults, actualReboot = false } = {}) {
  const outputs = commandResults.map(({ output }) => output);
  const suspended = outputs.find((output) => output?.suspended === true || output?.proof?.suspended);
  const admission = outputs.find((output) => output?.command_type === "reboot_admission" || output?.proof?.admission);
  return {
    status: suspended && admission ? "blocked" : "blocked",
    reason: "suspended_run_requires_a_real_suspended_projection_and_explicit_admission",
    proof: {
      suspended: {
        observed: Boolean(suspended),
        simulated_boot: Boolean(suspended?.simulated_boot),
        prior_boot_id: suspended?.prior_boot_id ?? null,
        current_boot_id: suspended?.current_boot_id ?? null,
        admission: suspended?.admission ?? null,
      },
      admission: {
        explicit: Boolean(admission),
        command_type: admission?.command_type ?? null,
        simulated_boot: Boolean(admission?.simulated_boot),
        action_identity: admission?.action_identity ?? null,
      },
      reboot: {
        actual_reboot: actualReboot === true,
        deferred: actualReboot !== true,
        simulated: actualReboot !== true,
        boot_identity_observed: Boolean(suspended),
      },
    },
  };
}

async function negativeTakeoverAttempt({ registryDirectory, resourceKey, operation, mode }) {
  const requestedOption = mode === "age" ? "staleAfterMs" : "force";
  try {
    await acquireResourceLock(registryDirectory, resourceKey, {
      operation,
      authorityId: `issue-46-negative-${mode}`,
      maxAttempts: 1,
      retryDelayMs: 1,
      ...(mode === "age" ? { staleAfterMs: 0 } : { force: true }),
    });
    return {
      action: mode === "age" ? "age_takeover" : "force_takeover",
      requested_option: requestedOption,
      rejected: false,
      accepted: true,
      mutated: true,
      code: "unexpected_takeover",
      watermark: `sha256:${"0".repeat(64)}`,
    };
  } catch (error) {
    const projection = await resourceLockProjection(registryDirectory);
    return {
      action: mode === "age" ? "age_takeover" : "force_takeover",
      requested_option: requestedOption,
      rejected: true,
      accepted: false,
      mutated: false,
      code: error?.outcome ?? error?.code?.toString() ?? "registry_lock_recovery_required",
      outcome: error?.outcome ?? "registry_lock_recovery_required",
      watermark: projection.authority_watermark?.generation
        ? `sha256:${projection.authority_watermark.generation.slice("sha256:".length)}`
        : `sha256:${"0".repeat(64)}`,
      operation_id: operation.id,
      api_rejection: error?.outcome === "invalid_arguments" &&
        error?.details?.unsupported_options?.includes(requestedOption) === true,
      unsupported_options: error?.details?.unsupported_options ?? [],
    };
  }
}

function cleanupReceipt({ registryDirectory, lockPath, finalProjection, registryRemoved, completedAt }) {
  const resources = [
    { kind: "isolated_registry_directory", identity_ref: registryDirectory },
    { kind: "isolated_registry_lock", identity_ref: lockPath },
  ];
  return {
    disposition: finalProjection.locks.length === 0 && registryRemoved ? "complete" : "blocked",
    owned_resources: resources,
    resource_dispositions: resources.map((resource) => ({
      ...resource,
      disposition: registryRemoved ? "removed" : "retained",
      proof: registryRemoved ? "absent_after_cleanup" : "live_resource_remains",
    })),
    unresolved_obligations: finalProjection.locks.length === 0 && registryRemoved ? [] : [{
      code: "registry_lock_remains",
      resource_key: finalProjection.locks[0]?.resource_key ?? null,
    }],
    completed_at: completedAt,
  };
}

async function waitForReady(streamState, timeoutMs) {
  const deadline = Date.now() + boundedTimeout(timeoutMs, DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const value = parseJsonLines(streamState.value());
    if (value?.ready === true) return value;
    if (streamState.closed()) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new LiveSupportConfigurationError(
    "drovr_lock_owner_timeout",
    "isolated Drovr lock owner did not publish before the bounded timeout",
  );
}

function collectStream(stream) {
  let value = "";
  let closed = false;
  stream?.on("data", (chunk) => { value += chunk.toString(); });
  stream?.on("close", () => { closed = true; });
  return {
    value: () => value,
    closed: () => closed,
  };
}

function observeChildExit(child) {
  return new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function assertDisposableRoot(path, label) {
  const absolute = resolve(path);
  const temporary = resolve(tmpdir());
  const relativePath = relative(temporary, absolute);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new LiveSupportConfigurationError(
      "mutable_root_not_disposable",
      `${label} must be below the host temporary directory`,
    );
  }
  return absolute;
}

function boundedTimeout(value, fallback) {
  return Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS
    ? value
    : fallback;
}

function extractWatermark(value) {
  if (!isRecord(value)) return null;
  for (const candidate of [value.watermark, value.authority_watermark, value.review_watermark]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (isRecord(candidate)) {
      if (typeof candidate.generation === "string") return `sha256:${candidate.generation.replace(/^sha256:/u, "")}`;
      if (typeof candidate.content_sha256 === "string") return candidate.content_sha256;
      if (typeof candidate.registry_sha256 === "string") return candidate.registry_sha256;
      return `sha256:${canonicalDigest(candidate).slice("sha256:".length)}`;
    }
  }
  return null;
}

function legalActionStatus(value) {
  const actions = value?.legal_actions ?? value?.legal_next_actions;
  return Array.isArray(actions) ? "pass" : "not_observed";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorMessage(error) {
  return typeof error?.message === "string" ? error.message : String(error);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

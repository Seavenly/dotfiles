#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_RECOVERY_SCENARIOS,
  assertExternalQualificationRoot,
  assertQualificationPathDisjoint,
  cleanupQualificationIsolation,
  createQualificationIsolation,
  derivePinnedReleaseIdentity,
  isolatedQualificationEnvironment,
  qualificationHostIdentity,
  qualificationIsolationIdentity,
  redactQualificationCapture,
  readRawQualificationReceipt,
  resolvePinnedEntrypoints,
  resolvePinnedQualificationTools,
  runPinnedPublicCommand,
  writeQualificationFailureCleanupReceipt,
  writeRawQualificationReceipt,
} from "../src/host-recovery-qualification.mjs";
import {
  runHostRecoveryRuntimeScenario,
  buildHostRecoveryRawReceipt,
} from "../src/host-recovery-runtime-scenarios.mjs";
import {
  runHostRecoveryOperatorScenario,
} from "../src/host-recovery-operator-scenarios.mjs";
import {
  adaptProjectionReaderProbeResult,
  adaptSuspendedAdmissionProbeResult,
  READER_PROBE_COMMAND_KINDS,
} from "../src/host-recovery-reader-integration.mjs";
import {
  resolvePinnedTuicrPath,
  seedTuicrSession,
} from "../src/host-recovery-tuicr-live-integration.mjs";
import { runTuicrCli } from "../src/host-recovery-tuicr-scenario.mjs";
import {
  startFlowOwner,
  stopFlowOwner,
} from "../src/owner-process.mjs";
import {
  initializePublicReviewRepository,
  seedPublicReview,
} from "../test-support/public-review-seed.mjs";
import {
  digest as canonicalDigest,
} from "../../../tools/flow/src/canonical.mjs";
import {
  confirmedLaunchRequest,
} from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import {
  registeredOperationProposal,
} from "../../../tools/flow/test-support/registered-operation.mjs";

const configDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(configDirectory, "../..");
const HEADLESS_RECEIPT_MANIFEST = "public-command-receipts.json";

async function main() {
let options;
let worktreeRoot;
let rawRoot;
let scenario;
let isolation;
let entrypoints;
let release;
let tools;
let cleanup;
let scenarioResult;
let ownershipBegan = false;
let headlessOwnerStarted = false;
let failure;
const startedAt = new Date().toISOString();
const RUNTIME_SCENARIO_IDS = new Set([
  "backup_restore_reconciliation",
  "projection_rebuild_readers",
  "suspended_run_admission",
]);

try {
  options = parseArgs(process.argv.slice(2));
  worktreeRoot = requiredAbsolute(options, "worktree");
  rawRoot = assertExternalQualificationRoot(requiredAbsolute(options, "raw-root"), {
    worktreeRoot,
  });
  scenario = HOST_RECOVERY_SCENARIOS.find(({ id }) => id === options.scenario);
  if (!scenario) throw new Error(`unknown issue-46 scenario: ${options.scenario ?? ""}`);
  isolation = createQualificationIsolation({
    worktreeRoot,
    xdgStateHome: requiredAbsolute(options, "xdg-state-home"),
    authorityDirectory: requiredAbsolute(options, "authority-directory"),
    socketPath: requiredAbsolute(options, "socket"),
    endpointPath: requiredAbsolute(options, "endpoint"),
    backupDirectory: requiredAbsolute(options, "backup-directory"),
    repositoryRoot: requiredAbsolute(options, "repository-root"),
    drovrConfigDirectory: requiredAbsolute(options, "drovr-config-directory"),
    herdrSession: required(options, "herdr-session"),
    runId: required(options, "run-id"),
    runtimeDirectory: options["runtime-directory"] === undefined
      ? undefined
      : requiredAbsolute(options, "runtime-directory"),
  });
  ownershipBegan = true;
  assertQualificationPathDisjoint(rawRoot, {
    worktreeRoot,
    isolation,
    label: "rawRoot",
  });
  entrypoints = resolvePinnedEntrypoints({ worktreeRoot });
  release = derivePinnedReleaseIdentity({ worktreeRoot });
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  const driverOptions = {
    entrypoints,
    isolation,
    rawRoot,
    timeoutMs: options.timeout === undefined ? 120_000 : Number(options.timeout),
    commandRunner: publicCommandRunner,
    ...(scenario.id === "ubuntu_headless_text_captures" ? {
      toolRunner: nativeHeadlessProviderRunner({
        entrypoints,
        isolation,
        rawRoot,
        timeoutMs: options.timeout === undefined ? 120_000 : Number(options.timeout),
        worktreeRoot,
        release,
      }),
    } : {}),
  };
  if (scenario.id === "concurrent_runs_owner_restart" ||
      scenario.id === "actionable_failure_recovery") {
    scenarioResult = await runNativeProviderQualificationScenario({
      scenarioId: scenario.id,
      entrypoints,
      isolation,
      rawRoot,
      timeoutMs: driverOptions.timeoutMs,
      worktreeRoot,
    });
  } else if (scenario.id === "backup_restore_reconciliation") {
    scenarioResult = await runHostRecoveryRuntimeScenario(scenario.id, {
      ...driverOptions,
      nativeBackupRestoreProbe: nativeBackupRestoreProbeRunner({
        entrypoints,
        isolation,
        rawRoot,
        timeoutMs: driverOptions.timeoutMs,
        worktreeRoot,
      }),
    });
  } else if (scenario.id === "drovr_registry_lock_reconciliation") {
    scenarioResult = await runHostRecoveryOperatorScenario(scenario.id, {
      ...driverOptions,
      nativeDrovrLockProbe: nativeDrovrLockProbeRunner({
        entrypoints,
        isolation,
        rawRoot,
        timeoutMs: driverOptions.timeoutMs,
        worktreeRoot,
      }),
      cleanupRunner: () => cleanupQualificationIsolation(isolation),
    });
  } else if (scenario.id === "ubuntu_headless_text_captures") {
    const headlessSeed = await seedHeadlessPublicReview({
      worktreeRoot,
      isolation,
      rawRoot,
    });
    await startHeadlessPublicOwner({ entrypoints, isolation });
    headlessOwnerStarted = true;
    await captureHeadlessCheckpointProjection({
      entrypoints,
      isolation,
      rawRoot,
      timeoutMs: driverOptions.timeoutMs,
    });
    await captureHeadlessSeededProjections({
      entrypoints,
      isolation,
      rawRoot,
      seeded: headlessSeed.seeded,
    });
    await captureHeadlessTuicrConsumer({
      isolation,
      rawRoot,
      seeded: headlessSeed.seeded,
      session: headlessSeed.tuicr,
      timeoutMs: driverOptions.timeoutMs,
    });
    scenarioResult = await runHostRecoveryOperatorScenario(scenario.id, {
      ...driverOptions,
      cleanupRunner: () => cleanupHeadlessPublicOwner(isolation, () => {
        headlessOwnerStarted = false;
      }),
    });
  } else if (scenario.id === "tuicr_review_after_producer_exit") {
    scenarioResult = await runNativeTuicrQualificationScenario({
      entrypoints,
      isolation,
      rawRoot,
      timeoutMs: driverOptions.timeoutMs,
      worktreeRoot,
    });
  } else if (scenario.id === "projection_rebuild_readers" ||
      scenario.id === "suspended_run_admission") {
    scenarioResult = await runNativeReaderQualificationScenario({
      scenarioId: scenario.id,
      entrypoints,
      isolation,
      rawRoot,
      timeoutMs: driverOptions.timeoutMs,
      worktreeRoot,
    });
  } else {
    scenarioResult = RUNTIME_SCENARIO_IDS.has(scenario.id)
      ? await runHostRecoveryRuntimeScenario(scenario.id, driverOptions)
      : await runHostRecoveryOperatorScenario(scenario.id, {
        ...driverOptions,
        cleanupRunner: () => cleanupQualificationIsolation(isolation),
      });
  }
  cleanup = scenarioResult.cleanup;
  tools = toolIdentity(entrypoints, { herdrBinary: options["herdr-binary"] });
} catch (error) {
  failure = error;
} finally {
  if (ownershipBegan && cleanup === undefined) {
    try {
      if (headlessOwnerStarted) {
        await stopHeadlessPublicOwner(isolation);
        headlessOwnerStarted = false;
      }
      cleanup = cleanupQualificationIsolation(isolation);
    } catch (error) {
      cleanup = blockedCleanup(isolation, error);
      failure ??= error;
    }
  }
}

function retainFailureReceipt(error) {
  if (!ownershipBegan || !rawRoot || !isolation) return;
  try {
    writeQualificationFailureCleanupReceipt(
      `${scenario?.id ?? "qualification"}-cleanup-failure.json`,
      {
        runId: isolation.run_id,
        scenarioId: scenario?.id ?? null,
        isolation,
        cleanup: cleanup ?? blockedCleanup(isolation, error),
        error,
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      { rawRoot },
    );
  } catch (receiptError) {
    process.stderr.write(`failure cleanup receipt unavailable: ${receiptError.message}\n`);
  }
}

if (failure) {
  retainFailureReceipt(failure);
  throw failure;
}

try {
  const host = hostIdentity();
  const receipt = scenarioResult.schema === "flow.host-recovery-runtime-scenario/v1"
    ? buildHostRecoveryRawReceipt({
      scenarioResult,
      release,
      host,
      tools,
      isolation,
      rawRoot,
    })
    : buildOperatorRawReceipt({
      scenarioResult,
      release,
      host,
      tools,
      isolation,
    });
  const receiptPath = `${scenario.id}.json`;
  const written = writeRawQualificationReceipt(receiptPath, receipt, { rawRoot });
  const verified = readRawQualificationReceipt(receiptPath, { rawRoot });
  process.stdout.write(`${JSON.stringify({
    schema: verified.schema,
    status: verified.result.disposition,
    scenario_id: verified.scenario_id,
    receipt_path: written.path,
    receipt_sha256: written.sha256,
    commands: verified.commands.length,
  }, null, 2)}\n`);
} catch (error) {
  retainFailureReceipt(error);
  throw error;
}

}

async function startHeadlessPublicOwner({ entrypoints, isolation }) {
  return startFlowOwner({
    env: {
      ...isolatedQualificationEnvironment(isolation),
      FLOW_PUBLIC_REPOSITORY: isolation.repository_root,
      FLOW_OWNER_RUNTIME_MODULE: join(
        isolation.worktree_root,
        "config/flow/test-support/public-owner-runtime.mjs",
      ),
    },
    authorityDirectory: isolation.authority_directory,
    endpointPath: isolation.endpoint_path,
    socketPath: isolation.socket_path,
    ownerScript: entrypoints.host.path,
    runnerOptions: {
      delegateCapacity: 1,
      operationCapacity: 1,
    },
  });
}

async function seedHeadlessPublicReview({ worktreeRoot, isolation, rawRoot }) {
  prepareNativeProviderDrovrConfig({ worktreeRoot, isolation });
  mkdirSync(isolation.repository_root, { recursive: true, mode: 0o700 });
  writeFileSync(join(isolation.repository_root, "feature.txt"), "before\n", { mode: 0o600 });
  await initializePublicReviewRepository(isolation.repository_root);
  const env = {
    ...isolatedQualificationEnvironment(isolation),
    FLOW_PUBLIC_REPOSITORY: isolation.repository_root,
  };
  writeFileSync(join(isolation.repository_root, "tuicr-seed.txt"), "after\n", {
    mode: 0o600,
  });
  const tuicr = await seedTuicrSession({
    isolation,
    rawRoot,
    env,
    tuicrPath: resolvePinnedTuicrPath(),
    draftComment: "issue-46 headless qualification draft",
  });
  execFileSync("git", ["-C", isolation.repository_root, "add", "tuicr-seed.txt"]);
  execFileSync("git", [
    "-C",
    isolation.repository_root,
    "commit",
    "--quiet",
    "-m",
    "retain headless Tuicr qualification seed",
  ]);
  const seeded = await seedPublicReview({
    authorityDirectory: isolation.authority_directory,
    env,
    repository: isolation.repository_root,
  });
  return { seeded, tuicr };
}

async function stopHeadlessPublicOwner(isolation) {
  const result = await stopFlowOwner({
    env: isolatedQualificationEnvironment(isolation),
    authorityDirectory: isolation.authority_directory,
    endpointPath: isolation.endpoint_path,
    socketPath: isolation.socket_path,
  });
  if (!result || !["stopped", "stale"].includes(result.state)) {
    throw new Error(`headless public owner did not stop cleanly: ${result?.state ?? "missing"}`);
  }
  return result;
}

async function cleanupHeadlessPublicOwner(isolation, markStopped) {
  await stopHeadlessPublicOwner(isolation);
  markStopped?.();
  return cleanupQualificationIsolation(isolation);
}

async function publicCommandRunner(request) {
  const command = await runPinnedPublicCommand(request);
  const rawRoot = request.rawRoot ?? dirname(request.logDirectory);
  const stdoutPath = command.logs?.stdout?.path;
  let output = null;
  if (typeof stdoutPath === "string") {
    try {
      output = parseJsonLines(readFileSync(join(rawRoot, "logs", stdoutPath), "utf8"));
    } catch {
      output = null;
    }
  }
  if (request.scenario_id === "ubuntu_headless_text_captures" &&
      ["status", "query", "watch"].includes(request.kind) &&
      typeof stdoutPath === "string") {
    captureHeadlessPublicOutput({ request, command, rawRoot, stdoutPath });
  }
  return { command, output };
}

async function runNativeProviderQualificationScenario({
  scenarioId,
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
}) {
  const invocation = nativeProviderScenarioRunner({
    scenarioId,
    entrypoints,
    isolation,
    rawRoot,
    timeoutMs,
    worktreeRoot,
  });
  const capture = persistNativeProviderCapture({
    scenarioId,
    commandId: invocation.command.id,
    output: invocation.output,
    rawRoot,
    isolation,
  });
  const scenarioResult = adaptNativeProviderResult({
    scenarioId,
    command: invocation.command,
    output: invocation.output,
    capture,
  });
  const cleanup = cleanupQualificationIsolation(isolation);
  return { ...scenarioResult, cleanup };
}

async function runNativeReaderQualificationScenario({
  scenarioId,
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
}) {
  const projection = scenarioId === "projection_rebuild_readers";
  const commandKind = projection
    ? READER_PROBE_COMMAND_KINDS.projection
    : READER_PROBE_COMMAND_KINDS.suspended;
  const probe = projection ? "projection" : "suspended";
  const commandId = `${commandKind}-${randomUUID()}`;
  const scriptPath = join(worktreeRoot, "config/flow/scripts/run-host-recovery-reader-probe.mjs");
  const args = [
    scriptPath,
    "--probe", probe,
    "--worktree", worktreeRoot,
    "--raw-root", rawRoot,
    "--xdg-state-home", isolation.xdg_state_home,
    "--authority-directory", isolation.authority_directory,
    "--socket", isolation.socket_path,
    "--endpoint", isolation.endpoint_path,
    "--backup-directory", isolation.backup_directory,
    "--repository-root", isolation.repository_root,
    "--drovr-config-directory", isolation.drovr_config_directory,
    "--qualification-workspace", isolation.qualification_workspace,
    "--herdr-session", isolation.herdr_session,
    "--run-id", isolation.run_id,
    "--timeout", String(timeoutMs),
  ];
  const startedAt = new Date().toISOString();
  const result = await spawnNativeProvider({
    nodePath: entrypoints.node.path,
    args,
    cwd: worktreeRoot,
    env: isolatedQualificationEnvironment(isolation),
    timeoutMs,
  });
  const finishedAt = new Date().toISOString();
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = `logs/${commandId}.stdout.log`;
  const stderrPath = `logs/${commandId}.stderr.log`;
  mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
  writeProbeLog(join(rawRoot, stdoutPath), stdout, isolation);
  writeProbeLog(join(rawRoot, stderrPath), stderr, isolation);
  const pathMappings = {
    worktree: isolation.worktree_root,
    state: isolation.xdg_state_home,
    authority: isolation.authority_directory,
    backup: isolation.backup_directory,
    repository: isolation.repository_root,
    drovr: isolation.drovr_config_directory,
    workspace: isolation.qualification_workspace,
  };
  const command = {
    id: commandId,
    argv: ["node", relative(worktreeRoot, scriptPath), ...args.slice(1).map((arg) =>
      redactQualificationCapture(arg, { pathMappings }))],
    command_kind: commandKind,
    launcher_ref: relative(worktreeRoot, scriptPath),
    host_ref: "native/reader-provider",
    working_directory_ref: "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: result.timedOut === true,
    logs: {
      stdout: probeLogDescriptor(stdoutPath, stdout, isolation),
      stderr: probeLogDescriptor(stderrPath, stderr, isolation),
    },
  };
  const output = parseReaderProbeOutput(stdout, scenarioId, isolation.run_id, stderr);
  const cleanup = cleanupQualificationIsolation(isolation);
  const adapt = projection
    ? adaptProjectionReaderProbeResult
    : adaptSuspendedAdmissionProbeResult;
  return adapt({
    probeResult: output,
    command,
    cleanup,
    isolation,
    rawRoot,
  });
}

async function runNativeTuicrQualificationScenario({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
}) {
  const scenarioId = "tuicr_review_after_producer_exit";
  const commandKind = "native_tuicr_live_probe";
  const commandId = `${commandKind}-${randomUUID()}`;
  const scriptPath = join(worktreeRoot, "config/flow/scripts/run-host-recovery-tuicr-live-probe.mjs");
  mkdirSync(isolation.qualification_workspace, { recursive: true, mode: 0o700 });
  const inputPath = join(isolation.qualification_workspace, "tuicr-live-input.json");
  writeFileSync(inputPath, `${JSON.stringify({
    isolation,
    rawRoot,
    tuicrPath: resolvePinnedTuicrPath(),
    cleanupIsolation: true,
    producerTimeoutMs: timeoutMs,
    tuiTimeoutMs: Math.min(timeoutMs, 30_000),
  })}\n`, { flag: "wx", mode: 0o600 });
  const args = [scriptPath, "--input", inputPath];
  const startedAt = new Date().toISOString();
  const result = await spawnNativeProvider({
    nodePath: entrypoints.node.path,
    args,
    cwd: worktreeRoot,
    env: isolatedQualificationEnvironment(isolation),
    timeoutMs,
  });
  const finishedAt = new Date().toISOString();
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = `logs/${commandId}.stdout.log`;
  const stderrPath = `logs/${commandId}.stderr.log`;
  mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
  writeProbeLog(join(rawRoot, stdoutPath), stdout, isolation);
  writeProbeLog(join(rawRoot, stderrPath), stderr, isolation);
  const pathMappings = {
    worktree: isolation.worktree_root,
    state: isolation.xdg_state_home,
    authority: isolation.authority_directory,
    backup: isolation.backup_directory,
    repository: isolation.repository_root,
    drovr: isolation.drovr_config_directory,
    workspace: isolation.qualification_workspace,
  };
  const command = {
    id: commandId,
    argv: ["node", relative(worktreeRoot, scriptPath), "--input", "isolation/qualification-workspace/tuicr-live-input.json"],
    command_kind: commandKind,
    launcher_ref: relative(worktreeRoot, scriptPath),
    host_ref: "native/tuicr-live-provider",
    working_directory_ref: "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: result.timedOut === true,
    logs: {
      stdout: probeLogDescriptor(stdoutPath, stdout, isolation),
      stderr: probeLogDescriptor(stderrPath, stderr, isolation),
    },
  };
  const output = parseTuicrLiveProbeOutput(stdout, scenarioId, stderr);
  return adaptTuicrLiveProbeResult({ output, command, rawRoot, isolation });
}

function parseTuicrLiveProbeOutput(stdout, scenarioId, stderr) {
  try {
    const output = JSON.parse(stdout.trim());
    if (output?.schema !== "flow.host-recovery-tuicr-live-integration/v1" ||
        output.scenario_id !== scenarioId) {
      throw new Error("tuicr probe identity did not match the qualification scenario");
    }
    return output;
  } catch (error) {
    throw new Error(`native tuicr probe output invalid: ${error.message}; ${stderr}`);
  }
}

function adaptTuicrLiveProbeResult({ output, command, rawRoot, isolation }) {
  const scenarioId = "tuicr_review_after_producer_exit";
  const definition = HOST_RECOVERY_SCENARIOS.find(({ id }) => id === scenarioId);
  const normalized = normalizeProviderObservations({
    observations: output.scenario?.observations ?? [],
  }, scenarioId);
  const assertionKinds = {
    producer_exit_before_review: "producer_exit",
    flowruntime_disposition_and_approval: "disposition",
    stale_action_rejection: "stale_action",
    projection_rebuild_identity: "rebuild",
  };
  const assertions = definition.required_assertion_ids.map((id) => {
    const observation = normalized.byKind.get(assertionKinds[id]);
    const scenarioAssertion = output.scenario?.assertions?.[id];
    return {
      id,
      // The native probe's scenario assertion map is the authoritative
      // assertion result. Output status alone cannot turn a missing or false
      // assertion into proof.
      disposition: output.status === "pass" && output.scenario?.status === "pass" &&
        scenarioAssertion === true && observation ? "pass" : "not_observed",
      evidence_refs: observation ? [`observation:${observation.id}`] : [],
    };
  });
  const scenarioAssertionFailed = definition.required_assertion_ids.some((id) =>
    output.scenario?.assertions?.[id] !== true);
  const capture = persistNativeProviderCapture({
    scenarioId,
    commandId: command.id,
    output,
    rawRoot,
    isolation,
  });
  const pass = output.status === "pass" && output.scenario?.status === "pass" &&
    command.exit_code === 0 && command.signal === null && command.timed_out === false &&
    normalized.valid && definition.required_observation_kinds.every((kind) =>
      normalized.byKind.has(kind)) &&
    assertions.every(({ disposition }) => disposition === "pass") &&
    output.cleanup?.disposition === "complete" &&
    output.cleanup?.unresolved_obligations?.length === 0;
  const reason = pass ? null : scenarioAssertionFailed
    ? "scenario_assertion_failed"
    : output.reason ?? "native_tuicr_live_proof_incomplete";
  return {
    schema: "flow.host-recovery-runtime-scenario/v1",
    version: 1,
    issue: 46,
    scenario_id: scenarioId,
    execution_kind: definition.execution_kind,
    proof_predicate: definition.proof_predicate,
    proof: {
      predicate: definition.proof_predicate,
      satisfied: pass,
      observation_kinds: [...definition.required_observation_kinds],
      capture_kinds: [capture.kind],
    },
    required_command_kinds: [...definition.required_command_kinds],
    required_observation_kinds: [...definition.required_observation_kinds],
    required_capture_kinds: [],
    commands: [command],
    observations: normalized.observations,
    captures: [capture],
    assertions,
    retained_obligations: pass ? [] : [{ code: reason }],
    cleanup: output.cleanup,
    cleanup_inputs: {
      scenario_id: scenarioId,
      run_id: isolation.run_id,
      retained_obligations: pass ? [] : [{ code: reason }],
    },
    result: {
      schema: "flow.host-recovery-scenario-result/v1",
      disposition: pass ? "pass" : "blocked",
      reason,
    },
    started_at: command.started_at,
    finished_at: command.finished_at,
  };
}

function parseReaderProbeOutput(stdout, scenarioId, runId, stderr) {
  try {
    const output = JSON.parse(stdout.trim());
    if (output?.schema !== "flow.host-recovery-reader-integration/v1" ||
        output.scenario_id !== scenarioId || output.isolation_run_id !== runId) {
      throw new Error("reader probe identity did not match the qualification run");
    }
    return output;
  } catch (error) {
    throw new Error(`native reader probe output invalid: ${error.message}; ${stderr}`);
  }
}

function nativeProviderScenarioRunner({
  scenarioId,
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
}) {
  const commandKinds = {
    concurrent_runs_owner_restart: "native_concurrency_recovery_probe",
    actionable_failure_recovery: "native_failure_recovery_probe",
  };
  const commandKind = commandKinds[scenarioId];
  if (commandKind === undefined) throw new Error(`native provider scenario is not supported: ${scenarioId}`);
  const commandId = `${commandKind}-${randomUUID()}`;
  const scriptPath = join(worktreeRoot, "config/flow/scripts/run-host-recovery-provider-scenarios.mjs");
  prepareNativeProviderDrovrConfig({ worktreeRoot, isolation });
  const args = [
    scriptPath,
    "--scenario", scenarioId,
    "--worktree", worktreeRoot,
    "--authority-directory", isolation.authority_directory,
    "--home-directory", isolation.qualification_workspace,
    "--xdg-state-home", isolation.xdg_state_home,
    "--drovr-config-directory", isolation.drovr_config_directory,
    "--owner-isolation-root", join(isolation.qualification_workspace, "owner-lifecycle"),
    "--repository-root", isolation.repository_root,
    "--backup-directory", isolation.backup_directory,
    "--run-id", isolation.run_id,
    "--timeout", String(timeoutMs),
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(entrypoints.node.path, args, {
    cwd: worktreeRoot,
    env: isolatedQualificationEnvironment(isolation),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = `logs/${commandId}.stdout.log`;
  const stderrPath = `logs/${commandId}.stderr.log`;
  mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
  writeProbeLog(join(rawRoot, stdoutPath), stdout, isolation);
  writeProbeLog(join(rawRoot, stderrPath), stderr, isolation);
  const pathMappings = {
    worktree: isolation.worktree_root,
    state: isolation.xdg_state_home,
    authority: isolation.authority_directory,
    backup: isolation.backup_directory,
    repository: isolation.repository_root,
    drovr: isolation.drovr_config_directory,
    workspace: isolation.qualification_workspace,
  };
  const command = {
    id: commandId,
    argv: ["node", relative(worktreeRoot, scriptPath), ...args.slice(1).map((arg) =>
      redactQualificationCapture(arg, { pathMappings }))],
    command_kind: commandKind,
    launcher_ref: relative(worktreeRoot, scriptPath),
    host_ref: "native/flow-provider",
    working_directory_ref: "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: result.error?.code === "ETIMEDOUT" || result.signal !== null,
    logs: {
      stdout: probeLogDescriptor(stdoutPath, stdout, isolation),
      stderr: probeLogDescriptor(stderrPath, stderr, isolation),
    },
  };
  return {
    command,
    output: parseNativeProviderScenarioOutput(stdout, scenarioId, isolation.run_id, stderr),
  };
}

function prepareNativeProviderDrovrConfig({ worktreeRoot, isolation }) {
  const source = join(worktreeRoot, "config/drovr");
  const destination = isolation.drovr_config_directory;
  if (!existsSync(source)) throw new Error("pinned Drovr configuration is missing");
  const sourceInfo = lstatSync(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error("pinned Drovr configuration is not a real directory");
  }
  if (existsSync(destination)) {
    throw new Error("isolated Drovr configuration root must be unused before the native provider probe");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function parseNativeProviderScenarioOutput(stdout, scenarioId, runId, stderr) {
  try {
    const trimmed = stdout.trim();
    const output = trimmed.length === 0 ? null : JSON.parse(trimmed);
    return output?.schema === "flow.host-recovery-provider-scenario/v1" &&
        output.scenario_id === scenarioId && output.run_id === runId
      ? output
      : blockedNativeProviderResult(scenarioId, "native_provider_output_invalid", stderr);
  } catch (error) {
    return blockedNativeProviderResult(scenarioId, "native_provider_output_invalid", `${error.message}; ${stderr}`);
  }
}

function blockedNativeProviderResult(scenarioId, reason, detail = "") {
  return {
    schema: "flow.host-recovery-provider-scenario/v1",
    version: 1,
    issue: 46,
    scenario_id: scenarioId,
    execution_kind: "native_provider",
    status: "blocked",
    provider: null,
    commands: [],
    observations: [],
    assertions: [],
    retained_obligations: [{ code: reason, ...(detail.length === 0 ? {} : { detail }) }],
    result: { disposition: "blocked", reason },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
}

function persistNativeProviderCapture({ scenarioId, commandId, output, rawRoot, isolation }) {
  const captureId = `native-provider-${scenarioId}-${commandId}`;
  const capturePath = `captures/${captureId}.json`;
  const redacted = redactQualificationCapture(output, {
    pathMappings: {
      worktree: isolation.worktree_root,
      state: isolation.xdg_state_home,
      authority: isolation.authority_directory,
      backup: isolation.backup_directory,
      repository: isolation.repository_root,
      drovr: isolation.drovr_config_directory,
      workspace: isolation.qualification_workspace,
    },
  });
  const bytes = `${JSON.stringify(redacted, null, 2)}\n`;
  mkdirSync(join(rawRoot, "captures"), { recursive: true, mode: 0o700 });
  writeFileSync(join(rawRoot, capturePath), bytes, { flag: "wx", mode: 0o600 });
  return {
    id: captureId,
    kind: "native_provider_result",
    format: "json",
    path: capturePath,
    sha256: hash(bytes),
    legibility: output.status === "pass" ? "pass" : "not_observed",
    provenance: "native_provider",
    watermark: typeof output.provider?.watermark === "string"
      ? output.provider.watermark
      : canonicalDigest(output),
    legal_actions: output.status === "pass" ? "pass" : "not_observed",
  };
}

function adaptNativeProviderResult({ scenarioId, command, output, capture }) {
  const definition = HOST_RECOVERY_SCENARIOS.find(({ id }) => id === scenarioId);
  const normalized = normalizeProviderObservations(output, scenarioId);
  const assertions = normalizeProviderAssertions(
    output,
    normalized.observations,
    definition.required_assertion_ids,
  );
  const commandPass = command.exit_code === 0 && command.signal === null &&
    command.timed_out === false && command.expected_exit_code === command.exit_code &&
    command.expected_signal === command.signal && command.expected_timed_out === command.timed_out;
  const requiredObservations = definition.required_observation_kinds;
  const observationsComplete = requiredObservations.every((kind) =>
    normalized.byKind.has(kind));
  const assertionsPass = definition.required_assertion_ids.every((id) =>
    assertions.find((assertion) => assertion.id === id)?.disposition === "pass" &&
    assertions.find((assertion) => assertion.id === id).evidence_refs.length > 0);
  const pass = commandPass && normalized.valid && observationsComplete && assertionsPass &&
    output.status === "pass" && output.result?.disposition === "pass";
  const reason = pass ? null : output.result?.reason ??
    (commandPass ? "native_provider_proof_incomplete" : "native_provider_command_failed");
  return {
    schema: "flow.host-recovery-runtime-scenario/v1",
    version: 1,
    issue: 46,
    scenario_id: scenarioId,
    execution_kind: definition.execution_kind,
    proof_predicate: definition.proof_predicate,
    proof: {
      predicate: definition.proof_predicate,
      satisfied: pass,
      observation_kinds: [...definition.required_observation_kinds],
      capture_kinds: [...definition.required_capture_kinds],
    },
    required_command_kinds: [...definition.required_command_kinds],
    required_observation_kinds: [...definition.required_observation_kinds],
    required_capture_kinds: [...definition.required_capture_kinds],
    commands: [command],
    observations: normalized.observations,
    captures: [capture],
    assertions,
    retained_obligations: pass ? [] : [{ code: reason }],
    cleanup_inputs: {
      scenario_id: scenarioId,
      run_id: null,
      retained_obligations: pass ? [] : [{ code: reason }],
    },
    result: {
      schema: "flow.host-recovery-scenario-result/v1",
      disposition: pass ? "pass" : "blocked",
      reason,
    },
    started_at: command.started_at,
    finished_at: command.finished_at,
  };
}

function normalizeProviderObservations(output, scenarioId) {
  const observations = [];
  const byKind = new Map();
  let valid = Array.isArray(output.observations);
  for (const source of output.observations ?? []) {
    if (source === null || typeof source !== "object" || Array.isArray(source) ||
        typeof source.kind !== "string" || source.kind.length === 0 ||
        source.content === null || typeof source.content !== "object" ||
        Array.isArray(source.content) || byKind.has(source.kind)) {
      valid = false;
      continue;
    }
    const id = `native:${scenarioId}:${source.kind}`;
    const content = structuredClone(source.content);
    if (source.content_digest !== undefined && source.content_digest !== canonicalDigest(content)) {
      valid = false;
    }
    const observation = {
      id,
      kind: source.kind,
      content,
      content_digest: canonicalDigest(content),
    };
    observations.push(observation);
    byKind.set(source.kind, observation);
  }
  return { observations, byKind, valid };
}

function normalizeProviderAssertions(output, observations, requiredIds) {
  const sourceById = new Map((output.assertions ?? [])
    .filter((assertion) => assertion !== null && typeof assertion === "object")
    .map((assertion) => [assertion.id, assertion]));
  const byKind = new Map(observations.map((observation) => [observation.kind, observation]));
  return requiredIds.map((id) => {
    const source = sourceById.get(id);
    const evidenceRefs = (source?.evidence_refs ?? [])
      .map((reference) => {
        if (typeof reference !== "string") return null;
        const kind = reference.startsWith("observation:")
          ? reference.slice("observation:".length)
          : reference;
        const observation = byKind.get(kind) ?? observations.find(({ id: observationId }) =>
          observationId === kind);
        return observation === undefined ? null : `observation:${observation.id}`;
      })
      .filter(Boolean);
    return {
      id,
      disposition: source?.disposition === "pass" ? "pass" : "not_observed",
      evidence_refs: [...new Set(evidenceRefs)],
    };
  });
}

function headlessInputRoot(isolation) {
  const root = join(isolation.qualification_workspace, "headless-input");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("headless provider input root must be a real directory");
  }
  return root;
}

function captureHeadlessPublicOutput({ request, command, rawRoot, stdoutPath }) {
  const inputRoot = headlessInputRoot(request.isolation);
  const source = join(rawRoot, "logs", stdoutPath);
  const extension = request.kind === "status" ? "log" : "jsonl";
  const destination = join(inputRoot, `public-${request.kind}-${command.id}.${extension}`);
  const bytes = readFileSync(source);
  if (existsSync(destination)) {
    throw new Error(`headless public capture already exists: ${destination}`);
  }
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  const persistedSha = hash(bytes);
  const stdoutSha = command.logs?.stdout?.sha256;
  if (typeof stdoutSha !== "string" || stdoutSha !== persistedSha) {
    throw new Error(`headless public capture receipt does not match persisted stdout: ${command.id}`);
  }
  updateHeadlessReceiptManifest(inputRoot, {
    path: relative(inputRoot, destination),
    provenance: "public_process",
    command_id: command.id,
    command_kind: command.command_kind,
    stdout_sha256: stdoutSha,
    persisted_sha256: persistedSha,
  });
}

function updateHeadlessReceiptManifest(inputRoot, entry) {
  const path = join(inputRoot, HEADLESS_RECEIPT_MANIFEST);
  let manifest = {
    schema: "flow.headless-public-receipts/v1",
    receipts: [],
  };
  if (existsSync(path)) manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== "flow.headless-public-receipts/v1" ||
      !Array.isArray(manifest.receipts)) {
    throw new Error("headless public receipt manifest is invalid");
  }
  if (manifest.receipts.some(({ path: existingPath }) => existingPath === entry.path)) {
    throw new Error(`headless public receipt already exists: ${entry.path}`);
  }
  manifest.receipts.push(entry);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function captureHeadlessCheckpointProjection({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
}) {
  const preparedCommand = await runPinnedPublicCommand({
    entrypoints,
    isolation,
    args: [
      "prepare",
      "--input",
      JSON.stringify(registeredOperationProposal({ checkpointBound: true })),
      "--json",
    ],
    logDirectory: join(rawRoot, "logs"),
    cwd: isolation.worktree_root,
    timeoutMs,
  });
  const prepared = readCommandJsonOutput(preparedCommand, rawRoot, "checkpoint prepare");
  if (preparedCommand.exit_code !== 0 || preparedCommand.signal !== null ||
      preparedCommand.timed_out || prepared?.schema !== "flow.prepared-run/v1") {
    throw new Error("headless public checkpoint preparation failed");
  }
  const launchCommand = await runPinnedPublicCommand({
    entrypoints,
    isolation,
    args: [
      "launch",
      "--input",
      JSON.stringify(confirmedLaunchRequest(prepared)),
      "--json",
    ],
    logDirectory: join(rawRoot, "logs"),
    cwd: isolation.worktree_root,
    timeoutMs,
  });
  const launch = readCommandJsonOutput(launchCommand, rawRoot, "checkpoint launch");
  if (launchCommand.exit_code !== 0 || launchCommand.signal !== null ||
      launchCommand.timed_out || launch?.schema !== "flow.launch-receipt/v1" ||
      typeof launch.run_id !== "string") {
    throw new Error("headless public checkpoint launch failed");
  }
  const queryCommand = await runPinnedPublicCommand({
    entrypoints,
    isolation,
    args: ["query", "--input", JSON.stringify({ run_id: launch.run_id }), "--json"],
    logDirectory: join(rawRoot, "logs"),
    cwd: isolation.worktree_root,
    timeoutMs,
  });
  if (queryCommand.exit_code !== 0 || queryCommand.signal !== null || queryCommand.timed_out) {
    throw new Error("headless public checkpoint projection query failed");
  }
  const stdoutPath = queryCommand.logs?.stdout?.path;
  if (typeof stdoutPath !== "string") {
    throw new Error("headless public checkpoint projection query emitted no stdout log");
  }
  captureHeadlessPublicOutput({
    request: {
      isolation,
      kind: "seeded-checkpoint",
      scenario_id: "ubuntu_headless_text_captures",
    },
    command: queryCommand,
    rawRoot,
    stdoutPath,
  });
}

function readCommandJsonOutput(command, rawRoot, label) {
  const stdoutPath = command.logs?.stdout?.path;
  if (typeof stdoutPath !== "string") {
    throw new Error(`${label} emitted no stdout log`);
  }
  try {
    return JSON.parse(readFileSync(join(rawRoot, "logs", stdoutPath), "utf8"));
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error.message}`);
  }
}

async function captureHeadlessSeededProjections({
  entrypoints,
  isolation,
  rawRoot,
  seeded,
}) {
  for (const [label, runId] of [
    ["feature", seeded?.feature?.run_id],
    ["review", seeded?.reviewRun?.run_id],
  ]) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error(`headless public seed did not expose a ${label} run identity`);
    }
    const command = await runPinnedPublicCommand({
      entrypoints,
      isolation,
      args: [
        "query",
        "--input",
        JSON.stringify({ run_id: runId }),
        "--json",
      ],
      logDirectory: join(rawRoot, "logs"),
      cwd: isolation.worktree_root,
    });
    if (command.exit_code !== 0 || command.signal !== null || command.timed_out) {
      throw new Error(`headless public ${label} projection query failed`);
    }
    const stdoutPath = command.logs?.stdout?.path;
    if (typeof stdoutPath !== "string") {
      throw new Error(`headless public ${label} projection query emitted no stdout log`);
    }
    captureHeadlessPublicOutput({
      request: {
        isolation,
        kind: `seeded-${label}`,
        scenario_id: "ubuntu_headless_text_captures",
      },
      command,
      rawRoot,
      stdoutPath,
    });
  }
}

async function captureHeadlessTuicrConsumer({
  isolation,
  rawRoot,
  seeded,
  session,
  timeoutMs,
}) {
  if (typeof session?.session_path !== "string") {
    throw new Error("headless Tuicr seed did not expose a session path");
  }
  const env = {
    ...isolatedQualificationEnvironment(isolation),
    HOME: isolation.qualification_workspace,
    XDG_DATA_HOME: join(isolation.qualification_workspace, "tuicr-data"),
    TUICR_NO_UPDATE_CHECK: "1",
    TERM: "xterm-256color",
  };
  const tuicrPath = resolvePinnedTuicrPath();
  const logDirectory = join(rawRoot, "logs");
  const list = await runTuicrCli({
    tuicrPath,
    args: ["review", "list", "--repo", isolation.repository_root],
    cwd: isolation.repository_root,
    env,
    logDirectory,
    commandKind: "headless_tuicr_list",
    timeoutMs,
  });
  const comments = await runTuicrCli({
    tuicrPath,
    args: [
      "review",
      "comments",
      "--repo",
      isolation.repository_root,
      "--session",
      session.session_path,
    ],
    cwd: isolation.repository_root,
    env,
    logDirectory,
    commandKind: "headless_tuicr_comments",
    timeoutMs,
  });
  if ([list.command, comments.command].some((command) =>
    command.exit_code !== 0 || command.signal !== null || command.timed_out)) {
    throw new Error("headless Tuicr consumer command failed");
  }
  const rows = String(list.stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const commentsValue = JSON.parse(String(comments.stdout));
  const reviewId = seeded?.review?.review_id ?? seeded?.review?.subject_id ?? null;
  const consumer = {
    schema: "tuicr.review-consumer-observation/v1",
    // This JSON is a composed consumer observation. Its provenance is bound
    // below to the persisted stdout logs of both public Tuicr commands.
    provenance: "composed",
    consumer: "tuicr",
    started: true,
    session_path: session.session_path,
    list: {
      session_path: session.session_path,
      review_id: reviewId,
      rows,
      found: rows.some((row) => row.includes(session.session_path)),
      raw_digest: canonicalDigest(rows),
      command_id: list.command.id,
      stdout_sha256: list.command.logs.stdout.sha256,
    },
    comments: commentsValue,
    comments_command: {
      command_id: comments.command.id,
      stdout_sha256: comments.command.logs.stdout.sha256,
    },
    watermark: seeded?.review?.watermark ?? seeded?.candidate?.watermark ?? null,
    legal_actions: seeded?.review?.legal_actions ?? seeded?.candidate?.legal_actions ?? [],
  };
  if (consumer.list.found !== true) {
    throw new Error("headless Tuicr list did not resolve the seeded session");
  }
  const inputRoot = headlessInputRoot(isolation);
  const path = join(inputRoot, "public-tuicr-consumer.json");
  const consumerBytes = Buffer.from(`${JSON.stringify(consumer, null, 2)}\n`);
  writeFileSync(path, consumerBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const componentLogs = [
    { label: "list", command: list.command },
    { label: "comments", command: comments.command },
  ].map(({ label, command }) => {
    const stdoutPath = command.logs?.stdout?.path;
    if (typeof stdoutPath !== "string") {
      throw new Error(`headless Tuicr ${label} command emitted no stdout log`);
    }
    const bytes = readFileSync(join(rawRoot, "logs", stdoutPath));
    const stdoutSha256 = command.logs?.stdout?.sha256;
    const stdoutHex = typeof stdoutSha256 === "string"
      ? stdoutSha256.replace(/^sha256:/u, "")
      : null;
    if (stdoutHex === null || hash(bytes) !== stdoutHex) {
      throw new Error(`headless Tuicr ${label} stdout log differs from its command receipt`);
    }
    const destination = join(inputRoot, `public-tuicr-${label}-${command.id}.stdout.log`);
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    return {
      path: relative(inputRoot, destination),
      sha256: hash(bytes),
      stdout_sha256: stdoutSha256,
      command_id: command.id,
      command_kind: command.command_kind,
    };
  });
  updateHeadlessReceiptManifest(inputRoot, {
    path: relative(inputRoot, path),
    provenance: "composed",
    persisted_sha256: hash(consumerBytes),
    components: componentLogs,
  });
}

function nativeHeadlessProviderRunner({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
  release,
}) {
  return async ({ signal } = {}) => {
    const inputRoot = headlessInputRoot(isolation);
    writeHeadlessReleaseEvidence(inputRoot, release);
    const commandId = `native-headless-capture-${randomUUID()}`;
    const scriptPath = join(worktreeRoot, "config/flow/scripts/run-host-recovery-headless-provider.mjs");
    const args = [scriptPath, "--input-root", inputRoot];
    const startedAt = new Date().toISOString();
    const result = await spawnNativeProvider({
      nodePath: entrypoints.node.path,
      args,
      cwd: worktreeRoot,
      env: isolatedQualificationEnvironment(isolation),
      timeoutMs,
      signal,
    });
    const finishedAt = new Date().toISOString();
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const stdoutPath = `logs/${commandId}.stdout.log`;
    const stderrPath = `logs/${commandId}.stderr.log`;
    mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
    writeProbeLog(join(rawRoot, stdoutPath), stdout, isolation);
    writeProbeLog(join(rawRoot, stderrPath), stderr, isolation);
    const pathMappings = {
      worktree: isolation.worktree_root,
      state: isolation.xdg_state_home,
      authority: isolation.authority_directory,
      backup: isolation.backup_directory,
      repository: isolation.repository_root,
      drovr: isolation.drovr_config_directory,
      workspace: isolation.qualification_workspace,
    };
    const command = {
      id: commandId,
      argv: ["node", relative(worktreeRoot, scriptPath), ...args.slice(1).map((arg) =>
        redactQualificationCapture(arg, { pathMappings }))],
      command_kind: "native_headless_capture_probe",
      launcher_ref: relative(worktreeRoot, scriptPath),
      host_ref: "native/headless-provider",
      working_directory_ref: "worktree",
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      exit_code: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal ?? null,
      expected_exit_code: 0,
      expected_signal: null,
      expected_timed_out: false,
      timed_out: result.timedOut === true,
      logs: {
        stdout: probeLogDescriptor(stdoutPath, stdout, isolation),
        stderr: probeLogDescriptor(stderrPath, stderr, isolation),
      },
    };
    return {
      command,
      output: parseNativeHeadlessProviderOutput(stdout, stderr),
    };
  };
}

function writeHeadlessReleaseEvidence(inputRoot, release) {
  const path = join(inputRoot, "release-evidence.json");
  const value = {
    release_id: release.release_id,
    manifest_digest: release.release_content_digest,
    candidate_tree_sha: release.candidate_tree_sha,
    route: "ubuntu_headless_text",
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (!existing.equals(bytes)) throw new Error("headless release evidence changed during qualification");
    return;
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

function spawnNativeProvider({ nodePath, args, cwd, env, timeoutMs, signal }) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let timer;
    let terminationTimer;
    const child = spawn(nodePath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      signal?.removeEventListener?.("abort", terminate);
    };
    const terminate = () => {
      if (settled || terminating) return;
      terminating = true;
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* close remains authoritative */ }
      terminationTimer = setTimeout(() => {
        if (!settled) {
          try { child.kill("SIGKILL"); } catch { /* close remains authoritative */ }
        }
      }, 2_000);
    };
    timer = setTimeout(terminate, Math.max(1, timeoutMs));
    if (signal?.aborted) terminate();
    else signal?.addEventListener?.("abort", terminate, { once: true });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled || terminating) return;
      settled = true;
      clear();
      reject(error);
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      clear();
      resolvePromise({
        status: Number.isInteger(code) ? code : null,
        signal: childSignal ?? null,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function parseNativeHeadlessProviderOutput(stdout, stderr) {
  try {
    const output = parseWholeJson(stdout) ?? parseJsonLines(stdout) ?? parseJsonLines(stderr);
    return output?.schema === "flow.host-recovery-headless-provider/v1"
      ? output
      : {
        schema: "flow.host-recovery-headless-provider/v1",
        version: 1,
        status: "blocked",
        code: "native_headless_capture_probe_output_invalid",
        reason: "native provider did not return its versioned output",
      };
  } catch (error) {
    return {
      schema: "flow.host-recovery-headless-provider/v1",
      version: 1,
      status: "blocked",
      code: "native_headless_capture_probe_output_invalid",
      reason: error.message,
      stderr: redactQualificationCapture(stderr),
    };
  }
}

function parseWholeJson(text) {
  const trimmed = String(text).trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function nativeBackupRestoreProbeRunner({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
}) {
  const commandId = `native-backup-restore-${randomUUID()}`;
  const scriptPath = join(worktreeRoot, "config/flow/scripts/run-host-recovery-native-probe.mjs");
  const args = [
    scriptPath,
    "--probe", "backup_restore",
    "--worktree", worktreeRoot,
    "--raw-root", rawRoot,
    "--temporary-root", dirname(isolation.xdg_state_home),
    "--xdg-state-home", isolation.xdg_state_home,
    "--authority-directory", isolation.authority_directory,
    "--socket", isolation.socket_path,
    "--endpoint", isolation.endpoint_path,
    "--backup-directory", isolation.backup_directory,
    "--repository-root", isolation.repository_root,
    "--drovr-config-directory", isolation.drovr_config_directory,
    "--qualification-workspace", isolation.qualification_workspace,
    "--herdr-session", isolation.herdr_session,
    "--run-id", isolation.run_id,
    "--timeout", String(timeoutMs),
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(entrypoints.node.path, args, {
    cwd: worktreeRoot,
    env: isolatedQualificationEnvironment(isolation),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = `logs/${commandId}.stdout.log`;
  const stderrPath = `logs/${commandId}.stderr.log`;
  mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
  writeProbeLog(join(rawRoot, stdoutPath), stdout, isolation);
  writeProbeLog(join(rawRoot, stderrPath), stderr, isolation);
  const signal = result.signal ?? null;
  const timedOut = result.error?.code === "ETIMEDOUT" || signal !== null;
  const command = {
    id: commandId,
    argv: ["node", relative(worktreeRoot, scriptPath), ...args.slice(1).map((arg) =>
      redactQualificationCapture(arg, {
        pathMappings: {
          worktree: isolation.worktree_root,
          state: isolation.xdg_state_home,
          authority: isolation.authority_directory,
          backup: isolation.backup_directory,
          repository: isolation.repository_root,
          drovr: isolation.drovr_config_directory,
        },
      }))],
    command_kind: "native_backup_restore_probe",
    launcher_ref: relative(worktreeRoot, scriptPath),
    host_ref: "runtime/flow-runtime",
    working_directory_ref: "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: timedOut,
    logs: {
      stdout: probeLogDescriptor(stdoutPath, stdout, isolation),
      stderr: probeLogDescriptor(stderrPath, stderr, isolation),
    },
  };
  return {
    command,
    output: parseNativeProbeOutput(stdout),
  };
}

function nativeDrovrLockProbeRunner({
  entrypoints,
  isolation,
  rawRoot,
  timeoutMs,
  worktreeRoot,
}) {
  const commandId = `native-drovr-lock-${randomUUID()}`;
  const scriptPath = join(worktreeRoot, "config/flow/scripts/run-host-recovery-native-probe.mjs");
  const args = [
    scriptPath,
    "--probe", "drovr_lock",
    "--worktree", worktreeRoot,
    "--raw-root", rawRoot,
    "--temporary-root", dirname(isolation.xdg_state_home),
    "--xdg-state-home", isolation.xdg_state_home,
    "--authority-directory", isolation.authority_directory,
    "--socket", isolation.socket_path,
    "--endpoint", isolation.endpoint_path,
    "--backup-directory", isolation.backup_directory,
    "--repository-root", isolation.repository_root,
    "--drovr-config-directory", isolation.drovr_config_directory,
    "--qualification-workspace", isolation.qualification_workspace,
    "--herdr-session", isolation.herdr_session,
    "--run-id", isolation.run_id,
    "--timeout", String(timeoutMs),
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(entrypoints.node.path, args, {
    cwd: worktreeRoot,
    env: isolatedQualificationEnvironment(isolation),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutPath = `logs/${commandId}.stdout.log`;
  const stderrPath = `logs/${commandId}.stderr.log`;
  mkdirSync(join(rawRoot, "logs"), { recursive: true, mode: 0o700 });
  writeProbeLog(join(rawRoot, stdoutPath), stdout, isolation);
  writeProbeLog(join(rawRoot, stderrPath), stderr, isolation);
  const signal = result.signal ?? null;
  const timedOut = result.error?.code === "ETIMEDOUT" || signal !== null;
  const command = {
    id: commandId,
    argv: ["node", relative(worktreeRoot, scriptPath), ...args.slice(1).map((arg) =>
      redactQualificationCapture(arg, {
        pathMappings: {
          worktree: isolation.worktree_root,
          state: isolation.xdg_state_home,
          authority: isolation.authority_directory,
          backup: isolation.backup_directory,
          repository: isolation.repository_root,
          drovr: isolation.drovr_config_directory,
        },
      }))],
    command_kind: "native_drovr_lock_probe",
    launcher_ref: relative(worktreeRoot, scriptPath),
    host_ref: "native/drovr-registry",
    working_directory_ref: "worktree",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: timedOut,
    logs: {
      stdout: probeLogDescriptor(stdoutPath, stdout, isolation),
      stderr: probeLogDescriptor(stderrPath, stderr, isolation),
    },
  };
  return {
    command,
    output: parseNativeDrovrLockProbeOutput(stdout),
  };
}

function parseNativeProbeOutput(stdout) {
  try {
    const output = parseJsonLines(stdout);
    return output?.schema === "flow.production-backup-live-observation/v1"
      ? output
      : {
        schema: "flow.production-backup-live-observation/v1",
        status: "blocked",
        reason: "native_probe_output_invalid",
        provider: null,
        proof: {},
      };
  } catch (error) {
    return {
      schema: "flow.production-backup-live-observation/v1",
      status: "blocked",
      reason: "native_probe_output_invalid",
      detail: error.message,
      provider: null,
      proof: {},
    };
  }
}

function parseNativeDrovrLockProbeOutput(stdout) {
  try {
    const output = parseJsonLines(stdout);
    return output?.schema === "flow.drovr-lock-live-observation/v1"
      ? output
      : {
        schema: "flow.drovr-lock-live-observation/v1",
        status: "blocked",
        reason: "native_probe_output_invalid",
      };
  } catch (error) {
    return {
      schema: "flow.drovr-lock-live-observation/v1",
      status: "blocked",
      reason: "native_probe_output_invalid",
      detail: error.message,
    };
  }
}

function writeProbeLog(path, value, isolation) {
  const redacted = redactQualificationCapture(value, {
    pathMappings: {
      worktree: isolation.worktree_root,
      state: isolation.xdg_state_home,
      authority: isolation.authority_directory,
      backup: isolation.backup_directory,
      repository: isolation.repository_root,
      drovr: isolation.drovr_config_directory,
    },
  });
  writeFileSync(path, redacted, { flag: "wx", mode: 0o600 });
}

function probeLogDescriptor(path, value, isolation) {
  const redacted = redactQualificationCapture(value, {
    pathMappings: {
      worktree: isolation.worktree_root,
      state: isolation.xdg_state_home,
      authority: isolation.authority_directory,
      backup: isolation.backup_directory,
      repository: isolation.repository_root,
      drovr: isolation.drovr_config_directory,
    },
  });
  return {
    path,
    sha256: hash(redacted),
    bytes: Buffer.byteLength(redacted),
  };
}

function parseJsonLines(text) {
  const values = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (values.length === 0) return null;
  const parsed = values.map((line) => JSON.parse(line));
  return parsed.length === 1 ? parsed[0] : parsed;
}

function buildOperatorRawReceipt({
  scenarioResult,
  release,
  host,
  tools,
  isolation,
}) {
  return {
    schema: "flow.host-recovery-raw-receipt/v1",
    version: 1,
    issue: 46,
    run_id: isolation.run_id,
    scenario_id: scenarioResult.scenario_id,
    execution_kind: scenarioResult.execution_kind,
    release,
    host,
    tools,
    isolation: isolationReferences(isolation),
    commands: (scenarioResult.commands ?? []).map(normalizeCommandPaths),
    observations: scenarioResult.observations ?? [],
    captures: scenarioResult.captures ?? [],
    assertions: scenarioResult.assertions ?? [],
    retained_obligations: scenarioResult.retained_obligations ?? [],
    cleanup: scenarioResult.cleanup,
    result: {
      disposition: scenarioResult.result?.disposition ?? scenarioResult.status,
      reason: scenarioResult.result?.reason ?? null,
    },
    started_at: scenarioResult.started_at ?? startedAt,
    finished_at: scenarioResult.finished_at ?? new Date().toISOString(),
  };
}

export { adaptTuicrLiveProbeResult };

if (process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = error?.code === "path_not_absolute" ||
      error?.code === "isolation_incomplete" ? 2 : 1;
  });
}

function parseArgs(args) {
  const options = {};
  const keyMap = new Map([
    ["--worktree", "worktree"],
    ["--raw-root", "raw-root"],
    ["--scenario", "scenario"],
    ["--xdg-state-home", "xdg-state-home"],
    ["--authority-directory", "authority-directory"],
    ["--socket", "socket"],
    ["--endpoint", "endpoint"],
    ["--backup-directory", "backup-directory"],
    ["--repository-root", "repository-root"],
    ["--drovr-config-directory", "drovr-config-directory"],
    ["--herdr-session", "herdr-session"],
    ["--run-id", "run-id"],
    ["--runtime-directory", "runtime-directory"],
    ["--request", "request"],
    ["--timeout", "timeout"],
    ["--herdr-binary", "herdr-binary"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = keyMap.get(args[index]);
    if (!key) throw new Error(`unknown argument: ${args[index]}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${args[index]}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  if (typeof options[key] !== "string" || options[key].length === 0) {
    throw new Error(`--${key} is required`);
  }
  return options[key];
}

function requiredAbsolute(options, key) {
  const value = required(options, key);
  if (!value.startsWith("/")) throw new Error(`--${key} must be absolute`);
  return value;
}

function normalizeCommandPaths(command) {
  return {
    ...command,
    logs: {
      stdout: normalizeLogPath(command.logs.stdout),
      stderr: normalizeLogPath(command.logs.stderr),
    },
  };
}

function normalizeLogPath(log) {
  return log.path === null || log.path.startsWith("logs/")
    ? log
    : { ...log, path: `logs/${log.path}` };
}

function isolationReferences(isolation) {
  return {
    state_root_ref: "isolation/state",
    authority_root_ref: "isolation/authority",
    socket_ref: "isolation/authority/owner.sock",
    endpoint_ref: "isolation/authority/owner.json",
    backup_root_ref: "isolation/backup",
    repository_root_ref: "isolation/repository",
    drovr_config_root_ref: "isolation/drovr-config",
    herdr_session_ref: `herdr-session/${canonicalDigest(isolation.herdr_session)}`,
    run_id: isolation.run_id,
    identity_digest: qualificationIsolationIdentity(isolation),
  };
}

function toolIdentity(entrypoints, { herdrBinary = undefined } = {}) {
  const pinned = resolvePinnedQualificationTools({ entrypoints });
  const herdr = herdrBinary === undefined
    ? { path_ref: "external/herdr/not-required", version: "not_required", sha256: hash("herdr-not-required") }
    : observeExecutable(herdrBinary, { pathRef: "external/herdr" });
  return {
    ...pinned,
    herdr,
  };
}

function observeExecutable(path, {
  pathRef,
  invokeWithNode = false,
  nodePath = undefined,
  fallbackVersion = "not_observed",
} = {}) {
  try {
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error("executable path must be absolute");
    const canonical = realpathSync(path);
    const stats = lstatSync(canonical);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("executable is not a regular file");
    const bytes = readFileSync(canonical);
    const version = execFileSync(
      invokeWithNode ? nodePath : canonical,
      invokeWithNode ? [canonical, "--version"] : ["--version"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (version.length === 0) throw new Error("executable returned no version");
    return { path_ref: pathRef, version, sha256: hash(bytes) };
  } catch {
    let sha256 = hash("unobserved");
    try {
      sha256 = hash(readFileSync(realpathSync(path)));
    } catch {
      // Preserve a deterministic non-pass identity when no executable exists.
    }
    return { path_ref: pathRef ?? "external/unobserved", version: fallbackVersion, sha256 };
  }
}

function blockedCleanup(isolation, error) {
  const identities = [
    "isolation/qualification-workspace",
    "isolation/state",
    "isolation/authority",
    "isolation/backup",
    "isolation/repository",
    "isolation/drovr-config",
    ...(isolation?.runtime_directory === null || isolation?.runtime_directory === undefined
      ? []
      : ["isolation/runtime"]),
  ];
  return {
    disposition: "blocked",
    owned_resources: identities.map((identity_ref) => ({ kind: "isolated_root", identity_ref })),
    resource_dispositions: identities.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
      disposition: "cleanup_blocked",
      proof: "cleanup_exception",
    })),
    unresolved_obligations: [{
      code: "cleanup_exception",
      detail: error?.message ?? String(error),
    }],
    completed_at: new Date().toISOString(),
  };
}

function hostIdentity() {
  return qualificationHostIdentity();
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

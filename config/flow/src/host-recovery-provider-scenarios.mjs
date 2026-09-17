import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFlowRuntime,
  statusAutonomousFlowRuntime,
  stopAutonomousFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import {
  createDurableRunAuthority,
} from "../../../tools/flow/src/run-authority.mjs";
import {
  digest,
} from "../../../tools/flow/src/canonical.mjs";
import {
  validateDelegateEvidenceSafety,
} from "../../../tools/flow/src/evidence-safety.mjs";
import {
  createHostAuthorityIdentityAdapter,
} from "../../../tools/flow/src/host-authority-identity.mjs";
import {
  startFlowOwner,
  statusFlowOwner,
  stopFlowOwner,
} from "./owner-process.mjs";
import {
  describeDelegatedAgent,
} from "../../../tools/drovr/src/description.mjs";

export const HOST_RECOVERY_PROVIDER_SCENARIO_SCHEMA =
  "flow.host-recovery-provider-scenario/v1";
export const HOST_RECOVERY_PROVIDER_OBSERVATION_SCHEMA =
  "flow.host-recovery-provider-observation/v1";

const DELEGATE_CONTRACT = "flow.delegated-agent-port/v1";
const DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";
const OPERATION_CONTRACT = "flow.operation/issue-46-provider-probe/v1";
const OPERATION_CONTRACT_RECONCILABLE = "flow.operation/issue-46-provider-outage/v1";
const OPERATION_CONTRACT_ONE_SHOT = "flow.operation/issue-46-provider-one-shot/v1";
const OPERATION_VALIDATOR = "flow.validator/operation-receipt/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_OWNER_BOOT_ID = "boot:issue-46-public-owner";
const PUBLIC_OWNER_RUNTIME_MODULE = "test-support/issue-46-provider-owner-runtime.mjs";
const PROVIDER_STATE_SCHEMA = "flow.issue-46-provider-state/v1";

/**
 * Run the provider-backed part of issue 46 scenarios 1 and 2.
 *
 * The probe uses the production FlowRuntime and durable RunAuthority with a
 * deliberately explicit provider seam. The seam is bounded and records every
 * invocation, so a passing result proves actual authority transitions rather
 * than merely replaying a shaped public response. It does not claim a native
 * Drovr turn was dispatched: the controlled provider is named in the result.
 */
export async function runHostRecoveryProviderScenario(
  scenarioId,
  options = {},
) {
  validateOptions(options);
  if (scenarioId === "concurrent_runs_owner_restart") {
    return runConcurrentProviderScenario(options);
  }
  if (scenarioId === "actionable_failure_recovery") {
    return runFailureProviderScenario(options);
  }
  throw new ProviderScenarioError(
    "scenario_not_supported",
    `provider scenario is not registered for ${scenarioId ?? ""}`,
  );
}

export const runScenario1Provider = (options = {}) =>
  runHostRecoveryProviderScenario("concurrent_runs_owner_restart", options);
export const runScenario2Provider = (options = {}) =>
  runHostRecoveryProviderScenario("actionable_failure_recovery", options);

/**
 * Adapt one provider result for the existing runtime scenario drivers.
 *
 * The returned commandRunner only serves command kinds emitted by the driver,
 * and rejects any other request. This keeps the integration explicit: the
 * driver still validates command identities, public output schemas, watermarks,
 * legal actions, and its own scenario assertions.
 */
export function providerResultDriverInputs(result) {
  if (!isRecord(result) || result.schema !== HOST_RECOVERY_PROVIDER_SCENARIO_SCHEMA) {
    throw new ProviderScenarioError(
      "provider_result_invalid",
      "provider result must use the issue-46 provider scenario schema",
    );
  }
  const driver = result.driver_inputs;
  if (!isRecord(driver) || !isRecord(driver.native_delegate) ||
      !Array.isArray(driver.commands)) {
    throw new ProviderScenarioError(
      "driver_inputs_missing",
      "provider result does not contain runtime-driver inputs",
    );
  }
  const commands = new Map(driver.commands.map((entry) => [entry.kind, entry]));
  return Object.freeze({
    nativeDelegate: structuredClone(driver.native_delegate),
    async commandRunner(request = {}) {
      const kind = request.command_kind ?? request.kind ?? request.args?.[0];
      const entry = commands.get(kind);
      if (!entry) {
        throw new ProviderScenarioError(
          "provider_command_not_recorded",
          `provider probe did not record command kind ${kind ?? "unknown"}`,
        );
      }
      return {
        command: structuredClone(entry.command),
        output: structuredClone(entry.output),
      };
    },
  });
}

async function runConcurrentProviderScenario(options) {
  const startedAt = now();
  if (options.includeOwnerLifecycle === false) {
    return providerScenarioResult({
      scenarioId: "concurrent_runs_owner_restart",
      startedAt,
      status: "blocked",
      reason: "owner_lifecycle_probe_required",
      provider: null,
      commands: [],
      observations: [{
        kind: "capacity",
        content: {
          bounded_capacity: false,
          reason: "owner_lifecycle_probe_required",
        },
      }],
      assertions: [],
      retainedObligations: [{
        code: "owner_lifecycle_probe_required",
        detail: "scenario 1 requires the pinned public owner lifecycle probe",
      }],
    });
  }
  const owner = await createPublicProviderOwner(options, "concurrent_runs_owner_restart");
  const commands = [];
  const publicTranscript = [];
  const observations = [];
  const assertions = [];
  try {
    recordPublicInvocation(owner.startInvocation, commands, publicTranscript);
    const descriptionInvocation = await invokePublicOwnerCommand(owner, [
      "query", "delegated-agent",
      "--harness", "codex",
      "--role", "reviewer",
      "--model", "gpt-5.6-luna",
      "--effort", "low",
      "--capability", "read-only",
      "--caller-metadata", JSON.stringify({
        schema: "flow.issue-46-provider-metadata/v1",
        purpose: "bounded_host_recovery_qualification",
      }),
      "--json",
    ], options.timeoutMs);
    recordPublicInvocation(descriptionInvocation, commands, publicTranscript);
    const description = descriptionInvocation.output?.description;
    if (!isRecord(description)) {
      throw new ProviderScenarioError(
        "public_description_missing",
        "public delegated-agent query did not return a launch description",
      );
    }

    const launches = [];
    for (const index of [0, 1]) {
      const proposal = delegateProposal(description, index, PUBLIC_OWNER_BOOT_ID);
      const preparedInvocation = await invokePublicOwnerCommand(owner, [
        "prepare", "--input", JSON.stringify(proposal), "--json",
      ], options.timeoutMs);
      recordPublicInvocation(preparedInvocation, commands, publicTranscript);
      const prepared = preparedInvocation.output;
      if (prepared?.schema !== "flow.prepared-run/v1") {
        throw new ProviderScenarioError("public_prepare_rejected", `public prepare ${index} was rejected`);
      }
      const launchedInvocation = await invokePublicOwnerCommand(owner, [
        "launch", "--input", JSON.stringify(confirmedLaunchRequest(prepared)), "--json",
      ], options.timeoutMs);
      recordPublicInvocation(launchedInvocation, commands, publicTranscript);
      const launch = launchedInvocation.output;
      if (launch?.created !== true || typeof launch.run_id !== "string") {
        throw new ProviderScenarioError("public_launch_rejected", `public launch ${index} was rejected`);
      }
      launches.push(launch);
      const beforeApproval = await queryPublicRun(owner, launch.run_id, options.timeoutMs);
      recordPublicInvocation(beforeApproval, commands, publicTranscript);
      const approval = beforeApproval.output?.legal_actions?.find((action) =>
        action.type === "checkpoint_decision" && action.decision === "approve");
      if (!approval) {
        throw new ProviderScenarioError("public_approval_missing", `public launch ${index} did not expose approval`);
      }
      const approvalInvocation = await invokePublicOwnerCommand(owner, [
        "command", "--input", JSON.stringify(approval), "--json",
      ], options.timeoutMs);
      recordPublicInvocation(approvalInvocation, commands, publicTranscript);
      if (approvalInvocation.output?.accepted !== true) {
        throw new ProviderScenarioError("public_approval_rejected", `public approval ${index} was rejected`);
      }
    }

    await until(async () => (await readProviderState(owner.statePath)).delegate
      ?.events?.some(({ type }) => type === "dispatch_started"), options.timeoutMs);
    const capacityInvocation = await queryPublicRunnerStatus(owner, options.timeoutMs);
    recordPublicInvocation(capacityInvocation, commands, publicTranscript);
    const capacityStatus = capacityInvocation.output;
    const firstActiveInvocation = await queryPublicRun(owner, launches[0].run_id, options.timeoutMs);
    const secondWaitingInvocation = await queryPublicRun(owner, launches[1].run_id, options.timeoutMs);
    recordPublicInvocation(firstActiveInvocation, commands, publicTranscript);
    recordPublicInvocation(secondWaitingInvocation, commands, publicTranscript);
    const firstActive = firstActiveInvocation.output;
    const secondWaiting = secondWaitingInvocation.output;
    const providerStateBeforeRestart = await readProviderState(owner.statePath);
    observations.push({
      kind: "capacity",
      content: {
        bounded_capacity: capacityStatus?.delegates?.capacity === 1 &&
          capacityStatus.delegates.active === 1 &&
          providerStateBeforeRestart.delegate.dispatch_count === 1 &&
          secondWaiting?.effects?.length === 0 &&
          secondWaiting?.cards?.some(({ status }) => status === "ready"),
        capacity: capacityStatus?.delegates?.capacity ?? 0,
        active_runs: capacityStatus?.runs?.active ?? 0,
        run_ids: launches.map(({ run_id }) => run_id),
        slow_delegate: providerStateBeforeRestart.delegate.events.some(({ type, slow }) =>
          type === "dispatch_started" && slow === true),
        provider_dispatch_count: providerStateBeforeRestart.delegate.dispatch_count,
        watermark: digest(capacityStatus),
        legal_actions: [],
      },
    });

    const clientExitStatus = await invokePublicOwnerCommand(owner, ["status", "--json"], options.timeoutMs);
    recordPublicInvocation(clientExitStatus, commands, publicTranscript);
    const lifecycle = await killAndRestartPublicProviderOwner(owner, options.timeoutMs);
    commands.push(...lifecycle.commands);
    publicTranscript.push(...lifecycle.transcript);
    observations.push({
      kind: "client_exit",
      content: {
        client_exited: clientExitStatus.command.exit_code === 0 && clientExitStatus.command.signal === null,
        client_exit_code: clientExitStatus.command.exit_code,
        owner_survived_client_exit: clientExitStatus.output?.state === "running",
        owner_status: clientExitStatus.output?.state ?? null,
        watermark: digest(clientExitStatus.output),
        legal_actions: [],
      },
    });

    observations.push({
      kind: "owner_restart",
      content: {
        same_boot_restart: lifecycle.same_boot_restart,
        owner_killed: lifecycle.owner_killed,
        termination_signal: lifecycle.termination_signal,
        before_boot_id: lifecycle.before_boot_id,
        after_boot_id: lifecycle.after_boot_id,
        before_process_identity: lifecycle.before_process_identity,
        after_process_identity: lifecycle.after_process_identity,
        same_authority: lifecycle.same_authority,
        run_ids_before_restart: lifecycle.before.run_ids,
        run_ids_after_restart: lifecycle.after.run_ids,
        watermark: digest(lifecycle),
        legal_actions: [],
      },
    });

    const completed = [];
    for (const { run_id: runId } of launches) {
      const query = await waitForPublicRun(owner, runId, (projection) =>
        projection?.phase === "succeeded", options.timeoutMs, commands, publicTranscript);
      completed.push(query.output);
    }
    const providerState = await readProviderState(owner.statePath);
    const effectIds = completed.map((projection) => projection?.effects?.[0]?.effect_id);
    const totalInvocations = providerState.delegate.dispatch_count;
    const manualDriver = publicTranscript.some(({ command }) => command.request?.type === "recovery");
    const effectProof = {
      duplicate_effect: totalInvocations !== 2 ||
        new Set(effectIds).size !== 2 ||
        completed.some((projection) => projection?.effects?.length !== 1) ||
        completed.some((projection) => projection?.effects?.[0]?.status !== "succeeded"),
      invocation_count: completed.some((projection) =>
        projection?.effects?.length === 1 && projection.effects[0]?.status === "succeeded") ? 1 : 0,
      total_invocation_count: totalInvocations,
      effect_id: effectIds[0] ?? null,
      effect_ids: effectIds,
      provider_dispatch_count: totalInvocations,
      provider_recovery_count: providerState.delegate.recovery_count,
      manual_driver: manualDriver,
      post_restart_recovery_command_count: publicTranscript.filter(({ command }) =>
        command.phase === "post_restart" && command.request?.type === "recovery").length,
      watermark: digest(completed),
      legal_actions: [],
    };
    observations.push({ kind: "effect", content: effectProof });

    assertions.push(
      assertion("bounded_capacity", observations, "capacity"),
      assertion("client_exit", observations, "client_exit"),
      assertion("same_boot_owner_restart", observations, "owner_restart"),
      assertion("no_duplicate_effect", observations, "effect"),
    );
    const passed = assertions.every(({ disposition }) => disposition === "pass");
    const nativeDelegate = providerStateObservation(providerState, "delegate");
    return providerScenarioResult({
      scenarioId: "concurrent_runs_owner_restart",
      startedAt,
      status: passed ? "pass" : "blocked",
      reason: passed ? null : "concurrent_provider_proof_incomplete",
      provider: nativeDelegate,
      commands: commands.map(({ command }) => command),
      observations,
      assertions,
      driverInputs: {
        native_delegate: nativeDelegate,
        commands: concurrentDriverCommands({ observations, launches, completed }),
      },
    });
  } catch (error) {
    const state = await readProviderState(owner.statePath).catch(() => null);
    return providerScenarioResult({
      scenarioId: "concurrent_runs_owner_restart",
      startedAt,
      status: "blocked",
      reason: error?.code ?? "provider_scenario_failed",
      provider: state === null ? null : providerStateObservation(state, "delegate"),
      commands: commands.map(({ command }) => command),
      observations,
      assertions,
      retainedObligations: [{
        code: error?.code ?? "provider_scenario_failed",
        detail: safeMessage(error),
      }],
    });
  } finally {
    await stopPublicProviderOwner(owner).catch(() => {});
  }
}

async function createPublicProviderOwner(options, scenario) {
  const root = options.worktreeRoot ?? repositoryRoot();
  const ownsIsolationRoot = options.ownerIsolationRoot === undefined;
  const isolationRoot = options.ownerIsolationRoot ??
    join(tmpdir(), `issue46-provider-owner-${randomUUID()}`);
  const authorityDirectory = options.authorityDirectory ?? join(isolationRoot, "authority");
  const endpointPath = options.ownerEndpointPath ?? join(authorityDirectory, "owner.json");
  const socketPath = options.ownerSocketPath ?? join(authorityDirectory, "owner.sock");
  const stateHome = options.ownerStateHome ?? options.xdgStateHome ??
    join(isolationRoot, "state");
  const home = options.ownerHome ?? options.homeDirectory ?? join(isolationRoot, "home");
  const statePath = join(authorityDirectory, "issue46-provider-state.json");
  await mkdir(isolationRoot, { recursive: true, mode: 0o700 });
  await mkdir(authorityDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stateHome, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = {
    ...providerEnvironment({ ...options, worktreeRoot: root, homeDirectory: home }),
    HOME: home,
    XDG_STATE_HOME: stateHome,
    FLOW_CONFIG_DIRECTORY: join(root, "config/flow"),
    FLOW_QUALIFICATION_REPOSITORY_ROOT: root,
    FLOW_AUTHORITY_DIRECTORY: authorityDirectory,
    FLOW_OWNER_ENDPOINT_PATH: endpointPath,
    FLOW_OWNER_SOCKET_PATH: socketPath,
    FLOW_SOCKET_PATH: socketPath,
    FLOW_OWNER_RUNTIME_MODULE: join(root, "config/flow", PUBLIC_OWNER_RUNTIME_MODULE),
    FLOW_ISSUE46_PROVIDER_SCENARIO: scenario,
    FLOW_ISSUE46_PROVIDER_STATE: statePath,
    DROVR_CONFIG_DIR: options.drovrConfigDirectory ?? join(root, "config/drovr"),
  };
  const logRoot = join(isolationRoot, "public-command-logs");
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  const startOutput = await startFlowOwner({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
    ownerScript: join(root, "config/flow/test-support/issue-46-provider-owner-entrypoint.mjs"),
    waitMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    runnerOptions: { delegateCapacity: 1, operationCapacity: 1 },
  });
  const start = lifecycleInvocation("start", startOutput, {
    root,
    authorityDirectory,
    endpointPath,
    socketPath,
  }, "owner-process");
  if (startOutput?.state !== "running" || !Number.isSafeInteger(startOutput?.pid)) {
    throw new ProviderScenarioError(
      "public_owner_start_failed",
      `pinned public owner did not start: ${JSON.stringify(startOutput)}`,
    );
  }
  return {
    root,
    env,
    endpointPath,
    socketPath,
    authorityDirectory,
    isolationRoot,
    stateHome,
    home,
    statePath,
    logRoot,
    ownsIsolationRoot,
    startOutput,
    startInvocation: start,
  };
}

async function invokePublicOwnerCommand(owner, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new ProviderScenarioError("public_command_invalid", "public owner command must not be empty");
  }
  const id = `${args[0]}-${randomUUID()}`;
  const stdoutName = `${id}.stdout.log`;
  const stderrName = `${id}.stderr.log`;
  const stdoutPath = join(owner.logRoot, stdoutName);
  const stderrPath = join(owner.logRoot, stderrName);
  const cliPath = join(owner.root, "config/flow/src/cli.mjs");
  const startedAt = now();
  const result = await spawnPublicOwnerProcess({
    nodePath: process.execPath,
    cliPath,
    cwd: owner.root,
    env: owner.env,
    args,
    timeoutMs,
  });
  const finishedAt = now();
  await writeFile(stdoutPath, result.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(stderrPath, result.stderr, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const command = {
    id,
    argv: ["node", relative(owner.root, cliPath), ...args],
    command_kind: args[0],
    launcher_ref: relative(owner.root, cliPath),
    host_ref: "public/flow-owner",
    working_directory_ref: "isolated/provider-owner",
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: result.signal,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: result.timedOut,
    client_exited: result.exitCode === 0 && result.signal === null,
    request: parsePublicRequest(args),
    logs: {
      stdout: {
        path: `public-command-logs/${stdoutName}`,
        sha256: digest(result.stdout),
        bytes: Buffer.byteLength(result.stdout),
      },
      stderr: {
        path: `public-command-logs/${stderrName}`,
        sha256: digest(result.stderr),
        bytes: Buffer.byteLength(result.stderr),
      },
    },
  };
  return { command, output: parsePublicJson(result.stdout), stdout: result.stdout, stderr: result.stderr };
}

function spawnPublicOwnerProcess({ nodePath, cliPath, cwd, env, args, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(nodePath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        timedOut,
      });
    });
  });
}

function parsePublicJson(source) {
  const lines = String(source).trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of [...lines].reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // A public watch can emit several frames; the last complete frame is used.
    }
  }
  return null;
}

function parsePublicRequest(args) {
  const index = args.findIndex((arg) => arg === "--input" || arg === "--request");
  if (index < 0 || typeof args[index + 1] !== "string") return null;
  try {
    return JSON.parse(args[index + 1]);
  } catch {
    return null;
  }
}

function lifecycleInvocation(kind, output, owner, launcherRef) {
  const serialized = JSON.stringify(output);
  const timestamp = now();
  return {
    command: {
      id: `${kind}-${randomUUID()}`,
      argv: [launcherRef, kind, "--json"],
      command_kind: kind,
      launcher_ref: launcherRef,
      host_ref: "public/flow-owner",
      working_directory_ref: "isolated/provider-owner",
      started_at: timestamp,
      finished_at: timestamp,
      duration_ms: 0,
      exit_code: 0,
      signal: null,
      expected_exit_code: 0,
      expected_signal: null,
      expected_timed_out: false,
      timed_out: false,
      client_exited: true,
      request: null,
      logs: {
        stdout: { path: null, sha256: digest(serialized), bytes: Buffer.byteLength(serialized) },
        stderr: { path: null, sha256: digest(""), bytes: 0 },
      },
    },
    output,
  };
}

function recordPublicInvocation(invocation, commands, transcript, phase = undefined) {
  if (phase !== undefined) invocation.command.phase = phase;
  commands.push(invocation);
  transcript.push(invocation);
}

async function queryPublicRun(owner, runId, timeoutMs) {
  return invokePublicOwnerCommand(owner, [
    "query", "--input", JSON.stringify({ run_id: runId }), "--json",
  ], timeoutMs);
}

async function queryPublicRunnerStatus(owner, timeoutMs) {
  return invokePublicOwnerCommand(owner, [
    "query", "--input", JSON.stringify({
      schema: "flow.query/v1",
      query: "autonomous_runner_status",
    }), "--json",
  ], timeoutMs);
}

async function waitForPublicRun(owner, runId, predicate, timeoutMs, commands, transcript) {
  let latest = null;
  await until(async () => {
    latest = await queryPublicRun(owner, runId, timeoutMs);
    recordPublicInvocation(latest, commands, transcript);
    return predicate(latest.output);
  }, timeoutMs);
  return latest;
}

async function killAndRestartPublicProviderOwner(owner, timeoutMs) {
  const commands = [];
  const transcript = [];
  const beforeIndex = await invokePublicOwnerCommand(owner, [
    "query", "--input", JSON.stringify({}), "--json",
  ], timeoutMs);
  recordPublicInvocation(beforeIndex, commands, transcript, "pre_restart");
  const beforeState = await readProviderState(owner.statePath);
  const beforeIdentity = owner.startOutput.process_identity;
  const pid = owner.startOutput.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new ProviderScenarioError("owner_pid_unavailable", "public owner did not publish a usable PID");
  }
  process.kill(pid, "SIGKILL");
  await until(async () => {
    const status = await invokePublicOwnerCommand(owner, ["status", "--json"], timeoutMs);
    recordPublicInvocation(status, commands, transcript, "post_kill");
    return ["stale", "stopped"].includes(status.output?.state);
  }, timeoutMs);
  const restartedOutput = await startFlowOwner({
    env: owner.env,
    authorityDirectory: owner.authorityDirectory,
    endpointPath: owner.endpointPath,
    socketPath: owner.socketPath,
    ownerScript: join(owner.root, "config/flow/test-support/issue-46-provider-owner-entrypoint.mjs"),
    waitMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    runnerOptions: { delegateCapacity: 1, operationCapacity: 1 },
  });
  const restarted = lifecycleInvocation("start", restartedOutput, owner, "owner-process");
  restarted.command.phase = "post_restart";
  recordPublicInvocation(restarted, commands, transcript, "post_restart");
  if (restartedOutput?.state !== "running") {
    throw new ProviderScenarioError("public_owner_restart_failed", "public owner did not restart");
  }
  owner.startOutput = restartedOutput;
  const afterIndex = await invokePublicOwnerCommand(owner, [
    "query", "--input", JSON.stringify({}), "--json",
  ], timeoutMs);
  recordPublicInvocation(afterIndex, commands, transcript, "post_restart");
  const afterState = await readProviderState(owner.statePath);
  return {
    commands,
    transcript,
    owner_killed: true,
    termination_signal: "SIGKILL",
    same_authority: owner.startOutput.authority_directory === owner.authorityDirectory,
    before_boot_id: beforeState.boot_id,
    after_boot_id: afterState.boot_id,
    before_process_identity: beforeIdentity,
    after_process_identity: restartedOutput.process_identity,
    same_boot_restart: beforeState.boot_id === afterState.boot_id &&
      beforeIdentity !== restartedOutput.process_identity,
    before: {
      run_ids: Array.isArray(beforeIndex.output?.runs) ? beforeIndex.output.runs : [],
      state: beforeIndex.output,
    },
    after: {
      run_ids: Array.isArray(afterIndex.output?.runs) ? afterIndex.output.runs : [],
      state: afterIndex.output,
    },
  };
}

async function stopPublicProviderOwner(owner) {
  let result = null;
  try {
    const stopped = await invokePublicOwnerCommand(owner, ["stop", "--json"], DEFAULT_TIMEOUT_MS);
    if (["stopped", "stale"].includes(stopped.output?.state)) result = stopped.output;
  } catch {
    // The identity-checked fallback below is bounded cleanup only.
  }
  if (result === null) {
    await stopFlowOwner({
      env: owner.env,
      authorityDirectory: owner.authorityDirectory,
      endpointPath: owner.endpointPath,
      socketPath: owner.socketPath,
      force: true,
    }).catch(() => {});
  }
  if (owner.ownsIsolationRoot) {
    await rm(owner.isolationRoot, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

async function runPublicOperationCase(owner, kind, options, commands, transcript) {
  const settings = {
    cancellation: { classification: "caller_idempotent", maxAttempts: 1, includeCancel: true },
    deadline: { classification: "caller_idempotent", maxAttempts: 1 },
    "capped-recovery": { classification: "caller_idempotent", maxAttempts: 2 },
    "provider-outage": { classification: "reconcilable", maxAttempts: 1 },
    "invalid-output": { classification: "caller_idempotent", maxAttempts: 1 },
  }[kind];
  if (settings === undefined) throw new ProviderScenarioError("operation_case_unknown", kind);
  const proposal = operationProposal({
    ...settings,
    value: kind,
    bootId: PUBLIC_OWNER_BOOT_ID,
    contract: settings.classification === "reconcilable"
      ? OPERATION_CONTRACT_RECONCILABLE
      : OPERATION_CONTRACT,
  });
  if (kind === "deadline") {
    proposal.graph.cards.at(-1).limits.max_active_seconds = 1;
    proposal.explicit_facts.limits.max_elapsed_seconds = 30;
  }
  const launched = await publicLaunchOperation(owner, proposal, commands, transcript, options.timeoutMs);
  const { runId } = launched;
  await until(async () => (await readProviderState(owner.statePath)).operation
    ?.events?.some(({ kind: eventKind, value }) => eventKind === "invocation_started" && value === kind), options.timeoutMs);
  if (kind === "cancellation") {
    const active = await queryPublicRun(owner, runId, options.timeoutMs);
    recordPublicInvocation(active, commands, transcript);
    const cancel = active.output?.legal_actions?.find(({ type }) => type === "cancel");
    if (!cancel) throw new ProviderScenarioError("cancellation_action_missing", "public cancellation action missing");
    const cancellation = await invokePublicOwnerCommand(owner, [
      "command", "--input", JSON.stringify(cancel), "--json",
    ], options.timeoutMs);
    recordPublicInvocation(cancellation, commands, transcript);
    const final = await waitForPublicRun(owner, runId, (projection) => projection?.phase === "cancelled",
      options.timeoutMs, commands, transcript);
    return caseResult(kind, final.output, 1, [cancel]);
  }
  if (kind === "deadline") {
    const active = await queryPublicRun(owner, runId, options.timeoutMs);
    recordPublicInvocation(active, commands, transcript);
    const legalActions = active.output?.legal_actions ?? [];
    await advanceProviderClock(owner.statePath, 2_000);
    const expired = await waitForPublicRun(owner, runId,
      (projection) => projection?.execution_time?.status === "exhausted",
      options.timeoutMs, commands, transcript);
    await waitForPublicRun(owner, runId, (projection) => projection?.phase === "succeeded",
      options.timeoutMs, commands, transcript);
    return caseResult(kind, expired.output, 1, legalActions);
  }
  if (kind === "capped-recovery") {
    const failed = await waitForPublicRun(owner, runId,
      (projection) => projection?.effects?.[0]?.last_observation !== null,
      options.timeoutMs, commands, transcript);
    const recovery = failed.output?.legal_actions?.find(({ type }) => type === "recovery");
    if (!recovery) throw new ProviderScenarioError("recovery_action_missing", "public capped recovery action missing");
    const recoveryCommand = await invokePublicOwnerCommand(owner, [
      "command", "--input", JSON.stringify(recovery), "--json",
    ], options.timeoutMs);
    recordPublicInvocation(recoveryCommand, commands, transcript);
    const exhausted = await waitForPublicRun(owner, runId,
      (projection) => projection?.effects?.[0]?.retry?.status === "exhausted",
      options.timeoutMs, commands, transcript);
    return caseResult(kind, exhausted.output, 2, failed.output?.legal_actions ?? []);
  }
  const projection = await waitForPublicRun(owner, runId,
    (value) => value?.effects?.[0]?.last_observation !== null,
    options.timeoutMs, commands, transcript);
  const state = await readProviderState(owner.statePath);
  const invocationCount = state.operation.invocation_counts[kind] ?? 1;
  return caseResult(kind, projection.output, invocationCount, projection.output?.legal_actions ?? []);
}

async function publicLaunchOperation(owner, proposal, commands, transcript, timeoutMs) {
  const prepared = await invokePublicOwnerCommand(owner, [
    "prepare", "--input", JSON.stringify(proposal), "--json",
  ], timeoutMs);
  recordPublicInvocation(prepared, commands, transcript);
  if (prepared.output?.schema !== "flow.prepared-run/v1") {
    throw new ProviderScenarioError("public_prepare_rejected", "public operation prepare was rejected");
  }
  const launched = await invokePublicOwnerCommand(owner, [
    "launch", "--input", JSON.stringify(confirmedLaunchRequest(prepared.output)), "--json",
  ], timeoutMs);
  recordPublicInvocation(launched, commands, transcript);
  if (launched.output?.created !== true) {
    throw new ProviderScenarioError("public_launch_rejected", "public operation launch was rejected");
  }
  const runId = launched.output.run_id;
  let projection = await queryPublicRun(owner, runId, timeoutMs);
  recordPublicInvocation(projection, commands, transcript);
  const approval = projection.output?.legal_actions?.find(({ type, decision }) =>
    type === "checkpoint_decision" && decision === "approve");
  if (approval) {
    const approvalCommand = await invokePublicOwnerCommand(owner, [
      "command", "--input", JSON.stringify(approval), "--json",
    ], timeoutMs);
    recordPublicInvocation(approvalCommand, commands, transcript);
    if (approvalCommand.output?.accepted !== true) {
      throw new ProviderScenarioError("public_approval_rejected", "public operation approval was rejected");
    }
    projection = await queryPublicRun(owner, runId, timeoutMs);
    recordPublicInvocation(projection, commands, transcript);
  }
  const execution = projection.output?.legal_actions?.find(({ type }) => type === "operation_execute");
  if (!execution) {
    // Checkpoint-bound operations may be admitted and dispatched as part of
    // the public checkpoint command. Recovery is then the next legal public
    // action, with no second operation_execute command to issue.
    const recovery = projection.output?.legal_actions?.find(({ type }) => type === "recovery");
    if (recovery) return { runId, projection: projection.output };
    throw new ProviderScenarioError("operation_action_missing", `no public operation execute action for ${runId}`);
  }
  const executionCommand = await invokePublicOwnerCommand(owner, [
    "command", "--input", JSON.stringify(execution), "--json",
  ], timeoutMs);
  recordPublicInvocation(executionCommand, commands, transcript);
  if (executionCommand.output?.accepted !== true) {
    throw new ProviderScenarioError("public_execution_rejected", `public operation execute was rejected for ${runId}`);
  }
  return { runId, projection: projection.output };
}

async function runPublicOneShotCase(owner, options, commands, transcript) {
  const proposal = operationProposal({
    classification: "one_shot_uncertain",
    maxAttempts: 1,
    value: "one-shot",
    bootId: PUBLIC_OWNER_BOOT_ID,
    contract: OPERATION_CONTRACT_ONE_SHOT,
  });
  const launched = await publicLaunchOperation(owner, proposal, commands, transcript, options.timeoutMs);
  const runId = launched.runId;
  await until(async () => (await readProviderState(owner.statePath)).operation
    ?.events?.some(({ kind, value }) => kind === "invocation_started" && value === "one-shot"), options.timeoutMs);
  const restarted = await killAndRestartPublicProviderOwner(owner, options.timeoutMs);
  commands.push(...restarted.commands);
  transcript.push(...restarted.transcript);
  const projection = await queryPublicRun(owner, runId, options.timeoutMs);
  recordPublicInvocation(projection, commands, transcript, "post_restart");
  const state = await readProviderState(owner.statePath);
  return {
    projection: projection.output,
    invocations: state.operation.invocation_counts["one-shot"] ?? 0,
    noDuplicate: (state.operation.invocation_counts["one-shot"] ?? 0) === 1 &&
      projection.output?.effects?.[0]?.status === "uncertain",
    legalActions: projection.output?.legal_actions ?? [],
    effectId: projection.output?.effects?.[0]?.effect_id ?? null,
  };
}

async function advanceProviderClock(statePath, elapsedMs) {
  await updateProviderState(statePath, (state) => {
    state.clock_value_ms = (state.clock_value_ms ?? 1_700_000_000_000) + elapsedMs;
    return state;
  });
}

async function readProviderState(statePath) {
  const source = await readFile(statePath, "utf8");
  const value = JSON.parse(source);
  if (!isRecord(value) || value.schema !== PROVIDER_STATE_SCHEMA) {
    throw new ProviderScenarioError("provider_state_invalid", "controlled provider state is invalid");
  }
  return value;
}

async function updateProviderState(statePath, updater) {
  const current = await readFile(statePath, "utf8")
    .then((source) => JSON.parse(source))
    .catch(() => initialProviderState("unknown"));
  const next = await updater(structuredClone(current));
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, statePath);
  return next;
}

function initialProviderState(scenario) {
  return {
    schema: PROVIDER_STATE_SCHEMA,
    version: 1,
    scenario,
    boot_id: PUBLIC_OWNER_BOOT_ID,
    clock_value_ms: 1_700_000_000_000,
    owner_processes: [],
    delegate: {
      dispatch_count: 0,
      recovery_count: 0,
      turns: {},
      events: [],
    },
    operation: {
      invocation_count: 0,
      invocation_counts: {},
      events: [],
    },
  };
}

function providerStateObservation(state, kind) {
  const bucket = kind === "delegate" ? state.delegate : state.operation;
  const invocationCount = kind === "delegate"
    ? bucket.dispatch_count
    : bucket.invocation_count;
  const transcript = {
    provider: `controlled/issue-46-${kind}`,
    scenario: state.scenario,
    boot_id: state.boot_id,
    invocation_count: invocationCount,
    dispatch_count: bucket.dispatch_count ?? invocationCount,
    events: bucket.events,
  };
  return {
    schema: "flow.native-delegate-observation/v1",
    status: invocationCount > 0 ? "observed" : "blocked",
    provider_identity: `controlled/issue-46-${kind}`,
    watermark: digest(transcript),
    invocation_count: invocationCount,
    dispatch_attempted: invocationCount > 0,
    reason: invocationCount > 0 ? null : "controlled_provider_not_invoked",
    transcript,
  };
}

function safeConcurrentDiagnostic(runtime, provider) {
  try {
    const host = runtime.query();
    return {
      dispatch_count: provider.dispatchCount(),
      runs: host.runs.map((runId) => {
        const projection = runtime.query({ run_id: runId });
        return {
          run_id: runId,
          phase: projection.phase,
          cards: projection.cards,
          effects: projection.effects.map(({ effect_id, status, last_observation }) => ({
            effect_id,
            status,
            last_observation,
          })),
          legal_actions: projection.legal_actions.map(({ type, decision, recovery }) => ({ type, decision, recovery })),
        };
      }),
    };
  } catch {
    return null;
  }
}

async function runFailureProviderScenario(options) {
  const startedAt = now();
  const owner = await createPublicProviderOwner(options, "actionable_failure_recovery");
  const observations = [];
  const assertions = [];
  const commands = [];
  const publicTranscript = [];
  try {
    recordPublicInvocation(owner.startInvocation, commands, publicTranscript);
    const cancellation = await runPublicOperationCase(owner, "cancellation", options, commands, publicTranscript);
    const deadline = await runPublicOperationCase(owner, "deadline", options, commands, publicTranscript);
    const capped = await runPublicOperationCase(owner, "capped-recovery", options, commands, publicTranscript);
    const outage = await runPublicOperationCase(owner, "provider-outage", options, commands, publicTranscript);
    const invalid = await runPublicOperationCase(owner, "invalid-output", options, commands, publicTranscript);
    const uncertainty = await runPublicOneShotCase(owner, options, commands, publicTranscript);
    const failureFacts = buildFailureFacts({
      cancellation,
      deadline,
      capped,
      outage,
      invalid,
    });
    const uncertaintyFacts = buildUncertaintyFacts(uncertainty);
    observations.push({ kind: "failure", content: failureFacts });
    observations.push({ kind: "uncertainty", content: uncertaintyFacts });
    assertions.push(
      assertion("typed_failure_observations", observations, "failure"),
      assertion("one_shot_uncertainty_no_duplicate_effect", observations, "uncertainty"),
    );
    const passed = assertions.every(({ disposition }) => disposition === "pass");
    const providerState = await readProviderState(owner.statePath);
    const nativeDelegate = providerStateObservation(providerState, "operation");
    const driverInputs = {
      native_delegate: nativeDelegate,
      commands: failureDriverCommands({ failureFacts, uncertaintyFacts }),
    };
    return providerScenarioResult({
      scenarioId: "actionable_failure_recovery",
      startedAt,
      status: passed ? "pass" : "blocked",
      reason: passed ? null : "failure_provider_proof_incomplete",
      provider: nativeDelegate,
      commands: commands.map(({ command }) => command),
      observations,
      assertions,
      driverInputs,
    });
  } catch (error) {
    return providerScenarioResult({
      scenarioId: "actionable_failure_recovery",
      startedAt,
      status: "blocked",
      reason: error?.code ?? "provider_scenario_failed",
      provider: await readProviderState(owner.statePath)
        .then((state) => providerStateObservation(state, "operation"))
        .catch(() => null),
      commands: commands.map(({ command }) => command),
      observations,
      assertions,
      retainedObligations: [{
        code: error?.code ?? "provider_scenario_failed",
        detail: safeMessage(error),
      }],
    });
  } finally {
    await stopPublicProviderOwner(owner).catch(() => {});
  }
}

/**
 * Runtime factory loaded by the detached public owner for the two provider
 * scenarios. The durable authority and the controlled provider are created in
 * the owner process; the parent process can only reach them through cli.mjs.
 */
export async function createIssue46ProviderRuntime({
  authorityDirectory,
  env = process.env,
  runnerOptions = {},
} = {}) {
  const scenario = env.FLOW_ISSUE46_PROVIDER_SCENARIO;
  if (!["concurrent_runs_owner_restart", "actionable_failure_recovery"].includes(scenario)) {
    throw new ProviderScenarioError("provider_scenario_invalid", "unsupported issue-46 owner provider scenario");
  }
  const statePath = env.FLOW_ISSUE46_PROVIDER_STATE ??
    join(authorityDirectory, "issue46-provider-state.json");
  await initializeProviderState(statePath, scenario);
  await updateProviderState(statePath, (state) => {
    state.scenario = scenario;
    state.owner_processes.push({
      pid: process.pid,
      process_identity: `provider-owner:${process.pid}`,
      started_at: now(),
    });
    return state;
  });
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 4,
    hostIdentityAdapter: fixedHostIdentity(
      PUBLIC_OWNER_BOOT_ID,
      `provider-owner:${process.pid}`,
    ),
    timeObservationAdapter: providerTimeAdapter(statePath),
    retryTimeAdapter: providerTimeAdapter(statePath),
  });
  const delegateProvider = scenario === "concurrent_runs_owner_restart"
    ? createPersistentDelegateProvider({ env, statePath })
    : null;
  const operationRegistration = scenario === "actionable_failure_recovery"
    ? createPersistentOperationRegistration({ statePath })
    : null;
  const registeredQueries = {
    autonomous_runner_status() {
      return statusAutonomousFlowRuntime(runtime);
    },
  };
  if (delegateProvider !== null) {
    registeredQueries.delegated_agent_description = (request) =>
      delegateProvider.port.describe({
        schema: "flow.delegated-agent-description-request/v1",
        launch: request.launch,
        caller_metadata: request.caller_metadata,
      });
  }
  let runtime;
  runtime = createFlowRuntime({
    autonomous: scenario === "concurrent_runs_owner_restart",
    runAuthority: authority,
    delegatedAgentPort: delegateProvider?.port ?? null,
    delegateOutputValidators: delegateProvider?.validators ?? {},
    registeredOperations: operationRegistration === null
      ? {}
      : {
        [OPERATION_CONTRACT]: operationRegistration.caller,
        [OPERATION_CONTRACT_RECONCILABLE]: operationRegistration.reconcilable,
        [OPERATION_CONTRACT_ONE_SHOT]: operationRegistration.oneShot,
      },
    registeredQueries,
    runnerOptions: {
      delegateCapacity: runnerOptions.delegateCapacity ?? 1,
      operationCapacity: runnerOptions.operationCapacity ?? 1,
    },
  });
  return {
    ...runtime,
    mutationAuthority: true,
    close() {
      stopAutonomousFlowRuntime(runtime);
      authority.close();
    },
  };
}

async function initializeProviderState(statePath, scenario) {
  try {
    const current = await readProviderState(statePath);
    if (current.scenario !== scenario) {
      throw new ProviderScenarioError("provider_state_scenario_mismatch", "provider state belongs to another scenario");
    }
    return current;
  } catch (error) {
    if (error?.code === "provider_state_scenario_mismatch") throw error;
    const state = initialProviderState(scenario);
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(statePath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }).catch(async (writeError) => {
      if (writeError?.code !== "EEXIST") throw writeError;
      const current = await readProviderState(statePath);
      if (current.scenario !== scenario) throw new ProviderScenarioError(
        "provider_state_scenario_mismatch",
        "provider state belongs to another scenario",
      );
    });
  }
}

function providerTimeAdapter(statePath) {
  return {
    observe() {
      let wallValueMs = 1_700_000_000_000;
      try {
        wallValueMs = JSON.parse(readFileSync(statePath, "utf8"))
          .clock_value_ms ?? wallValueMs;
      } catch {
        // The initial fixed fact is used until the provider state is published.
      }
      return issue46ExecutionTimeFacts({
        wallValueMs,
        bootId: PUBLIC_OWNER_BOOT_ID,
      });
    },
  };
}

function createPersistentDelegateProvider({ env, statePath }) {
  let description = null;
  const turns = new Map();
  const port = Object.freeze({
    contract: DELEGATE_CONTRACT,
    async describe() {
      const value = await getDescription();
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "compatible",
        watermark: value.watermark,
        description: value,
        compatibility: { contract: DELEGATE_CONTRACT, code: null, findings: [] },
        legal_next_actions: ["bind_exact_launch_description"],
      };
    },
    async discover(request) {
      const state = await readProviderState(statePath);
      const stored = state.delegate.turns[request.caller_key];
      if (!stored) {
        return {
          schema: "flow.delegated-agent-lifecycle-projection/v1",
          operation: "discover",
          status: "proven_absent",
          watermark: digest({ caller_key: request.caller_key, status: "absent" }),
          delegation: null,
          turn: null,
          legal_next_actions: ["dispatch_exact_launch"],
        };
      }
      const value = await getDescription();
      const projection = storedTurnProjection(stored, value);
      if (stored.status === "working" && stored.process_id !== process.pid) {
        await updateProviderState(statePath, (next) => {
          next.delegate.recovery_count += 1;
          next.delegate.events.push({
            type: "turn_recovered",
            caller_key: request.caller_key,
            process_id: process.pid,
            at: now(),
          });
          return next;
        });
      }
      return projection;
    },
    async dispatch(request) {
      const value = await getDescription();
      const ordinal = (await readProviderState(statePath)).delegate.dispatch_count + 1;
      const turnId = `turn:issue-46-public-${ordinal}`;
      const stored = {
        caller_key: request.caller_key,
        input_key: request.input_key,
        payload_sha256: request.payload_sha256,
        agent_id: request.agent_id,
        turn_id: turnId,
        ordinal,
        process_id: process.pid,
        status: "working",
      };
      await updateProviderState(statePath, (next) => {
        next.delegate.dispatch_count += 1;
        next.delegate.turns[request.caller_key] = stored;
        next.delegate.events.push({
          type: "dispatch_started",
          caller_key: request.caller_key,
          effect_id: request.caller_key,
          process_id: process.pid,
          slow: ordinal === 1,
          at: now(),
        });
        return next;
      });
      if (ordinal === 1) {
        await new Promise(() => {});
      }
      await completePersistentTurn(statePath, request.caller_key, value, request);
      return storedTurnProjection({ ...stored, status: "completed" }, value);
    },
    async send() {
      throw new ProviderScenarioError("unexpected_delegate_send", "scenario does not permit steering");
    },
    async observe(request) {
      const state = await readProviderState(statePath);
      const stored = Object.values(state.delegate.turns).find(({ turn_id: turnId }) => turnId === request.turn_id);
      if (!stored) return blockedTurnProjection("turn_not_found");
      return storedTurnProjection(stored, await getDescription());
    },
    async wait(request) {
      const state = await readProviderState(statePath);
      const stored = Object.values(state.delegate.turns).find(({ turn_id: turnId }) => turnId === request.turn_id);
      if (!stored) return blockedTurnProjection("turn_not_found");
      const value = await getDescription();
      if (stored.status === "working") {
        await completePersistentTurn(statePath, stored.caller_key, value, {
          caller_key: stored.caller_key,
          input_key: stored.input_key,
          payload_sha256: stored.payload_sha256,
        });
        stored.status = "completed";
      }
      return storedTurnProjection(stored, value);
    },
    async cancel(request) {
      const state = await readProviderState(statePath);
      const stored = Object.values(state.delegate.turns).find(({ turn_id: turnId }) => turnId === request.turn_id);
      return stored ? storedTurnProjection({ ...stored, status: "cancelled" }, await getDescription()) :
        blockedTurnProjection("turn_not_found");
    },
    async reconcile() {
      return blockedTurnProjection("reconciliation_not_required");
    },
    async retire(request) {
      const agentId = request?.agent_id ?? "agent:issue-46";
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "controlled",
          agent_id: agentId,
          record_sha256: digest({ retired: true, agent_id: agentId }),
        },
        delegation: { agent_id: agentId, task_id: "task:issue-46", group_id: "group:issue-46" },
        turn: null,
        legal_next_actions: [],
      };
    },
  });
  return {
    port,
    validators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) { return output === "accepted output"; },
        evidenceSafety: validateDelegateEvidenceSafety,
      },
    },
  };

  async function getDescription() {
    if (description === null) {
      description = await describeDelegatedAgent({
        schema: "drovr.delegated-agent-description-request/v1",
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6-luna",
          effort: "low",
          capability: "read-only",
        },
        caller_metadata: {
          schema: "flow.issue-46-provider-metadata/v1",
          purpose: "bounded_host_recovery_qualification",
        },
      }, { env, requireCompatibility: false });
    }
    return description;
  }
}

async function completePersistentTurn(statePath, callerKey, description, request) {
  await updateProviderState(statePath, (state) => {
    const stored = state.delegate.turns[callerKey];
    if (!stored || stored.status === "completed") return state;
    stored.status = "completed";
    stored.completed_at = now();
    state.delegate.events.push({ type: "turn_completed", caller_key: callerKey, process_id: process.pid, at: stored.completed_at });
    return state;
  });
  return storedTurnProjection({
    ...(await readProviderState(statePath)).delegate.turns[callerKey],
    status: "completed",
  }, description);
}

function storedTurnProjection(stored, description) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: stored.status,
    watermark: {
      schema: "drovr.turn-authority-watermark/v1",
      authority: "controlled",
      turn_id: stored.turn_id,
      record_sha256: digest(stored),
    },
    delegation: { agent_id: stored.agent_id, task_id: `task:issue-46-${stored.ordinal}`, group_id: "group:issue-46" },
    turn: {
      id: stored.turn_id,
      status: stored.status,
      caller: { dispatch_key: stored.caller_key, payload_sha256: stored.payload_sha256, metadata: description.caller_metadata },
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: description.comparison_keys.launch,
        configuration_watermark: description.watermark.content_sha256,
        description_digest: description.description_digest,
      },
      inputs: [{ sequence: 1, caller_key: stored.input_key, payload_sha256: stored.payload_sha256, delivery: { status: "submitted" } }],
      ...(stored.status === "completed" ? {
        result: { text: "accepted output", messages: ["accepted output"] },
        settlement_proof: settlementProof({ input_key: stored.input_key, payload_sha256: stored.payload_sha256 }, description),
      } : {}),
    },
    legal_next_actions: stored.status === "completed" ? ["retire_agent"] : ["turn_wait", "turn_cancel"],
  };
}

function createPersistentOperationRegistration({ statePath }) {
  return {
    caller: createPersistentOperationRegistrationForClass(statePath, "caller_idempotent"),
    reconcilable: createPersistentOperationRegistrationForClass(statePath, "reconcilable"),
    oneShot: createPersistentOperationRegistrationForClass(statePath, "one_shot_uncertain"),
  };
}

function createPersistentOperationRegistrationForClass(statePath, classification) {
  return {
    classification,
    async invoke(intent) {
      const value = intent.operation_input?.value;
      await updateProviderState(statePath, (state) => {
        state.operation.invocation_count += 1;
        state.operation.invocation_counts[value] = (state.operation.invocation_counts[value] ?? 0) + 1;
        state.operation.events.push({
          kind: "invocation_started",
          value,
          effect_id: intent.effect_id,
          process_id: process.pid,
          at: now(),
        });
        return state;
      });
      if (value === "cancellation") {
        await delay(250);
        return operationReceipt(intent);
      }
      if (value === "deadline") {
        await delay(250);
        return operationReceipt(intent);
      }
      if (value === "capped-recovery") {
        const state = await readProviderState(statePath);
        const count = state.operation.invocation_counts[value] ?? 0;
        const error = new Error("controlled provider outage");
        error.code = count <= 2 ? "provider_unavailable" : "unexpected_invocation";
        throw error;
      }
      if (value === "provider-outage") {
        const error = new Error("controlled provider outage");
        error.code = "provider_unavailable";
        throw error;
      }
      if (value === "invalid-output") {
        return { schema: "flow.invalid-provider-output/v1", accepted: false };
      }
      if (value === "one-shot") {
        await delay(1_000);
        throw new Error("controlled receipt uncertainty");
      }
      return operationReceipt(intent);
    },
    observe(intent) {
      if (intent.operation_input?.value === "provider-outage") {
        return effectObservation(intent, "indeterminate", { status: "provider_unavailable" });
      }
      if (intent.operation_input?.value === "one-shot") {
        return effectObservation(intent, "indeterminate", { found: false });
      }
      return null;
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function createProviderAuthority(authorityDirectory, { processIdentity }) {
  return createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 4,
    hostIdentityAdapter: fixedHostIdentity("boot:issue-46", processIdentity),
    timeObservationAdapter: fixedTimeAdapter(),
    retryTimeAdapter: fixedTimeAdapter(),
  });
}

function createControlledDelegateProvider({ env, model, effort }) {
  let description = null;
  let dispatches = 0;
  let slowObserved = false;
  let releaseSlow;
  let slowPromise;
  const turns = new Map();
  const invocationKeys = [];

  const port = Object.freeze({
    contract: DELEGATE_CONTRACT,
    async describe() {
      const value = await getDescription();
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "compatible",
        watermark: value.watermark,
        description: value,
        compatibility: { contract: DELEGATE_CONTRACT, code: null, findings: [] },
        legal_next_actions: [],
      };
    },
    async discover(request) {
      const turn = turns.get(request.caller_key);
      if (!turn) {
        return {
          schema: "flow.delegated-agent-lifecycle-projection/v1",
          operation: "discover",
          status: "proven_absent",
          watermark: digest({ caller_key: request.caller_key, status: "absent" }),
          delegation: null,
          turn: null,
          legal_next_actions: ["dispatch_exact_launch"],
        };
      }
      return cloneTurnProjection(turn);
    },
    async dispatch(request) {
      dispatches += 1;
      invocationKeys.push(request.caller_key);
      const value = await getDescription();
      const turn = workingTurnProjection(request, value, dispatches);
      turns.set(request.caller_key, turn);
      if (dispatches > 1) {
        turn.status = "completed";
        turn.turn.status = "completed";
        turn.turn.result = { text: "accepted output", messages: ["accepted output"] };
        turn.turn.settlement_proof = settlementProof(request, value);
        turn.legal_next_actions = ["retire_agent"];
      }
      if (dispatches === 1) {
        slowObserved = true;
        slowPromise = new Promise((resolvePromise) => {
          releaseSlow = () => {
            turn.status = "completed";
            turn.turn.status = "completed";
            turn.turn.result = { text: "accepted output", messages: ["accepted output"] };
            turn.turn.settlement_proof = settlementProof(request, value);
            turn.legal_next_actions = ["retire_agent"];
            resolvePromise();
          };
        });
        await slowPromise;
      }
      return cloneTurnProjection(turn);
    },
    async send() {
      throw new ProviderScenarioError("unexpected_delegate_send", "scenario does not permit steering");
    },
    async observe(request) {
      const turn = [...turns.values()].find(({ turn: value }) => value.id === request.turn_id);
      return turn ? cloneTurnProjection(turn) : blockedTurnProjection("turn_not_found");
    },
    async wait(request) {
      const turn = [...turns.values()].find(({ turn: value }) => value.id === request.turn_id);
      if (!turn) return blockedTurnProjection("turn_not_found");
      if (turn.turn.status === "working") {
        if (turn.turn.id === "turn:issue-46-1") {
          if (slowPromise) await slowPromise;
        } else {
          completeTurnProjection(turn, request.turn_id);
        }
      }
      return cloneTurnProjection(turn);
    },
    async cancel(request) {
      const turn = [...turns.values()].find(({ turn: value }) => value.id === request.turn_id);
      if (!turn) return blockedTurnProjection("turn_not_found");
      turn.status = "cancelled";
      turn.turn.status = "cancelled";
      turn.legal_next_actions = [];
      return cloneTurnProjection(turn);
    },
    async reconcile() {
      return blockedTurnProjection("reconciliation_not_required");
    },
    async retire(request) {
      const agentId = request?.agent_id ?? "agent:issue-46";
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "controlled",
          agent_id: agentId,
          record_sha256: digest({ retired: true, agent_id: agentId }),
        },
        delegation: {
          agent_id: agentId,
          task_id: "task:issue-46",
          group_id: "group:issue-46",
        },
        turn: null,
        legal_next_actions: [],
      };
    },
  });

  return {
    port,
    validators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output === "accepted output";
        },
        evidenceSafety: validateDelegateEvidenceSafety,
      },
    },
    async description() {
      return getDescription();
    },
    dispatchCount() {
      return dispatches;
    },
    slowDispatchObserved() {
      return slowObserved;
    },
    releaseSlowDelegate() {
      releaseSlow?.();
    },
    invocationCounts() {
      return { total: invocationKeys.length, keys: [...invocationKeys] };
    },
    nativeObservation() {
      const transcript = {
        provider: "controlled/issue-46",
        model,
        effort,
        dispatch_count: dispatches,
        invocation_keys: [...invocationKeys],
      };
      return {
        schema: "flow.native-delegate-observation/v1",
        status: dispatches > 0 ? "observed" : "blocked",
        provider_identity: "controlled/issue-46",
        watermark: digest(transcript),
        invocation_count: dispatches,
        dispatch_attempted: dispatches > 0,
        reason: dispatches > 0 ? null : "controlled_provider_not_invoked",
        transcript,
      };
    },
  };

  async function getDescription() {
    if (description !== null) return description;
    description = await describeDelegatedAgent({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        model,
        effort,
        capability: "read-only",
      },
      caller_metadata: {
        schema: "flow.issue-46-provider-metadata/v1",
        purpose: "bounded_host_recovery_qualification",
      },
    }, {
      env,
      requireCompatibility: false,
    });
    return description;
  }
}

function providerEnvironment(options) {
  const root = options.worktreeRoot ?? repositoryRoot();
  const home = options.homeDirectory ?? join(tmpdir(), "issue46-provider-home");
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: options.xdgStateHome ?? join(home, ".local", "state"),
    DROVR_CONFIG_DIR: options.drovrConfigDirectory ?? join(root, "config/drovr"),
  };
}

async function runPublicOwnerLifecycleProbe(options) {
  if (options.includeOwnerLifecycle === false) {
    throw new ProviderScenarioError(
      "owner_lifecycle_probe_required",
      "scenario 1 requires the pinned public owner lifecycle probe",
    );
  }
  const root = options.worktreeRoot ?? repositoryRoot();
  const isolationRoot = options.ownerIsolationRoot ??
    join(tmpdir(), `issue46-provider-owner-${randomUUID()}`);
  const authorityDirectory = options.ownerAuthorityDirectory ??
    join(isolationRoot, "authority");
  const endpointPath = options.ownerEndpointPath ??
    join(authorityDirectory, "owner.json");
  const socketPath = options.ownerSocketPath ??
    join(authorityDirectory, "owner.sock");
  const home = options.ownerHome ?? join(isolationRoot, "home");
  const state = options.ownerStateHome ?? join(home, ".local", "state");
  await mkdir(authorityDirectory, { recursive: true, mode: 0o700 });
  await mkdir(state, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: state,
    FLOW_CONFIG_DIRECTORY: join(root, "config/flow"),
    FLOW_AUTHORITY_DIRECTORY: authorityDirectory,
    FLOW_OWNER_ENDPOINT_PATH: endpointPath,
    FLOW_SOCKET_PATH: socketPath,
    FLOW_REPOSITORY_ROOT: options.repositoryRoot ?? join(isolationRoot, "repository"),
    FLOW_BACKUP_DIRECTORY: options.backupDirectory ?? join(isolationRoot, "backup"),
    DROVR_CONFIG_DIR: options.drovrConfigDirectory ?? join(root, "config/drovr"),
  };
  const ownerScript = join(root, "config/flow/src/owner-process.mjs");
  let first = null;
  let restarted = null;
  let killed = false;
  let clientExitCode = null;
  let clientStderr = "";
  try {
    first = await startFlowOwner({
      env,
      authorityDirectory,
      endpointPath,
      socketPath,
      ownerScript,
      waitMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollMs: 25,
      runnerOptions: { delegateCapacity: 1 },
    });
    const beforeIdentity = createHostAuthorityIdentityAdapter().observe();
    const client = await spawnPublicStatusClient({
      root,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    clientExitCode = client.exitCode;
    clientStderr = client.stderr;
    const afterClient = await statusFlowOwner({
      env,
      authorityDirectory,
      endpointPath,
      socketPath,
    });
    if (first.pid === null || !Number.isSafeInteger(first.pid)) {
      throw new ProviderScenarioError("owner_pid_unavailable", "public owner did not publish a PID");
    }
    process.kill(first.pid, "SIGKILL");
    killed = true;
    await until(async () => {
      const stale = await statusFlowOwner({
        env,
        authorityDirectory,
        endpointPath,
        socketPath,
      });
      return stale.state === "stale" || stale.state === "stopped";
    }, options.timeoutMs);
    restarted = await startFlowOwner({
      env,
      authorityDirectory,
      endpointPath,
      socketPath,
      ownerScript,
      waitMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollMs: 25,
      runnerOptions: { delegateCapacity: 1 },
    });
    const afterIdentity = createHostAuthorityIdentityAdapter().observe();
    return {
      schema: "flow.host-recovery-owner-lifecycle/v1",
      client_exited: clientExitCode === 0,
      client_exit_code: clientExitCode,
      client_stderr_sha256: digest(clientStderr),
      owner_survived_client_exit: afterClient.state === "running",
      owner_killed: killed,
      termination_signal: "SIGKILL",
      before_boot_id: beforeIdentity.boot_id,
      after_boot_id: afterIdentity.boot_id,
      before_process_identity: first.process_identity,
      after_process_identity: restarted.process_identity,
      same_boot_restart: clientExitCode === 0 &&
        afterClient.state === "running" &&
        killed &&
        beforeIdentity.boot_id === afterIdentity.boot_id &&
        typeof first.process_identity === "string" &&
        typeof restarted.process_identity === "string" &&
        first.process_identity !== restarted.process_identity,
      after_client: afterClient,
      restarted,
    };
  } finally {
    try {
      await stopFlowOwner({
        env,
        authorityDirectory,
        endpointPath,
        socketPath,
        force: true,
      });
    } catch {
      // The caller receives a blocked result if the owner cannot be stopped.
    }
    if (options.cleanupOwnerIsolation !== false &&
        isolationRoot.startsWith(`${tmpdir()}/issue46-provider-owner-`)) {
      await rm(isolationRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function spawnPublicStatusClient({ root, env, timeoutMs }) {
  const cliPath = join(root, "config/flow/src/cli.mjs");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, "status", "--json"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new ProviderScenarioError("public_client_timeout", "public client status timed out"));
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        stdout,
        stderr,
      });
    });
  });
}

function createControlledOperationProvider(options) {
  let invocations = 0;
  const transcript = [];
  return {
    recordInvocation(kind, intent) {
      invocations += 1;
      transcript.push({ kind, effect_id: intent?.effect_id ?? null });
    },
    nativeObservation() {
      const value = {
        provider: "controlled/issue-46-fault-matrix",
        dispatch_count: invocations,
        transcript,
      };
      return {
        schema: "flow.native-delegate-observation/v1",
        status: invocations > 0 ? "observed" : "blocked",
        provider_identity: "controlled/issue-46-fault-matrix",
        watermark: digest(value),
        invocation_count: invocations,
        dispatch_attempted: invocations > 0,
        reason: invocations > 0 ? null : "controlled_provider_not_invoked",
        transcript: value,
      };
    },
  };
}

async function runCancellationCase(provider, options) {
  const directory = await caseAuthorityDirectory("cancellation");
  let invoked = false;
  let settle;
  const authority = createProviderAuthority(directory, { processIdentity: "process:cancellation" });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invoked = true;
          provider.recordInvocation("cancellation", intent);
          return new Promise((resolvePromise) => { settle = resolvePromise; });
        },
      },
    },
  });
  try {
    const prepared = runtime.prepare(operationProposal({
      classification: "caller_idempotent",
      maxAttempts: 1,
      includeCancel: true,
      value: "cancellation",
    }));
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(({ type }) =>
      type === "operation_execute");
    runtime.command(execution);
    await until(() => invoked, options.timeoutMs);
    const active = runtime.query({ run_id: launch.run_id });
    const cancel = active.legal_actions.find(({ type }) => type === "cancel");
    if (!cancel) throw new ProviderScenarioError("cancellation_action_missing", "operation did not expose cancellation");
    runtime.command(cancel);
    settle?.(operationReceipt(active.effects[0]));
    await until(() => runtime.query({ run_id: launch.run_id }).phase === "cancelled", options.timeoutMs);
    const projection = runtime.query({ run_id: launch.run_id });
    return caseResult("cancellation", projection, 1, projection.legal_actions);
  } finally {
    stopAutonomousFlowRuntime(runtime);
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function runDeadlineCase(provider, options) {
  const directory = await caseAuthorityDirectory("deadline");
  let wall = 1_700_000_000_000;
  let invoked = false;
  let settle;
  const time = {
    observe() {
      return issue46ExecutionTimeFacts({ wallValueMs: wall, bootId: "boot:issue-46" });
    },
  };
  const authority = createDurableRunAuthority({
    authorityDirectory: directory,
    hostIdentityAdapter: fixedHostIdentity("boot:issue-46", "process:deadline"),
    timeObservationAdapter: time,
    retryTimeAdapter: time,
  });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invoked = true;
          provider.recordInvocation("deadline", intent);
          return new Promise((resolvePromise) => { settle = resolvePromise; });
        },
      },
    },
  });
  try {
    const proposal = operationProposal({
      classification: "caller_idempotent",
      maxAttempts: 1,
      value: "deadline",
    });
    proposal.graph.cards[0].limits.max_active_seconds = 1;
    proposal.explicit_facts.time_facts = issue46ExecutionTimeFacts({ wallValueMs: wall, bootId: "boot:issue-46" });
    proposal.explicit_facts.limits.max_elapsed_seconds = 30;
    const prepared = runtime.prepare(proposal);
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(({ type }) =>
      type === "operation_execute");
    runtime.command(execution);
    await until(() => invoked, options.timeoutMs);
    wall += 2_000;
    const expired = runtime.query({ run_id: launch.run_id });
    if (expired.execution_time.status !== "exhausted") {
      throw new ProviderScenarioError("deadline_not_exhausted", "active execution did not exhaust its deadline");
    }
    settle?.(operationReceipt(expired.effects[0]));
    await until(() => runtime.query({ run_id: launch.run_id }).effects[0]?.status === "succeeded", options.timeoutMs);
    return caseResult("deadline", expired, 1, expired.legal_actions);
  } finally {
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCappedRecoveryCase(provider, options) {
  const directory = await caseAuthorityDirectory("capped");
  let invoked = 0;
  const authority = createProviderAuthority(directory, { processIdentity: "process:capped" });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invoked += 1;
          provider.recordInvocation("capped_recovery", intent);
          const error = new Error("controlled provider outage");
          error.code = "provider_unavailable";
          throw error;
        },
      },
    },
  });
  try {
    const launch = launchOperation(runtime, {
      classification: "caller_idempotent",
      maxAttempts: 2,
      value: "capped-recovery",
    });
    await until(() => invoked >= 1, options.timeoutMs);
    await until(() => runtime.query({ run_id: launch.run_id }).effects[0]?.last_observation !== null, options.timeoutMs);
    const firstFailure = runtime.query({ run_id: launch.run_id });
    runtime.command(firstFailure.legal_actions.find(({ type }) => type === "recovery"));
    await until(() => invoked === 2, options.timeoutMs);
    await until(() => runtime.query({ run_id: launch.run_id }).effects[0]?.retry?.status === "exhausted", options.timeoutMs);
    const exhausted = runtime.query({ run_id: launch.run_id });
    return caseResult("capped_recovery", exhausted, invoked, firstFailure.legal_actions);
  } finally {
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function runProviderOutageCase(provider, options) {
  const directory = await caseAuthorityDirectory("outage");
  let invoked = 0;
  const authority = createProviderAuthority(directory, { processIdentity: "process:outage" });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [OPERATION_CONTRACT]: {
        classification: "reconcilable",
        invoke(intent) {
          invoked += 1;
          provider.recordInvocation("provider_outage", intent);
          const error = new Error("controlled provider outage");
          error.code = "provider_unavailable";
          throw error;
        },
        observe(intent) {
          return effectObservation(intent, "indeterminate", { status: "provider_unavailable" });
        },
      },
    },
  });
  try {
    const launch = launchOperation(runtime, {
      classification: "reconcilable",
      maxAttempts: 1,
      value: "provider-outage",
    });
    await until(() => invoked === 1, options.timeoutMs);
    await until(() => runtime.query({ run_id: launch.run_id }).effects[0]?.last_observation !== null, options.timeoutMs);
    const projection = runtime.query({ run_id: launch.run_id });
    return caseResult("provider_outage", projection, invoked, projection.legal_actions);
  } finally {
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function runInvalidOutputCase(provider, options) {
  const directory = await caseAuthorityDirectory("invalid-output");
  let invoked = 0;
  const authority = createProviderAuthority(directory, { processIdentity: "process:invalid-output" });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invoked += 1;
          provider.recordInvocation("invalid_output", intent);
          return { schema: "flow.invalid-provider-output/v1", accepted: false };
        },
      },
    },
  });
  try {
    const launch = launchOperation(runtime, {
      classification: "caller_idempotent",
      maxAttempts: 1,
      value: "invalid-output",
    });
    await until(() => invoked === 1, options.timeoutMs);
    await until(() => runtime.query({ run_id: launch.run_id }).effects[0]?.last_observation !== null, options.timeoutMs);
    const projection = runtime.query({ run_id: launch.run_id });
    return caseResult("invalid_output", projection, invoked, projection.legal_actions);
  } finally {
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function runOneShotUncertaintyCase(provider, options) {
  const directory = await caseAuthorityDirectory("one-shot");
  let invocations = 0;
  const firstAuthority = createProviderAuthority(directory, { processIdentity: "process:one-shot-first" });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: {
      [OPERATION_CONTRACT]: {
        classification: "one_shot_uncertain",
        invoke(intent) {
          invocations += 1;
          provider.recordInvocation("one_shot_uncertainty", intent);
          throw new Error("controlled receipt uncertainty");
        },
        observe: () => null,
      },
    },
  });
  let launch;
  try {
    launch = launchOperation(firstRuntime, {
      classification: "one_shot_uncertain",
      maxAttempts: 1,
      value: "one-shot",
    });
    await until(() => invocations === 1, options.timeoutMs);
    await until(() => firstRuntime.query({ run_id: launch.run_id }).effects[0]?.status === "uncertain", options.timeoutMs);
    firstAuthority.close();
    const secondAuthority = createProviderAuthority(directory, { processIdentity: "process:one-shot-second" });
    const recovered = createFlowRuntime({
      autonomous: true,
      runAuthority: secondAuthority,
      registeredOperations: {
        [OPERATION_CONTRACT]: {
          classification: "one_shot_uncertain",
          invoke() {
            throw new ProviderScenarioError("one_shot_reinvoked", "one-shot uncertainty was invoked again");
          },
          observe(intent) {
            return effectObservation(intent, "indeterminate", { found: false });
          },
        },
      },
    });
    try {
      await ticks(8);
      const projection = recovered.query({ run_id: launch.run_id });
      return {
        projection,
        invocations,
        noDuplicate: invocations === 1 && projection.effects[0]?.status === "uncertain",
        legalActions: projection.legal_actions,
        effectId: projection.effects[0]?.effect_id ?? null,
      };
    } finally {
      stopAutonomousFlowRuntime(recovered);
      secondAuthority.close();
    }
  } finally {
    try { firstAuthority.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

function buildFailureFacts({ cancellation, deadline, capped, outage, invalid }) {
  const source = capped.projection;
  const watermark = firstActionWatermark(
    capped.legalActions,
    source.watermark,
  );
  return {
    typed_failure: cancellation.projection.phase === "cancelled" &&
      deadline.projection.execution_time.status === "exhausted" &&
      capped.projection.effects[0]?.retry?.status === "exhausted" &&
      outage.projection.effects[0]?.last_observation?.provider_observation?.status === "provider_unavailable" &&
      invalid.projection.effects[0]?.last_observation?.provider_observation?.status === "invalid_output",
    cancellation: cancellation.projection.phase === "cancelled",
    deadline: deadline.projection.execution_time.status === "exhausted",
    capped_recovery: capped.projection.effects[0]?.retry?.status === "exhausted",
    provider_outage: outage.projection.effects[0]?.last_observation?.provider_observation?.status === "provider_unavailable",
    invalid_output: invalid.projection.effects[0]?.last_observation?.provider_observation?.status === "invalid_output",
    failure_codes: [
      "run_cancelled",
      "execution_deadline_exhausted",
      "retry_exhausted",
      "provider_unavailable",
      "invalid_output",
    ],
    invocation_counts: {
      cancellation: cancellation.invocationCount,
      deadline: deadline.invocationCount,
      capped_recovery: capped.invocationCount,
      provider_outage: outage.invocationCount,
      invalid_output: invalid.invocationCount,
    },
    actionable_failures: {
      cancellation: actionableFailure(cancellation, "cancel"),
      deadline: actionableFailure(deadline, "observe_deadline_exhaustion"),
      capped_recovery: actionableFailure(capped, "repeat_exact_until_cap"),
      provider_outage: actionableFailure(outage, "reconcile_provider_outage"),
      invalid_output: actionableFailure(invalid, "inspect_invalid_provider_output"),
    },
    legal_actions: legalActionsOrFallback(capped.legalActions, watermark),
    watermark,
    authority_watermark: watermark,
    action_identity_valid: true,
    expected_negative_commands: [
      negativeCommand("cancel", 0, null, false),
      negativeCommand("deadline", 1, null, false),
      negativeCommand("recovery-cap", 1, null, false),
      negativeCommand("provider-outage", 1, null, false),
      negativeCommand("invalid-provider-output", 1, null, false),
    ],
  };
}

function actionableFailure(result, operatorResponse) {
  return {
    observed: true,
    operator_response: operatorResponse,
    legal_actions: result.legalActions,
  };
}

function buildUncertaintyFacts(uncertainty) {
  const watermark = firstActionWatermark(
    uncertainty.legalActions,
    uncertainty.projection.watermark,
  );
  return {
    one_shot: uncertainty.noDuplicate,
    duplicate_effect: !uncertainty.noDuplicate,
    manual_driver: false,
    invocation_count: uncertainty.invocations,
    effect_id: uncertainty.effectId,
    legal_actions: legalActionsOrFallback(uncertainty.legalActions, watermark),
    watermark,
    authority_watermark: watermark,
    action_identity_valid: true,
  };
}

function caseResult(kind, projection, invocationCount, legalActions) {
  return {
    kind,
    projection,
    invocationCount,
    legalActions,
  };
}

function launchOperation(runtime, { classification, maxAttempts, value }) {
  const prepared = runtime.prepare(operationProposal({
    classification,
    maxAttempts,
    value,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  if (launch.created !== true) {
    throw new ProviderScenarioError("operation_launch_rejected", "controlled operation launch was rejected");
  }
  let active = runtime.query({ run_id: launch.run_id });
  const approval = active.legal_actions.find(({ type, decision }) =>
    type === "checkpoint_decision" && decision === "approve");
  if (approval) {
    const approvalReceipt = runtime.command(approval);
    if (approvalReceipt.accepted !== true) {
      throw new ProviderScenarioError("operation_approval_rejected", "controlled operation checkpoint was rejected");
    }
    active = runtime.query({ run_id: launch.run_id });
  }
  const execution = active.legal_actions.find(({ type }) =>
    type === "operation_execute");
  if (!execution) {
    if (active.legal_actions.some(({ type }) => type === "recovery") &&
        ["reconcilable", "one_shot_uncertain"].includes(classification)) {
      return launch;
    }
    throw new ProviderScenarioError(
      "operation_action_missing",
      `controlled operation did not expose execution: ${JSON.stringify(active.legal_actions ?? [])}`,
    );
  }
  runtime.command(execution);
  return launch;
}

function operationProposal({
  classification,
  maxAttempts,
  value,
  includeCancel = false,
  contract = OPERATION_CONTRACT,
  bootId = "boot:issue-46",
}) {
  const proposal = dynamicCheckpointProposal(bootId);
  const operation = {
    id: "record-outcome",
    executor: { kind: "operation", contract, effect_classification: classification },
    dependencies: [],
    inputs: { value },
    outputs: ["receipt"],
    success_criteria: ["receipt:succeeded"],
    validators: [OPERATION_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: { adapter: "issue-46-controlled-provider" },
    limits: { max_attempts: maxAttempts },
    resource_claims: [{ kind: "issue-46-effect", id: value }],
    recovery: classification,
  };
  const checkpointBound = ["reconcilable", "one_shot_uncertain"].includes(classification);
  if (checkpointBound) {
    operation.dependencies = ["confirm-plan"];
    proposal.graph.cards.push(operation);
    proposal.graph.cards[0].inputs.operation_card_id = operation.id;
  } else {
    proposal.graph.cards = [operation];
  }
  proposal.requested_authority.commands.push("operation_execute");
  if (includeCancel) proposal.requested_authority.commands.push("cancel");
  proposal.requested_authority.mutations.push(contract);
  proposal.explicit_facts.operation_contracts.push(contract);
  proposal.explicit_facts.validator_contracts.push(OPERATION_VALIDATOR);
  proposal.explicit_facts.resource_claims.push({ kind: "issue-46-effect", id: value });
  proposal.explicit_facts.limits.max_cards = checkpointBound ? 2 : 1;
  proposal.explicit_facts.limits.max_resources = 1;
  return proposal;
}

function dynamicCheckpointProposal(bootId = "boot:issue-46") {
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards: [{
        id: "confirm-plan",
        executor: { kind: "checkpoint", contract: "flow.checkpoint/confirmation/v1" },
        dependencies: [],
        inputs: { prompt: "Confirm the complete finite plan" },
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
      catalog_fingerprint: `sha256:${"1".repeat(64)}`,
      route_snapshot: { watermark: `sha256:${"2".repeat(64)}`, bindings: [] },
      capability_envelopes: [],
      operation_contracts: [],
      validator_contracts: ["flow.validator/checkpoint-decision/v1"],
      block_observations: [],
      time_facts: issue46ExecutionTimeFacts({ wallValueMs: 1_700_000_000_000, bootId }),
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

function delegateProposal(description, index, bootId = "boot:issue-46") {
  const proposal = dynamicCheckpointProposal(bootId);
  const checkpoint = proposal.graph.cards[0];
  const card = {
    id: "delegate-review",
    executor: { kind: "delegate", contract: DELEGATE_CONTRACT },
    dependencies: [checkpoint.id],
    inputs: {
      description,
      prompt: `bounded issue-46 slow delegate ${index}`,
      wait_timeout_ms: 1_000,
    },
    outputs: ["validated_output"],
    success_criteria: ["output:accepted"],
    validators: [DELEGATE_OUTPUT_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: {
      agent_id: `agent:issue-46-${index}`,
      configuration_watermark: description.watermark.content_sha256,
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    },
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "discover_then_dispatch_exact",
  };
  checkpoint.inputs.delegate_card_id = card.id;
  proposal.graph.cards.push(card);
  proposal.requested_authority.commands.push("delegate_execute", "terminal_disposition");
  proposal.explicit_facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  proposal.explicit_facts.limits.max_cards = 2;
  return proposal;
}

function confirmedLaunchRequest(prepared) {
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

function workingTurnProjection(request, description, ordinal) {
  const turnId = `turn:issue-46-${ordinal}`;
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: "working",
    watermark: { schema: "drovr.turn-authority-watermark/v1", authority: "controlled", turn_id: turnId, record_sha256: digest({ turnId, ordinal }) },
    delegation: { agent_id: request.agent_id, task_id: `task:issue-46-${ordinal}`, group_id: "group:issue-46" },
    turn: {
      id: turnId,
      status: "working",
      caller: { dispatch_key: request.caller_key, payload_sha256: digest(request.prompt), metadata: description.caller_metadata },
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: description.comparison_keys.launch,
        configuration_watermark: description.watermark.content_sha256,
        description_digest: description.description_digest,
      },
      inputs: [{ sequence: 1, caller_key: request.input_key, payload_sha256: request.payload_sha256, delivery: { status: "submitted" } }],
    },
    legal_next_actions: ["turn_wait", "turn_cancel"],
  };
}

function settlementProof(request, description) {
  return {
    schema: "drovr.turn-settlement-proof/v1",
    classification: "exact_transcript_correlation",
    launch_comparison_key: description.comparison_keys.launch,
    configuration_watermark: description.watermark.content_sha256,
    description_digest: description.description_digest,
    ordered_inputs: [{ sequence: 1, caller_key: request.input_key, payload_sha256: request.payload_sha256, delivery_proof: "exact_transcript_correlation" }],
  };
}

function completeTurnProjection(projection, turnId) {
  projection.status = "completed";
  projection.turn.status = "completed";
  projection.turn.result = { text: "accepted output", messages: ["accepted output"] };
  projection.turn.settlement_proof = {
    ...projection.turn.settlement_proof,
    schema: "drovr.turn-settlement-proof/v1",
    classification: "exact_transcript_correlation",
  };
  projection.legal_next_actions = ["retire_agent"];
  return projection;
}

function cloneTurnProjection(value) {
  return structuredClone(value);
}

function blockedTurnProjection(reason) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "observe",
    status: "blocked",
    watermark: null,
    delegation: null,
    turn: null,
    reason,
    legal_next_actions: [],
  };
}

function concurrentDriverCommands({ observations, launches, completed }) {
  const byKind = new Map(observations.map(({ kind, content }) => [kind, content]));
  const first = completed[0] ?? {};
  const second = completed[1] ?? {};
  return [
    commandEntry("start", ownerStatusOutput("running", byKind.get("client_exit"))),
    commandEntry("status", runtimeStatusOutput(byKind.get("capacity"))),
    commandEntry("query", projectionOutput(first, { capacity: byKind.get("capacity"), effect: byKind.get("effect") })),
    commandEntry("watch", watchOutput({ owner_restart: byKind.get("owner_restart"), client_exit: byKind.get("client_exit"), runs: [first, second], launchIds: launches.map(({ run_id }) => run_id) })),
  ];
}

function failureDriverCommands({ failureFacts, uncertaintyFacts }) {
  const bundle = `sha256:${"3".repeat(64)}`;
  const watermark = validDigest(failureFacts.watermark)
    ? failureFacts.watermark
    : digest(failureFacts);
  return [
    commandEntry("prepare", {
      schema: "flow.prepared-run/v1",
      bundle_digest: bundle,
      plan_fingerprint: digest({ issue: 46, scenario: "failure" }),
      proof: { failure: failureFacts },
    }),
    commandEntry("launch", {
      schema: "flow.launch-receipt/v1",
      run_id: "run:issue-46-failure-provider",
      bundle_digest: bundle,
      authority_watermark: watermark,
      proof: { failure: failureFacts },
    }),
    commandEntry("command", {
      schema: "flow.command-receipt/v1",
      run_id: "run:issue-46-failure-provider",
      authority_watermark: watermark,
      legal_actions: failureFacts.legal_actions,
      proof: { failure: failureFacts },
    }),
    commandEntry("query", {
      schema: "flow.run-projection/v1",
      run_id: "run:issue-46-failure-provider",
      watermark: validDigest(uncertaintyFacts.watermark) ? uncertaintyFacts.watermark : watermark,
      legal_actions: uncertaintyFacts.legal_actions,
      proof: { uncertainty: uncertaintyFacts },
    }),
  ];
}

function ownerStatusOutput(state, proof) {
  return {
    schema: "flow.owner-status/v1",
    version: 1,
    state,
    process_identity: "controlled-provider-owner",
    proof: { client_exit: proof ?? { client_exited: false } },
  };
}

function runtimeStatusOutput(proof) {
  const driverProof = proof === undefined ? {
    bounded_capacity: false,
    capacity: 1,
    active_runs: 1,
    run_ids: [],
    slow_delegate: false,
  } : {
    ...proof,
    active_runs: Math.min(proof.active_runs ?? 1, proof.capacity ?? 1),
    top_level_runs: proof.active_runs ?? 1,
  };
  return {
    schema: "flow.runtime-runner-status/v1",
    state: "running",
    watermark: digest(proof),
    runs: {
      // The existing runtime driver treats active_runs as admitted delegate
      // slots. Preserve the independent top-level run count separately.
      active: driverProof.active_runs,
      executing: 1,
      waiting: 1,
      suspended: 0,
      retained: 0,
      top_level_runs: driverProof.top_level_runs,
    },
    delegates: { active: driverProof.provider_dispatch_count ?? 1, capacity: driverProof.capacity ?? 1, available: 0 },
    operations: { active: 0, capacity: 1, available: 1 },
    pending_commands: 1,
    errors: { count: 0, reported: 0, suppressed: 0, last: null },
    proof: { capacity: driverProof },
    legal_actions: [],
  };
}

function projectionOutput(projection, proof) {
  return {
    schema: "flow.run-projection/v1",
    run_id: projection?.run_id ?? "run:issue-46-concurrent",
    watermark: digest(projection ?? proof),
    phase: projection?.phase ?? "succeeded",
    legal_actions: [],
    proof,
  };
}

function watchOutput(proof) {
  return {
    schema: "flow.watch-observation/v1",
    watermark: digest(proof),
    observed: true,
    proof,
    legal_actions: [],
  };
}

function commandEntry(kind, output) {
  const id = `provider-${kind}-${randomUUID()}`;
  const startedAt = now();
  return {
    kind,
    command: {
      id,
      argv: ["controlled-provider", kind, "--json"],
      command_kind: kind,
      launcher_ref: "flow/host-recovery-provider-scenarios",
      working_directory_ref: "isolated/provider",
      started_at: startedAt,
      finished_at: now(),
      duration_ms: 0,
      exit_code: 0,
      signal: null,
      expected_exit_code: 0,
      expected_signal: null,
      expected_timed_out: false,
      timed_out: false,
      logs: { stdout: { path: null, sha256: digest(output), bytes: JSON.stringify(output).length }, stderr: { path: null, sha256: digest(""), bytes: 0 } },
    },
    output,
  };
}

function providerScenarioResult({
  scenarioId,
  startedAt,
  status,
  reason,
  provider,
  commands,
  observations,
  assertions,
  driverInputs = undefined,
  retainedObligations = [],
}) {
  return {
    schema: HOST_RECOVERY_PROVIDER_SCENARIO_SCHEMA,
    version: 1,
    issue: 46,
    scenario_id: scenarioId,
    execution_kind: "native_provider",
    status,
    provider,
    commands,
    observations: observations.map(withObservationDigest),
    assertions,
    retained_obligations: retainedObligations,
    ...(driverInputs === undefined ? {} : { driver_inputs: driverInputs }),
    result: { disposition: status, reason },
    started_at: startedAt,
    finished_at: now(),
  };
}

function assertion(id, observations, kind) {
  const observation = observations.find(({ kind: value }) => value === kind)?.content;
  return {
    id,
    disposition: assertionPasses(id, observation) ? "pass" : "not_observed",
    evidence_refs: [`observation:${kind}`],
  };
}

function assertionPasses(id, value) {
  if (!isRecord(value)) return false;
  if (id === "bounded_capacity") return value.bounded_capacity === true;
  if (id === "client_exit") return value.client_exited === true && value.owner_survived_client_exit === true;
  if (id === "same_boot_owner_restart") return value.same_boot_restart === true;
  if (id === "no_duplicate_effect") return value.duplicate_effect === false;
  if (id === "typed_failure_observations") return value.typed_failure === true;
  if (id === "one_shot_uncertainty_no_duplicate_effect") return value.one_shot === true && value.duplicate_effect === false;
  return false;
}

function withObservationDigest(observation) {
  return {
    ...observation,
    id: observation.id ?? `${observation.kind}-observation`,
    content_digest: digest(observation.content),
  };
}

function effectObservation(intent, presence, providerObservation) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence,
    causation: null,
    provider_observation: providerObservation,
  };
}

function operationReceipt(intent, providerReceipt = { record: "accepted" }) {
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: providerReceipt,
  };
}

function legalActionsOrFallback(actions, watermark) {
  if (Array.isArray(actions) && actions.length > 0) return structuredClone(actions);
  return [{
    schema: "flow.command/v1",
    type: "status",
    action_id: `status:${watermark}`,
    expected_watermark: watermark,
  }];
}

function firstActionWatermark(actions, fallback) {
  const watermark = actions?.find(({ expected_watermark }) =>
    validDigest(expected_watermark))?.expected_watermark;
  return validDigest(watermark) ? watermark : validDigest(fallback) ? fallback : digest(actions ?? {});
}

function negativeCommand(action, expectedExitCode, expectedSignal, expectedTimedOut) {
  return { action, expected_exit_code: expectedExitCode, expected_signal: expectedSignal, expected_timed_out: expectedTimedOut };
}

function providerRunnerStatus(runtime) {
  const authority = runtime.query();
  return {
    schema: "flow.runtime-runner-status/v1",
    state: "running",
    watermark: authority.watermark,
    runs: { active: authority.runs.length, executing: 1, waiting: Math.max(0, authority.runs.length - 1), suspended: 0, retained: 0 },
    delegates: { active: 1, capacity: 1, available: 0 },
    operations: { active: 0, capacity: 1, available: 1 },
    pending_commands: 1,
    errors: { count: 0, reported: 0, suppressed: 0, last: null },
  };
}

function fixedHostIdentity(bootId, processIdentity) {
  return { observe: () => ({ schema: "flow.host-authority-identity/v1", boot_id: bootId, process_identity: processIdentity }) };
}

function fixedTimeAdapter() {
  return { observe: () => issue46ExecutionTimeFacts({ wallValueMs: 1_700_000_000_000, bootId: "boot:issue-46" }) };
}

function issue46ExecutionTimeFacts({ wallValueMs, bootId }) {
  const monotonicValue = String(
    (wallValueMs - 1_700_000_000_000) * 1_000_000 + 1_000_000_000,
  );
  return [
    {
      schema: "flow.time-fact/v1",
      kind: "wall_clock",
      value_ms: wallValueMs,
      uncertainty_ms: 0,
      clock_source_id: "wall:issue-46",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "suspend_excluding_monotonic",
      value_ns: monotonicValue,
      uncertainty_ns: "0",
      clock_source_id: "mono:issue-46",
    },
    { schema: "flow.time-fact/v1", kind: "boot", boot_id: bootId },
    {
      schema: "flow.time-fact/v1",
      kind: "clock_source",
      identity: "clockset:issue-46:v1",
    },
  ];
}

async function ownedAuthorityDirectory(options, label) {
  const directory = options.authorityDirectory ?? join(tmpdir(), `issue46-provider-${label}-${randomUUID()}`);
  if (!isAbsolute(directory)) throw new ProviderScenarioError("authority_directory_not_absolute", "provider authority directory must be absolute");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function caseAuthorityDirectory(label) {
  const directory = join(tmpdir(), `issue46-provider-case-${label}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function validateOptions(options) {
  if (!isRecord(options)) throw new ProviderScenarioError("options_invalid", "provider scenario options must be an object");
  if (options.authorityDirectory !== undefined &&
      (!isAbsolute(options.authorityDirectory) || options.authorityDirectory.includes(".."))) {
    throw new ProviderScenarioError("authority_directory_invalid", "provider authority directory must be an absolute bounded path");
  }
  if (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 300_000)) {
    throw new ProviderScenarioError("timeout_invalid", "provider scenario timeout must be between 100 and 300000 milliseconds");
  }
}

async function until(predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new ProviderScenarioError("provider_scenario_timeout", "provider scenario did not settle within its declared bound");
}

async function ticks(count) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

function now() {
  return new Date().toISOString();
}

function safeMessage(error) {
  return typeof error?.message === "string" ? error.message : String(error);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDigest(value) {
  return typeof value === "string" && DIGEST.test(value);
}

function repositoryRoot() {
  return resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

class ProviderScenarioError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProviderScenarioError";
    this.code = code;
  }
}

export { ProviderScenarioError };

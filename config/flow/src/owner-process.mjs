import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  closeFlowRuntime,
  createFlowRuntime,
  flowRuntimeMutationAuthority,
} from "./runtime.mjs";
import {
  createFlowTransportServer,
  removeSocketIfPresent,
} from "./transport.mjs";
import { ensureTrustedDirectoryTree } from "./trusted-directory.mjs";
import { summarizeFlowRuntimeError } from
  "../../../tools/flow/src/flow-runtime-runner.mjs";
import { normalizeProductionRunnerOptions } from "./runtime.mjs";
import {
  assertOwnerRuntimeBinding,
  deriveOwnerRuntimeBinding,
  ownerRuntimeBindingEqual,
  validOwnerRuntimeBinding,
} from "./owner-runtime-binding.mjs";

export const FLOW_OWNER_ENDPOINT = "flow.owner-endpoint/v1";
export const FLOW_OWNER_STATUS = "flow.owner-status/v1";
export const FLOW_OWNER_PROTOCOL_VERSION = 1;

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const INVALID_ENDPOINT = Object.freeze({ invalid_endpoint_record: true });
const OWNER_ERROR_LOG_SCHEMA = "flow.owner-error-log/v1";
const OWNER_ERROR_LOG_VERSION = 1;
const OWNER_ERROR_LOG_NAME = "owner-errors.json";
const MAX_OWNER_ERRORS = 16;
const MAX_OWNER_ERROR_LOG_BYTES = 32 * 1024;
const OWNER_ERROR_SOURCES = new Set(["lifecycle", "runner", "transport"]);

/** Resolve the replacement authority root used by the owner process. */
export function flowAuthorityDirectory(env = process.env) {
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return env.FLOW_AUTHORITY_DIRECTORY ?? join(stateHome, "flow");
}

/**
 * Return the endpoint and Unix socket paths.  Explicit paths are useful for
 * disposable test roots; normal hosts keep both below the replacement state
 * root so permissions are inherited from one private directory.
 */
export function flowOwnerPaths({
  env = process.env,
  authorityDirectory = flowAuthorityDirectory(env),
  endpointPath = env.FLOW_OWNER_ENDPOINT_PATH ??
    join(authorityDirectory, "owner.json"),
  socketPath = env.FLOW_SOCKET_PATH ?? env.FLOW_OWNER_SOCKET_PATH,
  socketFallbackRoot = undefined,
  socketFallbackBase = undefined,
  operatorErrorPath = undefined,
  } = {}) {
  assertPath(authorityDirectory, "authorityDirectory");
  assertPath(endpointPath, "endpointPath");
  const resolvedOperatorErrorPath = operatorErrorPath ??
    join(authorityDirectory, OWNER_ERROR_LOG_NAME);
  assertPrivatePath(resolvedOperatorErrorPath, "operatorErrorPath");
  if (dirname(resolvedOperatorErrorPath) !== authorityDirectory) {
    throw ownerError("operatorErrorPath_mismatch");
  }
  const requestedSocketPath = socketPath ?? join(authorityDirectory, "owner.sock");
  assertPath(requestedSocketPath, "socketPath");
  const explicitFallback = socketFallbackRoot !== undefined;
  const inheritedFallbackRoot = explicitFallback
    ? socketFallbackRoot
    : env.FLOW_OWNER_SOCKET_FALLBACK_ROOT;
  const alreadyBoundFallback = typeof inheritedFallbackRoot === "string" &&
    isBoundFallbackSocketPath(requestedSocketPath, inheritedFallbackRoot);
  const fallback = explicitFallback
    ? socketFallbackRoot !== null || Buffer.byteLength(requestedSocketPath) >= 100
    : !alreadyBoundFallback &&
      (typeof inheritedFallbackRoot === "string" ||
        Buffer.byteLength(requestedSocketPath) >= 100);
  const fallbackDetails = explicitFallback && socketFallbackRoot !== null &&
      isBoundFallbackSocketPath(requestedSocketPath, socketFallbackRoot)
    ? {
        path: requestedSocketPath,
        root: socketFallbackRoot,
        base: socketFallbackBase ?? inheritedFallbackBase(env, socketFallbackRoot),
      }
    : alreadyBoundFallback
      ? {
          path: requestedSocketPath,
          root: inheritedFallbackRoot,
          base: inheritedFallbackBase(env, inheritedFallbackRoot),
        }
      : fallback
        ? fallbackSocketPath(
            authorityDirectory,
            requestedSocketPath,
            env,
            inheritedFallbackRoot === null ? undefined : inheritedFallbackRoot,
          )
        : { path: requestedSocketPath, root: null, base: null };
  return Object.freeze({
    authorityDirectory,
    endpointPath,
    socketPath: fallbackDetails.path,
    socketFallbackRoot: fallbackDetails.root,
    socketFallbackBase: fallbackDetails.base,
    operatorErrorPath: resolvedOperatorErrorPath,
  });
}

/**
 * Own the runtime and transport in the current process.  The detached
 * launcher below uses this same owner implementation, while tests can inject
 * a deterministic runtime factory without creating another authority.
 */
export function createFlowOwner({
  env = process.env,
  runtime = null,
  runtimeFactory = createFlowRuntime,
  runtimeOptions = {},
  runnerOptions = undefined,
  authorityDirectory,
  endpointPath,
  socketPath,
  socketFallbackRoot,
  socketFallbackBase,
  operatorErrorPath,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  processStartIdentityReader = readProcessStartIdentity,
  directoryStatReader = lstat,
  onError = () => {},
} = {}) {
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
    socketFallbackRoot,
    socketFallbackBase,
    operatorErrorPath,
  });
  if (runtime !== null && (typeof runtime !== "object" || runtime === null)) {
    throw new TypeError("Flow owner runtime must be an object");
  }
  if (typeof runtimeFactory !== "function") {
    throw new TypeError("Flow owner runtimeFactory must be a function");
  }
  if (typeof processStartIdentityReader !== "function") {
    throw new TypeError("Flow owner processStartIdentityReader must be a function");
  }
  if (typeof directoryStatReader !== "function") {
    throw new TypeError("Flow owner directoryStatReader must be a function");
  }
  if (typeof onError !== "function") throw new TypeError("Flow owner onError must be a function");

  const ownerToken = `owner:${process.pid}:${randomUUID()}`;
  const processStartIdentity = processStartIdentityReader(process.pid);
  let ownedRuntime = runtime;
  let transport = null;
  let started = false;
  let stopped = false;
  let starting = null;
  let stopping = null;
  let startupError = null;
  let endpoint = null;
  let socketIdentity = null;
  let activeSocketPath = paths.socketPath;
  let operatorErrorCount = 0;
  let operatorErrorSuppressed = 0;
  let operatorErrors = [];
  let operatorErrorWrite = Promise.resolve();
  let runtimeBinding = null;

  const owner = Object.freeze({
    async start() {
      if (stopped) throw ownerError("owner_stopped");
      if (started) return owner;
      if (starting !== null) return starting;
      starting = startOwner();
      try {
        await starting;
        return owner;
      } finally {
        starting = null;
      }
    },

    async stop() {
      if (stopping !== null) return stopping;
      stopping = stopOwner();
      try {
        await stopping;
      } finally {
        stopping = null;
      }
    },

    status() {
      return ownerStatusFromEndpoint(endpoint, {
        paths,
        includeOwnerToken: true,
        started,
        startupError,
        operatorErrors: currentOperatorErrors(),
        processStartIdentityReader,
      });
    },

    get endpointPath() {
      return paths.endpointPath;
    },

    get socketPath() {
      return paths.socketPath;
    },

    get ownerToken() {
      return ownerToken;
    },
  });

  return owner;

  async function startOwner() {
    startupError = null;
    runtimeBinding = ownerRuntimeBindingForEnvironment({ env });
    await ensurePrivateDirectory(paths.authorityDirectory, {
      code: "authority_directory",
      rejectMode: false,
      statReader: directoryStatReader,
    });
    await loadOperatorErrors();
    const existing = await statusFlowOwner({
      ...paths,
      cleanupStale: false,
      processStartIdentityReader,
    });
    if (["running", "starting"].includes(existing.state)) {
      throw ownerError("owner_already_running");
    }
    if (existing.state === "unknown") {
      throw ownerError("owner_identity_unavailable");
    }
    if (existing.state === "invalid") {
      throw ownerError("owner_invalid_endpoint");
    }
    if (ownedRuntime === null) {
      try {
        ownedRuntime = await runtimeFactory({
          ...runtimeOptions,
          ...(runnerOptions === undefined ? {} : { runnerOptions }),
          env,
          authorityDirectory: paths.authorityDirectory,
          runnerErrorSink: (error) => report(error, "runner"),
        });
      } catch (error) {
        report(error, "runner");
        await flushOperatorErrors();
        throw error;
      }
    }
    if (!holdsMutationAuthority(ownedRuntime)) {
      if (runtime === null && ownedRuntime !== null) {
        closeFlowRuntime(ownedRuntime);
        ownedRuntime = null;
      }
      throw ownerError("mutation_authority_unavailable");
    }
    if (existing.state === "stale") {
      const staleEndpoint = await readEndpoint(paths.endpointPath);
      await removeStaleOwnerFiles(
        paths,
        staleEndpoint,
        processStartIdentityReader,
      );
    }
    const socketDirectoryPath = await ensureSocketDirectory(paths, {
      statReader: directoryStatReader,
    });
    activeSocketPath = join(socketDirectoryPath, basename(paths.socketPath));
    await assertSocketPathAvailable(activeSocketPath);
    try {
      transport = createFlowTransportServer({
        socketPath: activeSocketPath,
        runtime: ownedRuntime,
        maxFrameBytes,
        onError: (error) => report(error, "transport"),
      });
      await transport.start();
      socketIdentity = await socketIdentityAt(activeSocketPath);
      endpoint = makeEndpoint({
        paths,
        ownerToken,
        processStartIdentity,
        runtimeBinding,
      });
      await writeEndpoint(paths.endpointPath, endpoint);
      await flushOperatorErrors();
      started = true;
    } catch (error) {
      startupError = summarizeOwnerError(error);
      report(error, "transport");
      if (transport !== null) await transport.close().catch(() => {});
      transport = null;
      await removeSocketIfPresent(activeSocketPath, socketIdentity).catch(() => {});
      socketIdentity = null;
      activeSocketPath = paths.socketPath;
      if (runtime === null && ownedRuntime !== null) {
        closeFlowRuntime(ownedRuntime);
        ownedRuntime = null;
      }
      await flushOperatorErrors();
      throw error;
    }
  }

  async function stopOwner() {
    if (!started && transport === null) {
      stopped = true;
      await flushOperatorErrors();
      return ownerStatusFromEndpoint(endpoint, {
        paths,
        includeOwnerToken: true,
        started,
        startupError,
        operatorErrors: currentOperatorErrors(),
        processStartIdentityReader,
      });
    }
    started = false;
    stopped = true;
    if (!holdsMutationAuthority(ownedRuntime)) {
      report(ownerError("mutation_authority_unavailable"));
      return owner.status();
    }
    const ownedSocketIdentity = socketIdentity ??
      await socketIdentityAt(activeSocketPath);
    if (transport !== null) {
      await transport.close().catch((error) => report(error));
      transport = null;
    }
    const endpointRemoved = await removeEndpointIfOwned(
      paths.endpointPath,
      ownerToken,
      endpoint,
    );
    if (endpointRemoved) {
      await removeSocketIfPresent(activeSocketPath, ownedSocketIdentity)
        .catch((error) => report(error));
    }
    socketIdentity = null;
    activeSocketPath = paths.socketPath;
    endpoint = null;
    if (ownedRuntime !== null && runtime === null) {
      try {
        const closedByComposition = closeFlowRuntime(ownedRuntime);
        if (!closedByComposition && typeof ownedRuntime.close === "function") {
          ownedRuntime.close();
        }
      } catch (error) {
        report(error);
      }
      ownedRuntime = null;
    }
    await flushOperatorErrors();
    return owner.status();
  }

  function report(error, source = "lifecycle") {
    const category = source === "transport" || source === "lifecycle"
      ? source
      : "runner";
    const summary = {
      source,
      ...summarizeFlowRuntimeError(error, category),
    };
    operatorErrorCount += 1;
    if (operatorErrors.length >= MAX_OWNER_ERRORS) operatorErrorSuppressed += 1;
    operatorErrors = [...operatorErrors, summary].slice(-MAX_OWNER_ERRORS);
    operatorErrorWrite = operatorErrorWrite
      .catch(() => {})
      .then(() => persistOperatorErrors())
      .catch(() => {});
    try {
      onError(safeErrorForCallback(summary));
    } catch {
      // Lifecycle cleanup must remain best effort and bounded.
    }
  }

  function currentOperatorErrors() {
    return {
      count: operatorErrorCount,
      suppressed: operatorErrorSuppressed,
      last: operatorErrors.at(-1) ?? null,
    };
  }

  async function loadOperatorErrors() {
    const loaded = await readOperatorErrors(paths.operatorErrorPath);
    if (loaded === null) return;
    operatorErrorCount = loaded.count;
    operatorErrorSuppressed = loaded.suppressed;
    operatorErrors = loaded.entries;
  }

  async function flushOperatorErrors() {
    await operatorErrorWrite.catch(() => {});
  }

  async function persistOperatorErrors() {
    await ensurePrivateDirectory(paths.authorityDirectory, {
      code: "authority_directory",
      rejectMode: true,
      statReader: directoryStatReader,
    });
    const temporary = `${paths.operatorErrorPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({
        schema: OWNER_ERROR_LOG_SCHEMA,
        version: OWNER_ERROR_LOG_VERSION,
        count: operatorErrorCount,
        suppressed: operatorErrorSuppressed,
        entries: operatorErrors,
      })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, paths.operatorErrorPath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

/**
 * Start a detached owner process and wait until its private endpoint is
 * published.  A caller receives only a status projection; mutation remains
 * inside the child process.
 */
export async function startFlowOwner({
  env = process.env,
  authorityDirectory,
  endpointPath,
  socketPath,
  socketFallbackRoot,
  socketFallbackBase,
  ownerScript = fileURLToPath(import.meta.url),
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  ownerArgs = [],
  runnerOptions = undefined,
  processStartIdentityReader = readProcessStartIdentity,
} = {}) {
  if (typeof processStartIdentityReader !== "function") {
    throw new TypeError("Flow owner processStartIdentityReader must be a function");
  }
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
    socketFallbackRoot,
    socketFallbackBase,
  });
  const resolvedRunnerOptions = normalizeProductionRunnerOptions({
    env,
    runnerOptions,
  });
  const runtimeBinding = ownerRuntimeBindingForEnvironment({
    env,
    ownerScript,
  });
  const existing = await statusFlowOwner({
    ...paths,
    cleanupStale: false,
    processStartIdentityReader,
  });
  if (["running", "starting"].includes(existing.state)) {
    if (runtimeBinding !== null &&
        !ownerRuntimeBindingEqual(existing.runtime_binding, runtimeBinding)) {
      throw ownerError("owner_runtime_binding_mismatch");
    }
    return { ...existing, started: false, already_running: true };
  }
  if (existing.state === "unknown") {
    throw ownerError("owner_identity_unavailable");
  }
  if (existing.state === "invalid") {
    throw ownerError("owner_invalid_endpoint");
  }
  const childEnv = {
    ...env,
    FLOW_OWNER_PROCESS: "1",
    FLOW_AUTHORITY_DIRECTORY: paths.authorityDirectory,
    FLOW_OWNER_ENDPOINT_PATH: paths.endpointPath,
    FLOW_OWNER_SOCKET_PATH: paths.socketPath,
    ...(paths.socketFallbackRoot === null ? {} : {
      FLOW_OWNER_SOCKET_FALLBACK_ROOT: paths.socketFallbackRoot,
    }),
    FLOW_OWNER_MAX_FRAME_BYTES: String(maxFrameBytes),
    ...(runtimeBinding === null ? {} : {
      FLOW_OWNER_RUNTIME_BINDING: JSON.stringify(runtimeBinding),
    }),
    ...(resolvedRunnerOptions.delegateCapacity === undefined ? {} : {
      FLOW_RUNNER_DELEGATE_CAPACITY: String(resolvedRunnerOptions.delegateCapacity),
    }),
    ...(resolvedRunnerOptions.operationCapacity === undefined ? {} : {
      FLOW_RUNNER_OPERATION_CAPACITY: String(resolvedRunnerOptions.operationCapacity),
    }),
  };
  if (paths.socketFallbackRoot === null) {
    delete childEnv.FLOW_OWNER_SOCKET_FALLBACK_ROOT;
  }
  const child = spawn(process.execPath, [ownerScript, ...ownerArgs], {
    env: childEnv,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const ready = await waitForOwner(paths, {
    waitMs,
    pollMs,
    tolerateStale: true,
    child,
    processStartIdentityReader,
  });
  if (ready.state !== "running") {
    if (childExited(child)) throw ownerError("owner_exited_during_start");
    throw ownerError(ready.state === "stale"
      ? "owner_exited_during_start"
      : "owner_start_timeout");
  }
  return { ...ready, started: true, already_running: false };
}

/** Read the endpoint and validate owner process identity without mutation. */
export async function statusFlowOwner({
  env = process.env,
  authorityDirectory,
  endpointPath,
  socketPath,
  socketFallbackRoot,
  socketFallbackBase,
  cleanupStale = false,
  processStartIdentityReader = readProcessStartIdentity,
} = {}) {
  if (typeof processStartIdentityReader !== "function") {
    throw new TypeError("Flow owner processStartIdentityReader must be a function");
  }
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
    socketFallbackRoot,
    socketFallbackBase,
  });
  const endpoint = await readEndpoint(paths.endpointPath);
  if (endpoint === null) {
    return statusWithOperatorErrors("stopped", { paths });
  }
  const issue = validateEndpoint(endpoint, paths);
  if (issue !== null) {
    return statusWithOperatorErrors("invalid", {
      paths,
      endpoint,
      reason: issue,
    });
  }
  const processState = inspectOwnerProcess(endpoint, processStartIdentityReader);
  if (processState !== "alive") {
    if (cleanupStale && ownerProcessAbsenceProven(processState)) {
      await removeStaleOwnerFiles(paths, endpoint, processStartIdentityReader);
    }
    return statusWithOperatorErrors(
      processState === "identity_unavailable" ? "unknown" : "stale",
      {
      paths,
      endpoint,
      reason: processState,
      },
    );
  }
  const socketState = await pathExists(paths.socketPath);
  return statusWithOperatorErrors(socketState ? "running" : "starting", {
    paths,
    endpoint,
  });
}

/**
 * Stop exactly the owner described by the endpoint.  Identity is checked
 * immediately before every signal, so a stale endpoint can never terminate a
 * PID-reused process.
 */
export async function stopFlowOwner({
  env = process.env,
  authorityDirectory,
  endpointPath,
  socketPath,
  socketFallbackRoot,
  socketFallbackBase,
  ownerToken = undefined,
  pid = undefined,
  processStartIdentity = undefined,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  force = false,
  processStartIdentityReader = readProcessStartIdentity,
} = {}) {
  if (typeof processStartIdentityReader !== "function") {
    throw new TypeError("Flow owner processStartIdentityReader must be a function");
  }
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
    socketFallbackRoot,
    socketFallbackBase,
  });
  const endpoint = await readEndpoint(paths.endpointPath);
  if (endpoint === null) return statusProjection("stopped", { paths });
  const issue = validateEndpoint(endpoint, paths);
  if (issue !== null) {
    return statusProjection("invalid", { paths, endpoint, reason: issue });
  }
  if (ownerToken !== undefined && ownerToken !== endpoint.owner_token ||
      pid !== undefined && pid !== endpoint.pid ||
      processStartIdentity !== undefined &&
        processStartIdentity !== endpoint.process_start_identity) {
    return statusProjection("owner_mismatch", {
      paths,
      endpoint,
      reason: "owner_identity_mismatch",
    });
  }
  let state = inspectOwnerProcess(endpoint, processStartIdentityReader);
  if (state === "identity_unavailable") {
    return statusProjection("unknown", {
      paths,
      endpoint,
      reason: "owner_identity_unavailable",
    });
  }
  if (state !== "alive") {
    if (ownerProcessAbsenceProven(state)) {
      await removeStaleOwnerFiles(paths, endpoint, processStartIdentityReader);
    }
    return statusProjection("stopped", {
      paths,
      endpoint,
      previous_state: "stale",
    });
  }
  signalOwner(endpoint, "SIGTERM", processStartIdentityReader);
  const stopped = await waitForOwnerStop(paths, endpoint, {
    waitMs,
    pollMs,
    processStartIdentityReader,
  });
  if (stopped) {
    await removeStaleOwnerFiles(paths, endpoint, processStartIdentityReader);
    return statusProjection("stopped", { paths, endpoint });
  }
  if (force && inspectOwnerProcess(endpoint, processStartIdentityReader) === "alive") {
    signalOwner(endpoint, "SIGKILL", processStartIdentityReader);
    await waitForOwnerStop(paths, endpoint, {
      waitMs,
      pollMs,
      processStartIdentityReader,
    });
    if (inspectOwnerProcess(endpoint, processStartIdentityReader) !== "alive") {
      await removeStaleOwnerFiles(paths, endpoint, processStartIdentityReader);
      return statusProjection("stopped", { paths, endpoint, forced: true });
    }
  }
  return statusProjection("running", {
    paths,
    endpoint,
    reason: "owner_did_not_stop",
  });
}

/** Run the owner entrypoint in the current process (used by the detached child). */
export async function runFlowOwnerProcess({
  env = process.env,
  runtime = null,
  runtimeFactory = null,
  runtimeOptions = {},
  runnerOptions = undefined,
  authorityDirectory,
  endpointPath,
  socketPath,
  socketFallbackRoot,
  socketFallbackBase,
  maxFrameBytes = Number.parseInt(
    env.FLOW_OWNER_MAX_FRAME_BYTES ?? String(DEFAULT_MAX_FRAME_BYTES),
    10,
  ),
  onError = () => {},
  installSignalHandlers = true,
} = {}) {
  ownerRuntimeBindingForEnvironment({ env });
  const factory = runtimeFactory ?? await runtimeFactoryFromEnvironment(env);
  const owner = createFlowOwner({
    env,
    runtime,
    runtimeFactory: factory,
    runtimeOptions,
    runnerOptions,
    authorityDirectory,
    endpointPath,
    socketPath,
    socketFallbackRoot,
    socketFallbackBase,
    maxFrameBytes,
    onError,
  });
  await owner.start();
  if (installSignalHandlers) {
    let stopping = null;
    const signal = () => {
      if (stopping !== null) return;
      stopping = owner.stop().catch(onError).finally(() => {
        process.exitCode = 0;
        process.exit(0);
      });
    };
    process.once("SIGTERM", signal);
    process.once("SIGINT", signal);
  }
  return owner;
}

export function readProcessStartIdentity(pid, {
  readProc = requireReadFile,
  readPs = readProcessStartWithPs,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const proc = String(readProc(`/proc/${pid}/stat`));
    const closeParen = proc.lastIndexOf(")");
    if (closeParen >= 0) {
      const fields = proc.slice(closeParen + 2).trim().split(/\s+/u);
      // /proc/<pid>/stat field 22 (starttime), with the post-comm fields
      // beginning at field 3, is index 19 here.
      if (fields[19]) return fields[19];
    }
  } catch {
    // macOS and other Unix hosts do not expose /proc. Fall through to ps.
  }
  try {
    const identity = readPs(pid);
    return typeof identity === "string" && identity.trim().length > 0
      ? identity.trim()
      : null;
  } catch {
    return null;
  }
}

function readProcessStartWithPs(pid) {
  const source = execFileSync(
    "ps",
    ["-p", String(pid), "-o", "stat=", "-o", "lstart="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const match = /^(\S+)\s+(.+)$/u.exec(source);
  if (!match || match[1].includes("Z")) return null;
  return `ps:${match[2].trim()}`;
}

function readProcessState(pid) {
  try {
    const proc = requireReadFile(`/proc/${pid}/stat`);
    const closeParen = proc.lastIndexOf(")");
    if (closeParen >= 0) {
      return proc.slice(closeParen + 2).trim().split(/\s+/u)[0] ?? null;
    }
  } catch {
    // Fall through to the portable ps query below.
  }
  try {
    return execFileSync(
      "ps",
      ["-p", String(pid), "-o", "stat="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split(/\s+/u)[0] ?? null;
  } catch {
    return null;
  }
}

function requireReadFile(path) {
  // This tiny synchronous read keeps PID identity checks race-free with the
  // signal that follows.  It is isolated here so all other lifecycle I/O is
  // asynchronous and bounded.
  return readFileSync(path, "utf8");
}

async function runtimeFactoryFromEnvironment(env) {
  if (!env.FLOW_OWNER_RUNTIME_MODULE) return createFlowRuntime;
  const modulePath = resolve(env.FLOW_OWNER_RUNTIME_MODULE);
  const loaded = await import(pathToFileURL(modulePath).href);
  const factory = loaded.createFlowRuntime ?? loaded.createRuntime ?? loaded.default;
  if (typeof factory !== "function") {
    throw ownerError("runtime_factory_unavailable");
  }
  return factory;
}

function makeEndpoint({
  paths,
  ownerToken,
  processStartIdentity,
  runtimeBinding = null,
}) {
  return {
    schema: FLOW_OWNER_ENDPOINT,
    version: FLOW_OWNER_PROTOCOL_VERSION,
    owner_token: ownerToken,
    pid: process.pid,
    process_identity: ownerToken,
    process_start_identity: processStartIdentity ?? ownerToken,
    authority_directory: paths.authorityDirectory,
    endpoint_path: paths.endpointPath,
    socket_path: paths.socketPath,
    started_at: new Date().toISOString(),
    ...(runtimeBinding === null ? {} : { runtime_binding: runtimeBinding }),
  };
}

async function writeEndpoint(endpointPath, endpoint) {
  await ensurePrivateDirectory(dirname(endpointPath), {
    code: "endpoint_directory",
    rejectMode: false,
  });
  const temporary = `${endpointPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await link(temporary, endpointPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readEndpoint(endpointPath) {
  try {
    const info = await lstat(endpointPath);
    if (!info.isFile() || info.isSymbolicLink()) return INVALID_ENDPOINT;
    const source = await readFile(endpointPath, "utf8");
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      return INVALID_ENDPOINT;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : INVALID_ENDPOINT;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return INVALID_ENDPOINT;
  }
}

function validateEndpoint(endpoint, paths) {
  if (endpoint === INVALID_ENDPOINT) return "invalid_endpoint_record";
  if (endpoint.schema !== FLOW_OWNER_ENDPOINT || endpoint.version !== 1) {
    return "invalid_endpoint_schema";
  }
  if (!Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 ||
      typeof endpoint.owner_token !== "string" || endpoint.owner_token.length < 8 ||
      typeof endpoint.process_identity !== "string" ||
      endpoint.process_identity !== endpoint.owner_token ||
      typeof endpoint.process_start_identity !== "string" ||
      endpoint.process_start_identity.length === 0) {
    return "invalid_endpoint_identity";
  }
  if (endpoint.authority_directory !== paths.authorityDirectory ||
      endpoint.endpoint_path !== paths.endpointPath ||
      endpoint.socket_path !== paths.socketPath) {
    return "endpoint_path_mismatch";
  }
  if (endpoint.runtime_binding !== undefined &&
      !validOwnerRuntimeBinding(endpoint.runtime_binding)) {
    return "invalid_runtime_binding";
  }
  return null;
}

function inspectOwnerProcess(
  endpoint,
  processStartIdentityReader = readProcessStartIdentity,
) {
  let current = null;
  try {
    current = processStartIdentityReader(endpoint.pid);
  } catch {
    current = null;
  }
  if (current !== null) {
    if (readProcessState(endpoint.pid) === "Z") return "absent";
    return current === endpoint.process_start_identity ? "alive" : "reused";
  }
  try {
    process.kill(endpoint.pid, 0);
    // Existence without a start identity cannot prove ownership. Fail closed
    // instead of allowing a PID-reused process to receive a lifecycle signal.
    return "identity_unavailable";
  } catch (error) {
    return error?.code === "EPERM" ? "identity_unavailable" : "absent";
  }
}

function signalOwner(
  endpoint,
  signal,
  processStartIdentityReader = readProcessStartIdentity,
) {
  if (inspectOwnerProcess(endpoint, processStartIdentityReader) !== "alive") return false;
  try {
    process.kill(endpoint.pid, signal);
    return true;
  } catch (error) {
    if (["ESRCH", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
}

async function waitForOwner(
  paths,
  {
    waitMs,
    pollMs,
    tolerateStale = false,
    child = null,
    processStartIdentityReader = readProcessStartIdentity,
  },
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const status = await statusFlowOwner({
      ...paths,
      cleanupStale: false,
      processStartIdentityReader,
    });
    if (status.state === "running") return status;
    if (["invalid", "unknown"].includes(status.state) ||
        status.state === "stale" && !tolerateStale) return status;
    if (tolerateStale && childExited(child)) {
      return status;
    }
    await delay(pollMs);
  }
  return statusFlowOwner({
    ...paths,
    cleanupStale: false,
    processStartIdentityReader,
  });
}

function childExited(child) {
  return child !== null &&
    (child.exitCode !== null && child.exitCode !== undefined ||
      child.signalCode !== null && child.signalCode !== undefined);
}

async function waitForOwnerStop(
  paths,
  endpoint,
  { waitMs, pollMs, processStartIdentityReader = readProcessStartIdentity },
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    if (inspectOwnerProcess(endpoint, processStartIdentityReader) !== "alive") return true;
    const current = await readEndpoint(paths.endpointPath);
    if (current === null) return true;
    await delay(pollMs);
  }
  return inspectOwnerProcess(endpoint, processStartIdentityReader) !== "alive";
}

async function removeStaleOwnerFiles(
  paths,
  endpoint = null,
  processStartIdentityReader = readProcessStartIdentity,
) {
  const current = await readEndpoint(paths.endpointPath);
  if (endpoint === null || !sameEndpointRecord(endpoint, current) ||
      validateEndpoint(current, paths) !== null ||
      !ownerProcessAbsenceProven(
        inspectOwnerProcess(current, processStartIdentityReader),
      )) {
    return false;
  }
  const socketIdentity = await socketIdentityAt(paths.socketPath);
  const endpointIdentity = await endpointIdentityAt(paths.endpointPath);
  const latest = await readEndpoint(paths.endpointPath);
  const latestEndpointIdentity = await endpointIdentityAt(paths.endpointPath);
  if (!sameEndpointRecord(endpoint, latest) ||
      !sameFileIdentity(endpointIdentity, latestEndpointIdentity)) return false;
  if (!await unlinkEndpointIfIdentity(paths.endpointPath, endpointIdentity)) {
    return false;
  }
  await removeSocketIfPresent(paths.socketPath, socketIdentity);
  return true;
}

function ownerProcessAbsenceProven(state) {
  // A live PID with a different start identity is a reused PID, not the
  // owner described by this endpoint.  It may be cleaned up as stale, but it
  // must never be signalled: signalOwner only accepts the exact "alive"
  // state above.
  return state === "absent" || state === "reused";
}

function holdsMutationAuthority(runtime) {
  if (runtime?.mutationAuthority === true) return true;
  try {
    return flowRuntimeMutationAuthority(runtime) === true;
  } catch {
    return false;
  }
}

async function ensureSocketDirectory(paths, { statReader = lstat } = {}) {
  if (paths.socketFallbackRoot !== null) {
    if (paths.socketFallbackBase !== null) {
      await ensurePrivateDirectory(paths.socketFallbackBase, {
        code: "socket_runtime_directory",
        rejectMode: true,
        statReader,
      });
    }
    await ensurePrivateDirectory(paths.socketFallbackRoot, {
      code: "socket_directory",
      rejectMode: true,
      statReader,
    });
    const parent = dirname(paths.socketPath);
    if (dirname(parent) !== paths.socketFallbackRoot) {
      throw ownerError("socket_directory_mismatch");
    }
    return ensurePrivateDirectory(parent, {
      code: "socket_directory",
      rejectMode: true,
      statReader,
    });
  }
  return ensurePrivateDirectory(dirname(paths.socketPath), {
    code: "socket_directory",
    rejectMode: false,
    statReader,
  });
}

async function ensurePrivateDirectory(
  path,
  { code, rejectMode, statReader = lstat },
) {
  assertPrivatePath(path, `${code}_path`);
  const resolved = await ensureDirectoryTree(path, code, statReader);
  const info = resolved.info;
  if (info.isSymbolicLink()) throw ownerError(`${code}_symlink`);
  if (!info.isDirectory()) throw ownerError(`${code}_not_directory`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && info.uid !== uid) throw ownerError(`${code}_owner`);
  if ((info.mode & 0o777) !== 0o700) {
    if (rejectMode) throw ownerError(`${code}_mode`);
    await chmod(resolved.path, 0o700);
    const tightened = await statReader(resolved.path);
    if (tightened.isSymbolicLink() ||
        !tightened.isDirectory() ||
        uid !== null && tightened.uid !== uid ||
        (tightened.mode & 0o777) !== 0o700) {
      throw ownerError(`${code}_mode`);
    }
  }
  return resolved.path;
}

async function ensureDirectoryTree(path, code, statReader) {
  return ensureTrustedDirectoryTree(path, {
    code,
    statReader,
    errorFactory: ownerError,
  });
}

async function assertSocketPathAvailable(socketPath) {
  try {
    const info = await lstat(socketPath);
    if (info.isSymbolicLink()) throw ownerError("socket_path_symlink");
    throw ownerError("socket_path_occupied");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function removeEndpointIfOwned(
  endpointPath,
  ownerToken,
  expectedEndpoint = null,
) {
  const current = await readEndpoint(endpointPath);
  const endpointIdentity = await endpointIdentityAt(endpointPath);
  if (current?.owner_token !== ownerToken ||
      expectedEndpoint !== null && !sameEndpointRecord(current, expectedEndpoint)) {
    return false;
  }
  return unlinkEndpointIfIdentity(endpointPath, endpointIdentity);
}

async function endpointIdentityAt(endpointPath) {
  try {
    const info = await lstat(endpointPath);
    return info.isFile() && !info.isSymbolicLink()
      ? { dev: info.dev, ino: info.ino }
      : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return left !== null && right !== null &&
    left.dev === right.dev && left.ino === right.ino;
}

async function unlinkEndpointIfIdentity(endpointPath, expectedIdentity) {
  if (expectedIdentity === null) return false;
  const currentIdentity = await endpointIdentityAt(endpointPath);
  if (!sameFileIdentity(expectedIdentity, currentIdentity)) return false;
  await unlink(endpointPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function socketIdentityAt(socketPath) {
  try {
    const info = await lstat(socketPath);
    return info.isSocket() ? { dev: info.dev, ino: info.ino } : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameEndpointRecord(left, right) {
  if (left === null || right === null ||
      typeof left !== "object" || typeof right !== "object") return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    const info = await lstat(path);
    return info.isSocket();
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

async function statusWithOperatorErrors(state, options) {
  const projection = statusProjection(state, options);
  const operatorErrors = await readOperatorErrors(options.paths.operatorErrorPath);
  if (operatorErrors === null) return projection;
  return {
    ...projection,
    operator_errors: {
      count: operatorErrors.count,
      suppressed: operatorErrors.suppressed,
      last: operatorErrors.entries.at(-1) ?? null,
    },
  };
}

function statusProjection(state, {
  paths,
  endpoint = null,
  reason = null,
  previous_state = undefined,
  forced = undefined,
  started = undefined,
  startupError = null,
  includeOwnerToken = false,
  operatorErrors = null,
} = {}) {
  const projection = {
    schema: FLOW_OWNER_STATUS,
    version: FLOW_OWNER_PROTOCOL_VERSION,
    state,
    endpoint_path: paths.endpointPath,
    socket_path: paths.socketPath,
    authority_directory: paths.authorityDirectory,
    pid: endpoint?.pid ?? null,
    process_identity: endpoint?.process_identity ?? null,
    process_start_identity: endpoint?.process_start_identity ?? null,
    started_at: endpoint?.started_at ?? null,
    ...(endpoint?.runtime_binding === undefined ? {} : {
      runtime_binding: endpoint.runtime_binding,
    }),
    ...(reason === null ? {} : { reason }),
    ...(previous_state === undefined ? {} : { previous_state }),
    ...(forced === undefined ? {} : { forced }),
  };
  if (includeOwnerToken && endpoint?.owner_token) {
    projection.owner_token = endpoint.owner_token;
  }
  if (started === true && startupError !== null) {
    projection.startup_error = startupError;
  }
  if (operatorErrors !== null) {
    projection.operator_errors = operatorErrors;
  }
  return projection;
}

function ownerStatusFromEndpoint(endpoint, {
  paths,
  includeOwnerToken = false,
  started = undefined,
  startupError = null,
  operatorErrors = null,
  processStartIdentityReader = readProcessStartIdentity,
} = {}) {
  if (!endpoint) {
    return statusProjection(started ? "starting" : "stopped", {
      paths,
      started,
      startupError,
      includeOwnerToken,
      operatorErrors,
    });
  }
  const processState = inspectOwnerProcess(endpoint, processStartIdentityReader);
  return statusProjection(processState === "alive"
    ? "running"
    : processState === "identity_unavailable" ? "unknown" : "stale", {
    paths,
    endpoint,
    started,
    startupError,
    includeOwnerToken,
    operatorErrors,
  });
}

function summarizeOwnerError(error) {
  return {
    code: summarizeFlowRuntimeError(error, "lifecycle").code,
  };
}

async function readOperatorErrors(path) {
  if (typeof path !== "string") return null;
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return invalidOperatorErrors();
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (info.isSymbolicLink() || !info.isFile() ||
      uid !== null && info.uid !== uid ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > MAX_OWNER_ERROR_LOG_BYTES) {
    return invalidOperatorErrors();
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return invalidOperatorErrors();
  }
  if (value?.schema !== OWNER_ERROR_LOG_SCHEMA ||
      value.version !== OWNER_ERROR_LOG_VERSION ||
      !Number.isSafeInteger(value.count) || value.count < 0 ||
      !Number.isSafeInteger(value.suppressed) || value.suppressed < 0 ||
      !Array.isArray(value.entries) || value.entries.length > MAX_OWNER_ERRORS) {
    return invalidOperatorErrors();
  }
  const entries = value.entries
    .map(sanitizeOperatorError)
    .filter((entry) => entry !== null);
  if (entries.length !== value.entries.length) return invalidOperatorErrors();
  return {
    count: value.count,
    suppressed: value.suppressed,
    entries,
  };
}

function sanitizeOperatorError(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !OWNER_ERROR_SOURCES.has(value.source)) return null;
  return {
    source: value.source,
    ...summarizeFlowRuntimeError(
      { code: value.code },
      value.source === "transport" ? "transport" : "runner",
    ),
  };
}

function invalidOperatorErrors() {
  return {
    count: 1,
    suppressed: 0,
    entries: [{
      source: "lifecycle",
      ...summarizeFlowRuntimeError(
        { code: "operator_error_sink_invalid" },
        "runner",
      ),
    }],
  };
}

function safeErrorForCallback(summary) {
  const error = new Error(summary.message);
  error.name = summary.name;
  error.code = summary.code;
  error.source = summary.source;
  return error;
}

function ownerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerRuntimeBindingForEnvironment({ env, ownerScript = fileURLToPath(import.meta.url) }) {
  const requested = env.FLOW_OWNER_RUNTIME_BINDING !== undefined ||
    env.FLOW_OWNER_RUNTIME_MODULE !== undefined ||
    env.FLOW_CONFIG_DIRECTORY !== undefined ||
    env.FLOW_QUALIFICATION_REPOSITORY_ROOT !== undefined ||
    ownerScript === fileURLToPath(import.meta.url);
  if (!requested) return null;
  try {
    if (env.FLOW_OWNER_RUNTIME_BINDING !== undefined) {
      return assertOwnerRuntimeBinding({ env, ownerScript });
    }
    return deriveOwnerRuntimeBinding({ env, ownerScript });
  } catch (error) {
    if (error?.code === "owner_runtime_binding_unavailable" ||
        error?.code === "owner_runtime_binding_mismatch") {
      throw error;
    }
    throw ownerError("owner_runtime_binding_unavailable");
  }
}

function assertPath(path, name) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`Flow owner ${name} must be an absolute path`);
  }
}

function assertPrivatePath(path, name) {
  assertPath(path, name);
  if (path.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw ownerError(`${name}_traversal`);
  }
}

function fallbackSocketPath(
  authorityDirectory,
  requestedSocketPath,
  env,
  inheritedRoot = undefined,
) {
  const hash = createHash("sha256")
    .update(authorityDirectory)
    .update("\0")
    .update(requestedSocketPath)
    .digest("hex")
    .slice(0, 24);
  const selected = inheritedRoot === undefined
    ? socketFallbackRoot(env, hash)
    : {
        root: inheritedRoot,
        base: validXdgRuntimeDirectory(env) &&
            inheritedRoot === join(env.XDG_RUNTIME_DIR, "flow-sockets")
          ? env.XDG_RUNTIME_DIR
          : null,
      };
  const root = selected.root;
  assertPrivatePath(root, "socketFallbackRoot");
  const directory = join(root, `flow-${hash}`);
  const candidate = join(directory, "owner.sock");
  if (Buffer.byteLength(candidate) < 100) {
    return { path: candidate, root, base: selected.base };
  }
  const boundedRoot = join(
    "/tmp",
    `flow-runtime-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
  );
  const boundedPath = join(boundedRoot, `flow-${hash}`, "owner.sock");
  if (Buffer.byteLength(boundedPath) >= 100) {
    throw new TypeError("Flow owner socket path exceeds the Unix path limit");
  }
  return { path: boundedPath, root: boundedRoot, base: null };
}

function socketFallbackRoot(env, hash) {
  const runtimeDirectory = env.XDG_RUNTIME_DIR;
  const preferred = validXdgRuntimeDirectory(env)
    ? join(runtimeDirectory, "flow-sockets")
    : join(
      tmpdir(),
      `flow-runtime-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
    );
  const candidate = join(preferred, `flow-${hash}`, "owner.sock");
  if (Buffer.byteLength(candidate) < 100) {
    return {
      root: preferred,
      base: validXdgRuntimeDirectory(env) ? runtimeDirectory : null,
    };
  }
  return {
    root: join(
      "/tmp",
      `flow-runtime-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
    ),
    base: null,
  };
}

function validXdgRuntimeDirectory(env) {
  return typeof env?.XDG_RUNTIME_DIR === "string" &&
    isAbsolute(env.XDG_RUNTIME_DIR) &&
    !env.XDG_RUNTIME_DIR.split(/[\\/]/u)
      .some((segment) => segment === "." || segment === "..");
}

function isBoundFallbackSocketPath(socketPath, root) {
  return typeof socketPath === "string" &&
    typeof root === "string" &&
    basename(socketPath) === "owner.sock" &&
    /^flow-[0-9a-f]{24}$/u.test(basename(dirname(socketPath))) &&
    dirname(dirname(socketPath)) === root;
}

function inheritedFallbackBase(env, root) {
  return validXdgRuntimeDirectory(env) &&
    root === join(env.XDG_RUNTIME_DIR, "flow-sockets")
    ? env.XDG_RUNTIME_DIR
    : null;
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.env.FLOW_OWNER_PROCESS === "1") {
  try {
    await runFlowOwnerProcess({ env: process.env });
  } catch (error) {
    process.stderr.write(`flow owner failed: ${error?.code ?? "owner_start_failed"}\n`);
    process.exitCode = 1;
  }
}

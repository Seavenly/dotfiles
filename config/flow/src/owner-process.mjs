import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createFlowRuntime, closeFlowRuntime } from "./runtime.mjs";
import {
  createFlowTransportServer,
  removeSocketIfPresent,
} from "./transport.mjs";

export const FLOW_OWNER_ENDPOINT = "flow.owner-endpoint/v1";
export const FLOW_OWNER_STATUS = "flow.owner-status/v1";
export const FLOW_OWNER_PROTOCOL_VERSION = 1;

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const INVALID_ENDPOINT = Object.freeze({ invalid_endpoint_record: true });

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
  socketPath = env.FLOW_SOCKET_PATH ?? env.FLOW_OWNER_SOCKET_PATH ??
    defaultSocketPath(authorityDirectory),
  } = {}) {
  assertPath(authorityDirectory, "authorityDirectory");
  assertPath(endpointPath, "endpointPath");
  assertPath(socketPath, "socketPath");
  const effectiveSocketPath = boundedSocketPath(authorityDirectory, socketPath);
  return Object.freeze({
    authorityDirectory,
    endpointPath,
    socketPath: effectiveSocketPath,
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
  authorityDirectory,
  endpointPath,
  socketPath,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  processStartIdentityReader = readProcessStartIdentity,
  onError = () => {},
} = {}) {
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
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
    await mkdir(paths.authorityDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.authorityDirectory, 0o700).catch(() => {});
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
    if (["stale", "invalid"].includes(existing.state)) {
      await removeStaleOwnerFiles(paths, existing.endpoint);
    }
    // A socket without a valid endpoint is never an authority identity.  It
    // is safe to remove exactly this socket after the endpoint check above.
    await removeSocketIfPresent(paths.socketPath);
    if (ownedRuntime === null) {
      ownedRuntime = await runtimeFactory({
        ...runtimeOptions,
        env,
        authorityDirectory: paths.authorityDirectory,
      });
    }
    transport = createFlowTransportServer({
      socketPath: paths.socketPath,
      runtime: ownedRuntime,
      maxFrameBytes,
      onError,
    });
    try {
      await transport.start();
      endpoint = makeEndpoint({ paths, ownerToken, processStartIdentity });
      await writeEndpoint(paths.endpointPath, endpoint);
      started = true;
    } catch (error) {
      startupError = summarizeOwnerError(error);
      await transport.close().catch(() => {});
      transport = null;
      if (runtime === null && ownedRuntime !== null) {
        closeFlowRuntime(ownedRuntime);
        ownedRuntime = null;
      }
      throw error;
    }
  }

  async function stopOwner() {
    if (!started && transport === null) {
      stopped = true;
      return ownerStatusFromEndpoint(endpoint, {
        paths,
        includeOwnerToken: true,
        started,
        startupError,
        processStartIdentityReader,
      });
    }
    started = false;
    stopped = true;
    if (transport !== null) {
      await transport.close().catch((error) => report(error));
      transport = null;
    }
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
    await removeEndpointIfOwned(paths.endpointPath, ownerToken);
    await removeSocketIfPresent(paths.socketPath).catch((error) => report(error));
    endpoint = null;
    return owner.status();
  }

  function report(error) {
    try {
      onError(error);
    } catch {
      // Lifecycle cleanup must remain best effort and bounded.
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
  ownerScript = fileURLToPath(import.meta.url),
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  ownerArgs = [],
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
  });
  const existing = await statusFlowOwner({
    ...paths,
    cleanupStale: false,
    processStartIdentityReader,
  });
  if (["running", "starting"].includes(existing.state)) {
    return { ...existing, started: false, already_running: true };
  }
  if (existing.state === "unknown") {
    throw ownerError("owner_identity_unavailable");
  }
  if (["stale", "invalid"].includes(existing.state)) {
    await removeStaleOwnerFiles(paths, existing.endpoint);
  }
  await removeSocketIfPresent(paths.socketPath);
  const childEnv = {
    ...env,
    FLOW_OWNER_PROCESS: "1",
    FLOW_AUTHORITY_DIRECTORY: paths.authorityDirectory,
    FLOW_OWNER_ENDPOINT_PATH: paths.endpointPath,
    FLOW_OWNER_SOCKET_PATH: paths.socketPath,
    FLOW_OWNER_MAX_FRAME_BYTES: String(maxFrameBytes),
  };
  const child = spawn(process.execPath, [ownerScript, ...ownerArgs], {
    env: childEnv,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const ready = await waitForOwner(paths, {
    waitMs,
    pollMs,
    processStartIdentityReader,
  });
  if (ready.state !== "running") {
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
  });
  const endpoint = await readEndpoint(paths.endpointPath);
  if (endpoint === null) {
    return statusProjection("stopped", { paths });
  }
  const issue = validateEndpoint(endpoint, paths);
  if (issue !== null) {
    if (cleanupStale) await removeStaleOwnerFiles(paths, endpoint);
    return statusProjection("invalid", { paths, endpoint, reason: issue });
  }
  const processState = inspectOwnerProcess(endpoint, processStartIdentityReader);
  if (processState !== "alive") {
    if (cleanupStale) await removeStaleOwnerFiles(paths, endpoint);
    return statusProjection(processState === "identity_unavailable" ? "unknown" : "stale", {
      paths,
      endpoint,
      reason: processState,
    });
  }
  const socketState = await pathExists(paths.socketPath);
  return statusProjection(socketState ? "running" : "starting", {
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
    await removeStaleOwnerFiles(paths, endpoint);
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
    await removeStaleOwnerFiles(paths, endpoint);
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
      await removeStaleOwnerFiles(paths, endpoint);
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
  authorityDirectory,
  endpointPath,
  socketPath,
  maxFrameBytes = Number.parseInt(
    env.FLOW_OWNER_MAX_FRAME_BYTES ?? String(DEFAULT_MAX_FRAME_BYTES),
    10,
  ),
  onError = () => {},
  installSignalHandlers = true,
} = {}) {
  const factory = runtimeFactory ?? await runtimeFactoryFromEnvironment(env);
  const owner = createFlowOwner({
    env,
    runtime,
    runtimeFactory: factory,
    runtimeOptions,
    authorityDirectory,
    endpointPath,
    socketPath,
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

function makeEndpoint({ paths, ownerToken, processStartIdentity }) {
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
  };
}

async function writeEndpoint(endpointPath, endpoint) {
  await mkdir(dirname(endpointPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(endpointPath), 0o700);
  const temporary = `${endpointPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, endpointPath);
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
  { waitMs, pollMs, processStartIdentityReader = readProcessStartIdentity },
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const status = await statusFlowOwner({
      ...paths,
      cleanupStale: false,
      processStartIdentityReader,
    });
    if (status.state === "running") return status;
    if (["stale", "invalid", "unknown"].includes(status.state)) return status;
    await delay(pollMs);
  }
  return statusFlowOwner({
    ...paths,
    cleanupStale: false,
    processStartIdentityReader,
  });
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

async function removeStaleOwnerFiles(paths, endpoint = null) {
  if (endpoint?.socket_path !== undefined && endpoint.socket_path !== paths.socketPath) return;
  await unlink(paths.endpointPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await removeSocketIfPresent(paths.socketPath);
}

async function removeEndpointIfOwned(endpointPath, ownerToken) {
  const current = await readEndpoint(endpointPath);
  if (current?.owner_token !== ownerToken) return false;
  await unlink(endpointPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function pathExists(path) {
  try {
    const info = await lstat(path);
    return info.isSocket();
  } catch (error) {
    return error?.code !== "ENOENT";
  }
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
  return projection;
}

function ownerStatusFromEndpoint(endpoint, {
  paths,
  includeOwnerToken = false,
  started = undefined,
  startupError = null,
  processStartIdentityReader = readProcessStartIdentity,
} = {}) {
  if (!endpoint) {
    return statusProjection(started ? "starting" : "stopped", {
      paths,
      started,
      startupError,
      includeOwnerToken,
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
  });
}

function summarizeOwnerError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "owner_start_failed",
  };
}

function ownerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertPath(path, name) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`Flow owner ${name} must be an absolute path`);
  }
}

function defaultSocketPath(authorityDirectory) {
  const candidate = join(authorityDirectory, "owner.sock");
  // AF_UNIX paths are commonly capped at 108 bytes.  Keep long disposable
  // roots usable while retaining an unambiguous endpoint record.
  if (Buffer.byteLength(candidate) < 100) return candidate;
  return fallbackSocketPath(authorityDirectory, candidate);
}

function boundedSocketPath(authorityDirectory, socketPath) {
  if (Buffer.byteLength(socketPath) < 100) return socketPath;
  return fallbackSocketPath(authorityDirectory, socketPath);
}

function fallbackSocketPath(authorityDirectory, requestedSocketPath) {
  const hash = createHash("sha256")
    .update(authorityDirectory)
    .update("\0")
    .update(requestedSocketPath)
    .digest("hex")
    .slice(0, 24);
  const directory = join(socketFallbackRoot(), `flow-${hash}`);
  const candidate = join(directory, "owner.sock");
  if (Buffer.byteLength(candidate) < 100) return candidate;
  // A custom TMPDIR can itself exceed the Unix socket limit. /tmp is present
  // on the supported macOS and Ubuntu hosts and keeps the fallback bounded.
  return join("/tmp", `flow-${hash}`, "owner.sock");
}

function socketFallbackRoot() {
  const candidate = join(tmpdir(), "flow-sockets");
  return Buffer.byteLength(candidate) < 70 ? candidate : "/tmp";
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

import { mkdir, chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";

export const FLOW_RUNTIME_INTERFACE = "flow.runtime/v1";
export const FLOW_TRANSPORT_REQUEST = "flow.transport-request/v1";
export const FLOW_TRANSPORT_RESPONSE = "flow.transport-response/v1";
export const FLOW_TRANSPORT_ERROR = "flow.transport-error/v1";
export const FLOW_RUNTIME_OPERATIONS = Object.freeze([
  "prepare",
  "launch",
  "command",
  "query",
  "watch",
]);

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const REQUEST_KEYS = new Set([
  "schema",
  "interface",
  "version",
  "request_id",
  "operation",
  "request",
]);
const RESPONSE_KEYS = new Set([
  "schema",
  "interface",
  "version",
  "request_id",
  "operation",
  "ok",
  "done",
  "sequence",
  "watermark",
  "result",
  "error",
]);
const ERROR_KEYS = new Set(["schema", "version", "code"]);

/**
 * Host-local newline-delimited JSON transport for the five FlowRuntime
 * operations.  Lifecycle policy intentionally lives in owner-process.mjs;
 * this module only frames and dispatches Interface requests.
 */
export function createFlowTransportServer({
  socketPath,
  runtime,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  onError = () => {},
} = {}) {
  assertSocketPath(socketPath);
  assertRuntime(runtime);
  assertFrameLimit(maxFrameBytes);
  if (typeof onError !== "function") {
    throw new TypeError("Flow transport onError must be a function");
  }

  let server = null;
  let starting = null;
  let closing = false;
  const connections = new Map();
  const returnedWatchers = new WeakMap();

  const controller = Object.freeze({
    async start() {
      if (server?.listening) return controller;
      if (starting !== null) return starting;
      if (closing) throw new Error("Flow transport server is closed");
      starting = listen();
      try {
        await starting;
        return controller;
      } finally {
        starting = null;
      }
    },

    async close() {
      if (closing) return;
      closing = true;
      for (const connection of connections.values()) {
        await closeConnection(connection);
      }
      if (!server) return;
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      server = null;
    },

    get listening() {
      return server?.listening === true;
    },

    get socketPath() {
      return socketPath;
    },
  });

  return controller;

  async function listen() {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(socketPath), 0o700);
    const candidate = net.createServer((socket) => acceptConnection(socket));
    server = candidate;
    candidate.on("error", (error) => {
      if (!candidate.listening && starting !== null) {
        // The listen promise owns the startup error.  The listener prevents
        // an unhandled error if the socket is already occupied.
        return;
      }
      report(error);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        candidate.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        candidate.off("error", onError);
        resolve();
      };
      candidate.once("error", onError);
      candidate.once("listening", onListening);
      candidate.listen(socketPath);
    }).catch((error) => {
      if (server === candidate) server = null;
      candidate.close();
      throw error;
    });
    try {
      await chmod(socketPath, 0o600);
    } catch (error) {
      await new Promise((resolve) => candidate.close(resolve));
      if (server === candidate) server = null;
      throw error;
    }
  }

  function acceptConnection(socket) {
    socket.setNoDelay(true);
    const connection = {
      socket,
      watcher: null,
      closed: false,
      parsed: false,
      bytes: 0,
      buffer: Buffer.alloc(0),
    };
    connections.set(socket, connection);
    socket.on("data", (chunk) => consumeBytes(connection, chunk));
    socket.once("close", () => {
      void closeConnection(connection);
    });
    socket.on("error", (error) => {
      if (!isSocketDisconnect(error)) report(error);
    });
  }

  function consumeBytes(connection, chunk) {
    if (connection.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    connection.bytes += bytes.byteLength;
    if (connection.bytes + 1 > maxFrameBytes) {
      void protocolFailure(connection, "frame_too_large");
      return;
    }
    connection.buffer = Buffer.concat([connection.buffer, bytes]);
    const newline = connection.buffer.indexOf(0x0a);
    if (newline < 0) return;
    const frame = connection.buffer.subarray(0, newline);
    const trailing = connection.buffer.subarray(newline + 1);
    connection.buffer = Buffer.alloc(0);
    connection.bytes = 0;
    if (trailing.byteLength > 0) {
      void protocolFailure(connection, "multiple_requests_per_connection");
      return;
    }
    if (connection.parsed) {
      void protocolFailure(connection, "multiple_requests_per_connection");
      return;
    }
    connection.parsed = true;
    let request;
    try {
      request = parseRequestFrame(frame, maxFrameBytes);
    } catch (error) {
      void protocolFailure(connection, error.code ?? "invalid_request");
      return;
    }
    void dispatch(connection, request);
  }

  async function dispatch(connection, request) {
    if (connection.closed) return;
    try {
      if (request.operation === "watch") {
        await streamWatch(connection, request);
        return;
      }
      const result = await runtime[request.operation](request.request);
      await writeFrame(connection.socket, responseFrame(request, {
        ok: true,
        done: true,
        result,
      }), maxFrameBytes);
      if (!connection.closed) connection.socket.end();
    } catch (error) {
      await sendError(connection, request, error);
    }
  }

  async function streamWatch(connection, request) {
    let watcher;
    let iterator;
    try {
      watcher = await runtime.watch(request.request);
      iterator = watcher?.[Symbol.asyncIterator]?.() ?? watcher;
      if (!iterator || typeof iterator.next !== "function") {
        throw transportError("invalid_watch_result");
      }
      connection.watcher = iterator;
      let sequence = 0;
      while (!connection.closed) {
        const item = await iterator.next();
        if (item.done) break;
        const observation = item.value;
        await writeFrame(connection.socket, responseFrame(request, {
          ok: true,
          done: false,
          sequence,
          watermark: observation?.watermark ??
            observation?.authority_watermark ?? null,
          result: observation,
        }), maxFrameBytes);
        sequence += 1;
      }
      if (!connection.closed) {
        await writeFrame(connection.socket, responseFrame(request, {
          ok: true,
          done: true,
          sequence,
        }), maxFrameBytes);
        connection.socket.end();
      }
    } catch (error) {
      await sendError(connection, request, error);
    } finally {
      if (connection.watcher === iterator) {
        connection.watcher = null;
      }
      await returnWatcher(iterator ?? watcher);
    }
  }

  async function sendError(connection, request, error) {
    if (connection.closed) return;
    try {
      await writeFrame(connection.socket, responseFrame(request, {
        ok: false,
        done: true,
        error: transportErrorEnvelope(error?.code),
      }), maxFrameBytes);
    } catch (sendFailure) {
      report(sendFailure);
    }
    if (!connection.closed) connection.socket.end();
  }

  async function protocolFailure(connection, code) {
    if (connection.closed) return;
    const request = {
      schema: FLOW_TRANSPORT_REQUEST,
      interface: FLOW_RUNTIME_INTERFACE,
      version: 1,
      request_id: null,
      operation: null,
      request: null,
    };
    try {
      await writeFrame(connection.socket, responseFrame(request, {
        ok: false,
        done: true,
        error: transportErrorEnvelope(code),
      }), maxFrameBytes);
    } catch (error) {
      report(error);
    }
    connection.socket.destroy();
  }

  async function closeConnection(connection) {
    if (connection.closed) return;
    connection.closed = true;
    connections.delete(connection.socket);
    const watcher = connection.watcher;
    connection.watcher = null;
    await returnWatcher(watcher);
    if (!connection.socket.destroyed) connection.socket.destroy();
  }

  async function returnWatcher(watcher) {
    if (watcher === null ||
        !["object", "function"].includes(typeof watcher) ||
        typeof watcher.return !== "function") {
      return;
    }
    let returned = returnedWatchers.get(watcher);
    if (returned === undefined) {
      returned = Promise.resolve().then(() => watcher.return());
      returnedWatchers.set(watcher, returned);
    }
    try {
      await returned;
    } catch (error) {
      report(error);
    }
  }

  function report(error) {
    try {
      onError(error);
    } catch {
      // Error reporting must not take the host down.
    }
  }
}

/** Send one strictly framed request and resolve its one response. */
export async function requestFlowTransport({
  socketPath,
  operation,
  request,
  requestId = randomUUID(),
  timeoutMs = 10_000,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
} = {}) {
  assertSocketPath(socketPath);
  assertOperation(operation);
  assertFrameLimit(maxFrameBytes);
  const frame = requestFrame({ operation, request, requestId });
  const socket = await connect(socketPath, timeoutMs);
  try {
    await writeFrame(socket, frame, maxFrameBytes);
    const response = await readOneResponse(socket, {
      requestId,
      operation,
      timeoutMs,
      maxFrameBytes,
    });
    if (response.ok !== true) {
      throw flowTransportResponseError(response.error);
    }
    return response.result;
  } finally {
    socket.destroy();
  }
}

/** Return an async iterator over the watermarked responses for watch. */
export function watchFlowTransport({
  socketPath,
  request,
  requestId = randomUUID(),
  timeoutMs = 10_000,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
} = {}) {
  assertSocketPath(socketPath);
  assertFrameLimit(maxFrameBytes);
  let socket = null;
  let iteratorPromise = null;
  let closed = false;
  let done = false;
  const queue = [];
  const waiters = [];

  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (done) return Promise.resolve({ done: true, value: undefined });
      ensureReader();
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async return() {
      close();
      return { done: true, value: undefined };
    },
  };
  ensureReader();
  return iterator;

  function ensureReader() {
    if (iteratorPromise !== null || closed) return;
    iteratorPromise = (async () => {
      try {
        socket = await connect(socketPath, timeoutMs);
        await writeFrame(socket, requestFrame({
          operation: "watch",
          request,
          requestId,
        }), maxFrameBytes);
        await readWatchResponses();
      } catch (error) {
        finish(error);
      }
    })();
  }

  async function readWatchResponses() {
    let buffer = Buffer.alloc(0);
    for await (const chunk of socket) {
      if (closed) return;
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (frame.byteLength + 1 > maxFrameBytes) {
          throw transportError("frame_too_large");
        }
        const response = parseResponseFrame(frame, maxFrameBytes);
        if (response.request_id !== requestId ||
            response.operation !== "watch") {
          throw transportError("response_correlation_mismatch");
        }
        if (response.ok !== true) throw flowTransportResponseError(response.error);
        if (response.done === true) {
          finish();
          return;
        }
        publish({ done: false, value: response.result });
      }
      // Validate only the still-incomplete frame after consuming every
      // complete newline-delimited frame. A single TCP chunk may contain
      // several valid frames whose combined size exceeds the per-frame cap.
      if (buffer.byteLength + 1 > maxFrameBytes) {
        throw transportError("frame_too_large");
      }
    }
    if (!done) throw transportError("transport_disconnected");
  }

  function publish(item) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(item);
    else queue.push(item);
  }

  function finish(error = null) {
    if (done) return;
    done = true;
    if (error) {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    } else {
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined });
      }
    }
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    done = true;
    if (socket && !socket.destroyed) socket.destroy();
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

export function requestFrame({ operation, request, requestId = randomUUID() }) {
  assertOperation(operation);
  if (typeof requestId !== "string" || requestId.length === 0 ||
      requestId.length > 128) {
    throw new TypeError("Flow transport request_id must be a bounded string");
  }
  return {
    schema: FLOW_TRANSPORT_REQUEST,
    interface: FLOW_RUNTIME_INTERFACE,
    version: 1,
    request_id: requestId,
    operation,
    request: request === undefined ? {} : request,
  };
}

export function parseRequestFrame(frame, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
  const value = parseJsonFrame(frame, maxFrameBytes);
  if (!isPlainRecord(value) || !exactKeys(value, REQUEST_KEYS) ||
      value.schema !== FLOW_TRANSPORT_REQUEST ||
      value.interface !== FLOW_RUNTIME_INTERFACE || value.version !== 1 ||
      typeof value.request_id !== "string" || value.request_id.length === 0 ||
      value.request_id.length > 128 || typeof value.operation !== "string" ||
      !FLOW_RUNTIME_OPERATIONS.includes(value.operation) ||
      !Object.hasOwn(value, "request")) {
    throw transportError("invalid_request");
  }
  return value;
}

export function parseResponseFrame(frame, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
  const value = parseJsonFrame(frame, maxFrameBytes);
  const protocolFailure = value?.ok === false &&
    value?.request_id === null && value?.operation === null;
  if (!isPlainRecord(value) || !exactKeys(value, RESPONSE_KEYS) ||
      value.schema !== FLOW_TRANSPORT_RESPONSE ||
      value.interface !== FLOW_RUNTIME_INTERFACE || value.version !== 1 ||
      (!protocolFailure &&
        (typeof value.request_id !== "string" || value.request_id.length === 0 ||
         !FLOW_RUNTIME_OPERATIONS.includes(value.operation))) ||
      typeof value.ok !== "boolean" || typeof value.done !== "boolean") {
    throw transportError("invalid_response");
  }
  if (value.ok && value.error !== undefined) throw transportError("invalid_response");
  if (!value.ok && !isTransportErrorEnvelope(value.error)) {
    throw transportError("invalid_response");
  }
  return value;
}

function responseFrame(request, values) {
  return {
    schema: FLOW_TRANSPORT_RESPONSE,
    interface: FLOW_RUNTIME_INTERFACE,
    version: 1,
    request_id: request.request_id,
    operation: request.operation,
    ...values,
  };
}

async function writeFrame(socket, value, maxFrameBytes) {
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(value));
  } catch {
    throw transportError("unserializable_response");
  }
  if (encoded.byteLength + 1 > maxFrameBytes) {
    throw transportError("frame_too_large");
  }
  await new Promise((resolve, reject) => {
    socket.write(Buffer.concat([encoded, Buffer.from("\n")]), (error) =>
      error ? reject(error) : resolve());
  });
}

async function readOneResponse(socket, {
  requestId,
  operation,
  timeoutMs,
  maxFrameBytes,
}) {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      timer = null;
      reject(transportError("response_timeout"));
    }, timeoutMs);
    const finish = (error, response) => {
      if (timer !== null) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) reject(error);
      else resolve(response);
    };
    const onError = (error) => finish(transportError(error?.code ?? "transport_error"));
    const onEnd = () => finish(transportError("transport_disconnected"));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.byteLength > maxFrameBytes) {
        finish(transportError("frame_too_large"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const frame = buffer.subarray(0, newline);
      if (buffer.byteLength !== newline + 1) {
        finish(transportError("multiple_responses"));
        return;
      }
      let response;
      try {
        response = parseResponseFrame(frame, maxFrameBytes);
      } catch (error) {
        finish(error);
        return;
      }
      if (response.request_id !== requestId || response.operation !== operation) {
        finish(transportError("response_correlation_mismatch"));
        return;
      }
      finish(null, response);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function connect(socketPath, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Flow transport timeout must be positive");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let timer = setTimeout(() => {
      timer = null;
      socket.destroy();
      reject(transportError("connect_timeout"));
    }, timeoutMs);
    const fail = (error) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      reject(transportError(error?.code ?? "owner_unavailable"));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

function parseJsonFrame(frame, maxFrameBytes) {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (bytes.byteLength + 1 > maxFrameBytes) {
    throw transportError("frame_too_large");
  }
  if (bytes.byteLength === 0) throw transportError("invalid_json");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw transportError("invalid_json");
  }
  return value;
}

function transportError(code = "transport_error") {
  const safeCode = safeTransportCode(code);
  const error = new Error(safeCode);
  error.code = safeCode;
  return error;
}

function transportErrorEnvelope(code = "transport_error") {
  return {
    schema: FLOW_TRANSPORT_ERROR,
    version: 1,
    code: safeTransportCode(code),
  };
}

function safeTransportCode(code) {
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code)
    ? code
    : "transport_error";
}

function isTransportErrorEnvelope(value) {
  return isPlainRecord(value) && exactKeys(value, ERROR_KEYS) &&
    value.schema === FLOW_TRANSPORT_ERROR && value.version === 1 &&
    typeof value.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(value.code);
}

function flowTransportResponseError(value) {
  const error = transportError(value?.code ?? "transport_error");
  error.schema = FLOW_TRANSPORT_ERROR;
  return error;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRuntime(runtime) {
  if (!runtime || FLOW_RUNTIME_OPERATIONS.some((operation) =>
    typeof runtime[operation] !== "function")) {
    throw new TypeError("Flow transport requires all five FlowRuntime operations");
  }
}

function assertOperation(operation) {
  if (!FLOW_RUNTIME_OPERATIONS.includes(operation)) {
    throw new TypeError(`unsupported FlowRuntime operation: ${String(operation)}`);
  }
}

function assertSocketPath(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new TypeError("Flow transport requires a socket path");
  }
}

function assertFrameLimit(maxFrameBytes) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024) {
    throw new TypeError("Flow transport frame limit must be at least 1024 bytes");
  }
}

function isSocketDisconnect(error) {
  return ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes(error?.code);
}

export async function removeSocketIfPresent(socketPath) {
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) return false;
    await unlink(socketPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

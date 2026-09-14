import {
  FLOW_RUNTIME_OPERATIONS,
  requestFlowTransport,
  watchFlowTransport,
} from "./transport.mjs";

/**
 * A transport-only FlowRuntime.  The client never opens RunAuthority and
 * therefore cannot acquire a persistent mutation lock.
 */
export function createFlowClient({
  socketPath,
  timeoutMs = 10_000,
  maxFrameBytes,
} = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new TypeError("Flow client requires a socket path");
  }
  const options = { socketPath, timeoutMs };
  if (maxFrameBytes !== undefined) options.maxFrameBytes = maxFrameBytes;
  const client = {};
  for (const operation of FLOW_RUNTIME_OPERATIONS) {
    if (operation === "watch") {
      client.watch = (request = {}) => watchFlowTransport({
        ...options,
        request,
      });
    } else {
      client[operation] = (request = {}) => requestFlowTransport({
        ...options,
        operation,
        request,
      });
    }
  }
  return Object.freeze(client);
}

export const createPublicFlowClient = createFlowClient;

export async function invokeFlowClient(client, operation, request = {}) {
  if (!client || typeof client[operation] !== "function" ||
      !FLOW_RUNTIME_OPERATIONS.includes(operation)) {
    throw new TypeError(`unsupported FlowRuntime operation: ${String(operation)}`);
  }
  return client[operation](request);
}

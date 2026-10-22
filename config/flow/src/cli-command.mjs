import { createFlowRuntime, FlowQueryRejected } from "./runtime.mjs";
import { createRejection } from "../../../tools/flow/src/rejection.mjs";
import { summarizeFlowRuntimeError } from
  "../../../tools/flow/src/flow-runtime-runner.mjs";
import { closeFlowRuntime } from "./runtime.mjs";
import { createFlowClient } from "./client.mjs";
import {
  flowOwnerPaths,
  startFlowOwner,
  statusFlowOwner,
  stopFlowOwner,
} from "./owner-process.mjs";

const MAX_STATUS_COUNT = 1_000_000;

const USAGE = `Usage:
  flow start [--json]
  flow status [--json]
  flow stop [--json]
  flow prepare --input JSON [--json]
  flow launch --input JSON [--json]
  flow command --input JSON [--json]
  flow query --input JSON [--json]
  flow watch --input JSON [--json]
  flow query legacy-inventory --json
  flow query delegated-agent [launch options] --caller-metadata JSON --json

Queries:
  legacy-inventory  Read retained Claude-only and Hermes-backed authority and evidence
  delegated-agent  Describe an exact non-mutating Drovr launch for preparation

Delegated-agent launch options:
  --harness HARNESS
  --role ROLE
  --model MODEL
  --effort EFFORT
  --capability CAPABILITY
`;

export async function runCli(
  args,
  {
    runtime = undefined,
    client = undefined,
    env = process.env,
    ownerOptions = {},
    stderr = process.stderr,
    stdout = process.stdout,
  } = {},
) {
  if (args.length === 0 || ["--help", "-h"].includes(args[0])) {
    stdout.write(USAGE);
    return 0;
  }
  const lifecycle = parseLifecycle(args);
  if (lifecycle !== null) {
    return runLifecycle(lifecycle, {
      env,
      ownerOptions,
      stderr,
      stdout,
    });
  }
  const queryRequest = parseQuery(args);
  const operationRequest = parseRuntimeOperation(args);
  if (!queryRequest && !operationRequest) {
    stderr.write(USAGE);
    return 2;
  }
  const operation = queryRequest !== null ? "query" : operationRequest.operation;
  const request = queryRequest !== null ? queryRequest.request : operationRequest.request;
  let directRuntime = runtime;
  let ownsDirectRuntime = false;
  const ownerPaths = flowOwnerPaths({ env, ...ownerOptions });
  const namedQuery = operation === "query" &&
    request?.schema === "flow.query/v1";
  const namedQueryOwner = namedQuery &&
    await ownerIsAvailable(ownerPaths);
  if (directRuntime === undefined && namedQuery && !namedQueryOwner) {
    // Inspection remains useful before the owner is started.  The fallback is
    // explicitly read-only and cannot acquire the durable mutation lock.
    try {
      directRuntime = createFlowRuntime({
        env,
        authorityDirectory: ownerPaths.authorityDirectory,
        authorityOptions: { access: "inspect" },
        autonomous: false,
      });
      ownsDirectRuntime = true;
    } catch {
      directRuntime = undefined;
    }
  }
  const selectedClient = directRuntime === undefined
    ? client ?? createFlowClient(flowOwnerPaths({
        env,
        ...ownerOptions,
      }))
    : null;
  try {
    if (operation === "watch") {
      const watcher = directRuntime === undefined
        ? selectedClient.watch(request)
        : directRuntime.watch(request);
      for await (const observation of watcher) {
        stdout.write(`${JSON.stringify(observation)}\n`);
      }
      return 0;
    }
    const result = directRuntime === undefined
      ? await selectedClient[operation](request)
      : await directRuntime[operation](request);
    if (result?.schema === "flow.rejection/v1") {
      stderr.write(`${JSON.stringify(result)}\n`);
      return operation === "query" && result.code === "unsupported_query" ? 2 : 1;
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof FlowQueryRejected && operation === "query") {
      stderr.write(`${JSON.stringify(createRejection({
        operation: "query",
        code: error.code,
        reason: error.reason ?? null,
        authorityWatermarkDomain: "host",
      }))}\n`);
      return 2;
    }
    stderr.write(`${JSON.stringify(createRejection({
      operation,
      code: operation === "query" && request?.query === "legacy_compatibility_inventory"
        ? "inventory_unavailable"
        : "transport_unavailable",
      authorityWatermarkDomain: "host",
    }))}\n`);
    return 1;
  } finally {
    if (ownsDirectRuntime) closeFlowRuntime(directRuntime);
  }
}

async function ownerIsAvailable(paths) {
  try {
    const status = await statusFlowOwner({ ...paths, cleanupStale: false });
    return ["running", "starting"].includes(status.state);
  } catch {
    return false;
  }
}

async function runLifecycle(command, { env, ownerOptions, stderr, stdout }) {
  try {
    let result;
    if (command.type === "start") {
      result = await startFlowOwner({ env, ...ownerOptions });
    } else if (command.type === "status") {
      result = await statusFlowOwner({ env, ...ownerOptions });
      result = await includeRunnerStatus(result, { env, ownerOptions });
    } else {
      result = await stopFlowOwner({ env, ...ownerOptions });
    }
    if (result.state === "owner_mismatch" || result.state === "invalid") {
      stderr.write(`${JSON.stringify(result)}\n`);
      return 1;
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(createRejection({
      operation: command.type,
      code: error?.code ?? `${command.type}_failed`,
      authorityWatermarkDomain: "host",
    }))}\n`);
    return 1;
  }
}

async function includeRunnerStatus(result, { env, ownerOptions }) {
  if (result?.state !== "running") return result;
  try {
    const client = createFlowClient(flowOwnerPaths({ env, ...ownerOptions }));
    const runner = await client.query({
      schema: "flow.query/v1",
      query: "autonomous_runner_status",
    });
    const sanitized = sanitizeRunnerStatus(runner);
    if (sanitized !== null) {
      return { ...result, runner: sanitized };
    }
    return {
      ...result,
      runner_error: { code: "invalid_runner_status" },
    };
  } catch (error) {
    return {
      ...result,
      runner_error: {
        code: summarizeFlowRuntimeError(error, "transport").code,
      },
    };
  }
}

function sanitizeRunnerStatus(value) {
  if (!isRecord(value) || value.schema !== "flow.runtime-runner-status/v1" ||
      !["idle", "running", "stopped"].includes(value.state)) return null;
  const runs = sanitizeCounters(value.runs, [
    "active",
    "executing",
    "waiting",
    "suspended",
    "retained",
  ]);
  const delegates = sanitizeCapacity(value.delegates);
  const operations = sanitizeCapacity(value.operations);
  const errors = sanitizeRunnerErrors(value.errors);
  if (runs === null || delegates === null || operations === null ||
      errors === null || !boundedCount(value.pending_commands)) return null;
  return {
    schema: value.schema,
    state: value.state,
    runs,
    delegates,
    operations,
    pending_commands: value.pending_commands,
    errors,
  };
}

function sanitizeCounters(value, fields) {
  if (!isRecord(value) || Object.keys(value).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(value, field))) return null;
  const output = {};
  for (const field of fields) {
    if (!boundedCount(value[field])) return null;
    output[field] = value[field];
  }
  return output;
}

function sanitizeCapacity(value) {
  const output = sanitizeCounters(value, ["active", "capacity", "available"]);
  if (output === null || output.capacity < 1 || output.available > output.capacity) {
    return null;
  }
  return output;
}

function sanitizeRunnerErrors(value) {
  if (!isRecord(value) || !Object.hasOwn(value, "last")) return null;
  const output = sanitizeCounters(
    {
      count: value.count,
      reported: value.reported,
      suppressed: value.suppressed,
    },
    ["count", "reported", "suppressed"],
  );
  if (output === null) return null;
  if (value.last === null) return { ...output, last: null };
  if (!isRecord(value.last)) return null;
  return {
    ...output,
    last: {
      name: "Error",
      message: "Autonomous runner error",
      code: summarizeFlowRuntimeError(value.last, "runner").code,
    },
  };
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_STATUS_COUNT;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLifecycle(args) {
  if (!["start", "status", "stop"].includes(args[0])) return null;
  if (args.length === 1 || args.length === 2 && args[1] === "--json") {
    return { type: args[0] };
  }
  return null;
}

function parseQuery(args) {
  if (
    args[0] === "query" &&
    args[1] === "legacy-inventory" &&
    args.length === 3 &&
    args[2] === "--json"
  ) {
    return {
      request: {
        schema: "flow.query/v1",
        query: "legacy_compatibility_inventory",
      },
    };
  }
  if (
    args[0] !== "query" ||
    args[1] !== "delegated-agent" ||
    args.at(-1) !== "--json"
  ) {
    return null;
  }
  const options = {};
  const allowed = new Map([
    ["--harness", "harness"],
    ["--role", "role"],
    ["--model", "model"],
    ["--effort", "effort"],
    ["--capability", "capability"],
  ]);
  let callerMetadata;
  for (let index = 2; index < args.length - 1; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== "string" || value === "--json") return null;
    if (flag === "--caller-metadata") {
      if (callerMetadata !== undefined) return null;
      try {
        callerMetadata = JSON.parse(value);
      } catch {
        return null;
      }
      continue;
    }
    const field = allowed.get(flag);
    if (!field || Object.hasOwn(options, field)) return null;
    options[field] = value;
  }
  if (callerMetadata === undefined) return null;
  return {
    request: {
      schema: "flow.query/v1",
      query: "delegated_agent_description",
      launch: options,
      caller_metadata: callerMetadata,
    },
  };
}

function parseRuntimeOperation(args) {
  if (!["prepare", "launch", "command", "query", "watch"].includes(args[0])) {
    return null;
  }
  // The two named query forms above retain their stable public syntax.
  if (args[0] === "query" && ["legacy-inventory", "delegated-agent"].includes(args[1])) {
    return null;
  }
  let input;
  let inputFromFlag = false;
  let json = false;
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (["--input", "--request"].includes(flag)) {
      if (input !== undefined || index + 1 >= args.length) return null;
      try {
        input = JSON.parse(args[++index]);
      } catch {
        return null;
      }
      inputFromFlag = true;
      continue;
    }
    if (flag.startsWith("--")) return null;
    positional.push(flag);
  }
  if (inputFromFlag) {
    if (positional.length !== 0) return null;
  } else {
    if (positional.length !== 1) return null;
    try {
      input = JSON.parse(positional[0]);
    } catch {
      return null;
    }
  }
  if (input === undefined) return null;
  return { operation: args[0], request: input, json };
}

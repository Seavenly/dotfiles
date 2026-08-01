import { createFlowRuntime, FlowQueryRejected } from "./runtime.mjs";
import { createRejection } from "../../../tools/flow/src/rejection.mjs";

const USAGE = `Usage:
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
    runtime = createFlowRuntime(),
    stderr = process.stderr,
    stdout = process.stdout,
  } = {},
) {
  if (args.length === 0 || ["--help", "-h"].includes(args[0])) {
    stdout.write(USAGE);
    return 0;
  }
  const queryRequest = parseQuery(args);
  if (!queryRequest) {
    stderr.write(USAGE);
    return 2;
  }
  try {
    const projection = await runtime.query(queryRequest);
    if (projection.schema === "flow.rejection/v1") {
      stderr.write(`${JSON.stringify(projection)}\n`);
      return projection.code === "unsupported_query" ? 2 : 1;
    }
    stdout.write(`${JSON.stringify(projection)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof FlowQueryRejected) {
      stderr.write(`${JSON.stringify(createRejection({
        operation: "query",
        code: error.code,
        reason: error.reason ?? null,
        authorityWatermarkDomain: "host",
      }))}\n`);
      return 2;
    }
    stderr.write(`${JSON.stringify(createRejection({
      operation: "query",
      code: queryRequest.query === "legacy_compatibility_inventory"
        ? "inventory_unavailable"
        : "description_unavailable",
      authorityWatermarkDomain: "host",
    }))}\n`);
    return 1;
  }
}

function parseQuery(args) {
  if (
    args[0] === "query" &&
    args[1] === "legacy-inventory" &&
    args.length === 3 &&
    args[2] === "--json"
  ) {
    return {
      schema: "flow.query/v1",
      query: "legacy_compatibility_inventory",
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
    schema: "flow.query/v1",
    query: "delegated_agent_description",
    launch: options,
    caller_metadata: callerMetadata,
  };
}

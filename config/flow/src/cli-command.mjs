import { createFlowRuntime, FlowQueryRejected } from "./runtime.mjs";

const USAGE = `Usage:
  flow query legacy-inventory --json

Queries:
  legacy-inventory  Read retained Claude-only and Hermes-backed authority and evidence
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
  if (
    args[0] !== "query" ||
    args[1] !== "legacy-inventory" ||
    args.length !== 3 ||
    args[2] !== "--json"
  ) {
    stderr.write(USAGE);
    return 2;
  }
  try {
    const projection = await runtime.query({
      schema: "flow.query/v1",
      query: "legacy_compatibility_inventory",
    });
    stdout.write(`${JSON.stringify(projection)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof FlowQueryRejected) {
      stderr.write(`${JSON.stringify({
        code: error.code,
        message: error.message,
        schema: "flow.rejection/v1",
      })}\n`);
      return 2;
    }
    stderr.write(`${JSON.stringify({
      code: "inventory_unavailable",
      message: "legacy compatibility inventory is unavailable",
      schema: "flow.rejection/v1",
    })}\n`);
    return 1;
  }
}

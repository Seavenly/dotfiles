import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Hermes 0.18.2 does not expose exact tool names through a public diagnostic.
// Keep its version-specific offline construction behind this single adapter.
const INSPECT_PROFILE = [
  "import json",
  "import hermes_cli.main",
  "from hermes_cli.config import load_config",
  "from hermes_cli.prompt_size import _build_inspection_agent",
  "config = load_config()",
  'kanban = config.get("kanban", {})',
  'agent = _build_inspection_agent("cli")',
  'print(json.dumps({"tools": sorted(tool["function"]["name"] ' +
    'for tool in agent.tools), "dispatchInGateway": ' +
    'kanban.get("dispatch_in_gateway"), "autoDecompose": ' +
    'kanban.get("auto_decompose")}))',
].join("; ");

export function defaultHermesRunner(binary) {
  return async (args, options = {}) => {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    });
    return stdout;
  };
}

function hermesPython(versionOutput) {
  if (process.env.AGENT_FLOW_HERMES_PYTHON) {
    return process.env.AGENT_FLOW_HERMES_PYTHON;
  }
  const installDirectory = versionOutput.match(
    /^Install directory:\s*(.+)$/m,
  )?.[1];
  if (!installDirectory) {
    throw new Error(
      "Hermes did not report its install directory; set AGENT_FLOW_HERMES_PYTHON",
    );
  }
  return join(installDirectory.trim(), "venv", "bin", "python");
}

async function inspectHermesProfile({ home, name, python }) {
  const profileHome = join(home, ".hermes", "profiles", name);
  const { stdout } = await execFileAsync(python, ["-c", INSPECT_PROFILE], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: profileHome,
      HERMES_KANBAN_TASK: "agent-flow-doctor-inspection",
    },
  });
  const inspection = JSON.parse(stdout);
  if (
    !Array.isArray(inspection.tools) ||
    inspection.tools.some((tool) => typeof tool !== "string") ||
    typeof inspection.dispatchInGateway !== "boolean" ||
    typeof inspection.autoDecompose !== "boolean"
  ) {
    throw new Error("Hermes returned a malformed native profile inspection");
  }
  return inspection;
}

export function createHermesProfileInspector({ home, versionOutput }) {
  const python = hermesPython(versionOutput);
  return (name) => inspectHermesProfile({ home, name, python });
}

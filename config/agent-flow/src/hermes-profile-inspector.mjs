import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Hermes 0.18.2 does not expose exact tool names through a public diagnostic.
// Keep its version-specific offline construction behind this single adapter.
const INSPECT_PROFILE = `
import json
import os
import pwd
import subprocess
import sys
import hermes_cli.main
from hermes_cli.config import load_config
from hermes_cli.prompt_size import _build_inspection_agent
from tools.environments.local import _make_run_env

config = load_config()
kanban = config.get("kanban", {})
terminal = config.get("terminal", {})
memory = config.get("memory", {})
agent = _build_inspection_agent("cli")
os.environ["TERMINAL_HOME_MODE"] = str(terminal.get("home_mode", "auto"))
probe_env = _make_run_env({})
probe_code = """
import json
import os
home = os.environ.get("HOME", "")
print(json.dumps({
    "home": home,
    "homeReadable": os.access(home, os.R_OK),
    "ordinaryEnvInherited": (
        os.environ.get("AGENT_FLOW_TRUST_SENTINEL") == "visible"
    ),
    "providerSecretFilteredByDefault": "OPENAI_API_KEY" not in os.environ,
    "gatewaySecretFiltered": "GATEWAY_RELAY_SECRET" not in os.environ,
}))
"""
probe_result = subprocess.run(
    [sys.executable, "-c", probe_code],
    env=probe_env,
    capture_output=True,
    text=True,
    check=True,
)
terminal_probe = json.loads(probe_result.stdout)
terminal_probe["homeIsOsUserHome"] = (
    terminal_probe["home"] == pwd.getpwuid(os.getuid()).pw_dir
)
print(json.dumps({
    "tools": sorted(tool["function"]["name"] for tool in agent.tools),
    "dispatchInGateway": kanban.get("dispatch_in_gateway"),
    "autoDecompose": kanban.get("auto_decompose"),
    "terminalBackend": terminal.get("backend"),
    "terminalHomeMode": terminal.get("home_mode"),
    "memoryEnabled": memory.get("memory_enabled"),
    "userProfileEnabled": memory.get("user_profile_enabled"),
    "concurrency": {
        "maxInProgress": kanban.get("max_in_progress"),
        "maxInProgressPerProfile": kanban.get("max_in_progress_per_profile"),
        "maxSpawn": kanban.get("max_spawn"),
    },
    "terminalProbe": terminal_probe,
}))
`;

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
      HERMES_REAL_HOME: homedir(),
      HERMES_HOME: profileHome,
      HERMES_KANBAN_TASK: "agent-flow-doctor-inspection",
      AGENT_FLOW_TRUST_SENTINEL: "visible",
      OPENAI_API_KEY: "agent-flow-filter-probe",
      GATEWAY_RELAY_SECRET: "agent-flow-filter-probe",
    },
  });
  const inspection = JSON.parse(stdout);
  if (
    !Array.isArray(inspection.tools) ||
    inspection.tools.some((tool) => typeof tool !== "string") ||
    typeof inspection.dispatchInGateway !== "boolean" ||
    typeof inspection.autoDecompose !== "boolean" ||
    typeof inspection.terminalBackend !== "string" ||
    typeof inspection.terminalHomeMode !== "string" ||
    typeof inspection.memoryEnabled !== "boolean" ||
    typeof inspection.userProfileEnabled !== "boolean" ||
    !inspection.terminalProbe ||
    typeof inspection.terminalProbe.home !== "string" ||
    [
      "homeReadable",
      "ordinaryEnvInherited",
      "providerSecretFilteredByDefault",
      "gatewaySecretFiltered",
      "homeIsOsUserHome",
    ].some((key) => typeof inspection.terminalProbe[key] !== "boolean") ||
    !inspection.concurrency ||
    Object.values(inspection.concurrency).some(
      (limit) => !Number.isInteger(limit) || limit < 1,
    )
  ) {
    throw new Error("Hermes returned a malformed native profile inspection");
  }
  return inspection;
}

export function createHermesProfileInspector({ home, versionOutput }) {
  const python = hermesPython(versionOutput);
  return (name) => inspectHermesProfile({ home, name, python });
}

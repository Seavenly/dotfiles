import { spawn } from "node:child_process";

import { claudeAgentArguments } from "./claude.mjs";
import { DrovrError } from "./errors.mjs";
import { execute } from "./process.mjs";

function parseJson(output, operation) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new DrovrError(
      `Herdr returned invalid JSON for ${operation}: ${error.message}`,
      {
        code: 4,
        outcome: "adapter_failure",
      },
    );
  }
}

export class HerdrClient {
  constructor({ session, run = execute, env = process.env } = {}) {
    this.session = session;
    this.run = run;
    this.env = env;
  }

  async sessionCommand(args) {
    try {
      return await this.run("herdr", ["--session", this.session, ...args], {
        env: this.env,
      });
    } catch (error) {
      const wrapped = new DrovrError(
        `Herdr ${args.slice(0, 2).join(" ")} failed: ${error.message}`,
        {
          code: 4,
          outcome: "adapter_failure",
        },
      );
      wrapped.adapterFailure = error;
      throw wrapped;
    }
  }

  async ensureSession() {
    const running = async () => {
      let output;
      try {
        output = await this.run("herdr", ["session", "list", "--json"], {
          env: this.env,
        });
      } catch (error) {
        throw new DrovrError(`Herdr session list failed: ${error.message}`, {
          code: 4,
          outcome: "adapter_failure",
        });
      }
      const sessions = parseJson(output, "session list");
      return sessions.sessions?.some(
        ({ name, running: isRunning }) => name === this.session && isRunning,
      );
    };
    if (await running()) return;

    await new Promise((resolve) => {
      const child = spawn("herdr", ["--session", this.session], {
        env: this.env,
        stdio: "ignore",
      });
      child.once("error", resolve);
      child.once("close", resolve);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await running()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new DrovrError(`Herdr session ${this.session} did not start`, {
      code: 4,
      outcome: "adapter_failure",
    });
  }

  async createWorkspace({ cwd, label }) {
    const result = parseJson(
      await this.sessionCommand([
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ]),
      "workspace create",
    ).result;
    const workspaceId = result?.workspace?.workspace_id ?? result?.workspace_id;
    const paneId = result?.root_pane?.pane_id ?? result?.pane?.pane_id;
    if (!workspaceId || !paneId) {
      throw new DrovrError(
        "Herdr workspace result omitted workspace or pane identity",
        {
          code: 4,
          outcome: "adapter_failure",
        },
      );
    }
    const pane = parseJson(
      await this.sessionCommand(["pane", "get", paneId]),
      "pane get",
    ).result?.pane;
    if (!pane?.tab_id) {
      throw new DrovrError("Herdr root pane result omitted tab identity", {
        code: 4,
        outcome: "adapter_failure",
      });
    }
    return { workspaceId, paneId, tabId: pane.tab_id };
  }

  async createTab({ workspaceId, cwd, label }) {
    const result = parseJson(
      await this.sessionCommand([
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ]),
      "tab create",
    ).result;
    const tabId = result?.tab?.tab_id ?? result?.tab_id;
    const paneId = result?.root_pane?.pane_id ?? result?.pane?.pane_id;
    if (!tabId || !paneId) {
      throw new DrovrError("Herdr tab result omitted tab or pane identity", {
        code: 4,
        outcome: "adapter_failure",
      });
    }
    return { tabId, paneId };
  }

  async startCodexAgent({ name, paneId, label, specification }) {
    await this.waitForShell(paneId);
    const native = specification.native;
    const agentArgs = [
      "--model",
      specification.model,
      "--sandbox",
      native.sandbox,
      "--ask-for-approval",
      native.approval,
      "-c",
      `model_reasoning_effort=${JSON.stringify(specification.effort)}`,
    ];
    if (native.approvals_reviewer) {
      agentArgs.push(
        "-c",
        `approvals_reviewer=${JSON.stringify(native.approvals_reviewer)}`,
      );
    }
    if (specification.instructions) {
      agentArgs.push(
        "-c",
        `developer_instructions=${JSON.stringify(specification.instructions)}`,
      );
    }
    if (native.network_access !== undefined) {
      agentArgs.push(
        "-c",
        `sandbox_workspace_write.network_access=${native.network_access}`,
      );
    }
    if (native.search) agentArgs.push("--search");
    await this.startAgentWhenPaneReady([
      "agent",
      "start",
      name,
      "--kind",
      "codex",
      "--pane",
      paneId,
      "--timeout",
      "120000",
      "--",
      ...agentArgs,
    ]);
    await this.sessionCommand(["pane", "rename", paneId, label]);
  }

  async startClaudeAgent({ name, paneId, label, specification }) {
    await this.waitForShell(paneId);
    const agentArgs = claudeAgentArguments(specification);
    await this.startAgentWhenPaneReady([
      "agent",
      "start",
      name,
      "--kind",
      "claude",
      "--pane",
      paneId,
      "--timeout",
      "120000",
      "--",
      ...agentArgs,
    ]);
    await this.sessionCommand(["pane", "rename", paneId, label]);
  }

  async startAgentWhenPaneReady(args) {
    let lastError;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await this.sessionCommand(args);
      } catch (error) {
        if (!isAgentPaneBusy(error)) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError;
  }

  async renameTab(tabId, label) {
    await this.sessionCommand(["tab", "rename", tabId, label]);
  }

  async waitForShell(paneId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let output;
      try {
        output = await this.sessionCommand([
          "pane",
          "process-info",
          "--pane",
          paneId,
        ]);
      } catch (error) {
        if (!isPaneNotFound(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const result = parseJson(output, "pane process-info").result
        ?.process_info;
      if (
        result?.shell_pid &&
        result.foreground_processes?.some(({ pid }) => pid === result.shell_pid)
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new DrovrError(`Herdr pane ${paneId} did not reach a shell prompt`, {
      code: 4,
      outcome: "adapter_failure",
    });
  }

  async agentRecord(name) {
    const result = parseJson(
      await this.sessionCommand(["agent", "list"]),
      "agent list",
    ).result;
    return result?.agents?.find((agent) => agent.name === name);
  }

  async agentExcerpt(name) {
    return this.sessionCommand([
      "agent",
      "read",
      name,
      "--source",
      "recent-unwrapped",
      "--lines",
      "30",
      "--format",
      "text",
    ]);
  }

  async attach(name, { takeover = false } = {}) {
    const args = ["--session", this.session, "agent", "attach", name];
    if (takeover) args.push("--takeover");
    return new Promise((resolve, reject) => {
      const child = spawn("herdr", args, { env: this.env, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 4));
    });
  }

  async prompt(name, prompt) {
    return this.sessionCommand(["agent", "prompt", name, prompt]);
  }

  async waitForAgent(name, timeoutMs) {
    const args = ["agent", "wait", name];
    if (timeoutMs !== undefined) {
      args.push("--timeout", String(timeoutMs));
    }
    let output;
    try {
      output = await this.sessionCommand(args);
    } catch (error) {
      if (isTimeout(error)) return { drovr_status: "still_running" };
      throw error;
    }
    const observed = parseJson(output, "agent wait").result?.agent;
    if (observed) return observed;
    return this.agentRecord(name);
  }
}

function isTimeout(error) {
  const adapterOutput = [
    error.adapterFailure?.stdout,
    error.adapterFailure?.stderr,
  ]
    .filter(Boolean)
    .join("\n");
  return /"code"\s*:\s*"timeout"|timed? out/iu.test(adapterOutput);
}

function isAgentPaneBusy(error) {
  const adapterOutput = [
    error.adapterFailure?.stdout,
    error.adapterFailure?.stderr,
  ]
    .filter(Boolean)
    .join("\n");
  return /"code"\s*:\s*"agent_pane_busy"/u.test(adapterOutput);
}

function isPaneNotFound(error) {
  const adapterOutput = [
    error.adapterFailure?.stdout,
    error.adapterFailure?.stderr,
  ]
    .filter(Boolean)
    .join("\n");
  return /"code"\s*:\s*"pane_not_found"/u.test(adapterOutput);
}

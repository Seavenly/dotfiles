import { spawn } from "node:child_process";

import { claudeAgentArguments } from "./claude.mjs";
import { codexAgentArguments } from "./codex.mjs";
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
  constructor({
    session,
    run = execute,
    env = process.env,
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.session = session;
    this.run = run;
    this.env = withoutCallerHerdrContext(env);
    this.delay = delay;
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
    if (await this.sessionRunning()) return;

    await new Promise((resolve) => {
      const child = spawn("herdr", ["--session", this.session], {
        env: this.env,
        stdio: "ignore",
      });
      child.once("error", resolve);
      child.once("close", resolve);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await this.sessionRunning()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new DrovrError(`Herdr session ${this.session} did not start`, {
      code: 4,
      outcome: "adapter_failure",
    });
  }

  async sessionRunning() {
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
    return Boolean(
      sessions.sessions?.some(
        ({ name, running }) => name === this.session && running,
      ),
    );
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

  async startCodexAgent({ name, paneId, label, specification, resume }) {
    await this.waitForShell(paneId);
    const agentArgs = codexAgentArguments(specification);
    if (resume) agentArgs.unshift("resume", resume);
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

  async resumeCodexAgent(options) {
    return this.startCodexAgent({ ...options, resume: options.nativeSession });
  }

  async startClaudeAgent({
    name,
    paneId,
    label,
    specification,
    systemPromptFile,
    resume,
  }) {
    await this.waitForShell(paneId);
    const agentArgs = claudeAgentArguments(specification, {
      systemPromptFile,
    });
    if (resume) agentArgs.push("--resume", resume);
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


  async resumeClaudeAgent(options) {
    return this.startClaudeAgent({ ...options, resume: options.nativeSession });
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

  async renameWorkspace(workspaceId, label) {
    await this.sessionCommand(["workspace", "rename", workspaceId, label]);
  }

  async renamePane(paneId, label) {
    await this.sessionCommand(["pane", "rename", paneId, label]);
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
    return (await this.agentRecords()).find((agent) => agent.name === name);
  }

  async agentRecords() {
    const result = parseJson(
      await this.sessionCommand(["agent", "list"]),
      "agent list",
    ).result;
    return result?.agents ?? [];
  }

  async paneProcessInfo(paneId) {
    return parseJson(
      await this.sessionCommand([
        "pane",
        "process-info",
        "--pane",
        paneId,
      ]),
      "pane process-info",
    ).result?.process_info;
  }

  async paneRecord(paneId) {
    try {
      return parseJson(
        await this.sessionCommand(["pane", "get", paneId]),
        "pane get",
      ).result?.pane;
    } catch (error) {
      if (isPaneNotFound(error)) return null;
      throw error;
    }
  }

  async paneLayout(paneId) {
    const layout = parseJson(
      await this.sessionCommand(["pane", "layout", "--pane", paneId]),
      "pane layout",
    ).result?.layout;
    if (!layout || !Array.isArray(layout.panes)) {
      throw new DrovrError("Herdr pane layout result omitted pane geometry", {
        code: 4,
        outcome: "adapter_failure",
      });
    }
    return layout;
  }

  async splitPane({ paneId, direction, ratio, cwd }) {
    const result = parseJson(
      await this.sessionCommand([
        "pane",
        "split",
        "--pane",
        paneId,
        "--direction",
        direction,
        "--ratio",
        String(ratio),
        "--cwd",
        cwd,
        "--no-focus",
      ]),
      "pane split",
    ).result;
    const createdPaneId =
      result?.pane?.pane_id ?? result?.root_pane?.pane_id ?? result?.pane_id;
    if (!createdPaneId) {
      throw new DrovrError("Herdr pane split result omitted pane identity", {
        code: 4,
        outcome: "adapter_failure",
      });
    }
    return createdPaneId;
  }

  async tabRecord(tabId) {
    try {
      return parseJson(
        await this.sessionCommand(["tab", "get", tabId]),
        "tab get",
      ).result?.tab;
    } catch (error) {
      if (isTabNotFound(error)) return null;
      throw error;
    }
  }

  async workspaceRecord(workspaceId) {
    try {
      return parseJson(
        await this.sessionCommand(["workspace", "get", workspaceId]),
        "workspace get",
      ).result?.workspace;
    } catch (error) {
      if (isWorkspaceNotFound(error)) return null;
      throw error;
    }
  }

  async closePane(paneId) {
    try {
      return await this.sessionCommand(["pane", "close", paneId]);
    } catch (error) {
      if (!isPaneNotFound(error)) throw error;
    }
  }

  async closeTab(tabId) {
    try {
      return await this.sessionCommand(["tab", "close", tabId]);
    } catch (error) {
      if (!isTabNotFound(error)) throw error;
    }
  }

  async closeWorkspace(workspaceId) {
    try {
      return await this.sessionCommand(["workspace", "close", workspaceId]);
    } catch (error) {
      if (!isWorkspaceNotFound(error)) throw error;
    }
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

  async agentVisibleText(name) {
    return this.sessionCommand([
      "agent",
      "read",
      name,
      "--source",
      "visible",
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

  async prompt(name, prompt, options = {}) {
    const observedBeforeDelivery =
      options.observedBeforeDelivery ?? (await this.agentRecord(name));
    const harness = options.harness ?? observedBeforeDelivery?.agent;
    const guardsClaudeMultilineSubmission =
      harness === "claude" &&
      prompt.includes("\n") &&
      ["idle", "done"].includes(observedBeforeDelivery?.agent_status);
    const visibleBeforeDelivery = guardsClaudeMultilineSubmission
      ? await this.agentVisibleText(name)
      : undefined;
    const result = await this.sessionCommand([
      "agent",
      "prompt",
      name,
      prompt,
    ]);
    if (!guardsClaudeMultilineSubmission) {
      return result;
    }

    // Claude turns a multiline bracketed paste into an attachment token
    // asynchronously. Herdr 0.7.5 can send the submit key before that
    // conversion finishes, leaving the prompt staged while the agent remains
    // idle. Use the visible pane only to wait for a new attachment token, then
    // send one guarded submit key. Native state and transcript correlation
    // remain authoritative for turn progress and completion.
    let attachmentReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (promptSubmissionObserved(await this.agentRecord(name))) {
        return result;
      }
      attachmentReady = newClaudeAttachmentTokenObserved(
        visibleBeforeDelivery,
        await this.agentVisibleText(name),
      );
      if (attachmentReady) break;
      await this.delay(25);
    }
    if (!attachmentReady) {
      throw new DrovrError(
        `Herdr did not expose Claude's staged multiline attachment for ${name}`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    await this.sessionCommand(["agent", "send-keys", name, "enter"]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await this.agentRecord(name);
      if (promptSubmissionObserved(observed)) {
        return result;
      }
      await this.delay(25);
    }
    throw new DrovrError(
      `Herdr did not confirm Claude prompt submission for ${name}`,
      { code: 4, outcome: "adapter_failure" },
    );
  }

  async interruptAgent(name) {
    return this.sessionCommand(["agent", "send-keys", name, "ctrl-c"]);
  }

  async waitForAgent(name, timeoutMs) {
    const current = await this.agentRecord(name);
    if (["idle", "done", "blocked"].includes(current?.agent_status)) {
      return current;
    }
    const args = ["agent", "wait", name];
    if (timeoutMs !== undefined) {
      args.push("--timeout", String(timeoutMs));
    }
    let output;
    try {
      output = await this.sessionCommand(args);
    } catch (error) {
      if (isTimeout(error)) return { drovr_status: "still_running" };
      if (isAgentNotFound(error)) return { drovr_status: "agent_lost" };
      throw error;
    }
    const observed = parseJson(output, "agent wait").result?.agent;
    if (observed) return observed;
    return this.agentRecord(name);
  }
}

function withoutCallerHerdrContext(env) {
  const sanitized = { ...env };
  for (const name of [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
  ]) {
    delete sanitized[name];
  }
  return sanitized;
}

function promptSubmissionObserved(observed) {
  return ["working", "blocked"].includes(observed?.agent_status);
}

function newClaudeAttachmentTokenObserved(before, after) {
  const beforeCounts = claudeAttachmentTokenCounts(before);
  for (const [token, count] of claudeAttachmentTokenCounts(after)) {
    if (count > (beforeCounts.get(token) ?? 0)) return true;
  }
  return false;
}

function claudeAttachmentTokenCounts(text) {
  const counts = new Map();
  for (const match of String(text).matchAll(
    /\[Pasted text #\d+(?: [^\]\r\n]*)?\]/gu,
  )) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

function isTimeout(error) {
  const adapterOutput = adapterFailureOutput(error);
  return /"code"\s*:\s*"timeout"|timed? out/iu.test(adapterOutput);
}

function isAgentPaneBusy(error) {
  const adapterOutput = adapterFailureOutput(error);
  return /"code"\s*:\s*"agent_pane_busy"/u.test(adapterOutput);
}

function isAgentNotFound(error) {
  const adapterOutput = adapterFailureOutput(error);
  return /"code"\s*:\s*"agent_not_found"/u.test(adapterOutput);
}

function isPaneNotFound(error) {
  const adapterOutput = adapterFailureOutput(error);
  return /"code"\s*:\s*"pane_not_found"/u.test(adapterOutput);
}

function isTabNotFound(error) {
  const adapterOutput = adapterFailureOutput(error);
  return /"code"\s*:\s*"tab_not_found"/u.test(adapterOutput);
}

function isWorkspaceNotFound(error) {
  const adapterOutput = adapterFailureOutput(error);
  return /"code"\s*:\s*"workspace_not_found"/u.test(adapterOutput);
}

function adapterFailureOutput(error) {
  return [
    error.adapterFailure?.stdout,
    error.adapterFailure?.stderr,
  ]
    .filter(Boolean)
    .join("\n");
}

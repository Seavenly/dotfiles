import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { claudeAgentArguments } from "./claude.mjs";
import { codexAgentArguments } from "./codex.mjs";
import { DrovrError } from "./errors.mjs";
import { HERDR_OBSERVATION_TIMEOUT_MS } from "./limits.mjs";
import { execute } from "./process.mjs";
import { createStagedInputReceipt } from "./staged-input-receipt.mjs";
import {
  createTraceJournal,
  redactPaneSnapshot,
  traceOperation,
  traceRequest,
} from "./trace.mjs";

// A status-only fast-completion escape is safe only for short literal input;
// longer single-line prompts must expose either their literal text or an
// attachment token before Drovr sends the submit key.
const CLAUDE_SHORT_LITERAL_PROMPT_MAX_LENGTH = 256;

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
    trace,
  } = {}) {
    this.session = session;
    this.run = run;
    this.env = withoutCallerHerdrContext(env);
    this.trace = trace ??
      (this.env.DROVR_TRACE_JOURNAL
        ? createTraceJournal(this.env.DROVR_TRACE_JOURNAL)
        : null);
    this.delay = async (milliseconds) => {
      await this.recordTrace({
        kind: "delay",
        operation: "clock.delay",
        payload: { duration_ms: milliseconds },
      });
      return delay(milliseconds);
    };
  }

  async sessionCommand(args, options = {}) {
    const operation = traceOperation(args);
    try {
      const output = await this.run("herdr", ["--session", this.session, ...args], {
        env: this.env,
        ...options,
      });
      await this.recordCommand(operation, output, args);
      return output;
    } catch (error) {
      await this.recordError(operation, error, args);
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

  async recordCommand(operation, output, args = []) {
    if (!this.trace) return;
    if (operation.startsWith("agent.read.")) {
      await this.recordTrace({
        kind: "pane_snapshot",
        operation,
        payload: {
          request: traceRequest(args),
          text: redactPaneSnapshot(output),
        },
      });
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(output);
    } catch {
      envelope = { raw: output };
    }
    const kind = ["agent.list", "agent.wait"].includes(operation)
      ? "agent_observation"
      : "command_result";
    await this.recordTrace({
      kind,
      operation,
      payload: { request: traceRequest(args), envelope },
    });
  }

  async recordError(operation, error, args = []) {
    const capturedError = {
      code: error.code ?? "adapter_failure",
      outcome: error.outcome ?? "adapter_failure",
      message: error.message,
    };
    if (typeof error.stdout === "string") capturedError.stdout = error.stdout;
    if (typeof error.stderr === "string") capturedError.stderr = error.stderr;
    if (typeof error.stderr === "string") {
      try {
        const envelope = JSON.parse(error.stderr);
        if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
          capturedError.envelope = envelope;
        }
      } catch {
        // Preserve the sanitized stderr text when Herdr did not return JSON.
      }
    }
    await this.recordTrace({
      kind: "error",
      operation,
      payload: {
        error: capturedError,
        request: traceRequest(args),
      },
    });
  }

  async recordTrace(event) {
    try {
      await this.trace?.record(event);
    } catch {
      // Trace capture is observational. A recorder failure must not turn a
      // successful native command into a Herdr failure or poison later calls.
    }
  }

  async observationCommand(args) {
    return this.sessionCommand(args, {
      timeout: HERDR_OBSERVATION_TIMEOUT_MS,
    });
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
      await this.delay(25);
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
        timeout: HERDR_OBSERVATION_TIMEOUT_MS,
      });
      await this.recordCommand("session.list", output, ["session", "list", "--json"]);
    } catch (error) {
      await this.recordError("session.list", error, ["session", "list", "--json"]);
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
      await this.observationCommand(["pane", "get", paneId]),
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
        await this.delay(50);
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
        output = await this.observationCommand([
          "pane",
          "process-info",
          "--pane",
          paneId,
        ]);
      } catch (error) {
        if (!isPaneNotFound(error)) throw error;
        await this.delay(50);
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
      await this.delay(50);
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
      await this.observationCommand(["agent", "list"]),
      "agent list",
    ).result;
    return result?.agents ?? [];
  }

  async paneProcessInfo(paneId) {
    return parseJson(
      await this.observationCommand([
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
        await this.observationCommand(["pane", "get", paneId]),
        "pane get",
      ).result?.pane;
    } catch (error) {
      if (isPaneNotFound(error)) return null;
      throw error;
    }
  }

  async paneLayout(paneId) {
    const layout = parseJson(
      await this.observationCommand(["pane", "layout", "--pane", paneId]),
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
        await this.observationCommand(["tab", "get", tabId]),
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
        await this.observationCommand(["workspace", "get", workspaceId]),
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

  async agentExcerpt(name, { nativeSession } = {}) {
    if (typeof nativeSession === "string") {
      assertNativeSession(name, await this.agentRecord(name), nativeSession);
    }
    return this.observationCommand([
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
    return this.observationCommand([
      "agent",
      "read",
      name,
      "--source",
      "visible",
      "--format",
      "text",
    ]);
  }

  async sendPaneText(paneId, text) {
    return this.sessionCommand(["pane", "send-text", paneId, text]);
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
    if (typeof options.nativeSession === "string") {
      assertNativeSession(name, observedBeforeDelivery, options.nativeSession);
    }
    const harness = options.harness ?? observedBeforeDelivery?.agent;
    const guardsClaudeStagedSubmission =
      harness === "claude" &&
      ["idle", "done"].includes(observedBeforeDelivery?.agent_status);
    const visibleBeforeDelivery = guardsClaudeStagedSubmission
      ? await this.agentVisibleText(name)
      : undefined;
    if (claudePromptBoxHasStagedInput(visibleBeforeDelivery)) {
      throw new DrovrError(
        `Claude already has staged prompt text for ${name}; inspect or clear it through drovr attach before starting another turn`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const result = await this.sessionCommand([
      "agent",
      "prompt",
      name,
      prompt,
    ]);
    if (!guardsClaudeStagedSubmission) {
      return result;
    }

    // Claude can turn multiline and long single-line bracketed pastes into an
    // attachment token asynchronously. Herdr 0.7.5 can send the submit key
    // before that conversion finishes, leaving the prompt staged while the
    // agent remains idle. Use the visible pane only to wait through attachment
    // conversion or confirm literal single-line staging, then send one guarded
    // submit key. Native state and transcript correlation remain authoritative
    // for progress and completion.
    let attachmentReady = false;
    let literalPromptReady = false;
    let noAttachmentPolls = 0;
    let stagedAfterDelivery;
    let observedAfterDelivery;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      observedAfterDelivery = await this.agentRecord(name);
      if (promptSubmissionObserved(observedAfterDelivery)) {
        return result;
      }
      const visibleAfterDelivery = await this.agentVisibleText(name);
      attachmentReady = newClaudeAttachmentTokenObserved(
        visibleBeforeDelivery,
        visibleAfterDelivery,
      );
      literalPromptReady ||=
        !prompt.includes("\n") &&
        newClaudeLiteralPromptObserved(
          visibleBeforeDelivery,
          visibleAfterDelivery,
          prompt,
        );
      if (literalPromptReady) {
        const snapshot = claudePromptBoxSnapshot(visibleAfterDelivery);
        if (snapshot?.display_text === prompt) {
          stagedAfterDelivery = snapshot;
        }
      }
      if (attachmentReady || literalPromptReady) break;
      noAttachmentPolls += 1;
      if (
        noAttachmentPolls >= 2 &&
        prompt.length <= CLAUDE_SHORT_LITERAL_PROMPT_MAX_LENGTH &&
        !prompt.includes("\n") &&
        promptCompletionObserved(observedBeforeDelivery, observedAfterDelivery)
      ) {
        return result;
      }
      await this.delay(25);
    }
    if (!attachmentReady && !literalPromptReady) {
      // A short prompt can complete before the first post-delivery poll. A
      // new done observation proves that the native agent transitioned, while
      // the exact transcript remains completion authority.
      if (
        prompt.length <= CLAUDE_SHORT_LITERAL_PROMPT_MAX_LENGTH &&
        !prompt.includes("\n") &&
        promptCompletionObserved(observedBeforeDelivery, observedAfterDelivery)
      ) {
        return result;
      }
      throw new DrovrError(
        `Herdr did not expose Claude's staged attachment for ${name}`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    await this.sessionCommand(["agent", "send-keys", name, "enter"]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await this.agentRecord(name);
      if (
        promptSubmissionObserved(observed) ||
        promptCompletionObserved(observedBeforeDelivery, observed)
      ) {
        return result;
      }
      await this.delay(25);
    }
    throw new DrovrError(
      `Herdr did not confirm Claude prompt submission for ${name}`,
      {
        code: 4,
        outcome: "adapter_failure",
        ...(stagedAfterDelivery
          ? {
              details: {
                staged_input: createStagedInputReceipt({
                  agentName: name,
                  observed: observedBeforeDelivery,
                  prompt,
                  snapshot: stagedAfterDelivery,
                }),
              },
            }
          : {}),
      },
    );
  }

  async inspectStagedInput(name, { harness } = {}) {
    if (harness !== "claude") return null;
    return claudePromptBoxSnapshot(await this.agentVisibleText(name));
  }

  async recoverStagedInput(
    name,
    { action, harness, nativeSession, token } = {},
  ) {
    if (harness !== "claude" || !["clear", "submit"].includes(action)) {
      throw new DrovrError("unsupported staged-input recovery action", {
        code: 2,
        outcome: "invalid_arguments",
      });
    }
    const observedBefore = await this.agentRecord(name);
    if (
      !observedBefore ||
      !["idle", "done"].includes(observedBefore.agent_status)
    ) {
      throw new DrovrError(`Claude agent ${name} is not settled`, {
        code: 0,
        outcome: "task_busy",
      });
    }
    if (
      nativeSession &&
      observedBefore.agent_session?.value !== nativeSession
    ) {
      throw new DrovrError(`Claude identity changed for ${name}`, {
        code: 0,
        outcome: "recovery_blocked",
      });
    }
    const staged = await this.inspectStagedInput(name, { harness });
    if (!staged || staged.token !== token) {
      throw new DrovrError(`Claude staged input changed for ${name}`, {
        code: 0,
        outcome: "recovery_blocked",
      });
    }
    const recoveryKeys = action === "submit" ? ["enter"] : ["esc", "esc"];
    await this.sessionCommand([
      "agent",
      "send-keys",
      name,
      ...recoveryKeys,
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await this.agentRecord(name);
      if (
        nativeSession &&
        observed?.agent_session?.value !== nativeSession
      ) {
        throw new DrovrError(`Claude identity changed for ${name}`, {
          code: 0,
          outcome: "recovery_blocked",
        });
      }
      if (action === "clear") {
        if (
          observed &&
          ["idle", "done"].includes(observed.agent_status) &&
          (!nativeSession || observed.agent_session?.value === nativeSession) &&
          !(await this.inspectStagedInput(name, { harness }))
        ) {
          return observed;
        }
        await this.delay(25);
        continue;
      }
      if (
        promptSubmissionObserved(observed) ||
        promptCompletionObserved(observedBefore, observed)
      ) {
        return observed;
      }
      await this.delay(25);
    }
    throw new DrovrError(
      `Herdr did not confirm Claude staged-input ${action} for ${name}`,
      { code: 4, outcome: "adapter_failure" },
    );
  }

  async interruptAgent(name) {
    return this.sessionCommand(["agent", "send-keys", name, "ctrl+c"]);
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

function assertNativeSession(name, observed, expected) {
  if (observed?.agent_session?.value === expected) return;
  const observedSession = observed?.agent_session?.value;
  const identityObserved =
    typeof observedSession === "string" && observedSession.length > 0;
  throw new DrovrError(
    identityObserved
      ? `Herdr native session changed for ${name}`
      : `Herdr did not report a native session for ${name}`,
    {
      code: 0,
      outcome: identityObserved ? "recovery_blocked" : "uncertain",
    },
  );
}

function promptCompletionObserved(before, after) {
  if (after?.agent_status !== "done") return false;
  return (
    before?.agent_status !== after.agent_status ||
    before?.state_change_seq !== after.state_change_seq
  );
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

function claudePromptBoxHasStagedInput(text) {
  return claudePromptBoxSnapshot(text) !== null;
}

function claudePromptBoxSnapshot(text) {
  const lines = String(text).split(/\r?\n/u);
  const dividers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*[─━-]{3,}\s*$/u.test(lines[index])) dividers.push(index);
  }
  if (dividers.length < 2) return null;
  const region = lines.slice(dividers.at(-2) + 1, dividers.at(-1));
  const promptLine = region.findIndex((line) => /^\s*❯/u.test(line));
  if (promptLine < 0) return null;
  const promptText = [
    region[promptLine].replace(/^\s*❯[ \u00a0]?/u, ""),
    ...region.slice(promptLine + 1),
  ].join("\n");
  if (promptText.trim().length === 0) return null;
  const displayText = promptText.trimEnd();
  return {
    token: createHash("sha256").update(displayText).digest("hex"),
    display_text: displayText,
  };
}

function newClaudeLiteralPromptObserved(before, after, prompt) {
  const compactBefore = compactTerminalText(before);
  const compactAfter = compactTerminalText(after);
  const compactPrompt = compactTerminalText(prompt);
  if (compactPrompt.length === 0) return false;
  const chunkLength = Math.min(32, compactPrompt.length);
  const offsets = new Set([
    0,
    Math.max(0, Math.floor((compactPrompt.length - chunkLength) / 2)),
    Math.max(0, compactPrompt.length - chunkLength),
  ]);
  for (const offset of offsets) {
    const chunk = compactPrompt.slice(offset, offset + chunkLength);
    if (compactAfter.includes(chunk) && !compactBefore.includes(chunk)) {
      return true;
    }
  }
  return false;
}

function compactTerminalText(text) {
  return String(text).replace(/\s/gu, "");
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

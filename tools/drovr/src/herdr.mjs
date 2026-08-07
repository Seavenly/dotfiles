import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

import { claudeAgentArguments } from "./claude.mjs";
import { codexAgentArguments } from "./codex.mjs";
import { DrovrError } from "./errors.mjs";
import { HERDR_OBSERVATION_TIMEOUT_MS } from "./limits.mjs";
import {
  MANAGED_PANE_IDENTITY_SCHEMA,
} from "./compatibility.mjs";
import { digestCanonical } from "./canonical-json.mjs";
import { execute } from "./process.mjs";
import {
  MANAGED_RUNTIME_OBSERVATION_FIELDS,
} from "./managed-runtime-identity.mjs";
import {
  processEnvironmentPath,
  processExecutablePath,
} from "./process-identity.mjs";
import {
  createStagedInputReceipt,
  stagedInputTextToken,
} from "./staged-input-receipt.mjs";
import {
  createTraceJournal,
  redactPaneSnapshot,
  traceOperation,
  traceRequest,
} from "./trace.mjs";

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
    if (operation.startsWith("agent.read.") || operation === "pane.read") {
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

  async paneRead(
    paneId,
    { source = "recent-unwrapped", lines = 40, format = "text" } = {},
  ) {
    const args = [
      "pane",
      "read",
      paneId,
      "--source",
      source,
      "--lines",
      String(lines),
      "--format",
      format,
    ];
    return this.observationCommand(args);
  }

  async probeManagedExecutable({ paneId, harness }) {
    assertSupportedHarness(harness);
    await this.waitForShell(paneId);
    const marker = `DROVR_RUNTIME_ID_${randomUUID().replaceAll("-", "")}`;
    const command = managedExecutableProbeCommand(marker, harness);
    await this.sessionCommand(["pane", "run", paneId, command]);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const output = await this.paneRead(paneId, {
        source: "recent-unwrapped",
        lines: 80,
      });
      const fields = managedExecutableProbeFields(output, marker);
      if (fields) {
        const identity = await managedExecutableIdentity({
          harness,
          paneId,
          observedPath: fields.observedPath,
          version: fields.version,
          managedPath: fields.managedPath,
        });
        identity.integration = await currentManagedIntegration(harness, this);
        return identity;
      }
      await this.delay(25);
    }
    throw managedIdentityError(
      `Herdr did not expose the ${harness} managed executable identity`,
      "missing",
    );
  }

  async captureManagedRuntimeIdentity({
    agentName,
    paneId,
    harness,
    executable,
    model,
    effort,
  }) {
    assertSupportedHarness(harness);
    const observed = await this.agentRecord(agentName);
    if (!observed) {
      throw managedIdentityError(
        "Herdr did not report the managed agent runtime identity",
        "missing",
      );
    }
    if (observed.pane_id !== paneId) {
      throw managedIdentityError(
        "Herdr managed pane identity changed",
        "changed",
      );
    }
    const nativeSession = observed.agent_session?.value;
    if (!nativeSession) {
      throw managedIdentityError(
        "Herdr did not report a native session identity",
        "missing",
      );
    }
    const processInfo = await this.paneProcessInfo(paneId);
    const process = await nativeProcessIdentity(
      processInfo,
      harness,
      executable,
      this,
    );
    if (!process) {
      throw managedIdentityError(
        `Herdr did not expose the ${harness} managed process identity`,
        "missing",
      );
    }
    const managedPath = await managedPanePath(processInfo, process, this);
    if (!managedPath) {
      throw managedIdentityError(
        "Herdr did not expose the managed PATH",
        "missing",
      );
    }
    const managedPathDigest = digestCanonical(managedPath);
    if (
      executable.managed_path_digest &&
      executable.managed_path_digest !== managedPathDigest
    ) {
      throw managedIdentityError(
        "managed PATH changed",
        "changed",
      );
    }
    const currentExecutable = await currentExecutableIdentity(executable, this);
    const integration = await currentManagedIntegration(harness, this);
    const identity = {
      ...structuredClone(executable),
      schema: MANAGED_PANE_IDENTITY_SCHEMA,
      harness,
      managed_agent: agentName,
      pane_id: paneId,
      executable: currentExecutable,
      managed_path_digest: managedPathDigest,
      integration,
      native_session: nativeSession,
      process,
      caller_path_digest: digestCanonical(String(this.env.PATH ?? "")),
      model: model ?? null,
      effort: effort ?? null,
    };
    await this.recordTrace({
      kind: "agent_observation",
      operation: "agent.runtime-identity",
      payload: {
        request: {
          resource: "agent",
          action: "runtime-identity",
          target: agentName,
        },
        managed_runtime_identity: identity,
      },
    });
    return identity;
  }

  async observeManagedRuntime({
    agentName,
    expectedIdentity,
    harness,
    model,
    effort,
  }) {
    if (!expectedIdentity?.pane_id || !expectedIdentity.executable) {
      throw managedIdentityError(
        "managed runtime identity is missing",
        "missing",
      );
    }
    const observed = await this.captureManagedRuntimeIdentity({
      agentName,
      paneId: expectedIdentity.pane_id,
      harness,
      executable: expectedIdentity,
      model: model ?? expectedIdentity.model,
      effort: effort ?? expectedIdentity.effort,
    });
    assertManagedRuntimeIdentity(expectedIdentity, observed);
    return observed;
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

  async sendPaneText(paneId, text, { agentName, nativeSession } = {}) {
    if (agentName) {
      const observed = await this.agentRecord(agentName);
      if (nativeSession !== undefined) {
        assertNativeSession(agentName, observed, nativeSession);
      }
      if (observed?.pane_id !== paneId) {
        throw new DrovrError(`Herdr managed pane changed for ${agentName}`, {
          code: 0,
          outcome: "recovery_blocked",
        });
      }
    }
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
    if (
      options.paneId !== undefined &&
      options.paneId !== null &&
      observedBeforeDelivery?.pane_id !== options.paneId
    ) {
      throw new DrovrError(`Herdr managed pane changed for ${name}`, {
        code: 0,
        outcome: "recovery_blocked",
      });
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
    if (!guardsClaudeStagedSubmission) return result;

    // Herdr 0.8 owns Claude's paste conversion and submission timing. Wait
    // for that native submission before using the explicit Enter fallback
    // required by older Herdr integrations. The grace period is deliberately
    // longer than Herdr's delayed-submit window so Drovr cannot race its own
    // submit gesture and leave the prompt staged after a successful turn.
    let attachmentObserved = false;
    let stagedAfterDelivery;
    let observedAfterDelivery;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      observedAfterDelivery = await this.agentRecord(name);
      if (
        promptSubmissionObserved(observedAfterDelivery) ||
        promptCompletionObserved(observedBeforeDelivery, observedAfterDelivery)
      ) {
        return result;
      }
      const visibleAfterDelivery = await this.agentVisibleText(name);
      attachmentObserved ||=
        newClaudeAttachmentTokenObserved(
          visibleBeforeDelivery,
          visibleAfterDelivery,
        );
      const staged = claudePromptBoxSnapshot(visibleAfterDelivery);
      if (staged?.display_text === prompt) {
        stagedAfterDelivery = staged;
        attachmentObserved = true;
      }
      await this.delay(25);
    }
    if (!attachmentObserved) {
      throw new DrovrError(
        `Herdr did not expose Claude's staged attachment for ${name}`,
        { code: 4, outcome: "adapter_failure" },
      );
    }
    const observedBeforeSubmit = await this.agentRecord(name);
    if (typeof options.nativeSession === "string") {
      assertNativeSession(name, observedBeforeSubmit, options.nativeSession);
    }
    if (
      options.paneId !== undefined &&
      options.paneId !== null &&
      observedBeforeSubmit?.pane_id !== options.paneId
    ) {
      throw new DrovrError(`Herdr managed pane changed for ${name}`, {
        code: 0,
        outcome: "recovery_blocked",
      });
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
    { action, harness, nativeSession, paneId, token, transitionToken } = {},
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
    if (
      paneId !== undefined &&
      paneId !== null &&
      observedBefore.pane_id !== paneId
    ) {
      throw new DrovrError(`Herdr managed pane changed for ${name}`, {
        code: 0,
        outcome: "recovery_blocked",
      });
    }
    if (
      !Number.isSafeInteger(transitionToken) ||
      observedBefore.state_change_seq !== transitionToken
    ) {
      throw new DrovrError(`Claude staged input changed for ${name}`, {
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
      if (
        paneId !== undefined &&
        paneId !== null &&
        observed?.pane_id !== paneId
      ) {
        throw new DrovrError(`Herdr managed pane changed for ${name}`, {
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

  async interruptAgent(name, { nativeSession, paneId } = {}) {
    if (nativeSession !== undefined || paneId !== undefined) {
      const observed = await this.agentRecord(name);
      if (nativeSession !== undefined) {
        assertNativeSession(name, observed, nativeSession);
      }
      if (paneId !== undefined && observed?.pane_id !== paneId) {
        throw new DrovrError(`Herdr managed pane changed for ${name}`, {
          code: 0,
          outcome: "recovery_blocked",
        });
      }
    }
    return this.sessionCommand(["agent", "send-keys", name, "ctrl+c"]);
  }

  async waitForAgent(name, timeoutMs) {
    const current = await this.agentRecord(name);
    if (["idle", "done", "blocked"].includes(current?.agent_status)) {
      return current;
    }
    const args = ["agent", "wait", name];
    if (timeoutMs !== undefined) {
      args.push("--timeout", String(Math.max(1, Math.floor(timeoutMs))));
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

function assertSupportedHarness(harness) {
  if (harness === "codex" || harness === "claude") return;
  throw new DrovrError(`unsupported native harness: ${harness}`, {
    code: 2,
    outcome: "invalid_arguments",
  });
}

function managedExecutableProbeCommand(marker, harness) {
  // The harness value is restricted by assertSupportedHarness. The command is
  // emitted into the managed pane so command lookup, version, and PATH all
  // come from the shell Herdr will use for the native agent.
  return [
    `printf '%s\\t%s\\t%s\\t%s\\n' '${marker}'`,
    `"$(command -v ${harness} 2>/dev/null || true)"`,
    `"$(${harness} --version 2>/dev/null | sed -n '1p')"`,
    `"$PATH"`,
  ].join(" ");
}

function managedExecutableProbeFields(output, marker) {
  const line = String(output ?? "")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${marker}\t`));
  if (!line) return null;
  const [observedPath, version, ...pathParts] = line
    .slice(marker.length + 1)
    .split("\t");
  const managedPath = pathParts.join("\t");
  if (!observedPath || !version || !managedPath || managedPath.includes("\t")) {
    return null;
  }
  return {
    observedPath: observedPath.trim(),
    version: version.trim(),
    managedPath,
  };
}

async function managedExecutableIdentity({
  harness,
  paneId,
  observedPath,
  version,
  managedPath,
}) {
  if (!observedPath.startsWith("/")) {
    throw managedIdentityError(
      `managed ${harness} executable path is not absolute: ${observedPath}`,
      "unqualified",
    );
  }
  let canonicalPath;
  let fileIdentity;
  try {
    canonicalPath = await realpath(observedPath);
    fileIdentity = await executableFileIdentity(canonicalPath);
  } catch (error) {
    throw managedIdentityError(
      `managed ${harness} executable identity could not be resolved: ${error.message}`,
      "missing",
    );
  }
  return {
    schema: MANAGED_PANE_IDENTITY_SCHEMA,
    harness,
    managed_agent: null,
    pane_id: paneId,
    executable: {
      observed_path: observedPath,
      canonical_path: canonicalPath,
      version,
      file_identity: fileIdentity,
    },
    managed_path_digest: digestCanonical(managedPath),
    native_session: null,
    process: null,
    model: null,
    effort: null,
  };
}

async function currentExecutableIdentity(identity, client) {
  let observedCanonicalPath;
  try {
    observedCanonicalPath = await realpath(identity.executable.observed_path);
  } catch (error) {
    throw managedIdentityError(
      `managed executable path ${identity.executable.observed_path} is no longer resolvable: ${error.message}`,
      "changed",
    );
  }
  if (observedCanonicalPath !== identity.executable.canonical_path) {
    throw managedIdentityError(
      `managed executable symlink changed for ${identity.executable.observed_path}`,
      "changed",
    );
  }
  const canonicalPath = identity.executable.canonical_path;
  let fileIdentity;
  try {
    fileIdentity = await executableFileIdentity(canonicalPath);
  } catch (error) {
    throw managedIdentityError(
      `managed executable ${canonicalPath} is no longer available: ${error.message}`,
      "changed",
    );
  }
  let version;
  try {
    const output = await client.run(canonicalPath, ["--version"], {
      env: client.env,
    });
    version = String(output).trim().split(/\r?\n/u)[0];
  } catch (error) {
    throw managedIdentityError(
      `managed executable ${canonicalPath} could not report its version: ${error.message}`,
      "changed",
    );
  }
  if (!version) {
    throw managedIdentityError(
      `managed executable ${canonicalPath} returned no version`,
      "changed",
    );
  }
  if (
    !identity.executable.file_identity ||
    digestCanonical(fileIdentity) !==
      digestCanonical(identity.executable.file_identity)
  ) {
    throw managedIdentityError(
      `managed executable ${canonicalPath} file identity changed`,
      "changed",
    );
  }
  if (version !== identity.executable.version) {
    throw managedIdentityError(
      `managed executable ${canonicalPath} version changed`,
      "changed",
    );
  }
  return {
    ...structuredClone(identity.executable),
    canonical_path: canonicalPath,
    version,
    file_identity: fileIdentity,
  };
}

async function executableFileIdentity(path) {
  const metadata = await stat(path);
  const device = Number(metadata.dev);
  const inode = Number(metadata.ino);
  const size = Number(metadata.size);
  if (
    !Number.isSafeInteger(device) ||
    !Number.isSafeInteger(inode) ||
    !Number.isSafeInteger(size) ||
    !Number.isFinite(metadata.mtimeMs)
  ) {
    throw new Error(`file metadata for ${path} is not lossless JSON`);
  }
  return {
    device,
    inode,
    size,
    mtime_ms: metadata.mtimeMs,
  };
}

async function nativeProcessIdentity(processInfo, harness, executable, client) {
  const candidates = Array.isArray(processInfo?.foreground_processes)
    ? processInfo.foreground_processes
    : Array.isArray(processInfo?.foregroundProcesses)
      ? processInfo.foregroundProcesses
      : [];
  const matches = candidates.filter((candidate) => {
    const argv = Array.isArray(candidate?.argv)
      ? candidate.argv.map((value) => String(value))
      : [];
    const argv0 = candidate?.argv0 ?? argv[0];
    const values = [
      candidate?.name,
      argv0,
    ]
      .filter(Boolean)
      .map((value) => executableName(value));
    return values.some((value) => value === harness);
  });
  if (matches.length !== 1) return null;
  const candidate = matches[0];
  const argv = Array.isArray(candidate.argv)
    ? candidate.argv.map((value) => String(value))
    : [];
  const argv0 = candidate.argv0 ?? argv[0];
  const cmdline = candidate.cmdline ?? argv.join(" ");
  const cwd = candidate.cwd;
  if (
    !Number.isSafeInteger(candidate.pid) ||
    !candidate.name ||
    !argv0 ||
    argv.length === 0 ||
    !cmdline ||
    !cwd
  ) {
    return null;
  }
  const executablePaths = new Set([
    executable?.executable?.observed_path,
    executable?.executable?.canonical_path,
  ].filter(Boolean));
  const processPath = await processExecutablePath(
    candidate,
    executablePaths,
    client,
  );
  if (!processPath || !executablePaths.has(processPath)) return null;
  return {
    pid: candidate.pid,
    name: String(candidate.name),
    argv0: String(argv0),
    argv,
    cmdline: String(cmdline),
    cwd: String(cwd),
  };
}

function executableName(value) {
  return String(value)
    .split(/[\\/]/u)
    .at(-1)
    .replace(/\.exe$/iu, "")
    .toLowerCase();
}

async function managedPanePath(processInfo, process, client) {
  const foregroundProcesses = Array.isArray(processInfo?.foreground_processes)
    ? processInfo.foreground_processes
    : Array.isArray(processInfo?.foregroundProcesses)
      ? processInfo.foregroundProcesses
      : [];
  const processRecord = foregroundProcesses.find(
    (candidate) => candidate?.pid === process?.pid,
  );
  const candidates = [
    processRecord?.environment?.PATH,
    processRecord?.environment?.path,
    processRecord?.env?.PATH,
    processRecord?.env?.path,
    process?.environment?.PATH,
    process?.environment?.path,
    process?.env?.PATH,
    process?.env?.path,
  ];
  const direct = candidates.find(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (direct) return direct;
  return processEnvironmentPath(process.pid, client, {
    commandLine: process.cmdline,
  });
}

async function currentManagedIntegration(harness, client) {
  let output;
  try {
    output = await client.run("herdr", ["integration", "status"], {
      env: client.env,
    });
  } catch (error) {
    throw managedIdentityError(
      `Herdr integration status could not be observed: ${error.message}`,
      "missing",
    );
  }
  const match = String(output).match(
    new RegExp(`^${harness}: current \\(v(\\d+)\\)`, "mu"),
  );
  if (!match) {
    throw managedIdentityError(
      `${harness} Herdr integration is not current`,
      "missing",
    );
  }
  return `herdr-${harness}/v${match[1]}`;
}

function assertManagedRuntimeIdentity(expected, observed) {
  const fields = MANAGED_RUNTIME_OBSERVATION_FIELDS.filter((field) =>
    Object.hasOwn(expected, field) &&
    expected[field] !== null &&
    expected[field] !== undefined
  );
  const mismatches = fields
    .filter((field) => !sameIdentityValue(expected[field], observed?.[field]))
    .map((field) => ({
      field: `managed_pane_identity.${field}`,
      expected: expected[field],
      observed: observed?.[field],
      reason: "changed",
    }));
  if (mismatches.length === 0) return;
  const error = managedIdentityError(
    "managed runtime identity differs from its launch binding",
    "changed",
  );
  error.details.expected = expected;
  error.details.observed = observed;
  error.details.mismatches = mismatches;
  throw error;
}

function sameIdentityValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return digestCanonical(left) === digestCanonical(right);
}

function managedIdentityError(message, reason) {
  return new DrovrError(message, {
    code: 0,
    outcome: "compatibility_blocked",
    details: {
      reason,
      legal_actions: ["refresh_compatibility", "run_drovr_doctor"],
    },
  });
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
    token: stagedInputTextToken(displayText),
    display_text: displayText,
  };
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

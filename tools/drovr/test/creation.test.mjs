import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startAgent } from "../src/agent-start.mjs";
import {
  loadConfiguration,
  resolveLaunchSpecification,
} from "../src/config.mjs";
import {
  readRecords,
  stateDirectory,
  writeRecord,
} from "../src/registry.mjs";
import { openTask } from "../src/task-open.mjs";
import { closeTask } from "../src/lifecycle.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("Claude role instructions launch through a private durable prompt file", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-role-launch-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  const configDirectory = join(scratch, "config");
  const roleDirectory = join(configDirectory, "roles", "shell-reviewer");
  const stateHome = join(scratch, "state");
  const instructions = [
    "Review the requested change.",
    "Preserve shell text literally: $HOME; 'single' \"double\" $(literal) && pipe | glob *.",
  ].join("\n");
  await mkdir(cwd);
  await cp(join(root, "config", "drovr"), configDirectory, { recursive: true });
  await mkdir(roleDirectory, { recursive: true });
  await writeFile(
    join(roleDirectory, "role.toml"),
    [
      'schema = "drovr.role/v1"',
      "",
      "[defaults]",
      'harness = "claude"',
      'capability = "read-only"',
      "",
    ].join("\n"),
  );
  await writeFile(join(roleDirectory, "instructions.md"), `${instructions}\n`);
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    DROVR_CONFIG_DIR: configDirectory,
  };
  let started = false;
  let startArguments;
  const run = async (file, args) => {
    if (file === "claude") {
      return "--model --effort --permission-mode dontAsk --allowedTools --append-system-prompt-file";
    }
    assert.equal(file, "herdr");
    if (args[0] === "session") {
      return JSON.stringify({ sessions: [{ name: "delegates", running: true }] });
    }
    const command = args.slice(2);
    if (command[0] === "workspace" && command[1] === "create") {
      return JSON.stringify({
        result: {
          workspace: { workspace_id: "workspace-1" },
          root_pane: { pane_id: "pane-1" },
        },
      });
    }
    if (command[0] === "pane" && command[1] === "get") {
      return JSON.stringify({
        result: { pane: { pane_id: "pane-1", tab_id: "tab-1" } },
      });
    }
    if (
      (command[0] === "tab" || command[0] === "pane") &&
      command[1] === "rename"
    ) {
      return JSON.stringify({ result: {} });
    }
    if (command[0] === "pane" && command[1] === "process-info") {
      return JSON.stringify({
        result: {
          process_info: {
            shell_pid: 10,
            foreground_processes: [{ pid: 10, name: "zsh" }],
          },
        },
      });
    }
    if (command[0] === "agent" && command[1] === "start") {
      startArguments = command;
      started = true;
      return JSON.stringify({ result: { agent: { name: command[2] } } });
    }
    if (command[0] === "agent" && command[1] === "list") {
      return JSON.stringify({
        result: {
          agents: started
            ? [
                {
                  name: startArguments[2],
                  pane_id: "pane-1",
                  agent_status: "idle",
                  agent_session: { value: "native-claude-1" },
                },
              ]
            : [],
        },
      });
    }
    throw new Error(`unexpected command: ${command.join(" ")}`);
  };
  const dependencies = { env, run, delay: async () => {} };
  const opened = await openTask(
    { group: "role-launch", key: "task", cwd },
    dependencies,
  );

  await startAgent(
    opened.task.id,
    { key: "reviewer", role: "shell-reviewer" },
    dependencies,
  );

  const separator = startArguments.indexOf("--");
  const nativeArguments = startArguments.slice(separator + 1);
  const promptFileIndex = nativeArguments.indexOf("--append-system-prompt-file");
  assert.notEqual(promptFileIndex, -1);
  assert.equal(nativeArguments.includes("--append-system-prompt"), false);
  assert.equal(nativeArguments.includes(instructions), false);
  const promptPath = nativeArguments[promptFileIndex + 1];
  assert.equal(await readFile(promptPath, "utf8"), instructions);
  assert.equal((await stat(promptPath)).mode & 0o777, 0o600);
  assert.ok(promptPath.startsWith(join(stateHome, "drovr")));
});

test("a genuinely failed start preserves its immutable launch reservation", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-failed-reservation-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const herdr = {
    async ensureSession() {},
    async createWorkspace() {
      return {
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
      };
    },
    async renameTab() {},
    async paneRecord(paneId) {
      return { pane_id: paneId, tab_id: "tab-1" };
    },
    async startCodexAgent() {
      throw new Error("native start failed");
    },
  };
  const dependencies = { env, herdr, run: async () => "" };
  const opened = await openTask(
    { group: "failed-start", key: "task", cwd },
    dependencies,
  );

  await assert.rejects(
    () => startAgent(opened.task.id, { key: "builder" }, dependencies),
    { message: "native start failed" },
  );
  await assert.rejects(
    () =>
      startAgent(
        opened.task.id,
        { key: "builder", effort: "low" },
        dependencies,
      ),
    { outcome: "configuration_conflict" },
  );
  const [agent] = await readRecords(stateDirectory(env), "agents");
  assert.equal(agent.key, "builder");
  assert.equal(agent.native_session, null);
  assert.equal(agent.launch.effort, "high");
  assert.deepEqual(Object.keys(agent.launch_binding).sort(), [
    "comparison_key",
    "configuration_watermark",
    "schema",
  ]);
  assert.match(agent.launch_binding.comparison_key, /^sha256:[0-9a-f]{64}$/u);
  assert.match(
    agent.launch_binding.configuration_watermark,
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("agent start balances additional panes using registered task topology", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-agent-layout-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const registryDirectory = stateDirectory(env);
  const launch = resolveLaunchSpecification(await loadConfiguration({ env }), {});
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "layout",
    label: "Layout",
    inferred: false,
    status: "active",
    herdr: { session: "delegates", workspace_id: "workspace-1" },
    created_at: "2026-07-23T10:00:00.000Z",
  });
  await writeRecord(registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: "group-1",
    key: "task",
    label: "Task",
    cwd,
    status: "active",
    herdr: { tab_id: "tab-1", root_pane_id: "pane-1" },
    created_at: "2026-07-23T10:00:01.000Z",
  });
  await writeRecord(registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: "task-1",
    key: "first",
    label: "First",
    status: "active",
    launch,
    herdr: { name: "managed-first", pane_id: "pane-1" },
    native_session: "native-first",
    created_at: "2026-07-23T10:00:02.000Z",
  });
  const panes = new Map([
    ["pane-1", { pane_id: "pane-1", rect: { width: 120, height: 40 } }],
  ]);
  const splits = [];
  const started = [];
  const herdr = {
    async ensureSession() {},
    async paneLayout() {
      return { panes: [...panes.values()] };
    },
    async splitPane(options) {
      splits.push(options);
      const paneId = `pane-${panes.size + 1}`;
      for (const pane of panes.values()) {
        if (pane.pane_id !== options.paneId) continue;
        if (options.direction === "right") pane.rect.width /= 2;
        else pane.rect.height /= 2;
        panes.set(paneId, { pane_id: paneId, rect: { ...pane.rect } });
        return paneId;
      }
      throw new Error("split target was not in the task layout");
    },
    async startCodexAgent(options) {
      started.push(options);
    },
    async agentRecord(name) {
      const start = started.find((candidate) => candidate.name === name);
      return start
        ? {
            name,
            pane_id: start.paneId,
            agent_status: "idle",
            agent_session: { value: `native-${name}` },
          }
        : null;
    },
  };
  const dependencies = { env, herdr, run: async () => "" };

  const second = await startAgent(
    "task-1",
    { key: "second" },
    dependencies,
  );
  const third = await startAgent(
    "task-1",
    { key: "third" },
    dependencies,
  );

  assert.equal(second.agent.herdr.pane_id, "pane-2");
  assert.equal(third.agent.herdr.pane_id, "pane-3");
  assert.deepEqual(splits, [
    {
      paneId: "pane-1",
      direction: "right",
      ratio: 0.5,
      cwd,
    },
    {
      paneId: "pane-1",
      direction: "down",
      ratio: 0.5,
      cwd,
    },
  ]);
  assert.deepEqual(
    started.map(({ paneId }) => paneId),
    ["pane-2", "pane-3"],
  );

  panes.delete("pane-3");
  await assert.rejects(
    () => startAgent("task-1", { key: "missing-pane" }, dependencies),
    { outcome: "recovery_blocked" },
  );
  assert.equal(splits.length, 2);

  panes.set("pane-3", {
    pane_id: "pane-3",
    rect: { width: 60, height: 20 },
  });
  third.agent.herdr.pane_id = "pane-2";
  await writeRecord(registryDirectory, "agents", third.agent);
  await assert.rejects(
    () => startAgent("task-1", { key: "duplicate-pane" }, dependencies),
    { outcome: "recovery_blocked" },
  );
  assert.equal(splits.length, 2);
});

test("concurrent task and agent starts converge on stable keyed identities", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-creation-locks-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  let workspaceCreations = 0;
  let agentStarts = 0;
  const observedAgents = new Map();
  const herdr = {
    async ensureSession() {},
    async paneRecord(paneId) {
      return { pane_id: paneId, tab_id: "tab-1" };
    },
    async createWorkspace() {
      workspaceCreations += 1;
      return {
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
      };
    },
    async renameTab() {},
    async startCodexAgent(options) {
      agentStarts += 1;
      observedAgents.set(options.name, {
        name: options.name,
        pane_id: options.paneId,
        agent_status: "idle",
        agent_session: { value: "native-1" },
      });
    },
    async agentRecord(name) {
      return observedAgents.get(name) ?? null;
    },
    async agentRecords() {
      return [...observedAgents.values()];
    },
  };
  const dependencies = { env, herdr, run: async () => "" };

  const [firstTask, secondTask] = await Promise.all([
    openTask(
      { group: "concurrent", key: "task", cwd },
      dependencies,
    ),
    openTask(
      { group: "concurrent", key: "task", cwd },
      dependencies,
    ),
  ]);
  const [firstAgent, secondAgent] = await Promise.all([
    startAgent(firstTask.task.id, { key: "builder" }, dependencies),
    startAgent(secondTask.task.id, { key: "builder" }, dependencies),
  ]);

  assert.equal(firstTask.group.id, secondTask.group.id);
  assert.equal(firstTask.task.id, secondTask.task.id);
  assert.equal(firstAgent.agent.id, secondAgent.agent.id);
  assert.equal(workspaceCreations, 1);
  assert.equal(agentStarts, 1);
  assert.equal(
    (await readRecords(stateDirectory(env), "groups")).length,
    1,
  );
  assert.equal((await readRecords(stateDirectory(env), "tasks")).length, 1);
  assert.equal((await readRecords(stateDirectory(env), "agents")).length, 1);

  await writeRecord(stateDirectory(env), "tasks", {
    ...firstTask.task,
    id: "duplicate-task",
  });
  await assert.rejects(
    () =>
      openTask(
        { group: "concurrent", key: "task", cwd },
        dependencies,
      ),
    { outcome: "corrupt_registry" },
  );
});

test("task close waits for concurrent agent start and retires the created agent", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-start-close-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  let releaseStart;
  let reportStartEntered;
  const startEntered = new Promise((resolve) => {
    reportStartEntered = resolve;
  });
  const startReleased = new Promise((resolve) => {
    releaseStart = resolve;
  });
  let observedAgent;
  let tabClosed = false;
  let idleTabCreated = false;
  const herdr = {
    async ensureSession() {},
    async createWorkspace() {
      return {
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
      };
    },
    async renameTab() {},
    async startCodexAgent(options) {
      reportStartEntered();
      await startReleased;
      observedAgent = {
        name: options.name,
        pane_id: options.paneId,
        agent_status: "idle",
        agent_session: { value: "native-started" },
      };
    },
    async agentRecord(name) {
      return observedAgent?.name === name ? observedAgent : null;
    },
    async paneRecord(paneId) {
      if (paneId === "pane-idle" && idleTabCreated) {
        return { pane_id: paneId, tab_id: "tab-idle" };
      }
      return paneId === "pane-1" && !tabClosed
        ? { pane_id: paneId, tab_id: "tab-1" }
        : null;
    },
    async tabRecord(tabId) {
      if (tabId === "tab-idle" && idleTabCreated) {
        return { tab_id: tabId, workspace_id: "workspace-1" };
      }
      return tabId === "tab-1" && !tabClosed
        ? { tab_id: tabId, workspace_id: "workspace-1" }
        : null;
    },
    async workspaceRecord() {
      return { workspace_id: "workspace-1" };
    },
    async createTab() {
      idleTabCreated = true;
      return { tabId: "tab-idle", paneId: "pane-idle" };
    },
    async closeTab(tabId) {
      assert.equal(tabId, "tab-1");
      tabClosed = true;
    },
  };
  const dependencies = { env, herdr, run: async () => "" };
  const opened = await openTask(
    { group: "race", key: "task", cwd },
    dependencies,
  );

  const starting = startAgent(
    opened.task.id,
    { key: "builder" },
    dependencies,
  );
  await startEntered;
  const closing = closeTask(opened.task.id, dependencies);
  releaseStart();
  const started = await starting;
  const closed = await closing;

  assert.equal(started.agent.native_session, "native-started");
  assert.equal(closed.status, "closed");
  assert.equal(tabClosed, true);
  const [agent] = await readRecords(stateDirectory(env), "agents");
  const [task] = await readRecords(stateDirectory(env), "tasks");
  assert.equal(agent.id, started.agent.id);
  assert.equal(agent.status, "retired");
  assert.equal(task.status, "closed");
});

test("task open waits for concurrent close before applying a mutable label", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-open-close-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  let closeEntered;
  let releaseClose;
  const closeIsWaiting = new Promise((resolve) => {
    closeEntered = resolve;
  });
  const closeCanContinue = new Promise((resolve) => {
    releaseClose = resolve;
  });
  let blockClose = false;
  let tabClosed = false;
  let idleTabCreated = false;
  const renamedTabs = [];
  let ensureCalls = 0;
  let reportReopenEnsured;
  const reopenEnsured = new Promise((resolve) => {
    reportReopenEnsured = resolve;
  });
  const herdr = {
    async ensureSession() {
      ensureCalls += 1;
      if (ensureCalls === 3) reportReopenEnsured();
    },
    async createWorkspace() {
      return {
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
      };
    },
    async renameTab(tabId, label) {
      renamedTabs.push({ tabId, label });
    },
    async tabRecord(tabId) {
      if (tabId === "tab-idle" && idleTabCreated) {
        return { tab_id: tabId, workspace_id: "workspace-1" };
      }
      if (blockClose) {
        blockClose = false;
        closeEntered();
        await closeCanContinue;
      }
      return tabId === "tab-1" && !tabClosed
        ? { tab_id: tabId, workspace_id: "workspace-1" }
        : null;
    },
    async paneRecord(paneId) {
      return paneId === "pane-idle" && idleTabCreated
        ? { pane_id: paneId, tab_id: "tab-idle" }
        : null;
    },
    async workspaceRecord() {
      return { workspace_id: "workspace-1" };
    },
    async createTab() {
      idleTabCreated = true;
      return { tabId: "tab-idle", paneId: "pane-idle" };
    },
    async closeTab(tabId) {
      assert.equal(tabId, "tab-1");
      tabClosed = true;
    },
  };
  const dependencies = { env, herdr, run: async () => "" };
  const opened = await openTask(
    { group: "race", key: "task", label: "Original", cwd },
    dependencies,
  );
  blockClose = true;
  const closing = closeTask(opened.task.id, dependencies);
  await closeIsWaiting;
  const reopening = openTask(
    { group: "race", key: "task", label: "Too late", cwd },
    dependencies,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensureCalls, 2);
  releaseClose();

  assert.equal((await closing).status, "closed");
  await reopenEnsured;
  await assert.rejects(reopening, { outcome: "task_closed" });
  assert.deepEqual(renamedTabs, [{ tabId: "tab-1", label: "Original" }]);
});

test("agent start recreates a task tab after its last agent was retired", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-agent-after-retire-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const registryDirectory = stateDirectory(env);
  const launch = resolveLaunchSpecification(await loadConfiguration({ env }), {});
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "retired",
    label: "Retired",
    inferred: false,
    status: "active",
    herdr: { session: "delegates", workspace_id: "workspace-1" },
    created_at: "2026-07-23T10:00:00.000Z",
  });
  await writeRecord(registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: "group-1",
    key: "task",
    label: "Task",
    cwd,
    status: "active",
    herdr: { tab_id: "tab-old", root_pane_id: "pane-old" },
    created_at: "2026-07-23T10:00:01.000Z",
  });
  await writeRecord(registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-retired",
    task_id: "task-1",
    key: "old",
    label: "Old",
    status: "retired",
    launch,
    herdr: { name: "managed-old", pane_id: "pane-old" },
    native_session: "native-old",
    created_at: "2026-07-23T10:00:02.000Z",
    retired_at: "2026-07-23T10:00:03.000Z",
  });
  const createdTabs = [];
  let started;
  const herdr = {
    async ensureSession() {},
    async paneRecord() {
      return null;
    },
    async tabRecord() {
      return null;
    },
    async workspaceRecord() {
      return { workspace_id: "workspace-1" };
    },
    async createTab(options) {
      createdTabs.push(options);
      return { tabId: "tab-new", paneId: "pane-new" };
    },
    async startCodexAgent(options) {
      started = options;
    },
    async agentRecord(name) {
      return name === started?.name
        ? {
            name,
            pane_id: "pane-new",
            agent_status: "idle",
            agent_session: { value: "native-new" },
          }
        : null;
    },
  };

  const result = await startAgent(
    "task-1",
    { key: "new" },
    { env, herdr, run: async () => "" },
  );

  assert.deepEqual(createdTabs, [
    {
      workspaceId: "workspace-1",
      cwd,
      label: "Task",
    },
  ]);
  assert.equal(result.agent.herdr.pane_id, "pane-new");
  const [task] = await readRecords(registryDirectory, "tasks");
  assert.deepEqual(task.herdr, {
    tab_id: "tab-new",
    root_pane_id: "pane-new",
  });
});

test("first agent recreates a task tab when its registered root disappeared", async (t) => {
  const fixture = await firstAgentTopologyFixture(t, {
    async paneRecord() {
      return null;
    },
    async tabRecord() {
      return null;
    },
  });

  const started = await fixture.start();

  assert.equal(started.agent.herdr.pane_id, "pane-new");
  assert.equal(fixture.agentStarts.length, 1);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  assert.deepEqual(task.herdr, {
    tab_id: "tab-new",
    root_pane_id: "pane-new",
  });
});

test("first agent recreates its workspace when the registered workspace disappeared", async (t) => {
  const fixture = await firstAgentTopologyFixture(
    t,
    {
      async paneRecord() {
        return null;
      },
      async tabRecord() {
        return null;
      },
    },
    { workspaceExists: false },
  );

  const started = await fixture.start();

  assert.equal(started.agent.herdr.pane_id, "pane-new");
  assert.equal(fixture.agentStarts.length, 1);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  assert.deepEqual(task.herdr, {
    tab_id: "tab-new",
    root_pane_id: "pane-new",
  });
  const [group] = await readRecords(fixture.registryDirectory, "groups");
  assert.equal(group.herdr.workspace_id, "workspace-new");
});

test("first agent refuses a root pane moved to another tab", async (t) => {
  const fixture = await firstAgentTopologyFixture(t, {
    async paneRecord() {
      return { pane_id: "pane-root", tab_id: "tab-other" };
    },
  });

  await assert.rejects(fixture.start, { outcome: "recovery_blocked" });
  assert.equal(fixture.agentStarts.length, 0);
});

test("agent start confirms a new harness remains settled before returning", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-agent-readiness-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  let recordCalls = 0;
  const delays = [];
  let startedName;
  const herdr = {
    async ensureSession() {},
    async paneRecord(paneId) {
      return { pane_id: paneId, tab_id: "tab-1" };
    },
    async createWorkspace() {
      return {
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
      };
    },
    async renameTab() {},
    async startCodexAgent({ name }) {
      startedName = name;
    },
    async agentRecord(name) {
      assert.equal(name, startedName);
      recordCalls += 1;
      return {
        name,
        pane_id: "pane-1",
        agent_status: "idle",
        agent_session: { value: "native-ready" },
      };
    },
  };
  const dependencies = {
    env,
    herdr,
    run: async () => "",
    async delay(milliseconds) {
      delays.push(milliseconds);
    },
  };
  const opened = await openTask(
    { group: "readiness", key: "task", cwd },
    dependencies,
  );

  const started = await startAgent(
    opened.task.id,
    { key: "builder" },
    dependencies,
  );

  assert.equal(recordCalls, 2);
  assert.deepEqual(delays, [2000]);
  assert.equal(started.agent.native_session, "native-ready");
});

test("agent start preserves a settled harness awaiting native identity", async (t) => {
  const fixture = await readinessFixture(t, () => ({
    agent_status: "idle",
  }));

  const started = await fixture.start();
  assert.equal(started.agent.native_session, null);
});

test("agent start rejects native identity disappearing during readiness", async (t) => {
  const fixture = await readinessFixture(t, (call) => ({
    agent_status: "idle",
    ...(call === 1
      ? { agent_session: { value: "native-transient" } }
      : {}),
  }));

  await assert.rejects(fixture.start, {
    message: /lost native session identity/u,
    outcome: "adapter_failure",
  });
});

test("agent start bounds an oscillating startup readiness check", async (t) => {
  const fixture = await readinessFixture(t, (call) => ({
    agent_status: call % 2 === 0 ? "working" : "idle",
    agent_session: { value: "native-oscillating" },
  }));

  await assert.rejects(fixture.start, {
    message: /did not stabilize/u,
    outcome: "adapter_failure",
  });
  assert.equal(fixture.delays.length, 60);
});

test("agent start applies one integer overall deadline to startup waits", async (t) => {
  const fixture = await readinessFixture(t, () => ({
    agent_status: "working",
    agent_session: { value: "native-waiting" },
  }), { fractionalClock: true });

  await assert.rejects(fixture.start, {
    message: /did not stabilize/u,
    outcome: "adapter_failure",
  });
  assert.ok(fixture.waitTimeouts.every(Number.isInteger));
  assert.ok(fixture.waitTimeouts.every((timeout) => timeout > 0));
  assert.ok(fixture.waitTimeouts[0] < 120_000);
  assert.ok(
    fixture.waitTimeouts.at(-1) < fixture.waitTimeouts[0],
  );
});

async function readinessFixture(
  t,
  observation,
  { fractionalClock = false } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-agent-readiness-edge-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  let calls = 0;
  let clockCalls = 0;
  let elapsed = 0;
  let startedName;
  const delays = [];
  const waitTimeouts = [];
  const herdr = {
    async ensureSession() {},
    async paneRecord(paneId) {
      return { pane_id: paneId, tab_id: "tab-1" };
    },
    async createWorkspace() {
      return {
        workspaceId: "workspace-1",
        paneId: "pane-1",
        tabId: "tab-1",
      };
    },
    async renameTab() {},
    async startCodexAgent({ name }) {
      startedName = name;
    },
    async agentRecord(name) {
      assert.equal(name, startedName);
      calls += 1;
      return {
        name,
        pane_id: "pane-1",
        ...observation(calls),
      };
    },
    async waitForAgent(name, timeoutMs) {
      assert.equal(name, startedName);
      waitTimeouts.push(timeoutMs);
      return {
        name,
        pane_id: "pane-1",
        agent_status: "idle",
        agent_session: { value: "native-waiting" },
      };
    },
  };
  const dependencies = {
    env,
    herdr,
    run: async () => "",
    monotonicNow: () =>
      elapsed + (fractionalClock ? (clockCalls += 1) / 4 : 0),
    async delay(milliseconds) {
      delays.push(milliseconds);
      elapsed += milliseconds;
    },
  };
  const opened = await openTask(
    { group: "readiness-edge", key: "task", cwd },
    dependencies,
  );
  return {
    delays,
    waitTimeouts,
    start: () =>
      startAgent(opened.task.id, { key: "builder" }, dependencies),
  };
}

async function firstAgentTopologyFixture(
  t,
  observations,
  { workspaceExists = true } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-first-agent-pane-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const registryDirectory = stateDirectory(env);
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-first",
    key: "first",
    label: "First",
    inferred: false,
    status: "active",
    herdr: { session: "delegates", workspace_id: "workspace-first" },
    created_at: "2026-07-23T10:00:00.000Z",
  });
  await writeRecord(registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-first",
    group_id: "group-first",
    key: "task",
    label: "Task",
    cwd,
    status: "active",
    herdr: { tab_id: "tab-first", root_pane_id: "pane-root" },
    created_at: "2026-07-23T10:00:01.000Z",
  });
  const agentStarts = [];
  const herdr = {
    async ensureSession() {},
    ...observations,
    async workspaceRecord() {
      return workspaceExists ? { workspace_id: "workspace-first" } : null;
    },
    async createWorkspace() {
      return {
        workspaceId: "workspace-new",
        paneId: "pane-new",
        tabId: "tab-new",
      };
    },
    async createTab() {
      return { tabId: "tab-new", paneId: "pane-new" };
    },
    async renameTab() {},
    async startCodexAgent(options) {
      agentStarts.push(options);
    },
    async agentRecord(name) {
      const started = agentStarts.find((agent) => agent.name === name);
      return started
        ? {
            name,
            pane_id: started.paneId,
            agent_status: "idle",
            agent_session: { value: "native-first" },
          }
        : null;
    },
  };
  return {
    agentStarts,
    registryDirectory,
    start: () =>
      startAgent(
        "task-first",
        { key: "builder" },
        { env, herdr, run: async () => "" },
      ),
  };
}

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeGroup, closeTask, retireAgent } from "../src/lifecycle.mjs";
import {
  readRecords,
  stateDirectory,
  taskLifecycleLockKey,
  withResourceLock,
  writeRecord,
} from "../src/registry.mjs";
import { startTurn } from "../src/turns.mjs";

test("agent retirement closes only its managed pane and preserves durable history", async (t) => {
  const fixture = await lifecycleFixture(t);
  const closed = [];
  const result = await retireAgent(fixture.agent.id, {
    env: fixture.env,
    now: () => "2026-07-23T11:00:00.000Z",
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return { agent_status: "idle", agent_session: { value: "native-1" } };
      },
      async closePane(paneId) {
        closed.push(paneId);
      },
      async paneRecord() {
        return null;
      },
    },
  });

  assert.equal(result.status, "retired");
  assert.deepEqual(closed, ["pane-agent-1"]);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  assert.equal(agent.status, "retired");
  assert.equal(agent.retired_at, "2026-07-23T11:00:00.000Z");
  assert.equal(turn.status, "completed");
  await access(fixture.callerFile);
  await access(fixture.transcript);
});

test("task cleanup closes a persisted startup pane without native identity", async (t) => {
  const fixture = await lifecycleFixture(t);
  fixture.agent.native_session = null;
  await writeRecord(fixture.registryDirectory, "agents", fixture.agent);
  await rm(join(fixture.registryDirectory, "turns", "turn-1.json"));
  let tabClosed = false;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return null;
      },
      async paneRecord() {
        return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
      },
      async tabRecord() {
        return tabClosed
          ? null
          : { tab_id: "tab-task-1", workspace_id: "workspace-1" };
      },
      async closeTab(tabId) {
        assert.equal(tabId, "tab-task-1");
        tabClosed = true;
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.equal(tabClosed, true);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(agent.status, "retired");
});

test("task cleanup closes an identity-less agent after an uncertain first turn", async (t) => {
  const fixture = await lifecycleFixture(t);
  fixture.agent.native_session = null;
  await writeRecord(fixture.registryDirectory, "agents", fixture.agent);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "uncertain";
  turn.error = "native session identity never appeared";
  delete turn.result;
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let tabClosed = false;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-agent-1",
          agent_status: "idle",
        };
      },
      async paneRecord() {
        return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
      },
      async tabRecord() {
        return tabClosed
          ? null
          : { tab_id: "tab-task-1", workspace_id: "workspace-1" };
      },
      async closeTab() {
        tabClosed = true;
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.equal(tabClosed, true);
});

test("task cleanup finalizes an identity-less agent with no native resources", async (t) => {
  const fixture = await lifecycleFixture(t);
  fixture.agent.native_session = null;
  await writeRecord(fixture.registryDirectory, "agents", fixture.agent);
  let mutations = 0;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return null;
      },
      async paneRecord() {
        return null;
      },
      async tabRecord() {
        return null;
      },
      async closeTab() {
        mutations += 1;
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.equal(mutations, 0);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(agent.status, "retired");
});

test("agent retirement targets the restored pane bound to its native session", async (t) => {
  const fixture = await lifecycleFixture(t);
  const closed = [];
  let paneClosed = false;
  const result = await retireAgent(fixture.agent.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return {
          pane_id: "restored-pane",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async paneRecord() {
        return paneClosed
          ? null
          : { pane_id: "restored-pane", tab_id: "restored-tab" };
      },
      async closePane(paneId) {
        closed.push(paneId);
        paneClosed = true;
      },
    },
  });

  assert.equal(result.status, "retired");
  assert.deepEqual(closed, ["restored-pane"]);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(task.herdr.tab_id, "restored-tab");
  assert.equal(agent.herdr.pane_id, "restored-pane");
});

test("non-force task cleanup refuses busy agents before mutating resources", async (t) => {
  const fixture = await lifecycleFixture(t);
  let mutations = 0;
  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return { agent_status: "blocked", agent_session: { value: "native-1" } };
      },
      async closeTab() {
        mutations += 1;
      },
    },
  });

  assert.equal(result.status, "task_busy");
  assert.equal(mutations, 0);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(task.status, "active");
  assert.equal(agent.status, "active");
});

test("non-force task cleanup honors durable working state before Herdr mutation", async (t) => {
  const fixture = await lifecycleFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "working";
  delete turn.result;
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let mutations = 0;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return { agent_status: "idle", agent_session: { value: "native-1" } };
      },
      async closeTab() {
        mutations += 1;
      },
    },
  });

  assert.equal(result.status, "task_busy");
  assert.equal(mutations, 0);
});

test("task cleanup closes its exact managed tab and retains caller-owned files", async (t) => {
  const fixture = await lifecycleFixture(t);
  const closed = [];
  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    now: () => "2026-07-23T11:00:01.000Z",
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return { agent_status: "idle", agent_session: { value: "native-1" } };
      },
      async paneRecord() {
        return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
      },
      async closeTab(tabId) {
        closed.push(tabId);
      },
      async tabRecord() {
        return closed.length
          ? null
          : { tab_id: "tab-task-1", workspace_id: "workspace-1" };
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.deepEqual(closed, ["tab-task-1"]);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  assert.equal(task.status, "closed");
  assert.equal(agent.status, "retired");
  assert.equal(turn.status, "completed");
  await access(fixture.callerFile);
  await access(fixture.transcript);
});

test("task cleanup rebinds restored pane and tab identities before closing", async (t) => {
  const fixture = await lifecycleFixture(t);
  const closed = [];
  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return {
          pane_id: "restored-pane",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async paneRecord() {
        return { pane_id: "restored-pane", tab_id: "restored-tab" };
      },
      async closeTab(tabId) {
        closed.push(tabId);
      },
      async tabRecord(tabId) {
        if (tabId === "tab-task-1" || closed.length) return null;
        return { tab_id: "restored-tab", workspace_id: "workspace-1" };
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.deepEqual(closed, ["restored-tab"]);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  assert.equal(task.herdr.tab_id, "restored-tab");
});

test("task cleanup refuses an agent moved from its still-registered tab", async (t) => {
  const fixture = await lifecycleFixture(t);
  let mutations = 0;
  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return {
          pane_id: "moved-pane",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async paneRecord() {
        return { pane_id: "moved-pane", tab_id: "unregistered-tab" };
      },
      async tabRecord(tabId) {
        return { tab_id: tabId, workspace_id: "workspace-1" };
      },
      async closeTab() {
        mutations += 1;
      },
    },
  });

  assert.equal(result.status, "recovery_blocked");
  assert.equal(mutations, 0);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  assert.equal(task.herdr.tab_id, "tab-task-1");
});

test("task cleanup excludes a concurrent new turn before preflight and closure", async (t) => {
  const fixture = await lifecycleFixture(t);
  let releaseClose;
  let closeStarted;
  let promptCalls = 0;
  let tabClosed = false;
  const closeStartedPromise = new Promise((resolve) => {
    closeStarted = resolve;
  });
  const releaseClosePromise = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const observed = {
    name: "managed-agent",
    pane_id: "pane-agent-1",
    agent_status: "idle",
    agent_session: { value: "native-1" },
  };
  const herdr = {
    async ensureSession() {},
    async agentRecord() {
      return observed;
    },
    async agentRecords() {
      return [observed];
    },
    async paneRecord() {
      return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
    },
    async closeTab() {
      closeStarted();
      await releaseClosePromise;
      tabClosed = true;
    },
    async tabRecord() {
      return tabClosed
        ? null
        : { tab_id: "tab-task-1", workspace_id: "workspace-1" };
    },
    async prompt() {
      promptCalls += 1;
    },
  };

  const closing = closeTask(fixture.task.id, { env: fixture.env, herdr });
  await closeStartedPromise;
  const starting = startTurn(
    fixture.agent.id,
    { prompt: "must not start during close" },
    { env: fixture.env, herdr },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCalls, 0);
  releaseClose();

  assert.equal((await closing).status, "closed");
  await assert.rejects(starting, { outcome: "recovery_blocked" });
  assert.equal(promptCalls, 0);
});

test("non-force group cleanup preflights every task before mutating resources", async (t) => {
  const fixture = await lifecycleFixture(t);
  await writeRecord(fixture.registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-2",
    group_id: fixture.group.id,
    key: "busy-task",
    label: "Busy task",
    cwd: fixture.task.cwd,
    status: "active",
    herdr: { tab_id: "tab-task-2", root_pane_id: "pane-agent-2" },
  });
  await writeRecord(fixture.registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-2",
    task_id: "task-2",
    key: "busy-agent",
    label: "Busy agent",
    status: "active",
    launch: { harness: "codex" },
    herdr: { name: "managed-agent-2", pane_id: "pane-agent-2" },
    native_session: "native-2",
  });
  await writeRecord(fixture.registryDirectory, "turns", {
    schema: "drovr.turn/v1",
    id: "turn-2",
    agent_id: "agent-2",
    task_id: "task-2",
    status: "working",
    inputs: [{ sequence: 1, text: "still working" }],
  });
  let mutations = 0;

  const result = await closeGroup(fixture.group.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord(name) {
        return {
          name,
          pane_id: name === "managed-agent" ? "pane-agent-1" : "pane-agent-2",
          agent_status: name === "managed-agent" ? "idle" : "working",
          agent_session: {
            value: name === "managed-agent" ? "native-1" : "native-2",
          },
        };
      },
      async paneRecord(paneId) {
        return {
          pane_id: paneId,
          tab_id: paneId === "pane-agent-1" ? "tab-task-1" : "tab-task-2",
        };
      },
      async tabRecord(tabId) {
        return { tab_id: tabId, workspace_id: "workspace-1" };
      },
      async closeTab() {
        mutations += 1;
      },
      async closeWorkspace() {
        mutations += 1;
      },
      async interruptAgent() {
        mutations += 1;
      },
    },
  });

  assert.equal(result.status, "task_busy");
  assert.equal(result.task.id, "task-2");
  assert.equal(mutations, 0);
  const tasks = await readRecords(fixture.registryDirectory, "tasks");
  assert.equal(tasks.every(({ status }) => status === "active"), true);
});

test("group cleanup locks tasks created while it waits for the group lock", async (t) => {
  const fixture = await lifecycleFixture(t);
  const closedTabs = new Set();
  let workspaceClosed = false;
  let taskLockEntered = false;
  let competingLock;
  const herdr = {
    async ensureSession() {},
    async agentRecord() {
      return {
        pane_id: "pane-agent-1",
        agent_status: "idle",
        agent_session: { value: "native-1" },
      };
    },
    async paneRecord() {
      return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
    },
    async tabRecord(tabId) {
      return closedTabs.has(tabId)
        ? null
        : { tab_id: tabId, workspace_id: "workspace-1" };
    },
    async closeTab(tabId) {
      if (!competingLock) {
        competingLock = withResourceLock(
          fixture.registryDirectory,
          taskLifecycleLockKey("task-2"),
          async () => {
            taskLockEntered = true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(taskLockEntered, false);
      }
      closedTabs.add(tabId);
    },
    async closeWorkspace() {
      workspaceClosed = true;
    },
    async workspaceRecord() {
      return workspaceClosed ? null : { workspace_id: "workspace-1" };
    },
  };
  let closing;
  await withResourceLock(
    fixture.registryDirectory,
    `group-key:${fixture.group.key}`,
    async () => {
      closing = closeGroup(fixture.group.id, {
        env: fixture.env,
        herdr,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeRecord(fixture.registryDirectory, "tasks", {
        schema: "drovr.task/v1",
        id: "task-2",
        group_id: fixture.group.id,
        key: "late-task",
        label: "Late task",
        cwd: fixture.task.cwd,
        status: "active",
        herdr: { tab_id: "tab-task-2", root_pane_id: "pane-task-2" },
      });
    },
  );

  const result = await closing;
  assert.equal(result.status, "closed");
  await competingLock;
  assert.equal(taskLockEntered, true);
});

test("force task cleanup interrupts active work and preserves durable history", async (t) => {
  const fixture = await lifecycleFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "working";
  turn.block_ids = ["block-1"];
  delete turn.result;
  await writeRecord(fixture.registryDirectory, "turns", turn);
  await writeRecord(fixture.registryDirectory, "blocks", {
    schema: "drovr.block/v1",
    id: "block-1",
    turn_id: turn.id,
    agent_id: fixture.agent.id,
    task_id: fixture.task.id,
    status: "open",
    created_at: "2026-07-23T10:30:00.000Z",
  });
  const interrupted = [];
  const closed = [];
  let tabClosed = false;
  let turnLockEntered = false;
  let competingTurnLock;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    force: true,
    now: () => "2026-07-23T11:30:00.000Z",
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-agent-1",
          agent_status: "blocked",
          agent_session: { value: "native-1" },
        };
      },
      async paneRecord() {
        return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
      },
      async tabRecord() {
        return tabClosed
          ? null
          : { tab_id: "tab-task-1", workspace_id: "workspace-1" };
      },
      async interruptAgent(name) {
        interrupted.push(name);
        competingTurnLock = withResourceLock(
          fixture.registryDirectory,
          `turn:${turn.id}`,
          async () => {
            turnLockEntered = true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(turnLockEntered, false);
      },
      async waitForAgent() {
        return {
          name: "managed-agent",
          pane_id: "pane-agent-1",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async closeTab(tabId) {
        closed.push(tabId);
        tabClosed = true;
      },
    },
  });

  assert.equal(result.status, "closed");
  await competingTurnLock;
  assert.equal(turnLockEntered, true);
  assert.deepEqual(interrupted, ["managed-agent"]);
  assert.deepEqual(closed, ["tab-task-1"]);
  const [storedTurn] = await readRecords(fixture.registryDirectory, "turns");
  const [block] = await readRecords(fixture.registryDirectory, "blocks");
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(storedTurn.status, "interrupted");
  assert.equal(storedTurn.settled_at, "2026-07-23T11:30:00.000Z");
  assert.equal(block.status, "resolved");
  assert.equal(block.resolution, "force_cleanup");
  assert.equal(task.status, "closed");
  assert.equal(agent.status, "retired");
  await access(fixture.callerFile);
  await access(fixture.transcript);
});

test("force cleanup records uncertain when interruption settlement is unconfirmed", async (t) => {
  const fixture = await lifecycleFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "working";
  delete turn.result;
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let tabClosed = false;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    force: true,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return {
          pane_id: "pane-agent-1",
          agent_status: "working",
          agent_session: { value: "native-1" },
        };
      },
      async paneRecord() {
        return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
      },
      async tabRecord() {
        return tabClosed
          ? null
          : { tab_id: "tab-task-1", workspace_id: "workspace-1" };
      },
      async interruptAgent() {},
      async waitForAgent() {
        return { drovr_status: "still_running" };
      },
      async closeTab() {
        tabClosed = true;
      },
    },
  });

  assert.equal(result.status, "closed");
  const [storedTurn] = await readRecords(fixture.registryDirectory, "turns");
  assert.equal(storedTurn.status, "uncertain");
  assert.match(storedTurn.error, /settlement could not be confirmed/u);
});

test("force cleanup revalidates native identity before interruption", async (t) => {
  const fixture = await lifecycleFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "working";
  delete turn.result;
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let observations = 0;
  let mutations = 0;

  const result = await closeTask(fixture.task.id, {
    env: fixture.env,
    force: true,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        observations += 1;
        return {
          pane_id: "pane-agent-1",
          agent_status: "working",
          agent_session: {
            value: observations === 1 ? "native-1" : "native-rebound",
          },
        };
      },
      async paneRecord() {
        return { pane_id: "pane-agent-1", tab_id: "tab-task-1" };
      },
      async tabRecord() {
        return { tab_id: "tab-task-1", workspace_id: "workspace-1" };
      },
      async interruptAgent() {
        mutations += 1;
      },
      async closeTab() {
        mutations += 1;
      },
    },
  });

  assert.equal(result.status, "recovery_blocked");
  assert.equal(mutations, 0);
  const [storedTurn] = await readRecords(fixture.registryDirectory, "turns");
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(storedTurn.status, "uncertain");
  assert.match(storedTurn.error, /native session identity changed/u);
  assert.equal(task.status, "active");
  assert.equal(agent.status, "active");
});

test("force group cleanup closes only exact managed resources after interrupting work", async (t) => {
  const fixture = await lifecycleFixture(t);
  const secondCwd = join(fixture.task.cwd, "second-task");
  const secondCallerFile = join(secondCwd, "keep-too.txt");
  await mkdir(secondCwd);
  await writeFile(secondCallerFile, "keep too\n");
  await writeRecord(fixture.registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-2",
    group_id: fixture.group.id,
    key: "busy-task",
    label: "Busy task",
    cwd: secondCwd,
    status: "active",
    herdr: { tab_id: "tab-task-2", root_pane_id: "pane-agent-2" },
  });
  await writeRecord(fixture.registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-2",
    task_id: "task-2",
    key: "busy-agent",
    label: "Busy agent",
    status: "active",
    launch: { harness: "codex" },
    herdr: { name: "managed-agent-2", pane_id: "pane-agent-2" },
    native_session: "native-2",
  });
  await writeRecord(fixture.registryDirectory, "turns", {
    schema: "drovr.turn/v1",
    id: "turn-2",
    agent_id: "agent-2",
    task_id: "task-2",
    status: "working",
    inputs: [{ sequence: 1, text: "still working" }],
  });
  const interrupted = [];
  const closedTabs = [];
  const closedWorkspaces = [];
  const closedTabIds = new Set();
  let workspaceClosed = false;

  const result = await closeGroup(fixture.group.id, {
    env: fixture.env,
    force: true,
    now: () => "2026-07-23T12:00:00.000Z",
    herdr: {
      async ensureSession() {},
      async agentRecord(name) {
        const second = name === "managed-agent-2";
        return {
          name,
          pane_id: second ? "pane-agent-2" : "pane-agent-1",
          agent_status: second ? "working" : "idle",
          agent_session: { value: second ? "native-2" : "native-1" },
        };
      },
      async paneRecord(paneId) {
        return {
          pane_id: paneId,
          tab_id: paneId === "pane-agent-2" ? "tab-task-2" : "tab-task-1",
        };
      },
      async tabRecord(tabId) {
        return closedTabIds.has(tabId)
          ? null
          : { tab_id: tabId, workspace_id: "workspace-1" };
      },
      async interruptAgent(name) {
        interrupted.push(name);
      },
      async waitForAgent(name) {
        return {
          name,
          agent_status: "idle",
          agent_session: { value: "native-2" },
        };
      },
      async closeTab(tabId) {
        closedTabs.push(tabId);
        closedTabIds.add(tabId);
      },
      async closeWorkspace(workspaceId) {
        closedWorkspaces.push(workspaceId);
        workspaceClosed = true;
      },
      async workspaceRecord() {
        return workspaceClosed ? null : { workspace_id: "workspace-1" };
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.deepEqual(interrupted, ["managed-agent-2"]);
  assert.deepEqual(closedTabs, ["tab-task-1", "tab-task-2"]);
  assert.deepEqual(closedWorkspaces, ["workspace-1"]);
  const groups = await readRecords(fixture.registryDirectory, "groups");
  const tasks = await readRecords(fixture.registryDirectory, "tasks");
  const agents = await readRecords(fixture.registryDirectory, "agents");
  const turns = await readRecords(fixture.registryDirectory, "turns");
  assert.equal(groups[0].status, "closed");
  assert.equal(tasks.every(({ status }) => status === "closed"), true);
  assert.equal(agents.every(({ status }) => status === "retired"), true);
  assert.equal(turns.find(({ id }) => id === "turn-1").status, "completed");
  assert.equal(turns.find(({ id }) => id === "turn-2").status, "interrupted");
  await access(fixture.callerFile);
  await access(secondCallerFile);
  await access(fixture.transcript);
});

async function lifecycleFixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-lifecycle-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "caller-worktree");
  const transcriptRoot = join(scratch, "codex", "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(transcriptRoot, { recursive: true });
  const callerFile = join(cwd, "owned.txt");
  const transcript = join(transcriptRoot, "rollout-native-1.jsonl");
  await writeFile(callerFile, "keep\n");
  await writeFile(transcript, "{}\n");
  const env = { ...process.env, XDG_STATE_HOME: join(scratch, "state") };
  env.CODEX_HOME = join(scratch, "codex");
  const registryDirectory = stateDirectory(env);
  const group = {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "group",
    label: "Group",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  };
  const task = {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: group.id,
    key: "task",
    label: "Task",
    cwd,
    status: "active",
    herdr: { tab_id: "tab-task-1", root_pane_id: "pane-agent-1" },
  };
  const agent = {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: task.id,
    key: "agent",
    label: "Agent",
    status: "active",
    launch: { harness: "codex" },
    herdr: { name: "managed-agent", pane_id: "pane-agent-1" },
    native_session: "native-1",
  };
  const turn = {
    schema: "drovr.turn/v1",
    id: "turn-1",
    agent_id: agent.id,
    task_id: task.id,
    status: "completed",
    inputs: [{ sequence: 1, text: "done" }],
    result: { text: "kept", messages: ["kept"] },
  };
  await writeRecord(registryDirectory, "groups", group);
  await writeRecord(registryDirectory, "tasks", task);
  await writeRecord(registryDirectory, "agents", agent);
  await writeRecord(registryDirectory, "turns", turn);
  return { env, registryDirectory, group, task, agent, callerFile, transcript };
}

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeTask, retireAgent } from "../src/lifecycle.mjs";
import { readRecords, stateDirectory, writeRecord } from "../src/registry.mjs";
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
        return null;
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
      async tabRecord() {
        return null;
      },
    },
  });

  assert.equal(result.status, "closed");
  assert.deepEqual(closed, ["restored-tab"]);
  const [task] = await readRecords(fixture.registryDirectory, "tasks");
  assert.equal(task.herdr.tab_id, "restored-tab");
});

test("task cleanup excludes a concurrent new turn before preflight and closure", async (t) => {
  const fixture = await lifecycleFixture(t);
  let releaseClose;
  let closeStarted;
  let promptCalls = 0;
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
    },
    async tabRecord() {
      return null;
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

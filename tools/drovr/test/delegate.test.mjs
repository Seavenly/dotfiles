import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { delegate } from "../src/delegate.mjs";
import { DrovrError } from "../src/errors.mjs";
import { retireAgent } from "../src/lifecycle.mjs";
import {
  loadConfiguration,
  resolveLaunchSpecification,
} from "../src/config.mjs";
import {
  readRecords,
  stateDirectory,
  writeRecord,
} from "../src/registry.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("delegate closes a newly created empty task after launch rejection", async () => {
  const rejection = new DrovrError("runtime is unqualified", {
    code: 0,
    outcome: "compatibility_blocked",
  });
  let closed;

  await assert.rejects(
    () =>
      delegate(
        { prompt: "review" },
        {
          openTask: async () => ({
            group: { id: "group-1" },
            task: { id: "task-1" },
            groupCreated: false,
            taskCreated: true,
          }),
          startAgent: async () => {
            throw rejection;
          },
          taskHasAgents: async () => false,
          closeTask: async (id, options) => {
            closed = { id, force: options.force };
            return { status: "closed" };
          },
        },
      ),
    (error) => error === rejection,
  );
  assert.deepEqual(closed, { id: "task-1", force: true });
});

test("delegate closes its newly created group when launch leaves it empty", async () => {
  let closed;

  await assert.rejects(
    () =>
      delegate(
        { prompt: "review" },
        {
          openTask: async () => ({
            group: { id: "group-1" },
            task: { id: "task-1" },
            groupCreated: true,
            taskCreated: true,
          }),
          startAgent: async () => {
            throw new Error("launch failed");
          },
          taskHasAgents: async () => false,
          closeGroup: async (id, options) => {
            closed = { id, force: options.force };
            return { status: "closed" };
          },
        },
      ),
    { message: "launch failed" },
  );
  assert.deepEqual(closed, { id: "group-1", force: true });
});

test("delegate preserves a task after an agent reservation is durable", async () => {
  let cleanupCalls = 0;

  await assert.rejects(
    () =>
      delegate(
        { prompt: "review" },
        {
          openTask: async () => ({
            group: { id: "group-1" },
            task: { id: "task-1" },
            groupCreated: true,
            taskCreated: true,
          }),
          startAgent: async () => {
            throw new Error("startup failed after reservation");
          },
          taskHasAgents: async () => true,
          closeGroup: async () => {
            cleanupCalls += 1;
          },
        },
      ),
    { message: "startup failed after reservation" },
  );
  assert.equal(cleanupCalls, 0);
});

test("delegate persists managed-agent ownership before startup readiness can fail", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-agent-startup-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  let startedName;
  let readinessFailed = false;
  let paneClosed = false;
  const herdr = {
    async sessionRunning() {
      return true;
    },
    async ensureSession() {},
    async createWorkspace() {
      return { workspaceId: "workspace-1", paneId: "pane-1", tabId: "tab-1" };
    },
    async renameTab() {},
    async startCodexAgent({ name }) {
      startedName = name;
    },
    async agentRecord() {
      return {
        name: startedName,
        pane_id: "pane-1",
        agent_status: readinessFailed ? "idle" : "working",
      };
    },
    async waitForAgent() {
      readinessFailed = true;
      return { drovr_status: "still_running" };
    },
    async paneRecord() {
      return paneClosed
        ? null
        : { pane_id: "pane-1", tab_id: "tab-1" };
    },
    async closePane() {
      paneClosed = true;
    },
  };

  await assert.rejects(
    () =>
      delegate(
        {
          taskKey: "startup-failure",
          agentKey: "builder",
          cwd,
          group: "startup-test",
          prompt: "request",
          timeoutMs: 1000,
        },
        { env, herdr },
      ),
    { message: /did not finish starting/u, outcome: "adapter_failure" },
  );

  const agents = await readRecords(stateDirectory(env), "agents");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].herdr.name, startedName);
  assert.equal(agents[0].native_session, null);
  assert.equal(agents[0].status, "active");

  const retired = await retireAgent(agents[0].id, { env, herdr });
  assert.equal(retired.status, "retired");
  assert.equal(paneClosed, true);
});

test("reused delegate refuses a new prompt while uncertain native work continues", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-delegate-busy-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  await mkdir(cwd);
  const canonicalCwd = await realpath(cwd);
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
    key: "busy-group",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  });
  await writeRecord(registryDirectory, "tasks", {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: "group-1",
    key: "busy-task",
    cwd: canonicalCwd,
    status: "active",
    herdr: { tab_id: "tab-1", root_pane_id: "pane-1" },
  });
  await writeRecord(registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: "task-1",
    key: "builder",
    status: "active",
    launch,
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  });
  let promptCalls = 0;
  const observed = {
    name: "managed-agent",
    pane_id: "pane-1",
    agent_status: "working",
    agent_session: { value: "native-1" },
  };
  const herdr = {
    async ensureSession() {},
    async agentRecords() {
      return [observed];
    },
    async agentRecord() {
      return observed;
    },
    async prompt() {
      promptCalls += 1;
    },
  };

  await assert.rejects(
    () =>
      delegate(
        {
          group: "busy-group",
          taskKey: "busy-task",
          agentKey: "builder",
          cwd: canonicalCwd,
          prompt: "must not overlap",
          timeoutMs: 1000,
        },
        { env, herdr },
      ),
    { outcome: "task_busy" },
  );
  assert.equal(promptCalls, 0);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { delegate } from "../src/delegate.mjs";
import { readRecords, stateDirectory } from "../src/registry.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

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
  const herdr = {
    async ensureSession() {},
    async createWorkspace() {
      return { workspaceId: "workspace-1", paneId: "pane-1", tabId: "tab-1" };
    },
    async renameTab() {},
    async startCodexAgent({ name }) {
      startedName = name;
    },
    async agentRecord() {
      return { agent_status: "working" };
    },
    async waitForAgent() {
      return { drovr_status: "still_running" };
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
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadConfiguration, resolveLaunchSpecification } from "../src/config.mjs";
import { createAgentLaunchBinding } from "../src/description.mjs";
import { reconcileOrRecoverAgent } from "../src/recovery.mjs";
import { readRecords, stateDirectory, writeRecord } from "../src/registry.mjs";
import { reconcileTurn, startTurn } from "../src/turns.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("Herdr restart reconciliation rebinds only the expected native session", async (t) => {
  const fixture = await recoveryFixture(t);
  let resumed = false;
  const result = await reconcileOrRecoverAgent(fixture.agent.id, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord(name) {
        assert.equal(name, "managed-agent");
        return {
          name,
          pane_id: "restored-pane",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async agentRecords() {
        return [
          {
            name: "managed-agent",
            pane_id: "restored-pane",
            agent_status: "idle",
            agent_session: { value: "native-1" },
          },
        ];
      },
      async resumeAgent() {
        resumed = true;
      },
    },
  });

  assert.equal(result.status, "reconciled");
  assert.equal(resumed, false);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(agent.herdr.pane_id, "restored-pane");
});

test("confirmed-down idle agents recover their exact native session", async (t) => {
  const fixture = await recoveryFixture(t);
  let resumed;
  let registered = false;
  const result = await reconcileOrRecoverAgent(fixture.agent.id, {
    env: fixture.env,
    now: () => "2026-07-23T12:00:00.000Z",
    herdr: recoveryHerdr({
      onResume(options) {
        resumed = options;
        registered = true;
      },
      registered: () => registered,
    }),
    run: compatibleCodex,
  });

  assert.equal(result.status, "recovered");
  assert.equal(resumed.nativeSession, "native-1");
  assert.equal(resumed.paneId, "pane-agent-1");
  assert.deepEqual(resumed.specification, fixture.agent.launch);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(agent.recovered_at, "2026-07-23T12:00:00.000Z");
});

test("an absent managed agent and exact persisted pane are confirmed down", async (t) => {
  const fixture = await recoveryFixture(t);
  let registered = false;
  let resumeCalls = 0;
  const herdr = recoveryHerdr({
    onResume(options) {
      resumeCalls += 1;
      assert.equal(options.paneId, "replacement-pane");
      registered = true;
    },
    registered: () => registered,
  });
  herdr.paneRecord = async (paneId) => {
    assert.equal(paneId, "pane-agent-1");
    return null;
  };
  herdr.tabRecord = async () => null;
  herdr.workspaceRecord = async () => null;
  herdr.createWorkspace = async ({ cwd }) => {
    assert.equal(cwd, fixture.task.cwd);
    return {
      workspaceId: "replacement-workspace",
      tabId: "replacement-tab",
      paneId: "replacement-pane",
    };
  };
  herdr.renameTab = async () => {};
  herdr.paneProcessInfo = async () => {
    throw new Error("a missing pane has no process information");
  };
  herdr.agentRecord = async () =>
    registered
      ? {
          name: "managed-agent",
          pane_id: "replacement-pane",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        }
      : null;
  herdr.agentRecords = async () =>
    registered ? [await herdr.agentRecord()] : [];

  const result = await reconcileOrRecoverAgent(fixture.agent.id, {
    env: fixture.env,
    herdr,
    run: compatibleCodex,
  });

  assert.equal(result.status, "recovered");
  assert.equal(resumeCalls, 1);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  assert.equal(agent.herdr.pane_id, "replacement-pane");
});

test("a missing agent pane recovers through an exact managed sibling", async (t) => {
  const fixture = await recoveryFixture(t);
  await writeRecord(fixture.registryDirectory, "agents", {
    schema: "drovr.agent/v1",
    id: "sibling-agent",
    task_id: fixture.task.id,
    status: "active",
    launch: fixture.agent.launch,
    herdr: { name: "managed-sibling", pane_id: "sibling-pane" },
    native_session: "native-sibling",
  });
  let registered = false;
  let splitOptions;
  const sibling = {
    name: "managed-sibling",
    pane_id: "sibling-pane",
    agent_status: "idle",
    agent_session: { value: "native-sibling" },
  };
  const restored = {
    name: "managed-agent",
    pane_id: "replacement-pane",
    agent_status: "idle",
    agent_session: { value: "native-1" },
  };
  const herdr = recoveryHerdr({
    onResume(options) {
      assert.equal(options.paneId, "replacement-pane");
      registered = true;
    },
    registered: () => registered,
  });
  herdr.agentRecord = async () => (registered ? restored : null);
  herdr.agentRecords = async () => [
    sibling,
    ...(registered ? [restored] : []),
  ];
  herdr.paneRecord = async (paneId) =>
    paneId === "sibling-pane"
      ? { pane_id: paneId, tab_id: "tab-task-1" }
      : null;
  herdr.tabRecord = async () => ({ tab_id: "tab-task-1" });
  herdr.splitPane = async (options) => {
    splitOptions = options;
    return "replacement-pane";
  };

  const result = await reconcileOrRecoverAgent(fixture.agent.id, {
    env: fixture.env,
    herdr,
    run: compatibleCodex,
  });

  assert.equal(result.status, "recovered");
  assert.deepEqual(splitOptions, {
    paneId: "sibling-pane",
    direction: "right",
    ratio: 0.5,
    cwd: fixture.task.cwd,
  });
  const [agent] = (await readRecords(fixture.registryDirectory, "agents"))
    .filter(({ id }) => id === fixture.agent.id);
  assert.equal(agent.herdr.pane_id, "replacement-pane");
});

test("recovering a working agent interrupts the prior turn without replaying it", async (t) => {
  const fixture = await recoveryFixture(t, { working: true });
  let registered = false;
  const delivered = [];
  const result = await reconcileOrRecoverAgent(fixture.agent.id, {
    env: fixture.env,
    now: () => "2026-07-23T12:00:01.000Z",
    herdr: recoveryHerdr({
      onResume() {
        registered = true;
      },
      registered: () => registered,
      delivered,
    }),
    run: compatibleCodex,
  });

  assert.equal(result.status, "recovered");
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.inputs[0].text, "do not replay me");
  assert.equal(turn.caller.dispatch_key, "run:1/card:1/attempt:1");
  assert.equal(
    turn.settlement_proof.classification,
    "interruption_unconfirmed",
  );
  assert.equal(
    turn.settlement_proof.launch_comparison_key,
    fixture.agent.launch_binding.comparison_key,
  );
  assert.deepEqual(delivered, []);
});

test("turn reconciliation reports the recovered turn disposition", async (t) => {
  const fixture = await recoveryFixture(t, { working: true });
  let registered = false;
  const result = await reconcileTurn(fixture.turn.id, { timeoutMs: 1000 }, {
    env: fixture.env,
    now: () => "2026-07-23T12:00:01.000Z",
    herdr: recoveryHerdr({
      onResume() {
        registered = true;
      },
      registered: () => registered,
    }),
    run: compatibleCodex,
  });

  assert.equal(result.turn.status, "interrupted");
  assert.equal(Object.hasOwn(result, "command_status"), false);
  assert.equal(Object.hasOwn(result, "recovery_reason"), false);
});

test("a mutating turn command recovers loss before accepting later explicit work", async (t) => {
  const fixture = await recoveryFixture(t, { working: true });
  let registered = false;
  const delivered = [];
  const herdr = recoveryHerdr({
    onResume() {
      registered = true;
    },
    registered: () => registered,
    delivered,
  });
  herdr.prompt = async (_name, prompt) => delivered.push(prompt);

  const started = await startTurn(
    fixture.agent.id,
    { prompt: "later explicit work" },
    { env: fixture.env, herdr, run: compatibleCodex },
  );
  const turns = await readRecords(fixture.registryDirectory, "turns");

  assert.equal(started.turn.status, "working");
  assert.equal(started.turn.inputs[0].text, "later explicit work");
  assert.equal(
    turns.find(({ id }) => id === fixture.turn.id).status,
    "interrupted",
  );
  assert.deepEqual(delivered, ["later explicit work"]);
});

for (const scenario of [
  "duplicate native ownership",
  "missing cwd",
  "missing transcript",
  "transcript metadata mismatch",
  "missing native identity",
  "launch drift",
  "launch unsatisfied",
  "ambiguous process state",
]) {
  test(`${scenario} blocks recovery without launching anything`, async (t) => {
    const fixture = await recoveryFixture(t);
    let resumeCalls = 0;
    const herdr = recoveryHerdr({
      onResume() {
        resumeCalls += 1;
      },
      registered: () => false,
      duplicate: scenario === "duplicate native ownership",
      ambiguous: scenario === "ambiguous process state",
    });
    if (scenario === "missing cwd") {
      await rm(fixture.task.cwd, { recursive: true });
    } else if (scenario === "missing transcript") {
      await rm(fixture.transcript);
    } else if (scenario === "missing native identity") {
      fixture.agent.native_session = null;
      await writeRecord(fixture.registryDirectory, "agents", fixture.agent);
    } else if (scenario === "transcript metadata mismatch") {
      await writeFile(
        fixture.transcript,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "native-1", cwd: "/different/cwd" },
        })}\n`,
      );
    } else if (scenario === "launch drift") {
      const [path] = Object.keys(fixture.agent.launch.catalog_fingerprints);
      fixture.agent.launch.catalog_fingerprints[path] = "drifted";
      await writeRecord(fixture.registryDirectory, "agents", fixture.agent);
    }

    const result = await reconcileOrRecoverAgent(fixture.agent.id, {
      env: fixture.env,
      herdr,
      run:
        scenario === "launch unsatisfied"
          ? async () => {
              throw new Error("persisted Codex options are unsupported");
            }
          : compatibleCodex,
    });

    assert.equal(result.status, "recovery_blocked");
    assert.equal(resumeCalls, 0);
  });
}

async function compatibleCodex() {
  return "Codex help";
}

function recoveryHerdr({ onResume, registered, duplicate = false, ambiguous = false }) {
  return {
    async ensureSession() {},
    async agentRecord() {
      return registered()
        ? {
            name: "managed-agent",
            pane_id: "pane-agent-1",
            agent_status: "idle",
            agent_session: { value: "native-1" },
          }
        : null;
    },
    async agentRecords() {
      if (registered()) {
        return [
          {
            name: "managed-agent",
            pane_id: "pane-agent-1",
            agent_status: "idle",
            agent_session: { value: "native-1" },
          },
        ];
      }
      return duplicate
        ? [{ name: "other-managed", agent_session: { value: "native-1" } }]
        : [];
    },
    async paneProcessInfo() {
      return ambiguous
        ? { shell_pid: 10, foreground_processes: [{ pid: 11, name: "codex" }] }
        : { shell_pid: 10, foreground_processes: [{ pid: 10, name: "zsh" }] };
    },
    async resumeCodexAgent(options) {
      onResume(options);
    },
  };
}

async function recoveryFixture(t, { working = false } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "work");
  const codexHome = join(scratch, "codex");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const canonicalCwd = await realpath(cwd);
  const transcript = join(codexHome, "sessions", "rollout-native-1.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "native-1", cwd: canonicalCwd },
    })}\n`,
  );
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const configuration = await loadConfiguration({ env });
  const launch = resolveLaunchSpecification(configuration, {});
  const launchBinding = createAgentLaunchBinding(configuration, launch);
  const registryDirectory = stateDirectory(env);
  const group = {
    schema: "drovr.group/v1",
    id: "group-1",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  };
  const task = {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: group.id,
    cwd: canonicalCwd,
    status: "active",
    herdr: { tab_id: "tab-task-1", root_pane_id: "pane-agent-1" },
  };
  const agent = {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: task.id,
    status: "active",
    launch,
    launch_binding: launchBinding,
    herdr: { name: "managed-agent", pane_id: "pane-agent-1" },
    native_session: "native-1",
  };
  const turn = {
    schema: "drovr.turn/v1",
    id: "turn-1",
    agent_id: agent.id,
    task_id: task.id,
    status: working ? "working" : "completed",
    inputs: [{
      sequence: 1,
      caller_key: "input:1",
      payload_sha256: `sha256:${"d".repeat(64)}`,
      text: working ? "do not replay me" : "done",
    }],
    caller: {
      dispatch_key: "run:1/card:1/attempt:1",
      payload_sha256: `sha256:${"e".repeat(64)}`,
      metadata: { run_id: "run:1", card_id: "card:1" },
    },
    launch_binding: {
      schema: "drovr.launch-binding/v1",
      comparison_key: launchBinding.comparison_key,
      configuration_watermark: launchBinding.configuration_watermark,
      description_digest: `sha256:${"f".repeat(64)}`,
    },
  };
  await writeRecord(registryDirectory, "groups", group);
  await writeRecord(registryDirectory, "tasks", task);
  await writeRecord(registryDirectory, "agents", agent);
  await writeRecord(registryDirectory, "turns", turn);
  return { env, registryDirectory, task, agent, turn, transcript };
}

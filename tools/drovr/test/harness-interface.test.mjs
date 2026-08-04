import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createProductionSemanticHarness } from "../src/production-harness-adapter.mjs";
import { observeAgents } from "../src/observations.mjs";
import {
  SEMANTIC_HARNESS_EVIDENCE,
  SEMANTIC_HARNESS_INTERFACE,
  SEMANTIC_HARNESS_OPERATIONS,
  SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS,
  createSemanticHarness,
  identityEvidence,
} from "../src/harness-interface.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("semantic harness accepts harness-neutral delivery, observation, and recovery operations", async () => {
  const calls = [];
  const adapter = semanticAdapter({ calls, implementation: "trace-replay" });
  const harness = createSemanticHarness({ adapter });

  assert.equal(harness.schema, SEMANTIC_HARNESS_INTERFACE);
  assert.equal(harness.implementation, "trace-replay");
  assert.deepEqual(
    await harness.deliverTurn({ agent: { id: "agent-1" }, input: { key: "input-1" } }),
    { outcome: "submitted", evidence: "present" },
  );
  assert.deepEqual(
    await harness.waitForTurn({ agent: { id: "agent-1" }, turn: { id: "turn-1" } }),
    { outcome: "completed", evidence: "present", result: { text: "done" } },
  );
  assert.deepEqual(
    await harness.recoverStagedInput({
      agent: { id: "agent-1" },
      action: "clear",
      token: "snapshot-1",
    }),
    {
      outcome: "cleared",
      evidence: "present",
      stability: { interval_ms: 30_000, observations: 2 },
    },
  );
  assert.deepEqual(calls, ["deliverTurn", "waitForTurn", "recoverStagedInput"]);
});

test("identity evidence distinguishes exact, missing, changed, and uncertain observations", () => {
  const expected = {
    managed_agent: "drovr-agent-1",
    pane: "pane-1",
    native_session: "native-1",
  };

  assert.equal(identityEvidence(expected, expected).evidence, "present");
  assert.equal(identityEvidence(expected, null).evidence, "absent");
  const paneRebind = identityEvidence(expected, {
    ...expected,
    pane: "pane-2",
  });
  assert.equal(paneRebind.evidence, "present");
  assert.equal(paneRebind.pane_changed, true);
  assert.equal(
    identityEvidence(expected, {
      ...expected,
      native_session: "native-2",
    }).evidence,
    "changed",
  );
  assert.equal(
    identityEvidence(expected, undefined).evidence,
    "uncertain",
  );
  assert.deepEqual(SEMANTIC_HARNESS_EVIDENCE, [
    "present",
    "absent",
    "changed",
    "uncertain",
  ]);
});

test("production interrupt permits an exact managed identity without native binding", async () => {
  let observations = 0;
  let interruptions = 0;
  let interruptionOptions;
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: null,
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    herdr: {
      async agentRecord() {
        observations += 1;
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: observations === 1 ? "working" : "idle",
          agent_session: { value: "native-observed" },
        };
      },
      async interruptAgent(_name, options) {
        interruptions += 1;
        interruptionOptions = options;
      },
    },
  });

  const result = await harness.interruptTurn({ agent });

  assert.equal(result.outcome, "cancelled");
  assert.equal(interruptions, 1);
  assert.deepEqual(interruptionOptions, {
    nativeSession: "native-observed",
    paneId: "pane-1",
  });

  let blockedInterruptions = 0;
  const reboundHarness = createProductionSemanticHarness({
    harness: "codex",
    herdr: {
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-rebound",
          agent_status: "working",
        };
      },
      async interruptAgent() {
        blockedInterruptions += 1;
      },
    },
  });
  const rebound = await reboundHarness.interruptTurn({ agent });

  assert.equal(rebound.outcome, "uncertain");
  assert.match(rebound.error, /managed pane identity changed/u);
  assert.equal(blockedInterruptions, 0);
});

test("production turn correlation settles uncertain without an overall timeout", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-harness-correlation-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transcript = join(scratch, "session.jsonl");
  await writeFile(transcript, "");
  let now = 0;
  let pauses = 0;
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    monotonicNow: () => now,
    wallClock: () => 0,
    delay: async (milliseconds) => {
      pauses += 1;
      now += milliseconds;
    },
    herdr: {
      async waitForAgent() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          state_change_seq: 1,
          agent_session: { value: "native-1" },
        };
      },
    },
  });

  const result = await harness.waitForTurn({
    agent,
    turn: {
      inputs: [{ text: "missing from transcript" }],
      transcript_cursor: {
        adapter: "codex-jsonl/v1",
        path: transcript,
        offset: 0,
        anchor_start: 0,
        anchor_sha256: createHash("sha256").update("").digest("hex"),
      },
    },
  });

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.evidence, "present");
  assert.match(result.error, /not observed/u);
  assert.ok(now >= 5_000);
  assert.ok(pauses > 0);
});

test("production zero-timeout waits do not claim unobserved evidence", async () => {
  const harness = createProductionSemanticHarness({
    harness: "codex",
    herdr: {},
  });
  const result = await harness.waitForTurn({
    agent: {
      herdr: { name: "managed-agent", pane_id: "pane-1" },
      native_session: "native-1",
    },
    turn: { inputs: [] },
    timeoutMs: 0,
  });

  assert.equal(result.outcome, "still_running");
  assert.equal(result.evidence, "uncertain");
  assert.equal(result.observation, undefined);
});

test("production block resume reports a newer block before native working evidence", async () => {
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const harness = createProductionSemanticHarness({
    harness: "codex",
    herdr: {
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "blocked",
          agent_session: { value: "native-1" },
        };
      },
    },
  });
  const result = await harness.waitForTurn({
    agent,
    turn: { inputs: [] },
    afterBlock: {
      id: "acknowledged-block",
      transition_token: 4,
      working_observed: false,
    },
    refreshBlock: async () => ({ id: "new-block" }),
  });
  assert.equal(result.outcome, "block_changed");
  assert.deepEqual(result.block, { id: "new-block" });
});

test("production unknown-input staging settles on a mismatch or disappearing agent", async () => {
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  let recordCalls = 0;
  const mismatchHarness = createProductionSemanticHarness({
    harness: "claude",
    herdr: {
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async inspectStagedInput() {
        recordCalls += 1;
        return recordCalls === 1
          ? null
          : { token: "foreign", display_text: "different text" };
      },
      async sendPaneText() {},
    },
  });
  const mismatch = await mismatchHarness.stageUnknownInput({
    agent,
    text: "authorized text",
  });
  assert.equal(mismatch.outcome, "recovery_blocked");
  assert.equal(mismatch.evidence, "changed");

  let absentWrites = 0;
  const absentHarness = createProductionSemanticHarness({
    harness: "claude",
    herdr: {
      async agentRecord() {
        return null;
      },
      async inspectStagedInput() {
        return null;
      },
      async sendPaneText() {
        absentWrites += 1;
      },
    },
  });
  const absent = await absentHarness.stageUnknownInput({
    agent,
    text: "authorized text",
  });
  assert.equal(absent.outcome, "recovery_blocked");
  assert.equal(absent.evidence, "absent");
  assert.equal(absentWrites, 0);

  let disappearingCalls = 0;
  const disappearingHarness = createProductionSemanticHarness({
    harness: "claude",
    herdr: {
      async agentRecord() {
        disappearingCalls += 1;
        return disappearingCalls === 1
          ? {
              name: "managed-agent",
              pane_id: "pane-1",
              agent_status: "idle",
              agent_session: { value: "native-1" },
            }
          : null;
      },
      async inspectStagedInput() {
        return null;
      },
      async sendPaneText() {},
    },
  });
  const disappearing = await disappearingHarness.stageUnknownInput({
    agent,
    text: "authorized text",
  });
  assert.equal(disappearing.outcome, "recovery_blocked");
  assert.equal(disappearing.evidence, "absent");
});

test("production topology unknown-input writes require exact semantic agent identity", async () => {
  let writes = 0;
  const harness = createProductionSemanticHarness({
    harness: "codex",
    herdr: {
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-after",
          agent_status: "idle",
          agent_session: { value: "native-2" },
        };
      },
      async sendPaneText() {
        writes += 1;
      },
    },
  });
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-before" },
    native_session: "native-1",
  };

  await assert.rejects(
    () => harness.topology.sendUnknownInput({ agent, text: "unsafe" }),
    (error) => error.outcome === "recovery_blocked",
  );
  assert.equal(writes, 0);
});

test("public observations retain agent_lost for unsafe identity evidence", async () => {
  const agent = {
    id: "agent-1",
    launch: { harness: "codex" },
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const result = await observeAgents("delegates", [agent], {
    herdr: {
      async sessionRunning() {
        return true;
      },
      async agentRecords() {
        return [{
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: { value: "native-2" },
        }];
      },
    },
  });
  assert.deepEqual(result.observations.get(agent.id), {
    status: "agent_lost",
    reason: "native_session_mismatch",
  });
});

test("production topology translates Herdr records into semantic facts", async () => {
  const harness = createProductionSemanticHarness({
    herdr: {
      async paneRecord() {
        return { pane_id: "pane-1", tab_id: "tab-1", workspace_id: "workspace-1" };
      },
      async paneProcessInfo() {
        return { shell_pid: 10, foreground_processes: [{ pid: 10 }] };
      },
      async tabRecord() {
        return { tab_id: "tab-1", workspace_id: "workspace-1" };
      },
      async workspaceRecord() {
        return { workspace_id: "workspace-1" };
      },
      async paneLayout() {
        return { panes: [{ pane_id: "pane-1", rect: { width: 100, height: 50 } }] };
      },
    },
  });
  assert.deepEqual(await harness.topology.observePane("pane-1"), {
    paneId: "pane-1",
    tabId: "tab-1",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(await harness.topology.observePaneProcess("pane-1"), {
    shellPid: 10,
    foregroundProcesses: [{ pid: 10 }],
  });
  assert.deepEqual(await harness.topology.observeTab("tab-1"), {
    tabId: "tab-1",
    workspaceId: "workspace-1",
    rootPaneId: undefined,
  });
  assert.deepEqual(await harness.topology.observeWorkspace("workspace-1"), {
    workspaceId: "workspace-1",
    rootPaneId: undefined,
  });
  assert.deepEqual(await harness.topology.observeLayout("pane-1"), {
    panes: [{ paneId: "pane-1", geometry: { width: 100, height: 50 } }],
  });
});

test("production staged recovery reports a reappearing snapshot as changed evidence", async () => {
  let inspection = 0;
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const harness = createProductionSemanticHarness({
    harness: "claude",
    stabilityIntervalMs: 50,
    delay: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    herdr: {
      async agentRecord() {
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          state_change_seq: 7,
          agent_session: { value: "native-1" },
        };
      },
      async inspectStagedInput() {
        inspection += 1;
        if (inspection === 1) {
          return { token: "snapshot-1", display_text: "owned input" };
        }
        if (inspection === 2) return null;
        return { token: "snapshot-1", display_text: "owned input" };
      },
      async recoverStagedInput() {},
    },
  });

  const result = await harness.recoverStagedInput({
    agent,
    action: "clear",
    token: "snapshot-1",
  });

  assert.equal(result.outcome, "clear_contradicted");
  assert.equal(result.evidence, "changed");
  assert.equal(result.contradiction, "staged_snapshot_reappeared");
  assert.ok(result.stability.observations >= 2);
});

test("production staged recovery fails closed when native identity changes", async () => {
  let recordCalls = 0;
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const harness = createProductionSemanticHarness({
    harness: "claude",
    stabilityIntervalMs: 50,
    herdr: {
      async agentRecord() {
        recordCalls += 1;
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: {
            value: recordCalls === 1 ? "native-1" : "native-2",
          },
        };
      },
      async inspectStagedInput() {
        return { token: "snapshot-1", display_text: "owned input" };
      },
      async recoverStagedInput() {},
    },
  });

  const result = await harness.recoverStagedInput({
    agent,
    action: "clear",
    token: "snapshot-1",
  });

  assert.equal(result.outcome, "clear_unstable");
  assert.equal(result.evidence, "changed");
});

test("turn and lifecycle callers depend on the semantic seam, not low-level harness mechanisms", async () => {
  const callers = [
    "tools/drovr/src/turns.mjs",
    "tools/drovr/src/turn-lifecycle.mjs",
    "tools/drovr/src/lifecycle.mjs",
    "tools/drovr/src/recovery.mjs",
    "tools/drovr/src/staged-input.mjs",
    "tools/drovr/src/agent-start.mjs",
    "tools/drovr/src/task-open.mjs",
    "tools/drovr/src/observations.mjs",
    "tools/drovr/src/attach.mjs",
  ];
  for (const caller of callers) {
    const source = await readFile(`${root}/${caller}`, "utf8");
    assert.doesNotMatch(
      source,
      /HerdrClient|harnessAdapter|claude-transcript|codex-transcript/u,
      caller,
    );
    assert.doesNotMatch(source, /state_change_seq/u, caller);
    assert.doesNotMatch(
      source,
      /(?:pane\?\.tab_id|registeredTab\.workspace_id|processInfo\.(?:shell_pid|foreground_processes)|layout\.panes.*(?:pane_id|rect))/u,
      caller,
    );
    if (caller !== "tools/drovr/src/turn-lifecycle.mjs") {
      assert.match(source, /harness-interface\.mjs/u, caller);
    }
  }
  const turnLifecycle = await readFile(
    `${root}/tools/drovr/src/turn-lifecycle.mjs`,
    "utf8",
  );
  assert.match(turnLifecycle, /harness\.prepareTurn/u);
  assert.match(turnLifecycle, /harness\.deliverTurn/u);
  const lifecycle = await readFile(`${root}/tools/drovr/src/lifecycle.mjs`, "utf8");
  assert.match(lifecycle, /requireCompatibilityBinding:\s*false/u);
  const attach = await readFile(`${root}/tools/drovr/src/attach.mjs`, "utf8");
  assert.match(attach, /requireCompatibilityBinding:\s*false/u);
});

function semanticAdapter({ calls, implementation }) {
  return {
    ...Object.fromEntries(
      SEMANTIC_HARNESS_OPERATIONS.map((operation) => [
        operation,
        async () => ({ outcome: "not_exercised", evidence: "uncertain" }),
      ]),
    ),
    topology: Object.fromEntries(
      SEMANTIC_HARNESS_TOPOLOGY_OPERATIONS.map((operation) => [
        operation,
        async () => ({ outcome: "not_exercised", evidence: "uncertain" }),
      ]),
    ),
    schema: SEMANTIC_HARNESS_INTERFACE,
    implementation,
    async deliverTurn() {
      calls.push("deliverTurn");
      return { outcome: "submitted", evidence: "present" };
    },
    async waitForTurn() {
      calls.push("waitForTurn");
      return {
        outcome: "completed",
        evidence: "present",
        result: { text: "done" },
      };
    },
    async recoverStagedInput() {
      calls.push("recoverStagedInput");
      return {
        outcome: "cleared",
        evidence: "present",
        stability: { interval_ms: 30_000, observations: 2 },
      };
    },
  };
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createProductionSemanticHarness } from "../src/production-harness-adapter.mjs";
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
  assert.equal(
    identityEvidence(expected, { ...expected, pane: "pane-2" }).evidence,
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

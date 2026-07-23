import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeBlockRecord,
  blockRepresentsActiveTransition,
  createBlockRecord,
  observeBlockWorking,
} from "../src/block-record.mjs";

test("block registry transitions preserve one acknowledgement and working observation", () => {
  const block = createBlockRecord({
    id: "block-1",
    turnId: "turn-1",
    agentId: "agent-1",
    taskId: "task-1",
    harness: "codex",
    excerpt: "Approval required",
    createdAt: "2026-07-23T10:00:00.000Z",
  });

  acknowledgeBlockRecord(block, {
    acknowledgedAt: "2026-07-23T10:00:01.000Z",
  });
  acknowledgeBlockRecord(block, {
    acknowledgedAt: "2026-07-23T10:00:02.000Z",
  });
  observeBlockWorking(block, {
    observedAt: "2026-07-23T10:00:03.000Z",
  });

  assert.deepEqual(block, {
    schema: "drovr.block/v1",
    id: "block-1",
    turn_id: "turn-1",
    agent_id: "agent-1",
    task_id: "task-1",
    harness: "codex",
    status: "acknowledged",
    excerpt: "Approval required",
    attach: { command: "drovr attach agent-1" },
    created_at: "2026-07-23T10:00:00.000Z",
    acknowledged_at: "2026-07-23T10:00:01.000Z",
    working_observed_at: "2026-07-23T10:00:03.000Z",
  });
});

test("Herdr state-change tokens distinguish later blocked transitions", () => {
  const block = createBlockRecord({
    id: "block-1",
    turnId: "turn-1",
    agentId: "agent-1",
    taskId: "task-1",
    harness: "codex",
    excerpt: "Approval required",
    herdrStateChangeSeq: 41,
    createdAt: "2026-07-23T10:00:00.000Z",
  });

  assert.deepEqual(block.herdr, { state_change_seq: 41 });
  assert.equal(
    blockRepresentsActiveTransition(block, { herdrStateChangeSeq: 41 }),
    true,
  );
  assert.equal(
    blockRepresentsActiveTransition(block, { herdrStateChangeSeq: 43 }),
    false,
  );
});

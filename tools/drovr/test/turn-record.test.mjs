import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTurnInput,
  createTurnRecord,
  settleTurnRecord,
} from "../src/turn-record.mjs";

test("turn registry transitions preserve ordered inputs and reject closed turns", () => {
  const turn = createTurnRecord({
    id: "turn-1",
    agentId: "agent-1",
    taskId: "task-1",
    prompt: "initial",
    submittedAt: "2026-07-23T10:00:00.000Z",
    transcriptCursor: { adapter: "codex-jsonl/v1", offset: 10 },
  });

  appendTurnInput(turn, {
    text: "first steering input",
    submittedAt: "2026-07-23T10:00:01.000Z",
  });
  appendTurnInput(turn, {
    text: "second steering input",
    submittedAt: "2026-07-23T10:00:02.000Z",
  });

  assert.deepEqual(
    turn.inputs.map(({ sequence, text }) => ({ sequence, text })),
    [
      { sequence: 1, text: "initial" },
      { sequence: 2, text: "first steering input" },
      { sequence: 3, text: "second steering input" },
    ],
  );

  settleTurnRecord(turn, {
    status: "completed",
    result: { text: "settled", messages: ["settled"] },
    settledAt: "2026-07-23T10:00:03.000Z",
  });

  assert.throws(
    () =>
      appendTurnInput(turn, {
        text: "too late",
        submittedAt: "2026-07-23T10:00:04.000Z",
      }),
    { outcome: "turn_closed", code: 0 },
  );
});

test("caller-owned turns bind ordered inputs and terminal proof to the exact launch", () => {
  const turn = createTurnRecord({
    id: "turn-1",
    agentId: "agent-1",
    taskId: "task-1",
    prompt: "initial",
    submittedAt: "2026-07-23T10:00:00.000Z",
    transcriptCursor: { adapter: "codex-jsonl/v1", offset: 10 },
    caller: {
      dispatch_key: "run:1/card:review/attempt:1",
      metadata: { run_id: "run:1", card_id: "review" },
    },
    inputKey: "input:1",
    launchBinding: {
      schema: "drovr.launch-binding/v1",
      comparison_key: `sha256:${"a".repeat(64)}`,
      configuration_watermark: `sha256:${"b".repeat(64)}`,
      description_digest: `sha256:${"c".repeat(64)}`,
    },
  });

  appendTurnInput(turn, {
    callerKey: "input:2",
    text: "steer",
    submittedAt: "2026-07-23T10:00:01.000Z",
  });
  settleTurnRecord(turn, {
    status: "completed",
    result: { text: "settled", messages: ["settled"] },
    settledAt: "2026-07-23T10:00:02.000Z",
  });

  assert.deepEqual(turn.caller, {
    dispatch_key: "run:1/card:review/attempt:1",
    metadata: { run_id: "run:1", card_id: "review" },
  });
  assert.deepEqual(
    turn.inputs.map(({ sequence, caller_key, payload_sha256 }) => ({
      sequence,
      caller_key,
      payload_sha256,
    })),
    [
      {
        sequence: 1,
        caller_key: "input:1",
        payload_sha256:
          "sha256:ac1b5c0961a7269b6a053ee64276ed0e20a7f48aefb9f67519539d23aaf10149",
      },
      {
        sequence: 2,
        caller_key: "input:2",
        payload_sha256:
          "sha256:57fce44d7c6df51ad8525da1580a246e9d1142d79d1d1f176b1d29643d61ed44",
      },
    ],
  );
  assert.deepEqual(turn.settlement_proof, {
    schema: "drovr.turn-settlement-proof/v1",
    classification: "exact_transcript_correlation",
    launch_comparison_key: `sha256:${"a".repeat(64)}`,
    configuration_watermark: `sha256:${"b".repeat(64)}`,
    description_digest: `sha256:${"c".repeat(64)}`,
    ordered_inputs: turn.inputs.map(
      ({ sequence, caller_key, payload_sha256 }) => ({
        sequence,
        caller_key,
        payload_sha256,
        delivery_proof: "exact_transcript_correlation",
      }),
    ),
  });
});

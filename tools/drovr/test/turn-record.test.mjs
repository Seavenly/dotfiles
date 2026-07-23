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

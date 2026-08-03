import { randomUUID } from "node:crypto";

import { writeRecord } from "./registry.mjs";
import { createTurnRecord, settleTurnRecord } from "./turn-record.mjs";

export async function prepareTurn({
  registryDirectory,
  agent,
  task,
  harness,
  prompt,
  now,
  inventoryBeforeDelivery = false,
  transitionToken,
  caller,
  inputKey,
  launchBinding,
}) {
  const prepared = await harness.prepareTurn({
    agent,
    task,
    now,
    inventoryBeforeDelivery,
  });
  const submittedAt = now();
  const turn = createTurnRecord({
    id: randomUUID(),
    agentId: agent.id,
    taskId: task.id,
    prompt,
    submittedAt,
    transcriptCursor: prepared.cursor,
    transitionToken,
    caller,
    inputKey,
    launchBinding,
  });
  await writeRecord(registryDirectory, "turns", turn);
  return turn;
}

export async function deliverTurn({
  registryDirectory,
  agent,
  turn,
  prompt,
  harness,
  now,
}) {
  try {
    const result = await harness.deliverTurn({ agent, prompt });
    const input = turn.inputs.at(-1);
    if (input?.delivery?.status === "recorded") {
      input.delivery = { status: "submitted", accepted_at: now() };
      await writeRecord(registryDirectory, "turns", turn);
    }
    return result;
  } catch (error) {
    if (error.details?.staged_input?.ownership === "drovr") {
      turn.staged_input = error.details.staged_input;
      turn.late_result_recovery = "exact_transcript_correlation";
    }
    settleTurnRecord(turn, {
      status: "uncertain",
      error: error.message,
      settledAt: now(),
    });
    await writeRecord(registryDirectory, "turns", turn);
    throw error;
  }
}

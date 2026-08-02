import { randomUUID } from "node:crypto";

import { writeRecord } from "./registry.mjs";
import { createTurnRecord, settleTurnRecord } from "./turn-record.mjs";

export async function prepareTurn({
  registryDirectory,
  agent,
  task,
  adapter,
  prompt,
  now,
  inventoryBeforeDelivery = false,
  herdrStateChangeSeq,
  caller,
  inputKey,
  launchBinding,
}) {
  let cursor;
  if (agent.native_session && !inventoryBeforeDelivery) {
    const transcriptPath = await adapter.locate(
      adapter.root,
      agent.native_session,
    );
    cursor = await adapter.captureCursor(transcriptPath);
  } else {
    cursor = await adapter.captureInventory(adapter.root, task.cwd, now());
  }
  const submittedAt = now();
  const turn = createTurnRecord({
    id: randomUUID(),
    agentId: agent.id,
    taskId: task.id,
    prompt,
    submittedAt,
    transcriptCursor: cursor,
    herdrStateChangeSeq,
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
  herdr,
  now,
}) {
  try {
    const result = await herdr.prompt(agent.herdr.name, prompt, {
      harness: agent.launch.harness,
    });
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

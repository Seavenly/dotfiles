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
    return await herdr.prompt(agent.herdr.name, prompt);
  } catch (error) {
    settleTurnRecord(turn, {
      status: "uncertain",
      error: error.message,
      settledAt: now(),
    });
    await writeRecord(registryDirectory, "turns", turn);
    throw error;
  }
}

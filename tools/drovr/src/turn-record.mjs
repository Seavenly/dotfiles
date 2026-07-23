import { DrovrError } from "./errors.mjs";

export function createTurnRecord({
  id,
  agentId,
  taskId,
  prompt,
  submittedAt,
  transcriptCursor,
}) {
  return {
    schema: "drovr.turn/v1",
    id,
    agent_id: agentId,
    task_id: taskId,
    status: "working",
    inputs: [{ sequence: 1, text: prompt, submitted_at: submittedAt }],
    transcript_cursor: transcriptCursor,
    created_at: submittedAt,
  };
}

export function appendTurnInput(turn, { text, submittedAt }) {
  requireOpenTurn(turn);
  const sequence = (turn.inputs.at(-1)?.sequence ?? 0) + 1;
  const input = { sequence, text, submitted_at: submittedAt };
  turn.inputs.push(input);
  return input;
}

export function settleTurnRecord(turn, { status, result, error, settledAt }) {
  requireOpenTurn(turn);
  turn.status = status;
  if (result !== undefined) turn.result = result;
  if (error !== undefined) turn.error = error;
  turn.settled_at = settledAt;
  return turn;
}

function requireOpenTurn(turn) {
  if (turn.status !== "working") {
    throw new DrovrError(`logical turn ${turn.id} is closed`, {
      code: 0,
      outcome: "turn_closed",
    });
  }
}

import { DrovrError } from "./errors.mjs";

// A `--prompt-file` or standard-input prompt arrives with the terminating newline
// that ends the file, which is not part of the submission and which Codex does not
// write back into its transcript. Normalizing an input once, before it becomes
// durable, keeps the recorded text equal to the text a harness will record, which
// is what transcript correlation compares.
export function normalizeInputText(text) {
  return text.trimEnd();
}

export function createTurnRecord({
  id,
  agentId,
  taskId,
  prompt,
  submittedAt,
  transcriptCursor,
  herdrStateChangeSeq,
}) {
  return {
    schema: "drovr.turn/v1",
    id,
    agent_id: agentId,
    task_id: taskId,
    status: "working",
    inputs: [{ sequence: 1, text: prompt, submitted_at: submittedAt }],
    transcript_cursor: transcriptCursor,
    ...(Number.isSafeInteger(herdrStateChangeSeq)
      ? { herdr: { state_change_seq_before_delivery: herdrStateChangeSeq } }
      : {}),
    created_at: submittedAt,
  };
}

export function turnAwaitsPostDeliverySettlement(
  turn,
  herdrStateChangeSeq,
) {
  const stateChangeSeqBeforeDelivery =
    turn.herdr?.state_change_seq_before_delivery;
  return (
    Number.isSafeInteger(stateChangeSeqBeforeDelivery) &&
    Number.isSafeInteger(herdrStateChangeSeq) &&
    herdrStateChangeSeq <= stateChangeSeqBeforeDelivery
  );
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

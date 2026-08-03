import { createHash } from "node:crypto";

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
  transitionToken,
  herdrStateChangeSeq,
  caller,
  inputKey,
  launchBinding,
}) {
  return {
    schema: "drovr.turn/v1",
    id,
    agent_id: agentId,
    task_id: taskId,
    status: "working",
    inputs: [inputRecord({
      sequence: 1,
      text: prompt,
      submittedAt,
      callerKey: inputKey,
    })],
    ...(caller ? { caller: structuredClone(caller) } : {}),
    ...(launchBinding
      ? { launch_binding: structuredClone(launchBinding) }
      : {}),
    transcript_cursor: transcriptCursor,
    ...(Number.isSafeInteger(transitionToken ?? herdrStateChangeSeq)
      ? {
          herdr: {
            state_change_seq_before_delivery:
              transitionToken ?? herdrStateChangeSeq,
          },
        }
      : {}),
    created_at: submittedAt,
  };
}

export function turnAwaitsPostDeliverySettlement(
  turn,
  transitionToken,
) {
  const stateChangeSeqBeforeDelivery =
    turn.herdr?.state_change_seq_before_delivery;
  return (
    Number.isSafeInteger(stateChangeSeqBeforeDelivery) &&
    Number.isSafeInteger(transitionToken) &&
    transitionToken <= stateChangeSeqBeforeDelivery
  );
}

export function appendTurnInput(turn, { callerKey, text, submittedAt }) {
  requireOpenTurn(turn);
  const sequence = (turn.inputs.at(-1)?.sequence ?? 0) + 1;
  const input = inputRecord({ sequence, text, submittedAt, callerKey });
  turn.inputs.push(input);
  return input;
}

export function settleTurnRecord(turn, { status, result, error, settledAt }) {
  requireOpenTurn(turn);
  turn.status = status;
  if (result !== undefined) turn.result = result;
  if (error !== undefined) turn.error = error;
  turn.settled_at = settledAt;
  if (turn.launch_binding) {
    turn.settlement_proof = {
      schema: "drovr.turn-settlement-proof/v1",
      classification: terminalProofClassification(status),
      launch_comparison_key: turn.launch_binding.comparison_key,
      configuration_watermark:
        turn.launch_binding.configuration_watermark,
      description_digest: turn.launch_binding.description_digest,
      ordered_inputs: turn.inputs.map(
        ({ sequence, caller_key, payload_sha256 }) => ({
          sequence,
          caller_key,
          payload_sha256,
          delivery_proof: inputDeliveryProof(status),
        }),
      ),
    };
  }
  return turn;
}

function inputDeliveryProof(status) {
  return status === "completed"
    ? "exact_transcript_correlation"
    : "unproven";
}

function inputRecord({ sequence, text, submittedAt, callerKey }) {
  return {
    sequence,
    ...(callerKey
      ? {
          caller_key: callerKey,
          payload_sha256: `sha256:${createHash("sha256")
            .update(text)
            .digest("hex")}`,
          delivery: { status: "recorded" },
        }
      : {}),
    text,
    submitted_at: submittedAt,
  };
}

export function terminalProofClassification(status) {
  return {
    completed: "exact_transcript_correlation",
    cancelled: "native_interruption_settlement",
    interrupted: "interruption_unconfirmed",
    uncertain: "indeterminate",
    unsupported_transcript: "transcript_unavailable",
  }[status] ?? "terminal_without_result";
}

function requireOpenTurn(turn) {
  if (turn.status !== "working") {
    throw new DrovrError(`logical turn ${turn.id} is closed`, {
      code: 0,
      outcome: "turn_closed",
    });
  }
}

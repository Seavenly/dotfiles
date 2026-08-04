import { createHash } from "node:crypto";

export function createStagedInputReceipt({ agentName, observed, prompt, snapshot }) {
  const receipt = {
    ownership: "drovr",
    snapshot_token: stagedInputTextToken(snapshot.display_text),
    display_text: snapshot.display_text,
    prompt_sha256: sha256(prompt),
    agent_name: agentName,
    pane_id: observed.pane_id,
    native_session: observed.agent_session?.value,
    state_change_seq_before_delivery: observed.state_change_seq,
  };
  return {
    ...receipt,
    token: sha256(JSON.stringify(receipt)),
  };
}

export function bindStagedInputToken(snapshotToken, transitionToken) {
  if (!Number.isSafeInteger(transitionToken)) return null;
  return sha256(JSON.stringify({ snapshotToken, transitionToken }));
}

export function stagedInputTextToken(displayText) {
  return sha256(displayText);
}

export function ownedStagedTurn(turn, agent, snapshot) {
  const receipt = turn.staged_input;
  const textToken =
    typeof snapshot?.display_text === "string"
      ? stagedInputTextToken(snapshot.display_text)
      : null;
  const legacyBoundToken = bindStagedInputToken(
    textToken,
    receipt?.state_change_seq_before_delivery,
  );
  return (
    turn.agent_id === agent.id &&
    turn.status === "uncertain" &&
    receipt?.ownership === "drovr" &&
    !receipt.recovery &&
    (receipt.snapshot_token === textToken ||
      receipt.snapshot_token === legacyBoundToken) &&
    receipt.prompt_sha256 === sha256(turn.inputs.at(-1)?.text ?? "") &&
    receipt.agent_name === agent.herdr.name &&
    receipt.pane_id === agent.herdr.pane_id &&
    receipt.native_session === agent.native_session &&
    Number.isSafeInteger(receipt.state_change_seq_before_delivery)
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

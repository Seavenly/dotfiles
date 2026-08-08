import assert from "node:assert/strict";
import test from "node:test";

import {
  bindStagedInputToken,
  createStagedInputReceipt,
  ownedStagedTurn,
  stagedInputTextToken,
} from "../src/staged-input-receipt.mjs";

test("owned staged receipts survive transition changes and the intermediate token shape", () => {
  const agent = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const prompt = "Exact staged work";
  const receipt = createStagedInputReceipt({
    agentName: agent.herdr.name,
    observed: {
      pane_id: agent.herdr.pane_id,
      agent_session: { value: agent.native_session },
      state_change_seq: 12,
    },
    prompt,
    snapshot: {
      token: stagedInputTextToken(prompt),
      display_text: prompt,
    },
  });
  const turn = {
    agent_id: agent.id,
    status: "uncertain",
    inputs: [{ text: prompt }],
    staged_input: receipt,
  };
  const currentSnapshot = {
    token: bindStagedInputToken(receipt.snapshot_token, 13),
    display_text: prompt,
  };

  assert.equal(ownedStagedTurn(turn, agent, currentSnapshot), true);
  assert.equal(
    ownedStagedTurn(turn, agent, {
      token: bindStagedInputToken(stagedInputTextToken("Other work"), 13),
      display_text: "Other work",
    }),
    false,
  );
  assert.equal(
    ownedStagedTurn(
      turn,
      { ...agent, herdr: { ...agent.herdr, pane_id: "pane-2" } },
      currentSnapshot,
    ),
    false,
  );
  assert.equal(
    ownedStagedTurn(
      {
        ...turn,
        staged_input: {
          ...receipt,
          snapshot_token: bindStagedInputToken(receipt.snapshot_token, 12),
        },
      },
      agent,
      currentSnapshot,
    ),
    true,
  );
});

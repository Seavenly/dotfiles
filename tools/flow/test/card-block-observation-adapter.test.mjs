import assert from "node:assert/strict";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { observeCardBlock } from
  "../src/card-block-observation-adapter.mjs";

test("the card-block Adapter emits immutable digest-bound evidence", () => {
  const block = {
    schema: "flow.card-block/v1",
    id: "confirm-plan:repository-write",
    type: "capability_required",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "capability_required",
      code: "repository_write_required",
    },
    required_capabilities: ["repository:write"],
    revision_template_ids: [],
  };

  const observation = observeCardBlock({
    card_id: "confirm-plan",
    block,
  });
  const { schema: _schema, evidence_digest: _digest, ...evidence } = observation;

  assert.deepEqual(observation, {
    schema: "flow.card-block-observation/v1",
    adapter_contract: "flow.adapter/card-block-observation/v1",
    validator_contract: "flow.validator/card-block-observation/v1",
    card_id: "confirm-plan",
    block,
    evidence_digest: digest(evidence),
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.block), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createDeepResearchSelection, validateDeepResearchSelection, researchQuestion } from "../src/deep-research-contract.mjs";

test("deep selection retains two supplied angle bytes and deterministic identities", () => {
  const selection = createDeepResearchSelection({ angles: [" Delivery guarantees ", "Integrity limitations"] });
  assert.deepEqual(selection.angles, [{ angle_id: "angle:1", text: " Delivery guarantees " }, { angle_id: "angle:2", text: "Integrity limitations" }]);
  assert.equal(selection.parallel, 2);
  assert.equal(selection.max_cycles, 2);
  assert.equal(validateDeepResearchSelection(selection), true);
  assert.equal(Object.isFrozen(selection), true);
});

test("closed deep selection rejects unsafe, duplicate, oversized or caller-shaped choices", () => {
  for (const angles of [["same", " same "], ["one"], ["one", "two", "three"], ["é".repeat(513), "two"], ["Read /home/operator/private", "two"]]) {
    assert.throws(() => createDeepResearchSelection({ angles }), { code: "invalid_deep_research_selection" });
  }
  const selection = createDeepResearchSelection({ angles: ["one", "two"], parallel: 1, max_cycles: 1 });
  for (const changed of [{ ...selection, parallel: 3 }, { ...selection, max_cycles: 0 }, { ...selection, unknown: true },
    { ...selection, angles: [{ angle_id: "invented", text: "one" }, selection.angles[1]] }]) {
    assert.equal(validateDeepResearchSelection(changed), false);
  }
});

test("replacement questions retain exact safe text under the original question bound", () => {
  assert.equal(researchQuestion("What differs?").text, "What differs?");
  for (const text of ["", "x".repeat(4097), "Read /home/operator/private"]) assert.equal(researchQuestion(text), null);
});

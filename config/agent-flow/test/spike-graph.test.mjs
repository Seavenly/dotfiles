import assert from "node:assert/strict";
import test from "node:test";

import { compileSpikeGraph } from "../src/spike-graph.mjs";
import { validateContract } from "../src/schema-validator.mjs";

test("quick research joins directly into synthesis without a product worktree", async () => {
  const graph = compileSpikeGraph({ mode: "quick", angles: [], maxRevisions: 0, prototype: false });
  assert.deepEqual(await validateContract(graph), { valid: true, errors: [] });
  assert.equal(hasPath(graph, "research", "synthesis"), true);
  assert.equal(graph.stages.some(({ workspace }) => workspace === "feature-worktree"), false);
});

test("deep research joins parallel angles through a bounded gap critic", async () => {
  const graph = compileSpikeGraph({
    mode: "deep",
    angles: ["correctness", "operations", "alternatives"],
    maxRevisions: 2,
    prototype: true,
  });
  assert.deepEqual(await validateContract(graph), { valid: true, errors: [] });
  for (const key of ["angle:correctness", "angle:operations", "angle:alternatives"]) {
    assert.equal(hasPath(graph, key, "gap-critic"), true);
  }
  assert.equal(graph.transitions[0].key, "gap-revision");
  assert.equal(graph.transitions[0].max_instances, 2);
  assert.deepEqual(
    [...new Set(graph.stages.filter(({ workspace }) => workspace === "feature-worktree").map(({ workspace }) => workspace))],
    ["feature-worktree"],
  );
  assert.equal(hasPath(graph, "prototype-builder:1", "spike-root"), true);
});

function hasPath(graph, from, to) {
  const queue = [from];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const { child } of graph.dependencies.filter(({ parent }) => parent === current)) {
      if (child === to) return true;
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return false;
}

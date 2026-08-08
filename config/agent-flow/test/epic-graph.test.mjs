import assert from "node:assert/strict";
import test from "node:test";

import { compileEpicGraph } from "../src/epic-graph.mjs";
import { validateContract } from "../src/schema-validator.mjs";

test("epic graph serializes source verification and declares target refresh", async () => {
  const graph = compileEpicGraph({ featureCount: 4 });
  assert.deepEqual(await validateContract(graph), { valid: true, errors: [] });
  assert.equal(graph.transitions[0].key, "source-refresh");
  assert.equal(graph.transitions[0].stages.some(({ key }) => key === "source-refresh-review"), true);
  assert.equal(hasPath(graph, "source-verification", "epic-root"), true);
});

function hasPath(graph, from, to) {
  const queue = [from]; const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    for (const { child } of graph.dependencies.filter(({ parent }) => parent === current)) {
      if (child === to) return true;
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return false;
}

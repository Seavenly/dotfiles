import assert from "node:assert/strict";
import test from "node:test";

import { compileFeatureGraph } from "../src/feature-graph.mjs";
import { validateContract } from "../src/schema-validator.mjs";

test("approved feature slices compile into one serialized worktree chain", async () => {
  const graph = compileFeatureGraph({
    slices: [
      { id: "api", title: "Add API", verification: "npm test -- api" },
      { id: "ui", title: "Add UI", verification: "npm test -- ui" },
    ],
    maxSliceRetries: 2,
    maxCompletenessFixes: 1,
    maxCritiqueFixes: 1,
  });

  assert.deepEqual(await validateContract(graph), { valid: true, errors: [] });
  assert.equal(graph.flow, "feature");
  assert.equal(graph.root, "feature-root");
  assert.equal(graph.stages.some(({ key }) => key === "planner"), false);
  for (const stage of graph.stages) {
    if (["builder", "critic"].includes(stage.profile)) {
      assert.equal(stage.workspace, "feature-worktree", stage.key);
    }
  }
  assert.equal(hasPath(graph, "tester:1", "tester:2"), true);
  assert.equal(hasPath(graph, "tester:2", "feature-root"), true);
  assert.deepEqual(
    graph.transitions.map(({ key, max_instances }) => [key, max_instances]),
    [
      ["slice-retry:1", 2],
      ["slice-retry:2", 2],
      ["completeness-fix", 1],
      ["critique-fix", 1],
    ],
  );
  const completenessFix = graph.transitions.find(({ key }) => key === "completeness-fix");
  assert.equal(completenessFix.stages.some(({ key }) => key === "completeness:fix"), true);
  assert.equal(
    completenessFix.dependencies.some(({ parent, child }) =>
      parent === "validate-handoff:completeness:fix" && child === "completeness-controller"
    ),
    true,
  );
  const critiqueFix = graph.transitions.find(({ key }) => key === "critique-fix");
  assert.equal(critiqueFix.stages.some(({ key }) => key === "independent-critic:fix"), true);
});

test("feature planning fallback is explicit and bounded", async () => {
  const graph = compileFeatureGraph({
    slices: [],
    maxSliceRetries: 3,
    maxCompletenessFixes: 2,
    maxCritiqueFixes: 2,
  });

  assert.deepEqual(await validateContract(graph), { valid: true, errors: [] });
  assert.equal(hasPath(graph, "planner", "plan-controller"), true);
  assert.equal(hasPath(graph, "plan-controller", "feature-root"), true);
  assert.equal(
    graph.transitions.find(({ key }) => key === "planned-slice").max_instances,
    32,
  );
});

test("feature manifests pin observable slices and verification", async () => {
  const manifest = {
    schema: "agent-flow.feature/v1",
    run_id: "feature-one",
    summary: "Implement one feature",
    repo: "/tmp/repository",
    base: { branch: "main", sha: "a".repeat(40) },
    branch: "agent-flow/feature-one",
    kanban: { board: "features", task: "root" },
    external_ref: null,
    acceptance: ["The command prints the result"],
    slices: [{
      id: "result",
      title: "Print the result",
      verification: [{ argv: ["npm", "test"] }],
    }],
    verification: [{ argv: ["npm", "test"] }],
    limits: {
      max_slice_retries: 2,
      max_completeness_fixes: 1,
      max_critique_fixes: 1,
      max_elapsed_seconds: 3600,
    },
  };
  assert.deepEqual(await validateContract(manifest), { valid: true, errors: [] });

  manifest.slices[0].verification = [];
  assert.equal((await validateContract(manifest)).valid, false);
});

function hasPath(graph, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of graph.dependencies.filter(({ parent }) => parent === current)) {
      if (edge.child === to) return true;
      if (!seen.has(edge.child)) {
        seen.add(edge.child);
        queue.push(edge.child);
      }
    }
  }
  return false;
}

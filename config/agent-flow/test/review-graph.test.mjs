import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateContract } from "../src/schema-validator.mjs";

test("canonical local review graph pins the standard review topology", async () => {
  const graph = JSON.parse(
    await readFile(
      new URL("../graphs/local-review.v1.json", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(await validateContract(graph), { valid: true, errors: [] });
  assert.equal(graph.root, "review-root");
  assert.deepEqual(
    Object.fromEntries(
      graph.stages.map(({ key, ...contract }) => [key, contract]),
    ),
    {
      "review-root": stage("flow-controller", "run-dir", "review-flow-controller"),
      "lens:correctness": stage("analyst", "candidate-worktree", "review-lens", {
        maxAttempts: 2,
        semanticMeasurement: true,
      }),
      "validate-handoff:lens:correctness": validator("lens:correctness"),
      "lens:security": stage("analyst", "candidate-worktree", "review-lens", {
        maxAttempts: 2,
        semanticMeasurement: true,
      }),
      "validate-handoff:lens:security": validator("lens:security"),
      "lens:tests": stage("analyst", "candidate-worktree", "review-lens", {
        maxAttempts: 2,
        semanticMeasurement: true,
      }),
      "validate-handoff:lens:tests": validator("lens:tests"),
      "lens:style": stage("analyst", "candidate-worktree", "review-lens", {
        maxAttempts: 2,
        semanticMeasurement: true,
        optional: true,
      }),
      "validate-handoff:lens:style": validator("lens:style"),
      "lens:observability": stage(
        "analyst",
        "candidate-worktree",
        "review-lens",
        {
          maxAttempts: 2,
          semanticMeasurement: true,
          optional: true,
        },
      ),
      "validate-handoff:lens:observability": validator("lens:observability"),
      critic: stage("critic", "candidate-worktree", "review-critic", {
        maxAttempts: 2,
        semanticMeasurement: true,
      }),
      "validate-handoff:critic": validator("critic"),
      orientation: stage("analyst", "candidate-worktree", "review-orientation", {
        maxAttempts: 2,
        optional: true,
      }),
      "validate-handoff:orientation": validator("orientation"),
      diagram: stage("artifact", "candidate-worktree", "review-diagram", {
        optional: true,
      }),
      "validate-handoff:diagram": validator("diagram"),
      finalize: stage("gate", "run-dir", "review-finalizer"),
    },
  );
  assert.deepEqual(
    graph.dependencies,
    [
      ["lens:correctness", "validate-handoff:lens:correctness"],
      ["validate-handoff:lens:correctness", "critic"],
      ["lens:security", "validate-handoff:lens:security"],
      ["validate-handoff:lens:security", "critic"],
      ["lens:tests", "validate-handoff:lens:tests"],
      ["validate-handoff:lens:tests", "critic"],
      ["lens:style", "validate-handoff:lens:style"],
      ["validate-handoff:lens:style", "finalize"],
      ["lens:observability", "validate-handoff:lens:observability"],
      ["validate-handoff:lens:observability", "finalize"],
      ["critic", "validate-handoff:critic"],
      ["validate-handoff:critic", "finalize"],
      ["orientation", "validate-handoff:orientation"],
      ["validate-handoff:orientation", "finalize"],
      ["diagram", "validate-handoff:diagram"],
      ["validate-handoff:diagram", "finalize"],
      ["finalize", "review-root"],
    ].map(([parent, child]) => ({ parent, child })),
  );
});

function stage(
  profile,
  workspace,
  skill,
  {
    maxAttempts = 1,
    semanticMeasurement = false,
    validatesHandoffFor = null,
    optional = false,
  } = {},
) {
  return {
    profile,
    workspace,
    skill,
    max_attempts: maxAttempts,
    semantic_measurement: semanticMeasurement,
    validates_handoff_for: validatesHandoffFor,
    optional,
  };
}

function validator(producer) {
  return stage("gate", "run-dir", "handoff-validator", {
    validatesHandoffFor: producer,
  });
}

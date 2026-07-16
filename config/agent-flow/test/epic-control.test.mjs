import assert from "node:assert/strict";
import test from "node:test";

import {
  planReadyWave,
  reconcileEpicTarget,
  validateFeatureDependencies,
} from "../src/epic-control.mjs";

const features = [
  { id: "core", depends_on: [] },
  { id: "api", depends_on: ["core"] },
  { id: "ui", depends_on: ["core"] },
  { id: "docs", depends_on: ["api", "ui"] },
];

test("epic dependencies reject cycles and materialize only bounded ready waves", () => {
  assert.deepEqual(validateFeatureDependencies(features), features);
  assert.deepEqual(planReadyWave({
    features,
    statuses: { core: "pending", api: "pending", ui: "pending", docs: "pending" },
    maxStreams: 2,
  }), ["core"]);
  assert.deepEqual(planReadyWave({
    features,
    statuses: { core: "integrated", api: "pending", ui: "pending", docs: "pending" },
    maxStreams: 1,
  }), ["api"]);
  assert.throws(() => validateFeatureDependencies([
    { id: "one", depends_on: ["two"] },
    { id: "two", depends_on: ["one"] },
  ]), /cycle/);
});

test("target drift always creates a new source refresh generation", () => {
  assert.deepEqual(reconcileEpicTarget({
    recordedTarget: "a".repeat(40),
    liveTarget: "a".repeat(40),
    sourceSha: "b".repeat(40),
    generation: 2,
  }), { action: "current", generation: 2, sourceSha: "b".repeat(40), targetSha: "a".repeat(40) });
  assert.deepEqual(reconcileEpicTarget({
    recordedTarget: "a".repeat(40),
    liveTarget: "c".repeat(40),
    sourceSha: "b".repeat(40),
    generation: 2,
  }), {
    action: "source_refresh",
    generation: 3,
    priorSourceSha: "b".repeat(40),
    priorTargetSha: "a".repeat(40),
    targetSha: "c".repeat(40),
    requires: ["builder", "gate", "automated_review", "source_verification"],
  });
});

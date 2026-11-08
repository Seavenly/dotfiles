import assert from "node:assert/strict";
import test from "node:test";

import { createProductionRouteConformanceEvidence, productionRouteConformanceForRelease } from "../src/qualification-recipe.mjs";
import * as qualificationRecipe from "../src/qualification-recipe.mjs";
import { isGovernedReleasePath } from "../src/release-content-contract.mjs";

const identity = {
  qualificationBaseCommit: "c34c6e881ce375691d4f3e4ca626c1af9eef81cc",
  candidateTreeSha: "a".repeat(40),
  releaseContentDigest: `sha256:${"b".repeat(64)}`,
  capturedAt: "2026-10-03T00:00:00Z",
  environment: { os: "linux", architecture: "x64", node: "v22.23.1", npm: "10.9.8", git: "2.53.0" },
};

test("dark test deterministic assertions describe only the exact selected release routes", () => {
  const { deterministicQualificationAssertionsForRelease, DETERMINISTIC_QUALIFICATION_ASSERTIONS } = qualificationRecipe;
  assert.equal(typeof deterministicQualificationAssertionsForRelease, "function");
  assert.deepEqual(deterministicQualificationAssertionsForRelease("flow-release-1.0-dark/v1"), DETERMINISTIC_QUALIFICATION_ASSERTIONS);
  assert.equal(DETERMINISTIC_QUALIFICATION_ASSERTIONS[1], "dark opt-in resolves only exact feature verify and local review routes");
  const selected = deterministicQualificationAssertionsForRelease("flow-release-1.1-dark-test/v1");
  assert.equal(selected[1], "dark opt-in resolves only exact feature verify, feature test, and local review routes");
  assert.deepEqual(selected.filter((_, index) => index !== 1), DETERMINISTIC_QUALIFICATION_ASSERTIONS.filter((_, index) => index !== 1));
});

test("dark test release adds only its exact production test conformance route", () => {
  const old = createProductionRouteConformanceEvidence({ ...identity, releaseId: "flow-release-1.0-dark/v1" });
  assert.deepEqual(old.routes, [{ flow: "feature", mode: "verify" }, { flow: "review", mode: "local" }]);
  const next = createProductionRouteConformanceEvidence({ ...identity, releaseId: "flow-release-1.1-dark-test/v1" });
  assert.deepEqual(next.routes, [...old.routes, { flow: "feature", mode: "test" }]);
  assert.equal(next.status, "not_run");
  assert.equal(next.recipe, null);
  assert.ok(next.assertions.some(value => value.includes("healthy RED") && value.includes("GREEN")));
  const unknown = createProductionRouteConformanceEvidence({ ...identity, releaseId: "unknown-release" });
  assert.deepEqual(unknown.routes, old.routes);
  const previousRecipe = productionRouteConformanceForRelease(old.release_id);
  const recipe = productionRouteConformanceForRelease(next.release_id);
  assert.deepEqual(recipe.commands.slice(0, -1), previousRecipe.commands);
  assert.equal(recipe.commands.at(-1).id, "public_production_feature_test");
  assert.equal(recipe.commands.at(-1).command, "node --test config/flow/test/direct-feature-test.test.mjs");
});

test("dark test release governs its curated source and copies without evidence digest cycles", () => {
  const directory = "config/flow/releases/1.1-dark-test/";
  for (const path of ["release-manifest.v1.json", "launch-policy.v1.json", "contracts/catalog.v1.json", "legacy-baselines.v1.json"]) {
    assert.equal(isGovernedReleasePath(directory + path), true, path);
  }
  assert.equal(isGovernedReleasePath(directory + "evidence/release-content.v1.json"), false);
  assert.equal(isGovernedReleasePath(directory + "evidence/production-route-conformance.v1.json"), false);
  assert.equal(isGovernedReleasePath(directory + "transition-ledger.v1.json"), false);
  assert.equal(isGovernedReleasePath("config/flow/releases/other/evidence/source.json"), true);
});

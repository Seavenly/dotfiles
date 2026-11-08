import assert from "node:assert/strict";
import test from "node:test";

import { decideFeatureContinuation } from "../src/feature-controller.mjs";

test("slice failures retry within the cap and block visibly at exhaustion", () => {
  assert.deepEqual(decideFeatureContinuation({
    kind: "slice",
    measurement: { passed: false, evidence: "/run/gate.json" },
    used: 0,
    cap: 2,
  }), { action: "retry", nextOrdinal: 1, evidence: "/run/gate.json" });
  assert.deepEqual(decideFeatureContinuation({
    kind: "slice",
    measurement: { passed: false, evidence: "/run/gate.json" },
    used: 2,
    cap: 2,
  }), {
    action: "needs_input",
    reason: "slice retry cap exhausted",
    evidence: "/run/gate.json",
  });
});

test("completeness and critique preserve every incomplete condition", () => {
  assert.equal(decideFeatureContinuation({
    kind: "completeness",
    measurement: { verdict: "RE_PLAN", evidence: "/run/completeness.json" },
    used: 0,
    cap: 2,
  }).action, "needs_input");
  assert.deepEqual(decideFeatureContinuation({
    kind: "completeness",
    measurement: { uncovered: ["criterion one"], evidence: "/run/completeness.json" },
    used: 0,
    cap: 1,
  }), {
    action: "fix",
    nextOrdinal: 1,
    blocking: ["criterion one"],
    evidence: "/run/completeness.json",
  });
  assert.deepEqual(decideFeatureContinuation({
    kind: "critique",
    measurement: {
      verdict: "blocking",
      blocking: ["broken behavior"],
      nonblocking: ["rename later"],
      evidence: "/run/critique.json",
    },
    used: 1,
    cap: 1,
  }), {
    action: "needs_input",
    reason: "critique fix cap exhausted",
    blocking: ["broken behavior"],
    deferred: ["rename later"],
    evidence: "/run/critique.json",
  });
});

test("missing critic verdict and non-testable verification never pass silently", () => {
  assert.equal(decideFeatureContinuation({
    kind: "critique",
    measurement: { blocking: [], nonblocking: [], evidence: "/run/critic.json" },
    used: 0,
    cap: 1,
  }).action, "needs_input");
  assert.equal(decideFeatureContinuation({
    kind: "slice",
    measurement: { passed: true, testable: false, evidence: "/run/gate.json" },
    used: 0,
    cap: 1,
  }).action, "needs_input");
});

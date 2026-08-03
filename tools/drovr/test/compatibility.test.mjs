import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPATIBILITY_FEATURES,
  collectProductionCompatibility,
  qualifyCompatibility,
} from "../src/compatibility.mjs";
import { createProductionSemanticHarness } from "../src/production-harness-adapter.mjs";

function runtime({ integration = "codex: current (v6)" } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "herdr" && args[0] === "--version") return "herdr 0.7.5\n";
    if (command === "herdr" && args[0] === "integration") {
      return `${integration}\nclaude: current (v7)\n`;
    }
    if (command === "codex" && args[0] === "--version") {
      return "codex-cli 0.145.0\n";
    }
    if (command === "codex") {
      return "--model --sandbox --ask-for-approval --search\n";
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  return { calls, run };
}

test("production compatibility records exact executable, integration, and adapter facts", async () => {
  const { run } = runtime();
  const result = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
  });

  assert.equal(result.status, "qualified");
  assert.deepEqual(result.facts, {
    drovr: "drovr.semantic-harness/v1",
    herdr: "herdr 0.7.5",
    harness: "codex-cli 0.145.0",
    integration: "herdr-codex/v6",
    adapters: ["drovr.production-herdr/v1", "codex-jsonl/v1"],
    features: COMPATIBILITY_FEATURES,
  });
  assert.match(result.evidence_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.legal_actions, []);
  assert.equal(result.upstream_gaps[0].status, "upstream_gap");
});

test("an unavailable or changed compatibility fact blocks production validation before native launch", async () => {
  const unavailable = runtime({ integration: "codex: not installed" });
  const blocked = await collectProductionCompatibility({
    harness: "codex",
    run: unavailable.run,
    env: {},
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "missing");
  assert.ok(blocked.legal_actions.includes("run_drovr_doctor"));

  const qualified = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
  });
  const changed = await collectProductionCompatibility({
    harness: "codex",
    run: runtime().run,
    env: {},
    expected: {
      ...qualified,
      facts: { ...qualified.facts, herdr: "herdr 0.7.6" },
    },
  });
  assert.equal(changed.status, "blocked");
  assert.equal(changed.reason, "changed");
  assert.ok(changed.legal_actions.includes("retire_stale_launch"));

  const explicitlyUnqualified = qualifyCompatibility({
    status: "blocked",
    reason: "unqualified",
    facts: qualified.facts,
  }, { harness: "codex", adapter: "drovr.production-herdr/v1" });
  assert.equal(explicitlyUnqualified.status, "blocked");
  assert.equal(explicitlyUnqualified.reason, "unqualified");

  const harness = createProductionSemanticHarness({
    harness: "codex",
    requireCompatibility: true,
    run: unavailable.run,
    env: {},
    herdr: {
      async agentRecord() {
        throw new Error("native launch must not be reached");
      },
    },
  });
  await assert.rejects(
    () => harness.validateLaunch({ specification: { harness: "codex" } }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.compatibility?.status === "blocked",
  );
});

test("a harness integration mismatch remains unqualified", async () => {
  const { run } = runtime();
  const result = await collectProductionCompatibility({ harness: "codex", run, env: {} });
  const mismatched = qualifyCompatibility(
    { facts: { ...result.facts, integration: "herdr-claude/v7" } },
    { harness: "codex", adapter: "drovr.production-herdr/v1" },
  );
  assert.equal(mismatched.status, "blocked");
  assert.equal(mismatched.reason, "unqualified");
  assert.equal(mismatched.mismatches[0].field, "integration");
});

test("compatibility rejects malformed version and identity facts", async () => {
  const { run } = runtime();
  const qualified = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
  });
  const malformed = qualifyCompatibility({
    facts: {
      ...qualified.facts,
      herdr: "latest",
      adapters: [...qualified.facts.adapters, "forged-adapter/v1"],
      features: [...qualified.facts.features, "forged-feature/v1"],
    },
  }, { harness: "codex", adapter: "drovr.production-herdr/v1" });
  assert.equal(malformed.status, "blocked");
  assert.equal(malformed.reason, "unqualified");
  assert.ok(malformed.mismatches.some(({ field }) => field === "herdr"));
  assert.ok(malformed.mismatches.some(({ field }) => field === "adapters"));
  assert.ok(malformed.mismatches.some(({ field }) => field === "features"));
});

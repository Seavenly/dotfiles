import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPATIBILITY_FEATURES,
  collectProductionCompatibility,
  qualifyCompatibility,
} from "../src/compatibility.mjs";
import { semanticHarnessFor } from "../src/harness-interface.mjs";
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

test("semantic production mutations require the registered compatibility digest", async () => {
  const { run } = runtime();
  const compatibility = await collectProductionCompatibility({
    harness: "codex",
    run,
    env: {},
  });
  let nativeObservations = 0;
  let nativePrompts = 0;
  const context = {
    group: { herdr: { session: "delegates" } },
    agent: {
      launch: { harness: "codex" },
      launch_binding: {
        compatibility_evidence_digest: "sha256:" + "0".repeat(64),
      },
    },
  };
  const harness = semanticHarnessFor(context, {
    env: {},
    run,
    herdr: {
      async agentRecord() {
        nativeObservations += 1;
        return {
          name: "managed-agent",
          pane_id: "pane-1",
          agent_status: "idle",
          agent_session: { value: "native-1" },
        };
      },
      async prompt() {
        nativePrompts += 1;
      },
    },
    compatibility,
    requireCompatibility: true,
  });

  await assert.rejects(
    () => harness.deliverTurn({
      agent: {
        herdr: { name: "managed-agent", pane_id: "pane-1" },
        native_session: "native-1",
      },
      prompt: "must not be delivered",
    }),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "changed" &&
      error.details?.legal_actions?.includes("retire_stale_launch"),
  );
  assert.equal(nativeObservations, 0);
  assert.equal(nativePrompts, 0);
});

test("semantic production mutations block agents with no compatibility digest", async () => {
  const harness = semanticHarnessFor({
    group: { herdr: { session: "delegates" } },
    agent: { launch: { harness: "codex" }, launch_binding: {} },
  }, {
    env: {},
    run: async () => {
      throw new Error("compatibility collection must not run");
    },
    requireCompatibility: true,
  });

  await assert.rejects(
    () => harness.interruptTurn({ agent: {} }),
    (error) =>
      error.outcome === "compatibility_blocked" &&
      error.details?.reason === "missing" &&
      error.details?.legal_actions?.includes("refresh_compatibility"),
  );
});

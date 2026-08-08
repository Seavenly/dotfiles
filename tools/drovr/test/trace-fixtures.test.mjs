import assert from "node:assert/strict";
import test from "node:test";

import { loadTraceFixtures } from "../src/qualification-traces.mjs";

test("qualification traces cover every deterministic incident boundary", async () => {
  const fixtures = await loadTraceFixtures();
  assert.ok(fixtures.length >= 12);
  const coverage = new Set(fixtures.flatMap(({ coverage }) => coverage));
  for (const required of [
    "delayed_paste_conversion",
    "stale_idle_observation",
    "fast_completion",
    "delayed_transcript_flush",
    "identity_change",
    "late_result",
    "token_change",
    "error_envelope",
    "post_stability_reappearance",
    "non_submission",
    "no_hidden_repair",
  ]) {
    assert.ok(coverage.has(required), required);
  }
  assert.equal(
    new Set(fixtures.map(({ trace }) => trace.scenario_id)).size,
    fixtures.length,
  );
  for (const { trace } of fixtures) {
    assert.match(trace.provenance.drovr, /^source commit [0-9a-f]{40}$/u);
    assert.match(trace.provenance.herdr, /^herdr \d+\.\d+\.\d+$/u);
    assert.match(trace.provenance.claude, /Claude Code/u);
    assert.match(trace.provenance.codex, /^codex-cli \d+\.\d+\.\d+$/u);
  }
});

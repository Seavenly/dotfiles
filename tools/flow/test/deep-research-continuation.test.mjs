import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/canonical.mjs";
import { boundedDeepRemainingSeconds, withDeepExecutionTime } from "../src/deep-research-continuation.mjs";
import { decideLifecycle } from "../src/lifecycle-kernel.mjs";

test("deep scope completion and expansion both require a fresh within-budget authority observation", () => {
  const base = { schema: "flow.command/v1", type: "checkpoint_decision", run_id: "run:clock", checkpoint_id: "deep-gate-cycle-1", expected_watermark: digest("fresh") };
  const approve = { ...base, decision: "approve" }, decline = { ...base, decision: "decline" };
  const cancel = { schema: "flow.command/v1", type: "cancel", run_id: base.run_id, expected_watermark: base.expected_watermark };
  const original = { cycle: 1, scope_proposal: { checkpoint_id: base.checkpoint_id }, operationally_blocked: false, report: { answer: "Retained diagnostic answer" } };
  const fold = { run_id: base.run_id, watermark: base.expected_watermark, phase: "active", active_plan: { cards: [] },
    effects: [], effect_intents: [], legal_actions: [approve, decline, cancel], deep_research: original };
  for (const [status, code] of [["unobserved", "execution_time_unavailable"], ["uncertain", "execution_deadline_uncertain"], ["exhausted", "execution_deadline_exhausted"]]) {
    const executionTime = { status, max_elapsed_seconds: 60, wall_elapsed_seconds: { lower: 10, upper: status === "exhausted" ? 61 : null } };
    const projected = withDeepExecutionTime(fold, executionTime, fold.legal_actions);
    assert.deepEqual(projected.legal_actions, [cancel]);
    assert.equal(projected.deep_research.completion_block, code);
    assert.equal(projected.deep_research.scope_proposal.remaining_elapsed_seconds, null);
    assert.deepEqual(projected.deep_research.report, original.report);
    // Even a caller replaying a previously displayed decline cannot turn the
    // retained report into successful completion when the authority clock is lost.
    assert.equal(decideLifecycle({ ...fold, execution_time: executionTime }, decline).code, code);
  }
  const within = { status: "within", max_elapsed_seconds: 60, wall_elapsed_seconds: { lower: 11, upper: 12.5 } };
  assert.equal(boundedDeepRemainingSeconds(within), 47);
  assert.deepEqual(withDeepExecutionTime(fold, within, fold.legal_actions).legal_actions, fold.legal_actions);
  assert.equal(withDeepExecutionTime(fold, within, fold.legal_actions).deep_research.scope_proposal.remaining_elapsed_seconds, 47);
});

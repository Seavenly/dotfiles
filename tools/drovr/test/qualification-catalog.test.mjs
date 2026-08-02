import assert from "node:assert/strict";
import test from "node:test";

import {
  loadQualificationCatalog,
  validateQualificationCatalog,
} from "../src/qualification-catalog.mjs";

test("the versioned qualification catalog is complete and runner-ready", async () => {
  const catalog = await loadQualificationCatalog();
  const summary = validateQualificationCatalog(catalog);

  assert.equal(catalog.schema, "drovr.qualification-catalog/v1");
  assert.equal(catalog.version, 1);
  assert.equal(summary.scenario_count, catalog.scenarios.length);
  assert.ok(summary.scenario_count >= 15);
  assert.deepEqual(summary.execution_kinds, [
    "deterministic_trace_replay",
    "real_herdr_harness",
  ]);
  assert.deepEqual(
    catalog.known_incidents.map(({ id }) => id).sort(),
    [
      "caller_pane_inheritance",
      "cancellation",
      "claude_long_paste_conversion",
      "claude_multiline_conversion",
      "claude_staged_prompt_concatenation",
      "codex_prompt_normalization",
      "codex_startup_context",
      "delayed_transcript_settlement",
      "late_results",
      "native_session_identity_races",
      "recovery_token_conflicts",
      "staged_prompt_clearing",
      "staged_prompt_submission",
      "transient_clear_reappearance",
    ],
  );
  assert.deepEqual(Object.keys(catalog.safety_invariants).sort(), [
    "caller_owned_workspace_preservation",
    "exact_agent_identity",
    "exact_native_session_identity",
    "non_submission_of_unknown_text",
    "prompt_ownership",
    "snapshot_token_conflicts",
  ]);

  for (const scenario of catalog.scenarios) {
    assert.ok(scenario.public_commands.length > 0, scenario.id);
    assert.ok(scenario.preconditions.length > 0, scenario.id);
    assert.deepEqual(Object.keys(scenario.expected_outcomes).sort(), [
      "negative",
      "positive",
      "recovery",
      "uncertain",
    ]);
    assert.ok(scenario.safety_invariants.length > 0, scenario.id);
    assert.ok(scenario.prohibited_mutations.length > 0, scenario.id);
    assert.ok(scenario.cleanup_obligations.length > 0, scenario.id);
    assert.ok(scenario.evidence_requirements.length > 0, scenario.id);
  }
});

test("qualification evidence and cleanup receipts have versioned required shapes", async () => {
  const catalog = await loadQualificationCatalog();

  assert.equal(
    catalog.contracts.qualification_evidence.schema,
    "drovr.qualification-evidence/v1",
  );
  assert.equal(
    catalog.contracts.cleanup_receipt.schema,
    "drovr.qualification-cleanup-receipt/v1",
  );
  assert.ok(
    catalog.contracts.qualification_evidence.required_fields.includes(
      "cleanup_receipt",
    ),
  );
  assert.ok(
    catalog.contracts.cleanup_receipt.required_fields.includes(
      "caller_owned_workspace",
    ),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  loadQualificationCatalog,
  validateQualificationCatalog,
} from "../src/qualification-catalog.mjs";
import {
  CYCLE_EVIDENCE_REQUIRED_FIELDS,
  QUALIFICATION_EVIDENCE_REQUIRED_FIELDS,
} from "../src/qualification-contracts.mjs";
import { loadTraceFixtures } from "../src/qualification-traces.mjs";

test("the versioned qualification catalog is complete and runner-ready", async () => {
  const catalog = await loadQualificationCatalog();
  const summary = validateQualificationCatalog(catalog);

  assert.equal(catalog.schema, "drovr.qualification-catalog/v1");
  assert.equal(catalog.version, 1);
  assert.equal(summary.scenario_count, catalog.scenarios.length);
  assert.ok(summary.scenario_count >= 18);
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
  assert.deepEqual(
    catalog.known_incidents.find(({ id }) => id === "transient_clear_reappearance")
      .scenarios.sort(),
    [
      "claude_staged_input_delayed_reappearance_after_clear",
      "claude_staged_input_transient_clear_reappears",
    ],
  );
  assert.deepEqual(Object.keys(catalog.safety_invariants).sort(), [
    "caller_owned_workspace_preservation",
    "exact_agent_identity",
    "exact_launch_configuration",
    "exact_native_session_identity",
    "non_submission_of_unknown_text",
    "prompt_ownership",
    "prompt_source_preservation",
    "snapshot_token_conflicts",
    "unrelated_herdr_resource_preservation",
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
  assert.deepEqual(
    catalog.contracts.qualification_evidence.required_fields,
    QUALIFICATION_EVIDENCE_REQUIRED_FIELDS,
  );
  assert.ok(
    CYCLE_EVIDENCE_REQUIRED_FIELDS.every((field) =>
      catalog.contracts.qualification_evidence.required_fields.includes(field),
    ),
  );
  assert.equal(CYCLE_EVIDENCE_REQUIRED_FIELDS.length, 12);
  assert.ok(
    catalog.contracts.qualification_evidence.required_fields.includes(
      "cleanup_receipt",
    ),
  );
  assert.ok(
    catalog.contracts.qualification_evidence.required_fields.includes(
      "execution_policy",
    ),
  );
  assert.ok(
    catalog.contracts.cleanup_receipt.required_fields.includes(
      "caller_owned_workspace",
    ),
  );
});

test("replay mutation proofs are declared by their catalog scenarios", async () => {
  const catalog = await loadQualificationCatalog();
  const fixtures = await loadTraceFixtures();
  for (const fixture of fixtures) {
    const scenario = catalog.scenarios.find(({ id }) => id === fixture.id);
    if (!scenario) continue;
    const proofDescriptions = fixture.steps
      .filter(({ action }) =>
        ["assert_no_mutation", "assert_no_followup_mutation"].includes(action),
      )
      .map(({ description }) => description);
    for (const description of proofDescriptions) {
      assert.ok(
        scenario.prohibited_mutations.includes(description),
        `${fixture.id} proof is not declared in the catalog: ${description}`,
      );
    }
  }
  const delayed = fixtures.find(
    ({ id }) => id === "claude_staged_input_delayed_reappearance_after_clear",
  );
  assert.ok(
    delayed.steps.some(
      ({ action, method, outcome }) =>
        action === "expect_error" &&
        method === "recover_clear" &&
        outcome === "recovery_blocked",
    ),
    "delayed reappearance must exercise stale-token rejection",
  );
});

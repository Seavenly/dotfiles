import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { directOutputContract } from "../src/direct-output-contract.mjs";
import { parseReviewDelegateResult } from "../src/review-rendering.mjs";

function reviewIntent(role = "lens") {
  return {
    delegate_input: {
      task_inputs: {
        schema: "flow.delegate-task-inputs/v1",
        flow: "review/v1",
        role,
        ...(role === "lens" ? { lens: "security" } : { lenses: ["correctness", "security"] }),
        target: {
          schema: "flow.review-local-candidate/v1",
          candidate_fingerprint: `sha256:${"a".repeat(64)}`,
          candidate_authority_watermark: `sha256:${"b".repeat(64)}`,
          lifecycle_generation: 1,
          candidate: { workspace: { subject_id: "workspace:review", generation: 1 } },
        },
      },
      output_requirements: {
        schema: "flow.delegate-output-requirements/v1",
        format: "canonical-json",
        schemas: ["flow.review-result/v1"],
        validator_contracts: ["flow.validator/review-delegate-output/v1"],
      },
    },
    delegate_output_schemas: ["flow.review-result/v1"],
  };
}

for (const role of ["lens", "critic"]) {
  test(`direct ${role} accepts the existing local review task and result contract`, () => {
    const contract = directOutputContract(reviewIntent(role));
    assert.deepEqual(contract.schemas, ["flow.review-result/v1"]);
    const validate = new Ajv({ strict: false }).compile(contract.schema);
    const result = { schema: "flow.review-result/v1", findings: [] };
    assert.equal(validate(result), true, JSON.stringify(validate.errors));
    const parsed = parseReviewDelegateResult(result, { role, lens: role === "lens" ? "security" : null });
    assert.equal(parsed.posture, "no_findings");
    assert.equal(parsed.coverage.status, "produced");
  });
}

test("feature output contracts bind the additive file-digest variant and preserve equals", () => {
  for (const [phase, expected] of [
    ["apply", "sha256:5319da9e5f846e2ec961576de400a1d976fb202c8d1b2d8f8958df4c1a064e15"],
    ["critique", "sha256:5470ae27fa32f7126d301d4a2ae3e445d8d142b645cc76a3c7d54a9b7ce2384f"],
  ]) {
    const contract = directOutputContract({ delegate_input: { task_inputs: { phase } }, delegate_output_schemas: ["flow.delegate-evidence/v1"] });
    assert.equal(contract.contract_digest, expected);
    assert.equal(contract.schema.properties.schema.const, "flow.delegate-evidence/v1");
  }
});

test("unsupported and malformed review task identities fail closed", () => {
  const mutations = [
    (intent) => { delete intent.delegate_input.task_inputs; },
    (intent) => { intent.delegate_input.task_inputs.schema = "foreign.task/v1"; },
    (intent) => { intent.delegate_input.task_inputs.flow = "spike/v1"; },
    (intent) => { intent.delegate_input.task_inputs.role = "apply"; },
    (intent) => { intent.delegate_input.task_inputs.target.schema = "flow.review-github-pull-request/v1"; },
    (intent) => { delete intent.delegate_input.task_inputs.target; },
    (intent) => { delete intent.delegate_input.task_inputs.lens; },
    (intent) => { intent.delegate_input.task_inputs.lens = ""; },
    (intent) => { intent.delegate_output_schemas = ["flow.delegate-evidence/v1"]; },
    (intent) => { intent.delegate_output_schemas.push("foreign.result/v1"); },
  ];
  for (const mutate of mutations) {
    const intent = reviewIntent();
    mutate(intent);
    assert.throws(() => directOutputContract(intent), { code: "unsupported_direct_output_contract" });
  }
  for (const lenses of [undefined, [], ["security", "security"], [""]]) {
    const intent = reviewIntent("critic");
    intent.delegate_input.task_inputs.lenses = lenses;
    assert.throws(() => directOutputContract(intent), { code: "unsupported_direct_output_contract" });
  }
});

test("review schema accepts every posture, documented coverage form and opaque evidence", () => {
  const validate = new Ajv({ strict: false }).compile(directOutputContract(reviewIntent()).schema);
  const coverageForms = [
    [{}, "produced"],
    [{ coverage: null }, "produced"],
    [{ coverage: "produced" }, "produced"],
    [{ coverage: {} }, "produced"],
    [{ coverage: { schema: "flow.review-coverage/v1", status: "produced", reason: null } }, "produced"],
    [{ coverage: { status: "produced", reason: "Legacy optional reason" } }, "produced"],
    [{ coverage: { status: "degraded", reason: "bounded_timeout" } }, "degraded"],
    [{ coverage: { disposition: "unavailable", code: "delegate_unavailable" } }, "unavailable"],
    [{ terminal_disposition: { terminal_disposition: "degraded", reason: "bounded_timeout" } }, "degraded"],
  ];
  for (const posture of ["no_findings", "findings", "review_incomplete", "blocked", null]) {
    for (const [coverage, expectedStatus] of coverageForms) {
      for (const evidence of [null, "Independent observation", 42, true, ["observation"], { lens: "security", coverage: { status: "unavailable" } }]) {
        const result = { schema: "flow.review-result/v1", findings: [], posture, ...coverage, evidence };
        assert.equal(validate(result), true, JSON.stringify(validate.errors));
        const parsed = parseReviewDelegateResult(result, { lens: "security" });
        assert.equal(parsed.posture, posture ?? "no_findings");
        assert.equal(parsed.coverage.status, expectedStatus);
        assert.deepEqual(parsed.evidence, evidence);
      }
    }
  }
});

test("review schema preserves finding aliases, anchoring and normalized semantic identities", () => {
  for (const role of ["lens", "critic"]) {
    const validate = new Ajv({ strict: false }).compile(directOutputContract(reviewIntent(role)).schema);
    for (const urgency of ["critical", "high", "medium", "low", "info"]) {
      for (const classification of ["blocking", "non_blocking"]) {
        for (const location of [null, { path: "src/index.mjs", start_line: 1 }, { path: "src/index.mjs", start_line: 2, end_line: 3, start_column: 4, end_column: 1 }]) {
          const finding = { lens: role === "lens" ? "security" : "critic", urgency, classification, summary: "Finding summary", detail: "Finding detail", location };
          const alias = { lens: finding.lens, severity: urgency, blocking: classification === "blocking", title: finding.summary, description: finding.detail, inline: location };
          const options = { role, lens: role === "lens" ? "security" : null };
          const normalized = parseReviewDelegateResult({ schema: "flow.review-result/v1", findings: [finding] }, options).findings[0];
          for (const form of [finding, alias, normalized]) {
            const result = { schema: "flow.review-result/v1", posture: "findings", findings: [form], cap_reasons: [{ code: "finding_cap", detail: "Bounded review", count: 0, omitted_urgencies: ["low"], overflow_urgencies: ["high"] }] };
            assert.equal(validate(result), true, JSON.stringify(validate.errors));
            assert.deepEqual(parseReviewDelegateResult(result, options).findings, [normalized]);
          }
        }
      }
    }
  }
  const result = { schema: "flow.review-result/v1", findings: [{ severity: "high", title: "Inherited lens", description: "Independent detail" }] };
  assert.equal(new Ajv({ strict: false }).compile(directOutputContract(reviewIntent()).schema)(result), true);
  assert.equal(parseReviewDelegateResult(result, { lens: "security" }).findings[0].lens, "security");
});

test("review schema and independent parser reject malformed findings and coverage", () => {
  const validate = new Ajv({ strict: false }).compile(directOutputContract(reviewIntent()).schema);
  const base = { schema: "flow.review-result/v1", findings: [] };
  const finding = { lens: "security", urgency: "high", summary: "Summary", detail: "Detail" };
  const cases = [
    { ...base, schema: "foreign.review/v1" },
    { ...base, findings: {} },
    { ...base, posture: "approved" },
    { ...base, coverage: "degraded" },
    { ...base, coverage: { status: "degraded" } },
    { ...base, coverage: { status: "unavailable", reason: "# heading" } },
    { ...base, coverage: "produced", terminal_disposition: "produced" },
    { ...base, coverage: { schema: "foreign.coverage/v1", status: "produced" } },
    { ...base, findings: [{ ...finding, lens: "correctness" }] },
    { ...base, findings: [{ ...finding, urgency: "urgent" }] },
    { ...base, findings: [{ ...finding, summary: "unsafe\nheading" }] },
    { ...base, findings: [{ ...finding, detail: "```unsafe```" }] },
    { ...base, findings: [{ ...finding, location: { path: "src/index.mjs", start_line: 0 } }] },
    { ...base, cap_reasons: [{ code: "cap", detail: "- list item" }] },
    { ...base, cap_reasons: [{ code: "cap", detail: "Detail", count: -1 }] },
  ];
  for (const result of cases) {
    assert.equal(validate(result), false, JSON.stringify(result));
    assert.throws(() => parseReviewDelegateResult(result, { lens: "security" }));
  }
  assert.equal(validate({ ...base, approval: true }), false, "delegate output has a closed root shape");
  const critic = new Ajv({ strict: false }).compile(directOutputContract(reviewIntent("critic")).schema);
  assert.equal(critic({ ...base, findings: [{ urgency: "high", summary: "Summary", detail: "Detail" }] }), false);
});

test("structured schema cannot substitute for review identity, location or duplicate validation", () => {
  const validate = new Ajv({ strict: false }).compile(directOutputContract(reviewIntent()).schema);
  const finding = { lens: "security", urgency: "high", summary: "Summary", detail: "Detail" };
  for (const [findings, code] of [
    [[{ ...finding, finding_id: `finding:${"0".repeat(64)}` }], "finding_identity_mismatch"],
    [[{ ...finding, location: { path: "src/index.mjs", start_line: 3, end_line: 2 } }], "malformed_finding"],
    [[finding, finding], "duplicate_finding"],
  ]) {
    const result = { schema: "flow.review-result/v1", findings };
    assert.equal(validate(result), true);
    assert.throws(() => parseReviewDelegateResult(result, { lens: "security" }), { code });
  }
});

test("selected lens specialization changes the immutable output identity", () => {
  const security = directOutputContract(reviewIntent());
  const changed = reviewIntent();
  changed.delegate_input.task_inputs.lens = "correctness";
  const correctness = directOutputContract(changed);
  assert.notEqual(security.contract_digest, correctness.contract_digest);
  assert.notEqual(security.contract_digest, directOutputContract(reviewIntent("critic")).contract_digest);
  assert.equal(Object.isFrozen(security.schema), true);
  assert.equal(Object.isFrozen(security.schemas), true);
});


test("direct feature schemas accept both closed file observations and reject malformed digests", () => {
  const contract = directOutputContract({ delegate_input: { task_inputs: { phase: "apply" } }, delegate_output_schemas: ["flow.delegate-evidence/v1"] });
  const validate = new Ajv({ strict: false }).compile(contract.schema);
  const output = entry => ({ schema: "flow.delegate-evidence/v1", observation: "Inspected the candidate", feature_evidence: { schema: "flow.feature-criterion-evidence/v1", criteria: [entry] } });
  const entry = { criterion: "The feature is present", kind: "git_file_sha256", target: "src/feature.sh", expected: "sha256:" + "a".repeat(64) };
  assert.equal(validate(output(entry)), true, JSON.stringify(validate.errors));
  assert.equal(validate(output({ ...entry, kind: "git_file_equals", expected: "legacy bytes" })), true);
  assert.equal(validate(output({ ...entry, expected: "a".repeat(64) })), false);
  assert.equal(validate(output({ ...entry, expected: "sha256:" + "A".repeat(64) })), false);
  assert.equal(validate(output({ ...entry, sha256: entry.expected })), false);
});

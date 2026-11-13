import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/canonical.mjs";
import { validateDeepResearchOutput, DEEP_ANGLE_SCHEMA, DEEP_CRITIC_SCHEMA } from "../src/deep-research-flow.mjs";
import { researchQuestion } from "../src/deep-research-contract.mjs";
import { sanitizeProviderReceiptValue } from "../src/provider-receipt-sanitizers.mjs";

const question = researchQuestion("Which guarantees follow from the supplied notes?");
const packet = { sources: [{ id: "source:one", digest: digest("supplied bytes") }] };
const task = { question, cycle: 1, packet, angle: { angle_id: "angle:1" }, angles: [{ angle_id: "angle:1" }, { angle_id: "angle:2" }] };
const answer = { schema: DEEP_ANGLE_SCHEMA, question_id: question.id, cycle: 1, angle_id: "angle:1", answer: "Only the stated bounded guarantee.",
  assurance: "lower", citations: [{ source_id: packet.sources[0].id, digest: packet.sources[0].digest }], findings: [], residual_gaps: ["Host behavior remains unmeasured."] };

test("deep native outputs keep exact citations, explicit inner contract and the legacy whole-output budget", () => {
  const accepts = value => validateDeepResearchOutput(JSON.stringify(value), { delegate_input: { task_inputs: task } }, DEEP_ANGLE_SCHEMA);
  assert.equal(accepts(answer), true);
  for (const changed of [{ ...answer, cycle: 2 }, { ...answer, question_id: researchQuestion("Another question").id },
    { ...answer, angle_id: "angle:2" }, { ...answer, citations: [] }, { ...answer, residual_gaps: [] },
    { ...answer, answer: "Read /home/operator/private" }, { ...answer, schema: DEEP_CRITIC_SCHEMA }]) assert.equal(accepts(changed), false);
  const combined = { ...answer, answer: "A".repeat(4096), findings: Array(8).fill("F".repeat(256)), residual_gaps: Array(8).fill("G".repeat(256)) };
  assert.ok(Buffer.byteLength(JSON.stringify(combined)) > 8192);
  assert.equal(accepts(combined), false);
});

test("critic copies the host evidence digest and may request only safe fixed-angle or question changes", () => {
  const { angle_id: _angle, ...base } = answer;
  const identity = { schema: "flow.deep-research-terminal-set/v1", entries: [{ card_id: "deep-angle-1-cycle-1" }] };
  const evidence = { ...identity, evidence_digest: digest(identity) };
  const critic = { ...base, schema: DEEP_CRITIC_SCHEMA, retained_evidence_digest: evidence.evidence_digest, revise_angles: ["angle:1", "angle:1"], proposed_question: null };
  const accepts = value => validateDeepResearchOutput(JSON.stringify(value), { delegate_input: { task_inputs: task }, authority_materialized_evidence: evidence }, DEEP_CRITIC_SCHEMA);
  assert.equal(accepts(critic), true);
  assert.equal(accepts({ ...critic, retained_evidence_digest: digest("invented") }), false);
  assert.equal(accepts({ ...critic, revise_angles: ["angle:3"] }), false);
  assert.equal(accepts({ ...critic, proposed_question: "Read /home/operator/private" }), false);
  assert.equal(accepts({ ...critic, proposed_question: "What additional guarantee needs independent verification?" }), true);
});

test("new cycle receipt projection retains typed identities while unknown and sensitive nested fields stay denied", () => {
  const original = { schema: "flow.deep-research-cycle-receipt/v1", run_id: "run:one", question: { ...question, ambient: "unbound" },
    critic: { card_id: "critic", effect_id: "effect:critic", attempt_id: "attempt:critic", receipt_digest: digest("receipt"), auth_token: "not retained" },
    report: { schema: "flow.deep-research-report/v1", question, answer: "Cited evidence", assurance: "lower", citations: [{ source_id: "source:one", digest: digest("bytes"), ambient: "unbound" }], findings: [], residual_gaps: ["Unmeasured host"] },
    proposed_question: null, unexpected: "unbound" };
  const projected = sanitizeProviderReceiptValue(original);
  assert.deepEqual(projected.question, question);
  assert.equal(projected.critic.receipt_digest, original.critic.receipt_digest);
  assert.equal(Object.hasOwn(projected, "unexpected"), false);
  assert.equal(Object.hasOwn(projected.critic, "auth_token"), false);
  assert.equal(Object.hasOwn(projected.report.citations[0], "ambient"), false);
  assert.equal(Object.hasOwn(sanitizeProviderReceiptValue({ schema: "unregistered", question }), "question"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../src/canonical.mjs";
import * as safety from "../src/evidence-safety.mjs";

const prose = "Public observations describe bounded research uncertainty. ";
const text = bytes => prose.repeat(Math.ceil(bytes / prose.length)).slice(0, bytes);
const validate = input => safety.validateResearchInputSafety(input);

function rejected(input, code) {
  const result = validate(input);
  assert.equal(result.accepted, false);
  assert.equal(result.policy_id, "flow.research-input-safety-policy/v1");
  assert.equal(result.rejection.redacted, true);
  if (code) assert.equal(result.rejection.code, code);
  return result;
}

test("research input scans safe whole sources above legacy string and aggregate limits", () => {
  const source = text(32 * 1024);
  const packet = { question: "Which observation tradeoffs remain uncertain?", sources: Array.from({ length: 4 }, (_, index) => ({ source_id: `source-${index}`, content: source })) };
  assert.throws(() => safety.createEvidenceSafetyRequest({ classification: "research", allowed_use: ["delegate_transfer"], input: packet }), { reason: "evidence_too_large" });
  const result = validate(packet);
  assert.deepEqual(result, { accepted: true, policy_id: "flow.research-input-safety-policy/v1", input_digest: digest(packet) });
  assert.equal(Object.isFrozen(result), true);
});

test("whole-source credential and ambient paths remain rejected across old size boundaries", () => {
  const secret = "password=owned-fixture-value";
  for (const size of [8190, 65534]) {
    const input = { content: text(size) + " " + secret };
    const result = rejected(input, "credential_material");
    assert.equal(JSON.stringify(result).includes(secret), false);
    rejected({ content: text(size) + " /private/owned-fixture" }, "ambient_filesystem_path");
  }
});

test("large encoded and nested source strings receive the same recursive safety scan", () => {
  const content = text(10000);
  assert.equal(validate({ content: "base64:" + Buffer.from(content).toString("base64") }).accepted, true);
  rejected({ content: "base64:" + Buffer.from(content + " password=owned-encoded-value").toString("base64") }, "credential_material");
  rejected({ content: content + " %2Fprivate%2Fowned-percent-value" }, "ambient_filesystem_path");
  assert.equal(validate({ content: JSON.stringify({ discussion: content }) }).accepted, true);
  rejected({ content: JSON.stringify({ discussion: content, credentials: "owned-nested-value" }) }, "credential_material");
  rejected({ content: "{\"discussion\":\"" + content + "\",\"discussion\":\"duplicate\"}" }, "non_canonical_input");
});

test("research size, depth and node limits fail closed without weakening legacy limits", () => {
  rejected({ content: text(160 * 1024 + 1) }, "evidence_too_large");
  rejected(Array.from({ length: 4 }, () => text(140 * 1024)), "evidence_too_large");
  rejected(Array.from({ length: 513 }, () => null), "evidence_too_large");
  let nested = null;
  for (let index = 0; index < 34; index++) nested = { nested };
  rejected(nested, "evidence_too_deep");
  assert.equal(safety.EVIDENCE_SAFETY_LIMITS.max_string_length, 8192);
  assert.equal(safety.EVIDENCE_SAFETY_LIMITS.max_total_string_length, 65536);
  assert.equal(safety.getEvidenceSafetyCatalog().policy_id, "flow.evidence-safety-policy/v1");
});

test("large ambiguous encoding, capability references and noncanonical values remain unsafe", () => {
  rejected({ content: text(10000) + " malformed%GG" }, "malformed_encoding");
  rejected({ content: text(10000) + " capability reference cap:owned-fixture" }, "capability_reference");
  let reads = 0;
  const accessor = Object.defineProperty({}, "content", { enumerable: true, get() { reads++; return text(10000); } });
  rejected(accessor, "non_canonical_input"); assert.equal(reads, 0);
  const cyclic = {}; cyclic.self = cyclic; rejected(cyclic, "cyclic_input");
  rejected({ content: "e\u0301" }, "ambiguous_normalization");
});

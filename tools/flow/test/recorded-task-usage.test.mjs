import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/canonical.mjs";
import { parseRecordedUsage, readRecordedTaskUsage } from "../src/recorded-task-usage.mjs";
const hash = data => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const stream = events => Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
const codex = () => stream([{ type: "thread.started", thread_id: "session-one" }, { type: "turn.started" }, { type: "item.completed", item: { text: "private transcript sentinel" } }, { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 } }]);
function fixture(t) {
  const authority = mkdtempSync(join(tmpdir(), "flow-recorded-usage-")); t.after(() => rmSync(authority, { recursive: true, force: true }));
  const runId = `run:${"a".repeat(64)}`, effect = { run_id: runId, card_id: "writer", effect_id: "effect:writer", attempt_id: "attempt:writer", effect_kind: "delegate", status: "succeeded", invocation_started: true };
  const taskId = `task:${hash(Buffer.from(effect.attempt_id)).slice(7)}`, root = join(authority, "direct-tasks", taskId.slice(5)); mkdirSync(root, { recursive: true });
  const input = Buffer.from("private prompt sentinel"), stdout = codex(), stderr = Buffer.from("");
  const output = { schema: {} }, identity = { schema: "flow.task-invocation/v1", task_id: taskId, caller_key: effect.attempt_id, run_id: runId, card_id: effect.card_id, attempt_id: effect.attempt_id, effect_id: effect.effect_id,
    input_sha256: hash(input), description: { backend: { harness: "codex", executable: { version: "codex-cli 0.166.0" } }, launch: { model: "gpt-6.1-sol" } }, output_contract: output, output_schema_bytes: "{}", output_contract_digest: digest(output), process_containment: "linux_subreaper" };
  const descriptor = { ...identity, descriptor_digest: digest(identity) }, worker = { schema: "flow.task-process/v1", descriptor_digest: descriptor.descriptor_digest, containment: "linux_subreaper", identity: { pid: 11 }, child: { pid: 12 } };
  const receipt = { schema: "flow.task-terminal-receipt/v1", descriptor_digest: descriptor.descriptor_digest, input_sha256: hash(input), stdout_sha256: hash(stdout), stderr_sha256: hash(stderr), worker_identity: worker.identity, child_identity: worker.child, exit_code: 0, cancelled: false, tree_retired: true };
  const proofIdentity = { descriptor_digest: descriptor.descriptor_digest, input_sha256: hash(input), output_contract_digest: identity.output_contract_digest, stdout_sha256: hash(stdout), terminal_receipt_digest: digest(receipt), native_session: "session-one" };
  effect.receipt = { provider_receipt: { turn_id: taskId, settlement_proof: { ...proofIdentity, record_sha256: digest(proofIdentity) }, terminal_disposition: { resource: { type: "direct_task", id: taskId }, terminal_receipt_digest: digest(receipt), retired: true } } };
  for (const [name, data] of Object.entries({ "descriptor.json": JSON.stringify(descriptor), "worker.json": JSON.stringify(worker), "receipt.json": JSON.stringify(receipt), "input.bin": input, "output-schema.json": "{}", "stdout.bin": stdout, "stderr.bin": stderr })) writeFileSync(join(root, name), data, { mode: 0o600 });
  return { authorityDirectory: authority, runId, effect, root, receipt };
}
test("receipt-bound Codex fields preserve subset meaning and omit transcript/prompt", t => {
  const f = fixture(t), result = readRecordedTaskUsage(f);
  assert.equal(result.status, "reported"); assert.equal(result.metrics.input_tokens, 100); assert.equal(result.metrics.cached_input_tokens, 60); assert.equal(result.metrics.output_tokens, 20); assert.equal(result.metrics.reasoning_output_tokens, 5); assert.equal(result.metrics.turns, 1);
  assert.equal(result.model.reported, null); assert.equal(result.cost.usd, null); assert.match(result.token_semantics, /do_not_add_subsets/u);
  assert.doesNotMatch(JSON.stringify(result), /private transcript|private prompt/u);
});
test("Claude final cumulative result counts once and labels actual list-cost estimate", () => {
  const stdout = stream([{ type: "system", subtype: "init", session_id: "claude-one" }, { type: "assistant", message: { usage: { input_tokens: 999999 } } },
    { type: "result", session_id: "claude-one", num_turns: 5, total_cost_usd: 0.1621928, usage: { input_tokens: 8, cache_read_input_tokens: 44684, cache_creation_input_tokens: 16273, output_tokens: 1152, output_tokens_details: { thinking_tokens: 393 } }, modelUsage: { "claude-opus-5-5": { inputTokens: 8, costUSD: 0.1621928, costBasis: "list" } } }]);
  const result = parseRecordedUsage(stdout, { harness: "claude", nativeSession: "claude-one" });
  assert.equal(result.metrics.input_tokens, 8); assert.equal(result.metrics.cached_input_tokens, 44684); assert.equal(result.metrics.cache_write_input_tokens, 16273); assert.equal(result.metrics.turns, 5); assert.equal(result.cost.usd, 0.1621928); assert.equal(result.cost.basis, "cli_reported_list_estimate");
});
test("missing or changed stdout never becomes zero usage", t => {
  const f = fixture(t); writeFileSync(join(f.root, "stdout.bin"), "changed\n");
  const changed = readRecordedTaskUsage(f); assert.equal(changed.status, "unavailable"); assert.equal(changed.metrics.input_tokens, null);
  rmSync(join(f.root, "stdout.bin")); const missing = readRecordedTaskUsage(f); assert.equal(missing.status, "unavailable"); assert.equal(missing.metrics.output_tokens, null);
});
test("wrong projected effect cannot borrow a valid task's metrics", t => {
  const f = fixture(t); f.effect.effect_id = "effect:other";
  const result = readRecordedTaskUsage(f); assert.equal(result.status, "unavailable"); assert(result.diagnostics.includes("usage_descriptor_conflict"));
});
test("duplicate terminal events and impossible subsets stay partial or unavailable", () => {
  const lines = codex().toString("utf8"); assert.throws(() => parseRecordedUsage(Buffer.from(lines + lines), { harness: "codex" }), /usage_terminal_ambiguous/u);
  const invalid = stream([{ type: "thread.started", thread_id: "one" }, { type: "turn.completed", usage: { input_tokens: 2, cached_input_tokens: 3, output_tokens: 1, reasoning_output_tokens: 5 } }]);
  const result = parseRecordedUsage(invalid, { harness: "codex" }); assert.equal(result.metrics.cached_input_tokens, null); assert.equal(result.metrics.reasoning_output_tokens, null); assert.equal(result.diagnostics.length, 2);
});


test("aliased and oversized artifacts refuse without following unrelated content", t => {
  const f = fixture(t), outside = join(f.authorityDirectory, "outside-owned"); writeFileSync(outside, "outside marker");
  rmSync(join(f.root, "stdout.bin")); symlinkSync(outside, join(f.root, "stdout.bin"));
  assert.equal(readRecordedTaskUsage(f).status, "unavailable");
  rmSync(join(f.root, "descriptor.json")); writeFileSync(join(f.root, "descriptor.json"), "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(readRecordedTaskUsage(f).status, "unavailable");
});
test("changed public proof and native session refuse exact task reuse", t => {
  const f = fixture(t), proof = f.effect.receipt.provider_receipt.settlement_proof;
  proof.native_session = "different-session";
  const { record_sha256: _old, ...identity } = proof; proof.record_sha256 = digest(identity);
  assert.equal(readRecordedTaskUsage(f).status, "unavailable");
  proof.descriptor_digest = digest("other task");
  const { record_sha256: _older, ...changed } = proof; proof.record_sha256 = digest(changed);
  assert.equal(readRecordedTaskUsage(f).status, "unavailable");
});
test("hash-bound cancelled terminal metrics remain partial and keep authority outcome", t => {
  const f = fixture(t); f.receipt.cancelled = true; f.effect.status = "quarantined";
  writeFileSync(join(f.root, "receipt.json"), JSON.stringify(f.receipt));
  const projected = f.effect.receipt.provider_receipt; projected.terminal_disposition.terminal_receipt_digest = digest(f.receipt);
  projected.settlement_proof.terminal_receipt_digest = digest(f.receipt);
  const { record_sha256: _old, ...proof } = projected.settlement_proof; projected.settlement_proof.record_sha256 = digest(proof);
  const result = readRecordedTaskUsage(f); assert.equal(result.status, "partial"); assert.equal(result.authority_status, "quarantined"); assert.equal(result.metrics.input_tokens, 100);
});
test("Claude inconsistent cost sources stay unknown and reported provider stays explicit", () => {
  const stdout = stream([{ type: "system", subtype: "init", session_id: "claude" }, { type: "result", session_id: "claude", usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.2, modelUsage: { "claude-opus-5-5": { provider: "firstParty", costUSD: 0.1, costBasis: "list" } } }]);
  const result = parseRecordedUsage(stdout, { harness: "claude" }); assert.equal(result.cost.usd, null); assert.equal(result.provider_reported, "firstParty"); assert(result.diagnostics.includes("usage_cost_source_conflict"));
});

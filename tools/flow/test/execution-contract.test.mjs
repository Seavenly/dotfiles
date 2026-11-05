import assert from "node:assert/strict";
import test from "node:test";
import { executionDescription, directDescriptionIssue } from "../src/execution-contract.mjs";
import { digest } from "../src/canonical.mjs";
const backend = { contract: "flow.direct-task/v1", id: "direct", harness: "codex", adapter: "flow.codex-exec", adapter_version: "1", executable: { path: "/fixture/codex", version: "codex-cli 0.166.0", sha256: digest("executable") }, native_session_strategy: "fresh_ephemeral" };
function describe(supervised = false) { return executionDescription({ launch: { harness: "codex", model: "gpt-6.1-sol", effort: "high", capability: "workspace-write-denied", ...(supervised ? { trust_posture: "supervised-native-cli" } : {}) }, backend: { ...backend, ...(supervised ? { trust_contract: "flow.supervised-native-cli/v1" } : {}) }, callerMetadata: {} }); }
function rehash(description) { description.comparison_keys.effective_authority = digest(description.effective_authority); const { description_digest, ...identity } = description; description.description_digest = digest(identity); return description; }
test("supervised descriptions bind requested CLI controls without strict authority claims", () => {
 const strict = describe(), supervised = describe(true);
 assert.equal(directDescriptionIssue(strict), null); assert.equal(directDescriptionIssue(supervised), null);
 assert.equal(strict.effective_authority.network, "disabled");
 assert.equal(supervised.effective_authority.network, "not_independently_verified");
 assert.equal(supervised.effective_authority.assurance, "operator_supervised_cli");
 assert.equal(supervised.effective_authority.filesystem, "cli_requested_workspace_write");
 assert.equal(supervised.effective_authority.approvals, "cli_requested_never");
 assert.equal(supervised.effective_authority.escalation, "not_independently_verified");
 assert.deepEqual(supervised.effective_authority.protected_paths, []);
 assert.notEqual(strict.description_digest, supervised.description_digest);
 assert.notEqual(strict.comparison_keys.launch, supervised.comparison_keys.launch);
 assert.notEqual(strict.watermark.content_sha256, supervised.watermark.content_sha256);
});
test("recomputed supervised description cannot claim strict enforcement or lose the backend trust contract", () => {
 for (const mutate of [d => d.effective_authority.network = "disabled", d => d.effective_authority.escalation = false, d => d.effective_authority.protected_paths = [".git", ".agents", ".codex"], d => delete d.backend.trust_contract]) {
  const d = structuredClone(describe(true)); mutate(d); assert.equal(directDescriptionIssue(rehash(d)), "contradictory_execution_description");
 }
});

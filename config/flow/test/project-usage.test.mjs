import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { deriveChildRunId } from "../../../tools/flow/src/subrun-effects.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { collectProjectUsage, USAGE_LIMITS } from "../src/project-usage-state.mjs";
import { renderProjectUsage } from "../src/project-usage.mjs";
const rootRun = `run:${"a".repeat(64)}`, sibling = `run:${"b".repeat(64)}`;
const runtime = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const save = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flow-usage-collector-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "project"), state = join(root, "state"); mkdirSync(repository); mkdirSync(state);
  execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "init", "--quiet", repository], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const profile = join(state, "flow-local", digest(repository).slice(7, 31)), authority = join(profile, "authority"), directory = join(profile, "clients/verify");
  mkdirSync(authority, { recursive: true, mode: 0o700 }); mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(join(authority, "authority.sqlite"), "synthetic query-adapter branch sentinel");
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtime, node: realpathSync(process.execPath), executable: { path: "/never-executed" }, execution_trust: { fixture: true } };
  const generated = writeFeatureClient({ directory, runtimeRoot: runtime, workspace: repository, executionTrust: "supervised-native-cli", codexExecutable: "/never-executed", localStateHome: state, authorityDirectory: authority });
  save(join(profile, "profile.json"), { identity }); save(join(directory, "pilot.json"), { ...generated, directory, runtime_root: runtime, local_client: identity, execution_trust: identity.execution_trust });
  const queries = [], runs = new Map([[rootRun, { schema: "flow.run-projection/v1", run_id: rootRun, phase: "succeeded", effects: [], subruns: [] }]]);
  const observer = { status: async () => ({ state: "stopped" }), query: async (_client, request) => { queries.push(request); return runs.get(request.run_id) ?? { schema: "flow.rejection/v1", code: "unknown_run" }; } };
  const readTask = ({ runId, effect }) => ({ run_id: runId, card_id: effect.card_id, effect_id: effect.effect_id, attempt_id: effect.attempt_id, task_id: `task:${digest(effect.attempt_id).slice(7)}`, descriptor_digest: digest(effect), harness: "codex", model: { requested: "requested-model", reported: null }, cli_version: "codex-cli 0.166.0", status: "reported", authority_status: effect.status,
    metrics: { input_tokens: effect.amount ?? 10, cached_input_tokens: null, cache_write_input_tokens: null, output_tokens: 2, reasoning_output_tokens: null, turns: 1 }, token_semantics: "subset", turn_semantics: "completed_native_turn_events", cost: { usd: effect.cost ?? null, basis: effect.cost === undefined ? "unknown" : "cli_reported_list_estimate", raw_field: effect.cost === undefined ? null : "fixture.cost" }, provenance: {}, diagnostics: [] });
  return { repository, runs, queries, observer, readTask, collect: extra => collectProjectUsage({ repository, run: rootRun }, { env: { FLOW_LOCAL_CLIENT_STATE_HOME: state }, observer, readTask, ...extra }) };
}
const delegate = (n, extra = {}) => ({ effect_kind: "delegate", effect_id: `effect:${n}`, attempt_id: `attempt:${n}`, card_id: "work", invocation_started: true, status: "succeeded", ...extra });
test("direct run query excludes separate reviews and counts adopted copies only once", async t => {
  const f = fixture(t), effect = delegate(1); f.runs.get(rootRun).effects = [effect, effect, { ...effect, effect_kind: "delegate_cancellation" }];
  f.runs.set(sibling, { schema: "flow.run-projection/v1", run_id: sibling, phase: "succeeded", effects: [delegate(9)], subruns: [] });
  const report = await f.collect(); assert.equal(report.complete, true); assert.equal(report.attempts.length, 1); assert.equal(report.deduplicated_attempts, 1); assert.deepEqual(f.queries, [{ run_id: rootRun }]); assert.equal(report.cost.known_list_cost_usd, null);
});
test("distinct retries count; actual zero estimate remains known beside unknown cost", async t => {
  const f = fixture(t); f.runs.get(rootRun).effects = [delegate(1, { amount: 10, cost: 0 }), delegate(2, { amount: 20 })];
  const report = await f.collect(); assert.equal(report.attempts.length, 2); assert.equal(report.provider_totals[0].metrics.input_tokens, 30); assert.equal(report.cost.known_list_cost_usd, 0); assert.equal(report.cost.unknown_attempts, 1); assert.equal(report.cost.subtotal_complete, false);
});
test("deep research counts immutable angle versions and critics once across whole-cycle revisions", async t => {
  const f = fixture(t), cards = ["deep-angle-1-cycle-1", "deep-angle-2-cycle-1", "deep-critic-cycle-1", "deep-angle-1-cycle-2", "deep-angle-2-cycle-2", "deep-critic-cycle-2"];
  const effects = cards.map((card_id, index) => delegate(index + 1, { card_id }));
  f.runs.get(rootRun).effects = [...effects, effects[0], { effect_kind: "operation", card_id: "deep-decision-cycle-2" }];
  const report = await f.collect();
  assert.equal(report.complete, true); assert.equal(report.attempts.length, 6); assert.equal(report.deduplicated_attempts, 1);
  assert.deepEqual(new Set(report.attempts.map(attempt => attempt.card_id)), new Set(cards));
  assert.equal(report.provider_totals[0].metrics.input_tokens, 60); assert.equal(report.cost.unknown_attempts, 6);
  assert.deepEqual(f.queries, [{ run_id: rootRun }]);
});
test("only reciprocal admitted descendants join the requested lineage", async t => {
  const f = fixture(t), lineage = { parent_run_id: rootRun, card_id: "sub", card_identity: digest("sub"), revision_ordinal: 0 }, child = deriveChildRunId(lineage);
  f.runs.get(rootRun).subruns = [{ ...lineage, child_run_id: child, child_watermark: digest("child"), status: "succeeded" }];
  f.runs.set(child, { schema: "flow.run-projection/v1", run_id: child, phase: "succeeded", parent: lineage, effects: [delegate(2)], subruns: [] });
  const report = await f.collect(); assert.equal(report.complete, true); assert.equal(report.runs.length, 2); assert.deepEqual(f.queries, [{ run_id: rootRun }, { run_id: child }]);
  f.runs.get(child).parent = { ...lineage, revision_ordinal: 1 };
  const rejected = await f.collect(); assert.equal(rejected.complete, false); assert.equal(rejected.attempts.length, 0); assert(rejected.diagnostics.some(item => item.code === "usage_child_lineage_conflict"));
});
test("hard output cap also bounds oversized run-only facts", async t => {
  const f = fixture(t); f.runs.get(rootRun).phase = "x".repeat(20000);
  const report = await f.collect({ limits: { ...USAGE_LIMITS, output_bytes: 2048 } });
  assert.equal(report.complete, false); assert(Buffer.byteLength(JSON.stringify(report)) <= 2048); assert(report.diagnostics.some(item => item.code === "usage_output_limit"));
});
test("integer and finite monetary subtotal overflow remain explicit and sticky", async t => {
  const f = fixture(t); f.runs.get(rootRun).effects = [delegate(1, { amount: Number.MAX_SAFE_INTEGER, cost: 1e308 }), delegate(2, { amount: 1, cost: 1e308 }), delegate(3, { amount: 1, cost: 0 })];
  const report = await f.collect(); assert.equal(report.complete, false); assert.equal(report.provider_totals[0].metrics.input_tokens, null); assert.equal(report.cost.known_list_cost_usd, null); assert.equal(report.cost.subtotal_overflow, true); assert.match(JSON.stringify(report.diagnostics), /overflow/u);
});
test("unstarted terminal dispositions do not become pending or lose authority status", async t => {
  const f = fixture(t); f.runs.get(rootRun).effects = [delegate(1, { invocation_started: false, status: "not_created" }), delegate(2, { invocation_started: false, status: "quarantined" })];
  const report = await f.collect(); assert.equal(report.attempts[0].status, "not_created"); assert.equal(report.attempts[1].status, "unavailable"); assert.equal(report.complete, false); assert.match(renderProjectUsage(report), /authority.*quarantined/u); assert.match(renderProjectUsage(report), /authority.*not_created/u);
});

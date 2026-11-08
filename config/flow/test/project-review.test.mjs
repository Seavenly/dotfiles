import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT as trust } from "../src/supervised-native-trust.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { readRunJson } from "../src/project-run-state.mjs";
import { discoverReviewClients } from "../src/project-review-state.mjs";
import { parseReviewArguments, reviewProject } from "../src/project-review.mjs";
import { boundedCandidateDiff } from "../src/project-review-preparation.mjs";
import { renderReviewResult } from "../src/project-review-view.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const save = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
const sink = () => ({ isTTY: false, value: "", write(text) { this.value += text; } });
const producerId = "run:" + "1".repeat(64), runId = "run:" + "b".repeat(64);
const fingerprint = "sha256:" + "d".repeat(64), watermark = "sha256:" + "e".repeat(64);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-guided-review-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository"), state = join(root, "state");
  mkdirSync(repository); mkdirSync(state);
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git(["init", "--quiet"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "feature.txt"), "Before\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "Baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repository, "feature.txt"), "Exact retained change\n"); git(["commit", "--quiet", "-am", "Candidate"]);
  const head = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]), ref = git(["symbolic-ref", "HEAD"]);
  const profileRoot = join(state, "flow-local", digest(repository).slice(7, 31));
  const directory = join(profileRoot, "clients", "verify"), authority = join(profileRoot, "authority");
  mkdirSync(join(directory, "receipts"), { recursive: true }); mkdirSync(authority);
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtimeRoot, node: process.execPath,
    executable: { path: "/uninvoked/version-fixture", sha256: "sha256:" + "a".repeat(64) }, execution_trust: trust, git_identity: {} };
  save(join(profileRoot, "profile.json"), { identity, initial_check_digest: null });
  const files = writeFeatureClient({ directory, runtimeRoot, workspace: repository, executionTrust: "supervised-native-cli",
    codexExecutable: identity.executable.path, localStateHome: state, authorityDirectory: authority });
  save(join(directory, "pilot.json"), { directory, runtime_root: runtimeRoot, ...files, local_client: identity, execution_trust: trust });
  for (const briefId of ["one", "two"]) {
    mkdirSync(join(directory, "requests", briefId), { recursive: true });
    save(join(directory, "requests", briefId, "prepare-request.json"), { schema: "flow.feature-preparation-request/v1", repository, execution_trust: trust,
      brief: { schema: "flow.feature-brief/v1", id: briefId, summary: "Improve a command", acceptance: ["Existing suite passes"] }, mode: "verify" });
  }
  const env = { ...process.env, FLOW_LOCAL_CLIENT_STATE_HOME: state };
  const candidate = { schema: "work.review-candidate-projection/v1", contract: "work.review/v1", subject_id: "candidate:one", status: "sealed", current: true,
    generation: 1, watermark, candidate_fingerprint: fingerprint, candidate: { schema: "work.review-candidate/v1", candidate_id: "candidate:one", candidate_fingerprint: fingerprint, git: { clean: true, commit_sha: head, tree_sha: tree, ref } } };
  const producer = { schema: "flow.run-projection/v1", run_id: producerId, phase: "succeeded", review_candidate_reference: { candidate_id: candidate.subject_id, candidate_fingerprint: fingerprint },
    effects: [{ effect_id: "commit", status: "succeeded", operation_contract: "flow.operation/feature-direct-commit/v1", receipt: { provider_receipt: {
      schema: "flow.git-candidate-commit-receipt/v1", old_commit_sha: base, ...candidate.candidate.git } } }],
    active_plan: { cards: [{ id: "check", executor: { contract: "flow.operation/project-check/v2" } }] } };
  return { root, repository, state, directory, env, candidate, producer, git, base, head };
}

function publicRuntime(f) {
  const calls = [], graph = { cards: [{ id: "security", executor: { kind: "delegate" }, inputs: { description: { launch: { role: "lens:security" } } } }] };
  const confirmation = { target: f.candidate.candidate_fingerprint, limits: { max_elapsed_seconds: 600, max_revisions: 0 } };
  const prepared = { schema: "flow.prepared-run/v1", bundle_digest: "sha256:" + "b".repeat(64), graph, plan_fingerprint: digest(graph), confirmation, confirmation_digest: digest(confirmation) };
  const summary = { posture: "findings", coverage: { complete: true, lenses: [{ lens: "security", status: "produced" }], critic: { status: "produced" } }, merge_ready: false,
    findings: [{ summary: "Explain validation", urgency: "medium" }], cap_reasons: [] };
  const receipt = { schema: "flow.review-receipt/v1", review_id: "review:distinct-attempt", candidate_fingerprint: fingerprint, lifecycle_generation: 1, review_authority_watermark: "sha256:" + "7".repeat(64), summary };
  const record = { schema: "flow.review-projection/v1", contract: "work.review/v1", subject_id: receipt.review_id, source_run_id: runId,
    operation_contract: "flow.operation/review-record/v1", operation_effect_id: "record-effect", operation_attempt_id: "record-attempt", operation_idempotency_key: "record-key",
    candidate: f.candidate.candidate, candidate_fingerprint: fingerprint, lifecycle_generation: 1, candidate_authority_watermark: watermark,
    current: true, approval: "not_requested", summary, coverage: summary.coverage, posture: summary.posture, findings: summary.findings };
  const runtime = { calls, prepared, record, summary, receipt, launched: false, loseResponse: false, failBeforeAdmission: false, bridges: 0, preparations: 0, launches: 0,
    run: { schema: "flow.run-projection/v1", run_id: runId, bundle_digest: prepared.bundle_digest, phase: "succeeded", progress: "completed", sequence: 20, cards: [], blocks: [], legal_actions: [],
      effects: [{ effect_id: "record-effect", attempt_id: "record-attempt", idempotency_key: "record-key", status: "succeeded", operation_contract: "flow.operation/review-record/v1", receipt: { provider_receipt: receipt } }] } };
  runtime.call = async (_selection, args) => {
    calls.push(args);
    if (args[0] === "status") return { state: "running" };
    if (args[0] === "start") return { state: "running", started: false };
    if (args[0] === "query") {
      const q = JSON.parse(args[2]);
      if (q.contract) return q.subject_id === receipt.review_id ? record : f.candidate;
      if (q.run_id === producerId) return f.producer;
      if (q.run_id) return runtime.launched ? runtime.run : { schema: "flow.rejection/v1", code: "unknown_run" };
      return { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: [producerId, ...(runtime.launched ? [runId] : [])] };
    }
    if (args[0] === "local" && args[1] === "review-request") {
      runtime.bridges++; const directory = mkdtempSync(join(f.directory, "receipts", "review-")), request = join(directory, "prepare-request.json");
      save(request, { schema: "flow.predefined-flow-selection/v1", definition: "review/v1", inputs: { schema: "flow.review-request/v1", target: {
        schema: "flow.review-local-candidate/v1", candidate: f.candidate.candidate, candidate_fingerprint: fingerprint, lifecycle_generation: 1, candidate_authority_watermark: watermark },
        preparation_facts: { source_run: { run_id: producerId } }, delegation: { immutable: true } }, execution_trust: trust });
      return { status: "request_only", directory, request };
    }
    if (args[0] === "prepare") { runtime.preparations++; runtime.selectedRequest = readRunJson(args[2]); return prepared; }
    if (args[0] === "local" && args[1] === "inspect-prepared") return { routes: [{ launch: { role: "lens:security", model: "registered-model" } }], limits: confirmation.limits, trust_posture: trust };
    if (args[0] === "local" && args[1] === "accept-prepared") {
      const directory = mkdtempSync(join(f.directory, "receipts", "accepted-")), request = join(directory, "launch-request.json");
      save(request, { prepared, confirmation: { confirmation_digest: prepared.confirmation_digest } }); return { request };
    }
    if (args[0] === "launch") {
      runtime.launches++;
      if (runtime.failBeforeAdmission) return { schema: "flow.rejection/v1", operation: "launch", code: runtime.failureCode ?? "closed_facts_changed", bundle_digest: prepared.bundle_digest };
      runtime.launched = true; if (runtime.loseResponse) throw new Error("lost response after admission");
      return { schema: "flow.launch-receipt/v1", run_id: runId };
    }
    if (args[0] === "command") return { schema: "flow.command-receipt/v1" };
    throw new Error("unexpected public call " + args.join(" "));
  };
  return runtime;
}

async function invoke(f, runtime, args = [], extra = {}) {
  const stdout = sink(), stderr = sink();
  const exit = await reviewProject(["--repository", f.repository, "--json", ...args], { env: f.env, stdin: { isTTY: false }, stdout, stderr, callClient: runtime.call, ...extra });
  return { exit, stderr: stderr.value, records: stdout.value.trim().split("\n").filter(Boolean).map(text => JSON.parse(text)) };
}
const previewOf = result => result.records.find(record => record.schema === "flow.project-review-preview/v1");

test("multiple briefs deduplicate to one exact immutable client and preview retains a real bounded comparison without launching", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  assert.equal(discoverReviewClients({ repository: f.repository, env: f.env }).length, 1);
  const result = await invoke(f, runtime), preview = previewOf(result);
  assert.equal(result.exit, 0, result.stderr); assert.equal(runtime.launches, 0);
  assert.equal(preview.comparison.base_commit_sha, f.base); assert.equal(preview.comparison.commit_sha, f.head);
  assert.match(preview.comparison.diff, /Exact retained change/u);
  assert.deepEqual(runtime.selectedRequest.inputs.limits, { max_elapsed_seconds: 600, max_revisions: 0 });
  const original = readRunJson(preview.public_bridge);
  const { limits: _limits, ...inputs } = runtime.selectedRequest.inputs;
  assert.deepEqual(inputs, original.inputs); assert.deepEqual(runtime.selectedRequest.execution_trust, original.execution_trust);
  await invoke(f, runtime); assert.equal(runtime.bridges, 1); assert.equal(runtime.preparations, 1);
});

test("exact confirmation, lost response and repeat attach consume one bridge and dispatch once", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  runtime.loseResponse = true;
  const result = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  assert.equal(result.exit, 0, result.stderr); assert.equal(result.records.at(-1).review_id, runtime.receipt.review_id);
  assert.equal(result.records.at(-1).posture, "findings");
  await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  const attached = await invoke(f, runtime, ["--attach", runId]);
  assert.equal(attached.exit, 0, attached.stderr); assert.equal(runtime.launches, 1); assert.equal(runtime.bridges, 1); assert.equal(runtime.preparations, 1);
});

test("attach rejects another run before any owner or query, and cannot rewrite saved policy", async t => {
  const f = fixture(t), runtime = publicRuntime(f); await invoke(f, runtime); runtime.calls.length = 0;
  const result = await invoke(f, runtime, ["--attach", "run:" + "a".repeat(64)]);
  assert.equal(result.exit, 1); assert.equal(runtime.calls.length, 0);
  assert.throws(() => parseReviewArguments(["--attach", runId, "--timeout-seconds", "5"]), /saved policy/u);
});

test("current candidate drift refuses preparation and unsupported comparison never substitutes working tree or HEAD parent", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  f.candidate.status = "stale";
  assert.equal((await invoke(f, runtime)).exit, 1); assert.equal(runtime.bridges, 0);
  f.candidate.status = "sealed";
  f.producer.effects[0].receipt.provider_receipt.old_commit_sha = f.head;
  await assert.rejects(boundedCandidateDiff(f.repository, f.producer, f.candidate), /ancestry/u);
  assert.equal(runtime.preparations, 0);
});

test("stale or incomplete review records remain blocked with cap reasons and observed human state", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  runtime.record.coverage = { complete: false, lenses: [], critic: { status: "missing" } };
  runtime.record.cap_reasons = ["critic_evidence_missing"];
  const result = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  assert.equal(result.exit, 1, result.stderr); assert.equal(result.records.at(-1).review_status, "review_incomplete");
  assert.match(renderReviewResult(result.records.at(-1)), /critic_evidence_missing/u);
  runtime.record.coverage = runtime.summary.coverage; runtime.record.current = false; runtime.record.approval = "ineligible";
  const stale = await invoke(f, runtime, ["--attach", runId]);
  assert.equal(stale.exit, 1); assert.equal(stale.records.at(-1).review_status, "stale");
  runtime.record.current = true; runtime.record.approval = "approved"; runtime.record.human_status = "approved";
  const later = await invoke(f, runtime, ["--attach", runId]);
  assert.equal(later.exit, 0); assert.equal(later.records.at(-1).approval, "approved"); assert.equal(later.records.at(-1).guided_approval_granted, false);
});

test("record source/effect/attempt/candidate mismatches refuse instead of guessing a candidate-only record", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  for (const [field, wrong] of [["source_run_id", producerId], ["operation_effect_id", "wrong"], ["operation_attempt_id", "wrong"], ["operation_idempotency_key", "wrong"], ["candidate_fingerprint", "sha256:" + "f".repeat(64)], ["lifecycle_generation", 2]]) {
    const before = runtime.record[field]; runtime.record[field] = wrong;
    const result = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
    assert.equal(result.exit, 1, field); assert.match(result.stderr, /does not bind/u); runtime.record[field] = before;
  }
  assert.equal(runtime.launches, 1);
});

test("stale-before-admission rejection retains exact evidence and refresh requires fresh confirmation", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  runtime.failBeforeAdmission = true;
  const failed = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  assert.equal(failed.exit, 1); assert.equal(runtime.launched, false);
  const refreshed = await invoke(f, runtime, ["--refresh"]);
  assert.equal(refreshed.exit, 0, refreshed.stderr); assert.equal(runtime.bridges, 2); assert.equal(runtime.preparations, 2);
  const intentRoot = dirname(preview.prepared_file);
  assert.ok(readdirSync(dirname(intentRoot)).some(name => name.startsWith("session.retained-")));
});

test("terminal control characters in provider findings stay escaped and never become terminal instructions", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  runtime.record.findings = [{ summary: "\u001b[2Junsafe\rrewritten" }];
  const result = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  const rendered = renderReviewResult(result.records.at(-1));
  assert.equal(rendered.includes("\u001b"), false); assert.equal(rendered.includes("\r"), false);
  assert.equal(existsSync(join(f.state, "authority.sqlite")), false);
});

test("concurrent confirmations coordinate the same saved launch without a second dispatch", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  let entered, release;
  const enteredLaunch = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const call = async (selection, args) => { if (args[0] === "launch") { entered(); await hold; } return runtime.call(selection, args); };
  const first = invoke(f, runtime, ["--confirm", preview.confirmation_digest], { callClient: call });
  await enteredLaunch;
  const concurrent = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  assert.equal(concurrent.exit, 1); assert.match(concurrent.stderr, /Another frontend/u);
  release(); assert.equal((await first).exit, 0); assert.equal(runtime.launches, 1); assert.equal(runtime.bridges, 1);
});

test("uncertain accepted launch holds its saved intent and refuses refresh without creating new facts", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  let attempted = false;
  const call = async (selection, args) => {
    if (args[0] === "launch") { attempted = true; throw new Error("response unavailable"); }
    if (attempted && args[0] === "query" && JSON.parse(args[2]).run_id === runId) return { schema: "flow.rejection/v1", code: "transport_unavailable" };
    return runtime.call(selection, args);
  };
  const unknown = await invoke(f, runtime, ["--confirm", preview.confirmation_digest], { callClient: call });
  assert.equal(unknown.exit, 1); assert.match(unknown.stderr, /--attach/u);
  const refreshed = await invoke(f, runtime, ["--refresh"]);
  assert.equal(refreshed.exit, 1); assert.match(refreshed.stderr, /accepted launch intent/u);
  assert.equal(runtime.preparations, 1); assert.equal(runtime.bridges, 1);
});

test("fresh facts after explicit refresh have a new confirmation and the previous yes is refused", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  runtime.failBeforeAdmission = true;
  await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  runtime.prepared.confirmation = { ...runtime.prepared.confirmation, observed_host_epoch: 2 };
  runtime.prepared.confirmation_digest = digest(runtime.prepared.confirmation);
  const next = previewOf(await invoke(f, runtime, ["--refresh"]));
  assert.notEqual(next.confirmation_digest, preview.confirmation_digest);
  const refused = await invoke(f, runtime, ["--confirm", preview.confirmation_digest]);
  assert.equal(refused.exit, 1); assert.equal(runtime.launches, 1); assert.equal(runtime.bridges, 2);
});

test("a running incompatible owner refuses through the existing public start fence before preparation", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const call = (selection, args) => args[0] === "start" ? { schema: "flow.rejection/v1", code: "owner_runtime_binding_changed" } : runtime.call(selection, args);
  const result = await invoke(f, runtime, [], { callClient: call });
  assert.equal(result.exit, 1); assert.match(result.stderr, /owner_runtime_binding_changed/u);
  assert.equal(runtime.bridges, 0); assert.equal(runtime.preparations, 0); assert.equal(runtime.launches, 0);
});

test("saved policy is used on attachment regardless new-command defaults and no facts are regenerated", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = previewOf(await invoke(f, runtime, ["--timeout-seconds", "120", "--max-revisions", "1"]));
  const confirmed = await invoke(f, runtime, ["--timeout-seconds", "120", "--max-revisions", "1", "--confirm", preview.confirmation_digest]);
  assert.equal(confirmed.exit, 0, confirmed.stderr);
  const attached = await invoke(f, runtime, ["--attach", runId]);
  assert.equal(attached.exit, 0, attached.stderr); assert.equal(runtime.bridges, 1); assert.equal(runtime.launches, 1);
  assert.deepEqual(runtime.selectedRequest.inputs.limits, { max_elapsed_seconds: 120, max_revisions: 1 });
});

test("incomplete preview retains its bridge evidence and requires explicit unlaunched refresh", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  let once = true;
  const call = (selection, args) => {
    if (args[0] === "prepare" && once) { once = false; throw new Error("prepare response unavailable before any launch"); }
    return runtime.call(selection, args);
  };
  assert.equal((await invoke(f, runtime, [], { callClient: call })).exit, 1);
  const retry = await invoke(f, runtime);
  assert.equal(retry.exit, 1); assert.match(retry.stderr, /incomplete owned preview/u); assert.equal(runtime.bridges, 1);
  const next = await invoke(f, runtime, ["--refresh"]);
  assert.equal(next.exit, 0, next.stderr); assert.equal(runtime.bridges, 2); assert.equal(runtime.launches, 0);
});


test("review owner-epoch launch rejection permits only exact unknown-run refresh and fresh confirmation", async t => {
  const f = fixture(t), runtime = publicRuntime(f), preview = previewOf(await invoke(f, runtime));
  runtime.failBeforeAdmission = true; runtime.failureCode = "run_authority_changed";
  assert.equal((await invoke(f, runtime, ["--confirm", preview.confirmation_digest])).exit, 1);
  runtime.prepared.confirmation = { ...runtime.prepared.confirmation, observed_host_epoch: 2 };
  runtime.prepared.confirmation_digest = digest(runtime.prepared.confirmation);
  const refreshed = await invoke(f, runtime, ["--refresh"]);
  assert.equal(refreshed.exit, 0, refreshed.stderr);
  assert.notEqual(previewOf(refreshed).confirmation_digest, preview.confirmation_digest);
  assert.equal(runtime.bridges, 2); assert.equal(runtime.launches, 1); assert.equal(runtime.launched, false);
});

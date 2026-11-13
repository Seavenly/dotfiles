import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { SUPERVISED_NATIVE_ACKNOWLEDGMENT as trust } from "../src/supervised-native-trust.mjs";
import { writeFeatureClient } from "../scripts/feature-client-files.mjs";
import { discoverProjectRuns, lockProjectSubmission, readRunJson } from "../src/project-run-state.mjs";
import { parseRunArguments, runProject } from "../src/project-run.mjs";
import { projectRunProgress, projectRunBlocked, renderRunProgress, runDecisionActions, summarizeProjectRun, renderRunResult } from "../src/project-run-view.mjs";

test("settled quarantine and authority time blocks remain distinct from unresolved execution", () => {
  const run = { run_id: "run:deep-time", phase: "active", progress: "waiting", cards: [{ id: "deep-gate-cycle-1", status: "waiting_checkpoint" }],
    effects: [{ effect_id: "failed-angle", card_id: "deep-angle-2-cycle-1", status: "quarantined", receipt: { outcome: "quarantined", provider_receipt: { schema: "flow.delegate-quarantine/v1" } } }],
    deep_research: { schema: "flow.deep-research-progress/v1", cycle: 1, remaining_cycles: 1, operationally_blocked: true,
      completion_block: "execution_time_unavailable", scope: { text: "Which guarantees remain?" }, report: { answer: "Retained original-scope evidence" }, scope_proposal: null } };
  const progress = projectRunProgress(run), rendered = renderRunProgress(progress);
  assert.equal(projectRunBlocked(run), true);
  assert.equal(progress.effects[0].outcome, "quarantined");
  assert.match(rendered, /failed-angle: quarantined \(quarantined\)/u);
  assert.match(rendered, /Deep completion blocked: execution_time_unavailable/u);
  assert.doesNotMatch(rendered, /outcome unresolved/u);
  assert.equal(projectRunBlocked({ ...run, effects: [], deep_research: undefined }), false);
  const evidenceFailure = { ...run, cards: [{ id: "deep-decision-cycle-1", status: "completed" }], effects: [],
    deep_research: { schema: "flow.deep-research-progress/v1", operationally_blocked: true, report: null, scope_proposal: null, code: "deep_continuation_evidence_changed" } };
  assert.equal(projectRunBlocked(evidenceFailure), true);
  assert.match(renderRunProgress(projectRunProgress(evidenceFailure)), /Deep evidence blocked: deep_continuation_evidence_changed/u);
  assert.equal(projectRunBlocked({ ...evidenceFailure, phase: "cancelled" }), false);
});

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const save = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
const sink = () => ({ isTTY: false, value: "", write(text) { this.value += text; } });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "flow-guided-run-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository"), state = join(root, "state");
  mkdirSync(repository); mkdirSync(state);
  execFileSync("/usr/bin/git", ["init", "--quiet", repository]);
  const profileRoot = join(state, "flow-local", digest(repository).slice(7, 31));
  const directory = join(profileRoot, "clients", "verify"), authority = join(profileRoot, "authority");
  mkdirSync(join(directory, "requests", "feature-one"), { recursive: true });
  mkdirSync(join(directory, "receipts")); mkdirSync(authority);
  const identity = { schema: "flow.local-client/v1", repository, runtime_root: runtimeRoot, node: process.execPath,
    executable: { path: "/uninvoked/version-fixture", sha256: "sha256:" + "a".repeat(64) }, execution_trust: trust, git_identity: {} };
  save(join(profileRoot, "profile.json"), { identity, initial_check_digest: null });
  const clientFiles = writeFeatureClient({ directory, runtimeRoot, workspace: repository, executionTrust: "supervised-native-cli",
    codexExecutable: identity.executable.path, localStateHome: state, authorityDirectory: authority });
  save(join(directory, "pilot.json"), { directory, runtime_root: runtimeRoot, ...clientFiles, local_client: identity, execution_trust: trust });
  const request = join(directory, "requests", "feature-one", "prepare-request.json");
  save(request, { schema: "flow.feature-preparation-request/v1", repository, execution_trust: trust,
    brief: { schema: "flow.feature-brief/v1", id: "one", summary: "Improve an existing command", acceptance: ["Existing behavior remains correct"] }, mode: "verify" });
  const env = { ...process.env, FLOW_LOCAL_CLIENT_STATE_HOME: state };
  const selection = discoverProjectRuns({ repository, env })[0];
  return { root, repository, state, env, request, directory, authority, selection };
}

function publicRuntime(f) {
  let launched = false, starts = 0, launchCount = 0, prepareCount = 0, responseLoss = false;
  const graph = { cards: [{ id: "feature-apply", executor: { kind: "delegate" }, inputs: {} },
    { id: "feature-project-check", executor: { kind: "operation" } }, { id: "feature-critique", executor: { kind: "delegate" }, inputs: {} }] };
  const confirmation = { brief: readRunJson(f.request).brief, check: "Registered GREEN-only suite" };
  const prepared = { schema: "flow.prepared-run/v1", kind: "predefined", bundle_digest: "sha256:" + "b".repeat(64), graph,
    plan_fingerprint: digest(graph), confirmation, confirmation_digest: digest(confirmation), explicit_facts: { limits: { max_elapsed_seconds: 600 } },
    selection: { inputs: { brief: confirmation.brief } }, trust_posture: { execution_contract: trust.schema }, requested_authority: {} };
  const runId = "run:" + "b".repeat(64);
  let run = { schema: "flow.run-projection/v1", run_id: runId, bundle_digest: prepared.bundle_digest, sequence: 9, phase: "succeeded", progress: "complete", watermark: {},
    cards: [{ id: "feature-apply", status: "completed" }, { id: "feature-project-check", status: "completed" }, { id: "feature-critique", status: "completed" }],
    effects: [{ effect_id: "check", status: "succeeded", operation_contract: "flow.operation/project-check/v2", receipt: { provider_receipt: { outcome: "passed", exit_code: 0, candidate: { commit_sha: "c".repeat(40) } } } }],
    review_candidate_reference: { candidate_id: "candidate:one", candidate_fingerprint: "sha256:" + "d".repeat(64) }, legal_actions: [], resource_dispositions: [], active_plan: graph };
  const candidate = { status: "sealed", subject_id: "candidate:one", candidate_fingerprint: "sha256:" + "d".repeat(64), candidate: { git: { commit_sha: "c".repeat(40), ref: "refs/heads/feature" } } };
  const calls = [];
  const call = async (_selection, args) => {
    calls.push(args);
    if (args[0] === "status") return { state: starts ? "running" : "stopped" };
    if (args[0] === "start") { starts++; return { state: "running" }; }
    if (args[0] === "prepare") { prepareCount++; return prepared; }
    if (args[0] === "local" && args[1] === "inspect-prepared") return { brief: confirmation.brief, trust_posture: prepared.trust_posture, limits: prepared.explicit_facts.limits };
    if (args[0] === "local") {
      const path = join(f.directory, "receipts", "launch-request.json");
      save(path, { prepared, confirmation: { confirmation_digest: prepared.confirmation_digest } });
      return { request: path };
    }
    if (args[0] === "launch") { launched = true; launchCount++; if (responseLoss) throw new Error("lost response after authority admission"); return { schema: "flow.launch-receipt/v1", run_id: runId }; }
    if (args[0] === "query") {
      const request = JSON.parse(args[2]);
      if (request.contract) return candidate;
      if (!request.run_id) return { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: launched ? [runId] : [] };
      return launched ? run : { schema: "flow.rejection/v1", code: "unknown_run" };
    }
    if (args[0] === "command") return { schema: "flow.command-receipt/v1" };
    throw new Error("unexpected public command " + args[0]);
  };
  return { call, prepared, runId, calls, get run() { return run; }, set run(value) { run = value; },
    get launches() { return launchCount; }, get preparations() { return prepareCount; }, set loseResponse(value) { responseLoss = value; } };
}

async function invoke(f, runtime, args = [], extra = {}) {
  const stdout = sink(), stderr = sink();
  const exit = await runProject(["--repository", f.repository, "--json", ...args], { env: f.env, stdin: { isTTY: false }, stdout, stderr, callClient: runtime.call, ...extra });
  return { exit, stderr: stderr.value, records: stdout.value.trim().split("\n").filter(Boolean).map(value => JSON.parse(value)) };
}

test("guided run discovers exact old immutable clients without executing them, refuses changed client and request bindings", t => {
  const f = fixture(t);
  assert.equal(f.selection.pilot.runtime_root, runtimeRoot);
  assert.equal(f.selection.authority_directory, f.authority);
  assert.equal(existsSync(join(f.authority, "authority.sqlite")), false);
  writeFileSync(join(f.directory, "flow"), "#!/bin/sh\necho untrusted\n");
  assert.throws(() => discoverProjectRuns({ repository: f.repository, env: f.env }), /Generated client bytes changed/u);
});

test("guided run preview does not accept or launch; exact confirmation and repeated confirmation adopt the same run", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  assert.equal(preview.exit, 0, preview.stderr);
  const selected = preview.records.find(record => record.schema === "flow.project-run-preview/v1");
  assert.equal(runtime.launches, 0); assert.equal(runtime.preparations, 1);
  assert.ok(readRunJson(selected.prepared_file));
  const bad = await invoke(f, runtime, ["--confirm", "sha256:" + "f".repeat(64)]);
  assert.equal(bad.exit, 1); assert.equal(runtime.launches, 0);
  const confirmed = await invoke(f, runtime, ["--confirm", selected.confirmation_digest]);
  assert.equal(confirmed.exit, 0, confirmed.stderr);
  assert.equal(confirmed.records.at(-1).status, "succeeded");
  assert.equal(runtime.launches, 1); assert.equal(runtime.preparations, 1);
  assert.ok(readRunJson(join(f.selection.retained_directory, "accepted.json")));
  const repeated = await invoke(f, runtime, ["--confirm", selected.confirmation_digest]);
  assert.equal(repeated.exit, 0, repeated.stderr);
  assert.equal(runtime.launches, 1); assert.equal(runtime.preparations, 1);
});

test("lost launch response is reconciled through the exact public run without reprepare or duplicate launch", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  runtime.loseResponse = true;
  const result = await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.records.at(-1).run_id, runtime.runId);
  assert.equal(runtime.launches, 1); assert.equal(runtime.preparations, 1);
});

test("submission mutex refuses concurrent work and releases with its owning connection", t => {
  const f = fixture(t);
  const release = lockProjectSubmission(f.selection);
  assert.throws(() => lockProjectSubmission(f.selection), /Another frontend/u);
  release();
  lockProjectSubmission(f.selection)();
});

test("stale decision refuses without transplanting approval to a new watermark", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  runtime.run = { ...runtime.run, phase: "active", progress: "blocked", legal_actions: [{ schema: "flow.command/v1", type: "checkpoint_decision", run_id: runtime.runId, checkpoint_id: "approve-one", decision: "approve", expected_watermark: { sequence: 10 } }] };
  const result = await invoke(f, runtime, ["--attach", runtime.runId, "--action", "sha256:" + "f".repeat(64)]);
  assert.equal(result.exit, 1); assert.match(result.stderr, /no longer offered/u);
  assert.equal(runtime.calls.filter(args => args[0] === "command").length, 0);
});

test("public projection rendering never mistakes cancelled unresolved/quarantined work for positive settlement", () => {
  const run = { phase: "cancelled", run_id: "run:one", cards: [], effects: [
    { effect_id: "a", status: "unresolved", last_observation: { provider_observation: { code: "uncertain_external_outcome" } } },
    { effect_id: "b", status: "quarantined", receipt: { outcome: "quarantined" } }], legal_actions: [] };
  assert.equal(projectRunProgress(run).effects[0].outcome, "uncertain_external_outcome");
  const result = summarizeProjectRun(run, { selection: { repository: "/project", request: "/private/request", retained_directory: "/private/retained" }, status: "blocked" });
  assert.deepEqual(result.unresolved_effects, ["a"]); assert.deepEqual(result.quarantined_effects, ["b"]);
  assert.match(renderRunResult(result), /workspace reuse are not established/u);
});

test("only fresh operator decisions are displayed, not executor commands or forge/human review commands", () => {
  const allowed = { schema: "flow.command/v1", type: "recovery", recovery: "settle_cancelled_capture", run_id: "run:one", expected_watermark: {} };
  const actions = runDecisionActions({ legal_actions: [allowed, { ...allowed, type: "operation_execute" }, { schema: "work.review-human-command/v1", type: "merge" }] });
  assert.deepEqual(actions.map(action => action.command), [allowed]);
  assert.throws(() => parseRunArguments(["--confirm", "abc"]), /exact/u);
  assert.throws(() => parseRunArguments(["--attach", "run:" + "a".repeat(64), "--confirm", "sha256:" + "a".repeat(64)]), /separately/u);
});

test("a positive fresh decision submits the exact offered command and displays its authoritative changed state", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  const action = { schema: "flow.command/v1", type: "checkpoint_decision", run_id: runtime.runId, checkpoint_id: "choice", decision: "approve", expected_watermark: { sequence: 10 } };
  runtime.run = { ...runtime.run, phase: "active", progress: "waiting", sequence: 10, legal_actions: [action] };
  let submitted;
  const call = async (selection, args) => {
    if (args[0] === "command") { submitted = readRunJson(args[2]); runtime.run = { ...runtime.run, sequence: 11, phase: "succeeded", legal_actions: [] }; }
    return runtime.call(selection, args);
  };
  const result = await invoke(f, runtime, ["--attach", runtime.runId, "--action", digest(action)], { callClient: call });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(submitted, action);
  assert.equal(result.records.find(record => record.schema === "flow.project-run-progress/v1").sequence, 11);
});

test("explicit cancel keeps observing unsettled effects until positive receipts, without releasing or approving workspace settlement", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  const cancel = { schema: "flow.command/v1", type: "cancel", run_id: runtime.runId, expected_watermark: { sequence: 10 } };
  runtime.run = { ...runtime.run, phase: "active", progress: "executing", sequence: 10, effects: [{ effect_id: "checker", status: "unresolved", receipt: null }], review_candidate_reference: null, legal_actions: [cancel] };
  let cancelSubmitted = false, afterCancelQueries = 0;
  const call = async (selection, args) => {
    if (args[0] === "command") {
      assert.deepEqual(readRunJson(args[2]), cancel); cancelSubmitted = true;
      runtime.run = { ...runtime.run, phase: "cancelled", sequence: 11, legal_actions: [], resource_dispositions: [{ resource_id: "workspace:one", disposition: "quarantined" }] };
    }
    if (args[0] === "query" && cancelSubmitted && JSON.parse(args[2]).run_id && ++afterCancelQueries > 1) {
      runtime.run = { ...runtime.run, sequence: 12, effects: [{ effect_id: "checker", status: "late_succeeded", receipt: { provider_receipt: { retired: true, outcome: "cancelled" } } }] };
    }
    return runtime.call(selection, args);
  };
  const result = await invoke(f, runtime, ["--cancel", runtime.runId], { callClient: call });
  assert.equal(result.exit, 1, result.stderr); assert.equal(result.records.at(-1).status, "cancelled");
  assert.ok(result.records.some(record => record.phase === "cancelled" && record.sequence === 11));
  assert.deepEqual(result.records.at(-1).unresolved_effects, []);
  assert.equal(result.records.at(-1).workspace_settlement[0].disposition, "quarantined");
  assert.equal(runtime.calls.filter(args => args[0] === "command").length, 1);
});

test("owner loss returns an actionable unavailable result and never prepares a replacement run", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  runtime.run = { ...runtime.run, phase: "active", progress: "executing", effects: [{ effect_id: "writer", status: "unresolved", receipt: null }] };
  let statuses = 0;
  const call = async (selection, args) => args[0] === "status" && ++statuses > 1 ? { state: "stopped" } : runtime.call(selection, args);
  const result = await invoke(f, runtime, ["--attach", runtime.runId], { callClient: call });
  assert.equal(result.exit, 1, result.stderr); assert.equal(result.records.at(-1).status, "owner_unavailable");
  assert.match(result.records.at(-1).next_commands[0], /--attach/u);
  assert.equal(runtime.preparations, 1); assert.equal(runtime.launches, 1);
});

test("unreadable or unknown authority is not interpreted as an empty run index", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const result = await invoke(f, runtime, [], { callClient: async (selection, args) => args[0] === "query" ? { schema: "flow.rejection/v1", code: "authority_integrity_error" } : runtime.call(selection, args) });
  assert.equal(result.exit, 1); assert.equal(runtime.preparations, 0); assert.equal(runtime.launches, 0);
  assert.equal(runtime.calls.filter(args => args[0] === "start").length, 0);
});

test("old pinned client with no offline query support starts only its known stopped owner and discovers existing work", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  let running = false;
  const call = async (selection, args) => {
    if (args[0] === "query" && !running) return { schema: "flow.rejection/v1", code: "transport_unavailable" };
    if (args[0] === "status") return { state: running ? "running" : "stopped" };
    if (args[0] === "start") { running = true; return { state: "running" }; }
    if (args[0] === "query") return JSON.parse(args[2]).run_id ? { ...runtime.run, phase: "active" } : { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: [runtime.runId] };
    return runtime.call(selection, args);
  };
  const result = await invoke(f, runtime, [], { callClient: call });
  assert.equal(result.exit, 1); assert.match(result.stderr, /Existing work/u);
  assert.match(result.stderr, /no matching guided receipt/u);
  assert.ok(result.stderr.includes(f.selection.client)); assert.match(result.stderr, /watch --input/u);
  assert.ok(result.stderr.split("\n").some(line => line.startsWith("'") && line.includes(" query --input ")), "fallback query is a separate copyable command line");
  assert.equal(runtime.preparations, 0); assert.equal(runtime.launches, 0);
  assert.equal(result.records[0].schema, "flow.project-run-owner/v1");
});

test("submission mutex is released after actual owning process exit, without a PID lock repair", t => {
  const f = fixture(t);
  const module = pathToFileURL(join(runtimeRoot, "config/flow/src/project-run-state.mjs")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { lockProjectSubmission } from ${JSON.stringify(module)}; lockProjectSubmission(${JSON.stringify({ retained_directory: f.selection.retained_directory })}); process.exit(0);`], { env: { ...f.env, NODE_NO_WARNINGS: "1" } });
  lockProjectSubmission(f.selection)();
});

test("concurrent preview callers do not prepare twice while the first public prepare is in flight", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  let release, began;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { began = resolve; });
  const call = async (selection, args) => { if (args[0] === "prepare") { began(); await pending; } return runtime.call(selection, args); };
  const first = invoke(f, runtime, [], { callClient: call });
  await entered;
  const concurrent = await invoke(f, runtime);
  assert.equal(concurrent.exit, 1); assert.match(concurrent.stderr, /Another frontend/u);
  release();
  assert.equal((await first).exit, 0); assert.equal(runtime.preparations, 1);
});

test("partial unaccepted preview is retained by explicit refresh and selected request drift refuses acceptance", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  mkdirSync(f.selection.retained_directory);
  save(join(f.selection.retained_directory, "prepared.json"), { interrupted: true });
  const interrupted = await invoke(f, runtime);
  assert.equal(interrupted.exit, 1); assert.match(interrupted.stderr, /incomplete/u);
  const refreshed = await invoke(f, runtime, ["--refresh"]);
  assert.equal(refreshed.exit, 0, refreshed.stderr); assert.equal(runtime.preparations, 1);
  const request = readRunJson(f.request); request.brief.summary = "Changed after preview"; save(f.request, request);
  const confirmed = await invoke(f, runtime, ["--confirm", refreshed.records.at(-1).confirmation_digest]);
  assert.equal(confirmed.exit, 1); assert.match(confirmed.stderr, /changed after preview/u);
  assert.equal(runtime.launches, 0);
});

test("a known public pre-admission Git drift refusal permits only explicit fresh preview and confirmation", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  const call = async (selection, args) => args[0] === "launch" ? { schema: "flow.rejection/v1", operation: "launch",
    code: "workspace_fingerprint_changed", bundle_digest: runtime.prepared.bundle_digest } : runtime.call(selection, args);
  const refused = await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest], { callClient: call });
  assert.equal(refused.exit, 1); assert.match(refused.stderr, /workspace_fingerprint_changed/u);
  const fresh = await invoke(f, runtime, ["--refresh"]);
  assert.equal(fresh.exit, 0, fresh.stderr); assert.equal(fresh.records.at(-1).status, "confirmation_required");
  assert.equal(runtime.preparations, 2); assert.equal(runtime.launches, 0);
});

test("ambiguous transport after saved acceptance never authorizes a refreshed replacement task", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  const call = async (selection, args) => {
    if (args[0] === "launch") throw new Error("lost connection with unknown admission");
    return runtime.call(selection, args);
  };
  const refused = await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest], { callClient: call });
  assert.equal(refused.exit, 1); assert.match(refused.stderr, /Reattach with/u);
  const refresh = await invoke(f, runtime, ["--refresh"]);
  assert.equal(refresh.exit, 1); assert.match(refresh.stderr, /uncertain accepted work/u);
  assert.equal(runtime.preparations, 1); assert.equal(runtime.launches, 0);
});

test("mismatched attach refuses before querying or starting an old client owner", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  await invoke(f, runtime);
  const before = runtime.calls.length;
  const result = await invoke(f, runtime, ["--attach", "run:" + "c".repeat(64)]);
  assert.equal(result.exit, 1); assert.match(result.stderr, /does not own/u);
  assert.equal(runtime.calls.length, before);
});

test("a running owner must pass the selected client's public start binding fence before preparation", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  let starts = 0;
  const call = async (selection, args) => {
    if (args[0] === "status") return { state: "running" };
    if (args[0] === "start") { starts++; return { schema: "flow.rejection/v1", code: "owner_runtime_binding_mismatch" }; }
    return runtime.call(selection, args);
  };
  const refused = await invoke(f, runtime, [], { callClient: call });
  assert.equal(refused.exit, 1); assert.match(refused.stderr, /owner_runtime_binding_mismatch/u);
  assert.equal(starts, 1); assert.equal(runtime.preparations, 0); assert.equal(runtime.launches, 0);
});

test("compatible running owner reuse goes through public start rather than spawning another owner", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  let starts = 0;
  const call = async (selection, args) => {
    if (args[0] === "status") return { state: "running" };
    if (args[0] === "start") { starts++; return { state: "running", started: false, already_running: true }; }
    return runtime.call(selection, args);
  };
  const preview = await invoke(f, runtime, [], { callClient: call });
  assert.equal(preview.exit, 0, preview.stderr); assert.equal(starts, 1);
  assert.equal(preview.records.at(-1).owner_started, false); assert.equal(runtime.launches, 0);
});

test("retry refuses a consistently rehashed saved launch carrying another prepared task under the old confirmation", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  let launchCalls = 0;
  const call = async (selection, args) => { if (args[0] === "launch") { launchCalls++; throw new Error("transport lost before known admission"); } return runtime.call(selection, args); };
  assert.equal((await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest], { callClient: call })).exit, 1);
  const path = join(f.selection.retained_directory, "accepted.json"), intent = readRunJson(path), launch = readRunJson(intent.launch_file);
  launch.prepared = { ...launch.prepared, bundle_digest: "sha256:" + "e".repeat(64) };
  save(intent.launch_file, launch); intent.launch_digest = digest(launch); save(path, intent);
  const refused = await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest], { callClient: call });
  assert.equal(refused.exit, 1); assert.match(refused.stderr, /exact confirmed prepared task/u);
  assert.equal(launchCalls, 1); assert.equal(runtime.preparations, 1);
});

test("an authentic configured GREEN-only card remains pending before its first effect, rather than content-only", () => {
  // Reduced from the first official62da projection: writer executing, check
  // present in the authoritative plan/cards, no project-check effect yet.
  const run = { run_id: "run:pending", phase: "active", effects: [],
    active_plan: { cards: [{ id: "feature-project-check", executor: { kind: "operation", contract: "flow.operation/project-check/v2" } }] },
    cards: [{ id: "feature-apply", executor_kind: "delegate", status: "executing" }, { id: "feature-project-check", executor_kind: "operation", status: "pending" }] };
  const result = summarizeProjectRun(run, { selection: { repository: "/project", request: "/private/request", retained_directory: "/private/evidence" }, status: "detached" });
  assert.equal(result.checks.kind, "registered_green_only");
  assert.equal(result.checks.status, "pending"); assert.equal(result.checks.outcome, null);
  assert.equal(result.checks.evidence, null); assert.notEqual(result.checks.project_checks, "not_run");
});

test("configured v1 expected RED/GREEN remains pending before its first effect", () => {
  const run = { run_id: "run:pending-v1", phase: "active", effects: [],
    active_plan: { cards: [{ id: "feature-health", executor: { kind: "operation", contract: "flow.operation/feature-test/v1" } }] },
    cards: [{ id: "feature-health", executor_kind: "operation", status: "pending" }] };
  const result = summarizeProjectRun(run, { selection: { repository: "/project", request: "/private/request", retained_directory: "/private/evidence" }, status: "detached" });
  assert.equal(result.checks.kind, "registered_expected_red_then_green"); assert.equal(result.checks.status, "pending");
  assert.deepEqual(result.checks.evidence, []);
});

test("official seq20 executing one-attempt check keeps following to check, critique and seal without a second dispatch", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime);
  await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  const completed = runtime.run;
  const retry = { schema: "flow.operation-retry-projection/v1", consumed_attempts: 1, max_attempts: 1, remaining_attempts: 0, status: "exhausted", not_before: null };
  // Exact meaningful seq20 facts from the failed official frontend follow.
  const executing = { ...completed, phase: "active", progress: "executing", sequence: 20, blocks: [], review_candidate_reference: null,
    cards: [{ id: "feature-apply", status: "completed" }, { id: "feature-capture", status: "completed" }, { id: "feature-direct-commit", status: "completed" },
      { id: "feature-project-check", status: "executing" }, { id: "feature-critique", status: "pending" }, { id: "feature-seal", status: "pending" }],
    effects: [{ effect_id: "check", card_id: "feature-project-check", operation_contract: "flow.operation/project-check/v2", status: "unresolved", invocation_started: true, last_observation: null, receipt: null, retry },
      { effect_id: "capture", card_id: "feature-capture", operation_contract: "flow.operation/feature-capture/v1", status: "succeeded", receipt: { outcome: "created" }, retry },
      { effect_id: "commit", card_id: "feature-direct-commit", operation_contract: "flow.operation/feature-direct-commit/v1", status: "succeeded", receipt: { outcome: "created" }, retry }] };
  let observations = 0;
  const call = async (selection, args) => {
    if (args[0] === "query" && JSON.parse(args[2]).run_id) { runtime.run = ++observations <= 2 ? executing : { ...completed, sequence: 30 }; }
    return runtime.call(selection, args);
  };
  const result = await invoke(f, runtime, ["--attach", runtime.runId], { callClient: call });
  assert.equal(result.exit, 0, result.stderr); assert.equal(result.records.at(-1).status, "succeeded");
  assert.ok(result.records.some(record => record.sequence === 20)); assert.ok(result.records.some(record => record.sequence === 30));
  assert.equal(result.records.at(-1).checks.outcome, "passed"); assert.equal(result.records.at(-1).critique, "completed");
  assert.equal(runtime.launches, 1); assert.equal(runtime.preparations, 1);
  assert.equal(runtime.calls.filter(args => args[0] === "command").length, 0);
});

test("an authoritative blocked card still ends follow with legal decisions, without approval", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime); await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  runtime.run = { ...runtime.run, phase: "active", progress: "blocked", cards: [{ id: "feature-critique", status: "blocked" }], review_candidate_reference: null };
  const result = await invoke(f, runtime, ["--attach", runtime.runId]);
  assert.equal(result.exit, 1); assert.equal(result.records.at(-1).status, "blocked"); assert.equal(runtime.launches, 1);
  assert.equal(runtime.calls.filter(args => args[0] === "command").length, 0);
});

test("known failed registered check is blocked with its actual failure, never a pass or content-only result", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime); await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  runtime.run = { ...runtime.run, phase: "active", progress: "waiting", review_candidate_reference: null,
    effects: [{ effect_id: "check", card_id: "feature-project-check", operation_contract: "flow.operation/project-check/v2", status: "not_created",
      receipt: { provider_receipt: { schema: "work.project-check-absence-receipt/v2", found: false, complete: true, record: { schema: "work.project-check-receipt/v2", outcome: "failed", exit_code: 1, retired: true } } } }] };
  const result = await invoke(f, runtime, ["--attach", runtime.runId, "--follow-seconds", "1"]);
  assert.equal(result.exit, 1); assert.equal(result.records.at(-1).status, "blocked");
  assert.equal(result.records.at(-1).checks.kind, "registered_green_only"); assert.equal(result.records.at(-1).checks.outcome, "failed");
  assert.equal(runtime.calls.filter(args => args[0] === "command").length, 0);
});

// Reduced public terminal shape; receipt validity itself remains the authority's job.
test("positively retired cancelled check preserves cancelled result and held workspace without automatic settlement", async t => {
  const f = fixture(t), runtime = publicRuntime(f);
  const preview = await invoke(f, runtime); await invoke(f, runtime, ["--confirm", preview.records.at(-1).confirmation_digest]);
  runtime.run = { ...runtime.run, phase: "cancelled", progress: "complete", review_candidate_reference: null,
    cards: [{ id: "feature-project-check", status: "abandoned" }],
    resource_dispositions: [{ claim: { resource: "workspace" }, disposition: "quarantined" }],
    effects: [{ effect_id: "check", card_id: "feature-project-check", operation_contract: "flow.operation/project-check/v2", status: "not_created",
      receipt: { outcome: "not_created", provider_receipt: { schema: "work.project-check-absence-receipt/v2", found: false, complete: true,
        record: { schema: "work.project-check-receipt/v2", outcome: "cancelled", exit_code: null, retired: true } } } }] };
  const result = await invoke(f, runtime, ["--attach", runtime.runId]);
  assert.equal(result.exit, 1); assert.equal(result.records.at(-1).status, "cancelled");
  assert.equal(result.records.at(-1).checks.outcome, "cancelled");
  assert.deepEqual(result.records.at(-1).unresolved_effects, []);
  assert.equal(result.records.at(-1).workspace_settlement[0].disposition, "quarantined");
  assert.equal(runtime.calls.filter(args => args[0] === "command").length, 0);
});

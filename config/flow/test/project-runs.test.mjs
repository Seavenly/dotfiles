import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { flowOwnerPaths } from "../src/owner-process.mjs";
import { reviewSelection } from "../src/project-review-state.mjs";
import { digest } from "../../../tools/flow/src/canonical.mjs";
import { discoverProjectRuns, retainProjectPreview } from "../src/project-run-state.mjs";
import { collectProjectRuns, projectRunsObserver, RUNS_LIMITS } from "../src/project-runs-state.mjs";
import { projectRunsReport, renderProjectRuns } from "../src/project-runs-view.mjs";
const runtime = resolve(import.meta.dirname, "../../..");
const save = (path, value) => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
function snapshot(root) {
  const rows = [];
  function walk(path) {
    const stat = lstatSync(path), mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) rows.push([path, mode, readlinkSync(path)]);
    else if (stat.isDirectory()) { rows.push([path, mode, "directory"]); for (const name of readdirSync(path).sort()) walk(join(path, name)); }
    else rows.push([path, mode, createHash("sha256").update(readFileSync(path)).digest("hex")]);
  }
  walk(root); return rows;
}
function fixture(t, { longPaths = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), longPaths ? "flow-runs-core-long-canonical-state-authority-socket-fallback-fixture-" : "flow-runs-core-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "project"); mkdirSync(repository); writeFileSync(join(repository, "product.txt"), "retained source\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLOW_") && !key.startsWith("DOTFILES_") && !key.endsWith("_TOKEN") && !key.endsWith("_API_KEY")));
  Object.assign(env, { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), CODEX_HOME: join(root, "codex"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin" });
  for (const path of [env.HOME, env.XDG_STATE_HOME, env.XDG_CONFIG_HOME, env.CODEX_HOME]) mkdirSync(path);
  const git = args => execFileSync("/usr/bin/git", ["-C", repository, ...args], { env, stdio: "pipe" });
  git(["init", "--quiet", "--initial-branch=main"]); git(["config", "user.name", "Runs fixture"]); git(["config", "user.email", "runs@example.invalid"]); git(["add", "."]); git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Existing project"]);
  const codex = join(root, "version-only-cli"); writeFileSync(codex, "#!/bin/sh\nprintf 'codex-cli 0.166.0\\n'\n", { mode: 0o700 });
  const brief = join(root, "brief.json"); save(brief, { schema: "flow.feature-brief/v1", id: "runs-fixture", summary: "Improve arithmetic behavior", acceptance: ["Existing behavior remains correct"] });
  const setup = JSON.parse(execFileSync(process.execPath, [join(runtime, "config/flow/scripts/prepare-local-feature.mjs"), "--repository", repository, "--brief", brief, "--codex-executable", codex, "--execution-trust", "supervised-native-cli"], { env, encoding: "utf8", timeout: 30000 }));
  const [selection] = discoverProjectRuns({ repository, env });
  // Synthetic read adapter fixture: no SQLite database is opened by this adapter.
  writeFileSync(join(selection.authority_directory, "authority.sqlite"), "owned read-adapter presence sentinel");
  const calls = [];
  const observer = { status: async () => ({ state: "stopped" }), query: async (_selection, request) => { calls.push(request); return { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: [], watermark: { stream: "runs", sequence: 0 } }; } };
  const collect = async extra => projectRunsReport(await collectProjectRuns({ repository }, { env, observer, ...extra }));
  const preview = () => {
    const graph = { cards: [], edges: [] }, confirmation = { task: "arithmetic" };
    const prepared = { schema: "flow.prepared-run/v1", graph, plan_fingerprint: digest(graph), confirmation, confirmation_digest: digest(confirmation), bundle_digest: digest({ fixture: root }) };
    const retained = retainProjectPreview(selection, prepared, { brief: { summary: "Improve arithmetic behavior" } }, false);
    return { ...retained, id: retained.preview.run_id };
  };
  return { root, repository, env, setup, selection, observer, calls, collect, preview };
}
const linux = { skip: process.platform !== "linux" && "Supervised local setup fixtures use the supported Linux backend" };

test("initialized request and stopped empty history stay unprepared, read-only and deduplicated", linux, async t => {
  const f = fixture(t), before = snapshot(f.root), report = await f.collect();
  assert.equal(report.complete, true); assert.equal(report.attempts[0].state, "not_prepared");
  assert.equal(report.authorities[0].observation, "inspect_only"); assert.deepEqual(f.calls, [{}]);
  assert.equal(report.attempts[0].next_commands[0].kind, "preview"); assert.match(report.attempts[0].next_commands[0].disclosure, /recover/u);
  assert.deepEqual(snapshot(f.root), before); assert.match(renderProjectRuns(report), /Improve arithmetic behavior/u);
});

test("only exact active retained preview offers confirmation; incomplete and archives remain inspection-only", linux, async t => {
  const f = fixture(t); const retained = f.preview();
  const report = await f.collect(); assert.equal(report.attempts[0].state, "prepared");
  assert(report.attempts[0].next_commands.some(command => command.kind === "confirm" && command.command.includes(retained.preview.confirmation_digest)));
  const archive = f.selection.retained_directory + ".retained-1-1"; mkdirSync(archive);
  const archived = await f.collect(); const row = archived.attempts.find(row => row.state === "archived");
  assert(row); assert.equal(row.next_commands.length, 0);
  rmSync(join(f.selection.retained_directory, "preview.json"));
  const incomplete = await f.collect(); assert.equal(incomplete.attempts[0].state, "incomplete"); assert.equal(incomplete.attempts[0].next_commands.length, 0);
});

test("accepted-before-send intent with readable empty index remains uncertain and never admitted", linux, async t => {
  const f = fixture(t), retained = f.preview();
  const directory = join(f.selection.directory, "receipts/accepted-owned"); mkdirSync(directory, { recursive: true }); const launch = join(directory, "launch-request.json");
  const request = { prepared: retained.prepared, confirmation: { confirmation_digest: retained.preview.confirmation_digest } }; save(launch, request);
  save(join(f.selection.retained_directory, "accepted.json"), { run_id: retained.id, prepared_digest: retained.preview.prepared_digest, launch_file: launch, launch_digest: digest(request) });
  const before = snapshot(f.root), report = await f.collect(), row = report.attempts[0];
  assert.equal(report.complete, true); assert.equal(report.status, "attention"); assert.equal(row.state, "accepted_unknown"); assert.equal(row.run_id, null);
  assert.equal(row.intended_run_id, retained.id); assert(row.next_commands.some(command => command.kind === "resume_exact_attempt")); assert.deepEqual(snapshot(f.root), before);
});

test("exact admitted attempt preserves object facts and reports every unresolved count", linux, async t => {
  const f = fixture(t), retained = f.preview(), watermark = { stream: "run:test", sequence: 7 };
  const effects = Array.from({ length: 40 }, (_, index) => ({ effect_id: `effect:${index}`, status: "unresolved", receipt: null }));
  f.observer.query = async (_selection, request) => request.run_id ? { schema: "flow.run-projection/v1", run_id: retained.id, bundle_digest: retained.preview.bundle_digest, phase: "cancelled", watermark, cards: [], effects, resource_dispositions: [{ resource_id: "workspace:owned", status: "quarantined", reason: { code: "capture_retained" } }] } : { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: [retained.id] };
  const report = await f.collect(), row = report.attempts[0];
  assert.equal(row.state, "admitted"); assert.deepEqual(row.watermark, watermark);
  assert.equal(row.unresolved_effect_count, 40); assert.equal(row.unresolved_effects_truncated, true);
  assert.equal(row.workspace_dispositions[0].reason.code, "capture_retained");
  assert(row.next_commands.some(command => command.kind === "attach")); assert.match(renderProjectRuns(report), /quarantined|Unresolved/u);
});

test("query loss and total deadline are unavailable, never empty or fresh live facts", linux, async t => {
  const f = fixture(t); f.observer.query = async () => { throw Object.assign(new Error("transport lost"), { code: "transport_unavailable" }); };
  const lost = await f.collect(); assert.equal(lost.complete, false); assert.equal(lost.authorities[0].observation, "unavailable");
  f.observer.query = async () => new Promise(resolve => setTimeout(() => resolve({}), 200));
  const start = Date.now(), expired = await f.collect({ limits: { ...RUNS_LIMITS, elapsed_ms: 50 } });
  assert.equal(expired.complete, false); assert(Date.now() - start < 180); assert(expired.diagnostics.some(row => row.code === "deadline"));
});

test("redirected profile is refused without reading its target or executing a client", linux, async t => {
  const f = fixture(t), profile = f.selection.profile, target = join(f.root, "unrelated-owned.json");
  writeFileSync(target, readFileSync(profile)); rmSync(profile); symlinkSync(target, profile);
  const before = snapshot(f.root), report = await f.collect(); assert.equal(report.complete, false); assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.root), before);
});

test("bounded directory overflow is explicit and selects no arbitrary subset", linux, async t => {
  const f = fixture(t);
  for (let index = 0; index < 3; index++) mkdirSync(join(f.selection.directory, "requests", `extra-${index}`));
  const before = snapshot(f.root), report = await f.collect({ limits: { ...RUNS_LIMITS, directory_entries: 2 } });
  assert.equal(report.complete, false); assert(report.diagnostics.some(row => row.code === "entry_limit")); assert.deepEqual(snapshot(f.root), before);
});


test("real claim disposition remains readable with its generation and mutation epoch", linux, async t => {
  const f = fixture(t), id = `run:${"b".repeat(64)}`;
  f.observer.query = async (_selection, request) => request.run_id ? { schema: "flow.run-projection/v1", run_id: id, bundle_digest: digest("manual"), phase: "cancelled", cards: [], effects: [],
    resource_dispositions: [{ claim: { id: "workspace:retained", generation: 3, mutation_epoch: 7 }, disposition: "quarantined" }] } : { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: [id] };
  const report = await f.collect(), row = report.attempts.find(row => row.run_id === id);
  assert.deepEqual(row.workspace_dispositions[0].claim, { id: "workspace:retained", generation: 3, mutation_epoch: 7 });
  assert.match(renderProjectRuns(report), /workspace:retained.*quarantined/u);
  assert.equal(row.next_commands.some(command => command.kind === "attach"), false);
});

test("status reads retain XDG runtime socket selection but ignore inherited Flow redirects", linux, async t => {
  const f = fixture(t, { longPaths: true }), runtime = mkdtempSync(join(tmpdir(), "flow-xdg-")); t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const env = { ...f.env, XDG_RUNTIME_DIR: runtime, FLOW_SOCKET_PATH: "/wrong/socket", FLOW_AUTHORITY_DIRECTORY: "/wrong/authority" };
  const expected = flowOwnerPaths({ env: { ...f.env, XDG_RUNTIME_DIR: runtime, ...f.selection.pilot.environment } });
  const status = await projectRunsObserver({ env }).status(f.selection);
  assert.equal(status.socket_path, expected.socketPath); assert.equal(status.authority_directory, f.selection.authority_directory);
  const missingXdg = await projectRunsObserver({ env: {} }).status(f.selection);
  assert.notEqual(missingXdg.socket_path, expected.socketPath);
});

test("one exact review belongs only to its bound producer, preserving observed human state", linux, async t => {
  const f = fixture(t), a = `run:${"a".repeat(64)}`, b = `run:${"b".repeat(64)}`, fingerprint = digest("candidate"), watermark = digest("sealed");
  const target = { candidate_id: "candidate:owned", candidate_fingerprint: fingerprint, lifecycle_generation: 1, candidate_authority_watermark: watermark };
  const policy = { max_elapsed_seconds: 600, max_revisions: 0 };
  const selection = reviewSelection(f.selection, a, target, policy, { create: true }); mkdirSync(selection.retained_directory);
  save(selection.request, { schema: "flow.predefined-flow-selection/v1", definition: "review/v1", inputs: { preparation_facts: { source_run: { run_id: a } } } });
  const graph = { cards: [], edges: [] }, confirmation = { review: true }, prepared = { schema: "flow.prepared-run/v1", graph, plan_fingerprint: digest(graph), confirmation, confirmation_digest: digest(confirmation), bundle_digest: digest("review") };
  const retained = retainProjectPreview(selection, prepared, { brief: { summary: "Review arithmetic" } }, false, { inherited_checks: { kind: "registered_green_only", status: "succeeded", outcome: "passed" } });
  const id = retained.preview.run_id, reviewId = "review:exact-record", approval = { status: "approved", actor: "operator" };
  const receipt = { schema: "flow.review-receipt/v1", review_id: reviewId, candidate_fingerprint: fingerprint, lifecycle_generation: 1 };
  const effect = { effect_id: "effect:review", operation_contract: "flow.operation/review-record/v1", attempt_id: "attempt:review", idempotency_key: "key:review", status: "succeeded", receipt: { provider_receipt: receipt } };
  const record = { schema: "flow.review-projection/v1", contract: "work.review/v1", subject_id: reviewId, source_run_id: id, operation_contract: effect.operation_contract, operation_effect_id: effect.effect_id, operation_attempt_id: effect.attempt_id, operation_idempotency_key: effect.idempotency_key,
    candidate: { candidate_id: target.candidate_id }, candidate_fingerprint: fingerprint, lifecycle_generation: 1, candidate_authority_watermark: watermark, current: true, coverage: { complete: true, lenses: [], critic: { status: "completed" } }, posture: "no_findings", approval, human_status: { status: "accepted" }, cap_reasons: [{ code: "scope_limited" }] };
  const producer = run_id => ({ schema: "flow.run-projection/v1", run_id, bundle_digest: digest(run_id), phase: "succeeded", cards: [], effects: [], review_candidate_reference: { candidate_id: target.candidate_id, candidate_fingerprint: fingerprint } });
  f.observer.query = async (_selection, request) => {
    if (request.query === "review") return request.subject_id === reviewId ? record : { schema: "work.review-candidate-projection/v1", subject_id: target.candidate_id, candidate_fingerprint: fingerprint, generation: 1, watermark };
    if (request.run_id === a || request.run_id === b) return producer(request.run_id);
    if (request.run_id) return { schema: "flow.run-projection/v1", run_id: id, bundle_digest: prepared.bundle_digest, phase: "succeeded", cards: [], effects: [effect] };
    return { schema: "flow.run-index-projection/v1", authority_schema: { status: "compatible" }, runs: [a, b, id] };
  };
  const report = await f.collect(), review = report.attempts.find(row => row.run_id === id);
  assert.equal(report.complete, true); assert.deepEqual(review.review.approval, approval); assert.equal(review.producer_run_id, a);
  assert.deepEqual(report.attempts.find(row => row.run_id === a).separate_review_run_ids, [id]);
  assert.deepEqual(report.attempts.find(row => row.run_id === b).separate_review_run_ids, []);
  assert.equal(review.checks.rerun, false); assert.match(renderProjectRuns(report), /approved/u); assert.doesNotMatch(renderProjectRuns(report), /\[object Object\]/u);
});

test("attempt cap includes malformed review rows and stops scanning at the boundary", linux, async t => {
  const f = fixture(t), reviews = join(f.selection.directory, "receipts/guided-review");
  mkdirSync(reviews, { recursive: true });
  for (const digit of ["a", "b", "c"]) mkdirSync(join(reviews, digit.repeat(64)));
  const report = await f.collect({ limits: { ...RUNS_LIMITS, attempts: 1 } });
  assert.equal(report.complete, false); assert(report.attempts.length <= 1); assert(report.diagnostics.some(row => row.code === "attempt_limit"));
});

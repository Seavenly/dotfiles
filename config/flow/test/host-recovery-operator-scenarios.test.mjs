import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  runDrovrRegistryLockReconciliation,
  runTuicrReviewAfterProducerExit,
  runUbuntuHeadlessTextCaptures,
} from "../src/host-recovery-operator-scenarios.mjs";

const TIMESTAMP = "2026-09-17T10:00:00.000Z";
const WATERMARK = "sha256:" + "a".repeat(64);
const OWNER_RESOURCES = [
  "isolation/state",
  "isolation/authority",
  "isolation/backup",
  "isolation/repository",
  "isolation/drovr-config",
  "isolation/qualification-workspace",
];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-operator-scenarios-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const rawRoot = join(root, "raw");
  const isolationRoot = join(root, "isolation");
  await mkdir(join(worktree, "config/flow/src"), { recursive: true });
  await writeFile(join(worktree, "config/flow/src/cli.mjs"), "// pinned launcher\n");
  const isolation = {
    worktree_root: worktree,
    xdg_state_home: join(isolationRoot, "state"),
    authority_directory: join(isolationRoot, "authority"),
    socket_path: join(isolationRoot, "authority", "owner.sock"),
    endpoint_path: join(isolationRoot, "authority", "owner.json"),
    backup_directory: join(isolationRoot, "backup"),
    repository_root: join(isolationRoot, "repository"),
    drovr_config_directory: join(isolationRoot, "drovr"),
    qualification_workspace: join(isolationRoot, "workspace"),
    runtime_directory: null,
    herdr_session: "herdr:issue-46-driver-tests",
    run_id: "run:issue-46-driver-test-run",
  };
  const entrypoints = {
    worktree_root: worktree,
    launcher: { path: join(worktree, "config/flow/src/cli.mjs"), path_ref: "config/flow/src/cli.mjs" },
    host: { path: join(worktree, "config/flow/src/owner-process.mjs"), path_ref: "config/flow/src/owner-process.mjs" },
    node: { path: process.execPath },
  };
  return { root, worktree, rawRoot, isolation, entrypoints };
}

function invocation(kind, index = 0, { exitCode = 0 } = {}) {
  return {
    id: `command:${kind}:${index}`,
    argv: ["node", "config/flow/src/cli.mjs", kind, "--json"],
    command_kind: kind,
    launcher_ref: "config/flow/src/cli.mjs",
    host_ref: "config/flow/src/owner-process.mjs",
    working_directory_ref: "worktree",
    started_at: TIMESTAMP,
    finished_at: TIMESTAMP,
    duration_ms: 0,
    exit_code: exitCode,
    signal: null,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: false,
    logs: {
      stdout: { path: null, sha256: "b".repeat(64), bytes: 0 },
      stderr: { path: null, sha256: "c".repeat(64), bytes: 0 },
    },
  };
}

function commandResult(kind, output, index = 0, options = {}) {
  return { command: invocation(kind, index, options), output };
}

function statusOutput() {
  return {
    schema: "flow.owner-status/v1",
    version: 1,
    state: "running",
    endpoint_path: "/private/authority/owner.json",
    socket_path: "/private/authority/owner.sock",
    authority_directory: "/private/authority",
    pid: 1234,
    process_identity: "owner:1234:boot-a:start-a",
    process_start_identity: "start-a",
    started_at: TIMESTAMP,
    owner_token: "owner-token-1234",
    runner: {
      schema: "flow.runtime-runner-status/v1",
      state: "running",
      delegate_capacity: 1,
      operation_capacity: 1,
      active_delegates: 0,
      active_operations: 0,
      queued: 0,
      errors: [],
    },
    legal_actions: [],
    watermark: WATERMARK,
  };
}

function projection(schema, id = "run:operator-test") {
  return {
    schema,
    run_id: id,
    phase: "active",
    watermark: WATERMARK,
    legal_actions: [{ type: "status", expected_watermark: WATERMARK }],
    views: {
      graph: {
        schema: "flow.graph-projection/v1",
        run_id: id,
        authority_watermark: WATERMARK,
        nodes: [{ id: "card:one", status: "completed" }],
        edges: [],
        legal_actions: [],
      },
      timeline: {
        schema: "flow.timeline-projection/v1",
        run_id: id,
        authority_watermark: WATERMARK,
        entries: [{ sequence: 1, kind: "lifecycle", subject_id: id }],
        legal_actions: [],
      },
      operator: {
        schema: "flow.operator-projection/v1",
        run_id: id,
        authority_watermark: WATERMARK,
        phase: "active",
        legal_actions: [],
        checkpoints: [{ card_id: "card:one", decision: "approve", status: "completed" }],
      },
    },
  };
}

function captureSource(kind, value, format = "json") {
  return {
    kind,
    format,
    value,
    watermark: WATERMARK,
    legal_actions: value.legal_actions ?? [{ type: "status", expected_watermark: WATERMARK }],
    legibility: "pass",
    provenance: "native_provider",
  };
}

function cleanupComplete() {
  return {
    disposition: "complete",
    owned_resources: OWNER_RESOURCES.map((identity_ref) => ({ kind: "isolated_root", identity_ref })),
    resource_dispositions: OWNER_RESOURCES.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
      disposition: "removed",
      proof: "absent_after_cleanup",
    })),
    unresolved_obligations: [],
    completed_at: TIMESTAMP,
  };
}

function runnerFor(results) {
  let index = 0;
  return async ({ kind }) => {
    const result = results[kind];
    if (result === undefined) throw new Error(`unexpected command: ${kind}`);
    return typeof result === "function" ? result(kind, index++) : result;
  };
}

function toolFor(results) {
  return async ({ operation }) => {
    const result = results[operation];
    if (result === undefined) throw new Error(`unexpected tool operation: ${operation}`);
    const value = typeof result === "function" ? result(operation) : result;
    if (operation === "headless_captures" && value?.command === undefined) {
      return {
        command: invocation("native_headless_capture_probe"),
        output: value,
      };
    }
    return value;
  };
}

async function assertCaptureFiles(result, rawRoot) {
  assert.equal(new Set(result.captures.map(({ id }) => id)).size, result.captures.length);
  assert.equal(new Set(result.captures.map(({ sha256 }) => sha256)).size, result.captures.length);
  for (const capture of result.captures) {
    assert.match(capture.path, /^captures\//u);
    const bytes = await readFile(join(rawRoot, capture.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    assert.ok(bytes.length > 0);
    assert.ok(bytes.toString("utf8").split("\n").every((line) => line.length <= 120));
    if (capture.format === "json") {
      const persisted = JSON.parse(bytes);
      assert.equal(persisted.rendering.encoding, "json-text-segments/v1");
      assert.doesNotThrow(() => JSON.parse(persisted.rendering.segments.join("")));
    }
  }
}

const OUT_OF_SCOPE = [
  {
    form: "macos_visual",
    status: "out_of_scope",
    reason: "expanded macOS visual matrix belongs to issue 47",
    release_evidence: {
      release_id: "flow-release-1.0-dark/v1",
      route: "expanded_macos_visuals",
      status: "disabled",
    },
  },
];

function headlessProvider({ invalidKind = undefined } = {}) {
  const status = statusOutput();
  const query = projection("flow.review-inbox-projection/v1");
  const watch = { ...query, watermark: "sha256:" + "d".repeat(64) };
  const command = { ...query, schema: "flow.command-result/v1", watermark: "sha256:" + "e".repeat(64) };
  const sources = Object.fromEntries([
    captureSource("terminal", "flow status --json\nready\n", "text"),
    captureSource("status", status),
    captureSource("checkpoint", query.views.operator),
    captureSource("candidate", { ...query, candidate_id: "candidate:test" }),
    captureSource("review", { ...query, review_id: "review:test" }, "markdown"),
    captureSource("graph", query.views.graph),
    captureSource("timeline", query.views.timeline, "html"),
    captureSource("tuicr", query),
  ].map((source) => [source.kind, source]));
  if (invalidKind !== undefined) {
    const invalid = sources.terminal;
    sources[invalidKind] = { ...invalid, kind: invalidKind };
    delete sources.terminal;
  }
  return {
    commandRunner: runnerFor({
      status: commandResult("status", status),
      query: commandResult("query", query),
      watch: commandResult("watch", watch),
      command: commandResult("command", command),
    }),
    toolRunner: toolFor({
      headless_captures: {
        schema: "flow.host-recovery-headless-provider/v1",
        version: 1,
        status: "pass",
        captures: Object.values(sources),
        release_evidence: { release_id: "flow-release-1.0-dark/v1" },
      },
    }),
    outOfScopeForms: OUT_OF_SCOPE,
  };
}

test("Ubuntu headless driver captures every required form with distinct bytes and scope evidence", async (t) => {
  const fixtureData = await fixture(t);
  const status = statusOutput();
  const query = projection("flow.review-inbox-projection/v1");
  const watch = { ...query, watermark: "sha256:" + "d".repeat(64) };
  const command = { ...query, schema: "flow.command-result/v1", watermark: "sha256:" + "e".repeat(64) };
  const sources = Object.fromEntries([
    captureSource("terminal", "flow status --json\nready\n", "text"),
    captureSource("status", status),
    captureSource("checkpoint", query.views.operator),
    captureSource("candidate", { ...query, candidate_id: "candidate:test" }),
    captureSource("review", { ...query, review_id: "review:test" }, "markdown"),
    captureSource("graph", query.views.graph),
    captureSource("timeline", query.views.timeline, "html"),
    captureSource("tuicr", query),
  ].map((source) => [source.kind, source]));

  const result = await runUbuntuHeadlessTextCaptures({
    entrypoints: fixtureData.entrypoints,
    isolation: fixtureData.isolation,
    rawRoot: fixtureData.rawRoot,
    commandRunner: runnerFor({
      status: commandResult("status", status),
      query: commandResult("query", query),
      watch: commandResult("watch", watch),
      command: commandResult("command", command),
    }),
    toolRunner: toolFor({
      headless_captures: {
        schema: "flow.host-recovery-headless-provider/v1",
        version: 1,
        status: "pass",
        captures: Object.values(sources),
        release_evidence: { release_id: "flow-release-1.0-dark/v1" },
      },
    }),
    outOfScopeForms: OUT_OF_SCOPE,
    cleanupRunner: async () => cleanupComplete(),
  });

  assert.equal(result.scenario_id, "ubuntu_headless_text_captures");
  assert.equal(result.result.disposition, "pass", JSON.stringify(result));
  assert.equal(result.proof_predicate, "headless_capture_inventory");
  assert.deepEqual(result.captures.map(({ kind }) => kind), [
    "terminal", "status", "checkpoint", "candidate", "review", "graph", "timeline", "tuicr",
  ]);
  assert.equal(result.observations[0].kind, "capture_inventory");
  assert.equal(result.observations[0].content.inventory_complete, true);
  assert.deepEqual(result.observations[0].content.out_of_scope_forms, OUT_OF_SCOPE);
  await assertCaptureFiles(result, fixtureData.rawRoot);
  for (const assertion of result.assertions) {
    assert.deepEqual(
      assertion.evidence_refs.filter((ref) => ref.startsWith("capture:")),
      result.captures.map(({ id }) => `capture:${id}`),
    );
  }
});

test("operator capture persistence rejects traversal and symlink destinations", async (t) => {
  const symlinkFixture = await fixture(t);
  const outside = join(symlinkFixture.root, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(symlinkFixture.rawRoot, { recursive: true });
  await symlink(outside, join(symlinkFixture.rawRoot, "captures"));
  const symlinkProvider = headlessProvider();
  const symlinkResult = await runUbuntuHeadlessTextCaptures({
    ...symlinkFixture,
    ...symlinkProvider,
    cleanupRunner: async () => cleanupComplete(),
  });
  assert.equal(symlinkResult.result.disposition, "fail");
  assert.equal(symlinkResult.result.reason, "capture_path_invalid");

  const traversalFixture = await fixture(t);
  const traversalResult = await runUbuntuHeadlessTextCaptures({
    ...traversalFixture,
    ...headlessProvider({ invalidKind: "../escape" }),
    cleanupRunner: async () => cleanupComplete(),
  });
  assert.equal(traversalResult.result.disposition, "fail");
  assert.equal(traversalResult.result.reason, "capture_kind_invalid");
});

test("operator timeout aborts injected command work before cleanup", async (t) => {
  const fixtureData = await fixture(t);
  let aborted = false;
  let cleanupSignal;
  const result = await runUbuntuHeadlessTextCaptures({
    ...fixtureData,
    timeoutMs: 10,
    commandRunner: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve(commandResult("status", statusOutput()));
      }, { once: true });
    }),
    cleanupRunner: async ({ signal }) => {
      cleanupSignal = signal;
      return cleanupComplete();
    },
  });
  assert.equal(aborted, true);
  assert.equal(cleanupSignal instanceof AbortSignal, true);
  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "timeout");
  assert.equal(result.cleanup.disposition, "complete");
});

test("operator timeout with no abort acknowledgement withholds cleanup", async (t) => {
  const fixtureData = await fixture(t);
  let cleanupCalled = false;
  const result = await runUbuntuHeadlessTextCaptures({
    ...fixtureData,
    timeoutMs: 10,
    commandRunner: () => new Promise(() => {}),
    cleanupRunner: async () => {
      cleanupCalled = true;
      return cleanupComplete();
    },
  });
  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "abort_unacknowledged");
  assert.equal(cleanupCalled, false);
  assert.equal(result.cleanup.disposition, "not_started");
  assert.equal(result.cleanup.unresolved_obligations[0].code, "work_in_flight");
});

test("tuicr driver requires explicit producer absence, disposition, stale rejection, and rebuild identity", async (t) => {
  const fixtureData = await fixture(t);
  const reviewId = "review:sha256:test:1";
  const before = {
    schema: "work.review-projection/v1",
    review_id: reviewId,
    candidate_fingerprint: WATERMARK,
    lifecycle_generation: 1,
    review_generation: 2,
    watermark: WATERMARK,
    legal_actions: [{ type: "review_comment", expected_watermark: WATERMARK }],
  };
  const after = structuredClone(before);
  const stale = {
    schema: "work.rejection/v1",
    operation: "command",
    code: "stale_review_generation",
    review_id: reviewId,
    expected_generation: 1,
    observed_generation: 2,
    expected_watermark: "sha256:" + "b".repeat(64),
    observed_watermark: WATERMARK,
    rejected: true,
  };
  const producer = {
    schema: "flow.producer-exit-observation/v1",
    producer_exited: true,
    process_absence: { status: "absent", pid: 4343, process_identity: "producer:4343:start-a" },
    producer_exited_at: "2026-09-17T10:00:00.100Z",
  };
  const result = await runTuicrReviewAfterProducerExit({
    entrypoints: fixtureData.entrypoints,
    isolation: fixtureData.isolation,
    rawRoot: fixtureData.rawRoot,
    commandRunner: runnerFor({
      query: commandResult("query", { schema: "flow.review-inbox-projection/v1", watermark: WATERMARK, items: [{ review_id: reviewId, candidate_fingerprint: WATERMARK, lifecycle_generation: 1, legal_actions: before.legal_actions }] }),
      watch: commandResult("watch", { schema: "flow.review-inbox-projection/v1", watermark: WATERMARK, items: [{ review_id: reviewId, candidate_fingerprint: WATERMARK, lifecycle_generation: 1, legal_actions: before.legal_actions }] }),
      command: commandResult("command", stale),
    }),
    toolRunner: toolFor({
      producer_exit: producer,
      tuicr_consumer: {
        schema: "tuicr.review-consumer-observation/v1",
        consumer: "tuicr",
        started: true,
        list: { session_id: "tuicr:issue-46", review_id: reviewId, watermark: WATERMARK },
        comments: { session_id: "tuicr:issue-46", review_id: reviewId, comments: [], watermark: WATERMARK },
      },
      flowruntime_review: {
        schema: "work.review-projection/v1",
        review_id: reviewId,
        candidate_fingerprint: WATERMARK,
        lifecycle_generation: 1,
        review_generation: 4,
        disposition: "accept",
        approval: "approved",
        flowruntime_disposition: "approved",
        disposition_event: { accepted: true, watermark: WATERMARK },
        approval_event: { accepted: true, watermark: WATERMARK },
        watermark: WATERMARK,
        legal_actions: [{ type: "review_integration", expected_watermark: WATERMARK }],
        review_started_at: "2026-09-17T10:00:00.200Z",
      },
      owner_restart_rebuild: { before, after, identity_stable: true, watermark: WATERMARK, legal_actions: [] },
    }),
    cleanupRunner: async () => cleanupComplete(),
  });

  assert.equal(result.result.disposition, "pass");
  assert.deepEqual(result.observations.map(({ kind }) => kind), [
    "producer_exit", "disposition", "stale_action", "rebuild",
  ]);
  assert.equal(result.observations.find(({ kind }) => kind === "stale_action").content.rejected, true);
  await assertCaptureFiles(result, fixtureData.rawRoot);
  assert.equal(result.captures.length >= 3, true);
});

test("Drovr lock driver proves process absence, exact recovery action, and negative takeover outcomes", async (t) => {
  const fixtureData = await fixture(t);
  const lockWatermark = "sha256:" + "f".repeat(64);
  const query = {
    schema: "drovr.registry-lock-reconciliation/v1",
    status: "blocked",
    authority_watermark: lockWatermark,
    locks: [{
      resource_key: "task-lifecycle:task-46",
      lock_id: "lock:46",
      owner_status: "absent",
      legal_next_actions: ["release_absent_registry_lock"],
    }],
    legal_next_actions: ["release_absent_registry_lock"],
    watermark: lockWatermark,
    legal_actions: ["release_absent_registry_lock"],
  };
  const rejection = (action) => ({
    schema: "flow.rejection/v1",
    operation: "command",
    code: "registry_lock_recovery_evidence_invalid",
    action,
    rejected: true,
    accepted: false,
    mutated: false,
    authority_watermark: lockWatermark,
    legal_next_actions: ["status"],
  });
  const probeOutput = {
    schema: "flow.drovr-lock-live-observation/v1",
    status: "pass",
    authority_watermark: lockWatermark,
    owner_killed: true,
    termination_signal: "SIGKILL",
    owner_status: "absent",
    process_absence: { status: "absent", pid: 9911, process_identity: "drovr:9911:start-a" },
    lock_id: "lock:46",
    resource_key: "task-lifecycle:task-46",
    lock_projection: query,
    reconciliation: {
      reconciled: true,
      status: "released",
      resource_key: "task-lifecycle:task-46",
      lock_id: "lock:46",
      recovery_action: "release_absent_registry_lock",
      authority_watermark: lockWatermark,
      legal_next_actions: ["acquire_registry_lock"],
    },
    negative_age: rejection("age_takeover"),
    negative_force: rejection("force_takeover"),
  };
  const result = await runDrovrRegistryLockReconciliation({
    entrypoints: fixtureData.entrypoints,
    isolation: fixtureData.isolation,
    rawRoot: fixtureData.rawRoot,
    nativeDrovrLockProbe: {
      command: invocation("native_drovr_lock_probe"),
      output: probeOutput,
    },
    cleanupRunner: async () => cleanupComplete(),
  });

  assert.equal(result.result.disposition, "pass");
  assert.deepEqual(result.observations.map(({ kind }) => kind), [
    "lock_owner", "reconciliation", "negative_age", "negative_force",
  ]);
  assert.equal(result.observations.find(({ kind }) => kind === "reconciliation").content.reconciled, true);
  for (const kind of ["negative_age", "negative_force"]) {
    const content = result.observations.find((item) => item.kind === kind).content;
    assert.equal(content.rejected, true);
    assert.equal(content.mutated, false);
  }
  await assertCaptureFiles(result, fixtureData.rawRoot);
  assert.deepEqual(result.commands.map(({ command_kind }) => command_kind), [
    "native_drovr_lock_probe",
  ]);
});

test("drivers block without injected live prerequisites and never promote exit status into proof", async (t) => {
  const fixtureData = await fixture(t);
  const blocked = await runDrovrRegistryLockReconciliation({
    entrypoints: fixtureData.entrypoints,
    isolation: fixtureData.isolation,
    rawRoot: fixtureData.rawRoot,
  });
  assert.equal(blocked.result.disposition, "blocked");
  assert.ok(blocked.retained_obligations.some(({ code }) => code === "native_drovr_lock_probe_required"));

  const failed = await runDrovrRegistryLockReconciliation({
    entrypoints: fixtureData.entrypoints,
    isolation: fixtureData.isolation,
    rawRoot: join(fixtureData.root, "failed-raw"),
    commandRunner: runnerFor({
      query: commandResult("query", { schema: "drovr.registry-lock-reconciliation/v1" }, 0, { exitCode: 1 }),
      command: commandResult("command", { schema: "flow.rejection/v1", code: "provider_failed" }, 0, { exitCode: 1 }),
    }),
    toolRunner: toolFor({
      lock_owner_termination: { owner_killed: true, owner_status: "absent", process_absence: { status: "absent" } },
      lock_reconciliation: { reconciled: false, actionable_block: true, recovery_action: "status", legal_next_actions: ["status"], watermark: WATERMARK },
      negative_age_takeover: { rejected: true, mutated: false, code: "blocked", watermark: WATERMARK },
      negative_force_takeover: { rejected: true, mutated: false, code: "blocked", watermark: WATERMARK },
    }),
  });
  assert.notEqual(failed.result.disposition, "pass");
});

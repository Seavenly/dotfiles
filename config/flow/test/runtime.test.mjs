import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/runtime.mjs";

test("query exposes the DelegatedAgentPort description without creating a run", async () => {
  const projection = {
    schema: "flow.delegated-agent-description-projection/v1",
    status: "compatible",
    watermark: {
      schema: "drovr.authority-watermark/v1",
      authority: "drovr.configuration-catalog",
      content_sha256: `sha256:${"1".repeat(64)}`,
    },
    description: { description_digest: `sha256:${"2".repeat(64)}` },
    compatibility: {
      contract: "flow.delegated-agent-port/v1",
      code: null,
      findings: [],
    },
    legal_next_actions: ["bind_exact_launch_description"],
  };
  const delegatedAgentPort = {
    async describe(request) {
      assert.deepEqual(request, {
        schema: "flow.delegated-agent-description-request/v1",
        launch: { harness: "codex", capability: "read-only" },
        caller_metadata: { run_id: "run:example", card_id: "review" },
      });
      return projection;
    },
  };
  const runtime = createFlowRuntime({ delegatedAgentPort });
  const before = runtime.query();

  assert.deepEqual(await runtime.query({
    schema: "flow.query/v1",
    query: "delegated_agent_description",
    launch: { harness: "codex", capability: "read-only" },
    caller_metadata: { run_id: "run:example", card_id: "review" },
  }), projection);
  assert.deepEqual(runtime.query(), before);
});

test("query inventories retained legacy runs with a stable content digest", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-inventory-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const claudeRuns = join(scratch, "agent-teams", "runs");
  const claudeRun = join(claudeRuns, "claude-1");
  await mkdir(join(claudeRun, "out"), { recursive: true });
  await writeFile(join(claudeRun, "brief.md"), "# Accepted brief\n");
  await writeFile(join(claudeRun, "out", "report.md"), "result\n");
  const runDirectory = join(hermesRuns, "run-1");
  const artifactDirectory = join(runDirectory, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: {
      run_id: "run-1",
      flow: "feature",
      external_root: { system: "github", id: "seavenly/dotfiles#4" },
    },
  });
  await writeFile(join(artifactDirectory, "journal.md"), "verified notes\n");
  const materialization = join(runDirectory, "materialization.json");
  await writeJson(materialization, { retained_note: "first" });

  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns,
      hermesRuns,
      hermesStacks: join(scratch, "agent-flow", "stacks"),
    },
  });
  const request = {
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  };
  const beforeQuery = await snapshotFiles(scratch);

  const first = await runtime.query(request);
  const second = await runtime.query(request);

  assert.equal(first.schema, "flow.legacy-compatibility-inventory/v1");
  assert.equal(first.watermark.content_sha256, second.watermark.content_sha256);
  assert.match(first.watermark.content_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(first.inventory.runs.map(({ id }) => id), [
    "claude-agent-teams:claude-1",
    "hermes-agent-flow:run-1",
  ]);
  assert.deepEqual(first.inventory.artifacts.map(({ path }) => path), [
    "claude-1/out/report.md",
    "run-1/artifacts/journal.md",
    "run-1/materialization.json",
  ]);
  assert.deepEqual(await snapshotFiles(scratch), beforeQuery);
  await writeJson(materialization, { retained_note: "changed" });
  const changed = await runtime.query(request);
  assert.notEqual(changed.watermark.content_sha256, first.watermark.content_sha256);
});

test("query distinguishes legacy evidence states and exposes every retained domain", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-evidence-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const stacks = join(scratch, "agent-flow", "stacks");
  const runDirectory = join(hermesRuns, "run-verified");
  const artifacts = join(runDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await mkdir(stacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: {
      run_id: "run-verified",
      flow: "feature",
      external_root: { system: "github", id: "seavenly/dotfiles#4" },
    },
  });
  const transcript = join(artifacts, "native-session.jsonl");
  await writeFile(transcript, "{\"type\":\"result\"}\n");
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: transcript,
  });
  await writeJson(join(runDirectory, "delivery-state.json"), {
    schema: "agent-flow.delivery-state/v1",
    applied_layers: [{
      retarget: { request_id: "retarget-1", status: "pending" },
    }],
    pending_completion_pr: { request_id: "completion-1" },
  });
  await writeFile(join(artifacts, "summary.md"), "summary\n");
  await writeJson(join(artifacts, "review.json"), {
    schema: "agent-flow.local-review/v1",
    run_id: "run-verified",
    artifacts: {
      review_summary: join(artifacts, "summary.md"),
      verification: join(artifacts, "missing-verification.json"),
    },
    review: { status: "approved", generation: 2 },
  });
  await writeJson(join(stacks, "stack.state.json"), {
    schema: "agent-flow.stack-state/v1",
    run_id: "stack-1",
    generation: 1,
    status: "publish_failed",
    error: "receipt unavailable",
  });
  const malformed = join(hermesRuns, "run-unreadable");
  await mkdir(malformed, { recursive: true });
  await writeFile(join(malformed, "run.json"), "not-json\n");
  const unknown = join(hermesRuns, "run-uncertain");
  await mkdir(unknown, { recursive: true });
  await writeJson(join(unknown, "run.json"), {
    schema: "agent-flow.run/v999",
    identity: { run_id: "run-uncertain" },
  });

  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-agent-teams"),
      hermesRuns,
      hermesStacks: stacks,
    },
  });
  const projection = await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  });

  assert.ok(projection.inventory.evidence_summary.verified > 0);
  assert.ok(projection.inventory.evidence_summary.missing > 0);
  assert.ok(projection.inventory.evidence_summary.unreadable > 0);
  assert.ok(projection.inventory.evidence_summary.uncertain > 0);
  assert.deepEqual(projection.inventory.reviews.map(({ id }) => id), [
    "hermes-agent-flow:run-verified:review",
  ]);
  assert.deepEqual(projection.inventory.stacks.map(({ id }) => id), [
    "hermes-agent-flow-stack:stack-1:generation-1",
  ]);
  assert.equal(
    projection.inventory.transcript_pointers
      .find(({ id }) => id.endsWith("materialization.json:transcript_path"))
      ?.evidence_status,
    "verified",
  );
  assert.equal(
    projection.inventory.transcript_pointers
      .filter(({ reason }) => reason === "retained_run_has_no_transcript_pointer")
      .length,
    2,
  );
  assert.deepEqual(projection.inventory.active_ownership, [{
    evidence_status: "uncertain",
    id: "github:seavenly/dotfiles#4",
    owner: "hermes-agent-flow:run-verified",
    reason: "terminal_state_not_recorded_in_retained_manifest",
    state: "uncertain",
  }]);
  assert.deepEqual(
    projection.inventory.unresolved_effects.map(({ kind }) => kind).sort(),
    ["completion_pr", "retarget", "stack_publication"],
  );
  assert.ok(projection.legal_next_actions.includes("inspect_legacy_evidence"));
  assert.ok(!projection.legal_next_actions.some((action) =>
    /import|migrate|repair/u.test(action)
  ));
});

test("query retains unreadable and uncertain review and stack evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-records-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const stacks = join(scratch, "agent-flow", "stacks");
  for (const [runId, review] of [
    ["broken-review", "not-json\n"],
    ["unknown-review", `${JSON.stringify({ schema: "agent-flow.local-review/v999" })}\n`],
  ]) {
    const runDirectory = join(hermesRuns, runId);
    await mkdir(join(runDirectory, "artifacts"), { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      schema: "agent-flow.run/v1",
      identity: { run_id: runId, flow: "feature", external_root: null },
    });
    await writeFile(join(runDirectory, "artifacts", "review.json"), review);
  }
  await mkdir(stacks, { recursive: true });
  await writeFile(join(stacks, "broken.state.json"), "not-json\n");
  await writeJson(join(stacks, "unknown.state.json"), {
    schema: "agent-flow.stack-state/v999",
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
      hermesStacks: stacks,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.reviews.map(({ evidence_status }) => evidence_status),
    ["unreadable", "uncertain"],
  );
  assert.deepEqual(
    projection.inventory.stacks.map(({ evidence_status }) => evidence_status),
    ["unreadable", "uncertain"],
  );
});

test("query exposes corrupt retained records instead of hiding evidence gaps", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-corrupt-record-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-corrupt");
  await mkdir(runDirectory, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-corrupt", flow: "delivery", external_root: null },
  });
  await writeFile(join(runDirectory, "delivery-state.json"), "not-json\n");
  await writeFile(join(runDirectory, "transition.receipt"), "retained receipt\n");

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-corrupt/delivery-state.json")
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "unreadable", reason: "invalid_json" }],
  );
  assert.ok(projection.inventory.evidence_summary.unreadable > 0);
  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-corrupt/transition.receipt")
      .map(({ evidence_status }) => evidence_status),
    ["verified"],
  );
  assert.ok(projection.legal_next_actions.includes("inspect_legacy_evidence"));
});

test("query uses locale-independent byte ordering for ledger stability", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-order-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeRuns = join(scratch, "agent-teams", "runs");
  for (const run of ["run-a", "Run-b"]) {
    await mkdir(join(claudeRuns, run), { recursive: true });
    await writeFile(join(claudeRuns, run, "brief.md"), "# Brief\n");
  }

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns,
      hermesRuns: join(scratch, "missing-hermes-runs"),
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(projection.inventory.runs.map(({ id }) => id), [
    "claude-agent-teams:Run-b",
    "claude-agent-teams:run-a",
  ]);
});

test("query normalizes referenced artifacts without host paths or duplicates", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-paths-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-paths");
  const artifacts = join(runDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-paths", flow: "feature", external_root: null },
  });
  const summary = join(artifacts, "summary.md");
  await writeFile(summary, "summary\n");
  await writeJson(join(artifacts, "review.json"), {
    schema: "agent-flow.local-review/v1",
    artifacts: { review_summary: summary },
    review: { status: "review_ready", generation: 0 },
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.equal(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-paths/artifacts/summary.md").length,
    1,
  );
  assert.ok(projection.inventory.sources.every(({ path }) => path === undefined));
  assert.ok(projection.inventory.artifacts.every(({ path }) => !path.startsWith(scratch)));
});

test("query marks Claude transcript and ownership authority as uncertain", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-claude-authority-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeRuns = join(scratch, "agent-teams", "runs");
  const runDirectory = join(claudeRuns, "claude-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "brief.md"), [
    "---",
    "type: review",
    "---",
    "# Review brief",
    "",
  ].join("\n"));

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns,
      hermesRuns: join(scratch, "missing-hermes-runs"),
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(projection.inventory.active_ownership, [{
    evidence_status: "uncertain",
    id: "claude-agent-teams:claude-run:external-root",
    owner: "claude-agent-teams:claude-run",
    reason: "external_root_not_machine_readable_in_retained_brief",
    state: "uncertain",
  }]);
  assert.deepEqual(projection.inventory.transcript_pointers, [{
    evidence_status: "uncertain",
    id: "claude-agent-teams:claude-run:transcript",
    path: null,
    reason: "native_transcript_not_machine_linked_to_retained_run",
    run_id: "claude-agent-teams:claude-run",
    sha256: null,
  }]);
  assert.deepEqual(projection.inventory.reviews, [{
    evidence_status: "uncertain",
    generation: null,
    id: "claude-agent-teams:claude-run:review",
    path: "claude-run/brief.md",
    reason: "review_lifecycle_not_machine_readable_in_retained_brief",
    status: null,
  }]);
});

test("query reports unregistered operator stack paths as uncertain authority", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-stack-registry-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns: join(scratch, "missing-hermes-runs"),
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.sources.filter(({ id }) =>
      id === "hermes-agent-flow-stack-registry"
    ),
    [{
      entry_count: 0,
      evidence_status: "uncertain",
      id: "hermes-agent-flow-stack-registry",
      reason: "operator_supplied_stack_paths_are_not_registered",
    }],
  );
});

test("query preserves an uncertain transcript obligation for Hermes runs", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-hermes-transcript-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-without-transcript");
  await mkdir(runDirectory, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-without-transcript", flow: "feature", external_root: null },
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(projection.inventory.transcript_pointers, [{
    evidence_status: "uncertain",
    id: "hermes-agent-flow:run-without-transcript:transcript",
    path: null,
    reason: "retained_run_has_no_transcript_pointer",
    run_id: "hermes-agent-flow:run-without-transcript",
    sha256: null,
  }]);
});

test("query recovers when retained evidence is restored between observations", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeRuns = join(scratch, "agent-teams", "runs");
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const hermesStacks = join(scratch, "agent-flow", "configured-stacks");
  const runDirectory = join(hermesRuns, "run-recovery");
  const transcript = join(runDirectory, "artifacts", "native.jsonl");
  await mkdir(claudeRuns, { recursive: true });
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  await mkdir(hermesStacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-recovery", flow: "feature", external_root: null },
  });
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: transcript,
  });
  const runtime = createFlowRuntime({
    legacyRoots: { claudeRuns, hermesRuns, hermesStacks },
  });
  const request = { schema: "flow.query/v1", query: "legacy_compatibility_inventory" };

  const missing = await runtime.query(request);
  assert.equal(missing.inventory.transcript_pointers[0].evidence_status, "missing");
  await writeFile(transcript, '{"type":"result"}\n');
  const restored = await runtime.query(request);

  assert.equal(restored.inventory.transcript_pointers[0].evidence_status, "verified");
  assert.notEqual(restored.watermark.content_sha256, missing.watermark.content_sha256);
});

test("query keeps paths host-neutral while binding exact retained bytes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-host-stability-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  async function projectionAt(name) {
    const root = join(scratch, name);
    const hermesRuns = join(root, "state", "agent-flow", "runs");
    const runDirectory = join(hermesRuns, "run-stable");
    const artifacts = join(runDirectory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeJson(join(runDirectory, "run.json"), {
      schema: "agent-flow.run/v1",
      identity: { run_id: "run-stable", flow: "feature", external_root: null },
    });
    const summary = join(artifacts, "summary.md");
    await writeFile(summary, "same bytes\n");
    await writeJson(join(artifacts, "review.json"), {
      schema: "agent-flow.local-review/v1",
      artifacts: { review_summary: summary },
      review: { status: "review_ready", generation: 0 },
    });
    return createFlowRuntime({
      legacyRoots: {
        claudeRuns: join(root, "missing-claude-runs"),
        hermesRuns,
      },
    }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });
  }

  const first = await projectionAt("host-a");
  const second = await projectionAt("host-b");
  assert.deepEqual(
    first.inventory.artifacts.map(({ path }) => path),
    second.inventory.artifacts.map(({ path }) => path),
  );
  assert.notEqual(first.watermark.content_sha256, second.watermark.content_sha256);
});

test("query classifies symlinked and unreadable artifact evidence without following it", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-artifact-safety-"));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-safety");
  const artifacts = join(runDirectory, "artifacts");
  const locked = join(artifacts, "locked");
  t.after(async () => {
    await chmod(locked, 0o700).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });
  await mkdir(locked, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-safety", flow: "feature", external_root: null },
  });
  await writeFile(join(scratch, "outside.txt"), "must not be followed\n");
  await symlink(join(scratch, "outside.txt"), join(artifacts, "outside-link"));
  await writeFile(join(locked, "secret.txt"), "unreadable\n");
  await chmod(locked, 0o000);

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path.endsWith("outside-link"))
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  if (process.getuid?.() === 0) {
    t.diagnostic("root bypasses directory permission checks; EACCES assertion skipped");
  } else {
    assert.deepEqual(
      projection.inventory.artifacts
        .filter(({ path }) => path.endsWith("artifacts/locked"))
        .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
      [{ evidence_status: "unreadable", reason: "directory_unreadable" }],
    );
  }
});

test("query preserves non-file evidence outside artifact directories", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-run-entry-safety-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const hermesStacks = join(scratch, "agent-flow", "stacks");
  const runDirectory = join(hermesRuns, "run-entry-safety");
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  await mkdir(hermesStacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-entry-safety", flow: "feature", external_root: null },
  });
  await writeFile(join(scratch, "outside.txt"), "must not be followed\n");
  const outsideStackDirectory = join(scratch, "outside-stack-directory");
  await mkdir(outsideStackDirectory);
  const retainedLink = join(runDirectory, "retained-link");
  await symlink(join(scratch, "outside.txt"), retainedLink);
  await symlink(join(scratch, "outside.txt"), join(runDirectory, "artifacts", "review.json"));
  await symlink(join(scratch, "outside.txt"), join(runDirectory, "run-stack.json"));
  await symlink(join(scratch, "outside.txt"), join(hermesStacks, "configured-stack.json"));
  await symlink(outsideStackDirectory, join(hermesStacks, "previous"));
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: retainedLink,
  });

  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
      hermesStacks,
    },
  }).query({ schema: "flow.query/v1", query: "legacy_compatibility_inventory" });

  assert.deepEqual(
    projection.inventory.artifacts
      .filter(({ path }) => path === "run-entry-safety/retained-link")
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  assert.deepEqual(
    projection.inventory.transcript_pointers
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  assert.deepEqual(
    projection.inventory.reviews
      .map(({ evidence_status, reason }) => ({ evidence_status, reason })),
    [{ evidence_status: "uncertain", reason: "symbolic_link_not_followed" }],
  );
  assert.deepEqual(
    projection.inventory.stacks
      .map(({ evidence_status, path, reason }) => ({ evidence_status, path, reason })),
    [
      {
        evidence_status: "uncertain",
        path: "configured-stack.json",
        reason: "symbolic_link_not_followed",
      },
      {
        evidence_status: "uncertain",
        path: "previous",
        reason: "symbolic_link_not_followed",
      },
      {
        evidence_status: "uncertain",
        path: "run-entry-safety/run-stack.json",
        reason: "symbolic_link_not_followed",
      },
    ],
  );
});

test("source digest prunes only retained workspace directories", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-prune-depth-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-prune-depth");
  const nestedRepo = join(runDirectory, "artifacts", "repo");
  await mkdir(nestedRepo, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: { run_id: "run-prune-depth", flow: "feature", external_root: null },
  });
  const evidence = join(nestedRepo, "evidence.txt");
  await writeFile(evidence, "first\n");
  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
    },
  });
  const request = { schema: "flow.query/v1", query: "legacy_compatibility_inventory" };

  const first = await runtime.query(request);
  await writeFile(evidence, "changed\n");
  const changed = await runtime.query(request);
  const sourceDigest = (projection) => projection.inventory.sources
    .find(({ id }) => id === "hermes-agent-flow-runs").content_sha256;

  assert.notEqual(sourceDigest(first), sourceDigest(changed));
});

test("query rejects unsupported contracts and never repairs missing evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-legacy-read-only-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "run-1");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "run.json"), "not-json\n");
  const runtime = createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "absent-claude-runs"),
      hermesRuns,
      hermesStacks: join(scratch, "absent-stacks"),
    },
  });
  const before = await snapshotFiles(scratch);

  const projection = await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  });

  assert.equal(projection.inventory.sources[0].evidence_status, "missing");
  assert.deepEqual(await snapshotFiles(scratch), before);
  assert.deepEqual(
    await runtime.query({ schema: "flow.query/v1", query: "repair_legacy" }),
    {
      schema: "flow.rejection/v1",
      operation: "query",
      code: "unsupported_query",
      reason: null,
      command_type: null,
      run_id: null,
      bundle_digest: null,
      authority_watermark: `sha256:${"0".repeat(64)}`,
      authority_watermark_domain: "host",
      legal_actions: [],
    },
  );
});

test("registered query failures use the shared typed rejection contract", async () => {
  const runtime = createFlowRuntime({
    legacyAdapter: {
      async observe() {
        throw new Error("retained authority unavailable");
      },
    },
  });

  assert.deepEqual(Object.keys(runtime), [
    "prepare",
    "launch",
    "command",
    "query",
    "watch",
  ]);
  assert.deepEqual(await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  }), {
    schema: "flow.rejection/v1",
    operation: "query",
    code: "inventory_unavailable",
    reason: null,
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: `sha256:${"0".repeat(64)}`,
    authority_watermark_domain: "host",
    legal_actions: [],
  });
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshotFiles(root) {
  const snapshot = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    try {
      snapshot[name] = (await readFile(join(root, name))).toString("base64");
    } catch (error) {
      if (!["EISDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  return snapshot;
}

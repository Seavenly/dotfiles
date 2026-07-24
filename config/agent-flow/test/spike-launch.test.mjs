import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { finalizeSpike } from "../src/spike-finalize.mjs";
import { launchSpike } from "../src/spike-launch.mjs";
import { validateContract } from "../src/schema-validator.mjs";
import {
  FakeFeatureAdapter,
  featureTestFixture,
  healthyFeatureDoctor,
} from "./support/feature-fixture.mjs";

test("research-only spike seals a graph without creating a product worktree", async (t) => {
  const fixture = await featureTestFixture(t);
  const manifestPath = await writeSpike(fixture, { prototype: null });
  const adapter = new FakeFeatureAdapter();
  const before = await branches(fixture.repo);
  const result = await launchSpike({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "c".repeat(40),
    manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  assert.equal(result.worktree, null);
  assert.deepEqual(await branches(fixture.repo), before);
  const run = JSON.parse(await readFile(result.runManifestPath));
  assert.deepEqual(await validateContract(run), { valid: true, errors: [] });
  assert.equal(run.identity.repository.worktree, null);
  assert.equal([...adapter.tasks.values()].some(({ workspace_path }) => workspace_path === fixture.repo), false);

  const reportSource = join(run.identity.artifact_directory, "spike-report.md");
  await mkdir(run.identity.artifact_directory, { recursive: true });
  await writeFile(reportSource, "# Spike report\n");
  const digest = createHash("sha256").update(await readFile(reportSource)).digest("hex");
  const snapshotDirectory = join(run.identity.validation_directory, "synthesis");
  const snapshot = join(snapshotDirectory, "spike-report.md");
  await mkdir(snapshotDirectory, { recursive: true });
  await writeFile(snapshot, await readFile(reportSource));
  const handoff = {
    schema: "agent-flow.handoff/v1", run_id: result.runId, flow: "spike", stage: "synthesis",
    artifacts: [{ kind: "spike-report", path: reportSource, sha256: digest }],
    changed_files: [], verification: [], dependencies: [], retry_notes: [], residual_risk: [],
  };
  const producer = adapter.completeStage("synthesis", { handoff });
  const validator = adapter.completeStage("validate-handoff:synthesis");
  const authority = await adapter.getTaskAuthority({ taskId: validator.taskId });
  const validation = {
    schema: "agent-flow.validation/v1", run_id: result.runId, stage: "synthesis",
    task_id: producer.taskId, attempt: 1, validated_at: "2026-07-15T00:00:00Z",
    source_metadata_sha256: createHash("sha256").update(JSON.stringify({ handoff })).digest("hex"),
    provenance: {
      run_manifest_path: authority.runManifestPath,
      run_manifest_sha256: authority.runManifestSha256,
      hermes_attempt_id: producer.attemptId,
    },
    valid: true,
    identity: { handoff_schema: "agent-flow.handoff/v1", run_id: result.runId, stage: "synthesis", attempt: 1 },
    semantic: { required: false, passed: null },
    approved_artifact_roots: [run.identity.artifact_directory],
    validated_artifact_root: run.identity.validation_directory,
    artifacts: [{
      source_path: reportSource, path: snapshot,
      expected_sha256: digest, actual_sha256: digest, valid: true,
    }],
    errors: [],
  };
  const validationDirectory = join(run.identity.artifact_directory, "validations");
  await mkdir(validationDirectory, { recursive: true });
  await writeFile(join(validationDirectory, "validate-handoff--synthesis.json"), `${JSON.stringify(validation, null, 2)}\n`);
  await writeFile(reportSource, "# Changed after validation\n");
  const finalized = await finalizeSpike({
    adapter, env: { XDG_STATE_HOME: fixture.state }, runId: result.runId,
  });
  const spikeResult = JSON.parse(await readFile(finalized.resultPath));
  assert.equal(spikeResult.report_path, await realpath(snapshot));
});

test("prototype spike creates exactly one dedicated worktree and serial slice chain", async (t) => {
  const fixture = await featureTestFixture(t);
  const manifestPath = await writeSpike(fixture, {
    prototype: {
      branch: "agent-flow/spike-one",
      experiment_path: "experiments/spike-one",
      slices: [{ id: "probe", title: "Build probe", verification: [{ argv: ["git", "diff", "--check"] }] }],
      verification: [{ argv: ["git", "diff", "--check"] }],
    },
  });
  const adapter = new FakeFeatureAdapter();
  const result = await launchSpike({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "c".repeat(40),
    manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  assert.equal(typeof result.worktree, "string");
  const productPaths = [...adapter.tasks.values()]
    .filter(({ workspace_path }) => workspace_path === result.worktree)
    .map(({ workspace_path }) => workspace_path);
  assert.equal(productPaths.length > 0, true);
  assert.equal(new Set(productPaths).size, 1);
  const resumed = await launchSpike({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "c".repeat(40),
    manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  assert.equal(resumed.rootTaskId, result.rootTaskId);
  assert.equal((await branches(fixture.repo)).filter((name) => name === "agent-flow/spike-one").length, 1);
});

async function writeSpike(fixture, { prototype }) {
  const path = join(fixture.directory, prototype ? "prototype-spike.json" : "research-spike.json");
  await writeFile(path, `${JSON.stringify({
    schema: "agent-flow.spike/v1",
    run_id: prototype ? "spike-prototype" : "spike-research",
    summary: "Investigate an option",
    question: "Will this design remain deterministic?",
    repo: fixture.repo,
    source: { ref: "main", sha: fixture.baseSha },
    kanban: { board: prototype ? "spike-prototype" : "spike-research", task: "root" },
    external_ref: null,
    mode: "deep",
    angles: ["correctness", "operations"],
    prototype,
    limits: { max_revisions: 1, max_prototype_retries: 1, max_elapsed_seconds: 3600 },
  }, null, 2)}\n`);
  return path;
}

async function branches(repo) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => execFile(
    "git", ["-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { encoding: "utf8" },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim().split("\n").filter(Boolean)),
  ));
}

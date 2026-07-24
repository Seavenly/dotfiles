import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { finalizeFeature } from "../src/feature-finalize.mjs";
import { launchFeature } from "../src/feature-launch.mjs";
import { validateContract } from "../src/schema-validator.mjs";
import { featureTestFixture, FakeFeatureAdapter, healthyFeatureDoctor } from "./support/feature-fixture.mjs";

const execFile = promisify(execFileCallback);

test("feature finalization creates and registers an immutable local review", async (t) => {
  const fixture = await featureTestFixture(t);
  const adapter = new FakeFeatureAdapter();
  const launched = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  await writeFile(join(launched.worktree, "feature.txt"), "implemented\n");
  await git(launched.worktree, "add", "feature.txt");
  await git(launched.worktree, "commit", "-m", "implement feature");
  const artifacts = join(fixture.state, "agent-flow", "runs", "feature-one", "artifacts");
  const runDirectory = join(fixture.state, "agent-flow", "runs", "feature-one");
  await mkdir(artifacts, { recursive: true });
  for (const [name, content] of [
    ["review-summary.md", "# Review\n"],
    ["journal.md", "Implemented the slice.\n"],
    ["automated-review.json", `${JSON.stringify({
      passed: true,
      reviewed_head_sha: await git(launched.worktree, "rev-parse", "HEAD"),
      blocking_findings: [],
    })}\n`],
  ]) await writeFile(join(artifacts, name), content);
  await writeValidation({
    adapter,
    artifacts,
    paths: [join(artifacts, "automated-review.json")],
    runDirectory,
    semantic: { required: true, passed: true },
    stage: "independent-critic",
  });
  await writeValidation({
    adapter,
    artifacts,
    paths: [join(artifacts, "review-summary.md"), join(artifacts, "journal.md")],
    runDirectory,
    semantic: { required: false, passed: null },
    stage: "review-summary",
  });
  const registrations = [];
  const result = await finalizeFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    registerReview: async (path) => registrations.push(path),
    runId: "feature-one",
  });

  assert.deepEqual(registrations, [result.reviewManifestPath]);
  const review = JSON.parse(await readFile(result.reviewManifestPath, "utf8"));
  assert.deepEqual(await validateContract(review), { valid: true, errors: [] });
  assert.equal(review.base.sha, fixture.baseSha);
  assert.equal(review.head.sha, await git(launched.worktree, "rev-parse", "HEAD"));
  assert.equal(review.worktree, launched.worktree);
  assert.equal(review.automated_review.status, "passed");

  const evidencePath = join(artifacts, "validations", "validate-handoff--independent-critic.json");
  const forged = JSON.parse(await readFile(evidencePath));
  forged.task_id = "attacker-selected-task";
  await writeFile(evidencePath, `${JSON.stringify(forged, null, 2)}\n`);
  await assert.rejects(
    finalizeFeature({
      adapter, env: { XDG_STATE_HOME: fixture.state },
      registerReview: async () => {}, runId: "feature-one",
    }),
    /terminal producer attempt/,
  );
});

async function writeValidation({ adapter, artifacts, paths, runDirectory, semantic, stage }) {
  const validatedRoot = join(runDirectory, "validated");
  const snapshotDirectory = join(validatedRoot, stage);
  await mkdir(snapshotDirectory, { recursive: true });
  const records = [];
  for (const source of paths) {
    const bytes = await readFile(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = join(snapshotDirectory, source.split("/").at(-1));
    await writeFile(path, bytes);
    records.push({
      source_path: source,
      path,
      expected_sha256: digest,
      actual_sha256: digest,
      valid: true,
    });
  }
  const handoff = {
    schema: "agent-flow.handoff/v1", run_id: "feature-one", flow: "feature", stage,
    artifacts: records.map(({ source_path: path, expected_sha256: sha256 }) => ({
      kind: "feature-artifact", path, sha256,
    })),
    changed_files: [], verification: [], dependencies: [], retry_notes: [], residual_risk: [],
    ...(typeof semantic.passed === "boolean" ? { passed: semantic.passed } : {}),
  };
  const producer = adapter.completeStage(stage, { handoff });
  const validator = adapter.completeStage(`validate-handoff:${stage}`);
  const authority = await adapter.getTaskAuthority({ taskId: validator.taskId });
  const metadata = { handoff };
  const evidence = {
    schema: "agent-flow.validation/v1",
    run_id: "feature-one",
    stage,
    task_id: producer.taskId,
    attempt: 1,
    validated_at: "2026-07-15T00:00:00Z",
    source_metadata_sha256: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),
    provenance: {
      run_manifest_path: authority.runManifestPath,
      run_manifest_sha256: authority.runManifestSha256,
      hermes_attempt_id: producer.attemptId,
    },
    valid: true,
    identity: {
      handoff_schema: "agent-flow.handoff/v1",
      run_id: "feature-one",
      stage,
      attempt: 1,
    },
    semantic,
    approved_artifact_roots: [artifacts],
    validated_artifact_root: validatedRoot,
    artifacts: records,
    errors: [],
  };
  const validations = join(artifacts, "validations");
  await mkdir(validations, { recursive: true });
  await writeFile(
    join(validations, `validate-handoff--${stage}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

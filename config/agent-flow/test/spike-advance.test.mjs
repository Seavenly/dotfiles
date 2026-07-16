import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { advanceSpike, decideSpikeRevision } from "../src/spike-advance.mjs";
import { launchSpike } from "../src/spike-launch.mjs";
import {
  FakeFeatureAdapter,
  featureTestFixture,
  healthyFeatureDoctor,
} from "./support/feature-fixture.mjs";

test("spike revision retains evidence and carries residual gaps into synthesis", () => {
  const revision = decideSpikeRevision({
    cap: 1,
    gaps: [
      { angle: "operations", gap: "No recovery evidence" },
      { angle: "security", gap: "No containment proof" },
    ],
    retainedEvidence: ["artifact-a", "artifact-a"],
    used: 0,
  });
  assert.equal(revision.action, "revise");
  assert.deepEqual(revision.retainedEvidence, ["artifact-a"]);
  assert.equal(revision.residualGaps.length, 1);
  const exhausted = decideSpikeRevision({
    cap: 1,
    gaps: [revision.gap, ...revision.residualGaps],
    retainedEvidence: revision.retainedEvidence,
    used: 1,
  });
  assert.equal(exhausted.action, "synthesize");
  assert.equal(exhausted.residualGaps.length, 2);
});

test("deep spike controller materializes only the named bounded revision", async (t) => {
  const fixture = await featureTestFixture(t);
  const manifestPath = join(fixture.directory, "spike.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "agent-flow.spike/v1", run_id: "spike-one", summary: "Investigate",
    question: "Is recovery safe?", repo: fixture.repo,
    source: { ref: "main", sha: fixture.baseSha },
    kanban: { board: "spike-one", task: "root" }, external_ref: null,
    mode: "deep", angles: ["operations", "security"], prototype: null,
    limits: { max_revisions: 1, max_prototype_retries: 0, max_elapsed_seconds: 3600 },
  }, null, 2)}\n`);
  const adapter = new FakeFeatureAdapter();
  const launched = await launchSpike({
    adapter, env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "c".repeat(40), manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  const artifacts = join(fixture.state, "agent-flow", "runs", "spike-one", "artifacts");
  const measurement = join(artifacts, "measurements", "gap-controller.json");
  await mkdir(join(artifacts, "measurements"), { recursive: true });
  await writeFile(measurement, `${JSON.stringify({
    gaps: [{ angle: "operations", gap: "No restart evidence" }],
    retained_evidence: ["operations-report.json"],
  })}\n`);
  const result = await advanceSpike({
    adapter, env: { XDG_STATE_HOME: fixture.state }, measurementPath: measurement,
    runId: launched.runId,
  });
  assert.equal(result.action, "revise");
  assert.equal(result.angle, "operations");
  assert.equal([...adapter.tasks.values()].filter(({ title }) => title.includes("/operations]")).length, 2);
  const exhausted = await advanceSpike({
    adapter, env: { XDG_STATE_HOME: fixture.state }, measurementPath: measurement,
    runId: launched.runId,
  });
  assert.equal(exhausted.action, "synthesize");
  const residual = JSON.parse(await readFile(join(artifacts, "residual-gaps.json")));
  assert.equal(residual.residual_gaps[0].angle, "operations");
});

test("prototype controller derives gate failure, materializes one retry, and blocks at cap", async (t) => {
  const fixture = await featureTestFixture(t);
  const manifestPath = join(fixture.directory, "prototype-spike.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "agent-flow.spike/v1", run_id: "spike-prototype", summary: "Prototype",
    question: "Does the prototype work?", repo: fixture.repo,
    source: { ref: "main", sha: fixture.baseSha },
    kanban: { board: "spike-prototype", task: "root" }, external_ref: null,
    mode: "quick", angles: [],
    prototype: {
      branch: "agent-flow/spike-prototype", experiment_path: "experiments/prototype",
      slices: [{ id: "one", title: "Build prototype", verification: [{ argv: ["git", "diff", "--check"] }] }],
      verification: [{ argv: ["git", "diff", "--check"] }],
    },
    limits: { max_revisions: 0, max_prototype_retries: 1, max_elapsed_seconds: 3600 },
  }, null, 2)}\n`);
  const adapter = new FakeFeatureAdapter();
  const launched = await launchSpike({
    adapter, env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "c".repeat(40), manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  const runDirectory = join(fixture.state, "agent-flow", "runs", launched.runId);
  const artifacts = join(runDirectory, "artifacts");
  const initialEvidence = join(artifacts, "gates", "prototype-gate--1", "1.json");
  await mkdir(join(artifacts, "gates", "prototype-gate--1"), { recursive: true });
  const initialHandoff = await writeCommandResult(initialEvidence, {
    cwd: launched.worktree, exitCode: 1, gateName: "spike-prototype-gate--1",
    runId: launched.runId, stage: "prototype-gate:1",
  });
  adapter.completeStage("prototype-gate:1", { handoff: initialHandoff });
  const retried = await advanceSpike({
    adapter, controllerStage: "prototype-controller:1",
    env: { XDG_STATE_HOME: fixture.state },
    runId: launched.runId,
  });
  assert.equal(retried.action, "retry");
  assert.equal(retried.ordinal, 1);
  const retryGate = [...adapter.tasks.values()].find(({ title }) =>
    title.includes("prototype-gate:retry-1:1")
  );
  assert.equal(retryGate.workspace_path, launched.worktree);
  const resumed = await launchSpike({
    adapter, env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "c".repeat(40), manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  assert.equal(resumed.rootTaskId, launched.rootTaskId);
  const sealedBody = retryGate.body;
  retryGate.body = `${sealedBody}\nforged`;
  await assert.rejects(
    launchSpike({
      adapter, env: { XDG_STATE_HOME: fixture.state },
      implementationRevision: "c".repeat(40), manifestPath,
      runDoctor: async () => healthyFeatureDoctor(),
    }),
    /differs from sealed authority/,
  );
  retryGate.body = sealedBody;

  const retryEvidence = join(artifacts, "gates", "prototype-gate--retry-1--1", "1.json");
  await mkdir(join(artifacts, "gates", "prototype-gate--retry-1--1"), { recursive: true });
  const retryHandoff = await writeCommandResult(retryEvidence, {
    cwd: launched.worktree, exitCode: 1, gateName: "spike-prototype-gate--retry-1--1",
    runId: launched.runId, stage: "prototype-gate:retry-1:1",
  });
  adapter.completeStage("prototype-gate:retry-1:1", { handoff: retryHandoff });
  const blocked = await advanceSpike({
    adapter, controllerStage: "prototype-controller:1",
    env: { XDG_STATE_HOME: fixture.state },
    runId: launched.runId,
  });
  assert.equal(blocked.action, "needs_input");
  assert.equal(adapter.tasks.get(launched.rootTaskId).status, "blocked");
  const stuck = JSON.parse(await readFile(join(artifacts, "stuck-slices.json")));
  assert.equal(stuck.stuck_slices[0].slice_ordinal, 1);
});

async function writeCommandResult(path, { cwd, exitCode, gateName, runId, stage }) {
  const bytes = `${JSON.stringify({
    schema: "agent-flow.command-result/v1", run_id: runId, stage,
    gate_name: gateName, gate_version: 1, command_index: 0,
    argv: ["git", "diff", "--check"], cwd, termination: "exit",
    exit_code: exitCode, stdout: "", stderr: exitCode ? "failed" : "",
  }, null, 2)}\n`;
  await writeFile(path, bytes);
  return {
    schema: "agent-flow.handoff/v1", run_id: runId, flow: "spike", stage,
    passed: exitCode === 0,
    artifacts: [{
      kind: "command-result", path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
    changed_files: [], verification: [], dependencies: [], retry_notes: [], residual_risk: [],
  };
}

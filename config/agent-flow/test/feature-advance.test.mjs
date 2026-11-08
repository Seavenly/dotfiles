import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { advanceFeature } from "../src/feature-advance.mjs";
import { launchFeature } from "../src/feature-launch.mjs";
import {
  FakeFeatureAdapter,
  featureTestFixture,
  healthyFeatureDoctor,
} from "./support/feature-fixture.mjs";

test("feature advance materializes a sealed retry and recovers idempotently", async (t) => {
  const fixture = await featureTestFixture(t);
  const adapter = new FakeFeatureAdapter();
  const launch = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  const artifacts = join(fixture.state, "agent-flow", "runs", launch.runId, "artifacts");
  const measurementPath = join(artifacts, "measurements", "slice-controller--1.json");
  await mkdir(join(artifacts, "measurements"), { recursive: true });
  const initial = await writeGateEvidence({
    fixture,
    passed: false,
    stage: "gate:1",
  });
  adapter.completeStage("gate:1", { handoff: initial.handoff });
  await writeFile(measurementPath, `${JSON.stringify({
    evidence: initial.evidence,
  })}\n`);

  const result = await advanceFeature({
    adapter,
    controllerStage: "slice-controller:1",
    env: { XDG_STATE_HOME: fixture.state },
    measurementPath,
    runId: launch.runId,
  });
  assert.equal(result.action, "retry");
  assert.equal(result.createdCards, 5);
  const count = adapter.tasks.size;
  const relaunched = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  assert.equal(relaunched.rootTaskId, launch.rootTaskId);
  assert.equal(adapter.tasks.size, count);
  const retry = await writeGateEvidence({
    fixture,
    passed: false,
    stage: "gate:retry-1:1",
  });
  adapter.completeStage("gate:retry-1:1", { handoff: retry.handoff });
  await writeFile(measurementPath, `${JSON.stringify({ evidence: retry.evidence })}\n`);
  const resumed = await advanceFeature({
    adapter,
    controllerStage: "slice-controller:1",
    env: { XDG_STATE_HOME: fixture.state },
    measurementPath,
    runId: launch.runId,
  });
  assert.equal(resumed.action, "needs_input");
  assert.equal(adapter.tasks.size, count);
  const receipt = JSON.parse(await readFile(
    join(fixture.state, "agent-flow", "runs", launch.runId, "materialization.json"),
  ));
  assert.equal(typeof receipt.tasks["gate:retry-1:1"], "string");
  assert.equal(
    adapter.tasks.get(receipt.tasks["slice-controller:1"]).parents.includes(
      receipt.tasks["gate:retry-1:1"],
    ),
    true,
  );
});

test("feature advance makes retry exhaustion visible on the root", async (t) => {
  const fixture = await featureTestFixture(t);
  const adapter = new FakeFeatureAdapter();
  const launch = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  const artifacts = join(fixture.state, "agent-flow", "runs", launch.runId, "artifacts");
  const measurementPath = join(artifacts, "measurements", "slice-controller--1.json");
  await mkdir(join(artifacts, "measurements"), { recursive: true });
  const initial = await writeGateEvidence({ fixture, passed: false, stage: "gate:1" });
  adapter.completeStage("gate:1", { handoff: initial.handoff });
  await writeFile(measurementPath, `${JSON.stringify({ evidence: initial.evidence })}\n`);
  await advanceFeature({
    adapter,
    controllerStage: "slice-controller:1",
    env: { XDG_STATE_HOME: fixture.state },
    measurementPath,
    runId: launch.runId,
  });
  const statePath = join(fixture.state, "agent-flow", "runs", launch.runId, "feature-controller.json");
  const state = JSON.parse(await readFile(statePath));
  state.transitions["slice-retry:1"] = 1;
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  const retry = await writeGateEvidence({
    fixture,
    passed: false,
    stage: "gate:retry-1:1",
  });
  adapter.completeStage("gate:retry-1:1", { handoff: retry.handoff });
  await writeFile(measurementPath, `${JSON.stringify({ evidence: retry.evidence })}\n`);
  const result = await advanceFeature({
    adapter,
    controllerStage: "slice-controller:1",
    env: { XDG_STATE_HOME: fixture.state },
    measurementPath,
    runId: launch.runId,
  });
  assert.equal(result.action, "needs_input");
  assert.equal(adapter.tasks.get(launch.rootTaskId).status, "blocked");
  const receipt = JSON.parse(await readFile(join(
    fixture.state, "agent-flow", "runs", launch.runId, "materialization.json",
  )));
  assert.equal(adapter.tasks.get(receipt.tasks["slice-controller:1"]).status, "blocked");
});

test("feature controller rejects terminal evidence for a substituted command", async (t) => {
  const fixture = await featureTestFixture(t);
  const adapter = new FakeFeatureAdapter();
  const launch = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  const evidence = await writeGateEvidence({ fixture, passed: true, stage: "gate:1" });
  const path = evidence.evidence[0];
  const forged = JSON.parse(await readFile(path));
  forged.argv = ["true"];
  const bytes = `${JSON.stringify(forged)}\n`;
  await writeFile(path, bytes);
  evidence.handoff.artifacts[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  adapter.completeStage("gate:1", { handoff: evidence.handoff });
  await assert.rejects(
    advanceFeature({
      adapter,
      controllerStage: "slice-controller:1",
      env: { XDG_STATE_HOME: fixture.state },
      runId: launch.runId,
    }),
    /differs from the sealed gate/,
  );
});

async function writeGateEvidence({ fixture, passed, stage }) {
  const runDirectory = join(fixture.state, "agent-flow", "runs", "feature-one");
  const run = JSON.parse(await readFile(join(runDirectory, "run.json")));
  const safe = stage.replaceAll(":", "--");
  const input = run.inputs.find(({ kind, sealed_path: path }) =>
    kind === "gate" && path.endsWith(`/${safe}.json`)
  );
  const gate = JSON.parse(await readFile(input.sealed_path));
  const artifacts = [];
  for (const [index, path] of gate.outputs.entries()) {
    await mkdir(join(path, ".."), { recursive: true });
    const bytes = `${JSON.stringify({
      schema: "agent-flow.command-result/v1",
      run_id: "feature-one",
      stage,
      gate_name: gate.name,
      gate_version: gate.version,
      command_index: index,
      argv: gate.commands[index].argv,
      cwd: gate.commands[index].cwd,
      termination: "exit",
      exit_code: passed ? 0 : 1,
      stdout: "",
      stderr: passed ? "" : "failed",
    })}\n`;
    await writeFile(path, bytes);
    artifacts.push({
      kind: "command-result",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return {
    evidence: gate.outputs,
    handoff: {
      schema: "agent-flow.handoff/v1",
      run_id: "feature-one",
      flow: "feature",
      stage,
      passed,
      artifacts,
      changed_files: [],
      verification: [],
      dependencies: [],
      retry_notes: [],
      residual_risk: [],
    },
  };
}

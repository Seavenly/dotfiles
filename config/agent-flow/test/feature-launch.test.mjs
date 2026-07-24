import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { launchFeature } from "../src/feature-launch.mjs";
import { runCli } from "../src/cli-command.mjs";
import { projectRunStatus } from "../src/run-lifecycle.mjs";
import { validateContract } from "../src/schema-validator.mjs";
import {
  FakeFeatureAdapter,
  featureTestFixture,
  healthyFeatureDoctor,
} from "./support/feature-fixture.mjs";

const execFile = promisify(execFileCallback);

test("feature launch creates one worktree and a complete serialized task graph", async (t) => {
  const fixture = await featureTestFixture(t);
  const adapter = new FakeFeatureAdapter();
  const result = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });

  assert.equal(result.runId, "feature-one");
  assert.equal(await git(result.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "agent-flow/feature-one");
  assert.equal(adapter.tasks.size, result.cardCount);
  const workspaces = [...adapter.tasks.values()]
    .filter(({ assignee }) => ["builder", "critic", "gate"].includes(assignee))
    .map(({ workspace_path }) => workspace_path);
  assert.equal(workspaces.includes(result.worktree), true);
  assert.equal(new Set(workspaces.filter((path) => path === result.worktree)).size, 1);

  const run = JSON.parse(await readFile(result.runManifestPath, "utf8"));
  assert.deepEqual(await validateContract(run), { valid: true, errors: [] });
  assert.equal(run.identity.repository.worktree, result.worktree);
  assert.equal(run.revisions.base, fixture.baseSha);
  assert.equal(adapter.remoteMutations, 0);
  const status = await projectRunStatus({
    adapter, env: { XDG_STATE_HOME: fixture.state }, runId: result.runId,
  });
  assert.equal(status.flow, "feature");
  assert.equal(status.state, "running");
  assert.deepEqual(status.issues, []);

  const resumed = await launchFeature({
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  });
  assert.equal(resumed.rootTaskId, result.rootTaskId);
  assert.equal(adapter.tasks.size, result.cardCount);
});

test("agent-flow exposes feature launch without remote mutation", async () => {
  let invoked = null;
  const stdout = captureStream();
  const stderr = captureStream();
  const status = await runCli([
    "launch", "feature", "--manifest", "/tmp/feature.json",
  ], {
    launchFeatureRun: async (options) => {
      invoked = options;
      return {
        runId: "feature-one",
        cardCount: 12,
        worktree: "/tmp/worktree",
        rootTaskId: "t_root",
        runManifestPath: "/tmp/run.json",
      };
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(status, 0);
  assert.equal(invoked.manifestPath, "/tmp/feature.json");
  assert.match(stdout.value(), /feature feature-one materialized 12 cards/);
  assert.equal(stderr.value(), "");
});

test("feature resume rejects sealed-input and idempotent-task drift", async (t) => {
  const fixture = await featureTestFixture(t);
  const adapter = new FakeFeatureAdapter();
  const options = {
    adapter,
    env: { XDG_STATE_HOME: fixture.state },
    implementationRevision: "b".repeat(40),
    manifestPath: fixture.manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  };
  const launched = await launchFeature(options);
  const run = JSON.parse(await readFile(launched.runManifestPath, "utf8"));
  const skill = run.inputs.find(({ kind }) => kind === "skill");
  await appendFile(skill.sealed_path, "tamper\n");
  await assert.rejects(() => launchFeature(options), /sealed input changed/);

  const fixture2 = await featureTestFixture(t);
  const adapter2 = new FakeFeatureAdapter();
  const options2 = {
    ...options,
    adapter: adapter2,
    env: { XDG_STATE_HOME: fixture2.state },
    manifestPath: fixture2.manifestPath,
  };
  const launched2 = await launchFeature(options2);
  adapter2.tasks.get(launched2.rootTaskId).body = "tampered";
  await assert.rejects(
    () => launchFeature(options2),
    /does not match sealed launch authority/,
  );
});

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

function captureStream() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    value: () => value,
  };
}

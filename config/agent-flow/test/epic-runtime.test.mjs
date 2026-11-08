import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  checkpointEpicTarget,
  initializeEpic,
  materializeEpicWave,
  recordEpicFeatureStatus,
} from "../src/epic-runtime.mjs";
import {
  FakeFeatureAdapter,
  healthyFeatureDoctor,
} from "./support/feature-fixture.mjs";

const execFile = promisify(execFileCallback);

test("epic prototype resumes, launches one bounded wave, rejects self-integration, and detects target drift", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-epic-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"); const state = join(directory, "state");
  await mkdir(repo); await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n"); await git(repo, "add", "base.txt"); await git(repo, "commit", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  const manifestPath = join(directory, "epic.json");
  const feature = (id, depends_on) => ({
    id, summary: `Feature ${id}`, depends_on, acceptance: [`${id} exists`],
    slices: [{ id, title: `Build ${id}`, verification: [{ argv: ["git", "diff", "--check"] }] }],
    verification: [{ argv: ["git", "diff", "--check"] }],
  });
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "agent-flow.epic/v1", run_id: "epic-one", summary: "Epic", repo,
    source: { base_ref: "main", base_sha: base, branch: "epic/source" },
    target: { ref: "main", sha: base }, kanban: { board: "epic-one", task: "root" },
    external_ref: "github:owner/repo#1",
    features: [feature("core", [])],
    verification: [{ argv: ["git", "diff", "--check"] }],
    limits: {
      max_feature_streams: 2, max_slice_retries: 1, max_completeness_fixes: 1,
      max_critique_fixes: 1, max_elapsed_seconds: 3600,
    },
  }, null, 2)}\n`);
  const env = { XDG_STATE_HOME: state };
  const adapter = new FakeFeatureAdapter();
  const launchOptions = {
    adapter, env, implementationRevision: "d".repeat(40), manifestPath,
    runDoctor: async () => healthyFeatureDoctor(),
  };
  const initialized = await initializeEpic(launchOptions);
  assert.equal(initialized.resumed, false);
  assert.equal((await initializeEpic(launchOptions)).resumed, true);
  const untracked = join(initialized.sourceWorktree, "untracked.txt");
  await writeFile(untracked, "untrusted\n");
  await assert.rejects(() => initializeEpic(launchOptions), /worktree is not clean/);
  await unlink(untracked);
  const runManifest = JSON.parse(await readFile(initialized.runManifestPath));
  assert.equal(runManifest.identity.flow, "epic");
  assert.equal(typeof initialized.rootTaskId, "string");
  const launched = [];
  const launchFeatureRun = async ({ manifestPath: path }) => {
    const child = JSON.parse(await readFile(path)); launched.push(child.run_id);
    return {
      rootTaskId: `root-${child.run_id}`, runId: child.run_id,
      runManifestPath: `${path}.run`, worktree: `${directory}/${child.run_id}`,
    };
  };
  const first = await materializeEpicWave({
    env, launchFeatureRun, runDoctor: async () => ({}), runId: "epic-one",
  });
  assert.deepEqual(first.ready, ["core"]);
  await assert.rejects(
    () => recordEpicFeatureStatus({ env, featureId: "core", runId: "epic-one", status: "integrated" }),
    /unknown epic feature status/,
  );
  assert.deepEqual(launched, ["epic-one.core"]);

  const projectionPath = join(state, "agent-flow", "runs", "epic-one", "epic-state.json");
  const projection = JSON.parse(await readFile(projectionPath));
  projection.features.core.status = "integrated";
  projection.features.core.integration_receipt = join(directory, "missing-receipt.json");
  await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
  await assert.rejects(
    () => checkpointEpicTarget({ adapter, env, runId: "epic-one" }),
    /not canonical|ENOENT|no such file/i,
  );
  for (const value of Object.values(projection.features)) {
    value.status = "pending";
    delete value.integration_receipt;
  }
  await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);

  for (const id of ["core"]) {
    projection.features[id].status = "integrated";
    projection.features[id].integration_receipt = await writeIntegrationReceipt({
      directory: join(state, "agent-flow", "runs", "epic-one", "receipts", "integration"),
      id, repo, sourceRef: "refs/heads/epic/source",
      sourceSha: await git(repo, "rev-parse", "epic/source"),
    });
  }
  await writeFile(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
  const sourceGate = await writeEpicGateEvidence({ passed: true, runDirectory: join(state, "agent-flow", "runs", "epic-one"), stage: "source-verification" });
  adapter.completeStage("source-verification", { handoff: sourceGate.handoff });

  await writeFile(join(repo, "target.txt"), "target moved\n");
  await git(repo, "add", "target.txt"); await git(repo, "commit", "-m", "move target");
  const checkpoint = await checkpointEpicTarget({ adapter, env, runId: "epic-one" });
  assert.equal(checkpoint.action, "source_refresh");
  assert.equal(checkpoint.generation, 1);
  assert.equal(checkpoint.createdCards, 5);
  const resumedCheckpoint = await checkpointEpicTarget({ adapter, env, runId: "epic-one" });
  assert.equal(resumedCheckpoint.generation, 1);
  await git(initialized.sourceWorktree, "merge", "--no-edit", "main");
  const refreshGate = await writeEpicGateEvidence({ passed: true, runDirectory: join(state, "agent-flow", "runs", "epic-one"), stage: "source-refresh-gate:1" });
  adapter.completeStage("source-refresh-gate:1", { handoff: refreshGate.handoff });
  adapter.completeStage("source-refresh-review:1", { handoff: epicHandoff("source-refresh-review:1", true) });
  adapter.completeStage("validate-handoff:source-refresh-review:1");
  const completedCheckpoint = await checkpointEpicTarget({ adapter, env, runId: "epic-one" });
  assert.equal(completedCheckpoint.action, "current");
  const completedState = JSON.parse(await readFile(initialized.statePath));
  assert.equal(completedState.recorded_target_sha, await git(repo, "rev-parse", "main"));
  assert.equal(completedState.stack_checkpoints[0].status, "source_refresh_complete");
});

async function writeEpicGateEvidence({ passed, runDirectory, stage }) {
  const run = JSON.parse(await readFile(join(runDirectory, "run.json")));
  const input = run.inputs.find(({ kind, sealed_path: path }) =>
    kind === "gate" && path.endsWith(`/${stage.replaceAll(":", "--")}.json`)
  );
  const gate = JSON.parse(await readFile(input.sealed_path));
  const artifacts = [];
  for (const [index, path] of gate.outputs.entries()) {
    await mkdir(join(path, ".."), { recursive: true });
    const bytes = `${JSON.stringify({
      schema: "agent-flow.command-result/v1", run_id: "epic-one", stage,
      gate_name: gate.name, gate_version: gate.version, command_index: index,
      argv: gate.commands[index].argv, cwd: gate.commands[index].cwd,
      termination: "exit", exit_code: passed ? 0 : 1, stdout: "", stderr: "",
    })}\n`;
    await writeFile(path, bytes);
    artifacts.push({ kind: "command-result", path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { handoff: epicHandoff(stage, passed, artifacts) };
}

function epicHandoff(stage, passed, artifacts = []) {
  return {
    schema: "agent-flow.handoff/v1", run_id: "epic-one", flow: "epic", stage,
    passed, artifacts, changed_files: [], verification: [], dependencies: [],
    retry_notes: [], residual_risk: [],
  };
}

async function writeIntegrationReceipt({ directory, id, repo, sourceRef, sourceSha }) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `epic-one.${id}.json`);
  const tree = await git(repo, "rev-parse", `${sourceSha}^{tree}`);
  await writeFile(path, `${JSON.stringify({
    schema: "agent-flow.integration-receipt/v1", receipt_id: `${id}-receipt`,
    review_run_id: `epic-one.${id}`, repository: await realpath(repo), reviewed_head_sha: sourceSha,
    approved_assembly_sha: null, target_ref: sourceRef, resulting_commit_sha: sourceSha,
    resulting_tree_sha: tree, actor: "test", integrated_at: "2026-07-16T00:00:00Z",
  })}\n`);
  return path;
}

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

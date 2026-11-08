import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  analyzeStackDiff,
  approveRestack,
  approveStackPlan,
  buildStack,
  prototypeAssemblyPolicy,
  publishStack,
  restackSuffix,
  stackPlanFingerprint,
  validateStackPlan,
} from "../src/stack-operations.mjs";

const execFile = promisify(execFileCallback);

test("approved hunk plan builds true linear layers with the exact source tree", async (t) => {
  const fixture = await stackFixture(t);
  const analysis = await analyzeStackDiff({
    repo: fixture.repo, sourceSha: fixture.source, targetSha: fixture.target,
  });
  assert.equal(analysis.files.find(({ path }) => path === "file.txt").hunk_count, 2);
  const { path, plan } = await writePlan(fixture);
  assert.deepEqual(await validateStackPlan(plan), { valid: true, errors: [] });
  await approveStackPlan({ actor: "user", planPath: path });
  const result = await buildStack({ planPath: path });
  assert.equal(
    await git(fixture.repo, "rev-parse", `${result.finalHeadSha}^{tree}`),
    await git(fixture.repo, "rev-parse", `${fixture.source}^{tree}`),
  );
  assert.equal(await isAncestor(fixture.repo, "stack/layer-1", "stack/layer-2"), true);
  assert.equal(await isAncestor(fixture.repo, "stack/layer-2", "stack/layer-3"), true);
  assert.equal(await git(fixture.repo, "rev-parse", "source"), fixture.source);
  assert.equal(await git(fixture.repo, "rev-parse", "main"), fixture.target);
  const state = JSON.parse(await readFile(result.statePath));
  assert.equal(state.status, "built");
  assert.equal(state.rollback_actions.length, 3);
  for (const policy of ["merge", "squash", "replay"]) {
    const proof = await prototypeAssemblyPolicy({
      layerHeads: state.created_layers.map(({ head_sha }) => head_sha),
      policy,
      repo: fixture.repo,
      sourceSha: fixture.source,
      targetSha: fixture.target,
    });
    assert.equal(proof.exactTree, true, policy);
  }
});

test("schema-valid built state cannot bypass approved stack topology", async (t) => {
  const fixture = await stackFixture(t);
  const { path: planPath } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath });
  const statePath = `${planPath}.state.json`;
  const plan = JSON.parse(await readFile(planPath));
  await writeFile(statePath, `${JSON.stringify({
    schema: "agent-flow.stack-state/v1", run_id: plan.run_id, generation: plan.generation,
    plan_fingerprint: plan.plan_fingerprint, status: "built", created_layers: [],
    final_head_sha: null, final_tree_sha: null, prs: [], rollback_actions: [], error: null,
  }, null, 2)}\n`);
  await assert.rejects(
    publishStack({ planPath, remote: {} }),
    /does not contain every approved layer/,
  );
});

for (const [position, path] of [[0, "file.txt"], [1, "file.txt"], [2, "final.txt"]]) {
  test(`review edit in layer ${position + 1} restacks only its suffix without force-updating the prefix`, async (t) => {
    const fixture = await stackFixture(t); const { path: planPath } = await writePlan(fixture);
    await approveStackPlan({ actor: "user", planPath });
    const built = await buildStack({ planPath });
    const state = JSON.parse(await readFile(built.statePath));
    const prefix = state.created_layers.slice(0, position).map(({ branch, head_sha }) => ({ branch, head_sha }));
    const originalSuffix = state.created_layers.slice(position + 1).map(({ branch, head_sha }) => ({ branch, head_sha }));
    const branch = state.created_layers[position].branch;
    await git(fixture.repo, "switch", branch);
    if (position < 2) {
      const lines = (await readFile(join(fixture.repo, path), "utf8")).split("\n");
      lines[position === 0 ? 1 : 20] += ` review edit ${position}`;
      await writeFile(join(fixture.repo, path), lines.join("\n"));
    } else {
      await writeFile(join(fixture.repo, path), `${await readFile(join(fixture.repo, path), "utf8")}review edit ${position}\n`);
    }
    await git(fixture.repo, "add", path); await git(fixture.repo, "commit", "-m", `review layer ${position + 1}`);
    const changedHeadSha = await git(fixture.repo, "rev-parse", "HEAD");
    await git(fixture.repo, "switch", "main");
    await approveRestack({
      actor: "user", changedHeadSha, changedLayerIndex: position,
      newGeneration: 2, planPath,
    });
    const restack = await restackSuffix({
      changedHeadSha, changedLayerIndex: position, newGeneration: 2, planPath,
    });
    assert.equal(restack.suffix.length, 2 - position);
    const promoted = JSON.parse(await readFile(built.statePath));
    assert.equal(promoted.active_generation, 2);
    assert.equal(promoted.final_head_sha, restack.final_head_sha);
    assert.equal(promoted.created_layers.at(-1).head_sha, restack.final_head_sha);
    for (const item of prefix) assert.equal(await git(fixture.repo, "rev-parse", item.branch), item.head_sha);
    for (const item of originalSuffix) assert.equal(await git(fixture.repo, "rev-parse", item.branch), item.head_sha);
    if (restack.suffix.length) assert.equal(await isAncestor(fixture.repo, changedHeadSha, restack.final_head_sha), true);
  });
}

test("target drift marks an approved generation stale before ref mutation", async (t) => {
  const fixture = await stackFixture(t);
  const { path } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath: path });
  await writeFile(join(fixture.repo, "target-moved.txt"), "moved\n");
  await git(fixture.repo, "add", "target-moved.txt"); await git(fixture.repo, "commit", "-m", "move target");
  await assert.rejects(() => buildStack({ planPath: path }), /generation is stale/);
  const stale = JSON.parse(await readFile(path));
  assert.equal(stale.approval.status, "stale");
  await assert.rejects(() => git(fixture.repo, "rev-parse", "stack/layer-1"));
});

test("review edits cannot cross another layer's hunk ownership", async (t) => {
  const fixture = await stackFixture(t); const { path: planPath } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath });
  const built = await buildStack({ planPath });
  const state = JSON.parse(await readFile(built.statePath));
  await git(fixture.repo, "switch", state.created_layers[0].branch);
  const lines = (await readFile(join(fixture.repo, "file.txt"), "utf8")).split("\n");
  lines[20] += " forged ownership";
  await writeFile(join(fixture.repo, "file.txt"), lines.join("\n"));
  await git(fixture.repo, "add", "file.txt"); await git(fixture.repo, "commit", "-m", "edit another layer hunk");
  const changedHeadSha = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");
  await assert.rejects(
    approveRestack({ actor: "user", changedHeadSha, changedLayerIndex: 0, newGeneration: 2, planPath }),
    /escaped owning hunks/,
  );
});

test("target drift between PR creations preserves a partial publication receipt", async (t) => {
  const fixture = await stackFixture(t); const { path } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath: path }); const built = await buildStack({ planPath: path });
  let created = 0;
  const remote = {
    async assertRepositoryCoordinate() {},
    async assertTargetRef() {},
    async pushBranch() {},
    async createPullRequest() {
      created += 1;
      if (created === 1) {
        await writeFile(join(fixture.repo, "remote-target.txt"), "moved\n");
        await git(fixture.repo, "add", "remote-target.txt"); await git(fixture.repo, "commit", "-m", "move target remotely");
      }
      return { id: `pr-${created}`, url: `https://example.test/pr/${created}` };
    },
  };
  await assert.rejects(() => publishStack({ planPath: path, remote }), /generation is stale/);
  const state = JSON.parse(await readFile(built.statePath));
  assert.equal(state.prs.length, 1);
  assert.equal(state.status, "publish_failed");
});

test("partial stack publication resumes by reconciling the existing remote PR", async (t) => {
  const fixture = await stackFixture(t); const { path } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath: path }); const built = await buildStack({ planPath: path });
  let calls = 0;
  const remote = {
    async assertRepositoryCoordinate() {},
    async assertTargetRef() {},
    async pushBranch() {},
    async createPullRequest({ head }) {
      calls += 1;
      if (calls === 2) throw new Error("temporary remote failure");
      const number = head.endsWith("1") ? 1 : head.endsWith("2") ? 2 : 3;
      return { id: `pr-${number}`, url: `https://example.test/pr/${number}` };
    },
  };
  await assert.rejects(() => publishStack({ planPath: path, remote }), /temporary remote failure/);
  let partial = JSON.parse(await readFile(built.statePath));
  assert.equal(partial.status, "publish_failed"); assert.equal(partial.prs.length, 1);
  const published = await publishStack({ planPath: path, remote });
  assert.equal(published.prs.length, 3);
  partial = JSON.parse(await readFile(built.statePath));
  assert.equal(partial.status, "published"); assert.equal(partial.error, null);
});

test("intermediate stack PRs omit external completion keys", async (t) => {
  const fixture = await stackFixture(t); const { path } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath: path }); await buildStack({ planPath: path });
  const created = [];
  const remote = {
    async assertRepositoryCoordinate() {},
    async assertTargetRef() {},
    async pushBranch() {},
    async createPullRequest(value) {
      created.push(value);
      return { id: `pr-${created.length}`, url: `https://example.test/pr/${created.length}` };
    },
  };
  await publishStack({ planPath: path, remote });
  assert.equal(created.length, 3);
  for (const pullRequest of created) {
    assert.doesNotMatch(pullRequest.body, /github:|jira:|(?:^|\s)[A-Z][A-Z0-9_]*-[1-9][0-9]*/);
  }
});

test("target drift during suffix restack stops after the durable partial suffix", async (t) => {
  const fixture = await stackFixture(t); const { path } = await writePlan(fixture);
  await approveStackPlan({ actor: "user", planPath: path }); const built = await buildStack({ planPath: path });
  const state = JSON.parse(await readFile(built.statePath));
  await git(fixture.repo, "switch", state.created_layers[0].branch);
  const reviewedLines = (await readFile(join(fixture.repo, "file.txt"), "utf8")).split("\n");
  reviewedLines[1] += " review";
  await writeFile(join(fixture.repo, "file.txt"), reviewedLines.join("\n"));
  await git(fixture.repo, "add", "file.txt"); await git(fixture.repo, "commit", "-m", "review early layer");
  const changedHeadSha = await git(fixture.repo, "rev-parse", "HEAD"); await git(fixture.repo, "switch", "main");
  await approveRestack({
    actor: "user", changedHeadSha, changedLayerIndex: 0,
    newGeneration: 2, planPath: path,
  });
  let calls = 0;
  await assert.rejects(() => restackSuffix({
    beforeMutation: async () => {
      calls += 1;
      if (calls === 2) {
        await writeFile(join(fixture.repo, "target-during-restack.txt"), "moved\n");
        await git(fixture.repo, "add", "target-during-restack.txt");
        await git(fixture.repo, "commit", "-m", "move target during restack");
      }
    },
    changedHeadSha, changedLayerIndex: 0, newGeneration: 2, planPath: path,
  }), /generation is stale/);
  const partial = JSON.parse(await readFile(built.statePath));
  assert.equal(partial.restacks.at(-1).suffix.length, 1);
  assert.equal(await git(fixture.repo, "rev-parse", "source"), fixture.source);
});

async function stackFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-stack-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"); await mkdir(repo);
  await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "file.txt"), Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  await git(repo, "add", "file.txt"); await git(repo, "commit", "-m", "target");
  const target = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-c", "source");
  const lines = (await readFile(join(repo, "file.txt"), "utf8")).split("\n");
  lines[1] = "line 2 changed"; lines[20] = "line 21 changed";
  await writeFile(join(repo, "file.txt"), lines.join("\n"));
  await writeFile(join(repo, "added.txt"), "added\n");
  await writeFile(join(repo, "final.txt"), "final\n");
  await git(repo, "add", "file.txt", "added.txt", "final.txt"); await git(repo, "commit", "-m", "source");
  const source = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return { directory, repo, source, target };
}

async function writePlan(fixture) {
  const plan = {
    schema: "agent-flow.stack-plan/v1", run_id: "stack-one", generation: 1,
    repo: fixture.repo, forge_coordinate: "owner/repo",
    source: { ref: "source", sha: fixture.source },
    target: { ref: "main", sha: fixture.target }, delivery_branch: "epic/delivery",
    assembly_policy: "replay",
    layers: [
      {
        id: "foundation", branch: "stack/layer-1", title: "Foundation",
        commit_message: "feat: foundation", changes: [
          { path: "file.txt", old_path: null, change_type: "M", hunks: [0] },
        ],
      },
      {
        id: "finish", branch: "stack/layer-2", title: "Finish",
        commit_message: "feat: finish", changes: [
          { path: "file.txt", old_path: null, change_type: "M", hunks: [1] },
          { path: "added.txt", old_path: null, change_type: "A", hunks: "all" },
        ],
      },
      {
        id: "final", branch: "stack/layer-3", title: "Final",
        commit_message: "feat: final", changes: [
          { path: "final.txt", old_path: null, change_type: "A", hunks: "all" },
        ],
      },
    ],
    verification: [{ argv: ["git", "diff", "--check"] }],
    plan_fingerprint: "0".repeat(64),
    approval: { status: "proposed", actor: null, approved_at: null, plan_fingerprint: null },
  };
  plan.plan_fingerprint = stackPlanFingerprint(plan);
  const path = join(fixture.directory, "stack-plan.json");
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`);
  return { path, plan };
}

async function isAncestor(repo, ancestor, descendant) {
  try { await execFile("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

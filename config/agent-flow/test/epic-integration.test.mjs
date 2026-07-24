import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { integrateEpicFeature } from "../src/epic-integration.mjs";
import { ExternalRootAdapter } from "../src/external-progress.mjs";

const execFile = promisify(execFileCallback);

test("epic integration verifies off-ref, advances source atomically, and recovers its receipt", async (t) => {
  const fixture = await epicFixture(t);
  let failTransition = true;
  const transition = async ({ manifestPath, to }) => {
    if (failTransition) { failTransition = false; throw new Error("simulated manifest failure"); }
    const review = JSON.parse(await readFile(manifestPath));
    review.review.status = to;
    review.review.generation += 1;
    await writeFile(manifestPath, `${JSON.stringify(review, null, 2)}\n`);
  };
  await assert.rejects(() => integrateEpicFeature({
    env: fixture.env,
    epicManifestPath: fixture.epicPath,
    receiptDirectory: fixture.receipts,
    reviewManifestPath: fixture.reviewPath,
    transitionReviewRun: transition,
  }), /simulated manifest failure/);
  assert.equal(await git(fixture.repo, "rev-parse", "epic/source"), fixture.featureHead);
  const recovered = await integrateEpicFeature({
    env: fixture.env,
    epicManifestPath: fixture.epicPath,
    receiptDirectory: fixture.receipts,
    reviewManifestPath: fixture.reviewPath,
    transitionReviewRun: transition,
  });
  assert.equal(recovered.recovered, true);
  const review = JSON.parse(await readFile(fixture.reviewPath));
  assert.equal(review.review.status, "integrated");
});

test("source movement merges into a feature and requires review of the new head", async (t) => {
  const fixture = await epicFixture(t);
  await git(fixture.repo, "switch", "epic/source");
  await writeFile(join(fixture.repo, "source.txt"), "source movement\n");
  await git(fixture.repo, "add", "source.txt");
  await git(fixture.repo, "commit", "-m", "move source");
  const movedSource = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");
  const result = await integrateEpicFeature({
    env: fixture.env,
    epicManifestPath: fixture.epicPath,
    receiptDirectory: fixture.receipts,
    reviewManifestPath: fixture.reviewPath,
    transitionReviewRun: async () => { throw new Error("must not transition"); },
  });
  assert.equal(result.action, "rereview_required");
  assert.notEqual(result.reconciledHead, fixture.featureHead);
  assert.equal(await git(fixture.repo, "rev-parse", "epic/source"), movedSource);
});

test("external epic progress keeps exactly one stable comment", async () => {
  const comments = [];
  const driver = {
    async listComments() { return structuredClone(comments); },
    async createComment(_root, body) { comments.push({ id: "c1", body }); return "c1"; },
    async updateComment(_root, id, body) { comments.find((comment) => comment.id === id).body = body; },
  };
  const adapter = new ExternalRootAdapter({ github: driver });
  const progress = { run_id: "epic-one", complete: 1, running: 2, blocked: 0, review: 1 };
  assert.equal((await adapter.upsertProgress({ externalRef: "github:owner/repo#1", progress })).changed, true);
  assert.equal((await adapter.upsertProgress({ externalRef: "github:owner/repo#1", progress })).changed, false);
  progress.complete = 2;
  assert.equal((await adapter.upsertProgress({ externalRef: "github:owner/repo#1", progress })).changed, true);
  assert.equal(comments.length, 1);
});

async function epicFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-epic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  const featureWorktree = join(directory, "feature");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "base.txt");
  await git(repo, "commit", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  await git(repo, "branch", "epic/source", base);
  await execFile("git", ["-C", repo, "worktree", "add", "-b", "feature/a", featureWorktree, base]);
  await writeFile(join(featureWorktree, "feature.txt"), "feature\n");
  await git(featureWorktree, "add", "feature.txt");
  await git(featureWorktree, "commit", "-m", "feature");
  const featureHead = await git(featureWorktree, "rev-parse", "HEAD");
  const epic = {
    schema: "agent-flow.epic/v1", run_id: "epic-one", summary: "Ship an epic", repo,
    source: { base_ref: "main", base_sha: base, branch: "epic/source" },
    target: { ref: "main", sha: base }, kanban: { board: "epic-one", task: "root" },
    external_ref: "github:owner/repo#1",
    features: [{
      id: "a", summary: "Feature A", depends_on: [], acceptance: ["A exists"],
      slices: [{ id: "a", title: "Build A", verification: [{ argv: ["git", "diff", "--check"] }] }],
      verification: [{ argv: ["git", "diff", "--check"] }],
    }],
    verification: [{ argv: ["git", "diff", "--check"] }],
    limits: {
      max_feature_streams: 2, max_slice_retries: 1, max_completeness_fixes: 1,
      max_critique_fixes: 1, max_elapsed_seconds: 3600,
    },
  };
  const epicPath = join(directory, "epic.json");
  const epicBytes = `${JSON.stringify(epic, null, 2)}\n`;
  await writeFile(epicPath, epicBytes);
  const artifact = (name) => join(directory, name);
  for (const name of ["summary.md", "verification.json", "journal.md", "automated.json"]) {
    await writeFile(artifact(name), "{}\n");
  }
  const review = {
    schema: "agent-flow.local-review/v1", run_id: "epic-one.a", flow: "feature",
    summary: "Feature A", repo, worktree: featureWorktree,
    base: { branch: "epic/source", sha: base }, head: { branch: "feature/a", sha: featureHead },
    kanban: { board: "epic-one", tenant: "epic-one", task: "task-a" }, external_ref: null,
    artifacts: {
      review_summary: artifact("summary.md"), verification: artifact("verification.json"),
      journal: artifact("journal.md"), automated_findings: artifact("automated.json"), diagram: null,
    },
    automated_review: {
      status: "passed", reviewed_head_sha: featureHead, findings_path: artifact("automated.json"),
      urgency: "standard", max_comments: 20,
      per_tier_caps: { critical: 20, important: 20, recommended: 20, nit: 0 },
    },
    review: {
      status: "review_ready", session_slug: null, reviewed_head_sha: null,
      consumed_comment_ids: [], generation: 0,
      events: [],
      comment_dispositions: [], integration_receipts: [],
    },
  };
  const stateHome = join(directory, "state");
  const epicRunDirectory = join(stateHome, "agent-flow", "runs", "epic-one");
  const childRunDirectory = join(stateHome, "agent-flow", "runs", review.run_id);
  const sealedEpicPath = join(epicRunDirectory, "inputs", "epic.json");
  const reviewPath = join(childRunDirectory, "artifacts", "review.json");
  const receipts = join(epicRunDirectory, "receipts", "integration");
  await mkdir(join(epicRunDirectory, "inputs"), { recursive: true });
  await mkdir(join(childRunDirectory, "artifacts"), { recursive: true });
  await writeFile(sealedEpicPath, epicBytes);
  const { createHash } = await import("node:crypto");
  await writeFile(join(epicRunDirectory, "epic-state.json"), `${JSON.stringify({
    schema: "agent-flow.epic-state/v1", run_id: epic.run_id,
    repository: repo, epic_path: sealedEpicPath,
    epic_sha256: createHash("sha256").update(epicBytes).digest("hex"),
    run_manifest_path: join(epicRunDirectory, "run.json"), epic_root_task_id: "epic-root-task",
    source_ref: "refs/heads/epic/source", source_worktree: repo,
    recorded_target_sha: base, stack_generation: 0,
    features: { a: {
      child_run_id: review.run_id, worktree: featureWorktree, status: "review_ready",
      manifest_path: null, root_task_id: null, error: null,
    } },
    stack_checkpoints: [],
  }, null, 2)}\n`);
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  return { base, directory, env: { XDG_STATE_HOME: stateHome }, epicPath, featureHead, receipts, repo, reviewPath };
}

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

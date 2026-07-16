import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  assembleNextDeliveryLayer,
  approveCompletionCheckpoint,
  initializeDelivery,
  observeCompletionMerge,
  openCompletionPullRequest,
  reconcileOpenCompletion,
  verifyDelivery,
} from "../src/delivery-operations.mjs";
import {
  approveStackPlan,
  buildStack,
  registerLayerReview,
  stackPlanFingerprint,
} from "../src/stack-operations.mjs";

const execFile = promisify(execFileCallback);

test("delivery replays only reviewed layers, proves exact tree, and completes only after merge observation", async (t) => {
  const fixture = await deliveryFixture(t);
  const remote = fakeRemote({ safe: true });
  await assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath, remote,
    reviewManifestPath: fixture.reviews[0],
  });
  assert.equal(remote.retargets.length, 1);
  await assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath, remote,
    reviewManifestPath: fixture.reviews[1],
  });
  const verification = await verifyDelivery({ deliveryPath: fixture.deliveryPath });
  assert.equal(verification.passed, true);
  const completion = await openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote });
  assert.equal(completion.status, "ready");
  assert.match(remote.created.at(-1).body, /github:owner\/repo#1/);
  const statePath = `${fixture.deliveryPath}.state.json`;
  const state = JSON.parse(await readFile(statePath));
  const deliveryTree = await git(fixture.repo, "rev-parse", `${state.delivery_head_sha}^{tree}`);
  const mergeCommit = await git(
    fixture.repo, "commit-tree", deliveryTree, "-p", fixture.target,
    "-p", state.delivery_head_sha, "-m", "completion merge",
  );
  await git(fixture.repo, "update-ref", "refs/heads/main", mergeCommit, fixture.target);
  remote.observed = {
    merged: true, merge_commit_sha: mergeCommit,
    base_ref: "main", head_ref: "epic/delivery", head_sha: state.delivery_head_sha,
  };
  let done = 0;
  const observed = await observeCompletionMerge({
    completionAdapter: { async markDone() { done += 1; } },
    deliveryPath: fixture.deliveryPath,
    remote,
  });
  assert.equal(observed.action, "complete");
  assert.equal(done, 1);
});

test("target drift between layer assemblies makes delivery stale without implicit update", async (t) => {
  const fixture = await deliveryFixture(t);
  const remote = fakeRemote({ safe: true });
  await assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath, remote,
    reviewManifestPath: fixture.reviews[0],
  });
  const firstState = JSON.parse(await readFile(`${fixture.deliveryPath}.state.json`));
  await writeFile(join(fixture.repo, "target-drift.txt"), "drift\n");
  await git(fixture.repo, "add", "target-drift.txt"); await git(fixture.repo, "commit", "-m", "target drift");
  await assert.rejects(() => assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath, remote,
    reviewManifestPath: fixture.reviews[1],
  }), /source refresh/);
  const stale = JSON.parse(await readFile(`${fixture.deliveryPath}.state.json`));
  assert.equal(stale.status, "stale");
  assert.equal(stale.delivery_head_sha, firstState.delivery_head_sha);
});

test("unsafe repository policy keeps the completion PR at an explicit draft checkpoint", async (t) => {
  const fixture = await deliveryFixture(t);
  const remote = fakeRemote({ safe: false });
  await assembleNextDeliveryLayer({ deliveryPath: fixture.deliveryPath, remote, reviewManifestPath: fixture.reviews[0] });
  await assembleNextDeliveryLayer({ deliveryPath: fixture.deliveryPath, remote, reviewManifestPath: fixture.reviews[1] });
  await verifyDelivery({ deliveryPath: fixture.deliveryPath });
  const completion = await openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote });
  assert.equal(completion.status, "merge_checkpoint_required");
  assert.equal(remote.created[0].draft, true);
  const approved = await approveCompletionCheckpoint({
    actor: "user", deliveryPath: fixture.deliveryPath,
    reason: "repository cannot enforce current-base checks", remote,
  });
  assert.equal(approved.status, "ready");
  assert.equal(remote.ready.length, 1);
});

test("completion PR creation is idempotent for one verified delivery generation", async (t) => {
  const fixture = await deliveryFixture(t);
  await assembleAll(fixture);
  await verifyDelivery({ deliveryPath: fixture.deliveryPath });
  const remote = fakeRemote({ safe: true });
  const first = await openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote });
  const second = await openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote });
  assert.deepEqual(second, first);
  assert.equal(remote.created.length, 1);
});

test("schema-valid verified state cannot bypass delivery reconstruction", async (t) => {
  const fixture = await deliveryFixture(t);
  const statePath = `${fixture.deliveryPath}.state.json`;
  const state = JSON.parse(await readFile(statePath));
  state.status = "completion_open";
  state.verification = { passed: true, delivery_tree: fixture.target, source_tree: fixture.source, results: [] };
  state.completion_pr = {
    id: "forged-pr", url: "https://example.test/pr/forged",
    target_sha: fixture.target, delivery_head_sha: fixture.source, status: "ready",
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(
    openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote: fakeRemote({ safe: true }) }),
    /does not contain every settled layer/,
  );
});

test("delivery initialization resumes without erasing durable assembly progress", async (t) => {
  const fixture = await deliveryFixture(t);
  const remote = fakeRemote({ safe: true });
  await assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath, remote,
    reviewManifestPath: fixture.reviews[0],
  });
  const result = await initializeDelivery({
    deliveryPath: fixture.deliveryPath, externalRef: "github:owner/repo#1",
    repositoryPolicy: { require_current_base: true, required_checks: ["tests"], allow_explicit_checkpoint: true },
    stackPlanPath: fixture.planPath, stackStatePath: fixture.stackStatePath,
  });
  assert.equal(result.resumed, true);
  const state = JSON.parse(await readFile(`${fixture.deliveryPath}.state.json`));
  assert.equal(state.applied_layers.length, 1);
});

test("a failed retarget preserves the applied layer and a durable failure receipt", async (t) => {
  const fixture = await deliveryFixture(t);
  const remote = fakeRemote({ safe: true });
  remote.retargetPullRequest = async () => { throw new Error("retarget unavailable"); };
  await assert.rejects(() => assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath, remote,
    reviewManifestPath: fixture.reviews[0],
  }), /retarget unavailable/);
  const state = JSON.parse(await readFile(`${fixture.deliveryPath}.state.json`));
  assert.equal(state.status, "assembly_failed");
  assert.equal(state.applied_layers.length, 1);
});

test("a stale layer review cannot enter delivery", async (t) => {
  const fixture = await deliveryFixture(t);
  const review = JSON.parse(await readFile(fixture.reviews[0]));
  review.head.sha = fixture.target;
  review.review.reviewed_head_sha = fixture.target;
  review.automated_review.reviewed_head_sha = fixture.target;
  for (const event of review.review.events) event.head_sha = fixture.target;
  await writeFile(fixture.reviews[0], `${JSON.stringify(review, null, 2)}\n`);
  await assert.rejects(() => assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath,
    reviewManifestPath: fixture.reviews[0],
  }), /review authority changed|canonical review manifest changed|not approved at its recorded head/);
});

test("source movement makes delivery stale and never updates it implicitly", async (t) => {
  const fixture = await deliveryFixture(t);
  await git(fixture.repo, "switch", "source");
  await writeFile(join(fixture.repo, "source-drift.txt"), "drift\n");
  await git(fixture.repo, "add", "source-drift.txt"); await git(fixture.repo, "commit", "-m", "source drift");
  await git(fixture.repo, "switch", "main");
  await assert.rejects(() => assembleNextDeliveryLayer({
    deliveryPath: fixture.deliveryPath,
    reviewManifestPath: fixture.reviews[0],
  }), /source moved/);
  const state = JSON.parse(await readFile(`${fixture.deliveryPath}.state.json`));
  assert.equal(state.status, "stale");
  assert.equal(state.delivery_head_sha, null);
});

test("target movement before delivery initialization rejects the generation", async (t) => {
  await assert.rejects(() => deliveryFixture(t, {
    beforeInitialize: async ({ repo }) => {
      await writeFile(join(repo, "early-target-drift.txt"), "drift\n");
      await git(repo, "add", "early-target-drift.txt"); await git(repo, "commit", "-m", "early target drift");
    },
  }), /moved before delivery initialization/);
});

test("exact tree equality rejects equal-size but different delivery content", async (t) => {
  const fixture = await deliveryFixture(t);
  await assembleAll(fixture);
  await git(fixture.repo, "switch", "epic/delivery");
  await writeFile(join(fixture.repo, "one.txt"), "eno\n");
  await git(fixture.repo, "add", "one.txt"); await git(fixture.repo, "commit", "-m", "alter equal-size content");
  const altered = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");
  const statePath = `${fixture.deliveryPath}.state.json`;
  const state = JSON.parse(await readFile(statePath)); state.delivery_head_sha = altered;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(() => verifyDelivery({ deliveryPath: fixture.deliveryPath }), /does not exactly equal/);
  const failed = JSON.parse(await readFile(statePath));
  assert.equal(failed.status, "verification_failed");
});

test("failed full verification is recorded and blocks completion", async (t) => {
  const fixture = await deliveryFixture(t, { verification: [{ argv: ["sh", "-c", "exit 7"] }] });
  await assembleAll(fixture);
  await assert.rejects(() => verifyDelivery({ deliveryPath: fixture.deliveryPath }), /verification failed/);
  const state = JSON.parse(await readFile(`${fixture.deliveryPath}.state.json`));
  assert.equal(state.verification.passed, false);
  assert.equal(state.verification.results[0].exit_code, 7);
  await assert.rejects(() => openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote: fakeRemote({ safe: true }) }), /gates must pass/);
});

test("an open completion becomes non-completing when its target advances", async (t) => {
  const fixture = await deliveryFixture(t);
  const remote = fakeRemote({ safe: true });
  await assembleNextDeliveryLayer({ deliveryPath: fixture.deliveryPath, remote, reviewManifestPath: fixture.reviews[0] });
  await assembleNextDeliveryLayer({ deliveryPath: fixture.deliveryPath, remote, reviewManifestPath: fixture.reviews[1] });
  await verifyDelivery({ deliveryPath: fixture.deliveryPath });
  await openCompletionPullRequest({ deliveryPath: fixture.deliveryPath, remote });
  await writeFile(join(fixture.repo, "advance.txt"), "advance\n");
  await git(fixture.repo, "add", "advance.txt"); await git(fixture.repo, "commit", "-m", "advance target");
  const result = await reconcileOpenCompletion({ deliveryPath: fixture.deliveryPath, remote });
  assert.equal(result.action, "source_refresh_required");
  assert.equal(remote.drafts.length, 1);
});

async function deliveryFixture(t, { beforeInitialize = null, verification = [{ argv: ["git", "diff", "--check"] }] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-delivery-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"); await mkdir(repo);
  await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n"); await git(repo, "add", "base.txt"); await git(repo, "commit", "-m", "base");
  const target = await git(repo, "rev-parse", "HEAD"); await git(repo, "switch", "-c", "source");
  await writeFile(join(repo, "one.txt"), "one\n"); await git(repo, "add", "one.txt"); await git(repo, "commit", "-m", "one");
  await writeFile(join(repo, "two.txt"), "two\n"); await git(repo, "add", "two.txt"); await git(repo, "commit", "-m", "two");
  const source = await git(repo, "rev-parse", "HEAD"); await git(repo, "switch", "main");
  const plan = {
    schema: "agent-flow.stack-plan/v1", run_id: "delivery-one", generation: 1, repo,
    forge_coordinate: "owner/repo",
    source: { ref: "source", sha: source }, target: { ref: "main", sha: target },
    delivery_branch: "epic/delivery", assembly_policy: "replay",
    layers: [
      { id: "one", branch: "stack/one", title: "One", commit_message: "feat: one", changes: [{ path: "one.txt", old_path: null, change_type: "A", hunks: "all" }] },
      { id: "two", branch: "stack/two", title: "Two", commit_message: "feat: two", changes: [{ path: "two.txt", old_path: null, change_type: "A", hunks: "all" }] },
    ],
    verification,
    plan_fingerprint: "0".repeat(64),
    approval: { status: "proposed", actor: null, approved_at: null, plan_fingerprint: null },
  };
  plan.plan_fingerprint = stackPlanFingerprint(plan);
  const planPath = join(directory, "stack.json"); await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await approveStackPlan({ actor: "user", planPath }); const built = await buildStack({ planPath });
  const stack = JSON.parse(await readFile(built.statePath));
  stack.status = "published";
  stack.prs = stack.created_layers.map((layer, index) => ({
    layer_id: layer.id, id: `stack-pr-${index + 1}`, branch: layer.branch,
    base: index ? stack.created_layers[index - 1].branch : "epic/delivery",
    url: `https://example.test/pr/${index + 1}`, status: "created",
  }));
  await writeFile(built.statePath, `${JSON.stringify(stack, null, 2)}\n`);
  const reviews = [];
  const registryPath = join(directory, "tuicr-reviews.jsonl");
  for (const [index, layer] of stack.created_layers.entries()) {
    const path = join(directory, `review-${index}.json`); await writeReview({ directory, layer, path, repo }); reviews.push(path);
    const prior = index === 0 ? "" : await readFile(registryPath, "utf8");
    await writeFile(registryPath, `${prior}${JSON.stringify({ kind: "manifest", manifest: path })}\n`);
    await registerLayerReview({
      env: { TUICR_REVIEWS_FILE: registryPath },
      layerId: layer.id,
      planPath,
      reviewManifestPath: path,
      statePath: built.statePath,
    });
  }
  const deliveryPath = join(directory, "delivery.json");
  if (beforeInitialize) await beforeInitialize({ directory, repo });
  await initializeDelivery({
    deliveryPath, externalRef: "github:owner/repo#1",
    repositoryPolicy: { require_current_base: true, required_checks: ["tests"], allow_explicit_checkpoint: true },
    stackPlanPath: planPath, stackStatePath: built.statePath,
  });
  return { deliveryPath, directory, planPath, repo, reviews, source, stackStatePath: built.statePath, target };
}

async function assembleAll(fixture) {
  const remote = fakeRemote({ safe: true });
  for (const reviewManifestPath of fixture.reviews) {
    await assembleNextDeliveryLayer({ deliveryPath: fixture.deliveryPath, remote, reviewManifestPath });
  }
}

async function writeReview({ directory, layer, path, repo }) {
  const artifact = (name) => join(directory, `${layer.id}-${name}`);
  for (const name of ["summary", "verification", "journal", "automated"]) await writeFile(artifact(name), "{}\n");
  const evidenceSha = createHash("sha256").update("{}\n").digest("hex");
  const events = [
    { kind: "transition", generation: 1, prior_generation: 0, actor: "user", recorded_at: "2026-07-15T00:00:00Z", head_sha: layer.head_sha, reason: "start review", evidence: { path: artifact("summary"), sha256: evidenceSha }, from: "review_ready", to: "reviewing", comment_ids: [], integration_receipt: null },
    { kind: "transition", generation: 2, prior_generation: 1, actor: "user", recorded_at: "2026-07-15T00:01:00Z", head_sha: layer.head_sha, reason: "approve", evidence: { path: artifact("automated"), sha256: evidenceSha }, from: "reviewing", to: "approved", comment_ids: [], integration_receipt: null },
  ];
  const review = {
    schema: "agent-flow.local-review/v1", run_id: `review-${layer.id}`, flow: "feature", summary: layer.id,
    repo, worktree: repo, base: { branch: "main", sha: layer.parent_sha }, head: { branch: layer.branch, sha: layer.head_sha },
    kanban: { board: "delivery", tenant: `review-${layer.id}`, task: `task-${layer.id}` }, external_ref: null,
    artifacts: { review_summary: artifact("summary"), verification: artifact("verification"), journal: artifact("journal"), automated_findings: artifact("automated"), diagram: null },
    automated_review: { status: "passed", reviewed_head_sha: layer.head_sha, findings_path: artifact("automated"), urgency: "standard", max_comments: 20, per_tier_caps: { critical: 20, important: 20, recommended: 20, nit: 0 } },
    review: { status: "approved", session_slug: `layer-${layer.id}`, reviewed_head_sha: layer.head_sha, consumed_comment_ids: [], generation: 2, events, comment_dispositions: [], integration_receipts: [] },
  };
  await writeFile(path, `${JSON.stringify(review, null, 2)}\n`);
}

function fakeRemote({ safe }) {
  return {
    created: [], drafts: [], ready: [], retargets: [], observed: {
      merged: false, merge_commit_sha: null, base_ref: "main",
      head_ref: "epic/delivery", head_sha: null,
    },
    async assertRepositoryCoordinate() {},
    async assertTargetRef() {},
    async pushBranch(value) { this.pushed = value; },
    async retargetPullRequest(value) { this.retargets.push(value); },
    async getRepositoryPolicy() { return { current_base_enforced: safe, required_checks: safe ? ["tests"] : [] }; },
    async createPullRequest(value) { this.created.push(value); return { id: "completion-1", url: "https://example.test/completion/1" }; },
    async markDraft(value) { this.drafts.push(value); },
    async markReady(value) { this.ready.push(value); },
    async getPullRequest() {
      if (this.observed.head_sha === null && this.created.length > 0) {
        this.observed.head_sha = this.pushed?.expectedSha ?? null;
      }
      return this.observed;
    },
  };
}

async function git(cwd, ...args) { return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim(); }

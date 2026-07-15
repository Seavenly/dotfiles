import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  chmod,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runCli } from "../src/cli-command.mjs";
import {
  inspectReviewRepository,
  materializationOrder,
} from "../src/review-launch.mjs";
import { validateContract } from "../src/schema-validator.mjs";

const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const PROFILE_SHA = "a".repeat(64);
const execFileAsync = promisify(execFile);

function captureStream() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    value: () => value,
  };
}

function healthyDoctor() {
  const names = ["flow-controller", "analyst", "artifact", "critic", "gate"];
  return {
    ok: true,
    profileSetFingerprint: `sha256:${PROFILE_SHA}`,
    checks: [],
    profiles: names.map((name) => ({
      name,
      available: true,
      configurationFingerprint: `sha256:${PROFILE_SHA}`,
    })),
  };
}

class FakeHermesAdapter {
  constructor({ createDelayMs = 0, failAfterCreates = null } = {}) {
    this.createDelayMs = createDelayMs;
    this.failAfterCreates = failAfterCreates;
    this.tasks = new Map();
    this.idsByKey = new Map();
    this.events = [];
    this.nextId = 1;
  }

  async createTask(spec) {
    if (this.createDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    }
    if (this.failAfterCreates === 0) throw new Error("injected materialization failure");
    if (this.failAfterCreates !== null) this.failAfterCreates -= 1;
    const priorId = this.idsByKey.get(spec.idempotencyKey);
    if (priorId) return structuredClone(this.tasks.get(priorId));
    const id = `t_${this.nextId++}`;
    const status = spec.initialStatus === "blocked"
      ? "blocked"
      : spec.parents.length === 0
        ? "ready"
        : "todo";
    const task = {
      id,
      title: spec.title,
      body: spec.body,
      assignee: spec.assignee,
      status,
      tenant: spec.tenant,
      workspace_kind: spec.workspace.kind,
      workspace_path: spec.workspace.path,
      max_retries: spec.maxAttempts,
      parents: [...spec.parents],
    };
    this.tasks.set(id, task);
    this.idsByKey.set(spec.idempotencyKey, id);
    this.events.push({ type: "create", id, spec: structuredClone(spec) });
    return structuredClone(task);
  }

  async linkTasks({ parentId, childId }) {
    const child = this.tasks.get(childId);
    if (!child.parents.includes(parentId)) child.parents.push(parentId);
    this.events.push({ type: "link", parentId, childId });
  }

  async getTask({ taskId }) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return structuredClone(task);
  }

  async releaseTask({ taskId, reason }) {
    const task = this.tasks.get(taskId);
    assert.equal(task.status, "blocked");
    task.status = task.parents.length === 0 ? "ready" : "todo";
    this.events.push({ type: "release", taskId, reason });
  }

  async blockTask({ taskId, reason }) {
    const task = this.tasks.get(taskId);
    task.status = "blocked";
    this.events.push({ type: "block", taskId, reason });
  }

  async commentTask({ taskId, body }) {
    this.events.push({ type: "comment", taskId, body });
  }
}

test("launch review seals a hotfix run before safely materializing its graph", async (t) => {
  const fixture = await reviewFixture(t);
  const adapter = new FakeHermesAdapter();
  const stdout = captureStream();
  const stderr = captureStream();
  let firstCreateObserved = false;
  const createTask = adapter.createTask.bind(adapter);
  adapter.createTask = async (spec) => {
    if (!firstCreateObserved) {
      firstCreateObserved = true;
      const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
      assert.deepEqual(await validateContract(run), { valid: true, errors: [] });
    }
    return createTask(spec);
  };

  const exitCode = await launch(fixture, adapter, { stdout, stderr });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(
    stdout.value(),
    `ok - review launch ${fixture.review.run_id} materialized 10 cards\n` +
      `run: ${fixture.runManifestPath}\n` +
      "root: t_1\n",
  );
  assert.equal(adapter.tasks.size, 10);
  assert.deepEqual(
    [...adapter.tasks.values()].map(({ title }) => title),
    [
      "review-root",
      "lens:correctness",
      "lens:security",
      "lens:tests",
      "validate-handoff:lens:correctness",
      "validate-handoff:lens:security",
      "validate-handoff:lens:tests",
      "critic",
      "validate-handoff:critic",
      "finalize",
    ].map((stage) => `[${fixture.review.run_id}/${stage}]`),
  );
  const root = adapter.tasks.get("t_1");
  assert.equal(root.status, "todo");
  assert.deepEqual(root.parents, ["t_10"]);
  assert.equal(adapter.events.at(-1).type, "release");
  assert.equal(
    adapter.events.find(({ type }) => type === "create").spec.initialStatus,
    "blocked",
  );
  for (const task of adapter.tasks.values()) {
    const authority = JSON.parse(
      task.body.match(/<!-- agent-flow-authority\n([\s\S]*?)\n-->/)[1],
    );
    assert.deepEqual(await validateContract(authority), {
      valid: true,
      errors: [],
    });
  }

  const runBytes = await readFile(fixture.runManifestPath);
  const run = JSON.parse(runBytes);
  assert.equal(run.identity.run_id, fixture.review.run_id);
  assert.equal(run.identity.tenant, fixture.review.run_id);
  assert.equal(run.identity.board, fixture.review.kanban.board);
  assert.equal(run.revisions.base, fixture.review.base.sha);
  assert.equal(run.revisions.source, fixture.review.head.sha);
  assert.deepEqual(run.profiles.required, [
    "analyst",
    "critic",
    "flow-controller",
    "gate",
  ]);
  assert.equal(run.inputs.some(({ kind }) => kind === "review-manifest"), true);
  assert.equal(run.inputs.filter(({ kind }) => kind === "gate").length, 5);
  assert.equal(run.inputs.filter(({ kind }) => kind === "skill").length, 5);
  assert.equal(run.inputs.filter(({ kind }) => kind === "role-contract").length, 4);
  assert.equal(
    run.implementation.content_set_fingerprint,
    aggregateFingerprint(run.graph, run.inputs),
  );
  const correctnessGate = JSON.parse(
    await readFile(
      run.inputs.find(({ kind, name }) =>
        kind === "gate" && name === "validate-handoff:lens:correctness.json"
      ).sealed_path,
    ),
  );
  assert.equal(correctnessGate.handoff_validation.require_passed, false);
  const critic = [...adapter.tasks.values()].find(({ title }) =>
    title.endsWith("/critic]")
  );
  assert.match(critic.body, /inputs\/candidate\.patch/);
  assert.match(critic.body, /inputs\/review\.json/);
  assert.match(
    critic.body,
    /Outputs: metadata\.handoff\.artifacts\[0\]\.inline \(review-comments\)/,
  );
  assert.doesNotMatch(critic.body, /artifacts\/review\/comments\.json/);
  const correctness = [...adapter.tasks.values()].find(({ title }) =>
    title.endsWith("/lens:correctness]")
  );
  assert.match(
    correctness.body,
    /Outputs: metadata\.handoff\.artifacts\[0\]\.inline \(review-findings\)/,
  );
  assert.doesNotMatch(correctness.body, /artifacts\/lenses/);
  const correctnessValidator = [...adapter.tasks.values()].find(({ title }) =>
    title.endsWith("/validate-handoff:lens:correctness]")
  );
  assert.doesNotMatch(correctnessValidator.body, /artifacts\/lenses/);
  assert.equal(
    adapter.events.every((event, index) =>
      event.type !== "release" || index === adapter.events.length - 1),
    true,
  );
  const materialization = JSON.parse(
    await readFile(join(run.identity.run_directory, "materialization.json")),
  );
  assert.deepEqual(Object.keys(materialization.tasks), [
    "review-root",
    "lens:correctness",
    "lens:security",
    "lens:tests",
    "validate-handoff:lens:correctness",
    "validate-handoff:lens:security",
    "validate-handoff:lens:tests",
    "critic",
    "validate-handoff:critic",
    "finalize",
  ]);
});

test("launch review materializes fast optional lenses and supplements", async (t) => {
  const fixture = await reviewFixture(
    t,
    "review-launch-fast",
    { urgency: "fast" },
  );
  const adapter = new FakeHermesAdapter();
  const stderr = captureStream();

  assert.equal(
    await launch(fixture, adapter, { stderr }),
    0,
    stderr.value(),
  );
  assert.equal(adapter.tasks.size, 18);

  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  assert.deepEqual(run.profiles.required, [
    "analyst",
    "artifact",
    "critic",
    "flow-controller",
    "gate",
  ]);
  assert.equal(run.inputs.filter(({ kind }) => kind === "gate").length, 9);
  assert.equal(run.inputs.filter(({ kind }) => kind === "skill").length, 7);
  assert.equal(run.inputs.filter(({ kind }) => kind === "role-contract").length, 5);

  const finalizeGate = JSON.parse(await readFile(
    run.inputs.find(({ kind, name }) =>
      kind === "gate" && name === "finalize.json"
    ).sealed_path,
  ));
  assert.equal(finalizeGate.review_policy.urgency, "fast");
  assert.equal(finalizeGate.review_policy.minimum_tier, "important");
  assert.deepEqual(
    finalizeGate.review_finalize.supplements.map(({ kind }) => kind),
    ["diagram", "lens:observability", "lens:style", "orientation"],
  );
  assert.equal(finalizeGate.inputs.length, 5);

  const critic = taskForStage(adapter, "critic");
  assert.deepEqual(
    critic.parents.map((id) => adapter.tasks.get(id).title).sort(),
    [
      "validate-handoff:lens:correctness",
      "validate-handoff:lens:security",
      "validate-handoff:lens:tests",
    ].map((stage) => `[${fixture.review.run_id}/${stage}]`).sort(),
  );
  const finalize = taskForStage(adapter, "finalize");
  assert.deepEqual(
    finalize.parents.map((id) => adapter.tasks.get(id).title).sort(),
    [
      "validate-handoff:critic",
      "validate-handoff:diagram",
      "validate-handoff:lens:observability",
      "validate-handoff:lens:style",
      "validate-handoff:orientation",
    ].map((stage) => `[${fixture.review.run_id}/${stage}]`).sort(),
  );
  assert.match(
    taskForStage(adapter, "orientation").body,
    /metadata\.handoff\.artifacts\[0\]\.inline \(review-orientation\)/,
  );
  assert.match(
    taskForStage(adapter, "diagram").body,
    /metadata\.handoff\.artifacts\[0\]\.inline \(review-diagram\)/,
  );
  const taskIds = [...adapter.tasks.keys()];
  assert.equal(await launch(fixture, adapter), 0);
  assert.deepEqual([...adapter.tasks.keys()], taskIds);
});

test("launch review seals the standard urgency floor", async (t) => {
  const fixture = await reviewFixture(
    t,
    "review-launch-standard",
    { urgency: "standard" },
  );
  const adapter = new FakeHermesAdapter();
  const stderr = captureStream();

  assert.equal(
    await launch(fixture, adapter, { stderr }),
    0,
    stderr.value(),
  );
  assert.equal(adapter.tasks.size, 18);

  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  const finalizeGate = JSON.parse(await readFile(
    run.inputs.find(({ kind, name }) =>
      kind === "gate" && name === "finalize.json"
    ).sealed_path,
  ));
  assert.equal(finalizeGate.review_policy.urgency, "standard");
  assert.equal(finalizeGate.review_policy.minimum_tier, "nit");
  assert.deepEqual(
    finalizeGate.review_policy.per_tier_caps,
    fixture.review.automated_review.per_tier_caps,
  );
});

test("duplicate and interrupted review launches converge without releasing an incomplete root", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-recovery");
  const adapter = new FakeHermesAdapter({ failAfterCreates: 4 });
  const firstStderr = captureStream();

  assert.equal(
    await launch(fixture, adapter, { stderr: firstStderr }),
    1,
  );
  assert.match(firstStderr.value(), /injected materialization failure/);
  assert.equal(adapter.tasks.get("t_1").status, "blocked");
  assert.equal(adapter.events.some(({ type }) => type === "release"), false);

  adapter.failAfterCreates = null;
  const secondStdout = captureStream();
  assert.equal(await launch(fixture, adapter, { stdout: secondStdout }), 0);
  assert.equal(adapter.tasks.size, 10);
  assert.equal(adapter.tasks.get("t_1").status, "todo");
  const ids = [...adapter.tasks.keys()];

  assert.equal(await launch(fixture, adapter), 0);
  assert.deepEqual([...adapter.tasks.keys()], ids);
  assert.equal(
    adapter.events.filter(({ type }) => type === "release").length,
    1,
  );

  const relocatedManifest = join(fixture.directory, "relocated-review.json");
  await writeFile(relocatedManifest, await readFile(fixture.manifestPath));
  assert.equal(
    await launch({ ...fixture, manifestPath: relocatedManifest }, adapter),
    0,
  );
  assert.deepEqual([...adapter.tasks.keys()], ids);

  const changedReview = structuredClone(fixture.review);
  changedReview.summary = "Changed after the run was sealed";
  await writeFile(relocatedManifest, `${JSON.stringify(changedReview, null, 2)}\n`);
  const changedStderr = captureStream();
  assert.equal(
    await launch(
      { ...fixture, manifestPath: relocatedManifest },
      adapter,
      { stderr: changedStderr },
    ),
    1,
  );
  assert.match(changedStderr.value(), /different review input/);
  assert.equal(adapter.tasks.get("t_1").status, "blocked");
  assert.equal(adapter.events.at(-1).type, "block");
});

test("launch review rejects unhealthy required profiles before any mutation", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-profile-failure");
  const adapter = new FakeHermesAdapter();
  const stderr = captureStream();
  const report = healthyDoctor();
  report.ok = false;
  report.profiles.find(({ name }) => name === "critic").available = false;

  assert.equal(
    await runCli(["launch", "review", "--manifest", fixture.manifestPath], {
      adapter,
      env: fixture.env,
      inspectRepository: async () => ({
        repositoryPath: fixture.repository,
        headSha: fixture.review.head.sha,
        diffBytes: Buffer.from("diff --git a/example b/example\n"),
      }),
      implementationRevision: GIT_SHA,
      now: () => new Date("2026-07-15T12:00:00Z"),
      runDoctor: async () => report,
      stdout: captureStream().stream,
      stderr: stderr.stream,
    }),
    1,
  );
  assert.match(stderr.value(), /required Hermes profiles are unhealthy/);
  assert.equal(adapter.tasks.size, 0);
  await assert.rejects(readFile(fixture.runManifestPath), { code: "ENOENT" });
});

test("fast review requires the artifact profile before mutation", async (t) => {
  const fixture = await reviewFixture(
    t,
    "review-launch-artifact-profile-failure",
    { urgency: "fast" },
  );
  const adapter = new FakeHermesAdapter();
  const report = healthyDoctor();
  report.profiles.find(({ name }) => name === "artifact").available = false;
  const stderr = captureStream();

  assert.equal(
    await runCli(["launch", "review", "--manifest", fixture.manifestPath], {
      adapter,
      env: fixture.env,
      inspectRepository: async () => ({
        repositoryPath: fixture.repository,
        headSha: fixture.review.head.sha,
        diffBytes: Buffer.from("diff --git a/example b/example\n"),
      }),
      implementationRevision: GIT_SHA,
      now: () => new Date("2026-07-15T12:00:00Z"),
      runDoctor: async () => report,
      stdout: captureStream().stream,
      stderr: stderr.stream,
    }),
    1,
  );
  assert.match(stderr.value(), /required Hermes profiles are unhealthy: artifact/);
  assert.equal(adapter.tasks.size, 0);
  await assert.rejects(readFile(fixture.runManifestPath), { code: "ENOENT" });
});

test("concurrent review launches serialize native Hermes materialization", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-concurrent");
  const adapter = new FakeHermesAdapter({ createDelayMs: 10 });
  const errors = [captureStream(), captureStream()];

  const results = await Promise.all([
    launch(fixture, adapter, { stderr: errors[0] }),
    launch(fixture, adapter, { stderr: errors[1] }),
  ]);

  assert.equal(results.includes(0), true);
  assert.equal(adapter.tasks.size, 10);
  if (results.includes(1)) {
    assert.match(
      errors.find((stream) => stream.value()).value(),
      /another launcher is active/,
    );
  } else {
    assert.deepEqual(results, [0, 0]);
  }
});

test("resume rejects a self-consistent invalid sealed graph", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-invalid-graph");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const run = JSON.parse(await readFile(fixture.runManifestPath));
  const graph = JSON.parse(await readFile(run.graph.sealed_path));
  graph.dependencies = graph.dependencies.filter(({ child }) => child !== "review-root");
  const graphBytes = Buffer.from(`${JSON.stringify(graph, null, 2)}\n`);
  await chmod(run.graph.sealed_path, 0o600);
  await writeFile(run.graph.sealed_path, graphBytes);
  run.graph.sha256 = createHash("sha256").update(graphBytes).digest("hex");
  run.implementation.content_set_fingerprint = aggregateFingerprint(
    run.graph,
    run.inputs,
  );
  await chmod(fixture.runManifestPath, 0o600);
  await writeFile(fixture.runManifestPath, `${JSON.stringify(run, null, 2)}\n`);
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);
  assert.match(stderr.value(), /existing review graph is invalid/);
  assert.equal(adapter.tasks.get("t_1").status, "blocked");
});

test("resume requires the exact generated gate set", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-missing-gate");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const run = JSON.parse(await readFile(fixture.runManifestPath));
  run.inputs = run.inputs.filter(({ kind, name }) =>
    kind !== "gate" || name !== "finalize.json"
  );
  run.implementation.content_set_fingerprint = aggregateFingerprint(
    run.graph,
    run.inputs,
  );
  await chmod(fixture.runManifestPath, 0o600);
  await writeFile(fixture.runManifestPath, `${JSON.stringify(run, null, 2)}\n`);
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);
  assert.match(stderr.value(), /exact generated gate set/);
  assert.equal(adapter.tasks.get("t_1").status, "blocked");
});

test("stale launch locks fail with explicit recovery instead of racing reclamation", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-stale-lock");
  const lockPath = `${join(
    fixture.env.XDG_STATE_HOME,
    "agent-flow",
    "runs",
    fixture.review.run_id,
  )}.launch.lock`;
  await mkdir(join(fixture.env.XDG_STATE_HOME, "agent-flow", "runs"), {
    recursive: true,
  });
  await writeFile(lockPath, `${JSON.stringify({ pid: 999999, token: "stale" })}\n`);
  const adapter = new FakeHermesAdapter();
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);
  assert.match(stderr.value(), /stale launch lock/);
  assert.match(stderr.value(), /remove .*\.launch\.lock/);
  assert.equal(adapter.tasks.size, 0);
});

test("local review run IDs cannot select a filesystem path", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-safe-id");
  const review = structuredClone(fixture.review);
  review.run_id = "review/../../escape";

  const validation = await validateContract(review);

  assert.equal(validation.valid, false);
  assert.equal(
    validation.errors.some(({ instancePath }) => instancePath === "/run_id"),
    true,
  );
});

test("materialization order is root-first and topological regardless of graph declaration order", async () => {
  const graph = JSON.parse(
    await readFile(new URL("../graphs/local-review.v1.json", import.meta.url)),
  );
  graph.stages.reverse();

  const ordered = materializationOrder(graph);
  const positions = new Map(ordered.map(({ key }, index) => [key, index]));

  assert.equal(ordered[0].key, graph.root);
  for (const { parent, child } of graph.dependencies) {
    if (child === graph.root) continue;
    if (!positions.has(parent) || !positions.has(child)) continue;
    assert.equal(positions.get(parent) < positions.get(child), true);
  }
});

test("review repository inspection pins the declared commits and candidate diff", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-review-repo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", directory]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Test User"]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await writeFile(join(directory, "example.txt"), "base\n");
  await execFileAsync("git", ["-C", directory, "add", "example.txt"]);
  await execFileAsync("git", ["-C", directory, "commit", "-q", "-m", "base"]);
  const base = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], {
    encoding: "utf8",
  })).stdout.trim();
  await writeFile(join(directory, "example.txt"), "base\nhead\n");
  await execFileAsync("git", ["-C", directory, "commit", "-qam", "head"]);
  const head = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], {
    encoding: "utf8",
  })).stdout.trim();

  const inspection = await inspectReviewRepository({
    repo: directory,
    worktree: directory,
    base: { sha: base },
    head: { sha: head },
  });

  assert.equal(inspection.repositoryPath, await realpath(directory));
  assert.equal(inspection.worktreePath, await realpath(directory));
  assert.equal(inspection.headSha, head);
  assert.match(inspection.diffBytes.toString("utf8"), /\+head/);

  await writeFile(join(directory, "example.txt"), "base\nhead\ndirty\n");
  await assert.rejects(
    inspectReviewRepository({
      repo: directory,
      worktree: directory,
      base: { sha: base },
      head: { sha: head },
    }),
    /candidate worktree must be clean/,
  );
});

async function launch(
  fixture,
  adapter,
  { stdout = captureStream(), stderr = captureStream() } = {},
) {
  return runCli(["launch", "review", "--manifest", fixture.manifestPath], {
    adapter,
    env: fixture.env,
    inspectRepository: async () => ({
      repositoryPath: fixture.repository,
      headSha: fixture.review.head.sha,
      diffBytes: Buffer.from("diff --git a/example b/example\n"),
    }),
    implementationRevision: GIT_SHA,
    now: () => new Date("2026-07-15T12:00:00Z"),
    runDoctor: async () => healthyDoctor(),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
}

async function reviewFixture(
  t,
  runId = "review-launch-example",
  { urgency = "hotfix" } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-review-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repo");
  const worktree = join(directory, "worktree");
  const state = join(directory, "state");
  await mkdir(repository);
  await mkdir(worktree);
  const review = {
    schema: "agent-flow.local-review/v1",
    run_id: runId,
    flow: "feature",
    summary: "Review a hotfix candidate",
    repo: repository,
    worktree,
    base: { branch: "main", sha: GIT_SHA },
    head: { branch: "feature/example", sha: `1${GIT_SHA.slice(1)}` },
    kanban: { board: "review-launch", tenant: "feature-parent", task: "t_feature" },
    external_ref: null,
    artifacts: {
      review_summary: join(directory, "review.md"),
      verification: join(directory, "verification.json"),
      journal: join(directory, "journal.md"),
      automated_findings: null,
      diagram: null,
    },
    automated_review: {
      status: "pending",
      reviewed_head_sha: null,
      findings_path: null,
      urgency,
      max_comments: 12,
      per_tier_caps: { critical: 12, important: 0, recommended: 0, nit: 0 },
    },
    review: {
      status: "review_ready",
      session_slug: null,
      reviewed_head_sha: null,
      consumed_comment_ids: [],
    },
  };
  const manifestPath = join(directory, "review.json");
  await writeFile(manifestPath, `${JSON.stringify(review, null, 2)}\n`);
  return {
    directory,
    env: { HOME: directory, XDG_STATE_HOME: state },
    manifestPath,
    repository,
    review,
    runManifestPath: join(state, "agent-flow", "runs", runId, "run.json"),
  };
}

function taskForStage(adapter, stage) {
  return [...adapter.tasks.values()].find(({ title }) =>
    title.endsWith(`/${stage}]`)
  );
}

function aggregateFingerprint(graph, inputs) {
  const entries = [
    `graph\0${graph.name}\0${graph.sha256}`,
    ...inputs.map(({ kind, name, sha256 }) => `${kind}\0${name}\0${sha256}`),
  ].sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

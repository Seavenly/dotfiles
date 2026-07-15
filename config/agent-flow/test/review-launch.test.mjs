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
import { dirname, join } from "node:path";
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
  constructor({
    archiveTimestamp = Date.parse("2026-07-15T12:00:10Z") / 1000,
    createDelayMs = 0,
    failAfterCreates = null,
  } = {}) {
    this.archiveTimestamp = archiveTimestamp;
    this.createDelayMs = createDelayMs;
    this.failAfterCreates = failAfterCreates;
    this.tasks = new Map();
    this.idsByKey = new Map();
    this.events = [];
    this.nextId = 1;
    this.unarchivableTaskIds = new Set();
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
      comments: [],
      events: [],
      runs: [],
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
    this.tasks.get(taskId).comments.push({ author: "agent-flow", body });
    this.events.push({ type: "comment", taskId, body });
  }

  async listTasks({ tenant, includeArchived }) {
    return [...this.tasks.values()]
      .filter((task) => task.tenant === tenant)
      .filter((task) => includeArchived || task.status !== "archived")
      .map(({ id, status, tenant: taskTenant, title }) => ({
        id,
        status,
        tenant: taskTenant,
        title,
      }));
  }

  async getTaskLifecycle({ taskId }) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return structuredClone(task);
  }

  async reclaimTask({ taskId, reason }) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return false;
    task.status = "ready";
    task.runs.push({ status: "done", outcome: "reclaimed" });
    this.events.push({ type: "reclaim", taskId, reason });
    return true;
  }

  async archiveTask({ taskId }) {
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.status === "archived" ||
      this.unarchivableTaskIds.has(taskId)
    ) return false;
    task.status = "archived";
    task.events.push({ kind: "archived", created_at: this.archiveTimestamp });
    this.events.push({ type: "archive", taskId });
    return true;
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

test("launch review seals an external tracker root", async (t) => {
  const fixture = await reviewFixture(t, "review-external-root", {
    externalRef: "github:example/project#42",
  });
  const adapter = new FakeHermesAdapter();

  assert.equal(await launch(fixture, adapter), 0);

  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  assert.deepEqual(run.identity.external_root, {
    system: "github",
    id: "example/project#42",
  });
  assert.equal(run.identity.supersedes, null);
  const status = await statusReport(fixture, adapter);
  assert.deepEqual(status.report.external_root, run.identity.external_root);
  assert.equal(status.report.supersedes, null);
});

test("launch review rejects a second nonterminal external-root owner", async (t) => {
  const first = await reviewFixture(t, "review-external-first", {
    externalRef: "github:example/project#42",
  });
  const second = await replacementFixture(first, "review-external-second");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  const stderr = captureStream();

  assert.equal(await launch(second, adapter, { stderr }), 1);

  assert.match(
    stderr.value(),
    /external root github:example\/project#42 is owned by nonterminal run review-external-first/,
  );
  await assert.rejects(readFile(second.runManifestPath), { code: "ENOENT" });
  assert.equal(adapter.tasks.size, 10);
});

test("launch review rejects silent replacement of a terminal external owner", async (t) => {
  const first = await reviewFixture(t, "review-external-terminal", {
    externalRef: "github:example/project#42",
  });
  const second = await replacementFixture(first, "review-external-replacement");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  completeRun(adapter);
  const stderr = captureStream();

  assert.equal(await launch(second, adapter, { stderr }), 1);

  assert.match(
    stderr.value(),
    /must explicitly supersede terminal owner review-external-terminal/,
  );
  await assert.rejects(readFile(second.runManifestPath), { code: "ENOENT" });
});

test("launch review explicitly supersedes a terminal external owner", async (t) => {
  const first = await reviewFixture(t, "review-external-prior", {
    externalRef: "github:example/project#42",
  });
  const second = await replacementFixture(first, "review-external-successor", {
    supersedes: first.review.run_id,
  });
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  completeRun(adapter);

  assert.equal(await launch(second, adapter), 0);

  const run = JSON.parse(await readFile(second.runManifestPath, "utf8"));
  assert.deepEqual(run.identity.external_root, {
    system: "github",
    id: "example/project#42",
  });
  assert.equal(run.identity.supersedes, first.review.run_id);
  assert.equal(adapter.tasks.size, 20);
});

test("supersession rejects a root that only claims to be terminal", async (t) => {
  const first = await reviewFixture(t, "review-external-false-terminal", {
    externalRef: "jira:TEAM-42",
  });
  const second = await replacementFixture(first, "review-external-blocked", {
    supersedes: first.review.run_id,
  });
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  for (const task of adapter.tasks.values()) task.status = "done";
  const stderr = captureStream();

  assert.equal(await launch(second, adapter, { stderr }), 1);

  assert.match(
    stderr.value(),
    /external root jira:TEAM-42 is owned by nonterminal run review-external-false-terminal/,
  );
  await assert.rejects(readFile(second.runManifestPath), { code: "ENOENT" });
});

test("launch review can supersede an auditable cancelled owner", async (t) => {
  const first = await reviewFixture(t, "review-external-cancelled", {
    externalRef: "jira:TEAM-42",
  });
  const second = await replacementFixture(first, "review-external-after-cancel", {
    supersedes: first.review.run_id,
  });
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  const completed = taskForStage(adapter, "critic");
  completed.status = "done";
  completed.runs.push({ status: "done", outcome: "completed" });
  assert.equal(await runCli([
    "cancel",
    "--run",
    first.review.run_id,
    "--reason",
    "Superseded by a fresh review",
  ], {
    adapter,
    env: first.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);

  assert.equal(await launch(second, adapter), 0);

  const run = JSON.parse(await readFile(second.runManifestPath, "utf8"));
  assert.equal(run.identity.supersedes, first.review.run_id);
});

test("supersession rejects an active undeclared card in a completed tenant", async (t) => {
  const first = await reviewFixture(t, "review-external-extra-complete", {
    externalRef: "github:example/project#42",
  });
  const second = await replacementFixture(first, "review-external-extra-successor", {
    supersedes: first.review.run_id,
  });
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  completeRun(adapter);
  addUndeclaredTask(adapter, first.review.run_id);
  const stderr = captureStream();

  assert.equal(await launch(second, adapter, { stderr }), 1);

  assert.match(stderr.value(), /owned by nonterminal run review-external-extra-complete/);
  await assert.rejects(readFile(second.runManifestPath), { code: "ENOENT" });
});

test("supersession rejects an active undeclared card in a cancelled tenant", async (t) => {
  const first = await reviewFixture(t, "review-external-extra-cancelled", {
    externalRef: "jira:TEAM-42",
  });
  const second = await replacementFixture(first, "review-external-extra-after-cancel", {
    supersedes: first.review.run_id,
  });
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  assert.equal(await runCli([
    "cancel",
    "--run",
    first.review.run_id,
    "--reason",
    "Superseded by a fresh review",
  ], {
    adapter,
    env: first.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);
  addUndeclaredTask(adapter, first.review.run_id);
  const stderr = captureStream();

  assert.equal(await launch(second, adapter, { stderr }), 1);

  assert.match(stderr.value(), /owned by nonterminal run review-external-extra-cancelled/);
  await assert.rejects(readFile(second.runManifestPath), { code: "ENOENT" });
});

test("unrelated damaged sealed authority does not block external ownership", async (t) => {
  const first = await reviewFixture(t, "review-external-unrelated-damaged", {
    externalRef: "github:example/project#41",
  });
  const second = await replacementFixture(first, "review-external-unrelated-next");
  second.review.external_ref = "github:example/project#42";
  await writeFile(second.manifestPath, `${JSON.stringify(second.review, null, 2)}\n`);
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  const prior = JSON.parse(await readFile(first.runManifestPath, "utf8"));
  await chmod(prior.graph.sealed_path, 0o600);
  await writeFile(prior.graph.sealed_path, "damaged sealed graph\n");

  assert.equal(await launch(second, adapter), 0);
});

test("concurrent launches cannot claim the same external root", async (t) => {
  const first = await reviewFixture(t, "review-external-race-one", {
    externalRef: "github:example/project#99",
  });
  const second = await replacementFixture(first, "review-external-race-two");
  const adapter = new FakeHermesAdapter({ createDelayMs: 5 });
  const firstStderr = captureStream();
  const secondStderr = captureStream();

  const results = await Promise.all([
    launch(first, adapter, { stderr: firstStderr }),
    launch(second, adapter, { stderr: secondStderr }),
  ]);

  assert.deepEqual(results.sort(), [0, 1]);
  assert.equal(adapter.tasks.size, 10);
  const manifests = await Promise.allSettled([
    readFile(first.runManifestPath),
    readFile(second.runManifestPath),
  ]);
  assert.equal(manifests.filter(({ status }) => status === "fulfilled").length, 1);
  assert.match(
    `${firstStderr.value()}${secondStderr.value()}`,
    /external ownership is being claimed/,
  );
});

test("same-run ownership contention cannot mutate the materialized root", async (t) => {
  const fixture = await reviewFixture(t, "review-external-same-run-race", {
    externalRef: "github:example/project#99",
  });
  const adapter = new FakeHermesAdapter();
  const releaseTask = adapter.releaseTask.bind(adapter);
  let announceReceipt;
  let continueRelease;
  const receiptReady = new Promise((resolve) => { announceReceipt = resolve; });
  const releaseAllowed = new Promise((resolve) => { continueRelease = resolve; });
  adapter.releaseTask = async (request) => {
    announceReceipt();
    await releaseAllowed;
    return releaseTask(request);
  };
  const first = launch(fixture, adapter);
  await receiptReady;
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);
  continueRelease();
  assert.equal(await first, 0);

  assert.match(stderr.value(), /external ownership is being claimed/);
  assert.equal(adapter.events.some(({ type }) => type === "comment"), false);
  assert.equal(taskForStage(adapter, "review-root").status, "todo");
});

test("stale external ownership locks fail with an explicit recovery path", async (t) => {
  const fixture = await reviewFixture(t, "review-external-stale-lock", {
    externalRef: "github:example/project#99",
  });
  const key = createHash("sha256")
    .update(JSON.stringify([
      fixture.repository,
      "github",
      "example/project#99",
    ]))
    .digest("hex");
  const lockDirectory = join(
    fixture.env.XDG_STATE_HOME,
    "agent-flow",
    "ownership-locks",
  );
  const lockPath = join(lockDirectory, `${key}.lock`);
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({
    operation: "external-ownership",
    pid: 999999,
    token: "stale",
  })}\n`);
  const adapter = new FakeHermesAdapter();
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);

  assert.match(stderr.value(), /stale external ownership lock detected/);
  assert.equal(stderr.value().includes(lockPath), true);
  await assert.rejects(readFile(fixture.runManifestPath), { code: "ENOENT" });
  assert.equal(adapter.tasks.size, 0);
});

test("launch review rejects supersession without an external root", async (t) => {
  const fixture = await reviewFixture(t, "review-invalid-supersession", {
    supersedes: "review-prior",
  });
  const adapter = new FakeHermesAdapter();
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);

  assert.match(stderr.value(), /supersedes requires external_ref/);
  await assert.rejects(readFile(fixture.runManifestPath), { code: "ENOENT" });
  assert.equal(adapter.tasks.size, 0);
});

test("GitHub external ownership is canonical across coordinate case", async (t) => {
  const first = await reviewFixture(t, "review-external-case-one", {
    externalRef: "github:Example/Project#42",
  });
  const second = await replacementFixture(first, "review-external-case-two");
  second.review.external_ref = "github:example/project#42";
  await writeFile(
    second.manifestPath,
    `${JSON.stringify(second.review, null, 2)}\n`,
  );
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(first, adapter), 0);
  const stderr = captureStream();

  assert.equal(await launch(second, adapter, { stderr }), 1);

  assert.match(stderr.value(), /owned by nonterminal run review-external-case-one/);
  const run = JSON.parse(await readFile(first.runManifestPath, "utf8"));
  assert.equal(run.identity.external_root.id, "example/project#42");
});

test("status projects a launched run from sealed identity and Hermes state", async (t) => {
  const fixture = await reviewFixture(t, "review-status-running");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const stdout = captureStream();
  const stderr = captureStream();

  assert.equal(await runCli([
    "status",
    "--run",
    fixture.review.run_id,
    "--json",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:00:30Z"),
    stdout: stdout.stream,
    stderr: stderr.stream,
  }), 0, stderr.value());

  const report = JSON.parse(stdout.value());
  assert.equal(report.run_id, fixture.review.run_id);
  assert.equal(report.flow, "review");
  assert.equal(report.board, "review-launch");
  assert.equal(report.tenant, fixture.review.run_id);
  assert.equal(report.state, "running");
  assert.deepEqual(report.root, { id: "t_1", stage: "review-root", status: "todo" });
  assert.equal(report.counts.total, 10);
  assert.equal(report.counts.ready, 3);
  assert.equal(report.counts.todo, 7);
  assert.equal(report.counts.blocked, 0);
  assert.equal(report.cards.length, 10);
  assert.equal(report.cards[0].stage, "review-root");
  assert.equal(report.limits.created_cards.actual, 10);
  assert.equal(report.limits.created_cards.maximum, 10);
  assert.equal(report.limits.worker_attempts.actual, 0);
  assert.equal(report.limits.elapsed_seconds.actual, 30);
  assert.deepEqual(report.limits.feature_streams, {
    actual: 0,
    maximum: 1,
    exceeded: false,
  });
  assert.equal(report.cancellation.requested, false);
  assert.deepEqual(report.issues, []);
  assert.equal(
    report.artifacts.result,
    join(dirname(fixture.runManifestPath), "artifacts", "review", "result.json"),
  );
  assert.equal(report.artifacts.outputs.length, 4);
  assert.equal(report.artifacts.validations.length, 4);
});

test("status reports retry and broken topology without issuing mutations", async (t) => {
  const fixture = await reviewFixture(t, "review-status-broken");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const retrying = taskForStage(adapter, "lens:correctness");
  retrying.runs.push({ status: "done", outcome: "crashed" });
  retrying.status = "ready";
  adapter.tasks.delete(taskForStage(adapter, "critic").id);
  const stdout = captureStream();

  assert.equal(await runCli([
    "status",
    "--run",
    fixture.review.run_id,
    "--json",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:00:30Z"),
    stdout: stdout.stream,
    stderr: captureStream().stream,
  }), 1);

  const report = JSON.parse(stdout.value());
  assert.equal(report.state, "broken");
  assert.equal(
    report.cards.find(({ stage }) => stage === "lens:correctness").retrying,
    true,
  );
  assert.deepEqual(report.issues, ["missing Hermes task t_8 for stage critic"]);
  assert.equal(adapter.events.some(({ type }) => type === "comment"), false);
});

test("status distinguishes blocked, retrying, and complete runs", async (t) => {
  const blockedFixture = await reviewFixture(t, "review-status-blocked");
  const blockedAdapter = new FakeHermesAdapter();
  assert.equal(await launch(blockedFixture, blockedAdapter), 0);
  taskForStage(blockedAdapter, "critic").status = "blocked";
  assert.equal(
    (await statusReport(blockedFixture, blockedAdapter)).report.state,
    "blocked",
  );

  const retryFixture = await reviewFixture(t, "review-status-retrying");
  const retryAdapter = new FakeHermesAdapter();
  assert.equal(await launch(retryFixture, retryAdapter), 0);
  const retrying = taskForStage(retryAdapter, "lens:correctness");
  retrying.runs.push({ status: "done", outcome: "crashed" });
  retrying.status = "ready";
  assert.equal(
    (await statusReport(retryFixture, retryAdapter)).report.state,
    "retrying",
  );

  const completeFixture = await reviewFixture(t, "review-status-complete");
  const completeAdapter = new FakeHermesAdapter();
  assert.equal(await launch(completeFixture, completeAdapter), 0);
  for (const task of completeAdapter.tasks.values()) {
    task.status = "done";
    task.completed_at = Date.parse("2026-07-15T12:00:45Z") / 1000;
    task.runs.push({ status: "done", outcome: "completed" });
  }
  const complete = await statusReport(completeFixture, completeAdapter);
  assert.equal(complete.code, 0);
  assert.equal(complete.report.state, "complete");
  assert.equal(complete.report.limits.elapsed_seconds.actual, 45);
});

test("status exposes a mismatched materialization receipt as broken", async (t) => {
  const fixture = await reviewFixture(t, "review-status-receipt");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const receiptPath = join(dirname(fixture.runManifestPath), "materialization.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.run_id = "different-run";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const { code, report } = await statusReport(fixture, adapter);

  assert.equal(code, 1);
  assert.equal(report.state, "broken");
  assert.deepEqual(report.issues, [
    "materialization receipt names a different run",
  ]);
});

test("status exposes dependency drift from the sealed graph", async (t) => {
  const fixture = await reviewFixture(t, "review-status-dependency");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const critic = taskForStage(adapter, "critic");
  critic.parents.pop();

  const { code, report } = await statusReport(fixture, adapter);

  assert.equal(code, 1);
  assert.equal(report.state, "broken");
  assert.deepEqual(report.issues, [
    `task ${critic.id} has unexpected dependency parents`,
  ]);
});

test("status rejects substituted stages and drifted execution authority", async (t) => {
  const fixture = await reviewFixture(t, "review-status-authority");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const receiptPath = join(dirname(fixture.runManifestPath), "materialization.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.tasks["lens:style"] = receipt.tasks.critic;
  delete receipt.tasks.critic;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const lens = taskForStage(adapter, "lens:correctness");
  lens.assignee = "builder";
  lens.body = "authority removed";

  const { code, report } = await statusReport(fixture, adapter);

  assert.equal(code, 1);
  assert.equal(report.state, "broken");
  assert.equal(
    report.issues.includes(
      "materialization receipt does not name the exact enabled stages",
    ),
    true,
  );
  assert.equal(
    report.issues.includes(
      `task ${lens.id} execution settings do not match stage lens:correctness`,
    ),
    true,
  );
  assert.equal(
    report.issues.includes(
      `task ${lens.id} does not contain agent-flow authority`,
    ),
    true,
  );
});

test("status rejects archived or uncompleted required work as complete", async (t) => {
  const fixture = await reviewFixture(t, "review-status-invalid-complete");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  for (const task of adapter.tasks.values()) {
    task.status = "done";
    task.completed_at = Date.parse("2026-07-15T12:00:45Z") / 1000;
    task.runs.push({ status: "done", outcome: "completed" });
  }
  const archived = taskForStage(adapter, "lens:security");
  archived.status = "archived";
  archived.events.push({
    kind: "archived",
    created_at: Date.parse("2026-07-15T12:00:46Z") / 1000,
  });
  const uncompleted = taskForStage(adapter, "lens:tests");
  uncompleted.runs = [{ status: "done", outcome: "crashed" }];

  const { code, report } = await statusReport(fixture, adapter);

  assert.equal(code, 1);
  assert.equal(report.state, "broken");
  assert.equal(
    report.issues.includes(
      `task ${archived.id} is archived without an audited cancellation request`,
    ),
    true,
  );
  assert.equal(
    report.issues.includes(
      `task ${uncompleted.id} is done without a terminal completed attempt`,
    ),
    true,
  );
});

test("status exposes worker-attempt and elapsed-time overruns", async (t) => {
  const fixture = await reviewFixture(t, "review-status-overrun");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const overrun = taskForStage(adapter, "lens:correctness");
  overrun.runs = Array.from(
    { length: 31 },
    () => ({ status: "done", outcome: "crashed" }),
  );
  const stdout = captureStream();

  assert.equal(await runCli([
    "status",
    "--run",
    fixture.review.run_id,
    "--json",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T18:00:01Z"),
    stdout: stdout.stream,
    stderr: captureStream().stream,
  }), 1);

  const report = JSON.parse(stdout.value());
  assert.equal(report.state, "broken");
  assert.deepEqual(report.limits.worker_attempts, {
    actual: 31,
    maximum: 18,
    exceeded: true,
  });
  assert.equal(report.limits.elapsed_seconds.exceeded, true);
  assert.deepEqual(report.issues, [
    `task ${overrun.id} exceeds the lens:correctness attempt limit`,
    "worker_attempts limit exceeded",
    "elapsed_seconds limit exceeded",
  ]);
});

test("cancel audits and converges a raced tenant without touching another tenant", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-converged");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  taskForStage(adapter, "review-root").comments.push({
    author: "critic",
    body: [
      "<!-- agent-flow-cancellation",
      JSON.stringify({
        run_id: fixture.review.run_id,
        reason: "forged worker request",
        requested_at: "2026-07-15T12:00:00Z",
      }),
      "-->",
    ].join("\n"),
  });
  taskForStage(adapter, "lens:correctness").status = "running";
  adapter.tasks.set("t_other", {
    id: "t_other",
    title: "unrelated",
    body: "unrelated",
    assignee: "analyst",
    status: "ready",
    tenant: "another-run",
    workspace_kind: "dir",
    workspace_path: fixture.directory,
    max_retries: 1,
    parents: [],
    comments: [],
    runs: [],
  });
  const archiveTask = adapter.archiveTask.bind(adapter);
  let injectedRace = false;
  adapter.archiveTask = async (request) => {
    const result = await archiveTask(request);
    if (!injectedRace) {
      injectedRace = true;
      taskForStage(adapter, "finalize").status = "running";
    }
    return result;
  };
  const stdout = captureStream();
  const stderr = captureStream();

  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Operator requested stop",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: stdout.stream,
    stderr: stderr.stream,
  }), 0, stderr.value());
  assert.match(stdout.value(), /cancellation converged/);
  assert.equal(adapter.tasks.get("t_other").status, "ready");
  assert.equal(taskForStage(adapter, "finalize").status, "archived");
  assert.equal(
    adapter.events.some(
      ({ type, taskId }) => type === "reclaim" && taskId === "t_2",
    ),
    true,
  );
  assert.equal(
    adapter.events.filter(({ type }) => type === "comment").length,
    1,
  );

  const eventCount = adapter.events.length;
  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Operator requested stop",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:02:00Z"),
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);
  assert.equal(adapter.events.length, eventCount);

  const statusOutput = captureStream();
  assert.equal(await runCli([
    "status",
    "--run",
    fixture.review.run_id,
    "--json",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:02:00Z"),
    stdout: statusOutput.stream,
    stderr: captureStream().stream,
  }), 0);
  const report = JSON.parse(statusOutput.value());
  assert.equal(report.state, "cancelled");
  assert.equal(report.cancellation.reason, "Operator requested stop");
  assert.deepEqual(report.cancellation.survivors, []);
});

test("cancel refuses a receipt root that is not bound to sealed task authority", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-root-authority");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const receiptPath = join(dirname(fixture.runManifestPath), "materialization.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  adapter.tasks.set("t_swapped", {
    ...structuredClone(taskForStage(adapter, "review-root")),
    id: "t_swapped",
    body: "not launcher authority",
  });
  receipt.tasks["review-root"] = "t_swapped";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const stderr = captureStream();

  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Operator requested stop",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);

  assert.match(stderr.value(), /does not contain agent-flow authority/);
  assert.equal(adapter.events.some(({ type }) => type === "comment"), false);
  assert.equal(
    [...adapter.tasks.values()].some(({ status }) => status === "archived"),
    false,
  );
});

test("concurrent cancellation commands serialize one audited request", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-concurrent");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const invoke = (reason) => runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    reason,
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  });

  assert.deepEqual(
    (await Promise.all([invoke("first request"), invoke("second request")])).sort(),
    [0, 1],
  );
  assert.equal(
    adapter.events.filter(({ type }) => type === "comment").length,
    1,
  );
  assert.equal(await invoke("retry after convergence"), 0);
  assert.equal(
    adapter.events.filter(({ type }) => type === "comment").length,
    1,
  );
});

test("cancelled status preserves an elapsed overrun through convergence", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-overrun");
  const adapter = new FakeHermesAdapter({
    archiveTimestamp: Date.parse("2026-07-15T18:00:01Z") / 1000,
  });
  assert.equal(await launch(fixture, adapter), 0);

  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Long-running cancellation",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 0);

  const { code, report } = await statusReport(fixture, adapter);
  assert.equal(code, 1);
  assert.equal(report.state, "broken");
  assert.equal(report.cancellation.requested, true);
  assert.deepEqual(report.limits.elapsed_seconds, {
    actual: 21601,
    maximum: 3600,
    exceeded: true,
  });
});

test("status and cancel reject multiple agent-flow cancellation requests", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-duplicate-audit");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const root = taskForStage(adapter, "review-root");
  for (const reason of ["first", "second"]) {
    root.comments.push({
      author: "agent-flow",
      body: [
        "<!-- agent-flow-cancellation",
        JSON.stringify({
          run_id: fixture.review.run_id,
          reason,
          requested_at: "2026-07-15T12:00:00Z",
        }),
        "-->",
      ].join("\n"),
    });
  }

  const status = await statusReport(fixture, adapter);
  assert.equal(status.code, 1);
  assert.equal(status.report.state, "broken");
  assert.equal(
    status.report.issues.includes(
      "root has multiple agent-flow cancellation requests",
    ),
    true,
  );

  const stderr = captureStream();
  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "third",
  ], {
    adapter,
    env: fixture.env,
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /ambiguous cancellation audit/);
  assert.equal(
    [...adapter.tasks.values()].some(({ status }) => status === "archived"),
    false,
  );
});

test("cancel reports exact survivors when a sweep cannot progress", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-incomplete");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const survivor = taskForStage(adapter, "critic");
  adapter.unarchivableTaskIds.add(survivor.id);
  const stdout = captureStream();
  const stderr = captureStream();

  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Stop for recovery",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: stdout.stream,
    stderr: stderr.stream,
  }), 1);
  assert.equal(stdout.value(), "");
  assert.match(stderr.value(), /cancellation incomplete/);
  assert.match(stderr.value(), new RegExp(`${survivor.id} critic todo`));
  assert.equal(adapter.tasks.get(survivor.id).status, "todo");
});

test("cancel refuses to relabel an already completed run", async (t) => {
  const fixture = await reviewFixture(t, "review-cancel-complete");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  for (const task of adapter.tasks.values()) task.status = "done";
  const stderr = captureStream();

  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Too late",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: stderr.stream,
  }), 1);
  assert.match(stderr.value(), /already terminal/);
  assert.equal(
    adapter.events.filter(({ type }) => type === "comment").length,
    0,
  );
});

test("cancel resumes safely around every Kanban mutation boundary", async (t) => {
  for (const fault of [
    "before-comment",
    "after-comment",
    "after-reclaim",
    "after-archive",
  ]) {
    await t.test(fault, async () => {
      const fixture = await reviewFixture(t, `review-cancel-${fault}`);
      const adapter = new FakeHermesAdapter();
      assert.equal(await launch(fixture, adapter), 0);
      taskForStage(adapter, "lens:correctness").status = "running";
      const method = fault.split("-").at(-1) === "comment"
        ? "commentTask"
        : fault.split("-").at(-1) === "reclaim"
          ? "reclaimTask"
          : "archiveTask";
      const original = adapter[method].bind(adapter);
      let injected = false;
      adapter[method] = async (request) => {
        if (injected) return original(request);
        injected = true;
        if (fault === "before-comment") throw new Error("injected interruption");
        const result = await original(request);
        throw new Error("injected interruption");
      };

      const interruptedError = captureStream();
      assert.equal(await runCli([
        "cancel",
        "--run",
        fixture.review.run_id,
        "--reason",
        "Recovery test",
      ], {
        adapter,
        env: fixture.env,
        now: () => new Date("2026-07-15T12:01:00Z"),
        stdout: captureStream().stream,
        stderr: interruptedError.stream,
      }), 1);
      assert.match(interruptedError.value(), /injected interruption/);

      adapter[method] = original;
      assert.equal(await runCli([
        "cancel",
        "--run",
        fixture.review.run_id,
        "--reason",
        "Recovery test",
      ], {
        adapter,
        env: fixture.env,
        now: () => new Date("2026-07-15T12:02:00Z"),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
      }), 0);
      assert.equal(
        [...adapter.tasks.values()]
          .filter(({ tenant }) => tenant === fixture.review.run_id)
          .every(({ status }) => status === "archived"),
        true,
      );
      assert.equal(
        adapter.events.filter(({ type }) => type === "comment").length,
        1,
      );
    });
  }
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
  assert.match(changedStderr.value(), /migration receipt/);
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

test("resume accepts an approved complete implementation migration", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-implementation-migration");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  const nextRevision = `2${GIT_SHA.slice(1)}`;
  await writeMigrationReceipt(fixture, {
    changes: [{
      kind: "implementation",
      name: "agent-flow",
      prior_sha256: digestText(run.implementation.revision),
      next_sha256: digestText(nextRevision),
    }],
    from: compatibilityIdentity(run),
    to: {
      content_set_fingerprint: run.implementation.content_set_fingerprint,
      profile_set_fingerprint: run.profiles.profile_set_fingerprint,
      implementation_revision: nextRevision,
      contract_version: run.contract_version,
    },
  });
  const originalTaskIds = [...adapter.tasks.keys()];

  assert.equal(await launch(fixture, adapter, {
    implementationRevision: nextRevision,
  }), 0);

  assert.deepEqual([...adapter.tasks.keys()], originalTaskIds);
});

test("resume accepts an approved complete profile migration", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-profile-migration");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  const report = healthyDoctor();
  const critic = report.profiles.find(({ name }) => name === "critic");
  critic.configurationFingerprint = `sha256:${"b".repeat(64)}`;
  report.profileSetFingerprint = `sha256:${"c".repeat(64)}`;
  await writeMigrationReceipt(fixture, {
    changes: [{
      kind: "profile",
      name: "critic",
      prior_sha256: run.profiles.fingerprints.critic,
      next_sha256: "b".repeat(64),
    }],
    from: compatibilityIdentity(run),
    to: {
      ...compatibilityIdentity(run),
      profile_set_fingerprint: "c".repeat(64),
    },
  });
  const originalTaskIds = [...adapter.tasks.keys()];

  assert.equal(await launch(fixture, adapter, {
    runDoctor: async () => report,
  }), 0);

  assert.deepEqual([...adapter.tasks.keys()], originalTaskIds);
});

test("resume accepts an approved complete sealed-input migration", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-input-migration");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  const priorInput = run.inputs.find(({ kind }) => kind === "review-manifest");
  fixture.review.summary = "Review the same candidate with clarified intent";
  const nextBytes = Buffer.from(`${JSON.stringify(fixture.review, null, 2)}\n`);
  await writeFile(fixture.manifestPath, nextBytes);
  const nextInputDigest = createHash("sha256").update(nextBytes).digest("hex");
  const nextInputs = run.inputs.map((input) => input === priorInput
    ? { ...input, sha256: nextInputDigest }
    : input);
  const nextContentFingerprint = aggregateFingerprint(run.graph, nextInputs);
  await writeMigrationReceipt(fixture, {
    changes: [{
      kind: "input",
      name: "review-manifest/review.json",
      prior_sha256: priorInput.sha256,
      next_sha256: nextInputDigest,
    }],
    from: compatibilityIdentity(run),
    to: {
      ...compatibilityIdentity(run),
      content_set_fingerprint: nextContentFingerprint,
    },
  });
  const originalTaskIds = [...adapter.tasks.keys()];

  assert.equal(await launch(fixture, adapter), 0);

  assert.deepEqual([...adapter.tasks.keys()], originalTaskIds);
});

test("resume blocks before continuation when durable card limits are exceeded", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-resume-limit");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  addUndeclaredTask(adapter, fixture.review.run_id);
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);

  assert.match(stderr.value(), /created_cards limit exceeded/);
  assert.equal(taskForStage(adapter, "review-root").status, "blocked");
});

test("resume blocks on audited lifecycle issues before materialization", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-resume-broken");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const critic = taskForStage(adapter, "critic");
  critic.status = "done";
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);

  assert.match(stderr.value(), /done without a terminal completed attempt/);
  assert.equal(taskForStage(adapter, "review-root").status, "blocked");
});

test("pre-receipt recovery audits lifecycle state before root release", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-pre-receipt-broken");
  const adapter = new FakeHermesAdapter({ failAfterCreates: 4 });
  assert.equal(await launch(fixture, adapter), 1);
  const worker = [...adapter.tasks.values()].find(({ assignee }) =>
    assignee !== "flow-controller"
  );
  worker.status = "done";
  adapter.failAfterCreates = null;
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);

  assert.match(stderr.value(), /done without a terminal completed attempt/);
  assert.equal(taskForStage(adapter, "review-root").status, "blocked");
  await assert.rejects(
    readFile(join(dirname(fixture.runManifestPath), "materialization.json")),
    { code: "ENOENT" },
  );
});

test("resume cannot reverse an initiated cancellation", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-cancelling");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  for (const taskId of adapter.tasks.keys()) {
    adapter.unarchivableTaskIds.add(taskId);
  }
  assert.equal(await runCli([
    "cancel",
    "--run",
    fixture.review.run_id,
    "--reason",
    "Operator requested cancellation",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: captureStream().stream,
    stderr: captureStream().stream,
  }), 1);
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, { stderr }), 1);

  assert.match(stderr.value(), /cancellation has been requested/);
});

test("resume derives every content delta instead of trusting the receipt list", async (t) => {
  const fixture = await reviewFixture(t, "review-launch-incomplete-migration");
  const adapter = new FakeHermesAdapter();
  assert.equal(await launch(fixture, adapter), 0);
  const run = JSON.parse(await readFile(fixture.runManifestPath, "utf8"));
  fixture.review.summary = "Changed review intent";
  const nextReviewBytes = Buffer.from(`${JSON.stringify(fixture.review, null, 2)}\n`);
  const nextPatchBytes = Buffer.from("different candidate patch\n");
  await writeFile(fixture.manifestPath, nextReviewBytes);
  const nextInputs = run.inputs.map((input) => {
    if (input.kind === "review-manifest") {
      return { ...input, sha256: digestBytes(nextReviewBytes) };
    }
    if (input.kind === "machine-input") {
      return { ...input, sha256: digestBytes(nextPatchBytes) };
    }
    return input;
  });
  const priorReview = run.inputs.find(({ kind }) => kind === "review-manifest");
  await writeMigrationReceipt(fixture, {
    changes: [{
      kind: "input",
      name: "review-manifest/review.json",
      prior_sha256: priorReview.sha256,
      next_sha256: digestBytes(nextReviewBytes),
    }],
    from: compatibilityIdentity(run),
    to: {
      ...compatibilityIdentity(run),
      content_set_fingerprint: aggregateFingerprint(run.graph, nextInputs),
    },
  });
  const stderr = captureStream();

  assert.equal(await launch(fixture, adapter, {
    diffBytes: nextPatchBytes,
    stderr,
  }), 1);

  assert.match(stderr.value(), /explaining every compatibility change/);
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
  {
    implementationRevision = GIT_SHA,
    diffBytes = Buffer.from("diff --git a/example b/example\n"),
    runDoctor = async () => healthyDoctor(),
    stdout = captureStream(),
    stderr = captureStream(),
  } = {},
) {
  return runCli(["launch", "review", "--manifest", fixture.manifestPath], {
    adapter,
    env: fixture.env,
    inspectRepository: async () => ({
      repositoryPath: fixture.repository,
      headSha: fixture.review.head.sha,
      diffBytes,
    }),
    implementationRevision,
    now: () => new Date("2026-07-15T12:00:00Z"),
    runDoctor,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
}

async function statusReport(fixture, adapter) {
  const stdout = captureStream();
  const code = await runCli([
    "status",
    "--run",
    fixture.review.run_id,
    "--json",
  ], {
    adapter,
    env: fixture.env,
    now: () => new Date("2026-07-15T12:01:00Z"),
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  return { code, report: JSON.parse(stdout.value()) };
}

async function reviewFixture(
  t,
  runId = "review-launch-example",
  {
    externalRef = null,
    supersedes = null,
    urgency = "hotfix",
  } = {},
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
    external_ref: externalRef,
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
  if (supersedes !== null) review.supersedes = supersedes;
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

async function replacementFixture(fixture, runId, { supersedes = null } = {}) {
  const review = structuredClone(fixture.review);
  review.run_id = runId;
  if (supersedes === null) delete review.supersedes;
  else review.supersedes = supersedes;
  const manifestPath = join(fixture.directory, `${runId}.json`);
  await writeFile(manifestPath, `${JSON.stringify(review, null, 2)}\n`);
  return {
    ...fixture,
    manifestPath,
    review,
    runManifestPath: join(
      fixture.env.XDG_STATE_HOME,
      "agent-flow",
      "runs",
      runId,
      "run.json",
    ),
  };
}

function taskForStage(adapter, stage) {
  return [...adapter.tasks.values()].find(({ title }) =>
    title.endsWith(`/${stage}]`)
  );
}

function completeRun(adapter) {
  for (const task of adapter.tasks.values()) {
    task.status = "done";
    task.completed_at = Date.parse("2026-07-15T12:00:45Z") / 1000;
    task.runs.push({ status: "done", outcome: "completed" });
  }
}

function addUndeclaredTask(adapter, runId) {
  const id = `t_${adapter.nextId++}`;
  adapter.tasks.set(id, {
    id,
    title: `[${runId}/undeclared]`,
    body: "undeclared tenant card",
    assignee: "critic",
    status: "ready",
    tenant: runId,
    workspace_kind: "dir",
    workspace_path: "/tmp",
    max_retries: 1,
    parents: [],
    comments: [],
    events: [],
    runs: [],
  });
}

function aggregateFingerprint(graph, inputs) {
  const entries = [
    `graph\0${graph.name}\0${graph.sha256}`,
    ...inputs.map(({ kind, name, sha256 }) => `${kind}\0${name}\0${sha256}`),
  ].sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function compatibilityIdentity(run) {
  return {
    contract_version: run.contract_version,
    implementation_revision: run.implementation.revision,
    profile_set_fingerprint: run.profiles.profile_set_fingerprint,
    content_set_fingerprint: run.implementation.content_set_fingerprint,
  };
}

function digestText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeMigrationReceipt(fixture, { changes, from, to }) {
  const migrations = join(dirname(fixture.runManifestPath), "migrations");
  const evidencePath = join(migrations, "approval.json");
  await mkdir(migrations, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
    decision: "Approved migration evidence",
  }, null, 2)}\n`);
  await writeFile(join(migrations, "migration-1.json"), `${JSON.stringify({
    schema: "agent-flow.migration-receipt/v1",
    receipt_id: "migration-1",
    run_id: fixture.review.run_id,
    from,
    to,
    changes,
    approval: {
      actor: "operator",
      approved_at: "2026-07-15T12:30:00Z",
      reason: "Reviewed compatibility change",
      evidence_path: evidencePath,
    },
  }, null, 2)}\n`);
}

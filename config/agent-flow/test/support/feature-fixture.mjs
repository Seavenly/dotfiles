import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const FINGERPRINT = "a".repeat(64);

export async function featureTestFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-feature-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  const state = join(directory, "state");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "file.txt"), "base\n");
  await git(repo, "add", "file.txt");
  await git(repo, "commit", "-m", "base");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  const manifestPath = join(directory, "feature.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "agent-flow.feature/v1",
    run_id: "feature-one",
    summary: "Implement the feature",
    repo,
    base: { branch: "main", sha: baseSha },
    branch: "agent-flow/feature-one",
    kanban: { board: "features", task: "root" },
    external_ref: null,
    acceptance: ["The feature exists"],
    slices: [{
      id: "feature",
      title: "Build it",
      verification: [{ argv: ["git", "diff", "--check"] }],
    }],
    verification: [{ argv: ["git", "diff", "--check"] }],
    limits: {
      max_slice_retries: 1,
      max_completeness_fixes: 1,
      max_critique_fixes: 1,
      max_elapsed_seconds: 3600,
    },
  }, null, 2)}\n`);
  return { baseSha, directory, manifestPath, repo, state };
}

export function healthyFeatureDoctor() {
  return {
    ok: true,
    profileSetFingerprint: `sha256:${FINGERPRINT}`,
    profiles: ["flow-controller", "analyst", "critic", "builder", "artifact", "gate"]
      .map((name) => ({
        name,
        available: true,
        configurationFingerprint: `sha256:${FINGERPRINT}`,
      })),
  };
}

export class FakeFeatureAdapter {
  constructor() {
    this.tasks = new Map();
    this.byKey = new Map();
    this.next = 1;
    this.remoteMutations = 0;
  }
  async ensureBoard() {}
  async createTask(spec) {
    const existing = this.byKey.get(spec.idempotencyKey);
    if (existing) return this.tasks.get(existing);
    const id = `t_${this.next++}`;
    const task = {
      id,
      ...structuredClone(spec),
      workspace_kind: spec.workspace.kind,
      workspace_path: spec.workspace.path,
      max_retries: spec.maxAttempts,
      status: spec.initialStatus === "blocked" ? "blocked" : "todo",
    };
    this.byKey.set(spec.idempotencyKey, id);
    this.tasks.set(id, task);
    return task;
  }
  async getTask({ taskId }) { return structuredClone(this.tasks.get(taskId)); }
  async listTasks({ tenant }) {
    return [...this.tasks.values()]
      .filter((task) => task.tenant === tenant)
      .map((task) => structuredClone(task));
  }
  async getTaskLifecycle({ taskId }) {
    const task = structuredClone(this.tasks.get(taskId));
    return {
      ...task, comments: [], events: [],
      runs: task.completed ? [{ status: "done", outcome: "completed" }] : [],
    };
  }
  async linkTasks({ parentId, childId }) {
    const child = this.tasks.get(childId);
    if (!child.parents.includes(parentId)) child.parents.push(parentId);
  }
  async releaseTask({ taskId }) { this.tasks.get(taskId).status = "todo"; }
  async blockTask({ taskId }) { this.tasks.get(taskId).status = "blocked"; }
  async commentTask() {}
  completeStage(stage, metadata = {}) {
    const task = [...this.tasks.values()].find(({ title }) => title.includes(`/${stage}]`));
    if (!task) throw new Error(`missing fake task for ${stage}`);
    task.completed = {
      attempt: 1, attemptId: `attempt-${task.id}`, metadata,
      state: "completed", taskId: task.id,
    };
    task.status = "done";
    return structuredClone(task.completed);
  }
  async getTerminalCompletedAttempt({ taskId }) {
    const completed = this.tasks.get(taskId)?.completed;
    if (!completed) throw new Error(`fake task ${taskId} is not complete`);
    return structuredClone(completed);
  }
  async getTaskAuthority({ taskId }) {
    const body = this.tasks.get(taskId)?.body ?? "";
    const match = /<!-- agent-flow-authority\n(?<document>\{[\s\S]*?\})\n-->/.exec(body);
    if (!match) throw new Error(`fake task ${taskId} has no authority`);
    const document = JSON.parse(match.groups.document);
    return {
      taskId,
      runId: document.run_id,
      stage: document.stage,
      runManifestPath: document.run_manifest_path,
      runManifestSha256: document.run_manifest_sha256,
      gateSpecPath: document.gate_spec_path,
      gateSpecSha256: document.gate_spec_sha256,
      producerTaskId: document.producer_task_id,
    };
  }
}

async function git(cwd, ...args) {
  return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

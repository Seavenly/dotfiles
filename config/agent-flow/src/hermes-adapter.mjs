import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { validateContract } from "./schema-validator.mjs";

const execFileAsync = promisify(execFile);
const AUTHORITY_PATTERN =
  /<!-- agent-flow-authority\n(?<document>\{[\s\S]*?\})\n-->/;

export class HermesAdapter {
  constructor({ board = null, run = defaultRun } = {}) {
    this.board = board;
    this.run = run;
  }

  async createTask({
    title,
    body,
    assignee,
    tenant,
    workspace,
    parents,
    idempotencyKey,
    maxAttempts,
    initialStatus,
    signal = undefined,
  }) {
    const args = [
      "create",
      title,
      "--body",
      body,
      "--assignee",
      assignee,
      "--tenant",
      tenant,
      "--workspace",
      `${workspace.kind}:${workspace.path}`,
      "--idempotency-key",
      idempotencyKey,
      "--max-retries",
      String(maxAttempts),
      "--initial-status",
      initialStatus,
      "--created-by",
      "agent-flow",
    ];
    for (const parent of parents) args.push("--parent", parent);
    args.push("--json");
    return this.run(this.#kanbanArgs(args), { signal, json: true });
  }

  async getTask({ taskId, signal = undefined }) {
    const payload = await this.#show(taskId, signal);
    return { ...payload.task, parents: [...payload.parents] };
  }

  async listTasks({ tenant, includeArchived = false, signal = undefined }) {
    // Hermes v0.18.2 reconciles dependency-cleared tasks to ready during list.
    // Status accepts that native lifecycle transition and issues no mutation command.
    const args = ["list", "--tenant", tenant];
    if (includeArchived) args.push("--archived");
    args.push("--json");
    return this.run(this.#kanbanArgs(args), { signal, json: true });
  }

  async getTaskLifecycle({ taskId, signal = undefined }) {
    const payload = await this.#show(taskId, signal);
    return {
      ...payload.task,
      parents: [...payload.parents],
      comments: structuredClone(payload.comments ?? []),
      events: structuredClone(payload.events ?? []),
      runs: structuredClone(payload.runs ?? []),
    };
  }

  async linkTasks({ parentId, childId, signal = undefined }) {
    await this.run(
      this.#kanbanArgs(["link", parentId, childId]),
      { signal, json: false },
    );
  }

  async releaseTask({ taskId, reason, signal = undefined }) {
    await this.run(
      this.#kanbanArgs(["unblock", "--reason", reason, taskId]),
      { signal, json: false },
    );
  }

  async blockTask({ taskId, reason, signal = undefined }) {
    await this.run(
      this.#kanbanArgs(["block", taskId, reason]),
      { signal, json: false },
    );
  }

  async commentTask({ taskId, body, signal = undefined }) {
    await this.run(
      this.#kanbanArgs(["comment", taskId, body, "--author", "agent-flow"]),
      { signal, json: false },
    );
  }

  async reclaimTask({ taskId, reason, signal = undefined }) {
    try {
      await this.run(
        this.#kanbanArgs(["reclaim", "--reason", reason, taskId]),
        { signal, json: false },
      );
      return true;
    } catch (error) {
      if (
        error.code === 1 &&
        error.stderr?.includes(`cannot reclaim ${taskId}`)
      ) return false;
      throw error;
    }
  }

  async archiveTask({ taskId, signal = undefined }) {
    try {
      await this.run(
        this.#kanbanArgs(["archive", taskId]),
        { signal, json: false },
      );
      return true;
    } catch (error) {
      if (
        error.code === 1 &&
        error.stderr?.includes(`cannot archive ${taskId}`)
      ) return false;
      throw error;
    }
  }

  async getTaskAuthority({ taskId, signal = undefined }) {
    const payload = await this.#show(taskId, signal);
    return parseTaskAuthority({
      body: payload.task?.body,
      taskId: payload.task?.id ?? taskId,
    });
  }

  async getCompletedAttempt({ taskId, attempt, signal = undefined }) {
    const payload = await this.#show(taskId, signal);
    const runs = this.#orderedRuns(payload);
    const run = runs[attempt - 1];
    if (!run) {
      throw new Error(`task ${taskId} does not have attempt ${attempt}`);
    }
    return this.#attempt(taskId, attempt, run);
  }

  async getTerminalCompletedAttempt({ taskId, signal = undefined }) {
    const payload = await this.#show(taskId, signal);
    const runs = this.#orderedRuns(payload);
    const attempt = runs.length;
    const run = runs.at(-1);
    if (!run || run.status !== "done" || run.outcome !== "completed") {
      throw new Error(`task ${taskId} does not have a terminal completed attempt`);
    }
    return this.#attempt(taskId, attempt, run);
  }

  #orderedRuns(payload) {
    return [...payload.runs].sort(
      (left, right) => left.started_at - right.started_at,
    );
  }

  #attempt(taskId, attempt, run) {
    return {
      attemptId: String(run.id),
      taskId,
      attempt,
      state:
        run.status === "done" && run.outcome === "completed"
          ? "completed"
          : run.status,
      metadata: run.metadata,
    };
  }

  async #show(taskId, signal) {
    return this.run(
      this.#kanbanArgs(["show", taskId, "--json"]),
      { signal },
    );
  }

  #kanbanArgs(args) {
    return this.board === null
      ? ["kanban", ...args]
      : ["kanban", "--board", this.board, ...args];
  }
}

export async function parseTaskAuthority({ body, taskId }) {
  const match = body?.match(AUTHORITY_PATTERN);
  if (!match) {
    throw new Error(`task ${taskId} does not contain agent-flow authority`);
  }
  const authority = JSON.parse(match.groups.document);
  if (!(await validateContract(authority)).valid) {
    throw new Error(`task ${taskId} contains invalid agent-flow task authority`);
  }
  return {
    taskId,
    runId: authority.run_id,
    stage: authority.stage,
    runManifestPath: authority.run_manifest_path,
    runManifestSha256: authority.run_manifest_sha256,
    ...(authority.producer_task_id
      ? { producerTaskId: authority.producer_task_id }
      : {}),
    ...(authority.input_task_ids
      ? { inputTaskIds: structuredClone(authority.input_task_ids) }
      : {}),
    ...(authority.gate_spec_path
      ? {
          gateSpecPath: authority.gate_spec_path,
          gateSpecSha256: authority.gate_spec_sha256,
        }
      : {}),
  };
}

export function formatTaskAuthority(authority) {
  return `<!-- agent-flow-authority\n${JSON.stringify(authority)}\n-->`;
}

async function defaultRun(args, { signal, json = true } = {}) {
  const { stdout } = await execFileAsync("hermes", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });
  return json ? JSON.parse(stdout) : stdout;
}

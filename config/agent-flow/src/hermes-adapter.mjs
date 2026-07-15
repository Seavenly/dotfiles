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

  async getTaskAuthority({ taskId }) {
    const payload = await this.#show(taskId);
    const match = payload.task?.body?.match(AUTHORITY_PATTERN);
    if (!match) {
      throw new Error(`task ${taskId} does not contain agent-flow authority`);
    }
    const authority = JSON.parse(match.groups.document);
    if (!(await validateContract(authority)).valid) {
      throw new Error(`task ${taskId} contains invalid agent-flow task authority`);
    }
    return {
      taskId: payload.task.id,
      runId: authority.run_id,
      stage: authority.stage,
      runManifestPath: authority.run_manifest_path,
      runManifestSha256: authority.run_manifest_sha256,
      ...(authority.producer_task_id
        ? { producerTaskId: authority.producer_task_id }
        : {}),
      ...(authority.gate_spec_path
        ? {
            gateSpecPath: authority.gate_spec_path,
            gateSpecSha256: authority.gate_spec_sha256,
          }
        : {}),
    };
  }

  async getCompletedAttempt({ taskId, attempt }) {
    const payload = await this.#show(taskId);
    const runs = this.#orderedRuns(payload);
    const run = runs[attempt - 1];
    if (!run) {
      throw new Error(`task ${taskId} does not have attempt ${attempt}`);
    }
    return this.#attempt(taskId, attempt, run);
  }

  async getTerminalCompletedAttempt({ taskId }) {
    const payload = await this.#show(taskId);
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

  async #show(taskId) {
    return this.run(this.#kanbanArgs(["show", taskId, "--json"]));
  }

  #kanbanArgs(args) {
    return this.board === null
      ? ["kanban", ...args]
      : ["kanban", "--board", this.board, ...args];
  }
}

export function formatTaskAuthority(authority) {
  return `<!-- agent-flow-authority\n${JSON.stringify(authority)}\n-->`;
}

async function defaultRun(args) {
  const { stdout } = await execFileAsync("hermes", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

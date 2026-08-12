import { startAgent } from "./agent-start.mjs";
import { closeGroup, closeTask } from "./lifecycle.mjs";
import { readRecords, stateDirectory } from "./registry.mjs";
import { openTask } from "./task-open.mjs";
import {
  startTurn,
  turnCommandResult,
  waitForTurn,
} from "./turns.mjs";

export async function delegate(options, dependencies = {}) {
  const open = dependencies.openTask ?? openTask;
  const start = dependencies.startAgent ?? startAgent;
  const opened = await open(
    {
      group: options.group,
      groupLabel: options.groupLabel,
      key: options.taskKey,
      label: options.taskLabel,
      cwd: options.cwd,
    },
    dependencies,
  );
  const { group, task } = opened;
  let agent;
  try {
    ({ agent } = await start(
      task.id,
      {
        key: options.agentKey,
        label: options.agentLabel,
        role: options.role,
        harness: options.harness,
        model: options.model,
        effort: options.effort,
        capability: options.capability,
      },
      dependencies,
    ));
  } catch (error) {
    await cleanupEmptyDelegation(opened, dependencies);
    throw error;
  }
  const started = await startTurn(
    agent.id,
    { prompt: options.prompt },
    dependencies,
  );
  const settled = await waitForTurn(
    started.turn.id,
    { timeoutMs: options.timeoutMs },
    dependencies,
  );
  return turnCommandResult(
    "delegate",
    {
      group,
      task,
      agent: settled.agent,
      turn: settled.turn,
      block: settled.block,
    },
    { includeMessages: true, compact: true },
  );
}

async function cleanupEmptyDelegation(opened, dependencies) {
  if (!opened.taskCreated) return;
  const hasAgents = dependencies.taskHasAgents
    ? await dependencies.taskHasAgents(opened.task.id)
    : (await readRecords(
        stateDirectory(dependencies.env ?? process.env),
        "agents",
      )).some(({ task_id: taskId }) => taskId === opened.task.id);
  if (hasAgents) return;
  const cleanup = opened.groupCreated
    ? dependencies.closeGroup ?? closeGroup
    : dependencies.closeTask ?? closeTask;
  const result = await cleanup(
    opened.groupCreated ? opened.group.id : opened.task.id,
    { ...dependencies, force: true },
  );
  if (!["closed", "task_closed"].includes(result.status)) {
    throw new Error(`failed to clean empty delegated task: ${result.status}`);
  }
}

import { startAgent } from "./agent-start.mjs";
import { openTask } from "./task-open.mjs";
import {
  startTurn,
  turnCommandResult,
  waitForTurn,
} from "./turns.mjs";

export async function delegate(options, dependencies = {}) {
  const { group, task } = await openTask(
    {
      group: options.group,
      groupLabel: options.groupLabel,
      key: options.taskKey,
      label: options.taskLabel,
      cwd: options.cwd,
    },
    dependencies,
  );
  const { agent } = await startAgent(
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
  );
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

import { DrovrError } from "./errors.mjs";
import { readRecords } from "./registry.mjs";

const RECORD_KINDS = ["groups", "tasks", "agents", "turns", "blocks"];

export async function loadRegistryRelationships(registryDirectory) {
  const [groups, tasks, agents, turns, blocks] = await Promise.all(
    RECORD_KINDS.map((kind) => readRecords(registryDirectory, kind)),
  );
  return { groups, tasks, agents, turns, blocks };
}

export function agentRelationship(registry, agentId) {
  const agent = registry.agents.find(({ id }) => id === agentId);
  if (!agent) return null;
  const task = registry.tasks.find(({ id }) => id === agent.task_id);
  if (!task) missingOwner("agent", agent.id, "task", agent.task_id);
  const group = registry.groups.find(({ id }) => id === task.group_id);
  if (!group) missingOwner("task", task.id, "group", task.group_id);
  const taskIds = new Set(
    registry.tasks
      .filter(({ group_id }) => group_id === group.id)
      .map(({ id }) => id),
  );
  return {
    group,
    task,
    agent,
    groupAgents: registry.agents.filter((candidate) =>
      taskIds.has(candidate.task_id),
    ),
  };
}

export function taskRelationship(registry, taskId) {
  const task = registry.tasks.find(({ id }) => id === taskId);
  if (!task) return null;
  const group = registry.groups.find(({ id }) => id === task.group_id);
  if (!group) missingOwner("task", task.id, "group", task.group_id);
  return {
    group,
    task,
    agents: registry.agents.filter(
      (candidate) => candidate.task_id === task.id,
    ),
  };
}

export function groupRelationship(registry, groupId) {
  const group = registry.groups.find(({ id }) => id === groupId);
  if (!group) return null;
  const tasks = registry.tasks.filter(
    (candidate) => candidate.group_id === group.id,
  );
  const taskIds = new Set(tasks.map(({ id }) => id));
  const agents = registry.agents.filter((candidate) =>
    taskIds.has(candidate.task_id),
  );
  const agentIds = new Set(agents.map(({ id }) => id));
  const turns = registry.turns.filter((candidate) =>
    agentIds.has(candidate.agent_id),
  );
  const turnIds = new Set(turns.map(({ id }) => id));
  const blocks = registry.blocks.filter((candidate) =>
    turnIds.has(candidate.turn_id),
  );
  return { group, tasks, agents, turns, blocks };
}

function missingOwner(kind, id, ownerKind, ownerId) {
  throw new DrovrError(
    `registry ${kind} ${id} references missing ${ownerKind} ${ownerId}`,
    { code: 5, outcome: "corrupt_registry" },
  );
}

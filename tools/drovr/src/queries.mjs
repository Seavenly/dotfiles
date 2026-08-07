import { DrovrError } from "./errors.mjs";
import { observeAgents } from "./observations.mjs";
import { readRecords, stateDirectory } from "./registry.mjs";
import {
  agentRelationship,
  loadRegistryRelationships,
} from "./registry-relationships.mjs";

function invalidIdentifier(kind, id) {
  throw new DrovrError(`${kind} not found: ${id}`, {
    code: 2,
    outcome: "invalid_arguments",
  });
}

export function compareByCreation(left, right) {
  return (
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}

const SUMMARIZERS = {
  group: summarizeGroup,
  task: summarizeTask,
  agent: summarizeAgent,
};

export function summarizeGroup(group) {
  return {
    id: group.id,
    key: group.key,
    label: group.label,
    inferred: group.inferred,
    lifecycle_status: group.status,
    created_at: group.created_at,
    ...(group.closed_at ? { closed_at: group.closed_at } : {}),
  };
}

export function summarizeTask(task) {
  return {
    id: task.id,
    group_id: task.group_id,
    key: task.key,
    label: task.label,
    cwd: task.cwd,
    lifecycle_status: task.status,
    created_at: task.created_at,
    ...(task.closed_at ? { closed_at: task.closed_at } : {}),
  };
}

export function summarizeAgent(agent) {
  return {
    id: agent.id,
    task_id: agent.task_id,
    key: agent.key,
    label: agent.label,
    lifecycle_status: agent.status,
    harness: agent.launch.harness,
    model: agent.launch.model,
    effort: agent.launch.effort,
    capability: agent.launch.capability,
    native_session: agent.native_session,
    ...(agent.launch_binding?.managed_runtime_evidence_digest
      ? {
          managed_runtime_evidence_digest:
            agent.launch_binding.managed_runtime_evidence_digest,
        }
      : {}),
    created_at: agent.created_at,
    ...(agent.observation ? { observation: agent.observation } : {}),
    ...(agent.retired_at ? { retired_at: agent.retired_at } : {}),
    ...(agent.cleanup_receipt
      ? { cleanup_receipt: agent.cleanup_receipt }
      : {}),
  };
}

export async function listGroups(filters = {}, { env = process.env } = {}) {
  return (await readRecords(stateDirectory(env), "groups"))
    .filter((group) => !filters.status || group.status === filters.status)
    .sort(compareByCreation);
}

export async function getGroup(groupId, { env = process.env } = {}) {
  const group = (await readRecords(stateDirectory(env), "groups")).find(
    ({ id }) => id === groupId,
  );
  if (!group) invalidIdentifier("group", groupId);
  return group;
}

export async function listTasks(filters = {}, { env = process.env } = {}) {
  return (await readRecords(stateDirectory(env), "tasks"))
    .filter(
      (task) =>
        (!filters.groupId || task.group_id === filters.groupId) &&
        (!filters.status || task.status === filters.status),
    )
    .sort(compareByCreation);
}

export async function getTask(taskId, { env = process.env } = {}) {
  const task = (await readRecords(stateDirectory(env), "tasks")).find(
    ({ id }) => id === taskId,
  );
  if (!task) invalidIdentifier("task", taskId);
  return task;
}

export async function listAgents(filters = {}, { env = process.env } = {}) {
  return (await readRecords(stateDirectory(env), "agents"))
    .filter(
      (agent) =>
        (!filters.taskId || agent.task_id === filters.taskId) &&
        (!filters.status || agent.status === filters.status) &&
        (!filters.harness || agent.launch.harness === filters.harness),
    )
    .sort(compareByCreation);
}

export async function getAgent(agentId, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const registryDirectory = stateDirectory(env);
  const registry = await loadRegistryRelationships(registryDirectory);
  const context = agentRelationship(registry, agentId);
  if (!context) invalidIdentifier("agent", agentId);
  const { agent, group } = context;
  if (agent.status !== "active") return agent;
  if (!group.herdr?.session) {
    throw new DrovrError(`registry agent ${agentId} has a missing owner`, {
      code: 5,
      outcome: "corrupt_registry",
    });
  }
  const observation = await observeAgents(group.herdr.session, [agent], {
    ...dependencies,
    env,
  });
  return {
    ...agent,
    observation: observation.observations.get(agent.id),
  };
}

export function queryListCommandResult(kind, records) {
  return queryCommandResult(kind, "list", {
    [`${kind}s`]: records.map(SUMMARIZERS[kind]),
  });
}

export function queryGetCommandResult(kind, record) {
  const lost = kind === "agent" && record.observation?.status === "agent_lost";
  const status = lost
    ? record.observation.reason === "session_missing"
      ? "session_missing"
      : "agent_lost"
    : "completed";
  return queryCommandResult(kind, "get", {
    status,
    [kind]: SUMMARIZERS[kind](record),
  });
}

function queryCommandResult(kind, action, result) {
  return {
    schema: "drovr.command/v1",
    command: `${kind} ${action}`,
    ok: true,
    result: {
      status: "completed",
      ...result,
    },
  };
}

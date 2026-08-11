import { DrovrError } from "./errors.mjs";
import { loadConfiguration } from "./config.mjs";
import { observeAgents } from "./observations.mjs";
import {
  compareByCreation,
  summarizeAgent,
  summarizeGroup,
  summarizeTask,
} from "./queries.mjs";
import {
  readRegistrySnapshot,
  resourceLockProjection,
  stateDirectory,
} from "./registry.mjs";

export async function statusReport(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const registryDirectory = stateDirectory(env);
  const { groups, tasks, agents, turns, blocks, authority_watermark: authorityWatermark } =
    await readRegistrySnapshot(registryDirectory);
  const reconciliation = await resourceLockProjection(registryDirectory, {
    ...dependencies,
    authorityWatermark,
  });
  const sessions = new Set(groups.map((group) => group.herdr?.session));
  if (sessions.has(undefined) || sessions.size > 1) {
    throw new DrovrError("registry groups do not share one Herdr session", {
      code: 5,
      outcome: "corrupt_registry",
    });
  }
  const session =
    [...sessions][0] ?? (await loadConfiguration({ env })).session;
  const activeAgents = agents.filter(({ status }) => status === "active");
  const observation = await observeAgents(session, activeAgents, {
    ...dependencies,
    env,
  });
  const observedAgents = agents.map((agent) => ({
    ...agent,
    ...(observation.observations.has(agent.id)
      ? { observation: observation.observations.get(agent.id) }
      : {}),
  }));
  const warnings = observedAgents
    .filter(({ observation: current }) => current?.status === "agent_lost")
    .map((agent) => ({
      code: "agent_lost",
      agent_id: agent.id,
      reason: agent.observation.reason,
    }));
  if (!observation.running) {
    warnings.unshift({ code: "session_missing", session });
  }
  return {
    schema: "drovr.command/v1",
    command: "status",
    ok: true,
    result: {
      status: observation.running ? "completed" : "session_missing",
      authority_watermark: authorityWatermark,
      reconciliation,
      session: {
        name: session,
        status: observation.running ? "running" : "missing",
      },
      groups: groups.sort(compareByCreation).map(summarizeGroup),
      tasks: tasks.sort(compareByCreation).map(summarizeTask),
      agents: observedAgents.sort(compareByCreation).map(summarizeAgent),
      active_turns: turns
        .filter(({ status }) => status === "working")
        .sort(compareByCreation)
        .map((turn) => ({
          id: turn.id,
          agent_id: turn.agent_id,
          task_id: turn.task_id,
          status: turn.status,
          input_count: turn.inputs.length,
          created_at: turn.created_at,
        })),
      blocked_events: blocks
        .filter(({ status }) => ["open", "acknowledged"].includes(status))
        .sort(compareByCreation)
        .map((block) => ({
          id: block.id,
          turn_id: block.turn_id,
          agent_id: block.agent_id,
          task_id: block.task_id,
          status: block.status,
          created_at: block.created_at,
        })),
      warnings,
    },
  };
}

import { HerdrClient } from "./herdr.mjs";

export async function observeAgents(
  session,
  agents,
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const herdr =
    dependencies.herdr ??
    new HerdrClient({ session, env, run: dependencies.run });
  const running = await herdr.sessionRunning();
  const observations = new Map();
  if (!running) {
    for (const agent of agents) {
      observations.set(agent.id, {
        status: "agent_lost",
        reason: "session_missing",
      });
    }
    return { running, observations };
  }

  const observedAgents = await herdr.agentRecords();
  const byName = new Map(observedAgents.map((agent) => [agent.name, agent]));
  for (const agent of agents) {
    const observed = byName.get(agent.herdr.name);
    if (!observed) {
      observations.set(agent.id, {
        status: "agent_lost",
        reason: "agent_not_found",
      });
    } else if (
      !agent.native_session ||
      observed.agent_session?.value !== agent.native_session
    ) {
      observations.set(agent.id, {
        status: "agent_lost",
        reason: "native_session_mismatch",
      });
    } else {
      observations.set(agent.id, {
        status: observed.agent_status ?? "unknown",
        pane_id: observed.pane_id ?? agent.herdr.pane_id,
      });
    }
  }
  return { running, observations };
}

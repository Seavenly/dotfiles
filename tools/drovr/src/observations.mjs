import { createSemanticHarness } from "./harness-interface.mjs";

export async function observeAgents(
  session,
  agents,
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const harness = createSemanticHarness({
    ...dependencies,
    env,
    session,
    harness: agents[0]?.launch?.harness ?? "codex",
  });
  const runtime = await harness.observeRuntime();
  const running = runtime.evidence === "present";
  const observations = new Map();
  if (runtime.evidence !== "present") {
    for (const agent of agents) {
      observations.set(agent.id, {
        status: runtime.evidence === "absent" ? "agent_lost" : "uncertain",
        reason: runtime.evidence === "absent"
          ? "session_missing"
          : "session_observation_uncertain",
      });
    }
    return { running, observations };
  }

  const semanticObservations = await harness.observeAgents(agents);
  for (const [index, agent] of agents.entries()) {
    const observed = semanticObservations[index];
    if (observed.evidence === "absent") {
      observations.set(agent.id, {
        status: "agent_lost",
        reason: "agent_not_found",
      });
    } else if (observed.evidence !== "present") {
      observations.set(agent.id, {
        status: "uncertain",
        reason: "native_session_mismatch",
      });
    } else {
      observations.set(agent.id, {
        status: observed.state ?? "unknown",
        pane_id: observed.identity?.pane ?? agent.herdr.pane_id,
      });
    }
  }
  return { running, observations };
}

import { loadConfiguration } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { createSemanticHarness } from "./harness-interface.mjs";
import { readRecords, stateDirectory } from "./registry.mjs";

export async function attach(
  agentId,
  { takeover = false, env = process.env } = {},
) {
  const configuration = await loadConfiguration({ env });
  const agents = await readRecords(stateDirectory(env), "agents");
  const agent = agents.find(
    (candidate) => candidate.id === agentId && candidate.status === "active",
  );
  if (!agent) {
    throw new DrovrError(`active agent not found: ${agentId}`, {
      code: 2,
      outcome: "invalid_arguments",
    });
  }
  const harness = createSemanticHarness({
    env,
    session: configuration.session,
    harness: agent.launch.harness,
  });
  await harness.ensureRuntime();
  return harness.attach({ agent, takeover });
}

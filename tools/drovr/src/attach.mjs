import { loadConfiguration } from "./config.mjs";
import { DrovrError } from "./errors.mjs";
import { HerdrClient } from "./herdr.mjs";
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
  const herdr = new HerdrClient({ session: configuration.session, env });
  return herdr.attach(agent.herdr.name, { takeover });
}

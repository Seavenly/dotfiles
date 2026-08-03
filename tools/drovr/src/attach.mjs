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
  const runtime = await harness.observeRuntime();
  if (runtime.evidence !== "present") {
    if (runtime.evidence === "absent") return 4;
    throw new DrovrError(
      runtime.error?.message ?? "harness runtime could not be observed",
      { code: 4, outcome: "adapter_failure" },
    );
  }
  const result = await harness.attach({ agent, takeover });
  return typeof result === "number" ? result : result.exit_code ?? 4;
}

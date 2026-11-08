import { DrovrError } from "./errors.mjs";
import { execute } from "./process.mjs";

export function codexAgentArguments(specification) {
  const native = specification.native;
  const args = [
    "--model",
    specification.model,
    "--sandbox",
    native.sandbox,
    "--ask-for-approval",
    native.approval,
    "-c",
    `model_reasoning_effort=${JSON.stringify(specification.effort)}`,
  ];
  if (native.approvals_reviewer) {
    args.push(
      "-c",
      `approvals_reviewer=${JSON.stringify(native.approvals_reviewer)}`,
    );
  }
  if (specification.instructions) {
    args.push(
      "-c",
      `developer_instructions=${JSON.stringify(specification.instructions)}`,
    );
  }
  if (native.network_access !== undefined) {
    args.push(
      "-c",
      `sandbox_workspace_write.network_access=${native.network_access}`,
    );
  }
  if (native.search) args.push("--search");
  return args;
}

export async function validateCodexLaunchSpecification(
  specification,
  { env = process.env, run = execute } = {},
) {
  try {
    await run(
      "codex",
      ["--strict-config", ...codexAgentArguments(specification), "--help"],
      { env },
    );
  } catch (error) {
    throw new DrovrError(`cannot validate Codex: ${error.message}`, {
      code: 0,
      outcome: "unsupported_configuration",
    });
  }
}

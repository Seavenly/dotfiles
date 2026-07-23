import { DrovrError } from "./errors.mjs";
import { execute } from "./process.mjs";

export function claudePermissionMode(native) {
  return native.permission_mode === "default"
    ? "manual"
    : native.permission_mode;
}

export function claudeAgentArguments(specification) {
  const native = specification.native;
  const permissionMode = claudePermissionMode(native);
  const args = [
    "--model",
    specification.model,
    "--effort",
    specification.effort,
    "--permission-mode",
    permissionMode,
  ];
  if (native.allowed_tools?.length) {
    args.push("--allowedTools", native.allowed_tools.join(","));
  }
  if (permissionMode === "bypassPermissions") {
    args.push("--allow-dangerously-skip-permissions");
  }
  if (specification.instructions) {
    args.push("--append-system-prompt", specification.instructions);
  }
  return args;
}

export async function validateClaudeLaunchSpecification(
  specification,
  { env = process.env, run = execute } = {},
) {
  let help;
  try {
    help = await run("claude", ["--help"], { env });
  } catch (error) {
    throw new DrovrError(`cannot validate Claude Code: ${error.message}`, {
      code: 0,
      outcome: "unsupported_configuration",
    });
  }
  const permissionMode = claudePermissionMode(specification.native);
  const required = ["--model", "--effort", "--permission-mode", permissionMode];
  if (specification.native.allowed_tools?.length) {
    required.push("--allowedTools");
  }
  if (permissionMode === "bypassPermissions") {
    required.push("--allow-dangerously-skip-permissions");
  }
  if (specification.instructions) required.push("--append-system-prompt");
  const missing = required.filter((capability) => !help.includes(capability));
  if (missing.length) {
    throw new DrovrError(
      `Claude Code does not support: ${missing.join(", ")}`,
      { code: 0, outcome: "unsupported_configuration" },
    );
  }

  if (permissionMode === "auto") {
    try {
      const policy = JSON.parse(
        await run("claude", ["auto-mode", "config"], { env }),
      );
      if (
        !Array.isArray(policy.allow) ||
        !Array.isArray(policy.soft_deny) ||
        !Array.isArray(policy.hard_deny)
      ) {
        throw new Error("effective policy is incomplete");
      }
    } catch (error) {
      throw new DrovrError(
        `Claude Code auto mode is unavailable: ${error.message}`,
        { code: 0, outcome: "unsupported_configuration" },
      );
    }
  }
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveAuthorityRoot } from "./authority-root.mjs";

export async function resolveLaunchPolicy({
  policyPath,
  requestedImplementation,
  homeDirectory,
  stateDirectory,
}) {
  const bytes = await readFile(policyPath);
  const policy = JSON.parse(bytes);
  if (policy.schema !== "flow.launch-policy/v1") {
    throw new Error(`unsupported launch policy: ${policy.schema ?? "missing"}`);
  }

  const implementation = requestedImplementation ?? policy.default_implementation;
  const selected = policy.implementations?.[implementation];
  if (!selected) throw new Error(`unknown flow implementation: ${implementation}`);
  if (!selected.launch_enabled) {
    const kind = implementation === "flow-runtime/v1" ? "replacement" : implementation;
    throw new Error(`${kind} launch is disabled`);
  }

  return {
    schema: "flow.launch-selection/v1",
    policy_generation: policy.generation,
    policy_watermark: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    implementation,
    authority_root_spec: selected.authority_root,
    authority_root: resolveAuthorityRoot(selected.authority_root, {
      homeDirectory,
      stateDirectory,
    }),
  };
}

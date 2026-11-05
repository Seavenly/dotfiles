import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";

export const EXECUTION_DESCRIPTION_SCHEMA = "flow.execution-description/v1";
export const DIRECT_TASK_CONTRACT = "flow.direct-task/v1";
export const DIRECT_CAPABILITY = "workspace-write-denied";
export function isDirectDescription(description) {
  return description?.schema === EXECUTION_DESCRIPTION_SCHEMA;
}
export function directDescriptionIssue(description) {
  if (!isDirectDescription(description)) return "incompatible_execution_description";
  const { description_digest: ignored, ...identity } = description;
  const authority = description.effective_authority;
  const backend = description.backend;
  if (digest(identity) !== description.description_digest ||
      digest(description.launch) !== description.comparison_keys?.launch ||
      digest(authority) !== description.comparison_keys?.effective_authority ||
      digest(backend) !== description.watermark?.content_sha256 ||
      backend?.contract !== DIRECT_TASK_CONTRACT || backend.id !== "direct" ||
      backend.native_session_strategy !== "fresh_ephemeral" ||
      description.watermark?.schema !== "flow.execution-watermark/v1" ||
      !["codex", "claude"].includes(backend.harness) ||
      backend.harness !== description.launch?.harness ||
      !isPlainRecord(backend.executable) ||
      !/^sha256:[0-9a-f]{64}$/u.test(backend.executable.sha256 ?? "") ||
      !backend.executable.path?.startsWith("/") || !backend.executable.version ||
      !backend.adapter || !backend.adapter_version ||
      !["read-only", DIRECT_CAPABILITY].includes(description.launch.capability) ||
      authority?.capability !== description.launch.capability ||
      authority?.approvals !== "denied" || authority?.network !== "disabled" || authority?.escalation !== false ||
      digest(authority.writable_roots) !== digest(description.launch.capability === "read-only" ? [] : ["authority_workspace", "task_scratch"]) ||
      digest(authority.protected_paths) !== digest([".git", ".agents", ".codex"]) ||
      authority?.filesystem !== (description.launch.capability === "read-only"
        ? "read_only" : "workspace_write") ||
      description.capabilities?.initial_input !== true ||
      description.capabilities?.structured_output !== true ||
      description.capabilities?.steering !== false ||
      description.capabilities?.session_reuse !== false ||
      description.capabilities?.backend_failover !== false) return "contradictory_execution_description";
  return null;
}
export function executionDescription({ launch, callerMetadata, backend }) {
  const effectiveAuthority = {
    capability: launch.capability,
    approvals: "denied",
    filesystem: launch.capability === "read-only" ? "read_only" : "workspace_write",
    network: "disabled",
    writable_roots: launch.capability === "read-only" ? [] : ["authority_workspace", "task_scratch"],
    protected_paths: [".git", ".agents", ".codex"],
    escalation: false,
  };
  const identity = {
    schema: EXECUTION_DESCRIPTION_SCHEMA, backend, launch,
    caller_metadata: callerMetadata,
    effective_authority: effectiveAuthority,
    capabilities: { initial_input: true, structured_output: true, steering: false, session_reuse: false, backend_failover: false },
    comparison_keys: { launch: digest(launch), effective_authority: digest(effectiveAuthority) },
    watermark: { schema: "flow.execution-watermark/v1", content_sha256: digest(backend) },
  };
  return freezeCanonical({ ...identity, description_digest: digest(identity) });
}

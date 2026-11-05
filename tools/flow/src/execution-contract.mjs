import { digest, freezeCanonical, isPlainRecord } from "./canonical.mjs";

export const EXECUTION_DESCRIPTION_SCHEMA = "flow.execution-description/v1";
export const DIRECT_TASK_CONTRACT = "flow.direct-task/v1";
export const DIRECT_CAPABILITY = "workspace-write-denied";
export const SUPERVISED_NATIVE_TRUST = "supervised-native-cli";
export const SUPERVISED_NATIVE_CONTRACT = "flow.supervised-native-cli/v1";
export function isSupervisedDescription(description) {
  return description?.launch?.trust_posture === SUPERVISED_NATIVE_TRUST &&
    description?.backend?.trust_contract === SUPERVISED_NATIVE_CONTRACT;
}
export function descriptionTrustIssue(description, executionTrust) {
  return isSupervisedDescription(description) === (executionTrust === SUPERVISED_NATIVE_TRUST)
    ? null : "execution_trust_mismatch";
}
function requestedAuthority(launch) {
  const readonly = launch.capability === "read-only";
  const roots = readonly ? [] : ["authority_workspace", "task_scratch"];
  return launch.trust_posture === SUPERVISED_NATIVE_TRUST ? {
    capability: launch.capability, assurance: "operator_supervised_cli",
    approvals: "cli_requested_never",
    filesystem: readonly ? "cli_requested_read_only" : "cli_requested_workspace_write",
    network: "not_independently_verified", writable_roots: roots,
    protected_paths: [], escalation: "not_independently_verified", ambient_startup: "trusted_official_cli",
  } : {
    capability: launch.capability, approvals: "denied",
    filesystem: readonly ? "read_only" : "workspace_write", network: "disabled",
    writable_roots: roots, protected_paths: [".git", ".agents", ".codex"], escalation: false,
  };
}
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
      ![undefined, SUPERVISED_NATIVE_TRUST].includes(description.launch.trust_posture) ||
      (description.launch.trust_posture === SUPERVISED_NATIVE_TRUST
        ? backend.trust_contract !== SUPERVISED_NATIVE_CONTRACT : backend.trust_contract !== undefined) ||
      digest(authority) !== digest(requestedAuthority(description.launch)) ||
      description.capabilities?.initial_input !== true ||
      description.capabilities?.structured_output !== true ||
      description.capabilities?.steering !== false ||
      description.capabilities?.session_reuse !== false ||
      description.capabilities?.backend_failover !== false) return "contradictory_execution_description";
  return null;
}
export function executionDescription({ launch, callerMetadata, backend }) {
  const effectiveAuthority = requestedAuthority(launch);
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

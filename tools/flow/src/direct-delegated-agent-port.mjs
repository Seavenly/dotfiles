import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { freezeCanonical, digest } from "./canonical.mjs";
import { claudeExecutionAdapter } from "./claude-execution-adapter.mjs";
import { codexExecutionAdapter } from "./codex-execution-adapter.mjs";
import { directDescriptionIssue, executionDescription, SUPERVISED_NATIVE_TRUST, SUPERVISED_NATIVE_CONTRACT } from "./execution-contract.mjs";

export function executableIdentity(path, adapter, env = process.env, executionTrust) {
  if (!isAbsolute(path)) throw new Error("executable_path_not_absolute");
  const resolved = realpathSync(path);
  const version = execFileSync(resolved, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 8192, env: { PATH: env.PATH ?? process.env.PATH, HOME: env.HOME ?? process.env.HOME, ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}) } }).trim();
  if (version !== (adapter.supportedVersionForTrust?.(executionTrust) ?? adapter.supportedVersion)) throw new Error("unsupported_executable_version");
  return { path: resolved, version, sha256: "sha256:" + createHash("sha256").update(readFileSync(resolved)).digest("hex") };
}
export function createDirectDelegatedAgentPort({
  env = process.env, executables = {}, providers = { codex: codexExecutionAdapter, claude: claudeExecutionAdapter },
  taskDirectory, resolveWorkspace = () => null, executionTrust,
} = {}) {
  if (![undefined, SUPERVISED_NATIVE_TRUST].includes(executionTrust)) throw new TypeError("unsupported_execution_trust");
  const adapters = Object.freeze({ ...providers });
  let taskPort = null;
  const lifecycle = async (operation, request) => {
    if (taskPort === null) {
      const { createDirectTaskPort } = await import("./direct-task-port.mjs");
      taskPort = createDirectTaskPort({ taskDirectory, env, adapters, resolveWorkspace, executionTrust });
    }
    try { return await taskPort[operation](request); }
    catch (error) { return { schema: "flow.task-observation/v1", status: "blocked", reason: { code: /^[a-z_]+$/u.test(error.message) ? error.message : "task_request_invalid" } }; }
  };
  return Object.freeze({
    contract: "flow.delegated-agent-port/v1", backend: "direct",
    // Adapter constructors are trusted host code. Request and environment
    // fields cannot turn source conformance into official native permission.
    nativeAdmissionIssue({ workspacePath } = {}) {
      if (executionTrust === SUPERVISED_NATIVE_TRUST) return process.platform === "linux" ? null : "direct_task_containment_unsupported";
      for (const adapter of Object.values(adapters)) {
        const issue = adapter.nativeQualificationIssue?.();
        if (issue) return adapter.authorityIssue({ env, workspacePath }) ?? issue;
      }
      return null;
    },
    async describe(request) {
      try {
        if (request?.schema !== "flow.delegated-agent-description-request/v1") throw new Error("invalid_description_request");
        const launch = { harness: "codex", model: "gpt-6.1-sol", effort: "high", capability: "read-only", ...request.launch };
        if (Object.hasOwn(launch, "trust_posture")) throw new Error("request_supplied_execution_trust");
        if (executionTrust === SUPERVISED_NATIVE_TRUST) launch.trust_posture = executionTrust;
        if (Object.keys(launch).some((key) => !["harness", "model", "effort", "capability", "role", "trust_posture"].includes(key)) ||
            typeof launch.model !== "string" || !launch.model || !["low", "medium", "high", "xhigh"].includes(launch.effort) ||
            !["read-only", "workspace-write-denied"].includes(launch.capability)) throw new Error("unsupported_execution_capability");
        if (launch.capability === "workspace-write-denied" && process.platform !== "linux") throw new Error("direct_mutation_containment_unsupported");
        const adapter = adapters[launch.harness];
        if (!adapter) throw new Error("unsupported_execution_backend");
        const issue = adapter.authorityIssue({ env, workspacePath: request.workspace_path, executionTrust, launch });
        if (issue) throw new Error(issue);
        const executable = executableIdentity(executables[launch.harness] ?? env[`FLOW_${launch.harness.toUpperCase()}_EXECUTABLE`] ?? findExecutable(launch.harness, env), adapter, env, executionTrust);
        const backend = { contract: "flow.direct-task/v1", id: "direct", harness: launch.harness,
          adapter: adapter.id, adapter_version: adapter.versionForTrust?.(executionTrust) ?? adapter.version, executable, native_session_strategy: "fresh_ephemeral", ...(executionTrust === SUPERVISED_NATIVE_TRUST ? { trust_contract: SUPERVISED_NATIVE_CONTRACT } : {}) };
        const description = executionDescription({ launch, callerMetadata: request.caller_metadata ?? {}, backend });
        const contradiction = directDescriptionIssue(description); if (contradiction) throw new Error(contradiction);
        return freezeCanonical({ schema: "flow.execution-description-projection/v1", status: "compatible",
          watermark: description.watermark, description,
          compatibility: { contract: "flow.delegated-agent-port/v1", code: null, findings: [] }, legal_next_actions: ["bind_exact_launch_description"] });
      } catch (error) {
        return freezeCanonical({ schema: "flow.execution-description-projection/v1", status: "blocked",
          description: null, watermark: null, compatibility: { contract: "flow.delegated-agent-port/v1", code: /^[a-z_]+$/u.test(error.message) ? error.message : "execution_backend_unavailable", findings: [] }, legal_next_actions: [] });
      }
    },
    ...Object.fromEntries(["dispatch", "discover", "observe", "wait", "cancel", "reconcile", "retire"].map((name) => [name, (request) => lifecycle(name, request)])),
    async send() { return { schema: "flow.task-observation/v1", status: "blocked", reason: { code: "unsupported_steering" } }; },
  });
}
function findExecutable(name, env) {
  for (const directory of (env.PATH ?? "").split(":")) {
    try { return realpathSync(join(directory, name)); } catch { /* next PATH entry */ }
  }
  throw new Error("executable_missing");
}

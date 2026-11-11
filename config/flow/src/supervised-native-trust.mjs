import { PROJECT_CHECK_SCOPE } from "../../../tools/flow/src/project-check.mjs";
import {
  SUPERVISED_NATIVE_CONTRACT,
  SUPERVISED_NATIVE_TRUST as SUPERVISED_NATIVE_POSTURE,
} from "../../../tools/flow/src/execution-contract.mjs";

export { SUPERVISED_NATIVE_CONTRACT, SUPERVISED_NATIVE_POSTURE };
export const SUPERVISED_NATIVE_ACKNOWLEDGMENT = Object.freeze({
  schema: SUPERVISED_NATIVE_CONTRACT,
  acknowledgment: "trust-official-cli-permissions",
});

export function executionTrustFromEnvironment(env) {
  const trust = env.FLOW_EXECUTION_TRUST ?? "strict";
  if (!["strict", SUPERVISED_NATIVE_POSTURE].includes(trust)) {
    throw new TypeError("unsupported Flow execution trust posture");
  }
  return trust;
}

export function supervisedTrustPosture(definition, executionTrust, { gitIdentity, projectCheck = false } = {}) {
  if (executionTrust !== SUPERVISED_NATIVE_POSTURE) return definition;
  return {
    ...definition,
    trust_posture: {
      ...definition.trust_posture,
      execution_contract: SUPERVISED_NATIVE_CONTRACT,
      operator_supervision: "required",
      permissions: "requested_cli_permissions_not_independently_enforced",
      ambient_startup: "trusted_official_cli",
      independent_workspace_and_tool_network_enforcement: false,
      qualification: "not_claimed",
      ...(definition.id === "feature/v1" ? {
        ...(gitIdentity === undefined ? {} : { git_identity: gitIdentity }),
        verification_scope: {
          schema: "flow.supervised-verification-scope/v1",
          verify: projectCheck ? PROJECT_CHECK_SCOPE : "Git-backed content observations plus independent model critique; project checks NOT_RUN; runtime behavior not established",
          test: "Registered pinned Node health and acceptance checks with expected RED then GREEN; arbitrary project suites are not registered",
        },
      } : {}),
    },
  };
}

/** The supervised route is a separate contract, never qualification evidence. */
export function supervisedAdmissionIssue({ request, route, executionTrust, backend, operation }) {
  const requested = request?.execution_trust;
  const prepared = request?.prepared;
  const preparedContract = prepared?.trust_posture?.execution_contract;
  if (executionTrust !== SUPERVISED_NATIVE_POSTURE) {
    return requested !== undefined || preparedContract === SUPERVISED_NATIVE_CONTRACT
      ? "supervised_execution_not_enabled" : null;
  }
  if (!requested || typeof requested !== "object" || Array.isArray(requested) ||
      Object.keys(requested).sort().join(",") !== "acknowledgment,schema" ||
      requested.schema !== SUPERVISED_NATIVE_CONTRACT ||
      requested.acknowledgment !== SUPERVISED_NATIVE_ACKNOWLEDGMENT.acknowledgment) {
    return "supervised_acknowledgment_required";
  }
  if (request.dark_opt_in !== undefined) return "conflicting_execution_contracts";
  if (process.platform !== "linux" || backend !== "direct") {
    return "supervised_backend_unsupported";
  }
  if (!(route.flow === "feature" && ["verify", "test"].includes(route.mode) ||
      route.flow === "review" && route.mode === "local" ||
      route.flow === "spike" && route.mode === "quick" && (request.schema === "flow.research-preparation-request/v1" || request.prepared?.definition?.id === "spike/v2"))) {
    return "supervised_route_unsupported";
  }
  if (operation === "launch") {
    if (preparedContract !== SUPERVISED_NATIVE_CONTRACT) {
      return "supervised_preparation_required";
    }
    const descriptions = collectDescriptions(prepared?.selection?.inputs);
    if (descriptions.length === 0 || descriptions.some((description) =>
      description.backend?.trust_contract !== SUPERVISED_NATIVE_CONTRACT ||
      description.launch?.trust_posture !== SUPERVISED_NATIVE_POSTURE)) {
      return "supervised_route_binding_mismatch";
    }
  }
  return null;
}

function collectDescriptions(value) {
  if (value === null || typeof value !== "object") return [];
  if (value.schema === "flow.execution-description/v1") return [value];
  return Object.values(value).flatMap(collectDescriptions);
}

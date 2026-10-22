import {
  openTask as openDrovrTask,
} from "../../drovr/src/task-open.mjs";
import {
  startAgent as startDrovrAgent,
} from "../../drovr/src/agent-start.mjs";
import {
  retireAgent as retireDrovrAgent,
  closeGroup as closeDrovrGroup,
} from "../../drovr/src/lifecycle.mjs";
import {
  readRegistrySnapshot as readDrovrRegistrySnapshot,
  stateDirectory,
} from "../../drovr/src/registry.mjs";

import {
  digest,
  freezeCanonical,
  isPlainRecord,
} from "./canonical.mjs";

export const DELEGATED_AGENT_RESOURCE_PORT_CONTRACT =
  "flow.delegated-agent-resource-port/v1";
export const DELEGATED_AGENT_RESOURCE_ENSURE_REQUEST_SCHEMA =
  "flow.delegated-agent-resource-ensure-request/v1";
export const DELEGATED_AGENT_RESOURCE_RETIRE_REQUEST_SCHEMA =
  "flow.delegated-agent-resource-retire-request/v1";
export const DELEGATED_AGENT_RESOURCE_PROJECTION_SCHEMA =
  "flow.delegated-agent-resource-projection/v1";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const LAUNCH_KEYS = ["harness", "role", "model", "effort", "capability"];

/**
 * Return the stable identity of a delegated resource. Attempt ordinals are
 * deliberately absent so a retry adopts the same task and agent. The run ID
 * prevents a later run from selecting an earlier run's resource by accident.
 */
export function deriveDelegatedAgentResourceKey(request) {
  const normalized = normalizeIdentityRequest(request);
  const scopedOwner = {
    run_id: normalized.owner.run_id,
    scope: normalized.owner.managed_agent_binding_id ??
      normalized.owner.card_id,
    ...(normalized.owner.managed_agent_binding_id === undefined
      ? { route_key: normalized.owner.route_key }
      : {}),
  };
  return digest({
    schema: "flow.delegate-resource-identity/v1",
    owner: scopedOwner,
    workspace_claim: resourceIdentityWorkspace(normalized),
    launch_binding: normalized.launch_binding,
  });
}

function resourceIdentityWorkspace(request) {
  if (request.owner.managed_agent_binding_id === undefined) {
    return request.workspace_claim;
  }
  const { operation: _operation, ...workspace } = request.workspace_claim;
  return workspace;
}

function resourceBindingOwner(request) {
  if (request.owner.managed_agent_binding_id === undefined) return request.owner;
  return {
    ...request.owner,
    card_id: request.owner.managed_agent_binding_id,
    route_key: request.owner.managed_agent_binding_id,
  };
}

export class DelegatedAgentResourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DelegatedAgentResourceError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The resource Interface has only ensure and retire. The Adapter hides
 * Drovr registry locks, task/agent keys, canonical workspace resolution, and
 * crash recovery behind those two replay-safe operations.
 */
export function createDrovrDelegatedAgentResourcePort({
  resolveWorkspace,
  dependencies = {},
  openTask = openDrovrTask,
  startAgent = startDrovrAgent,
  retireAgent = retireDrovrAgent,
  readRegistrySnapshot = readDrovrRegistrySnapshot,
  closeGroup = closeDrovrGroup,
} = {}) {
  if (typeof resolveWorkspace !== "function") {
    throw new TypeError(
      "DelegatedAgentResourcePort requires an injected workspace resolver",
    );
  }
  for (const [name, implementation] of Object.entries({
    openTask,
    startAgent,
    retireAgent,
    readRegistrySnapshot,
    closeGroup,
  })) {
    if (typeof implementation !== "function") {
      throw new TypeError(`DelegatedAgentResourcePort requires ${name}`);
    }
  }

  return Object.freeze({
    contract: DELEGATED_AGENT_RESOURCE_PORT_CONTRACT,

    async ensure(request) {
      let normalized;
      try {
        normalized = normalizeEnsureRequest(request);
      } catch (error) {
        return blockedProjection({
          operation: "ensure",
          request,
          code: error.code ?? "invalid_resource_request",
          message: error.message,
          legalNextActions: [],
        });
      }

      const resourceKey = deriveDelegatedAgentResourceKey(normalized);
      if (request.resource_key !== undefined &&
          request.resource_key !== resourceKey) {
        return blockedProjection({
          operation: "ensure",
          request: normalized,
          resourceKey,
          code: "resource_key_conflict",
          message: "caller resource key does not match immutable resource identity",
          legalNextActions: ["reconcile_delegated_resource"],
        });
      }

      let workspace;
      try {
        workspace = await resolveWorkspace(
          structuredClone(normalized.workspace_claim),
          structuredClone(normalized),
        );
        validateResolvedWorkspace(workspace, normalized.workspace_claim);
      } catch (error) {
        return blockedProjection({
          operation: "ensure",
          request: normalized,
          resourceKey,
          code: error.code ?? "workspace_claim_uncertain",
          message: error.message ?? "workspace claim could not be resolved",
          legalNextActions: workspaceActions(error.code),
        });
      }

      const keys = resourceKeys(resourceKey);
      let taskResult;
      try {
        taskResult = await openTask({
          group: keys.group_key,
          groupLabel: `${normalized.owner.run_id} delegated resource`,
          key: keys.task_key,
          label: keys.task_key,
          cwd: workspace.canonical_path,
        }, dependencies);
        validateTaskResult(taskResult, keys, workspace);
      } catch (error) {
        return blockedProjection({
          operation: "ensure",
          request: normalized,
          resourceKey,
          code: resourceErrorCode(error, "task"),
          message: error.message ?? "delegated resource task could not be opened",
          legalNextActions: resourceActions(resourceErrorCode(error, "task")),
        });
      }

      let agentResult;
      try {
        agentResult = await startAgent(taskResult.task.id, {
          ...structuredClone(normalized.launch),
          key: keys.agent_key,
          label: keys.agent_key,
          group_key: keys.group_key,
          task_key: keys.task_key,
        }, dependencies);
        validateAgentResult(
          agentResult,
          taskResult,
          normalized,
          keys,
        );
      } catch (error) {
        return blockedProjection({
          operation: "ensure",
          request: normalized,
          resourceKey,
          code: resourceErrorCode(error, "agent"),
          message: error.message ?? "delegated resource agent could not be started",
          legalNextActions: resourceActions(resourceErrorCode(error, "agent")),
        });
      }

      let observation;
      try {
        observation = await observeResource(
          readRegistrySnapshot,
          dependencies,
          keys,
        );
        validateReadyObservation(
          observation,
          taskResult,
          agentResult,
          normalized,
          keys,
        );
      } catch (error) {
        return blockedProjection({
          operation: "ensure",
          request: normalized,
          resourceKey,
          delegation: {
            group_id: taskResult.group.id,
            task_id: taskResult.task.id,
            agent_id: agentResult.agent.id,
          },
          code: resourceErrorCode(error, "inspect"),
          message: error.message ?? "delegated resource identity is uncertain",
          legalNextActions: resourceActions(
            resourceErrorCode(error, "inspect"),
          ),
          watermark: error?.authority_watermark ?? null,
        });
      }

      return readyProjection({
        operation: "ensure",
        request: normalized,
        resourceKey,
        workspace,
        taskResult,
        agentResult,
        keys,
        observation,
      });
    },

    async retire(request) {
      let normalized;
      try {
        normalized = normalizeRetireRequest(request);
      } catch (error) {
        return blockedProjection({
          operation: "retire",
          request,
          code: error.code ?? "invalid_resource_request",
          message: error.message,
          legalNextActions: [],
        });
      }

      const resourceKey = deriveDelegatedAgentResourceKey(normalized);
      if (normalized.binding.resource_key !== resourceKey) {
        return blockedProjection({
          operation: "retire",
          request: normalized,
          resourceKey,
          code: "resource_key_conflict",
          message: "retirement resource key does not match immutable resource identity",
          legalNextActions: ["reconcile_delegated_resource"],
        });
      }

      const keys = resourceKeys(resourceKey);
      let observed;
      try {
        observed = await observeResource(
          readRegistrySnapshot,
          dependencies,
          keys,
        );
        validateRetirementObservation(
          observed,
          normalized.binding.delegation,
          keys,
        );
      } catch (error) {
        return blockedProjection({
          operation: "retire",
          request: normalized,
          resourceKey,
          delegation: normalized.binding.delegation,
          code: resourceErrorCode(error, "retire"),
          message: error.message ?? "delegated resource identity is uncertain",
          legalNextActions: resourceActions(
            resourceErrorCode(error, "retire"),
          ),
          watermark: error?.authority_watermark ?? null,
        });
      }

      if (observed.status === "partial") {
        return blockedProjection({
          operation: "retire",
          request: normalized,
          resourceKey,
          code: "resource_retirement_uncertain",
          message: "delegated resource is only partially represented in Drovr",
          legalNextActions: ["reconcile_exact_agent_retirement"],
          watermark: observed.authority_watermark,
        });
      }

      let agentRetirement = null;
      if (observed.agent.status === "active") {
        try {
          agentRetirement = await retireAgent(observed.agent.id, dependencies);
          validateAgentRetirementResult(agentRetirement, observed.delegation);
        } catch (error) {
          return blockedProjection({
            operation: "retire",
            request: normalized,
            resourceKey,
            delegation: observed.delegation,
            code: resourceErrorCode(error, "retire"),
            message: error.message ?? "delegated agent retirement is uncertain",
            legalNextActions: resourceActions(
              resourceErrorCode(error, "retire"),
            ),
            watermark: observed.authority_watermark,
          });
        }
      }

      try {
        const result = await closeGroup(observed.group.id, dependencies);
        validateGroupRetirementResult(result, observed);
      } catch (error) {
        return blockedProjection({
          operation: "retire",
          request: normalized,
          resourceKey,
          delegation: observed.delegation,
          code: resourceErrorCode(error, "retire"),
          message: error.message ?? "delegated resource retirement is uncertain",
          legalNextActions: resourceActions(
            resourceErrorCode(error, "retire"),
          ),
          watermark: observed.authority_watermark,
        });
      }

      let retired;
      try {
        retired = await observeResource(
          readRegistrySnapshot,
          dependencies,
          keys,
        );
        validateRetiredObservation(retired, observed);
      } catch (error) {
        return blockedProjection({
          operation: "retire",
          request: normalized,
          resourceKey,
          delegation: observed.delegation,
          code: "resource_retirement_uncertain",
          message: error.message ?? "delegated resource retirement is uncertain",
          legalNextActions: ["reconcile_exact_agent_retirement"],
          watermark: error?.authority_watermark ?? observed.authority_watermark,
        });
      }

      const delegation = retired.delegation ?? observed.delegation;
      const binding = normalized.binding;
      return freezeCanonical({
        schema: DELEGATED_AGENT_RESOURCE_PROJECTION_SCHEMA,
        operation: "retire",
        status: "retired",
        resource_key: resourceKey,
        binding,
        binding_digest: binding.binding_digest,
        delegation,
        watermark: resourceWatermark(resourceKey, retired),
        cleanup_receipt: {
          schema: "flow.delegated-agent-resource-cleanup-receipt/v1",
          proof: "exact_group_closed",
          group_id: retired.group.id,
          task_id: retired.task?.id ?? null,
          agent_id: retired.agent?.id ?? null,
          authority_watermark: retired.authority_watermark,
          ...(agentRetirement?.agent?.cleanup_receipt === undefined ? {} : {
            agent_retirement: agentRetirement.agent.cleanup_receipt,
          }),
        },
        reason: null,
        legal_next_actions: [],
      });
    },
  });
}

export function snapshotDelegatedAgentResourcePort(port) {
  if (port === null) return null;
  return Object.freeze({
    contract: port?.contract,
    ensure: typeof port?.ensure === "function"
      ? port.ensure.bind(port)
      : port?.ensure,
    retire: typeof port?.retire === "function"
      ? port.retire.bind(port)
      : port?.retire,
  });
}

function normalizeIdentityRequest(request) {
  if (!isPlainRecord(request) || !isPlainRecord(request.owner) ||
      !isPlainRecord(request.workspace_claim) ||
      !isPlainRecord(request.launch_binding)) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource request requires owner, workspace claim, and launch binding",
    );
  }
  const owner = request.owner;
  if (typeof owner.run_id !== "string" || owner.run_id.length === 0 ||
      typeof owner.card_id !== "string" || owner.card_id.length === 0 ||
      typeof owner.route_key !== "string" || owner.route_key.length === 0 ||
      owner.managed_agent_binding_id !== undefined &&
        (typeof owner.managed_agent_binding_id !== "string" ||
         owner.managed_agent_binding_id.length === 0)) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource owner identity is incomplete",
    );
  }
  const workspaceClaim = normalizeWorkspaceClaim(request.workspace_claim);
  const launchBinding = normalizeLaunchBinding(request.launch_binding);
  return {
    owner: {
      run_id: owner.run_id,
      card_id: owner.card_id,
      route_key: owner.route_key,
      ...(owner.managed_agent_binding_id === undefined ? {} : {
        managed_agent_binding_id: owner.managed_agent_binding_id,
      }),
    },
    workspace_claim: workspaceClaim,
    launch_binding: launchBinding,
  };
}

function normalizeEnsureRequest(request) {
  if (request?.schema !== DELEGATED_AGENT_RESOURCE_ENSURE_REQUEST_SCHEMA ||
      Object.hasOwn(request, "cwd")) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource ensure request has an invalid schema or caller cwd",
    );
  }
  const normalized = normalizeIdentityRequest(request);
  if (!isPlainRecord(request.launch)) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource ensure request requires an exact launch",
    );
  }
  return {
    ...normalized,
    launch: structuredClone(request.launch),
  };
}

function normalizeRetireRequest(request) {
  if (request?.schema !== DELEGATED_AGENT_RESOURCE_RETIRE_REQUEST_SCHEMA) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource retire request has an invalid schema",
    );
  }
  const binding = request.binding;
  if (!isPlainRecord(binding) ||
      binding.schema !== "flow.delegated-agent-resource-binding/v1" ||
      !DIGEST_PATTERN.test(binding.resource_key ?? "") ||
      !DIGEST_PATTERN.test(binding.binding_digest ?? "") ||
      !DIGEST_PATTERN.test(binding.managed_runtime_evidence_digest ?? "") ||
      !isPlainRecord(binding.delegation) ||
      !nonEmpty(binding.delegation.group_id) ||
      !nonEmpty(binding.delegation.task_id) ||
      !nonEmpty(binding.delegation.agent_id)) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource retirement requires exact delegation identity",
    );
  }
  const normalized = normalizeIdentityRequest(binding);
  const expectedBindingDigest = digest({
    resource_key: binding.resource_key,
    owner: normalized.owner,
    workspace_claim: normalized.workspace_claim,
    launch_binding: normalized.launch_binding,
    delegation: binding.delegation,
    native_session: binding.native_session,
    managed_runtime_evidence_digest: binding.managed_runtime_evidence_digest,
  });
  if (binding.binding_digest !== expectedBindingDigest) {
    throw new DelegatedAgentResourceError(
      "resource_binding_conflict",
      "delegated resource retirement binding digest does not match",
    );
  }
  return { ...normalized, binding: structuredClone(binding) };
}

function normalizeWorkspaceClaim(claim) {
  if (!isPlainRecord(claim) || claim.kind !== "workspace" ||
      claim.authority !== "WorkspaceAuthority" ||
      claim.contract !== "work.workspace/v1" ||
      !nonEmpty(claim.subject_id) ||
      !Number.isSafeInteger(claim.generation) || claim.generation < 1 ||
      !Number.isSafeInteger(claim.mutation_epoch) || claim.mutation_epoch < 1 ||
      !DIGEST_PATTERN.test(claim.fingerprint) ||
      !["mutation", "read_only"].includes(claim.access) ||
      claim.operation !== undefined && !nonEmpty(claim.operation)) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource workspace claim is incomplete",
    );
  }
  return {
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: claim.subject_id,
    generation: claim.generation,
    mutation_epoch: claim.mutation_epoch,
    fingerprint: claim.fingerprint,
    access: claim.access,
    ...(claim.operation === undefined ? {} : { operation: claim.operation }),
  };
}

function normalizeLaunchBinding(binding) {
  if (!isPlainRecord(binding) ||
      !DIGEST_PATTERN.test(binding.description_digest) ||
      !DIGEST_PATTERN.test(binding.launch_comparison_key) ||
      !DIGEST_PATTERN.test(binding.effective_authority_comparison_key) ||
      !DIGEST_PATTERN.test(binding.configuration_watermark)) {
    throw new DelegatedAgentResourceError(
      "invalid_resource_request",
      "delegated resource launch binding is incomplete",
    );
  }
  return {
    description_digest: binding.description_digest,
    launch_comparison_key: binding.launch_comparison_key,
    effective_authority_comparison_key:
      binding.effective_authority_comparison_key,
    configuration_watermark: binding.configuration_watermark,
  };
}

function validateResolvedWorkspace(workspace, claim) {
  if (!isPlainRecord(workspace) ||
      workspace.subject_id !== claim.subject_id ||
      workspace.generation !== claim.generation ||
      workspace.mutation_epoch !== claim.mutation_epoch ||
      workspace.fingerprint !== claim.fingerprint ||
      !nonEmpty(workspace.canonical_path) ||
      !nonEmpty(workspace.repository_id)) {
    throw new DelegatedAgentResourceError(
      "workspace_claim_stale",
      "WorkspaceAuthority did not return the exact claimed workspace",
    );
  }
}

function resourceKeys(resourceKey) {
  const suffix = resourceKey.slice("sha256:".length);
  return {
    group_key: `flow-delegate-resource-group:${suffix}`,
    task_key: `flow-delegate-resource-task:${suffix}`,
    agent_key: `flow-delegate-resource-agent:${suffix}`,
  };
}

function validateTaskResult(result, keys, workspace) {
  if (!isPlainRecord(result) || !isPlainRecord(result.group) ||
      !isPlainRecord(result.task) || !nonEmpty(result.group.id) ||
      result.group.key !== keys.group_key ||
      !nonEmpty(result.task.id) || result.task.group_id !== result.group.id ||
      result.task.key !== keys.task_key || result.task.cwd !== workspace.canonical_path ||
      result.task.status !== "active") {
    throw new DelegatedAgentResourceError(
      "resource_key_conflict",
      "Drovr returned a task that is not the exact resource task",
    );
  }
}

function validateAgentResult(result, taskResult, request, keys) {
  const agent = result?.agent;
  const task = result?.task ?? taskResult.task;
  const group = result?.group ?? taskResult.group;
  if (!isPlainRecord(agent) || !isPlainRecord(task) || !isPlainRecord(group) ||
      !nonEmpty(agent.id) || agent.task_id !== taskResult.task.id ||
      task.id !== taskResult.task.id || task.group_id !== taskResult.group.id ||
      task.key !== keys.task_key || task.status !== "active" ||
      task.cwd !== taskResult.task.cwd ||
      group.id !== taskResult.group.id || group.key !== keys.group_key ||
      agent.key !== keys.agent_key ||
      agent.status !== "active") {
    throw new DelegatedAgentResourceError(
      "resource_key_conflict",
      "Drovr returned an agent outside the exact resource task",
    );
  }
  if (!isPlainRecord(agent.launch) ||
      LAUNCH_KEYS.some((key) => agent.launch[key] !== request.launch[key])) {
    throw new DelegatedAgentResourceError(
      "launch_binding_conflict",
      "Drovr returned an agent with a different launch",
    );
  }
  if (!isPlainRecord(agent.launch_binding) ||
      agent.launch_binding.comparison_key !==
        request.launch_binding.launch_comparison_key ||
      agent.launch_binding.configuration_watermark !==
        request.launch_binding.configuration_watermark) {
    throw new DelegatedAgentResourceError(
      "launch_binding_conflict",
      "Drovr returned an agent with a different launch binding",
    );
  }
  const managedRuntimeIdentity = agent.launch_binding.managed_runtime_identity;
  const managedRuntimeEvidenceDigest =
    agent.launch_binding.managed_runtime_evidence_digest;
  if (!DIGEST_PATTERN.test(managedRuntimeEvidenceDigest ?? "") ||
      !nonEmpty(agent.native_session) &&
      (!isPlainRecord(managedRuntimeIdentity) ||
       !nonEmpty(managedRuntimeIdentity.managed_agent) ||
       !nonEmpty(managedRuntimeIdentity.pane_id) ||
       !isPlainRecord(managedRuntimeIdentity.process) ||
       !Number.isSafeInteger(managedRuntimeIdentity.process.pid) ||
       managedRuntimeIdentity.native_session !== null)) {
    throw new DelegatedAgentResourceError(
      "native_session_identity_conflict",
      "Drovr returned neither a native session nor an exact provisional managed runtime identity",
    );
  }
  if (managedRuntimeIdentity !== undefined &&
      (!isPlainRecord(managedRuntimeIdentity) ||
       digest(managedRuntimeIdentity) !== managedRuntimeEvidenceDigest)) {
    throw new DelegatedAgentResourceError(
      "native_session_identity_conflict",
      "Drovr returned a managed runtime digest that does not bind its identity",
    );
  }
  if (nonEmpty(agent.native_session) && managedRuntimeIdentity !== undefined &&
      managedRuntimeIdentity?.native_session !==
        agent.native_session) {
    throw new DelegatedAgentResourceError(
      "native_session_identity_conflict",
      "Drovr returned a native session different from its launch binding",
    );
  }
}

async function observeResource(readRegistrySnapshot, dependencies, keys) {
  const env = dependencies.env ?? process.env;
  const snapshot = await readRegistrySnapshot(stateDirectory(env));
  const authorityWatermark = snapshot?.authority_watermark;
  if (!isPlainRecord(snapshot) || !isPlainRecord(authorityWatermark)) {
    throw new DelegatedAgentResourceError(
      "resource_provisioning_uncertain",
      "Drovr did not return a stable registry authority watermark",
    );
  }
  const groups = (snapshot.groups ?? []).filter(({ key }) =>
    key === keys.group_key);
  const tasksByKey = (snapshot.tasks ?? []).filter(({ key }) =>
    key === keys.task_key);
  const agentsByKey = (snapshot.agents ?? []).filter(({ key }) =>
    key === keys.agent_key);
  const conflict = (message) => {
    const error = new DelegatedAgentResourceError(
      "resource_key_conflict",
      message,
    );
    error.authority_watermark = authorityWatermark;
    throw error;
  };
  if (groups.length > 1 || tasksByKey.length > 1 || agentsByKey.length > 1) {
    conflict("Drovr registry contains duplicate delegated resource keys");
  }
  const group = groups[0] ?? null;
  const task = tasksByKey[0] ?? null;
  const agent = agentsByKey[0] ?? null;
  if (group === null) {
    if (task !== null || agent !== null) {
      conflict("Drovr registry contains an orphaned delegated resource");
    }
    return {
      status: "proven_absent",
      group: null,
      task: null,
      agent: null,
      delegation: null,
      authority_watermark: authorityWatermark,
    };
  }
  if (task !== null && task.group_id !== group.id ||
      agent !== null && (task === null || agent.task_id !== task.id)) {
    conflict("Drovr registry delegated resource ownership is inconsistent");
  }
  return {
    status: agent === null ? "partial" :
      group.status === "active" && task?.status === "active" &&
        agent.status === "active" ? "ready" : "retired",
    group,
    task,
    agent,
    delegation: agent === null ? null : {
      group_id: group.id,
      task_id: task.id,
      agent_id: agent.id,
    },
    authority_watermark: authorityWatermark,
  };
}

function validateReadyObservation(
  observation,
  taskResult,
  agentResult,
  request,
  keys,
) {
  if (observation.status !== "ready" ||
      observation.group?.id !== taskResult.group.id ||
      observation.task?.id !== taskResult.task.id ||
      observation.agent?.id !== agentResult.agent.id) {
    throw new DelegatedAgentResourceError(
      "resource_provisioning_uncertain",
      "Drovr registry did not retain the exact provisioned resource",
    );
  }
  validateAgentResult({
    group: observation.group,
    task: observation.task,
    agent: observation.agent,
  }, taskResult, request, keys);
  if (observation.agent.launch_binding
      .managed_runtime_evidence_digest !==
      agentResult.agent.launch_binding.managed_runtime_evidence_digest ||
      observation.agent.native_session !== agentResult.agent.native_session ||
      digest(observation.agent.launch_binding.managed_runtime_identity ?? null) !==
        digest(agentResult.agent.launch_binding.managed_runtime_identity ?? null)) {
    throw new DelegatedAgentResourceError(
      "native_session_identity_conflict",
      "Drovr re-observation did not retain the exact managed runtime identity",
    );
  }
}

function validateRetirementObservation(observation, delegation, keys) {
  if (!isPlainRecord(observation?.authority_watermark)) {
    throw new DelegatedAgentResourceError(
      "resource_retirement_uncertain",
      "Drovr registry authority could not be observed for retirement",
    );
  }
  if (delegation !== null && observation.status !== "partial" &&
      (observation.status === "proven_absent" ||
       observation.delegation?.group_id !== delegation.group_id ||
       observation.delegation?.task_id !== delegation.task_id ||
       observation.delegation?.agent_id !== delegation.agent_id)) {
    const error = new DelegatedAgentResourceError(
      observation.status === "proven_absent"
        ? "resource_retirement_uncertain"
        : "resource_key_conflict",
      observation.status === "proven_absent"
        ? "Drovr registry absence cannot prove retirement of an exact bound resource"
        : "retirement delegation does not match the exact registry resource",
    );
    error.authority_watermark = observation.authority_watermark;
    throw error;
  }
  if (observation.group !== null && observation.group.key !== keys.group_key ||
      observation.task !== null && observation.task.key !== keys.task_key ||
      observation.agent !== null && observation.agent.key !== keys.agent_key) {
    throw new DelegatedAgentResourceError(
      "resource_key_conflict",
      "retirement observation does not match deterministic resource keys",
    );
  }
}

function validateAgentRetirementResult(result, delegation) {
  if (!isPlainRecord(result) || result.status !== "retired" ||
      result.group?.id !== delegation.group_id ||
      result.task?.id !== delegation.task_id ||
      result.agent?.id !== delegation.agent_id ||
      !isPlainRecord(result.agent.cleanup_receipt)) {
    throw new DelegatedAgentResourceError(
      "resource_retirement_uncertain",
      "Drovr did not prove exact delegated agent retirement",
    );
  }
}

function validateGroupRetirementResult(result, observation) {
  if (!isPlainRecord(result) || result.status !== "closed" ||
      result.group?.id !== observation.group.id) {
    throw new DelegatedAgentResourceError(
      "resource_retirement_uncertain",
      "Drovr did not prove exact delegated resource group closure",
    );
  }
}

function validateRetiredObservation(retired, before) {
  if (retired.status !== "retired" ||
      retired.group?.id !== before.group.id ||
      retired.group.status !== "closed" ||
      before.task !== null &&
        (retired.task?.id !== before.task.id || retired.task.status !== "closed") ||
      before.agent !== null &&
        (retired.agent?.id !== before.agent.id ||
         retired.agent.status !== "retired")) {
    throw new DelegatedAgentResourceError(
      "resource_retirement_uncertain",
      "Drovr registry did not retain exact delegated resource closure",
    );
  }
}

function readyProjection({
  operation,
  request,
  resourceKey,
  workspace,
  taskResult,
  agentResult,
  keys,
  observation,
}) {
  const delegation = {
    group_id: taskResult.group.id,
    task_id: taskResult.task.id,
    agent_id: agentResult.agent.id,
  };
  const binding = bindingFor({
    request,
    resourceKey,
    delegation,
    native_session: agentResult.agent.native_session ?? null,
    managed_runtime_evidence_digest:
      agentResult.agent.launch_binding.managed_runtime_evidence_digest ?? null,
  });
  return freezeCanonical({
    schema: DELEGATED_AGENT_RESOURCE_PROJECTION_SCHEMA,
    operation,
    status: "ready",
    resource_key: resourceKey,
    binding,
    binding_digest: binding.binding_digest,
    delegation,
    watermark: resourceWatermark(resourceKey, observation),
    workspace: {
      subject_id: workspace.subject_id,
      generation: workspace.generation,
      mutation_epoch: workspace.mutation_epoch,
      fingerprint: workspace.fingerprint,
    },
    reason: null,
    legal_next_actions: ["dispatch_exact_turn", "retire_exact_resource"],
    resource_keys: keys,
  });
}

function bindingFor({
  request,
  resourceKey,
  delegation,
  native_session,
  managed_runtime_evidence_digest,
}) {
  return {
    schema: "flow.delegated-agent-resource-binding/v1",
    resource_key: resourceKey,
    owner: resourceBindingOwner(request),
    workspace_claim: resourceIdentityWorkspace(request),
    launch_binding: request.launch_binding,
    delegation,
    native_session,
    managed_runtime_evidence_digest,
    binding_digest: digest({
      resource_key: resourceKey,
      owner: resourceBindingOwner(request),
      workspace_claim: resourceIdentityWorkspace(request),
      launch_binding: request.launch_binding,
      delegation,
      native_session,
      managed_runtime_evidence_digest,
    }),
  };
}

function resourceWatermark(resourceKey, records) {
  if (records.delegation === null) return records.authority_watermark;
  return {
    schema: "flow.delegated-agent-resource-watermark/v1",
    authority: "drovr.registry",
    resource_key: resourceKey,
    group_id: records.group.id,
    task_id: records.task.id,
    agent_id: records.agent.id,
    record_sha256: digest(records),
    authority_watermark: records.authority_watermark,
  };
}

function blockedProjection({
  operation,
  request,
  resourceKey = null,
  delegation = null,
  code,
  message,
  legalNextActions,
  watermark = null,
}) {
  return freezeCanonical({
    schema: DELEGATED_AGENT_RESOURCE_PROJECTION_SCHEMA,
    operation,
    status: "blocked",
    resource_key: resourceKey,
    binding: null,
    binding_digest: null,
    delegation,
    watermark,
    cleanup_receipt: null,
    reason: {
      code,
      message: typeof message === "string" ? message : code,
    },
    legal_next_actions: legalNextActions,
    ...(request?.owner ? { owner: request.owner } : {}),
  });
}

function resourceErrorCode(error, stage) {
  if (error?.code && /^[a-z0-9_:-]+$/u.test(error.code) &&
      error.code !== "ERR_INVALID_ARG_TYPE") return error.code;
  if (stage === "retire") return "resource_retirement_uncertain";
  if (stage === "inspect") return "resource_provisioning_uncertain";
  if (stage === "agent") {
    if (["recovery_blocked", "uncertain", "adapter_failure"].includes(
      error?.outcome,
    )) return "native_session_identity_conflict";
    if (error?.outcome === "compatibility_blocked") {
      return "launch_binding_conflict";
    }
    return "resource_provisioning_uncertain";
  }
  if (stage === "task" && error?.outcome === "configuration_conflict") {
    return "workspace_configuration_conflict";
  }
  if (error?.outcome === "registry_lock_recovery_required") {
    return "resource_provisioning_uncertain";
  }
  return stage === "task"
    ? "resource_provisioning_uncertain"
    : "resource_retirement_uncertain";
}

function resourceActions(code) {
  if (code === "workspace_claim_stale" ||
      code === "workspace_configuration_conflict") {
    return ["revalidate_workspace_claim"];
  }
  if (code === "launch_binding_conflict") {
    return ["refresh_delegated_runtime_description"];
  }
  if (code === "native_session_identity_conflict") {
    return ["reconcile_managed_agent_identity"];
  }
  if (code === "resource_retirement_uncertain") {
    return ["reconcile_exact_agent_retirement"];
  }
  return ["repair_delegated_runtime_registry"];
}

function workspaceActions(code) {
  return code === "workspace_claim_stale"
    ? ["revalidate_workspace_claim"]
    : ["reconcile_workspace_authority"];
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

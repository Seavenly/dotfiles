import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  createDrovrDelegatedAgentResourcePort,
  deriveDelegatedAgentResourceKey,
} from "../src/drovr-delegated-agent-resource-port.mjs";
import { digest } from "../src/canonical.mjs";
import {
  dispatchDelegateEffect,
} from "../src/delegate-effects.mjs";
import { validateDelegateEvidenceSafety } from "../src/evidence-safety.mjs";
import {
  completedTurnProjection,
} from "../test-support/delegate-card.mjs";
import {
  repositoryDrovrDependencies,
  supportedDescription,
} from "../test-support/delegated-agent-description.mjs";

const workspaceClaim = {
  schema: "flow.delegate-execution-resource-selection/v1",
  kind: "workspace",
  authority: "WorkspaceAuthority",
  contract: "work.workspace/v1",
  subject_id: "workspace:issue-44",
  generation: 7,
  mutation_epoch: 3,
  fingerprint: `sha256:${"a".repeat(64)}`,
  access: "mutation",
  operation: "feature-apply",
  authority_binding_id: "resource:facts",
};

const launchBinding = {
  description_digest: `sha256:${"b".repeat(64)}`,
  launch_comparison_key: `sha256:${"c".repeat(64)}`,
  effective_authority_comparison_key: `sha256:${"d".repeat(64)}`,
  configuration_watermark: `sha256:${"e".repeat(64)}`,
};
const managedRuntimeEvidenceDigest = `sha256:${"f".repeat(64)}`;

const request = {
  schema: "flow.delegated-agent-resource-ensure-request/v1",
  owner: {
    run_id: "run:issue-44",
    card_id: "feature-apply",
    managed_agent_binding_id: "feature-apply-slices",
    route_key: "agent:logical-apply",
  },
  workspace_claim: workspaceClaim,
  launch: {
    harness: "codex",
    role: "apply",
    model: "gpt-5.6",
    effort: "high",
    capability: "workspace-write",
  },
  launch_binding: launchBinding,
};

function retirementRequest(binding) {
  return {
    schema: "flow.delegated-agent-resource-retire-request/v1",
    binding,
  };
}

function resourceAdapter(overrides = {}) {
  const observed = {
    group: null,
    task: null,
    agent: null,
  };
  const defaultResolveWorkspace = async (claim) => ({
    subject_id: claim.subject_id,
    generation: claim.generation,
    mutation_epoch: claim.mutation_epoch,
    fingerprint: claim.fingerprint,
    canonical_path: "/workspace/issue-44",
    repository_id: "repository:issue-44",
    ref: "refs/heads/ticket/44-real-mixed-delegation",
  });
  const defaultOpenTask = async (options) => ({
    group: {
      id: "group:resource",
      key: options.group,
      status: "active",
    },
    task: {
      id: "task:resource",
      group_id: "group:resource",
      key: options.key,
      cwd: options.cwd,
      status: "active",
    },
  });
  const defaultStartAgent = async (taskId, options) => ({
    group: {
      id: "group:resource",
      key: options.group_key,
      status: "active",
    },
    task: {
      id: taskId,
      group_id: "group:resource",
      key: options.task_key,
      cwd: "/workspace/issue-44",
      status: "active",
    },
    agent: {
      id: "agent:actual-resource-id",
      task_id: taskId,
      key: options.key,
      status: "active",
      launch: request.launch,
      launch_binding: {
        comparison_key: launchBinding.launch_comparison_key,
        configuration_watermark: launchBinding.configuration_watermark,
        managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
      },
      native_session: "native:issue-44",
    },
  });
  const defaultRetireAgent = async (agentId) => ({
    status: "retired",
    group: { id: "group:resource" },
    task: { id: "task:resource" },
    agent: {
      id: agentId,
      task_id: "task:resource",
      status: "retired",
      native_session: "native:issue-44",
      cleanup_receipt: {
        schema: "drovr.agent-retirement-receipt/v1",
        proof: "exact_identity_and_pane_close",
      },
    },
  });
  const {
    resolveWorkspace = defaultResolveWorkspace,
    openTask: openTaskOverride,
    startAgent: startAgentOverride,
    retireAgent: retireAgentOverride,
    readRegistrySnapshot: readSnapshotOverride,
    closeGroup: closeGroupOverride,
  } = overrides;
  const openTask = async (options, dependencies) => {
    const result = await (openTaskOverride ?? defaultOpenTask)(
      options,
      dependencies,
    );
    observed.group = structuredClone(result.group);
    observed.task = structuredClone(result.task);
    return result;
  };
  const startAgent = async (taskId, options, dependencies) => {
    const result = await (startAgentOverride ?? defaultStartAgent)(
      taskId,
      options,
      dependencies,
    );
    observed.group = structuredClone(result.group);
    observed.task = structuredClone(result.task);
    observed.agent = structuredClone(result.agent);
    return result;
  };
  const retireAgent = async (agentId, dependencies) => {
    const result = await (retireAgentOverride ?? defaultRetireAgent)(
      agentId,
      dependencies,
    );
    if (result?.status === "retired" && observed.agent?.id === agentId) {
      observed.agent = {
        ...observed.agent,
        ...structuredClone(result.agent),
      };
    }
    return result;
  };
  const closeGroup = async (groupId, dependencies) => {
    const result = await (closeGroupOverride ?? (async () => ({
      status: "closed",
      group: { id: groupId },
    })))(groupId, dependencies);
    if (result?.status === "closed" && observed.group?.id === groupId) {
      observed.group = { ...observed.group, status: "closed" };
      if (observed.task?.group_id === groupId) {
        observed.task = { ...observed.task, status: "closed" };
      }
    }
    return result;
  };
  const readRegistrySnapshot = readSnapshotOverride ?? (async () => {
    const records = {
      groups: observed.group ? [structuredClone(observed.group)] : [],
      tasks: observed.task ? [structuredClone(observed.task)] : [],
      agents: observed.agent ? [structuredClone(observed.agent)] : [],
      turns: [],
      blocks: [],
    };
    return {
      ...records,
      authority_watermark: registryWatermark(records),
    };
  });
  return createDrovrDelegatedAgentResourcePort({
    resolveWorkspace,
    openTask,
    startAgent,
    retireAgent,
    readRegistrySnapshot,
    closeGroup,
  });
}

test("DelegatedAgentResourcePort provisions an exact run-scoped resource", async () => {
  const calls = [];
  const port = resourceAdapter({
    resolveWorkspace: async (claim) => {
      calls.push(["resolveWorkspace", claim]);
      return {
        subject_id: claim.subject_id,
        generation: claim.generation,
        mutation_epoch: claim.mutation_epoch,
        fingerprint: claim.fingerprint,
        canonical_path: "/workspace/issue-44",
        repository_id: "repository:issue-44",
        ref: "refs/heads/ticket/44-real-mixed-delegation",
      };
    },
    openTask: async (options) => {
      calls.push(["openTask", options]);
      return {
        group: { id: "group:resource", key: options.group, status: "active" },
        task: {
          id: "task:resource",
          group_id: "group:resource",
          key: options.key,
          cwd: options.cwd,
          status: "active",
        },
      };
    },
    startAgent: async (taskId, options) => {
      calls.push(["startAgent", taskId, options]);
      return {
        group: {
          id: "group:resource",
          key: options.group_key,
          status: "active",
        },
        task: {
          id: taskId,
          group_id: "group:resource",
          key: options.task_key,
          cwd: "/workspace/issue-44",
          status: "active",
        },
        agent: {
          id: "agent:actual-resource-id",
          task_id: taskId,
          key: options.key,
          status: "active",
          launch: request.launch,
          launch_binding: {
            comparison_key: launchBinding.launch_comparison_key,
            configuration_watermark: launchBinding.configuration_watermark,
            managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
          },
          native_session: "native:issue-44",
        },
      };
    },
  });

  const projection = await port.ensure(request);

  assert.equal(projection.status, "ready");
  assert.equal(projection.delegation.agent_id, "agent:actual-resource-id");
  assert.equal(projection.delegation.task_id, "task:resource");
  assert.equal(projection.delegation.group_id, "group:resource");
  assert.match(projection.resource_key, /^sha256:[0-9a-f]{64}$/u);
  assert.match(projection.binding_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(projection.watermark.authority, "drovr.registry");
  assert.equal(projection.binding.workspace_claim.subject_id,
    workspaceClaim.subject_id);
  assert.deepEqual(calls.map(([operation]) => operation), [
    "resolveWorkspace",
    "openTask",
    "startAgent",
  ]);
  assert.equal(calls[1][1].cwd, "/workspace/issue-44");
  assert.notEqual(calls[1][1].key, request.owner.route_key);
  assert.equal(
    projection.resource_key,
    deriveDelegatedAgentResourceKey(request),
  );
});

test("resource provisioning binds a provisional managed runtime before the first native session", async () => {
  const port = resourceAdapter({
    startAgent: async (taskId, options) => {
      const managedRuntimeIdentity = {
        managed_agent: "drovr-issue44",
        pane_id: "w2:p1",
        native_session: null,
        process: {
          pid: 4400,
        },
      };
      return {
      group: {
        id: "group:resource",
        key: options.group_key,
        status: "active",
      },
      task: {
        id: taskId,
        group_id: "group:resource",
        key: options.task_key,
        cwd: "/workspace/issue-44",
        status: "active",
      },
      agent: {
        id: "agent:actual-resource-id",
        task_id: taskId,
        key: options.key,
        status: "active",
        launch: request.launch,
        launch_binding: {
          comparison_key: launchBinding.launch_comparison_key,
          configuration_watermark: launchBinding.configuration_watermark,
          managed_runtime_evidence_digest: digest(managedRuntimeIdentity),
          managed_runtime_identity: managedRuntimeIdentity,
        },
        native_session: null,
      },
      };
    },
  });

  const projection = await port.ensure(request);

  assert.equal(projection.status, "ready");
  assert.equal(projection.binding.native_session, null);
  assert.equal(projection.binding.managed_runtime_evidence_digest,
    digest({
      managed_agent: "drovr-issue44",
      pane_id: "w2:p1",
      native_session: null,
      process: { pid: 4400 },
    }));
  assert.match(projection.binding.binding_digest, /^sha256:[0-9a-f]{64}$/u);
});

test("resource provisioning rejects a native session without managed runtime evidence", async () => {
  const port = resourceAdapter({
    startAgent: async (taskId, options) => ({
      group: { id: "group:resource", key: options.group_key, status: "active" },
      task: {
        id: taskId,
        group_id: "group:resource",
        key: options.task_key,
        cwd: "/workspace/issue-44",
        status: "active",
      },
      agent: {
        id: "agent:actual-resource-id",
        task_id: taskId,
        key: options.key,
        status: "active",
        launch: request.launch,
        launch_binding: {
          comparison_key: launchBinding.launch_comparison_key,
          configuration_watermark: launchBinding.configuration_watermark,
        },
        native_session: "native:issue-44",
      },
    }),
  });

  const projection = await port.ensure(request);

  assert.equal(projection.status, "blocked");
  assert.equal(projection.reason.code, "native_session_identity_conflict");
});

test("resource provisioning rejects a managed runtime digest that mismatches identity", async () => {
  const port = resourceAdapter({
    startAgent: async (taskId, options) => ({
      group: { id: "group:resource", key: options.group_key, status: "active" },
      task: {
        id: taskId,
        group_id: "group:resource",
        key: options.task_key,
        cwd: "/workspace/issue-44",
        status: "active",
      },
      agent: {
        id: "agent:actual-resource-id",
        task_id: taskId,
        key: options.key,
        status: "active",
        launch: request.launch,
        launch_binding: {
          comparison_key: launchBinding.launch_comparison_key,
          configuration_watermark: launchBinding.configuration_watermark,
          managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
          managed_runtime_identity: {
            managed_agent: "drovr-issue44",
            pane_id: "w2:p1",
            native_session: "native:issue-44",
            process: { pid: 4400 },
          },
        },
        native_session: "native:issue-44",
      },
    }),
  });
  const projection = await port.ensure(request);

  assert.equal(projection.status, "blocked");
  assert.equal(projection.reason.code, "native_session_identity_conflict");
});

test("resource retirement uses the actual owned agent identity", async () => {
  const retired = [];
  const port = resourceAdapter({
    retireAgent: async (agentId) => {
      retired.push(agentId);
      return {
        status: "retired",
        group: { id: "group:resource" },
        task: { id: "task:resource" },
        agent: {
          id: agentId,
          task_id: "task:resource",
        status: "retired",
        launch_binding: {
          comparison_key: launchBinding.launch_comparison_key,
          configuration_watermark: launchBinding.configuration_watermark,
          managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
        },
        native_session: "native:issue-44",
          cleanup_receipt: {
            schema: "drovr.agent-retirement-receipt/v1",
            proof: "exact_identity_and_pane_close",
          },
        },
      };
    },
  });
  const ensured = await port.ensure(request);
  const projection = await port.retire(retirementRequest(ensured.binding));

  assert.deepEqual(retired, ["agent:actual-resource-id"]);
  assert.equal(projection.status, "retired");
  assert.equal(projection.delegation.agent_id, "agent:actual-resource-id");
  assert.equal(projection.cleanup_receipt.proof,
    "exact_group_closed");
});

test("mixed resource bindings keep harness and native identities distinct", async () => {
  const port = resourceAdapter({
    startAgent: async (taskId, options) => ({
      group: {
        id: "group:resource",
        key: options.group_key,
        status: "active",
      },
      task: {
        id: taskId,
        group_id: "group:resource",
        key: options.task_key,
        cwd: "/workspace/issue-44",
        status: "active",
      },
      agent: {
        id: `agent:${options.harness}`,
        task_id: taskId,
        key: options.key,
        status: "active",
        launch: {
          ...request.launch,
          harness: options.harness,
        },
        launch_binding: {
          comparison_key: options.harness === "claude"
            ? `sha256:${"f".repeat(64)}`
            : launchBinding.launch_comparison_key,
          configuration_watermark: launchBinding.configuration_watermark,
          managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
        },
        native_session: `native:${options.harness}`,
      },
    }),
  });
  const critiqueRequest = {
    ...request,
    owner: {
      ...request.owner,
      card_id: "feature-critique",
      route_key: "agent:logical-critique",
    },
    launch: {
      ...request.launch,
      harness: "claude",
    },
    launch_binding: {
      ...launchBinding,
      description_digest: `sha256:${"1".repeat(64)}`,
      launch_comparison_key: `sha256:${"f".repeat(64)}`,
    },
  };
  const apply = await port.ensure(request);
  const critique = await port.ensure(critiqueRequest);

  assert.equal(request.launch.harness, "codex");
  assert.equal(critiqueRequest.launch.harness, "claude");
  assert.notEqual(apply.delegation.agent_id, critique.delegation.agent_id);
  assert.notEqual(apply.binding.native_session,
    critique.binding.native_session);
  assert.notEqual(apply.binding.launch_binding.launch_comparison_key,
    critique.binding.launch_binding.launch_comparison_key);
  assert.equal(
    apply.binding.launch_binding.effective_authority_comparison_key,
    critique.binding.launch_binding.effective_authority_comparison_key,
  );
});

test("resource provisioning blocks workspace drift and uncertain identity", async () => {
  const stale = resourceAdapter({
    resolveWorkspace: async () => ({
      subject_id: "workspace:other",
      generation: workspaceClaim.generation,
      mutation_epoch: workspaceClaim.mutation_epoch,
      fingerprint: workspaceClaim.fingerprint,
      canonical_path: "/workspace/other",
      repository_id: "repository:other",
      ref: "refs/heads/other",
    }),
  });
  const staleProjection = await stale.ensure(request);
  assert.equal(staleProjection.status, "blocked");
  assert.equal(staleProjection.reason.code, "workspace_claim_stale");
  assert.equal(staleProjection.delegation, null);

  const uncertain = resourceAdapter({
    startAgent: async () => {
      const error = new Error("native identity changed");
      error.outcome = "recovery_blocked";
      throw error;
    },
  });
  const uncertainProjection = await uncertain.ensure(request);
  assert.equal(uncertainProjection.status, "blocked");
  assert.equal(uncertainProjection.reason.code,
    "native_session_identity_conflict");
  assert.equal(uncertainProjection.delegation, null);
});

test("resource provisioning retains actual identity after post-start registry drift", async () => {
  const postStartDrift = resourceAdapter({
    readRegistrySnapshot: async () => ({
      groups: [],
      tasks: [],
      agents: [],
      turns: [],
      blocks: [],
      authority_watermark: absenceResourceWatermark(),
    }),
  });
  const projection = await postStartDrift.ensure(request);

  assert.equal(projection.status, "blocked");
  assert.equal(projection.reason.code, "resource_provisioning_uncertain");
  assert.equal(projection.resource_key,
    deriveDelegatedAgentResourceKey(request));
  assert.deepEqual(projection.delegation, {
    group_id: "group:resource",
    task_id: "task:resource",
    agent_id: "agent:actual-resource-id",
  });
});

test("resource identity and retirement drift remain typed blocks", async () => {
  const collision = resourceAdapter({
    openTask: async (options) => ({
      group: { id: "group:resource", key: options.group },
      task: {
        id: "task:resource",
        group_id: "group:resource",
        key: "task:another-resource",
        cwd: options.cwd,
        status: "active",
      },
    }),
  });
  const collisionProjection = await collision.ensure(request);
  assert.equal(collisionProjection.status, "blocked");
  assert.equal(collisionProjection.reason.code, "resource_key_conflict");

  const launchDrift = resourceAdapter({
    startAgent: async (taskId, options) => ({
      group: { id: "group:resource", key: options.group_key },
      task: {
        id: taskId,
        group_id: "group:resource",
        key: options.task_key,
        cwd: "/workspace/issue-44",
        status: "active",
      },
      agent: {
        id: "agent:actual-resource-id",
        task_id: taskId,
        key: options.key,
        status: "active",
        launch: { ...request.launch, model: "different-model" },
        launch_binding: {
          comparison_key: launchBinding.launch_comparison_key,
          configuration_watermark: launchBinding.configuration_watermark,
          managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
        },
        native_session: "native:issue-44",
      },
    }),
  });
  const launchProjection = await launchDrift.ensure(request);
  assert.equal(launchProjection.status, "blocked");
  assert.equal(launchProjection.reason.code, "launch_binding_conflict");

  const uncertainRetirement = resourceAdapter({
    retireAgent: async (agentId) => ({
      status: "uncertain",
      group: { id: "group:resource" },
      task: { id: "task:resource" },
      agent: { id: agentId },
    }),
  });
  const ensured = await uncertainRetirement.ensure(request);
  const retirementProjection = await uncertainRetirement.retire(
    retirementRequest(ensured.binding),
  );
  assert.equal(retirementProjection.status, "blocked");
  assert.equal(retirementProjection.reason.code,
    "resource_retirement_uncertain");
});

test("managed binding identity reuses one resource across card route keys", async () => {
  const port = resourceAdapter();
  const first = await port.ensure(request);
  const second = await port.ensure({
    ...request,
    owner: {
      ...request.owner,
      card_id: "feature-critique",
      route_key: "agent:logical-critique",
    },
    workspace_claim: {
      ...request.workspace_claim,
      operation: "feature-apply-slice-2",
    },
  });

  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(first.resource_key, second.resource_key);
  assert.deepEqual(first.delegation, second.delegation);
  assert.deepEqual(first.binding, second.binding);
});

test("resource retirement after a crash proves and closes an exact owned resource", async () => {
  let phase = "active";
  const snapshots = [];
  const retired = [];
  const closed = [];
  const port = resourceAdapter({
    readRegistrySnapshot: async () => {
      snapshots.push(phase);
      return phase === "active" ? activeResourceSnapshot() : closedResourceSnapshot();
    },
    retireAgent: async (agentId) => {
      retired.push(agentId);
      phase = "retired";
      return {
        status: "retired",
        group: { id: "group:resource" },
        task: { id: "task:resource" },
        agent: {
          id: agentId,
          task_id: "task:resource",
          status: "retired",
          native_session: "native:issue-44",
          cleanup_receipt: {
            schema: "drovr.agent-retirement-receipt/v1",
            proof: "exact_identity_and_pane_close",
          },
        },
      };
    },
    closeGroup: async (groupId) => {
      closed.push(groupId);
      phase = "closed";
      return { status: "closed", group: { id: groupId } };
    },
  });
  const ensured = await port.ensure(request);
  const projection = await port.retire(retirementRequest(ensured.binding));

  assert.deepEqual(snapshots, ["active", "active", "closed"]);
  assert.deepEqual(retired, ["agent:actual-resource-id"]);
  assert.deepEqual(closed, ["group:resource"]);
  assert.equal(projection.status, "retired");
  assert.deepEqual(projection.delegation, {
    group_id: "group:resource",
    task_id: "task:resource",
    agent_id: "agent:actual-resource-id",
  });
  assert.deepEqual(
    projection.watermark.authority_watermark,
    closedResourceSnapshot().authority_watermark,
  );
});

test("partial resource evidence blocks crash cleanup without claiming absence", async () => {
  let retirements = 0;
  let groupClosures = 0;
  const port = resourceAdapter({
    readRegistrySnapshot: async () => ({
      ...activeResourceSnapshot(),
      agents: [],
    }),
    retireAgent: async () => {
      retirements += 1;
      throw new Error("must not retire an unlocated agent");
    },
    closeGroup: async () => {
      groupClosures += 1;
      throw new Error("must not close a partially located resource");
    },
  });
  const ensured = await resourceAdapter().ensure(request);
  const projection = await port.retire(retirementRequest(ensured.binding));

  assert.equal(projection.status, "blocked");
  assert.equal(projection.reason.code, "resource_retirement_uncertain");
  assert.equal(retirements, 0);
  assert.equal(groupClosures, 0);
});

test("registry absence after exact provisioning remains retirement-uncertain", async () => {
  let retirements = 0;
  let groupClosures = 0;
  const port = resourceAdapter({
    readRegistrySnapshot: async () => emptyResourceSnapshot(),
    retireAgent: async () => {
      retirements += 1;
      throw new Error("must not retire an absent agent");
    },
    closeGroup: async () => {
      groupClosures += 1;
      throw new Error("must not close an absent group");
    },
  });
  const ensured = await resourceAdapter().ensure(request);
  const projection = await port.retire(retirementRequest(ensured.binding));

  assert.equal(projection.status, "blocked");
  assert.equal(projection.reason.code, "resource_retirement_uncertain");
  assert.deepEqual(projection.watermark, absenceResourceWatermark());
  assert.deepEqual(projection.legal_next_actions, [
    "reconcile_exact_agent_retirement",
  ]);
  assert.equal(retirements, 0);
  assert.equal(groupClosures, 0);
});

test("exact absence cannot retire without a carried immutable binding", async () => {
  const port = resourceAdapter({
    readRegistrySnapshot: async () => ({
      ...emptyResourceSnapshot(),
      authority_watermark: absenceResourceWatermark(),
    }),
  });
  const projection = await port.retire({
    schema: "flow.delegated-agent-resource-retire-request/v1",
  });

  assert.equal(projection.status, "blocked");
  assert.equal(projection.reason.code, "invalid_resource_request");
  assert.deepEqual(projection.legal_next_actions, []);
});

test("resource projections validate against their strict schema", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../../config/flow/schemas/flow.delegated-agent-resource-projection.v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const ready = await resourceAdapter().ensure(request);
  assert.equal(validate(ready), true, ajv.errorsText(validate.errors));

  const blocked = await resourceAdapter({
    resolveWorkspace: async () => ({
      subject_id: "workspace:other",
      generation: workspaceClaim.generation,
      mutation_epoch: workspaceClaim.mutation_epoch,
      fingerprint: workspaceClaim.fingerprint,
      canonical_path: "/workspace/other",
      repository_id: "repository:other",
    }),
  }).ensure(request);
  assert.equal(validate(blocked), true, ajv.errorsText(validate.errors));

  const ensured = await resourceAdapter().ensure(request);
  const retired = await resourceAdapter().retire(
    retirementRequest(ensured.binding),
  );
  assert.equal(validate(retired), true, ajv.errorsText(validate.errors));
});

function resourceKeysFor(resourceRequest = request) {
  const suffix = deriveDelegatedAgentResourceKey(resourceRequest)
    .slice("sha256:".length);
  return {
    group_key: `flow-delegate-resource-group:${suffix}`,
    task_key: `flow-delegate-resource-task:${suffix}`,
    agent_key: `flow-delegate-resource-agent:${suffix}`,
  };
}

function activeResourceSnapshot(resourceRequest = request) {
  const keys = resourceKeysFor(resourceRequest);
  const records = {
    groups: [{
      schema: "drovr.group/v1",
      id: "group:resource",
      key: keys.group_key,
      status: "active",
    }],
    tasks: [{
      schema: "drovr.task/v1",
      id: "task:resource",
      group_id: "group:resource",
      key: keys.task_key,
      cwd: "/workspace/issue-44",
      status: "active",
    }],
    agents: [{
      schema: "drovr.agent/v1",
      id: "agent:actual-resource-id",
      task_id: "task:resource",
      key: keys.agent_key,
      status: "active",
      launch: resourceRequest.launch,
      launch_binding: {
        comparison_key: resourceRequest.launch_binding.launch_comparison_key,
        configuration_watermark:
          resourceRequest.launch_binding.configuration_watermark,
        managed_runtime_evidence_digest: managedRuntimeEvidenceDigest,
      },
      native_session: "native:issue-44",
    }],
    turns: [],
    blocks: [],
  };
  return {
    ...records,
    authority_watermark: registryWatermark(records),
  };
}

function closedResourceSnapshot(resourceRequest = request) {
  const snapshot = activeResourceSnapshot(resourceRequest);
  snapshot.groups[0].status = "closed";
  snapshot.tasks[0].status = "closed";
  snapshot.agents[0].status = "retired";
  snapshot.agents[0].cleanup_receipt = {
    schema: "drovr.agent-retirement-receipt/v1",
    proof: "exact_identity_and_pane_close",
  };
  const {
    authority_watermark: _priorWatermark,
    ...records
  } = snapshot;
  snapshot.authority_watermark = registryWatermark(records);
  return snapshot;
}

function emptyResourceSnapshot() {
  const records = {
    groups: [],
    tasks: [],
    agents: [],
    turns: [],
    blocks: [],
  };
  return {
    ...records,
    authority_watermark: registryWatermark(records),
  };
}

function absenceResourceWatermark() {
  return emptyResourceSnapshot().authority_watermark;
}

function registryWatermark(records) {
  const generation = {
    schema: "drovr.registry-authority-watermark/v1",
    authority: "drovr.registry",
    ...Object.fromEntries(Object.entries(records).map(([kind, values]) => [
      `${kind}_sha256`, digest(values),
    ])),
    ...Object.fromEntries(Object.entries(records).map(([kind, values]) => [
      `${kind}_count`, values.length,
    ])),
  };
  return {
    ...generation,
    generation: digest(generation),
    registry_sha256: digest(records),
  };
}

test("Flow dispatch binds the materialized agent ID after resource ensure", async () => {
  const description = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { run_id: "run:issue-44", card_id: "delegate-review" },
  }, repositoryDrovrDependencies());
  const fallbackDescription = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { run_id: "run:issue-44", card_id: "delegate-review" },
  }, repositoryDrovrDependencies());
  const calls = [];
  const resourceRequests = [];
  const actualAgentId = "agent:actual-resource-id";
  let latestBinding = null;
  let initialDispatchProjection = null;
  const claim = {
    ...workspaceClaim,
    access: "read_only",
  };
  const intent = {
    effect_kind: "delegate",
    effect_id: "effect:resource-integration",
    idempotency_key: "delegate:resource-integration",
    run_id: "run:issue-44",
    attempt_id: "run:issue-44:delegate-review:attempt:1",
    attempt_ordinal: 1,
    max_attempts: 1,
    card_id: "delegate-review",
    operation_contract: "flow.delegated-agent-port/v1",
    delegate_input: {
      description,
      prompt: "inspect the exact candidate",
      wait_timeout_ms: 1000,
      resource_references: [{
        schema: "flow.delegate-execution-resource-selection/v1",
        kind: "workspace",
        authority: "WorkspaceAuthority",
        contract: "work.workspace/v1",
        subject_id: claim.subject_id,
        generation: claim.generation,
        mutation_epoch: claim.mutation_epoch,
        fingerprint: claim.fingerprint,
        access: claim.access,
        authority_binding_id: "resource:facts",
      }],
    },
    delegate_output_schemas: ["validated_output"],
    delegate_validator_contracts: ["flow.validator/delegate-output-conformance/v1"],
    capability_envelopes: [],
    capability_bindings: [],
    required_authority_bindings: [{
      schema: "flow.required-authority-binding/v1",
      id: "resource:facts",
      contract: "flow.resource-authority/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "authority:resource",
        version: "v1",
      },
      observation_input: { fact: "resource_claims" },
      observation: {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${"5".repeat(64)}`,
        observation_input: { fact: "resource_claims" },
      },
    }],
    resource_claims: [{
      kind: "workspace",
      id: claim.subject_id,
      generation: claim.generation,
      mutation_epoch: claim.mutation_epoch,
      fingerprint: claim.fingerprint,
    }],
    route_binding: {
      agent_id: "agent:logical-apply",
      configuration_watermark: description.watermark.content_sha256,
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    },
    managed_agent_binding: null,
  };
  const delegatedPort = {
    async discover() {
      calls.push("discover");
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "proven_absent",
        watermark: {
          schema: "drovr.registry-authority-watermark/v1",
          authority: "drovr.registry",
          turns_sha256: `sha256:${"1".repeat(64)}`,
        },
        delegation: null,
        turn: null,
        legal_next_actions: ["dispatch_exact_turn"],
      };
    },
    async dispatch(request) {
      calls.push(["dispatch", request]);
      const projection = completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        prompt: request.prompt,
      });
      if (request.caller_key === intent.attempt_id) {
        initialDispatchProjection = structuredClone(projection);
      }
      return projection;
    },
    async retire(request) {
      calls.push(["retire", request]);
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "drovr.registry",
          agent_id: request.agent_id,
          record_sha256: `sha256:${"2".repeat(64)}`,
        },
        delegation: {
          agent_id: request.agent_id,
          task_id: "task:resource",
          group_id: "group:resource",
        },
        turn: null,
        legal_next_actions: [],
      };
    },
    async send() {},
    async observe() {},
    async wait() {},
    async cancel() {},
    async reconcile() {},
  };
  const resourcePort = {
    async ensure(request) {
      calls.push("ensure");
      resourceRequests.push(request);
      const resourceKey = deriveDelegatedAgentResourceKey(request);
      const binding = {
        schema: "flow.delegated-agent-resource-binding/v1",
        resource_key: resourceKey,
        owner: request.owner,
        workspace_claim: request.workspace_claim,
        launch_binding: request.launch_binding,
        delegation: {
          agent_id: actualAgentId,
          task_id: "task:resource",
          group_id: "group:resource",
        },
        native_session: "native:issue-44",
        managed_runtime_evidence_digest: `sha256:${"8".repeat(64)}`,
      };
      const bindingDigest = digest({
        resource_key: binding.resource_key,
        owner: binding.owner,
        workspace_claim: binding.workspace_claim,
        launch_binding: binding.launch_binding,
        delegation: {
          agent_id: actualAgentId,
          task_id: "task:resource",
          group_id: "group:resource",
        },
        native_session: binding.native_session,
        managed_runtime_evidence_digest:
          binding.managed_runtime_evidence_digest,
      });
      binding.binding_digest = bindingDigest;
      latestBinding = structuredClone(binding);
      return {
        schema: "flow.delegated-agent-resource-projection/v1",
        operation: "ensure",
        status: "ready",
        resource_key: resourceKey,
        binding,
        binding_digest: bindingDigest,
        delegation: {
          agent_id: actualAgentId,
          task_id: "task:resource",
          group_id: "group:resource",
        },
        watermark: {
          schema: "flow.delegated-agent-resource-watermark/v1",
          authority: "drovr.registry",
          resource_key: resourceKey,
          group_id: "group:resource",
          task_id: "task:resource",
          agent_id: actualAgentId,
          record_sha256: `sha256:${"4".repeat(64)}`,
        },
        legal_next_actions: ["dispatch_exact_turn"],
      };
    },
    async retire(request) {
      calls.push("resource-retire");
      return {
        schema: "flow.delegated-agent-resource-projection/v1",
        operation: "retire",
        status: "retired",
        resource_key: request.binding.resource_key,
        binding: request.binding,
        binding_digest: request.binding.binding_digest,
        delegation: request.binding.delegation,
        watermark: {
          schema: "flow.delegated-agent-resource-watermark/v1",
          authority: "drovr.registry",
          resource_key: request.binding.resource_key,
          group_id: request.binding.delegation.group_id,
          task_id: request.binding.delegation.task_id,
          agent_id: request.binding.delegation.agent_id,
          record_sha256: `sha256:${"7".repeat(64)}`,
          authority_watermark: {
            schema: "drovr.registry-authority-watermark/v1",
          },
        },
        cleanup_receipt: {
          schema: "drovr.agent-retirement-receipt/v1",
          proof: "exact_identity_and_pane_close",
        },
        reason: null,
        legal_next_actions: [],
      };
    },
  };
  let settled;
  const runAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      settled = invoke(currentIntent);
      return settled;
    },
  };
  dispatchDelegateEffect(
    intent,
    delegatedPort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    runAuthority,
    { resourcePort },
  );
  await settled;

  assert.deepEqual(calls.map((entry) =>
    Array.isArray(entry) ? entry[0] : entry), [
    "discover",
    "ensure",
    "dispatch",
    "retire",
    "resource-retire",
  ]);
  assert.equal(resourceRequests[0].owner.route_key, "agent:logical-apply");
  assert.equal(Object.hasOwn(resourceRequests[0], "cwd"), false);
  assert.equal(calls[2][1].agent_id, actualAgentId);
  assert.equal(calls[2][1].resource_binding.delegation.agent_id,
    actualAgentId);
  assert.notEqual(calls[2][1].agent_id, intent.route_binding.agent_id);

  const failureIntent = {
    ...structuredClone(intent),
    effect_id: "effect:resource-review-failure",
    idempotency_key: "delegate:resource-review-failure",
    attempt_id: "run:issue-44:review-critic:attempt:1",
    card_id: "review-critic",
  };
  const failurePort = {
    ...delegatedPort,
    async dispatch(request) {
      calls.push(["dispatch-failure", request]);
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "dispatch",
        status: "blocked",
        watermark: null,
        delegation: null,
        turn: null,
        compatibility: {
          contract: "flow.delegated-agent-port/v1",
          code: "delegated_runtime_unavailable",
        },
        legal_next_actions: ["retry_delegated_runtime_operation"],
      };
    },
  };
  let failedSettled;
  const failureAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      failedSettled = invoke(currentIntent);
      return failedSettled;
    },
  };
  dispatchDelegateEffect(
    failureIntent,
    failurePort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    failureAuthority,
    { resourcePort },
  );
  const failureReceipt = await failedSettled;
  assert.equal(failureReceipt.outcome, "succeeded");
  assert.equal(
    failureReceipt.provider_receipt.terminal_disposition.status,
    "retired",
  );
  assert.equal(
    failureReceipt.provider_receipt.terminal_disposition.binding_digest,
    failureReceipt.provider_receipt.terminal_disposition.binding.binding_digest,
  );

  const uncertainProjection = {
    schema: "flow.delegated-agent-resource-projection/v1",
    operation: "retire",
    status: "blocked",
    resource_key: latestBinding.resource_key,
    binding: latestBinding,
    binding_digest: latestBinding.binding_digest,
    delegation: latestBinding.delegation,
    watermark: {
      schema: "flow.delegated-agent-resource-watermark/v1",
      authority: "drovr.registry",
      resource_key: latestBinding.resource_key,
      group_id: latestBinding.delegation.group_id,
      task_id: latestBinding.delegation.task_id,
      agent_id: latestBinding.delegation.agent_id,
      record_sha256: `sha256:${"9".repeat(64)}`,
      authority_watermark: {
        schema: "drovr.registry-authority-watermark/v1",
        authority: "drovr.registry",
        generation: `sha256:${"a".repeat(64)}`,
        registry_sha256: `sha256:${"b".repeat(64)}`,
        groups_count: 1,
        groups_sha256: `sha256:${"c".repeat(64)}`,
        tasks_count: 1,
        tasks_sha256: `sha256:${"d".repeat(64)}`,
        agents_count: 1,
        agents_sha256: `sha256:${"e".repeat(64)}`,
        turns_count: 0,
        turns_sha256: `sha256:${"f".repeat(64)}`,
        blocks_count: 0,
        blocks_sha256: `sha256:${"0".repeat(64)}`,
      },
    },
    legal_next_actions: ["reconcile_exact_agent_retirement"],
    reason: {
      code: "resource_retirement_uncertain",
      message: "registry authority did not prove exact retirement",
    },
    cleanup_receipt: null,
    workspace: null,
  };
  const uncertainResourcePort = {
    ...resourcePort,
    async retire() {
      calls.push("resource-retire-uncertain");
      return uncertainProjection;
    },
  };
  const uncertainIntent = {
    ...structuredClone(failureIntent),
    effect_id: "effect:resource-review-failure-uncertain",
    idempotency_key: "delegate:resource-review-failure-uncertain",
    attempt_id: "run:issue-44:review-critic:attempt:1-uncertain",
  };
  let uncertainSettled;
  const uncertainAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      uncertainSettled = invoke(currentIntent);
      return uncertainSettled;
    },
  };
  dispatchDelegateEffect(
    uncertainIntent,
    failurePort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    uncertainAuthority,
    { resourcePort: uncertainResourcePort },
  );
  const uncertainReceipt = await uncertainSettled;
  const uncertainHandoff = uncertainReceipt.provider_receipt
    .terminal_disposition;
  assert.equal(uncertainHandoff.resource.id, actualAgentId);
  assert.equal(uncertainHandoff.resource_binding.binding_digest,
    latestBinding.binding_digest);
  assert.deepEqual(uncertainHandoff.resource_projection,
    uncertainProjection);
  assert.equal(uncertainHandoff.resource_projection.reason.code,
    "resource_retirement_uncertain");
  assert.deepEqual(uncertainHandoff.resource_projection.legal_next_actions,
    ["reconcile_exact_agent_retirement"]);
  assert.equal(Object.hasOwn(uncertainHandoff, "cleanup_receipt"), false);

  const quarantineIntent = {
    ...structuredClone(intent),
    effect_id: "effect:resource-quarantine-retry",
    idempotency_key: "delegate:resource-quarantine-retry",
    attempt_id: "run:issue-44:delegate-review:attempt:1-retry",
    attempt_ordinal: 1,
    max_attempts: 2,
    next_route_binding: {
      agent_id: "agent:logical-fallback",
      configuration_watermark: fallbackDescription.watermark.content_sha256,
      description_digest: fallbackDescription.description_digest,
      launch_comparison_key: fallbackDescription.comparison_keys.launch,
    },
    retry_resource_strategy:
      "retire_exact_primary_before_independent_fallback",
  };
  const quarantineStart = calls.length;
  let quarantineSettled;
  const quarantineAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      quarantineSettled = invoke(currentIntent);
      return quarantineSettled;
    },
  };
  dispatchDelegateEffect(
    quarantineIntent,
    delegatedPort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => false, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    quarantineAuthority,
    { resourcePort },
  );
  const quarantineReceipt = await quarantineSettled;
  assert.equal(quarantineReceipt.outcome, "quarantined");
  assert.equal(
    quarantineReceipt.provider_receipt.terminal_disposition.status,
    "retired",
  );
  assert.equal(
    quarantineReceipt.provider_receipt.terminal_disposition.resource_disposition
      .binding_digest,
    quarantineReceipt.provider_receipt.terminal_disposition.resource_disposition
      .binding.binding_digest,
  );

  const primaryRetirementIndex = calls.findIndex((entry, index) =>
    index >= quarantineStart && entry === "resource-retire");
  assert.notEqual(primaryRetirementIndex, -1);
  const fallbackIntent = {
    ...structuredClone(intent),
    effect_id: "effect:resource-independent-fallback",
    idempotency_key: "delegate:resource-independent-fallback",
    attempt_id: "run:issue-44:delegate-review:attempt:2",
    attempt_ordinal: 2,
    max_attempts: 2,
    delegate_input: {
      ...structuredClone(intent.delegate_input),
      description: fallbackDescription,
    },
    route_binding: {
      agent_id: "agent:logical-fallback",
      configuration_watermark: fallbackDescription.watermark.content_sha256,
      description_digest: fallbackDescription.description_digest,
      launch_comparison_key: fallbackDescription.comparison_keys.launch,
    },
  };
  let fallbackSettled;
  const fallbackAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      fallbackSettled = invoke(currentIntent);
      return fallbackSettled;
    },
  };
  const fallbackStart = calls.length;
  dispatchDelegateEffect(
    fallbackIntent,
    delegatedPort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    fallbackAuthority,
    { resourcePort },
  );
  const fallbackReceipt = await fallbackSettled;
  const fallbackEnsureIndex = calls.findIndex((entry, index) =>
    index >= fallbackStart && entry === "ensure");
  assert.notEqual(fallbackEnsureIndex, -1);
  assert.ok(primaryRetirementIndex < fallbackEnsureIndex);
  assert.notEqual(resourceRequests.at(-2)?.owner.route_key,
    resourceRequests.at(-1)?.owner.route_key,
    `resourceRequests=${resourceRequests.length} calls=${JSON.stringify(calls)}`,
  );
  assert.equal(fallbackReceipt.outcome, "succeeded");

  const sameRouteIntent = {
    ...structuredClone(quarantineIntent),
    effect_id: "effect:resource-same-route-retry",
    idempotency_key: "delegate:resource-same-route-retry",
    attempt_id: "run:issue-44:delegate-review:attempt:1-same-route",
    next_route_binding: intent.route_binding,
    retry_resource_strategy: "retain_exact_primary_for_same_route_retry",
  };
  let sameRouteSettled;
  const sameRouteAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      sameRouteSettled = invoke(currentIntent);
      return sameRouteSettled;
    },
  };
  const sameRouteStart = calls.length;
  dispatchDelegateEffect(
    sameRouteIntent,
    delegatedPort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => false, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    sameRouteAuthority,
    { resourcePort },
  );
  const sameRouteReceipt = await sameRouteSettled;
  assert.equal(sameRouteReceipt.outcome, "quarantined");
  assert.equal(
    sameRouteReceipt.provider_receipt.terminal_disposition.schema,
    "flow.resource-handoff/v1",
  );
  assert.equal(
    sameRouteReceipt.provider_receipt.terminal_disposition.resource_binding
      .binding_digest,
    digest({
      resource_key: sameRouteReceipt.provider_receipt.terminal_disposition
        .resource_binding.resource_key,
      owner: sameRouteReceipt.provider_receipt.terminal_disposition
        .resource_binding.owner,
      workspace_claim: sameRouteReceipt.provider_receipt.terminal_disposition
        .resource_binding.workspace_claim,
      launch_binding: sameRouteReceipt.provider_receipt.terminal_disposition
        .resource_binding.launch_binding,
      delegation: sameRouteReceipt.provider_receipt.terminal_disposition
        .resource_binding.delegation,
      native_session: sameRouteReceipt.provider_receipt.terminal_disposition
        .resource_binding.native_session,
      managed_runtime_evidence_digest:
        sameRouteReceipt.provider_receipt.terminal_disposition.resource_binding
          .managed_runtime_evidence_digest,
    }),
  );
  assert.equal(
    calls.slice(sameRouteStart).includes("resource-retire"),
    false,
  );

  const adoptionProjection = structuredClone(initialDispatchProjection);
  adoptionProjection.operation = "discover";
  adoptionProjection.delegation = structuredClone(latestBinding.delegation);
  adoptionProjection.turn.resource_binding = latestBinding;
  const adoptionCallsStart = calls.length;
  const adoptionPort = {
    ...delegatedPort,
    async discover() {
      calls.push("adoption-discover");
      return adoptionProjection;
    },
    async dispatch() {
      assert.fail("workspace adoption must not dispatch a second turn");
    },
  };
  let adoptionSettled;
  const adoptionAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      adoptionSettled = invoke(currentIntent);
      return adoptionSettled;
    },
  };
  dispatchDelegateEffect(
    intent,
    adoptionPort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    adoptionAuthority,
    { resourcePort },
  );
  const adoptionReceipt = await adoptionSettled;
  assert.ok(["succeeded", "quarantined"].includes(adoptionReceipt.outcome));
  assert.equal(calls.slice(adoptionCallsStart).includes("ensure"), false);
  assert.equal(calls.slice(adoptionCallsStart).includes("resource-retire"), true);

  const invalidAdoptionProjection = structuredClone(adoptionProjection);
  invalidAdoptionProjection.turn.resource_binding.binding_digest =
    `sha256:${"0".repeat(64)}`;
  let invalidObservation;
  let invalidSettled;
  const invalidAdoptionAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      invalidSettled = invoke(currentIntent);
      invalidSettled.catch(() => {});
      return invalidSettled;
    },
    async recordEffectObservation(_intent, observation) {
      invalidObservation = observation;
    },
  };
  dispatchDelegateEffect(
    intent,
    {
      ...adoptionPort,
      async discover() {
        return invalidAdoptionProjection;
      },
    },
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    invalidAdoptionAuthority,
    { resourcePort },
  );
  for (let attempt = 0; attempt < 20 && invalidObservation === undefined;
    attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(invalidObservation?.provider_observation?.code,
    "resource_binding_conflict");

  const metadataOnlyProjection = structuredClone(adoptionProjection);
  delete metadataOnlyProjection.turn.resource_binding;
  metadataOnlyProjection.turn.caller.metadata = {
    ...metadataOnlyProjection.turn.caller.metadata,
    flow_resource_binding: latestBinding,
  };
  let metadataObservation;
  let metadataSettled;
  const metadataAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      metadataSettled = invoke(currentIntent);
      metadataSettled.catch(() => {});
      return metadataSettled;
    },
    async recordEffectObservation(_intent, observation) {
      metadataObservation = observation;
    },
  };
  const metadataCallsStart = calls.length;
  dispatchDelegateEffect(
    intent,
    {
      ...adoptionPort,
      async discover() {
        return metadataOnlyProjection;
      },
    },
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    metadataAuthority,
    { resourcePort },
  );
  for (let attempt = 0; attempt < 20 && metadataObservation === undefined;
    attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(metadataObservation?.provider_observation?.code,
    "resource_binding_conflict");
  assert.equal(calls.slice(metadataCallsStart).includes("resource-retire"),
    false);

  const nonReviewIntent = {
    ...structuredClone(intent),
    effect_id: "effect:resource-non-review-dispatch-failure",
    idempotency_key: "delegate:resource-non-review-dispatch-failure",
    attempt_id: "run:issue-44:feature-apply:attempt:1",
    card_id: "feature-apply",
  };
  let failedDispatchRequest;
  let failureObservation;
  let failureSettled;
  const nonReviewFailureAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      failureSettled = invoke(currentIntent);
      failureSettled.catch(() => {});
      return failureSettled;
    },
    async recordEffectObservation(_intent, observation) {
      failureObservation = observation;
    },
  };
  const failingDispatchPort = {
    ...delegatedPort,
    async dispatch(request) {
      failedDispatchRequest = request;
      const error = new Error("post-ensure dispatch unavailable");
      error.code = "delegated_runtime_unavailable";
      throw error;
    },
  };
  dispatchDelegateEffect(
    nonReviewIntent,
    failingDispatchPort,
    new Map([[
      "flow.validator/delegate-output-conformance/v1",
      { validate: () => true, evidenceSafety: validateDelegateEvidenceSafety },
    ]]),
    nonReviewFailureAuthority,
    { resourcePort },
  );
  for (let attempt = 0; attempt < 20 && failureObservation === undefined;
    attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const failedBinding = latestBinding;
  assert.equal(failedDispatchRequest?.agent_id, actualAgentId);
  assert.equal(failedDispatchRequest?.resource_binding?.delegation?.agent_id,
    actualAgentId);
  const failureObservationSchema = JSON.parse(await readFile(new URL(
    "../../../config/flow/schemas/flow.delegate-failure-observation.v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const validateFailureObservation = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile(failureObservationSchema);
  assert.equal(failureObservation?.provider_observation?.schema,
    "flow.delegate-failure-observation/v1");
  assert.equal(
    validateFailureObservation(failureObservation.provider_observation),
    true,
    validateFailureObservation.errors &&
      JSON.stringify(validateFailureObservation.errors),
  );
  assert.deepEqual(
    failureObservation.provider_observation.resource_projection.binding,
    failedBinding,
  );
  assert.equal(
    failureObservation.provider_observation.resource_projection.delegation
      .agent_id,
    actualAgentId,
  );

  const invalidResourceIntent = {
    ...nonReviewIntent,
    effect_id: "effect:resource-invalid-projection",
    idempotency_key: "delegate:resource-invalid-projection",
    attempt_id: "run:issue-44:feature-apply:attempt:invalid",
  };
  let invalidResourceObservation;
  let invalidResourceSettled;
  const invalidResourceAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      invalidResourceSettled = invoke(currentIntent);
      invalidResourceSettled.catch(() => {});
      return invalidResourceSettled;
    },
    async recordEffectObservation(_intent, observation) {
      invalidResourceObservation = observation;
    },
  };
  const invalidResourcePort = {
    ...resourcePort,
    async ensure() {
      return {
        schema: "flow.delegated-agent-resource-projection/v1",
        operation: "ensure",
        status: "blocked",
        resource_key: null,
        binding: null,
        binding_digest: null,
        delegation: null,
        watermark: null,
        reason: {
          code: "invalid_resource_request",
          message: "invalid resource request",
        },
        legal_next_actions: [],
      };
    },
  };
  dispatchDelegateEffect(
    invalidResourceIntent,
    delegatedPort,
    new Map(),
    invalidResourceAuthority,
    { resourcePort: invalidResourcePort },
  );
  for (let attempt = 0; attempt < 20 && invalidResourceObservation === undefined;
    attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(invalidResourceObservation?.provider_observation?.schema,
    "flow.delegate-failure-observation/v1");
  assert.equal(
    validateFailureObservation(invalidResourceObservation.provider_observation),
    true,
    validateFailureObservation.errors &&
      JSON.stringify(validateFailureObservation.errors),
  );
  assert.equal(
    Object.hasOwn(invalidResourceObservation.provider_observation,
      "resource_projection"),
    false,
  );
});

test("workspace cancellation without an exact turn emits unresolved retirement handoff", async () => {
  const authorityWatermark = {
    schema: "drovr.registry-authority-watermark/v1",
    authority: "drovr.registry",
    generation: `sha256:${"1".repeat(64)}`,
    registry_sha256: `sha256:${"2".repeat(64)}`,
    groups_count: 0,
    groups_sha256: `sha256:${"3".repeat(64)}`,
    tasks_count: 0,
    tasks_sha256: `sha256:${"4".repeat(64)}`,
    agents_count: 0,
    agents_sha256: `sha256:${"5".repeat(64)}`,
    turns_count: 0,
    turns_sha256: `sha256:${"6".repeat(64)}`,
    blocks_count: 0,
    blocks_sha256: `sha256:${"7".repeat(64)}`,
  };
  const description = {
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    description_digest: launchBinding.description_digest,
    comparison_keys: {
      launch: launchBinding.launch_comparison_key,
      effective_authority: launchBinding.effective_authority_comparison_key,
    },
    watermark: {
      content_sha256: launchBinding.configuration_watermark,
    },
  };
  const absent = {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "proven_absent",
    watermark: authorityWatermark,
    delegation: null,
    turn: null,
    legal_next_actions: ["dispatch_exact_turn"],
  };
  const intent = {
    effect_kind: "delegate_cancellation",
    effect_id: "effect:workspace-cancel-absent",
    idempotency_key: "delegate:workspace-cancel-absent",
    run_id: "run:workspace-cancel",
    delegate_attempt_id: "run:workspace-cancel:attempt:1",
    delegate_effect_id: "effect:workspace-delegate",
    retire_managed_agent: true,
    card_id: "delegate-review",
    operation_contract: "flow.delegated-agent-port/v1",
    route_binding: {
      agent_id: "agent:planned",
    },
    delegate_input: {
      description,
      resource_references: [{
        ...workspaceClaim,
        subject_id: "workspace:cancel",
      }],
    },
  };
  let resourceRetireCalls = 0;
  const resourcePort = {
    contract: "flow.delegated-agent-resource-port/v1",
    async ensure() {
      assert.fail("proven-absent cancellation must not ensure a resource");
    },
    async retire() {
      resourceRetireCalls += 1;
      assert.fail("unresolved cancellation must not retire a null binding");
    },
  };
  let settled;
  const runAuthority = {
    invokeEffect(currentIntent, { invoke }) {
      settled = invoke(currentIntent);
      return settled;
    },
  };
  dispatchDelegateEffect(
    intent,
    { async discover() { return absent; } },
    new Map(),
    runAuthority,
    { resourcePort },
  );
  const receipt = await settled;
  const disposition = receipt.provider_receipt.terminal_disposition;
  const projectionSchema = JSON.parse(await readFile(new URL(
    "../../../config/flow/schemas/flow.delegated-agent-resource-projection.v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const validateProjection = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile(projectionSchema);
  assert.equal(validateProjection(disposition.resource_projection), true,
    validateProjection.errors &&
      JSON.stringify(validateProjection.errors));
  assert.equal(receipt.outcome, "succeeded");
  assert.deepEqual(disposition.resource, {
    type: "drovr_agent_unresolved",
  });
  assert.deepEqual(disposition.planning_identity, {
    type: "flow_route",
    agent_id: "agent:planned",
  });
  assert.equal(disposition.durable_holder, "flow.run:run:workspace-cancel");
  assert.equal(disposition.reason, "resource_retirement_uncertain");
  assert.equal(disposition.resource_projection.resource_key,
    deriveDelegatedAgentResourceKey({
      owner: {
        run_id: intent.run_id,
        card_id: intent.card_id,
        route_key: intent.route_binding.agent_id,
      },
      workspace_claim: {
        kind: "workspace",
        authority: "WorkspaceAuthority",
        contract: "work.workspace/v1",
        subject_id: "workspace:cancel",
        generation: 7,
        mutation_epoch: 3,
        fingerprint: workspaceClaim.fingerprint,
        access: "mutation",
        operation: "feature-apply",
      },
      launch_binding: launchBinding,
    }));
  assert.deepEqual(disposition.resource_projection.watermark,
    authorityWatermark);
  assert.equal(disposition.resource_projection.reason.code,
    "resource_retirement_uncertain");
  assert.deepEqual(disposition.resource_projection.legal_next_actions,
    ["reconcile_exact_agent_retirement"]);
  assert.equal(Object.hasOwn(disposition.resource, "id"), false);
  assert.equal(resourceRetireCalls, 0);

  async function assertNoInvalidProjection(candidate, label) {
    dispatchDelegateEffect(
      candidate,
      { async discover() { return absent; } },
      new Map(),
      runAuthority,
      { resourcePort },
    );
    const candidateReceipt = await settled;
    const candidateDisposition = candidateReceipt.provider_receipt
      .terminal_disposition;
    assert.equal(candidateReceipt.outcome, "succeeded", label);
    assert.equal(
      Object.hasOwn(candidateDisposition, "resource_projection"),
      false,
      label,
    );
    assert.equal(
      JSON.stringify(candidateDisposition).includes('"resource_key":null'),
      false,
      label,
    );
  }

  const missingLaunchIntent = structuredClone(intent);
  missingLaunchIntent.effect_id = "effect:workspace-cancel-missing-launch";
  missingLaunchIntent.idempotency_key =
    "delegate:workspace-cancel-missing-launch";
  delete missingLaunchIntent.delegate_input.description;
  await assertNoInvalidProjection(
    missingLaunchIntent,
    "missing launch facts must not emit a null resource key",
  );

  const missingWorkspaceIntent = structuredClone(intent);
  missingWorkspaceIntent.effect_id =
    "effect:workspace-cancel-missing-workspace";
  missingWorkspaceIntent.idempotency_key =
    "delegate:workspace-cancel-missing-workspace";
  missingWorkspaceIntent.delegate_input.resource_references = [];
  await assertNoInvalidProjection(
    missingWorkspaceIntent,
    "missing workspace facts must not emit a resource projection",
  );

  const malformedWorkspaceIntent = structuredClone(intent);
  malformedWorkspaceIntent.effect_id =
    "effect:workspace-cancel-malformed-workspace";
  malformedWorkspaceIntent.idempotency_key =
    "delegate:workspace-cancel-malformed-workspace";
  malformedWorkspaceIntent.delegate_input.resource_references[0]
    .fingerprint = "not-a-digest";
  await assertNoInvalidProjection(
    malformedWorkspaceIntent,
    "malformed workspace facts must not emit a null resource key",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { describeDelegatedAgent } from "../../drovr/src/description.mjs";
import {
  createDrovrDelegatedAgentPort as createProductionDrovrDelegatedAgentPort,
} from "../src/drovr-delegated-agent-port.mjs";
import { digest } from "../src/canonical.mjs";
import {
  rebindDescriptionDigest,
  repositoryDrovrDependencies,
  supportedDescription,
} from "../test-support/delegated-agent-description.mjs";

const request = {
  schema: "flow.delegated-agent-description-request/v1",
  launch: {
    harness: "codex",
    role: "reviewer",
    capability: "read-only",
  },
  caller_metadata: {
    run_id: "run:example",
    card_id: "review",
    attempt: 1,
  },
};

function createDrovrDelegatedAgentPort(options = {}) {
  return createProductionDrovrDelegatedAgentPort({
    dependencies: repositoryDrovrDependencies(),
    ...options,
  });
}

test("DelegatedAgentPort exposes the exact compatible lifecycle description", async () => {
  const port = createDrovrDelegatedAgentPort();

  const projection = await port.describe(request);

  assert.equal(projection.schema, "flow.delegated-agent-description-projection/v1");
  assert.equal(projection.status, "compatible");
  assert.deepEqual(projection.watermark, projection.description.watermark);
  assert.deepEqual(
    projection.description.caller_metadata,
    request.caller_metadata,
  );
  assert.match(projection.description.description_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(projection.compatibility.code, null);
  assert.deepEqual(projection.compatibility.findings, []);
  assert.deepEqual(projection.legal_next_actions, [
    "bind_exact_launch_description",
    "refresh_delegated_runtime_description",
  ]);
});

test("DelegatedAgentPort projects missing compatibility as a typed block", async () => {
  const port = createDrovrDelegatedAgentPort({
    dependencies: {
      ...repositoryDrovrDependencies(),
      requireCompatibility: true,
      run: async (command, args) => {
        if (command === "herdr" && args[0] === "--version") {
          return "herdr 0.7.5";
        }
        if (command === "codex" && args[0] === "--version") {
          return "codex-cli 0.145.0";
        }
        return "";
      },
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "compatibility_blocked");
  assert.deepEqual(blocked.compatibility.findings, [
    { field: "integration", reason: "missing" },
  ]);
  assert.deepEqual(blocked.legal_next_actions, [
    "refresh_compatibility",
    "run_drovr_doctor",
  ]);
});

test("DelegatedAgentPort rejects a description that omits required compatibility", async () => {
  const port = createDrovrDelegatedAgentPort({
    describeDrovr: (descriptionRequest) =>
      describeDelegatedAgent(
        descriptionRequest,
        repositoryDrovrDependencies(),
      ),
    dependencies: {
      ...repositoryDrovrDependencies(),
      requireCompatibility: true,
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "compatibility_blocked");
  assert.deepEqual(blocked.compatibility.findings, [
    { field: "compatibility", reason: "missing" },
  ]);
});

test("DelegatedAgentPort rejects self-authored compatibility without qualified facts", async () => {
  const port = createDrovrDelegatedAgentPort({
    dependencies: {
      ...repositoryDrovrDependencies(),
      requireCompatibility: true,
    },
    async describeDrovr(drovrRequest) {
      const description = await supportedDescription(
        drovrRequest,
        repositoryDrovrDependencies(),
      );
      description.schemas.compatibility = "drovr.compatibility/v1";
      description.compatibility = {
        schema: "drovr.compatibility/v1",
        status: "qualified",
        reason: null,
        facts: {
          drovr: "forged-drovr",
          herdr: "forged-herdr",
          harness: "forged-harness",
          integration: "forged-integration",
          adapters: ["forged-adapter-1", "forged-adapter-2"],
          features: [
            "forged-feature-1",
            "forged-feature-2",
            "forged-feature-3",
            "forged-feature-4",
            "forged-feature-5",
          ],
        },
        evidence_digest: digest({
          drovr: "forged-drovr",
          herdr: "forged-herdr",
          harness: "forged-harness",
          integration: "forged-integration",
          adapters: ["forged-adapter-1", "forged-adapter-2"],
          features: [
            "forged-feature-1",
            "forged-feature-2",
            "forged-feature-3",
            "forged-feature-4",
            "forged-feature-5",
          ],
        }),
        legal_actions: [],
        upstream_gaps: [{
          id: "forged-gap/v1",
          operation: "forged.operation",
          status: "upstream_gap",
          posture: "forged",
          safe_local_posture: "forged",
        }],
      };
      description.comparison_keys.compatibility = digest(
        description.compatibility,
      );
      rebindDescriptionDigest(description);
      return description;
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "compatibility_blocked");
  assert.deepEqual(blocked.compatibility.findings, [
    { field: "compatibility", reason: "missing" },
  ]);
});

test("DelegatedAgentPort exposes the complete authority-derived lifecycle", async () => {
  const calls = [];
  const context = lifecycleContext();
  const port = createDrovrDelegatedAgentPort({
    async dispatchDrovr(agentId, options) {
      calls.push(["dispatch", agentId, options]);
      return { ...context, dispatch_status: "dispatched" };
    },
    async discoverDrovr(callerKey) {
      calls.push(["discover", callerKey]);
      return {
        ...context,
        discovery_status: "found",
        discovery_watermark: registryWatermark(),
      };
    },
    async sendDrovr(turnId, options) {
      calls.push(["send", turnId, options]);
      return context;
    },
    async observeDrovr(turnId) {
      calls.push(["observe", turnId]);
      return context;
    },
    async waitDrovr(turnId, options) {
      calls.push(["wait", turnId, options]);
      return { ...context, wait_status: "still_running" };
    },
    async cancelDrovr(turnId) {
      calls.push(["cancel", turnId]);
      return {
        ...context,
        turn: { ...context.turn, status: "cancelled" },
      };
    },
    async reconcileDrovr(turnId, options) {
      calls.push(["reconcile", turnId, options]);
      return { ...context, wait_status: "still_running" };
    },
    async retireDrovr(agentId) {
      calls.push(["retire", agentId]);
      return {
        ...context,
        status: "retired",
        agent: { ...context.agent, status: "retired" },
      };
    },
  });
  const description = (await port.describe(request)).description;

  const dispatched = await port.dispatch({
    schema: "flow.delegated-agent-dispatch-request/v1",
    agent_id: "agent:1",
    caller_key: "run:1/card:review/attempt:1",
    input_key: "input:1",
    prompt: "inspect the candidate",
    description,
  });
  const discovered = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: "run:1/card:review/attempt:1",
  });
  const sent = await port.send({
    schema: "flow.delegated-agent-send-request/v1",
    turn_id: "turn:1",
    input_key: "input:2",
    prompt: "prioritize correctness",
  });
  const observed = await port.observe({
    schema: "flow.delegated-agent-observe-request/v1",
    turn_id: "turn:1",
  });
  const waited = await port.wait({
    schema: "flow.delegated-agent-wait-request/v1",
    turn_id: "turn:1",
    timeout_ms: 1000,
  });
  const cancelled = await port.cancel({
    schema: "flow.delegated-agent-cancel-request/v1",
    turn_id: "turn:1",
  });
  const reconciled = await port.reconcile({
    schema: "flow.delegated-agent-reconcile-request/v1",
    turn_id: "turn:1",
    timeout_ms: 1000,
  });
  const retired = await port.retire({
    schema: "flow.delegated-agent-retire-request/v1",
    agent_id: "agent:1",
    turn_id: "turn:1",
    attempt_id: "run:1/card:review/attempt:1",
  });

  for (const projection of [
    dispatched,
    discovered,
    sent,
    observed,
    waited,
    cancelled,
    reconciled,
  ]) {
    assert.equal(
      projection.schema,
      "flow.delegated-agent-lifecycle-projection/v1",
    );
    assert.notEqual(projection.watermark, null);
    assert.ok(projection.legal_next_actions.length > 0);
  }
  assert.equal(dispatched.status, "working");
  assert.deepEqual(dispatched.delegation, {
    agent_id: "agent:1",
    task_id: "task:1",
    group_id: "group:1",
  });
  assert.deepEqual(discovered.discovery_watermark, registryWatermark());
  assert.equal(waited.status, "still_running");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(reconciled.status, "still_running");
  assert.equal(retired.status, "retired");
  assert.equal(retired.watermark.schema, "drovr.agent-authority-watermark/v1");
  assert.deepEqual(retired.legal_next_actions, []);
  assert.equal(calls[0][2].launchBinding.description_digest,
    description.description_digest);
  assert.equal(calls[2][2].callerKey, "input:2");
});

test("DelegatedAgentPort proves caller-key absence and fails conflicts closed", async () => {
  const port = createDrovrDelegatedAgentPort({
    async discoverDrovr() {
      return {
        discovery_status: "proven_absent",
        authority_watermark: registryWatermark(),
      };
    },
    async sendDrovr() {
      const error = new Error("input key has a different payload");
      error.outcome = "caller_key_conflict";
      throw error;
    },
    async observeDrovr() {
      return lifecycleContext();
    },
  });

  const absent = await port.discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: "missing",
  });
  assert.equal(absent.status, "proven_absent");
  assert.deepEqual(absent.watermark, registryWatermark());
  assert.deepEqual(absent.legal_next_actions, [
    "dispatch_with_same_caller_key",
  ]);

  const conflict = await port.send({
    schema: "flow.delegated-agent-send-request/v1",
    turn_id: "turn:1",
    input_key: "input:2",
    prompt: "different",
  });
  assert.equal(conflict.status, "blocked");
  assert.equal(conflict.compatibility.code, "caller_key_conflict");
  assert.equal(conflict.watermark.turn_id, "turn:1");
  assert.equal(conflict.turn.id, "turn:1");
  assert.deepEqual(conflict.legal_next_actions, [
    "observe_bounded",
    "reconcile_exact_turn",
  ]);
});

test("DelegatedAgentPort projects the durable retirement receipt", async () => {
  const context = lifecycleContext();
  const cleanupReceipt = {
    schema: "drovr.agent-retirement-receipt/v1",
    agent_id: "agent:1",
    recorded_at: "2026-08-01T00:00:00Z",
    proof: "exact_absence",
    observation: {
      evidence: "absent",
      runtime: { evidence: "present" },
    },
    pane: {
      pane_id: "pane:1",
      before: null,
      after: { evidence: "absent" },
    },
    interrupted_turns: [],
  };
  const port = createDrovrDelegatedAgentPort({
    async retireDrovr() {
      return {
        ...context,
        status: "retired",
        reason: "exact_absence",
        legal_next_actions: [],
        agent: {
          ...context.agent,
          status: "retired",
          cleanup_receipt: cleanupReceipt,
        },
      };
    },
  });

  const projection = await port.retire({
    schema: "flow.delegated-agent-retire-request/v1",
    agent_id: "agent:1",
    turn_id: "turn:1",
    attempt_id: "run:1/card:review/attempt:1",
  });

  assert.equal(projection.status, "retired");
  assert.equal(projection.reason, "exact_absence");
  assert.deepEqual(projection.cleanup_receipt, cleanupReceipt);
  assert.deepEqual(projection.legal_next_actions, []);
});

for (const outcome of ["launch_binding_missing", "launch_binding_stale"]) {
  test(`DelegatedAgentPort points ${outcome} at the exact agent retirement`, async () => {
    const port = createDrovrDelegatedAgentPort({
      async dispatchDrovr() {
        const error = new Error(outcome);
        error.outcome = outcome;
        error.details = {
          delegation: {
            agent_id: "agent:1",
            task_id: "task:1",
            group_id: "group:1",
          },
        };
        throw error;
      },
      async discoverDrovr() {
        return {
          discovery_status: "proven_absent",
          authority_watermark: registryWatermark(),
        };
      },
    });
    const description = (await port.describe(request)).description;

    const blocked = await port.dispatch({
      schema: "flow.delegated-agent-dispatch-request/v1",
      agent_id: "agent:1",
      caller_key: "run:1/card:review/attempt:1",
      input_key: "input:1",
      prompt: "inspect the candidate",
      description,
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.compatibility.code, outcome);
    assert.deepEqual(blocked.watermark, registryWatermark());
    assert.deepEqual(blocked.delegation, {
      agent_id: "agent:1",
      task_id: "task:1",
      group_id: "group:1",
    });
    assert.deepEqual(blocked.legal_next_actions, ["retire_agent"]);
  });
}

test("DelegatedAgentPort keeps a fresh description conflict refreshable", async () => {
  const port = createDrovrDelegatedAgentPort({
    async dispatchDrovr() {
      const error = new Error("description changed");
      error.outcome = "launch_binding_conflict";
      throw error;
    },
    async discoverDrovr() {
      return {
        discovery_status: "proven_absent",
        authority_watermark: registryWatermark(),
      };
    },
  });
  const description = (await port.describe(request)).description;

  const blocked = await port.dispatch({
    schema: "flow.delegated-agent-dispatch-request/v1",
    agent_id: "agent:1",
    caller_key: "run:1/card:review/attempt:1",
    input_key: "input:1",
    prompt: "inspect the candidate",
    description,
  });

  assert.equal(blocked.compatibility.code, "launch_binding_conflict");
  assert.equal(blocked.delegation, null);
  assert.deepEqual(blocked.legal_next_actions, [
    "refresh_delegated_runtime_description",
  ]);
});

test("DelegatedAgentPort never recommends retirement without registry evidence", async () => {
  const port = createDrovrDelegatedAgentPort({
    async dispatchDrovr() {
      const error = new Error("stale binding");
      error.outcome = "launch_binding_stale";
      error.details = {
        delegation: {
          agent_id: "agent:1",
          task_id: "task:1",
          group_id: "group:1",
        },
      };
      throw error;
    },
    async discoverDrovr() {
      throw new Error("registry unavailable");
    },
  });
  const description = (await port.describe(request)).description;

  const blocked = await port.dispatch({
    schema: "flow.delegated-agent-dispatch-request/v1",
    agent_id: "agent:1",
    caller_key: "run:1/card:review/attempt:1",
    input_key: "input:1",
    prompt: "inspect the candidate",
    description,
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(
    blocked.compatibility.code,
    "delegated_runtime_projection_unavailable",
  );
  assert.equal(blocked.watermark, null);
  assert.equal(blocked.delegation, null);
  assert.deepEqual(blocked.legal_next_actions, [
    "repair_delegated_runtime_registry",
  ]);
});

test("DelegatedAgentPort closes legal actions around unproven delivery and agent loss", async () => {
  const context = lifecycleContext();
  const port = createDrovrDelegatedAgentPort({
    async sendDrovr() {
      return { ...context, input_status: "reconciling" };
    },
    async waitDrovr() {
      return { ...context, wait_status: "agent_lost" };
    },
  });

  const reconciling = await port.send({
    schema: "flow.delegated-agent-send-request/v1",
    turn_id: "turn:1",
    input_key: "input:2",
    prompt: "do not duplicate this input",
  });
  assert.equal(reconciling.status, "reconciling");
  assert.deepEqual(reconciling.legal_next_actions, [
    "observe_bounded",
    "wait_bounded",
    "reconcile_exact_turn",
  ]);

  const lost = await port.wait({
    schema: "flow.delegated-agent-wait-request/v1",
    turn_id: "turn:1",
    timeout_ms: 1000,
  });
  assert.equal(lost.status, "agent_lost");
  assert.deepEqual(lost.legal_next_actions, [
    "observe_bounded",
    "reconcile_exact_turn",
    "retire_agent",
  ]);
});

function lifecycleContext() {
  return {
    group: { id: "group:1", key: "group", label: "Group" },
    task: {
      id: "task:1",
      key: "task",
      label: "Task",
      cwd: "/workspace",
    },
    agent: {
      id: "agent:1",
      key: "agent",
      label: "Agent",
      launch: {
        harness: "codex",
        model: "gpt-5.6",
        effort: "high",
        capability: "read-only",
      },
    },
    turn: {
      id: "turn:1",
      agent_id: "agent:1",
      task_id: "task:1",
      status: "working",
      inputs: [{
        sequence: 1,
        caller_key: "input:1",
        payload_sha256: digest("inspect the candidate"),
        delivery: { status: "submitted", accepted_at: "2026-08-01T00:00:00Z" },
      }],
      caller: {
        dispatch_key: "run:1/card:review/attempt:1",
        payload_sha256: digest("dispatch"),
        metadata: request.caller_metadata,
      },
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: digest("launch"),
        configuration_watermark: digest("configuration"),
        description_digest: digest("description"),
      },
      created_at: "2026-08-01T00:00:00Z",
    },
  };
}

function registryWatermark() {
  return {
    schema: "drovr.registry-authority-watermark/v1",
    authority: "drovr.registry",
    turns_sha256: digest([]),
  };
}

for (const [label, mutate, expectedFinding] of [
  [
    "missing",
    (description) => description.feature_advertisement.features.shift(),
    { feature_id: "exact_launch_description", reason: "missing" },
  ],
  [
    "weakened",
    (description) => {
      description.feature_advertisement.features[0].guarantees.pop();
    },
    { feature_id: "exact_launch_description", reason: "weakened" },
  ],
  [
    "contradictory",
    (description) => {
      description.feature_advertisement.features[0].authority =
        "delegated_runtime";
    },
    { feature_id: "exact_launch_description", reason: "contradictory" },
  ],
  [
    "contradictory availability",
    (description) => {
      description.feature_advertisement.features[0].availability =
        "experimental";
    },
    { feature_id: "exact_launch_description", reason: "contradictory" },
  ],
]) {
  test(`Drovr conformance rejects ${label} advertised features and recovers after repair`, async () => {
    let broken = true;
    const port = createDrovrDelegatedAgentPort({
      async describeDrovr(drovrRequest, dependencies) {
        const description = await supportedDescription(
          drovrRequest,
          dependencies,
        );
        if (broken) {
          mutate(description);
          rebindDescriptionDigest(description);
        }
        return description;
      },
    });

    const blocked = await port.describe(request);

    assert.equal(blocked.status, "blocked");
    assert.equal(
      blocked.compatibility.code,
      "incompatible_feature_advertisement",
    );
    assert.deepEqual(blocked.compatibility.findings, [expectedFinding]);
    assert.equal(blocked.description, null);
    assert.equal(blocked.watermark, null);
    assert.deepEqual(blocked.legal_next_actions, [
      "repair_delegated_runtime_contract",
      "refresh_delegated_runtime_description",
    ]);

    broken = false;
    const recovered = await port.describe(request);
    assert.equal(recovered.status, "compatible");
    assert.deepEqual(recovered.compatibility.findings, []);
  });
}

test("DelegatedAgentPort classifies an unpinned Flow contract as a repairable local failure", async () => {
  const port = createDrovrDelegatedAgentPort({
    async loadRequiredFeatureContractBytes() {
      return Buffer.from('{"schema":"flow.drovr-required-features/v1"}');
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(
    blocked.compatibility.code,
    "delegated_agent_port_unavailable",
  );
  assert.deepEqual(blocked.legal_next_actions, [
    "repair_delegated_agent_port",
  ]);
});

test("DelegatedAgentPort classifies an unreadable Flow contract as a repairable local failure", async () => {
  const port = createDrovrDelegatedAgentPort({
    async loadRequiredFeatureContractBytes() {
      throw new Error("contract missing");
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "delegated_agent_port_unavailable");
  assert.deepEqual(blocked.legal_next_actions, [
    "repair_delegated_agent_port",
  ]);
});

test("DelegatedAgentPort classifies an unreadable projection schema as a repairable local failure", async () => {
  const port = createDrovrDelegatedAgentPort({
    async loadProjectionSchemaBytes() {
      throw new Error("schema missing");
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "delegated_agent_port_unavailable");
  assert.deepEqual(blocked.legal_next_actions, [
    "repair_delegated_agent_port",
  ]);
});

test("DelegatedAgentPort retries a failed local validator load after repair", async () => {
  let validatorAvailable = false;
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      return supportedDescription(drovrRequest, dependencies);
    },
    async loadDescriptionValidator() {
      if (!validatorAvailable) throw new Error("validator unavailable");
      return () => true;
    },
  });

  const blocked = await port.describe(request);
  assert.equal(blocked.compatibility.code, "delegated_agent_port_unavailable");
  assert.deepEqual(blocked.legal_next_actions, [
    "repair_delegated_agent_port",
  ]);

  validatorAvailable = true;
  const recovered = await port.describe(request);
  assert.equal(recovered.status, "compatible");
});

test("DelegatedAgentPort blocks internally contradictory launch authority", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      const description = await supportedDescription(
        drovrRequest,
        dependencies,
      );
      description.effective_authority.capability = "unrestricted";
      return description;
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "contradictory_description");
  assert.deepEqual(blocked.compatibility.findings, [
    { field: "effective_authority.capability", reason: "contradictory" },
  ]);
  assert.deepEqual(blocked.legal_next_actions, [
    "repair_delegated_runtime_contract",
    "refresh_delegated_runtime_description",
  ]);
});

test("DelegatedAgentPort rejects authority dimensions that contradict capability", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      const description = await supportedDescription(
        drovrRequest,
        dependencies,
      );
      description.effective_authority.dimensions = {
        approvals: "never",
        filesystem: "unrestricted",
        network: "unrestricted",
      };
      description.comparison_keys.effective_authority = digest(
        description.effective_authority,
      );
      rebindDescriptionDigest(description);
      return description;
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "contradictory_description");
  assert.deepEqual(blocked.compatibility.findings, [
    {
      field: "effective_authority.dimensions",
      reason: "contradictory",
    },
  ]);
  assert.equal(blocked.description, null);
  assert.equal(blocked.watermark, null);
});

test("DelegatedAgentPort rejects a self-consistent description for another launch", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      return supportedDescription({
        ...drovrRequest,
        launch: {
          ...drovrRequest.launch,
          capability: "unrestricted",
        },
      }, dependencies);
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "contradictory_description");
  assert.deepEqual(blocked.compatibility.findings, [
    { field: "launch.capability", reason: "contradictory" },
  ]);
});

test("DelegatedAgentPort turns malformed feature entries into a typed block", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      const description = await supportedDescription(
        drovrRequest,
        dependencies,
      );
      description.feature_advertisement.features[0] = null;
      return description;
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(
    blocked.compatibility.code,
    "incompatible_feature_advertisement",
  );
  assert.ok(blocked.compatibility.findings.some(
    (finding) => finding.feature_id === null &&
      finding.reason === "contradictory",
  ));
  assert.equal(blocked.description, null);
  assert.equal(blocked.watermark, null);
});

test("DelegatedAgentPort classifies a forged description digest as contradictory", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      const description = await supportedDescription(
        drovrRequest,
        dependencies,
      );
      description.feature_advertisement.features[0].guarantees[0] =
        "forged_guarantee";
      return description;
    },
  });

  const blocked = await port.describe(request);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compatibility.code, "contradictory_description");
  assert.deepEqual(blocked.compatibility.findings, [
    { field: "description_digest", reason: "contradictory" },
  ]);
});

test("DelegatedAgentPort sanitizes malformed descriptions into a typed block", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      const description = await supportedDescription(
        drovrRequest,
        dependencies,
      );
      delete description.caller_metadata;
      return description;
    },
  });

  const blocked = await port.describe(request);

  assert.deepEqual(blocked, {
    schema: "flow.delegated-agent-description-projection/v1",
    status: "blocked",
    watermark: null,
    description: null,
    compatibility: {
      contract: "flow.delegated-agent-port/v1",
      code: "contradictory_description",
      findings: [
        { field: "caller_metadata", reason: "contradictory" },
      ],
    },
    legal_next_actions: [
      "repair_delegated_runtime_contract",
      "refresh_delegated_runtime_description",
    ],
  });
});

for (const availability of ["advertised", "synthetically supported"]) {
  test(`DelegatedAgentPort rejects a self-consistent description missing capacity when ${availability}`, async () => {
    const port = createDrovrDelegatedAgentPort({
      async describeDrovr(drovrRequest, dependencies) {
        const description = availability === "advertised"
          ? structuredClone(
            await describeDelegatedAgent(drovrRequest, dependencies),
          )
          : await supportedDescription(drovrRequest, dependencies);
        delete description.capacity;
        rebindDescriptionDigest(description);
        return description;
      },
    });

    const blocked = await port.describe(request);

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.compatibility.code, "contradictory_description");
    assert.deepEqual(blocked.compatibility.findings, [
      { field: "capacity", reason: "contradictory" },
    ]);
    assert.equal(blocked.description, null);
    assert.equal(blocked.watermark, null);
  });
}

test("DelegatedAgentPort classifies invalid launch selectors as caller input", async () => {
  const port = createDrovrDelegatedAgentPort();

  const blocked = await port.describe({
    ...request,
    launch: { harness: "bogus", capability: "read-only" },
  });

  assert.deepEqual(blocked, {
    schema: "flow.delegated-agent-description-projection/v1",
    status: "blocked",
    watermark: null,
    description: null,
    compatibility: {
      contract: "flow.delegated-agent-port/v1",
      code: "invalid_description_request",
      findings: [],
    },
    legal_next_actions: [],
  });
});

test("DelegatedAgentPort reports unavailable descriptions without inventing authority", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr() {
      throw new Error("configuration offline");
    },
  });

  const blocked = await port.describe(request);

  assert.deepEqual(blocked, {
    schema: "flow.delegated-agent-description-projection/v1",
    status: "blocked",
    watermark: null,
    description: null,
    compatibility: {
      contract: "flow.delegated-agent-port/v1",
      code: "description_unavailable",
      findings: [],
    },
    legal_next_actions: ["retry_delegated_runtime_description"],
  });
});
test("DelegatedAgentPort exposes repair actions for invalid Drovr configuration", async () => {
  const port = createDrovrDelegatedAgentPort({
    async describeDrovr() {
      throw Object.assign(new Error("configuration invalid"), {
        outcome: "invalid_configuration",
      });
    },
  });

  const blocked = await port.describe(request);

  assert.deepEqual(blocked, {
    schema: "flow.delegated-agent-description-projection/v1",
    status: "blocked",
    watermark: null,
    description: null,
    compatibility: {
      contract: "flow.delegated-agent-port/v1",
      code: "description_unavailable",
      findings: [],
    },
    legal_next_actions: [
      "repair_delegated_runtime_contract",
      "refresh_delegated_runtime_description",
    ],
  });
});

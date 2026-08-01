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

const unavailableFeatureIds = [
  "caller_idempotent_dispatch",
  "caller_idempotent_discovery",
  "caller_keyed_ordered_input",
  "terminal_proof_classification",
  "launch_binding_settlement_proof",
  "opaque_caller_ownership_metadata",
];

function createDrovrDelegatedAgentPort(options = {}) {
  return createProductionDrovrDelegatedAgentPort({
    dependencies: repositoryDrovrDependencies(),
    ...options,
  });
}

test("DelegatedAgentPort blocks the exact description until every required feature is available", async () => {
  const port = createDrovrDelegatedAgentPort();

  const projection = await port.describe(request);

  assert.equal(projection.schema, "flow.delegated-agent-description-projection/v1");
  assert.equal(projection.status, "blocked");
  assert.deepEqual(projection.watermark, projection.description.watermark);
  assert.deepEqual(
    projection.description.caller_metadata,
    request.caller_metadata,
  );
  assert.match(projection.description.description_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    projection.compatibility.code,
    "incompatible_feature_advertisement",
  );
  assert.deepEqual(projection.compatibility.findings, unavailableFeatureIds.map(
    (featureId) => ({ feature_id: featureId, reason: "unavailable" }),
  ));
  assert.deepEqual(projection.legal_next_actions, [
    "repair_delegated_runtime_contract",
    "refresh_delegated_runtime_description",
  ]);
});

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

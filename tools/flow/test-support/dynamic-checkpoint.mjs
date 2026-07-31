export function dynamicCheckpointProposal() {
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: {
      schema: "flow.run-plan/v1",
      cards: [
        {
          id: "confirm-plan",
          executor: {
            kind: "checkpoint",
            contract: "flow.checkpoint/confirmation/v1",
          },
          dependencies: [],
          inputs: {
            prompt: "Confirm the complete finite plan",
          },
          outputs: [],
          success_criteria: ["decision:approve"],
          validators: ["flow.validator/checkpoint-decision/v1"],
          data_references: [],
          evidence_references: [],
          route: null,
          limits: {},
          resource_claims: [],
          recovery: "human_decision",
        },
      ],
    },
    requested_authority: {
      commands: ["checkpoint_decision"],
      capabilities: [],
      mutations: [],
    },
    explicit_facts: {
      catalog_fingerprint: `sha256:${"1".repeat(64)}`,
      route_snapshot: {
        watermark: `sha256:${"2".repeat(64)}`,
        bindings: [],
      },
      capability_envelopes: [],
      operation_contracts: [],
      validator_contracts: ["flow.validator/checkpoint-decision/v1"],
      limits: { max_cards: 1 },
      resource_claims: [],
    },
  };
}

export function dependencyCheckpointProposal() {
  const proposal = dynamicCheckpointProposal();
  const finalCheckpoint = proposal.graph.cards[0];
  finalCheckpoint.dependencies = ["confirm-scope"];
  proposal.graph.cards.push({
    ...structuredClone(finalCheckpoint),
    id: "confirm-scope",
    dependencies: [],
    inputs: { prompt: "Confirm the bounded scope" },
  });
  proposal.explicit_facts.limits.max_cards = 2;
  return proposal;
}

export function confirmedLaunchRequest(prepared, {
  decision = "accept",
  facts = prepared.explicit_facts,
} = {}) {
  return {
    prepared,
    confirmation: {
      schema: "flow.dynamic-plan-confirmation-decision/v1",
      decision,
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    },
    closed_facts: {
      schema: "flow.closed-fact-observation/v1",
      bundle_digest: prepared.bundle_digest,
      facts: structuredClone(facts),
    },
  };
}

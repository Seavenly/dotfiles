import { observeCardBlock } from "../src/card-block-observation-adapter.mjs";

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
      block_observations: [],
      elapsed_seconds: 0,
      limits: {
        max_cards: 1,
        max_revisions: 0,
        max_cards_per_revision: 0,
        max_capabilities: 0,
        max_resources: 0,
        max_elapsed_seconds: 0,
      },
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

export function independentCheckpointProposal() {
  const proposal = dependencyCheckpointProposal();
  proposal.graph.cards.find(({ id }) => id === "confirm-plan").dependencies = [];
  return proposal;
}

export function capabilityBlockedCheckpointProposal() {
  const proposal = dynamicCheckpointProposal();
  const block = {
    schema: "flow.card-block/v1",
    id: "confirm-plan:repository-write",
    type: "capability_required",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "capability_required",
      code: "repository_write_required",
    },
    required_capabilities: ["repository:write"],
    revision_template_ids: [],
  };
  proposal.requested_authority.commands.push("capability_grant");
  registerBlockObservationContracts(proposal);
  proposal.explicit_facts.capability_envelopes.push("repository:write");
  proposal.explicit_facts.limits.max_capabilities = 1;
  proposal.explicit_facts.block_observations.push(
    mutableCardBlockObservation("confirm-plan", block),
  );
  return proposal;
}

export function revisionBlockedCheckpointProposal() {
  const proposal = dependencyCheckpointProposal();
  const scopeCard = proposal.graph.cards.find(({ id }) => id === "confirm-scope");
  const scopeBlock = {
    schema: "flow.card-block/v1",
    id: "confirm-scope:approval",
    type: "capability_required",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "capability_required",
      code: "scope_approval_required",
    },
    required_capabilities: ["scope:approve"],
    revision_template_ids: [],
  };
  const blockedCard = proposal.graph.cards.find(({ id }) => id === "confirm-plan");
  blockedCard.route = { binding: "original-review-route" };
  const revisionBlock = {
    schema: "flow.card-block/v1",
    id: "confirm-plan:scope-revision",
    type: "plan_revision_required",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: "scope_revision_required",
    },
    required_capabilities: [],
    revision_template_ids: ["replace-confirm-plan"],
  };
  proposal.requested_authority.commands.push(
    "capability_grant",
    "revision_decision",
  );
  registerBlockObservationContracts(proposal);
  proposal.explicit_facts.capability_envelopes.push(
    "artifact:write",
    "scope:approve",
  );
  proposal.explicit_facts.block_observations.push(
    mutableCardBlockObservation("confirm-scope", scopeBlock),
    mutableCardBlockObservation("confirm-plan", revisionBlock),
  );
  proposal.explicit_facts.elapsed_seconds = 10;
  Object.assign(proposal.explicit_facts.limits, {
    max_revisions: 1,
    max_cards_per_revision: 1,
    max_capabilities: 2,
    max_resources: 1,
    max_elapsed_seconds: 60,
  });
  proposal.revision_templates = [{
    schema: "flow.plan-revision-template/v1",
    id: "replace-confirm-plan",
    trigger: structuredClone(revisionBlock.trigger),
    limits: { max_applications: 1 },
    changes: {
      add_cards: [{
        ...structuredClone(blockedCard),
        id: "confirm-revised-plan",
        dependencies: [],
        inputs: { prompt: "Confirm the revised bounded plan" },
        route: { binding: "revised-review-route" },
      }],
      add_edges: [{ from: "confirm-scope", to: "confirm-revised-plan" }],
      supersede_cards: ["confirm-plan"],
      capability_additions: [{
        capability: "artifact:write",
        card_ids: ["confirm-revised-plan"],
      }],
      resource_additions: [{ kind: "artifact", id: "revised-plan" }],
      limit_changes: { max_cards: 3 },
    },
  }];
  return proposal;
}

export function repeatedRevisionCheckpointProposal() {
  const proposal = independentCheckpointProposal();
  proposal.requested_authority.commands.push("revision_decision");
  registerBlockObservationContracts(proposal);
  Object.assign(proposal.explicit_facts.limits, {
    max_cards: 4,
    max_revisions: 2,
    max_cards_per_revision: 1,
  });
  proposal.revision_templates = proposal.graph.cards.map((card) => {
    const templateId = `replace-${card.id}`;
    const trigger = {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: `${card.id}_revision_required`,
    };
    proposal.explicit_facts.block_observations.push(
      mutableCardBlockObservation(card.id, {
        schema: "flow.card-block/v1",
        id: `${card.id}:revision`,
        type: "plan_revision_required",
        trigger,
        required_capabilities: [],
        revision_template_ids: [templateId],
      }),
    );
    return {
      schema: "flow.plan-revision-template/v1",
      id: templateId,
      trigger,
      limits: { max_applications: 1 },
      changes: {
        add_cards: [{
          ...structuredClone(card),
          id: `${card.id}-revised`,
        }],
        add_edges: [],
        supersede_cards: [card.id],
        capability_additions: [],
        resource_additions: [],
        limit_changes: {},
      },
    };
  });
  return proposal;
}

function mutableCardBlockObservation(cardId, block) {
  return structuredClone(observeCardBlock({ card_id: cardId, block }));
}

function registerBlockObservationContracts(proposal) {
  proposal.explicit_facts.operation_contracts.push(
    "flow.adapter/card-block-observation/v1",
  );
  proposal.explicit_facts.validator_contracts.push(
    "flow.validator/card-block-observation/v1",
  );
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

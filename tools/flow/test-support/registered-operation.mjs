import { dynamicCheckpointProposal } from "./dynamic-checkpoint.mjs";

export const TEST_OPERATION_CONTRACT = "flow.operation/conformance-record/v1";
export const OPERATION_RECEIPT_VALIDATOR =
  "flow.validator/operation-receipt/v1";

export function registeredOperationProposal({
  classification = "caller_idempotent",
  checkpointBound = true,
} = {}) {
  const proposal = dynamicCheckpointProposal();
  const checkpoint = proposal.graph.cards[0];
  const operation = {
    id: "record-outcome",
    executor: {
      kind: "operation",
      contract: TEST_OPERATION_CONTRACT,
      effect_classification: classification,
    },
    dependencies: checkpointBound ? [checkpoint.id] : [],
    inputs: { value: "accepted" },
    outputs: ["receipt"],
    success_criteria: ["receipt:succeeded"],
    validators: [OPERATION_RECEIPT_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: { adapter: "conformance-recorder" },
    limits: { max_attempts: 1 },
    resource_claims: [{ kind: "test-record", id: "outcome" }],
    recovery: classification,
  };
  if (checkpointBound) {
    checkpoint.inputs.operation_card_id = operation.id;
    proposal.graph.cards.push(operation);
  } else {
    proposal.graph.cards = [operation];
    proposal.requested_authority.commands.push("operation_execute");
  }
  proposal.requested_authority.mutations.push(TEST_OPERATION_CONTRACT);
  proposal.explicit_facts.operation_contracts.push(TEST_OPERATION_CONTRACT);
  proposal.explicit_facts.validator_contracts.push(
    OPERATION_RECEIPT_VALIDATOR,
  );
  proposal.explicit_facts.resource_claims.push({
    kind: "test-record",
    id: "outcome",
  });
  proposal.explicit_facts.limits.max_cards = checkpointBound ? 2 : 1;
  proposal.explicit_facts.limits.max_resources = 1;
  return proposal;
}

export function operationReceipt(intent, providerReceipt = { record: "accepted" }) {
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: providerReceipt,
  };
}

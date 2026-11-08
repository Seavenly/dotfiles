import { digest } from "../src/canonical.mjs";
import {
  DELEGATE_EXECUTION_AUTHORITY_SCHEMA,
  DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
  digestDelegateInputBytes,
  materializeDelegateInputEnvelope,
  serializeDelegateInputEnvelope,
} from
  "../src/delegate-input-envelope.mjs";
import { observeCardBlock } from "../src/card-block-observation-adapter.mjs";
import { dynamicCheckpointProposal } from "./dynamic-checkpoint.mjs";

export const DELEGATE_CONTRACT = "flow.delegated-agent-port/v1";
export const DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";

export function delegateCardProposal(description, { maxAttempts = 1 } = {}) {
  const proposal = dynamicCheckpointProposal();
  const checkpoint = proposal.graph.cards[0];
  const delegate = {
    id: "delegate-review",
    executor: { kind: "delegate", contract: DELEGATE_CONTRACT },
    dependencies: [checkpoint.id],
    inputs: {
      description,
      prompt: "inspect the exact candidate",
      wait_timeout_ms: 1000,
    },
    outputs: ["validated_output"],
    success_criteria: ["output:accepted"],
    validators: [DELEGATE_OUTPUT_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: {
      agent_id: "agent:delegate-review",
      configuration_watermark: description.watermark.content_sha256,
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    },
    limits: { max_attempts: maxAttempts },
    resource_claims: [],
    recovery: "discover_then_dispatch_exact",
  };
  checkpoint.inputs.delegate_card_id = delegate.id;
  proposal.graph.cards.push(delegate);
  proposal.requested_authority.commands.push("delegate_execute");
  proposal.requested_authority.commands.push("terminal_disposition");
  proposal.explicit_facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  proposal.explicit_facts.limits.max_cards = 2;
  return proposal;
}

export function capabilityBlockedDelegateProposal(
  description,
  { maxAttempts = 1 } = {},
) {
  const proposal = delegateCardProposal(description, { maxAttempts });
  const block = {
    schema: "flow.card-block/v1",
    id: "delegate-review:repository-read",
    type: "capability_required",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "capability_required",
      code: "repository_read_required",
    },
    required_capabilities: ["repository:read"],
    revision_template_ids: [],
  };
  proposal.requested_authority.commands.push("capability_grant");
  proposal.explicit_facts.operation_contracts.push(
    "flow.adapter/card-block-observation/v1",
  );
  proposal.explicit_facts.validator_contracts.push(
    "flow.validator/card-block-observation/v1",
  );
  proposal.explicit_facts.capability_envelopes.push("repository:read");
  proposal.explicit_facts.limits.max_capabilities = 1;
  proposal.explicit_facts.block_observations.push(structuredClone(
    observeCardBlock({ card_id: "delegate-review", block }),
  ));
  return proposal;
}

export function completedTurnProjection({
  agentId = "agent:delegate-review",
  callerKey,
  description,
  output = "accepted output",
  prompt,
  steering = [],
  turnId = "turn:delegate-review",
} = {}) {
  const inputKey = `${callerKey}:input:1`;
  const initialPrompt = projectionPrompt(prompt, {
    callerKey,
    description,
    inputKey,
    instructions: "inspect the exact candidate",
    sequence: 1,
    inputKind: "initial",
  });
  const inputs = [{
    sequence: 1,
    caller_key: inputKey,
    payload_sha256: digestDelegateInputBytes(initialPrompt),
    delivery: { status: "submitted" },
  }, ...steering.map(({ caller_id: callerId, prompt: steeringPrompt }, index) => {
    const serialized = projectionPrompt(steeringPrompt, {
      callerKey,
      description,
      inputKey: `${callerKey}:steering:${callerId}`,
      instructions: `steer ${callerId}`,
      sequence: index + 2,
      inputKind: "steering",
    });
    return {
      sequence: index + 2,
      caller_key: `${callerKey}:steering:${callerId}`,
      payload_sha256: digestDelegateInputBytes(serialized),
      delivery: { status: "submitted" },
    };
  })];
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "wait",
    status: "completed",
    watermark: {
      schema: "drovr.turn-authority-watermark/v1",
      authority: "drovr.registry",
      turn_id: turnId,
      record_sha256: digest({ turnId, output }),
    },
    delegation: {
      agent_id: agentId,
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn: {
      id: turnId,
      status: "completed",
      caller: {
        dispatch_key: callerKey,
        payload_sha256: digest("dispatch"),
        metadata: description.caller_metadata,
      },
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: description.comparison_keys.launch,
        configuration_watermark: description.watermark.content_sha256,
        description_digest: description.description_digest,
      },
      inputs,
      settlement_proof: {
        schema: "drovr.turn-settlement-proof/v1",
        classification: "exact_transcript_correlation",
        launch_comparison_key: description.comparison_keys.launch,
        configuration_watermark: description.watermark.content_sha256,
        description_digest: description.description_digest,
        ordered_inputs: inputs.map((input) => ({
          sequence: input.sequence,
          caller_key: input.caller_key,
          payload_sha256: input.payload_sha256,
          delivery_proof: "exact_transcript_correlation",
        })),
      },
      result: { text: output, messages: [output] },
    },
    legal_next_actions: ["retire_agent"],
  };
}

function projectionPrompt(prompt, context) {
  if (typeof prompt === "string") {
    try {
      if (JSON.parse(prompt)?.schema === "flow.delegate-input-envelope/v1") {
        return prompt;
      }
    } catch {
      // A legacy fixture prompt is converted into the canonical envelope.
    }
    return defaultDelegatePrompt({ ...context, instructions: prompt });
  }
  return defaultDelegatePrompt(context);
}

function defaultDelegatePrompt({
  callerKey,
  description,
  inputKey,
  instructions,
  sequence,
  inputKind,
}) {
  const envelope = materializeDelegateInputEnvelope({
    attemptId: callerKey,
    inputKey,
    sequence,
    inputKind,
    instructions,
    taskInputs: { schema: "flow.delegate-task-inputs/v1" },
    resourceReferences: [],
    executionAuthority: {
      schema: DELEGATE_EXECUTION_AUTHORITY_SCHEMA,
      owner: "RunAuthority",
      capability: description.launch.capability,
      effective_authority_digest:
        description.comparison_keys.effective_authority,
      capability_envelope_ids: [],
    },
    outputRequirements: {
      schema: DELEGATE_OUTPUT_REQUIREMENTS_SCHEMA,
      format: "canonical-json",
      schemas: ["validated_output"],
      validator_contracts: [DELEGATE_OUTPUT_VALIDATOR],
    },
  });
  return serializeDelegateInputEnvelope(envelope).bytes;
}

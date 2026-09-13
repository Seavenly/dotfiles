import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { compileDynamicPlan } from "../src/plan-compiler.mjs";
import { preparedObservation } from "../src/reboot-revalidation.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { decideLifecycle } from "../src/lifecycle-kernel.mjs";
import {
  createFeatureDefinition,
  FEATURE_CAPTURE_RECEIPT_VALIDATOR,
  FEATURE_TEST_RECEIPT_VALIDATOR,
  FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
  FEATURE_OPERATION_CONTRACTS,
  createFeatureCaptureOperation,
  validateFeatureCaptureReceipt,
  validateFeatureTestReceipt,
  validateFeatureVerificationReceipt,
} from "../src/feature-flow.mjs";
import { validateFeatureRepairContract } from
  "../src/feature-repair-contract.mjs";
import {
  buildReviewTargetObservation,
  createReviewDefinition,
  REVIEW_DELEGATE_OUTPUT_VALIDATOR,
} from "../src/review-flow.mjs";
import { observeCardBlock } from "../src/card-block-observation-adapter.mjs";
import { createDurableRunAuthority, createInMemoryRunAuthority } from
  "../src/run-authority.mjs";
import {
  getArtifactAuthority,
  getResourceHandoffAuthority,
  getReviewAuthority,
  getRunEffectIntentReader,
  getWorkspaceAuthority,
  workspaceEffectAuthorityIssue,
} from "../src/work-authority.mjs";
import { completedTurnProjection } from "../test-support/delegate-card.mjs";
import {
  dynamicCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import {
  shippedAuthorityRegistrations,
  shippedAuthorityStateFromFacts,
} from "../test-support/authority-bindings.mjs";
import { supportedDescription } from
  "../test-support/delegated-agent-description.mjs";

const DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";

test("feature/v1 verify selection prepares an honest candidate plan", () => {
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.operation_contracts = Object.values(FEATURE_OPERATION_CONTRACTS);
  facts.validator_contracts.push("flow.validator/operation-receipt/v1");
  facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_CAPTURE_RECEIPT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_TEST_RECEIPT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_VERIFICATION_RECEIPT_VALIDATOR);
  facts.resource_claims.push({
    kind: "workspace",
    id: "workspace:producer",
    generation: 1,
    mutation_epoch: 7,
    fingerprint: digestValue({ git: exactGitFacts() }),
  });
  facts.limits.max_cards = 8;
  facts.limits.max_resources = 4;
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    registeredOperations: Object.fromEntries(
      Object.values(FEATURE_OPERATION_CONTRACTS).map((contract) => [contract, {
        classification: contract === FEATURE_OPERATION_CONTRACTS.capture
          ? "reconcilable"
          : "caller_idempotent",
        ...(contract === FEATURE_OPERATION_CONTRACTS.test ? {
          provider_receipt_validator: FEATURE_TEST_RECEIPT_VALIDATOR,
          validateReceipt: validateFeatureTestReceipt,
        } : {}),
        ...(contract === FEATURE_OPERATION_CONTRACTS.capture ? {
          provider_receipt_validator: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
          validateReceipt: validateFeatureCaptureReceipt,
        } : {}),
        ...(contract === FEATURE_OPERATION_CONTRACTS.verify ? {
          provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
          validateReceipt: validateFeatureVerificationReceipt,
        } : {}),
        ...(contract === FEATURE_OPERATION_CONTRACTS.capture ? {
          observe() {
            return undefined;
          },
        } : {}),
        invoke() {
          throw new Error("feature operations are not invoked during preparation");
        },
      }]),
    ),
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
    },
  });
  const inputs = featureInputs();

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs,
    explicit_facts: facts,
  });

  assert.equal(prepared.kind, "predefined");
  assert.equal(prepared.definition.id, "feature/v1");
  assert.equal(prepared.selection.inputs.mode, "verify");
  assert.equal(prepared.confirmation.schema, "flow.predefined-flow-confirmation/v1");
  assert.equal(prepared.trust_posture.evidence, "registered_operations_only");
  assert.deepEqual(prepared.required_authorities.map(({ id }) => id), [
    "contract:facts",
    "generation:facts",
    "resource:facts",
    "route:facts",
  ]);
  assert.equal(prepared.required_authorities.every(({ observation }) =>
    observation.status === "available" && observation.watermark.startsWith("sha256:")), true);
  assert.equal(
    prepared.trust_posture.delegation,
    "bounded_implementation_and_independent_critique_only",
  );
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  assert.equal(cards.get("feature-apply").executor.kind, "delegate");
  assert.equal(cards.get("feature-critique").executor.kind, "delegate");
  assert.deepEqual(cards.get("feature-critique").dependencies, [
    "feature-apply",
    "feature-capture",
    "feature-verify",
  ]);
  assert.equal(cards.get("feature-capture").executor.kind, "operation");
  assert.equal(cards.get("feature-capture").executor.contract,
    FEATURE_OPERATION_CONTRACTS.capture);
  assert.deepEqual(cards.get("feature-capture").resource_claims, []);
  assert.equal(cards.get("feature-verify").executor.kind, "operation");
  assert.equal(cards.get("feature-seal").executor.kind, "operation");
  assert.deepEqual(cards.get("feature-apply").validators, [
    DELEGATE_OUTPUT_VALIDATOR,
  ]);
  assert.deepEqual(cards.get("feature-critique").validators, [
    DELEGATE_OUTPUT_VALIDATOR,
  ]);
  assert.deepEqual(cards.get("feature-verify").validators, [
    "flow.validator/operation-receipt/v1",
  ]);
  assert.deepEqual(cards.get("feature-seal").validators, [
    "flow.validator/operation-receipt/v1",
  ]);
  assert.notEqual(
    cards.get("feature-apply").route.agent_id,
    cards.get("feature-critique").route.agent_id,
  );
  assert.notEqual(
    cards.get("feature-apply").inputs.description.description_digest,
    cards.get("feature-critique").inputs.description.description_digest,
  );
  assert.deepEqual(
    cards.get("feature-apply").inputs.description,
    inputs.delegation.apply.description,
  );
  assert.deepEqual(
    cards.get("feature-critique").route,
    inputs.delegation.critique.route,
  );
  assert.equal(cards.get("feature-apply").inputs.wait_timeout_ms, 300_000);
  assert.equal(cards.get("feature-critique").inputs.wait_timeout_ms, 300_000);
  assert.equal(cards.get("feature-verify").inputs.receipt_owner,
    "registered_operation");
  assert.equal(cards.get("feature-seal").inputs.receipt_owner,
    "registered_operation");
  assert.deepEqual(cards.get("feature-verify").inputs.delegate_evidence_card_ids, [
    "feature-apply",
  ]);
  assert.deepEqual(cards.get("feature-verify").inputs.operation_evidence_card_ids, [
    "feature-capture",
  ]);
  assert.deepEqual(cards.get("feature-critique").inputs.delegate_evidence_card_ids, [
    "feature-apply",
  ]);
  assert.deepEqual(cards.get("feature-critique").inputs.operation_evidence_card_ids, [
    "feature-capture",
  ]);
  assert.deepEqual(cards.get("feature-seal").inputs.delegate_evidence_card_ids, [
    "feature-apply",
    "feature-critique",
  ]);
  assert.deepEqual(cards.get("feature-seal").inputs.operation_evidence_card_ids, [
    "feature-capture",
    "feature-verify",
  ]);
  assert.deepEqual(cards.get("feature-apply").outputs, [
    "workspace_mutation_observation",
  ]);
  assert.deepEqual(cards.get("feature-critique").outputs, [
    "critique_observation",
  ]);
  assert.deepEqual(prepared.confirmation.negative_outcomes, [
    "no review, integration, push, pull request, cleanup, or tracker completion",
  ]);

  const changedRouteInputs = structuredClone(inputs);
  changedRouteInputs.delegation.critique.route.agent_id =
    "agent:feature-critique-alternate";
  const changedRoutePrepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs: changedRouteInputs,
    explicit_facts: facts,
  });
  assert.notEqual(changedRoutePrepared.bundle_digest, prepared.bundle_digest);

  const nonIndependentInputs = structuredClone(inputs);
  nonIndependentInputs.delegation.critique.route.agent_id =
    nonIndependentInputs.delegation.apply.route.agent_id;
  assert.throws(
    () => runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "feature/v1",
      inputs: nonIndependentInputs,
      explicit_facts: facts,
    }),
    /independently declared route/,
  );
});

test("feature/v1 prepares and launches without future candidate identities", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-feature-prep-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-feature-prep", "feature-prep"),
  });
  t.after(() => runAuthority.close());

  const inputs = featureInputs();
  delete inputs.finalization;
  inputs.workspace.git = exactGitFacts();
  inputs.delegation = {
    ...inputs.delegation,
    apply: featureDelegateBindingFromDescription(
      "apply",
      await supportedDescription({
        schema: "drovr.delegated-agent-description-request/v1",
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "read-only",
        },
        caller_metadata: { owner: "feature-flow-preparation" },
      }, {}),
    ),
    critique: featureDelegateBindingFromDescription(
      "critique",
      await supportedDescription({
        schema: "drovr.delegated-agent-description-request/v1",
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "read-only",
        },
        caller_metadata: { owner: "feature-flow-preparation" },
      }, {}),
    ),
  };
  const facts = featureFactsForInputs(inputs);
  const runtime = featurePreparationRuntime(
    runAuthority,
    facts,
  );

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs,
    explicit_facts: facts,
  });

  const serialized = JSON.stringify(prepared);
  assert.equal(prepared.selection.inputs.finalization, undefined);
  assert.equal(serialized.includes('"candidate_id"'), false);
  assert.equal(serialized.includes('"artifacts":'), false);
  assert.equal(Object.hasOwn(prepared.selection.inputs, "patch"), false);
  assert.deepEqual(prepared.graph.result_bindings.filter(({ consumer_card_id }) =>
    consumer_card_id === "feature-verify"), [{
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-verify",
      producer_card_id: "feature-apply",
      output_contract: "workspace_mutation_observation",
      expected_schema: "flow.delegate-evidence/v1",
    }, {
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-verify",
      producer_card_id: "feature-capture",
      output_contract: "candidate_capture_receipt",
      expected_schema: "work.feature-capture-receipt/v1",
    }]);
  assert.deepEqual(prepared.graph.result_bindings.filter(({ consumer_card_id }) =>
    consumer_card_id === "feature-critique"), [{
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-critique",
      producer_card_id: "feature-apply",
      output_contract: "workspace_mutation_observation",
      expected_schema: "flow.delegate-evidence/v1",
    }, {
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-critique",
      producer_card_id: "feature-capture",
      output_contract: "candidate_capture_receipt",
      expected_schema: "work.feature-capture-receipt/v1",
    }]);
  assert.deepEqual(prepared.graph.result_bindings.filter(({ consumer_card_id }) =>
    consumer_card_id === "feature-seal"), [
    {
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-seal",
      producer_card_id: "feature-apply",
      output_contract: "workspace_mutation_observation",
      expected_schema: "flow.delegate-evidence/v1",
    },
    {
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-seal",
      producer_card_id: "feature-capture",
      output_contract: "candidate_capture_receipt",
      expected_schema: "work.feature-capture-receipt/v1",
    },
    {
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-seal",
      producer_card_id: "feature-critique",
      output_contract: "critique_observation",
      expected_schema: "flow.delegate-evidence/v1",
    },
    {
      schema: "flow.result-binding/v1",
      consumer_card_id: "feature-seal",
      producer_card_id: "feature-verify",
      output_contract: "verification_receipt",
      expected_schema: "work.feature-verification-receipt/v1",
    },
  ]);

  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.created, true, JSON.stringify(launch));
});

test("feature/v1 carries the exact capture policy into seal finalization", () => {
  const inputs = featureInputs();
  inputs.finalization.publication.retention = "pinned_candidate";
  inputs.finalization.publication.workspace.disposition = "retain_for_audit";
  inputs.finalization.publication.subject = {
    contract: "work.workspace/v1",
    subject_id: inputs.workspace.subject_id,
  };
  inputs.finalization.publication.allowed_consumer_operations = [
    "read_workspace",
    "inspect_candidate",
  ];
  inputs.finalization.publication.consumer_operation_authority = [
    { operation: "read_workspace", access: "read_only" },
    { operation: "inspect_candidate", access: "read_only" },
  ];
  inputs.finalization.publication.authority_envelope = {
    capabilities: ["repository:read", "candidate:inspect"],
  };
  inputs.finalization.publication.cleanup_obligations = [
    "retain_artifact_bytes",
    "retain_git_reference",
  ];
  inputs.finalization.publication.intended_consumer = "reviewer";
  const prepared = prepareFeatureSelection(inputs);
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));

  assert.deepEqual(
    cards.get("feature-seal").inputs.capture_policy,
    cards.get("feature-capture").inputs.capture_policy,
  );
  assert.equal(
    cards.get("feature-seal").inputs.capture_policy.retention,
    "pinned_candidate",
  );
  assert.equal(
    cards.get("feature-seal").inputs.capture_policy.disposition,
    "retain_for_audit",
  );
  assert.deepEqual(
    cards.get("feature-seal").inputs.capture_policy.publication_policy,
    {
      subject: inputs.finalization.publication.subject,
      allowed_consumer_operations:
        inputs.finalization.publication.allowed_consumer_operations,
      consumer_operation_authority:
        inputs.finalization.publication.consumer_operation_authority,
      authority_envelope: inputs.finalization.publication.authority_envelope,
      cleanup_obligations: inputs.finalization.publication.cleanup_obligations,
      intended_consumer: inputs.finalization.publication.intended_consumer,
    },
  );
});

test("feature/v1 identity-free preparation accepts an explicit capture policy", () => {
  const inputs = featureInputs();
  delete inputs.finalization;
  inputs.workspace.git = exactGitFacts();
  inputs.capture_policy = {
    schema: "flow.feature-capture-policy/v1",
    starting_workspace: structuredClone(inputs.workspace),
    starting_git: structuredClone(inputs.workspace.git),
    permitted_transformations: ["accepted_brief"],
    validation_contract: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    retention: "pinned_candidate",
    disposition: "retain_for_audit",
    publication_policy: {
      subject: {
        contract: "work.workspace/v1",
        subject_id: inputs.workspace.subject_id,
      },
      allowed_consumer_operations: ["read_workspace", "inspect_candidate"],
      consumer_operation_authority: [
        { operation: "read_workspace", access: "read_only" },
        { operation: "inspect_candidate", access: "read_only" },
      ],
      authority_envelope: {
        capabilities: ["repository:read", "candidate:inspect"],
      },
      cleanup_obligations: ["retain_artifact_bytes", "retain_git_reference"],
      intended_consumer: "reviewer",
    },
  };
  const prepared = prepareFeatureSelection(inputs);
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  const canonicalPolicy = structuredClone(inputs.capture_policy);
  canonicalPolicy.publication_policy.allowed_consumer_operations = [
    "inspect_candidate",
    "read_workspace",
  ];
  canonicalPolicy.publication_policy.consumer_operation_authority = [
    { operation: "inspect_candidate", access: "read_only" },
    { operation: "read_workspace", access: "read_only" },
  ];
  assert.deepEqual(
    cards.get("feature-capture").inputs.capture_policy,
    canonicalPolicy,
  );
  assert.deepEqual(
    cards.get("feature-seal").inputs.capture_policy,
    canonicalPolicy,
  );
  assert.equal(JSON.stringify(prepared).includes("candidate_id"), false);
  assert.equal(JSON.stringify(prepared).includes('"artifacts"'), false);

  const malformed = structuredClone(inputs);
  malformed.capture_policy.candidate_id = "candidate:future";
  assert.throws(
    () => prepareFeatureSelection(malformed),
    /capture policy is not an exact identity-free preparation policy/,
  );
});

test("feature/v1 identity-free custom policy derives the exact seal publication", async (t) => {
  const policyInputs = featureInputs();
  delete policyInputs.finalization;
  policyInputs.workspace.git = exactGitFacts();
  const policy = {
    schema: "flow.feature-capture-policy/v1",
    starting_workspace: structuredClone(policyInputs.workspace),
    starting_git: structuredClone(policyInputs.workspace.git),
    permitted_transformations: ["accepted_brief"],
    validation_contract: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
    retention: "pinned_candidate",
    disposition: "retain_for_audit",
    publication_policy: {
      subject: {
        contract: "work.workspace/v1",
        subject_id: policyInputs.workspace.subject_id,
      },
      allowed_consumer_operations: ["read_workspace", "inspect_candidate"],
      consumer_operation_authority: [
        { operation: "read_workspace", access: "read_only" },
        { operation: "inspect_candidate", access: "read_only" },
      ],
      authority_envelope: {
        capabilities: ["repository:read", "candidate:inspect"],
      },
      cleanup_obligations: ["retain_artifact_bytes", "retain_git_reference"],
      intended_consumer: "reviewer",
    },
  };
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    capturePolicy: policy,
  });
  await driveFeatureToSeal(fixture);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  const seal = fixture.sealIntents.at(-1);
  assert.equal(seal.operation_input.finalization.publication.retention,
    policy.retention);
  assert.equal(seal.operation_input.finalization.publication.workspace.disposition,
    policy.disposition);
  assert.deepEqual(
    seal.operation_input.finalization.publication.subject,
    policy.publication_policy.subject,
  );
  assert.deepEqual(
    seal.operation_input.finalization.publication.allowed_consumer_operations,
    ["inspect_candidate", "read_workspace"],
  );
  assert.deepEqual(
    seal.operation_input.finalization.publication.consumer_operation_authority,
    [
      { operation: "inspect_candidate", access: "read_only" },
      { operation: "read_workspace", access: "read_only" },
    ],
  );
  assert.deepEqual(
    seal.operation_input.finalization.publication.authority_envelope,
    policy.publication_policy.authority_envelope,
  );
  assert.deepEqual(
    seal.operation_input.finalization.publication.cleanup_obligations,
    policy.publication_policy.cleanup_obligations,
  );
  assert.equal(seal.operation_input.finalization.publication.intended_consumer,
    policy.publication_policy.intended_consumer);
});

test("feature/v1 identity-free preparation requires starting Git facts", () => {
  const inputs = featureInputs();
  delete inputs.finalization;
  const facts = featureFactsForInputs(inputs);
  assert.throws(
    () => prepareFeatureSelection(inputs, facts),
    (error) => error?.reason === "missing_starting_git_facts",
  );
});

test("dynamic result-binding declarations have canonical order", () => {
  const prepared = prepareFeatureSelection(featureInputs());
  const proposal = {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: structuredClone(prepared.graph),
    requested_authority: structuredClone(prepared.requested_authority),
    explicit_facts: structuredClone(prepared.explicit_facts),
    revision_templates: [],
  };
  const reordered = structuredClone(proposal);
  reordered.graph.result_bindings.reverse();
  const canonical = compileDynamicPlan(proposal);
  const reorderedCanonical = compileDynamicPlan(reordered);
  assert.equal(canonical.bundle_digest, reorderedCanonical.bundle_digest);
  assert.deepEqual(
    canonical.graph.result_bindings,
    reorderedCanonical.graph.result_bindings,
  );
});

test("feature/v1 prepares an exact bounded critique repair template", () => {
  const inputs = featureInputs();
  const base = prepareFeatureSelection(inputs);
  const originalSeal = base.graph.cards.find(({ id }) => id === "feature-seal");
  const repairTemplateId = "feature-repair-critique";
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "feature_critique_repair_required",
  };
  const repairCard = {
    id: "feature-seal-repair",
    replaces_card_id: "feature-seal",
    executor: {
      kind: "operation",
      contract: FEATURE_OPERATION_CONTRACTS.seal,
      effect_classification: "caller_idempotent",
    },
    dependencies: [],
    inputs: {
      brief: inputs.brief,
      mode: inputs.mode,
      workspace: inputs.workspace,
      verification: normalizedFeatureVerificationInput(inputs),
      phase: "seal",
      negative_outcomes: [
        "no review, integration, push, pull request, cleanup, or tracker completion",
      ],
      receipt_owner: "registered_operation",
      delegate_output_usage: "evidence_input_only",
      delegate_evidence_card_ids: ["feature-apply", "feature-critique"],
      operation_evidence_card_ids: ["feature-capture", "feature-verify"],
      capture_policy: structuredClone(originalSeal.inputs.capture_policy),
      finalization: inputs.finalization,
      publication: inputs.finalization.publication,
    },
    outputs: ["review_candidate_receipt"],
    success_criteria: ["registered_operation_receipt:succeeded"],
    validators: ["flow.validator/operation-receipt/v1"],
    data_references: [inputs.brief.id],
    evidence_references: [
      `flow.feature-verification-request/v1:${inputs.verification.baseline.fingerprint}`,
    ],
    route: null,
    limits: { max_attempts: 1 },
    resource_claims: [{
      kind: "workspace",
      id: inputs.workspace.subject_id,
      generation: inputs.workspace.generation,
      mutation_epoch: inputs.workspace.mutation_epoch,
      fingerprint: inputs.workspace.fingerprint,
    }],
    recovery: "caller_idempotent",
  };
  inputs.repairs = [{
    schema: "flow.feature-repair/v1",
    id: "repair:critique",
    kind: "critique",
    card_id: "feature-seal",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["re-run the independent critique and seal"],
    template: {
      schema: "flow.plan-revision-template/v1",
      id: repairTemplateId,
      trigger,
      limits: { max_applications: 1 },
      changes: {
        add_cards: [repairCard],
        add_edges: [{ from: "feature-critique", to: repairCard.id }],
        supersede_cards: ["feature-seal"],
        capability_additions: [],
        resource_additions: [],
        limit_changes: {},
      },
    },
  }];
  const facts = featureFactsForInputs(inputs);
  facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
  facts.validator_contracts.push("flow.validator/card-block-observation/v1");
  Object.assign(facts.limits, {
    max_revisions: 1,
    max_cards_per_revision: 1,
  });
  facts.block_observations.push(observeCardBlock({
    card_id: "feature-seal",
    block: {
      schema: "flow.card-block/v1",
      id: "feature-seal:critique-repair",
      type: "plan_revision_required",
      trigger,
      required_capabilities: [],
      revision_template_ids: [repairTemplateId],
    },
  }));

  const prepared = prepareFeatureSelection(inputs, facts);

  assert.deepEqual(prepared.revision_templates.map(({ id, repair }) => ({
    id,
    repair,
  })), [{
    id: repairTemplateId,
    repair: {
      schema: "flow.feature-repair/v1",
      id: "repair:critique",
      kind: "critique",
      card_id: "feature-seal",
      acceptance: ["the changed behavior is observable"],
      remaining_scope: ["re-run the independent critique and seal"],
      scope_expansion: false,
      checkpoint_id: null,
    },
  }]);
  assert.equal(prepared.requested_authority.commands.includes("revision_decision"), true);
  assert.equal(prepared.confirmation.revision_templates.length, 1);
});

test("feature/v1 repairs preserve every authority-bearing card field", () => {
  const inputs = featureInputs();
  const base = prepareFeatureSelection(inputs);
  const existingCards = base.graph.cards.map((card) => structuredClone(card));
  const original = existingCards.find(({ id }) => id === "feature-apply");
  original.inputs.managed_agent = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:feature-apply",
    card_ids: [original.id],
    terminal_card_id: original.id,
  };
  const repair = {
    schema: "flow.feature-repair/v1",
    id: "repair:authority-fields",
    kind: "replan",
    card_id: original.id,
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["retain the original authority contract"],
    scope_expansion: false,
    checkpoint_id: null,
  };
  const template = {
    schema: "flow.plan-revision-template/v1",
    id: "feature-repair-authority-fields",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: "feature_replan_required",
    },
    limits: { max_applications: 1 },
    changes: {
      add_cards: [],
      add_edges: [],
      supersede_cards: [original.id],
      capability_additions: [],
      resource_additions: [],
      limit_changes: {},
    },
  };
  const validReplacement = () => {
    const replacement = structuredClone(original);
    replacement.id = "feature-apply-repair";
    replacement.replaces_card_id = original.id;
    replacement.inputs.managed_agent.card_ids = [replacement.id];
    replacement.inputs.managed_agent.terminal_card_id = replacement.id;
    template.changes.add_cards = [replacement];
    return replacement;
  };
  validReplacement();
  assert.doesNotThrow(() => validateFeatureRepairContract({
    repair,
    template,
    existingCards,
    brief: inputs.brief,
    fail(reason, message) {
      throw new Error(`${reason}: ${message}`);
    },
  }));
  const missingIdentity = validReplacement();
  delete missingIdentity.replaces_card_id;
  assert.throws(
    () => validateFeatureRepairContract({
      repair,
      template,
      existingCards,
      brief: inputs.brief,
      fail(reason, message) {
        throw new Error(`${reason}: ${message}`);
      },
    }),
    /must identify a replacement.*replaces_card_id/,
  );
  validReplacement();
  const falseDerivedFlag = { ...repair, scope_expansion: true };
  assert.throws(
    () => validateFeatureRepairContract({
      repair: falseDerivedFlag,
      template,
      existingCards,
      brief: inputs.brief,
      fail(reason, message) {
        throw new Error(`${reason}: ${message}`);
      },
    }),
    /scope expansion does not match/,
  );
  for (const [field, mutate] of [
    ["route", (card) => { card.route.agent_id = "agent:changed-route"; }],
    ["description", (card) => {
      card.inputs.description = structuredClone(card.inputs.description);
      card.inputs.description.watermark.content_sha256 =
        `sha256:${"a".repeat(64)}`;
    }],
    ["prompt", (card) => { card.inputs.prompt = "changed prompt"; }],
    ["recovery", (card) => { card.recovery = "retry"; }],
    ["limits", (card) => { card.limits.max_attempts = 2; }],
    ["managed-agent", (card) => {
      card.inputs.managed_agent = structuredClone(card.inputs.managed_agent);
      card.inputs.managed_agent.card_ids = ["unbound-card"];
    }],
  ]) {
    const replacement = validReplacement();
    mutate(replacement);
    assert.throws(
      () => validateFeatureRepairContract({
        repair,
        template,
        existingCards,
        brief: inputs.brief,
        fail(reason, message) {
          throw new Error(`${reason}: ${message}`);
        },
      }),
      /authority-bearing|managed-agent|route, limits, recovery|does not safely rebind/,
      field,
    );
  }
});

test("feature/v1 repairs rebind every seal evidence reference by card identity", () => {
  const inputs = featureInputs();
  delete inputs.finalization;
  inputs.workspace.git = exactGitFacts();
  const base = prepareFeatureSelection(inputs);
  const cardsById = new Map(base.graph.cards.map((card) => [card.id, card]));
  const replace = (originalId, replacementId) => {
    const replacement = structuredClone(cardsById.get(originalId));
    replacement.id = replacementId;
    replacement.replaces_card_id = originalId;
    return replacement;
  };
  const capture = replace("feature-capture", "feature-capture-repair");
  capture.dependencies = ["feature-apply"];
  const verification = replace("feature-verify", "feature-verify-repair");
  verification.dependencies = [capture.id];
  verification.inputs.operation_evidence_card_ids = [capture.id];
  const critique = replace("feature-critique", "feature-critique-repair");
  critique.dependencies = ["feature-apply", capture.id, verification.id];
  critique.inputs.delegate_evidence_card_ids = ["feature-apply"];
  critique.inputs.operation_evidence_card_ids = [capture.id];
  const seal = replace("feature-seal", "feature-seal-repair");
  seal.dependencies = [critique.id, capture.id];
  seal.inputs.delegate_evidence_card_ids = ["feature-apply", critique.id];
  seal.inputs.operation_evidence_card_ids = [capture.id, verification.id];

  const templateId = "feature-repair-rebound-evidence";
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "feature_replan_required",
  };
  const repair = {
    schema: "flow.feature-repair/v1",
    id: "repair:rebound-evidence",
    kind: "critique",
    card_id: "feature-seal",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["rebind every seal evidence producer exactly"],
    scope_expansion: false,
    checkpoint_id: null,
  };
  const template = {
    schema: "flow.plan-revision-template/v1",
    id: templateId,
    trigger,
    limits: { max_applications: 1 },
    changes: {
      add_cards: [capture, verification, critique, seal],
      add_edges: [],
      supersede_cards: [
        "feature-capture",
        "feature-verify",
        "feature-critique",
        "feature-seal",
      ],
      capability_additions: [],
      resource_additions: [],
      limit_changes: {},
    },
  };

  const validation = validateFeatureRepairContract({
    repair,
    template,
    existingCards: base.graph.cards,
    existingResultBindings: base.graph.result_bindings,
    brief: inputs.brief,
    fail(reason, message) {
      throw new Error(`${reason}: ${message}`);
    },
  });
  const reboundSeal = validation.template.changes.add_cards.find(({ id }) =>
    id === seal.id);
  assert.deepEqual(reboundSeal.inputs.operation_evidence_card_ids, [
    capture.id,
    verification.id,
  ]);
  assert.deepEqual(reboundSeal.inputs.delegate_evidence_card_ids, [
    "feature-apply",
    critique.id,
  ]);
});

test("feature/v1 rejects an upstream repair that leaves the evidence closure without a replacement", () => {
  const inputs = featureInputs();
  const templateId = "feature-repair-upstream-empty";
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "feature_slice_repair_required",
  };
  inputs.repairs = [{
    schema: "flow.feature-repair/v1",
    id: "repair:upstream-empty",
    kind: "critique",
    card_id: "feature-critique",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["restore the independent critique evidence"],
    template: {
      schema: "flow.plan-revision-template/v1",
      id: templateId,
      trigger,
      limits: { max_applications: 1 },
      changes: {
        add_cards: [],
        add_edges: [],
        supersede_cards: ["feature-critique", "feature-seal"],
        capability_additions: [],
        resource_additions: [],
        limit_changes: {},
      },
    },
  }];
  const facts = featureFactsForInputs(inputs);
  facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
  facts.validator_contracts.push("flow.validator/card-block-observation/v1");
  facts.limits.max_revisions = 1;
  facts.block_observations.push(observeCardBlock({
    card_id: "feature-critique",
    block: {
      schema: "flow.card-block/v1",
      id: "feature-critique:empty-repair",
      type: "plan_revision_required",
      trigger,
      required_capabilities: [],
      revision_template_ids: [templateId],
    },
  }));

  assert.throws(
    () => prepareFeatureSelection(inputs, facts),
    /replacement|evidence|finalization gate/,
  );
});

test("feature/v1 does not admit a seal repair that drops seal evidence", () => {
  const inputs = featureInputs();
  inputs.repairs = [{
    schema: "flow.feature-repair/v1",
    id: "repair:incomplete-seal",
    kind: "critique",
    card_id: "feature-seal",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["retain the original seal evidence gate"],
    template: {
      schema: "flow.plan-revision-template/v1",
      id: "feature-repair-incomplete-seal",
      trigger: {
        schema: "flow.revision-trigger/v1",
        type: "plan_revision_required",
        code: "feature_critique_repair_required",
      },
      limits: { max_applications: 1 },
      changes: {
        add_cards: [{
          id: "feature-seal-repair",
          replaces_card_id: "feature-seal",
          executor: {
            kind: "operation",
            contract: FEATURE_OPERATION_CONTRACTS.seal,
            effect_classification: "caller_idempotent",
          },
          dependencies: [],
          inputs: { phase: "seal", receipt_owner: "registered_operation" },
          outputs: ["review_candidate_receipt"],
          success_criteria: ["registered_operation_receipt:succeeded"],
          validators: ["flow.validator/operation-receipt/v1"],
          data_references: [inputs.brief.id],
          evidence_references: [],
          route: null,
          limits: { max_attempts: 1 },
          resource_claims: [],
          recovery: "caller_idempotent",
        }],
        add_edges: [{ from: "feature-critique", to: "feature-seal-repair" }],
        supersede_cards: ["feature-seal"],
        capability_additions: [],
        resource_additions: [],
        limit_changes: {},
      },
    },
  }];
  const facts = featureFactsForInputs(inputs);
  facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
  facts.validator_contracts.push("flow.validator/card-block-observation/v1");
  facts.limits.max_revisions = 1;
  facts.limits.max_cards_per_revision = 1;
  facts.block_observations.push(observeCardBlock({
    card_id: "feature-seal",
    block: {
      schema: "flow.card-block/v1",
      id: "feature-seal:incomplete-repair",
      type: "plan_revision_required",
      trigger: inputs.repairs[0].template.trigger,
      required_capabilities: [],
      revision_template_ids: ["feature-repair-incomplete-seal"],
    },
  }));

  assert.throws(
    () => prepareFeatureSelection(inputs, facts),
    /retain the feature seal evidence and finalization gate/,
  );
});

test("feature/v1 legacy seal repairs preserve operation evidence references", () => {
  const inputs = featureInputs();
  const base = prepareFeatureSelection(inputs);
  const original = base.graph.cards.find(({ id }) => id === "feature-seal");
  const replacement = structuredClone(original);
  replacement.id = "feature-seal-legacy-repair";
  replacement.replaces_card_id = original.id;
  replacement.inputs.operation_evidence_card_ids = ["feature-capture"];
  const repair = {
    schema: "flow.feature-repair/v1",
    id: "repair:legacy-seal-evidence",
    kind: "critique",
    card_id: original.id,
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["retain the legacy seal evidence closure"],
    scope_expansion: false,
    checkpoint_id: null,
  };
  const template = {
    schema: "flow.plan-revision-template/v1",
    id: "feature-repair-legacy-seal-evidence",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: "feature_critique_repair_required",
    },
    limits: { max_applications: 1 },
    changes: {
      add_cards: [replacement],
      add_edges: [],
      supersede_cards: [original.id],
      capability_additions: [],
      resource_additions: [],
      limit_changes: {},
    },
  };

  assert.throws(
    () => validateFeatureRepairContract({
      repair,
      template,
      existingCards: base.graph.cards,
      brief: inputs.brief,
      fail(reason, message) {
        throw new Error(`${reason}: ${message}`);
      },
    }),
    /authority-bearing|evidence|seal evidence/,
  );
});

test("feature/v1 identity-free repair binds the replacement capture authority scope", () => {
  const inputs = featureInputs();
  delete inputs.finalization;
  inputs.workspace.git = exactGitFacts();
  const base = prepareFeatureSelection(inputs);
  const originalCapture = base.graph.cards.find(({ id }) => id === "feature-capture");
  const originalSeal = base.graph.cards.find(({ id }) => id === "feature-seal");
  const repair = {
    schema: "flow.feature-repair/v1",
    id: "repair:capture-scope",
    kind: "critique",
    card_id: originalSeal.id,
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["capture the repaired candidate with the original scope"],
    scope_expansion: false,
    checkpoint_id: null,
  };
  const template = {
    schema: "flow.plan-revision-template/v1",
    id: "feature-repair-capture-scope",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: "feature_critique_repair_required",
    },
    limits: { max_applications: 1 },
    changes: {
      add_cards: [],
      add_edges: [],
      supersede_cards: [originalSeal.id, originalCapture.id],
      capability_additions: [],
      resource_additions: [],
      limit_changes: {},
    },
  };
  const configure = (capture, seal) => {
    capture.id = "feature-capture-repair";
    capture.inputs.replaces_card_id = originalCapture.id;
    capture.dependencies = ["feature-apply"];
    seal.id = "feature-seal-repair";
    seal.replaces_card_id = originalSeal.id;
    seal.dependencies = ["feature-critique", capture.id];
    seal.inputs.operation_evidence_card_ids = [capture.id, "feature-verify"];
    template.changes.add_cards = [capture, seal];
  };
  const validate = () => validateFeatureRepairContract({
    repair,
    template,
    existingCards: base.graph.cards,
    brief: inputs.brief,
    fail(reason, message) {
      throw new Error(`${reason}: ${message}`);
    },
  });

  const validCapture = structuredClone(originalCapture);
  const validSeal = structuredClone(originalSeal);
  configure(validCapture, validSeal);
  validCapture.inputs.replaces_card_id = originalCapture.id;
  assert.doesNotThrow(validate);

  for (const [label, mutate] of [
    ["starting workspace", (capture) => {
      capture.inputs.capture_policy = structuredClone(capture.inputs.capture_policy);
      capture.inputs.capture_policy.starting_workspace = {
        ...capture.inputs.capture_policy.starting_workspace,
        mutation_epoch: capture.inputs.capture_policy.starting_workspace.mutation_epoch + 1,
      };
    }],
    ["validator", (capture) => {
      delete capture.inputs.provider_receipt_validator;
    }],
    ["limits", (capture) => {
      capture.limits = { ...capture.limits, max_attempts: 2 };
    }],
    ["resource claims", (capture) => {
      capture.resource_claims = [{
        kind: "artifact",
        id: "unplanned-repair-artifact",
      }];
    }],
  ]) {
    const capture = structuredClone(originalCapture);
    const seal = structuredClone(originalSeal);
    configure(capture, seal);
    mutate(capture);
    assert.throws(validate, /authority|scope|capture|result binding/, label);
  }
});

test("feature/v1 exposes a stale-safe repair action and recovers the blocked seal", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    repair: "critique",
  });
  await driveFeatureToSeal(fixture, { allowSealRefusal: true });
  const blocked = fixture.runtime.query({ run_id: fixture.runId });
  const revisionAction = blocked.legal_actions.find(({ type }) =>
    type === "revision_decision");
  assert.ok(revisionAction);
  assert.equal(revisionAction.expected_watermark, blocked.watermark);
  assert.deepEqual(revisionAction.repair, {
    schema: "flow.feature-repair/v1",
    id: "repair:critique",
    kind: "critique",
    card_id: "feature-seal",
    acceptance: ["the changed behavior is observable"],
    remaining_scope: ["re-run the independent critique and seal"],
    scope_expansion: false,
    checkpoint_id: null,
  });
  const stale = structuredClone(revisionAction);
  stale.base_plan_fingerprint = `sha256:${"9".repeat(64)}`;
  const rejected = fixture.runtime.command(stale);
  assert.equal(rejected.code, "revision_not_actionable");
  assert.deepEqual(fixture.runtime.query({ run_id: fixture.runId }), blocked);

  const declined = fixture.runtime.command({
    ...revisionAction,
    decision: "decline",
  });
  assert.equal(declined.accepted, true, JSON.stringify(declined));
  let stillBlocked = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(stillBlocked.phase, "active");
  assert.equal(stillBlocked.revisions.length, 0);
  assert.equal(stillBlocked.revision_outcomes.length, 1);
  assert.equal(stillBlocked.revision_outcomes[0].status, "declined");
  assert.equal(stillBlocked.revision_outcomes[0].template_id,
    revisionAction.template_id);
  assert.equal(stillBlocked.revision_outcomes[0].repair.id,
    revisionAction.repair.id);
  assert.equal(stillBlocked.revision_outcomes[0].authority_watermark,
    stillBlocked.watermark);
  assert.ok(stillBlocked.revision_outcomes[0].legal_next_actions.some(
    ({ decision }) => decision === "accept"));
  assert.ok(stillBlocked.legal_actions.some(({ type, decision }) =>
    type === "revision_decision" && decision === "accept"));
  const duplicateDecline = fixture.runtime.command(stillBlocked.legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "decline",
  ));
  assert.equal(duplicateDecline.accepted, true);
  stillBlocked = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(stillBlocked.revision_outcomes.length, 1);
  const accepted = fixture.runtime.command(stillBlocked.legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "accept",
  ));
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  const recovered = fixture.runtime.query({ run_id: fixture.runId });
  assert.deepEqual(recovered.revisions[0].repair, revisionAction.repair);
  assert.equal(recovered.cards.find(({ id }) => id === "feature-seal").status,
    "superseded");
  assert.equal(recovered.cards.find(({ id }) => id === "feature-seal-repair").status,
    "ready");
  assert.ok(recovered.legal_actions.some(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-seal-repair"));
});

test("feature/v1 rejects repair scope expansion without its exact checkpoint", () => {
  const inputs = featureInputs();
  inputs.repairs = [{
    schema: "flow.feature-repair/v1",
    id: "repair:replan",
    kind: "replan",
    card_id: "feature-seal",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["replan the bounded implementation"],
    scope_expansion: true,
    template: {
      schema: "flow.plan-revision-template/v1",
      id: "feature-replan",
      trigger: {
        schema: "flow.revision-trigger/v1",
        type: "plan_revision_required",
        code: "feature_replan_required",
      },
      limits: { max_applications: 1 },
      changes: {
        add_cards: [],
        add_edges: [],
        supersede_cards: ["feature-seal"],
        capability_additions: [],
        resource_additions: [],
        limit_changes: {},
      },
    },
  }];
  const facts = featureFactsForInputs(inputs);
  facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
  facts.validator_contracts.push("flow.validator/card-block-observation/v1");
  facts.limits.max_revisions = 1;
  facts.block_observations.push(observeCardBlock({
    card_id: "feature-seal",
    block: {
      schema: "flow.card-block/v1",
      id: "feature-seal:replan",
      type: "plan_revision_required",
      trigger: inputs.repairs[0].template.trigger,
      required_capabilities: [],
      revision_template_ids: ["feature-replan"],
    },
  }));
  assert.throws(
    () => prepareFeatureSelection(inputs, facts),
    /requires an exact scope checkpoint|evidence-preserving replacement|must identify a replacement/,
  );
});

test("feature/v1 derives expansion from added cards, resources, and limits instead of the caller flag", () => {
  const inputs = featureInputs();
  const base = prepareFeatureSelection(inputs);
  const seal = base.graph.cards.find(({ id }) => id === "feature-seal");
  const repairCard = structuredClone(seal);
  repairCard.id = "feature-seal-repair";
  repairCard.replaces_card_id = "feature-seal";
  repairCard.dependencies = ["feature-critique"];
  const checkpoint = structuredClone(dynamicCheckpointProposal().graph.cards[0]);
  checkpoint.id = "feature-repair-checkpoint";
  const templateId = "feature-repair-derived-expansion";
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "feature_replan_required",
  };
  inputs.repairs = [{
    schema: "flow.feature-repair/v1",
    id: "repair:derived-expansion",
    kind: "replan",
    card_id: "feature-seal",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["accept the exact bounded replan checkpoint"],
    scope_expansion: false,
    template: {
      schema: "flow.plan-revision-template/v1",
      id: templateId,
      trigger,
      limits: { max_applications: 1 },
      changes: {
        add_cards: [checkpoint, repairCard],
        add_edges: [{ from: checkpoint.id, to: repairCard.id }],
        supersede_cards: ["feature-seal"],
        capability_additions: [],
        resource_additions: [{ kind: "artifact", id: "repair-output" }],
        limit_changes: { max_cards: 9 },
      },
    },
  }];
  const facts = featureFactsForInputs(inputs);
  facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
  facts.validator_contracts.push("flow.validator/card-block-observation/v1");
  facts.limits.max_revisions = 1;
  facts.limits.max_cards_per_revision = 2;
  facts.block_observations.push(observeCardBlock({
    card_id: "feature-seal",
    block: {
      schema: "flow.card-block/v1",
      id: "feature-seal:derived-expansion",
      type: "plan_revision_required",
      trigger,
      required_capabilities: [],
      revision_template_ids: [templateId],
    },
  }));

  assert.throws(
    () => prepareFeatureSelection(inputs, facts),
    /requires an exact scope checkpoint|scope expansion does not match/,
  );
});

test("feature/v1 checkpoints an unrelated added capture card", () => {
  const inputs = featureInputs();
  const base = prepareFeatureSelection(inputs);
  const seal = base.graph.cards.find(({ id }) => id === "feature-seal");
  const repairCard = structuredClone(seal);
  repairCard.id = "feature-seal-repair";
  repairCard.replaces_card_id = "feature-seal";
  repairCard.dependencies = ["feature-critique"];
  const unrelatedCapture = structuredClone(base.graph.cards.find(({ id }) =>
    id === "feature-capture"));
  unrelatedCapture.id = "feature-capture-unrelated";
  unrelatedCapture.dependencies = [];
  const templateId = "feature-repair-unrelated-capture";
  const trigger = {
    schema: "flow.revision-trigger/v1",
    type: "plan_revision_required",
    code: "feature_replan_required",
  };
  inputs.repairs = [{
    schema: "flow.feature-repair/v1",
    id: "repair:unrelated-capture",
    kind: "replan",
    card_id: "feature-seal",
    acceptance: [...inputs.brief.acceptance],
    remaining_scope: ["checkpoint unrelated capture work"],
    scope_expansion: false,
    template: {
      schema: "flow.plan-revision-template/v1",
      id: templateId,
      trigger,
      limits: { max_applications: 1 },
      changes: {
        add_cards: [unrelatedCapture, repairCard],
        add_edges: [{ from: "feature-critique", to: repairCard.id }],
        supersede_cards: ["feature-seal"],
        capability_additions: [],
        resource_additions: [],
        limit_changes: {},
      },
    },
  }];
  const facts = featureFactsForInputs(inputs);
  facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
  facts.validator_contracts.push("flow.validator/card-block-observation/v1");
  facts.limits.max_revisions = 1;
  facts.limits.max_cards_per_revision = 2;
  facts.block_observations.push(observeCardBlock({
    card_id: "feature-seal",
    block: {
      schema: "flow.card-block/v1",
      id: "feature-seal:unrelated-capture",
      type: "plan_revision_required",
      trigger,
      required_capabilities: [],
      revision_template_ids: [templateId],
    },
  }));

  assert.throws(
    () => prepareFeatureSelection(inputs, facts),
    /scope expansion does not match|requires an exact scope checkpoint/,
  );
});

test("feature/v1 applies a closed target and evidence contract for every repair kind", () => {
  for (const [kind, cardId] of [
    ["slice", "feature-seal"],
    ["completeness", "feature-apply"],
    ["critique", "feature-apply"],
    ["replan", "feature-critique"],
  ]) {
    const inputs = featureInputs();
    const templateId = `feature-repair-${kind}-contract`;
    const trigger = {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: `feature_${kind}_repair_required`,
    };
    inputs.repairs = [{
      schema: "flow.feature-repair/v1",
      id: `repair:${kind}:contract`,
      kind,
      card_id: cardId,
      acceptance: [...inputs.brief.acceptance],
      remaining_scope: [`retain the ${kind} evidence contract`],
      template: {
        schema: "flow.plan-revision-template/v1",
        id: templateId,
        trigger,
        limits: { max_applications: 1 },
        changes: {
          add_cards: [],
          add_edges: [],
          supersede_cards: [cardId],
          capability_additions: [],
          resource_additions: [],
          limit_changes: {},
        },
      },
    }];
    const facts = featureFactsForInputs(inputs);
    facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
    facts.validator_contracts.push("flow.validator/card-block-observation/v1");
    facts.limits.max_revisions = 1;
    facts.block_observations.push(observeCardBlock({
      card_id: cardId,
      block: {
        schema: "flow.card-block/v1",
        id: `${cardId}:${kind}-contract`,
        type: "plan_revision_required",
        trigger,
        required_capabilities: [],
        revision_template_ids: [templateId],
      },
    }));
    assert.throws(
      () => prepareFeatureSelection(inputs, facts),
      new RegExp(`feature ${kind} repair must target`),
    );
  }
});

test("feature/v1 admits serialized slice and completeness repairs with explicit identities", async (t) => {
  for (const [targetId, kind] of [
    ["feature-slice-red-test", "slice"],
    ["feature-slice-blue-verify", "slice"],
    ["feature-verify", "completeness"],
  ]) {
    const inputs = featureInputs();
    inputs.mode = "mixed";
    inputs.brief.acceptance = ["the red behavior is observable", "the blue behavior is observable"];
    inputs.verification = {
      schema: "flow.feature-verification-request/v1",
      compensating_assertion: {
        schema: "flow.feature-compensating-assertion/v1",
        assertion: "the changed behavior remains bounded",
        non_destructive: true,
        fingerprint: `sha256:${"8".repeat(64)}`,
      },
    };
    inputs.slices = [
      {
        schema: "flow.feature-slice/v1",
        id: "red",
        mode: "test",
        acceptance: ["the red behavior is observable"],
        test: {
          schema: "flow.feature-test-request/v1",
          intended_failure: "the red behavior is absent before apply",
          environment_fingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
      {
        schema: "flow.feature-slice/v1",
        id: "blue",
        mode: "verify",
        acceptance: ["the blue behavior is observable"],
      },
    ];
    if (targetId === "feature-slice-red-test") {
      const applyDescription = await supportedDescription({
        schema: "drovr.delegated-agent-description-request/v1",
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "read-only",
        },
        caller_metadata: { owner: "feature-flow-serialized-repair" },
      }, {});
      const critiqueDescription = await supportedDescription({
        schema: "drovr.delegated-agent-description-request/v1",
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "read-only",
        },
        caller_metadata: { owner: "feature-flow-serialized-repair" },
      }, {});
      inputs.delegation = {
        ...inputs.delegation,
        apply: featureDelegateBindingFromDescription("apply", applyDescription),
        critique: featureDelegateBindingFromDescription(
          "critique",
          critiqueDescription,
        ),
      };
    }
    const base = prepareFeatureSelection(inputs);
    const target = base.graph.cards.find(({ id }) => id === targetId);
    assert.ok(target, targetId);
    const superseded = downstreamClosure(base.graph.cards, targetId);
    const replacements = new Map(superseded.map((card) => [
      card.id,
      `${card.id}-repair`,
    ]));
    const addCards = superseded.map((card) => {
      const replacement = structuredClone(card);
      replacement.id = replacements.get(card.id);
      replacement.replaces_card_id = card.id;
      replacement.dependencies = card.dependencies.map((id) =>
        replacements.get(id) ?? id);
      replacement.inputs = rebindFeatureCardInputs(replacement.inputs, replacements);
      if (replacement.inputs?.managed_agent) {
        replacement.inputs.managed_agent = rebindFeatureManagedAgent(
          replacement.inputs.managed_agent,
          replacements,
        );
      }
      return replacement;
    });
    const templateId = `feature-repair-${targetId}`;
    inputs.repairs = [{
      schema: "flow.feature-repair/v1",
      id: `repair:${targetId}`,
      kind,
      card_id: targetId,
      acceptance: [...inputs.brief.acceptance],
      remaining_scope: [`re-run ${targetId} with the original evidence contract`],
      scope_expansion: false,
      template: {
        schema: "flow.plan-revision-template/v1",
        id: templateId,
        trigger: {
          schema: "flow.revision-trigger/v1",
          type: "plan_revision_required",
          code: "feature_slice_repair_required",
        },
        limits: { max_applications: 1 },
        changes: {
          add_cards: addCards,
          add_edges: [],
          supersede_cards: superseded.map(({ id }) => id),
          capability_additions: [],
          resource_additions: [],
          limit_changes: {},
        },
      },
    }];
    const facts = featureFactsForInputs(inputs);
    facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
    facts.validator_contracts.push("flow.validator/card-block-observation/v1");
    facts.limits.max_revisions = 1;
    facts.limits.max_cards_per_revision = addCards.length;
    facts.block_observations.push(observeCardBlock({
      card_id: targetId,
      block: {
        schema: "flow.card-block/v1",
        id: `${targetId}:repair`,
        type: "plan_revision_required",
        trigger: inputs.repairs[0].template.trigger,
        required_capabilities: [],
        revision_template_ids: [templateId],
      },
    }));
    let runtime = null;
    if (targetId === "feature-slice-red-test") {
      const authorityDirectory = await mkdtemp(join(
        tmpdir(),
        "flow-feature-serialized-repair-",
      ));
      t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
      const runAuthority = createDurableRunAuthority({
        authorityDirectory,
        gitRetentionAdapter: deterministicGitRetentionAdapter(),
        gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
          promotion: true,
        }),
        hostIdentityAdapter: fixedHostIdentity(
          "boot-feature-serialized-repair",
          "feature-process-serialized-repair",
        ),
      });
      t.after(() => runAuthority.close());
      runtime = featurePreparationRuntime(runAuthority, facts);
    }
    const prepared = prepareFeatureSelection(inputs, facts, runtime);
    assert.equal(prepared.revision_templates[0].repair.kind, kind);
    assert.deepEqual(
      prepared.revision_templates[0].changes.supersede_cards,
      superseded.map(({ id }) => id),
    );

    if (runtime !== null) {
      const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
      assert.equal(launch.created, true, JSON.stringify(launch));
      let projection = runtime.query({ run_id: launch.run_id });
      assert.equal(projection.cards.find(({ id }) =>
        id === targetId).status, "blocked");
      const revisionAction = projection.legal_actions.find(({ type, decision }) =>
        type === "revision_decision" && decision === "accept");
      assert.ok(revisionAction);
      const watcher = runtime.watch({ run_id: launch.run_id })
        [Symbol.asyncIterator]();
      assert.deepEqual((await watcher.next()).value, projection);
      const update = watcher.next();
      assert.equal(runtime.command(revisionAction).accepted, true);
      projection = runtime.query({ run_id: launch.run_id });
      assert.deepEqual(await update, { done: false, value: projection });
      assert.equal(projection.revisions.length, 1);
      assert.equal(projection.cards.find(({ id }) =>
        id === `${targetId}-repair`).status, "ready");
      const activeApply = projection.active_plan.cards.find(({ id }) =>
        id === "feature-apply-repair");
      assert.deepEqual(activeApply.inputs.managed_agent.card_ids, [
        "feature-apply-repair",
        "feature-apply-blue-repair",
      ]);
      assert.equal(activeApply.inputs.managed_agent.terminal_card_id,
        "feature-apply-blue-repair");
      assert.equal(activeApply.inputs.managed_agent.card_ids.some((id) =>
        superseded.some((originalId) => originalId === id)), false);
      await watcher.return();
    }
  }
});

test("feature/v1 gates repair expansion behind an exact checkpoint", async (t) => {
  const declinedFixture = await createFeatureFailureFixture(t, {
    repair: "scope",
  });
  await driveFeatureToSeal(declinedFixture, { allowSealRefusal: true });
  let projection = declinedFixture.runtime.query({
    run_id: declinedFixture.runId,
  });
  const revision = projection.legal_actions.find(({ type }) =>
    type === "revision_decision" && projection.revisions.length === 0);
  assert.ok(revision);
  assert.equal(declinedFixture.runtime.command(revision).accepted, true);
  projection = declinedFixture.runtime.query({ run_id: declinedFixture.runId });
  assert.deepEqual(projection.capabilities, []);
  assert.equal(projection.resource_claims.some(({ id }) => id === "repair-output"),
    false);
  const checkpoint = projection.legal_actions.find(({ type }) =>
    type === "checkpoint_decision");
  assert.ok(checkpoint);
  const declinedWatch = declinedFixture.runtime.watch({
    run_id: declinedFixture.runId,
  })[Symbol.asyncIterator]();
  assert.deepEqual((await declinedWatch.next()).value, projection);
  const stale = declinedFixture.runtime.command({
    ...checkpoint,
    expected_watermark: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(stale.code, "stale_authority_watermark");
  assert.deepEqual(declinedFixture.runtime.query({
    run_id: declinedFixture.runId,
  }).capabilities, []);
  assert.equal(declinedFixture.runtime.command({
    ...checkpoint,
    decision: "decline",
  }).accepted, true);
  projection = declinedFixture.runtime.query({ run_id: declinedFixture.runId });
  const expansionDeclined = projection.revision_outcomes.find(({ code }) =>
    code === "expansion_declined");
  assert.ok(expansionDeclined);
  assert.equal(expansionDeclined.status, "expansion_declined");
  assert.deepEqual(expansionDeclined.legal_next_actions, []);
  assert.equal(expansionDeclined.authority_watermark, projection.watermark);
  assert.equal(expansionDeclined.effect_state.status, "voided");
  assert.deepEqual(expansionDeclined.effect_state.applied.card_ids, []);
  assert.deepEqual(expansionDeclined.effect_state.applied.superseded_card_ids,
    ["feature-seal"]);
  assert.deepEqual(expansionDeclined.effect_state.voided.superseded_card_ids, []);
  assert.ok(expansionDeclined.effect_state.voided.card_ids.includes(
    "feature-seal-repair",
  ));
  assert.equal(projection.cards.find(({ id }) => id === "feature-seal-repair").status,
    "voided");
  assert.deepEqual(projection.legal_actions, []);
  const watchedDecline = await declinedWatch.next();
  assert.equal(watchedDecline.value.phase, "declined");
  assert.equal(watchedDecline.value.revision_outcomes[0].status,
    "expansion_declined");
  await declinedWatch.return();
  assert.deepEqual(projection.capabilities, []);
  assert.equal(projection.resource_claims.some(({ id }) => id === "repair-output"),
    false);
  assert.equal(projection.legal_actions.some(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-seal-repair"), false);

  const acceptedFixture = await createFeatureFailureFixture(t, {
    repair: "scope",
  });
  await driveFeatureToSeal(acceptedFixture, { allowSealRefusal: true });
  projection = acceptedFixture.runtime.query({ run_id: acceptedFixture.runId });
  const revisionToAccept = projection.legal_actions.find(({ type }) =>
    type === "revision_decision");
  assert.equal(acceptedFixture.runtime.command(revisionToAccept).accepted, true);
  projection = acceptedFixture.runtime.query({ run_id: acceptedFixture.runId });
  assert.deepEqual(projection.capabilities, []);
  assert.ok(projection.admission_capability_bindings.some(({ capability }) =>
    capability === "repository:write"));
  assert.equal(projection.resource_claims.some(({ id }) => id === "repair-output"),
    false);
  assert.ok(projection.admission_resource_claims.some(({ id }) =>
    id === "repair-output"));
  assert.deepEqual(projection.revision_reservations.limit_changes, {});
  assert.ok(projection.revision_reservations.capability_additions.some(
    ({ capability }) => capability === "repository:write",
  ));
  assert.ok(projection.revision_reservations.resource_additions.some(({ id }) =>
    id === "repair-output"));
  const gatedEffectState = projection.revisions.at(-1).effect_state;
  assert.equal(gatedEffectState.status, "gated");
  assert.deepEqual(gatedEffectState.applied.card_ids, []);
  assert.deepEqual(gatedEffectState.applied.superseded_card_ids,
    ["feature-seal"]);
  assert.ok(gatedEffectState.gated.card_ids.includes("feature-seal-repair"));
  assert.deepEqual(gatedEffectState.gated.superseded_card_ids, []);
  assert.deepEqual(gatedEffectState.voided.superseded_card_ids, []);
  const checkpointToApprove = projection.legal_actions.find(({ type, decision }) =>
    type === "checkpoint_decision" && decision === "approve");
  assert.ok(checkpointToApprove);
  assert.equal(acceptedFixture.runtime.command(checkpointToApprove).accepted, true);
  projection = acceptedFixture.runtime.query({ run_id: acceptedFixture.runId });
  assert.deepEqual(projection.capabilities, ["repository:write"]);
  assert.equal(projection.resource_claims.some(({ id }) => id === "repair-output"),
    true);
  const appliedEffectState = projection.revisions.at(-1).effect_state;
  assert.equal(appliedEffectState.status, "applied");
  assert.ok(appliedEffectState.applied.card_ids.includes("feature-seal-repair"));
  assert.deepEqual(appliedEffectState.applied.superseded_card_ids,
    ["feature-seal"]);
  assert.deepEqual(appliedEffectState.gated.card_ids, []);
  assert.deepEqual(appliedEffectState.gated.superseded_card_ids, []);
  assert.deepEqual(appliedEffectState.voided.card_ids, []);
  assert.deepEqual(appliedEffectState.voided.superseded_card_ids, []);
  assert.ok(projection.legal_actions.some(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-seal-repair"));
});

test("feature/v1 preserves chronological decline and expansion-decline outcomes", async (t) => {
  const fixture = await createFeatureFailureFixture(t, { repair: "scope" });
  await driveFeatureToSeal(fixture, { allowSealRefusal: true });

  let projection = fixture.runtime.query({ run_id: fixture.runId });
  const firstRevision = projection.legal_actions.find(({ type }) =>
    type === "revision_decision");
  assert.ok(firstRevision);
  assert.equal(fixture.runtime.command({
    ...firstRevision,
    decision: "decline",
  }).accepted, true);

  projection = fixture.runtime.query({ run_id: fixture.runId });
  const secondRevision = projection.legal_actions.find(({ type }) =>
    type === "revision_decision");
  assert.ok(secondRevision);
  assert.equal(fixture.runtime.command({
    ...secondRevision,
    decision: "accept",
  }).accepted, true);

  projection = fixture.runtime.query({ run_id: fixture.runId });
  const checkpoint = projection.legal_actions.find(({ type }) =>
    type === "checkpoint_decision");
  assert.ok(checkpoint);
  assert.equal(fixture.runtime.command({
    ...checkpoint,
    decision: "decline",
  }).accepted, true);

  projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.deepEqual(
    projection.revision_outcomes.map(({ status }) => status),
    ["declined", "expansion_declined"],
  );
  assert.deepEqual(projection.revision_outcomes.map(({ legal_next_actions }) =>
    legal_next_actions), [[], []]);
});

test("feature/v1 requires registered authority providers", () => {
  const inputs = featureInputs();
  const facts = featureFactsForInputs(inputs);
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredOperations: featurePreparationOperations(),
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
    },
  });

  assert.throws(
    () => runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "feature/v1",
      inputs,
      explicit_facts: facts,
    }),
    (error) => error.reason === "required_authority_catalog_unavailable",
  );
});

test("feature/v1 requires discriminating evidence at preparation", () => {
  const missing = featureInputs();
  delete missing.verification.baseline;
  assert.throws(
    () => prepareFeatureSelection(missing),
    /safe baseline or non-destructive compensating assertion/,
  );

  const compensating = featureInputs();
  delete compensating.verification.baseline;
  compensating.verification.compensating_assertion = {
    schema: "flow.feature-compensating-assertion/v1",
    assertion: "the changed behavior remains bounded by an independent invariant",
    non_destructive: true,
    fingerprint: `sha256:${"7".repeat(64)}`,
  };
  const prepared = prepareFeatureSelection(compensating);
  assert.equal(prepared.selection.inputs.verification.baseline, undefined);
  assert.deepEqual(
    prepared.selection.inputs.verification.compensating_assertion,
    compensating.verification.compensating_assertion,
  );
});

test("feature/v1 requires one explicit non-destructive assertion and serialized test slices", () => {
  const testMode = featureInputs();
  testMode.mode = "test";
  assert.throws(
    () => prepareFeatureSelection(testMode),
    /explicit serialized slices/,
  );

  const absentFlag = featureInputs();
  delete absentFlag.verification.baseline;
  absentFlag.verification.compensating_assertion = {
    schema: "flow.feature-compensating-assertion/v1",
    assertion: "the changed behavior remains bounded by an independent invariant",
    fingerprint: `sha256:${"7".repeat(64)}`,
  };
  assert.throws(
    () => prepareFeatureSelection(absentFlag),
    /safe baseline or non-destructive compensating assertion/,
  );

  const falseFlag = structuredClone(absentFlag);
  falseFlag.verification.compensating_assertion.non_destructive = false;
  assert.throws(
    () => prepareFeatureSelection(falseFlag),
    /safe baseline or non-destructive compensating assertion/,
  );

  const ambiguous = featureInputs();
  ambiguous.verification.compensating_assertion = {
    schema: "flow.feature-compensating-assertion/v1",
    assertion: "the changed behavior remains bounded by an independent invariant",
    non_destructive: true,
    fingerprint: `sha256:${"7".repeat(64)}`,
  };
  assert.throws(
    () => prepareFeatureSelection(ambiguous),
    /exactly one safe baseline or compensating assertion/,
  );

  const malformedBaseline = structuredClone(ambiguous);
  malformedBaseline.verification.baseline.schema =
    "flow.feature-safe-baseline/invalid";
  assert.throws(
    () => prepareFeatureSelection(malformedBaseline),
    /exactly one safe baseline or compensating assertion/,
  );

  const malformedBaselineOnly = featureInputs();
  malformedBaselineOnly.verification.baseline.schema =
    "flow.feature-safe-baseline/invalid";
  assert.throws(
    () => prepareFeatureSelection(malformedBaselineOnly),
    /safe baseline or non-destructive compensating assertion/,
  );

  const zeroEpoch = featureInputs();
  zeroEpoch.workspace.mutation_epoch = 0;
  assert.throws(
    () => prepareFeatureSelection(zeroEpoch),
    /exact generation-fenced workspace binding/,
  );

  const dirty = featureInputs();
  dirty.finalization.publication.workspace.promoted_git.clean = false;
  assert.throws(
    () => prepareFeatureSelection(dirty),
    /finalization must bind and advance the selected clean workspace/,
  );
});

test("feature/v1 test mode prepares an honest failure-proving slice", () => {
  const inputs = featureInputs();
  inputs.mode = "test";
  inputs.slices = [{
    schema: "flow.feature-slice/v1",
    id: "behavior",
    mode: "test",
    acceptance: ["the changed behavior is observable"],
    test: {
      schema: "flow.feature-test-request/v1",
      intended_failure: "the behavior is absent before implementation",
      environment_fingerprint: `sha256:${"a".repeat(64)}`,
    },
  }];

  const prepared = prepareFeatureSelection(inputs);

  assert.equal(prepared.selection.inputs.mode, "test");
  assert.deepEqual(
    prepared.selection.inputs.slices.map(({ id, mode }) => ({ id, mode })),
    [{ id: "behavior", mode: "test" }],
  );
});

test("feature/v1 serialized slices own the brief acceptance exactly once", async (t) => {
  const cases = [
    {
      name: "omitted slice acceptance",
      mutate(inputs) {
        delete inputs.slices[0].acceptance;
      },
    },
    {
      name: "uncovered brief criterion",
      mutate(inputs) {
        inputs.brief.acceptance.push("the uncovered criterion is proven");
      },
    },
    {
      name: "duplicate ownership",
      mutate(inputs) {
        inputs.slices[1].acceptance = ["the changed behavior is observable"];
      },
    },
    {
      name: "out-of-brief criterion",
      mutate(inputs) {
        inputs.slices[1].acceptance = ["an unrequested behavior is accepted"];
      },
    },
  ];
  for (const { name, mutate } of cases) {
    await t.test(name, () => {
      const inputs = featureInputs();
      inputs.mode = "mixed";
      inputs.brief.acceptance = [
        "the changed behavior is observable",
        "the configuration remains declared",
      ];
      inputs.slices = [
        {
          schema: "flow.feature-slice/v1",
          id: "behavior",
          mode: "test",
          acceptance: ["the changed behavior is observable"],
          test: {
            schema: "flow.feature-test-request/v1",
            intended_failure: "the behavior is absent before implementation",
            environment_fingerprint: `sha256:${"a".repeat(64)}`,
          },
        },
        {
          schema: "flow.feature-slice/v1",
          id: "configuration",
          mode: "verify",
          acceptance: ["the configuration remains declared"],
        },
      ];
      mutate(inputs);
      assert.throws(
        () => prepareFeatureSelection(inputs),
        /slice acceptance must explicitly own every brief criterion exactly once/,
      );
    });
  }
});

test("feature/v1 rejects unreachable serialized safe baselines during preparation", async (t) => {
  const testSlice = {
    schema: "flow.feature-slice/v1",
    id: "behavior",
    mode: "test",
    acceptance: ["the changed behavior is observable"],
    test: {
      schema: "flow.feature-test-request/v1",
      intended_failure: "the behavior is absent before implementation",
      environment_fingerprint: `sha256:${"a".repeat(64)}`,
    },
  };
  const verifySlice = (id, acceptance) => ({
    schema: "flow.feature-slice/v1",
    id,
    mode: "verify",
    acceptance: [acceptance],
  });
  const cases = [
    {
      name: "more than one verify slice",
      inputs() {
        const inputs = featureInputs();
        inputs.brief.acceptance = ["first", "second"];
        inputs.slices = [
          verifySlice("first", "first"),
          verifySlice("second", "second"),
        ];
        inputs.verification.baseline.fingerprint = inputs.workspace.fingerprint;
        return inputs;
      },
    },
    {
      name: "verify slice after a test slice",
      inputs() {
        const inputs = featureInputs();
        inputs.mode = "mixed";
        inputs.brief.acceptance = [
          "the changed behavior is observable",
          "the configuration remains declared",
        ];
        inputs.slices = [
          testSlice,
          verifySlice("configuration", "the configuration remains declared"),
        ];
        inputs.verification.baseline.fingerprint = inputs.workspace.fingerprint;
        return inputs;
      },
    },
    {
      name: "baseline does not select the current workspace",
      inputs() {
        const inputs = featureInputs();
        inputs.slices = [verifySlice(
          "configuration",
          "the changed behavior is observable",
        )];
        return inputs;
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.throws(
        () => prepareFeatureSelection(scenario.inputs()),
        (error) => error.reason === "unreachable_safe_baseline_slice",
      );
    });
  }
});

test("workspace effect authority rejects an epoch-only stale claim", () => {
  const git = exactGitFacts();
  const projection = {
    schema: "work.workspace-projection/v1",
    subject_id: "workspace:producer",
    generation: 1,
    mutation_epoch: 8,
    git,
    claims: [{
      holder: "run:feature",
      operations: ["feature-apply"],
    }],
    taint: null,
  };
  const claim = {
    id: projection.subject_id,
    generation: projection.generation,
    mutation_epoch: 7,
    fingerprint: digestValue({ git }),
  };
  const intent = {
    run_id: "run:feature",
    card_id: "feature-apply",
  };

  assert.equal(
    workspaceEffectAuthorityIssue(projection, claim, intent),
    "workspace_claim_stale",
  );
});

test("feature/v1 test-only selection needs no verify baseline", () => {
  const inputs = featureInputs();
  inputs.mode = "test";
  delete inputs.verification.baseline;
  inputs.slices = [{
    schema: "flow.feature-slice/v1",
    id: "behavior",
    mode: "test",
    acceptance: ["the changed behavior is observable"],
    test: {
      schema: "flow.feature-test-request/v1",
      intended_failure: "the behavior is absent before implementation",
      environment_fingerprint: `sha256:${"a".repeat(64)}`,
    },
  }];

  const prepared = prepareFeatureSelection(inputs);

  assert.equal(prepared.selection.inputs.mode, "test");
  const testCard = prepared.graph.cards.find(({ id }) =>
    id === "feature-slice-behavior-test");
  assert.equal(testCard.inputs.verification, undefined);
  assert.equal(testCard.inputs.test_selection.schema,
    "flow.feature-test-selection/v1");
});

test("feature/v1 serializes mixed slices and keeps setup out of evidence", () => {
  const inputs = featureInputs();
  inputs.mode = "mixed";
  inputs.brief.acceptance = [
    "the changed behavior is observable",
    "the configuration remains declared",
  ];
  inputs.setup = {
    schema: "flow.feature-setup/v1",
    id: "setup:fixture",
    description: "install the fixture dependency once",
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  inputs.slices = [
    {
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    },
    {
      schema: "flow.feature-slice/v1",
      id: "configuration",
      mode: "verify",
      acceptance: ["the configuration remains declared"],
    },
  ];
  delete inputs.verification.baseline;
  inputs.verification.compensating_assertion = {
    schema: "flow.feature-compensating-assertion/v1",
    assertion: "the changed behavior remains bounded by an independent invariant",
    non_destructive: true,
    fingerprint: `sha256:${"7".repeat(64)}`,
  };

  const prepared = prepareFeatureSelection(inputs);
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  assert.deepEqual(cards.get("feature-setup").dependencies, []);
  assert.deepEqual(cards.get("feature-slice-behavior-test").dependencies, [
    "feature-setup",
  ]);
  assert.deepEqual(cards.get("feature-apply").dependencies, [
    "feature-slice-behavior-test",
  ]);
  assert.deepEqual(cards.get("feature-slice-behavior-verify").dependencies, [
    "feature-capture-behavior",
  ]);
  assert.deepEqual(
    cards.get("feature-slice-behavior-verify").inputs.operation_evidence_card_ids,
    ["feature-slice-behavior-test", "feature-capture-behavior"],
  );
  assert.deepEqual(cards.get("feature-apply-configuration").dependencies, [
    "feature-apply",
    "feature-slice-behavior-verify",
  ]);
  assert.deepEqual(cards.get("feature-slice-configuration-verify").dependencies, [
    "feature-capture-configuration",
  ]);
  assert.deepEqual(
    cards.get("feature-slice-configuration-verify").inputs.operation_evidence_card_ids,
    ["feature-capture-configuration"],
  );
  assert.deepEqual(cards.get("feature-verify").dependencies, [
    "feature-capture",
  ]);
  assert.deepEqual(cards.get("feature-verify").inputs.operation_evidence_card_ids, [
    "feature-slice-behavior-test",
    "feature-slice-behavior-verify",
    "feature-slice-configuration-verify",
    "feature-capture",
  ]);
  assert.equal(
    cards.get("feature-verify").inputs.operation_evidence_card_ids.includes(
      "feature-setup",
    ),
    false,
  );
  assert.equal(cards.get("feature-setup").inputs.evidence_role, "setup_only");
});

test("feature/v1 setup requires explicit slices and serializes verify setup", () => {
  const withoutSlices = featureInputs();
  withoutSlices.setup = {
    schema: "flow.feature-setup/v1",
    id: "setup:fixture",
    description: "install the fixture dependency once",
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  assert.throws(
    () => prepareFeatureSelection(withoutSlices),
    /setup requires explicit slices/,
  );

  const withVerifySlice = featureInputs();
  withVerifySlice.setup = structuredClone(withoutSlices.setup);
  withVerifySlice.slices = [{
    schema: "flow.feature-slice/v1",
    id: "behavior",
    mode: "verify",
    acceptance: ["the changed behavior is observable"],
  }];
  withVerifySlice.verification.baseline.fingerprint =
    withVerifySlice.workspace.fingerprint;
  const prepared = prepareFeatureSelection(withVerifySlice);
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  assert.deepEqual(cards.get("feature-setup").dependencies, []);
  assert.deepEqual(cards.get("feature-apply").dependencies, [
    "feature-setup",
  ]);
  assert.deepEqual(cards.get("feature-slice-behavior-verify").dependencies, [
    "feature-capture-behavior",
  ]);
  assert.deepEqual(cards.get("feature-verify").dependencies, [
    "feature-capture",
  ]);
});

test("feature/v1 test mode rejects broken or unrelated failures", () => {
  const broken = featureInputs();
  broken.mode = "test";
  broken.slices = [{
    schema: "flow.feature-slice/v1",
    id: "behavior",
    mode: "test",
    acceptance: ["the changed behavior is observable"],
    test: {
      schema: "flow.feature-test-request/v1",
      intended_failure: "the behavior is absent before implementation",
      environment_fingerprint: `sha256:${"a".repeat(64)}`,
      environment_status: "broken",
    },
  }];
  assert.throws(
    () => prepareFeatureSelection(broken),
    /healthy environment fingerprint/,
  );

  const unrelated = structuredClone(broken);
  unrelated.slices[0].test.environment_status = "healthy";
  delete unrelated.slices[0].test.intended_failure;
  assert.throws(
    () => prepareFeatureSelection(unrelated),
    /intended failure and healthy environment fingerprint/,
  );
});

test("feature/v1 verify rejects an unchanged promoted workspace", () => {
  const inputs = featureInputs();
  inputs.finalization.publication.workspace.promoted_git =
    inputs.finalization.publication.workspace.expected_git;
  assert.throws(
    () => prepareFeatureSelection(inputs),
    /finalization must bind and advance the selected clean workspace/,
  );
});

test("feature/v1 test mode proves failure before apply and seals a candidate", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "test",
    setup: {
      schema: "flow.feature-setup/v1",
      id: "setup:feature-test",
      description: "prepare the test fixture once",
      fingerprint: `sha256:${"b".repeat(64)}`,
    },
    slices: [{
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    }],
  });

  const order = await driveSerializedFeatureToSeal(fixture);
  assert.deepEqual(order, [
    "feature-setup",
    "feature-slice-behavior-test",
    "feature-apply",
    "feature-capture-behavior",
    "feature-slice-behavior-verify",
    "feature-capture",
    "feature-verify",
    "feature-critique",
    "feature-seal",
  ]);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  const candidateId = completed.review_candidate_reference.candidate_id;
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: candidateId,
  }).status, "sealed");
  for (const action of completed.legal_actions) {
    assert.equal(action.expected_watermark, completed.watermark);
  }
  const verifyEffect = completed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-verify");
  assert.ok(verifyEffect);
  assert.deepEqual(
    verifyEffect.receipt.provider_receipt.acceptance_criteria.map(({ criterion }) =>
      criterion),
    ["the changed behavior is observable"],
  );
});

test("feature/v1 test-only mode seals from current intended-failure evidence", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "test",
    testOnlyWithoutVerification: true,
    slices: [{
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    }],
  });

  const order = await driveSerializedFeatureToSeal(fixture, {
    allowSealRefusal: true,
  });
  assert.deepEqual(order, [
    "feature-slice-behavior-test",
    "feature-apply",
    "feature-capture-behavior",
    "feature-slice-behavior-verify",
    "feature-capture",
    "feature-verify",
    "feature-critique",
    "feature-seal",
  ]);
  const projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(projection.phase, "succeeded", JSON.stringify({
    phase: projection.phase,
    effects: projection.effects,
    legal_actions: projection.legal_actions,
  }));
});

test("feature/v1 test receipts reject unrelated and broken-environment failures", async (t) => {
  const cases = ["unrelated", "broken_environment", "stale_epoch"];
  for (const testReceiptMode of cases) {
    await t.test(testReceiptMode, async (caseTest) => {
      const fixture = await createFeatureFailureFixture(caseTest, {
        mode: "test",
        testOnlyWithoutVerification: true,
        testReceiptMode,
        slices: [{
          schema: "flow.feature-slice/v1",
          id: "behavior",
          mode: "test",
          acceptance: ["the changed behavior is observable"],
          test: {
            schema: "flow.feature-test-request/v1",
            intended_failure: "the behavior is absent before implementation",
            environment_fingerprint: `sha256:${"a".repeat(64)}`,
          },
        }],
      });

      const projection = await driveUntilTestReceiptBlocked(fixture);
      assert.equal(projection.phase, "active");
      assert.equal(projection.effects.find(({ card_id: cardId }) =>
        cardId.endsWith("-test")).status, "unresolved");
      assert.equal(fixture.reviewAuthority.query({
        contract: "work.review/v1",
        subject_id: "candidate:feature",
      }).status, undefined);
    });
  }
});

test("feature/v1 rejects invalid test receipts before writer admission and recovers", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "test",
    testOnlyWithoutVerification: true,
    testReceiptMode: "unrelated",
    slices: [{
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    }],
  });

  const initial = fixture.runtime.query({ run_id: fixture.runId });
  const testAction = initial.legal_actions.find(({ card_id: cardId }) =>
    cardId === "feature-slice-behavior-test");
  assert.ok(testAction);
  const commandReceipt = fixture.runtime.command(testAction);
  assert.equal(commandReceipt.accepted, true, JSON.stringify(commandReceipt));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const blocked = fixture.runtime.query({ run_id: fixture.runId });
  const testEffect = blocked.effects.find(({ card_id: cardId }) =>
    cardId === "feature-slice-behavior-test");
  assert.equal(testEffect.status, "unresolved");
  assert.equal(blocked.effects.some(({ card_id: cardId }) =>
    cardId === "feature-apply"), false);
  const recovery = blocked.legal_actions.find(({ type, effect_id: effectId }) =>
    type === "recovery" && effectId === testEffect.effect_id);
  assert.ok(recovery);
  assert.equal(recovery.expected_watermark, blocked.watermark);

  fixture.setTestReceiptMode("valid");
  const recovered = fixture.runtime.command(recovery);
  assert.equal(recovered.accepted, true, JSON.stringify(recovered));
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.find(
    ({ card_id: cardId }) => cardId === "feature-slice-behavior-test",
  )?.status === "succeeded");
  const afterRecovery = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(fixture.testInvocations(), 2);
  assert.equal(afterRecovery.effects.filter(({ card_id: cardId }) =>
    cardId === "feature-slice-behavior-test").length, 1);
  assert.ok(afterRecovery.legal_actions.some(({ card_id: cardId }) =>
    cardId === "feature-apply"));
});

test("feature/v1 mixed mode rejects invalid test-slice receipts despite a valid baseline", async (t) => {
  const cases = ["unrelated", "broken_environment", "stale_epoch", "missing"];
  for (const testReceiptMode of cases) {
    await t.test(testReceiptMode, async (caseTest) => {
      const fixture = await createFeatureFailureFixture(caseTest, {
        mode: "mixed",
        briefAcceptance: [
          "the changed behavior is observable",
          "the configuration remains declared",
        ],
        compensatingAssertion: true,
        testReceiptMode,
        slices: [
          {
            schema: "flow.feature-slice/v1",
            id: "behavior",
            mode: "test",
            acceptance: ["the changed behavior is observable"],
            test: {
              schema: "flow.feature-test-request/v1",
              intended_failure: "the behavior is absent before implementation",
              environment_fingerprint: `sha256:${"a".repeat(64)}`,
            },
          },
          {
            schema: "flow.feature-slice/v1",
            id: "configuration",
            mode: "verify",
            acceptance: ["the configuration remains declared"],
          },
        ],
      });

      const projection = await driveUntilTestReceiptBlocked(fixture);
      assert.equal(projection.phase, "active");
      assert.equal(projection.effects.find(({ card_id: cardId }) =>
        cardId.endsWith("-test")).status, "unresolved");
      assert.equal(fixture.reviewAuthority.query({
        contract: "work.review/v1",
        subject_id: "candidate:feature",
      }).status, undefined);
    });
  }
});

test("feature/v1 mixed mode requires every slice verification receipt", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "mixed",
    briefAcceptance: [
      "the changed behavior is observable",
      "the configuration remains declared",
    ],
    compensatingAssertion: true,
    sliceVerifyReceiptMode: "missing",
    slices: [
      {
        schema: "flow.feature-slice/v1",
        id: "behavior",
        mode: "test",
        acceptance: ["the changed behavior is observable"],
        test: {
          schema: "flow.feature-test-request/v1",
          intended_failure: "the behavior is absent before implementation",
          environment_fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        schema: "flow.feature-slice/v1",
        id: "configuration",
        mode: "verify",
        acceptance: ["the configuration remains declared"],
      },
    ],
  });

  await driveSerializedFeatureToSeal(fixture, { allowSealRefusal: true });
  const projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(projection.phase, "active");
  assert.equal(projection.effects.some(({ card_id: cardId }) =>
    cardId === "feature-verify" || cardId === "feature-seal"), false);
  assert.equal(projection.result_bindings.some(({ producer_card_id: cardId }) =>
    cardId === "feature-slice-behavior-verify"), false);
});

test("feature/v1 identity-free mixed mode carries the canonical workspace binding through seal", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    mode: "mixed",
    compensatingAssertion: true,
    slices: [
      {
        schema: "flow.feature-slice/v1",
        id: "behavior",
        mode: "test",
        acceptance: ["the changed behavior is observable"],
        test: {
          schema: "flow.feature-test-request/v1",
          intended_failure: "the behavior is absent before implementation",
          environment_fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        schema: "flow.feature-slice/v1",
        id: "configuration",
        mode: "verify",
        acceptance: ["the configuration remains declared"],
      },
    ],
    briefAcceptance: [
      "the changed behavior is observable",
      "the configuration remains declared",
    ],
  });

  const order = await driveSerializedFeatureToSeal(fixture);
  assert.deepEqual(order, [
    "feature-slice-behavior-test",
    "feature-apply",
    "feature-capture-behavior",
    "feature-slice-behavior-verify",
    "feature-apply-configuration",
    "feature-capture-configuration",
    "feature-slice-configuration-verify",
    "feature-capture",
    "feature-verify",
    "feature-critique",
    "feature-seal",
  ]);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded", JSON.stringify({
    phase: completed.phase,
    effects: completed.effects.map(({ card_id: cardId, status, receipt }) => ({
      card_id: cardId,
      status,
      code: receipt?.provider_receipt?.code,
      reason: receipt?.provider_receipt?.reason,
    })),
    sealIntent: fixture.sealIntents.at(-1) === undefined ? null : {
      operation_input_keys: Object.keys(fixture.sealIntents.at(-1).operation_input),
      finalization_schema: fixture.sealIntents.at(-1).operation_input.finalization?.schema,
      publication_retention: fixture.sealIntents.at(-1).operation_input.finalization?.publication?.retention,
      candidate_id: fixture.sealIntents.at(-1).operation_input.authority_materialized_candidate?.candidate_id,
      candidate_digest: fixture.sealIntents.at(-1).operation_input.authority_materialized_candidate_digest,
    },
    legal_actions: completed.legal_actions,
  }));
  assert.match(completed.review_candidate_reference.candidate_id, /^candidate:/);
});

test("feature/v1 slice verification rejects stale, foreign, or incomplete receipts", async (t) => {
  const cases = [
    "stale_epoch",
    "wrong_operation",
    "missing_verdict",
    "wrong_acceptance",
    "setup_only",
  ];
  for (const sliceVerifyReceiptMode of cases) {
    await t.test(sliceVerifyReceiptMode, async (caseTest) => {
      const fixture = await createFeatureFailureFixture(caseTest, {
        mode: "mixed",
        briefAcceptance: [
          "the changed behavior is observable",
          "the configuration remains declared",
        ],
        compensatingAssertion: true,
        sliceVerifyReceiptMode,
        slices: [
          {
            schema: "flow.feature-slice/v1",
            id: "behavior",
            mode: "test",
            acceptance: ["the changed behavior is observable"],
            test: {
              schema: "flow.feature-test-request/v1",
              intended_failure: "the behavior is absent before implementation",
              environment_fingerprint: `sha256:${"a".repeat(64)}`,
            },
          },
          {
            schema: "flow.feature-slice/v1",
            id: "configuration",
            mode: "verify",
            acceptance: ["the configuration remains declared"],
          },
        ],
      });

      await driveSerializedFeatureToSeal(fixture, { allowSealRefusal: true });
      const projection = fixture.runtime.query({ run_id: fixture.runId });
      assert.equal(projection.phase, "active");
      assert.equal(projection.effects.some(({ card_id: cardId }) =>
        cardId === "feature-verify" || cardId === "feature-seal"), false);
    });
  }
});

test("feature/v1 slice verification rejects malformed discriminators", async (t) => {
  const cases = [
    "missing_discriminator",
    "malformed_discriminator",
    "undistinguished_discriminator",
    "stale_discriminator",
  ];
  for (const sliceDiscriminatorMode of cases) {
    await t.test(sliceDiscriminatorMode, async (caseTest) => {
      const fixture = await createFeatureFailureFixture(caseTest, {
        mode: "mixed",
        briefAcceptance: [
          "the changed behavior is observable",
          "the configuration remains declared",
        ],
        compensatingAssertion: true,
        sliceDiscriminatorMode,
        slices: [
          {
            schema: "flow.feature-slice/v1",
            id: "behavior",
            mode: "test",
            acceptance: ["the changed behavior is observable"],
            test: {
              schema: "flow.feature-test-request/v1",
              intended_failure: "the behavior is absent before implementation",
              environment_fingerprint: `sha256:${"a".repeat(64)}`,
            },
          },
          {
            schema: "flow.feature-slice/v1",
            id: "configuration",
            mode: "verify",
            acceptance: ["the configuration remains declared"],
          },
        ],
      });

      await driveSerializedFeatureToSeal(fixture, { allowSealRefusal: true });
      const projection = fixture.runtime.query({ run_id: fixture.runId });
      assert.equal(projection.phase, "active");
      assert.equal(projection.effects.some(({ card_id: cardId }) =>
        cardId === "feature-verify" || cardId === "feature-seal"), false);
    });
  }
});

test("feature/v1 setup evidence cannot substitute for test slice evidence", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "test",
    testOnlyWithoutVerification: true,
    testReceiptMode: "setup_only",
    setup: {
      schema: "flow.feature-setup/v1",
      id: "setup:feature-test",
      description: "prepare the test fixture once",
      fingerprint: `sha256:${"b".repeat(64)}`,
    },
    slices: [{
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    }],
  });

  const projection = await driveUntilTestReceiptBlocked(fixture);
  assert.equal(projection.phase, "active");
  assert.equal(projection.effects.find(({ card_id: cardId }) =>
    cardId.endsWith("-test")).status, "unresolved");
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: "candidate:feature",
  }).status, undefined);
});

test("feature/v1 attributes mutation to the authority-owned apply card", async (t) => {
  const accepted = await createFeatureFailureFixture(t, {
    forgedDelegateSelfReport: true,
  });
  executeCard(accepted.runtime, accepted.runId, "delegate_execute", "feature-apply");
  await until(() => accepted.runtime.query({ run_id: accepted.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));

  const acceptedProjection = accepted.runtime.query({ run_id: accepted.runId });
  const acceptedEffect = acceptedProjection.effects.find(({ card_id: cardId }) =>
    cardId === "feature-apply");
  const acceptedAttempt = acceptedProjection.delegate_attempts.find(({ card_id: cardId }) =>
    cardId === "feature-apply");
  const acceptedWorkspace = accepted.workspaceAuthority.query(workspaceQuery());
  assert.equal(acceptedEffect.card_id, "feature-apply");
  assert.equal(acceptedEffect.operation_contract, "flow.delegated-agent-port/v1");
  assert.equal(acceptedAttempt.card_id, acceptedEffect.card_id);
  assert.equal(acceptedAttempt.effect_id, acceptedEffect.effect_id);
  assert.equal(acceptedAttempt.validated_output, "apply verification passed accepted");
  assert.equal(acceptedWorkspace.claims.length, 1);
  assert.equal(acceptedWorkspace.claims[0].holder, accepted.runId);
  assert.ok(acceptedWorkspace.claims[0].operations.includes(acceptedEffect.card_id));

  const rejected = await createFeatureFailureFixture(t, {
    forgedDelegateSelfReport: true,
    workspaceClaimHolder: "run:competing-writer",
  });
  executeCard(rejected.runtime, rejected.runId, "delegate_execute", "feature-apply");
  await settleFeatureEffect(rejected.runtime, rejected.runId, "feature-apply");
  const rejectedProjection = rejected.runtime.query({ run_id: rejected.runId });
  const rejectedEffect = rejectedProjection.effects.find(({ card_id: cardId }) =>
    cardId === "feature-apply");
  const rejectedWorkspace = rejected.workspaceAuthority.query(workspaceQuery());
  assert.equal(rejectedEffect.card_id, "feature-apply");
  assert.equal(rejectedWorkspace.claims[0].holder, "run:competing-writer");
  assert.equal(rejectedEffect.status, "unresolved");
  assert.equal(rejected.delegateDispatches(), 0);
});

test("feature/v1 rejects aggregate verification from a stale mutation epoch", async (t) => {
  const staleGit = promotedGitFacts();
  const fixture = await createFeatureFailureFixture(t, {
    mode: "test",
    testOnlyWithoutVerification: true,
    verification: {
      workspace: {
        subject_id: "workspace:producer",
        generation: 1,
        mutation_epoch: 6,
        fingerprint: digestValue({ git: staleGit }),
        git: staleGit,
      },
    },
    slices: [{
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    }],
  });

  await driveSerializedFeatureToSeal(fixture, { allowSealRefusal: true });
  const projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(projection.phase, "active");
  assert.equal(projection.effects.find(({ card_id: cardId }) =>
    cardId === "feature-verify").status, "unresolved");
  assert.equal(projection.effects.some(({ card_id: cardId }) =>
    cardId === "feature-seal"), false);
});

test("feature/v1 test operation recovery reuses the current intent once", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "test",
    testOnlyWithoutVerification: true,
    testReceiptMode: "throw",
    slices: [{
      schema: "flow.feature-slice/v1",
      id: "behavior",
      mode: "test",
      acceptance: ["the changed behavior is observable"],
      test: {
        schema: "flow.feature-test-request/v1",
        intended_failure: "the behavior is absent before implementation",
        environment_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    }],
  });
  const initial = fixture.runtime.query({ run_id: fixture.runId });
  const action = initial.legal_actions.find(({ type }) =>
    type === "operation_execute");
  assert.equal(action.card_id, "feature-slice-behavior-test");
  const firstReceipt = fixture.runtime.command(action);
  assert.equal(firstReceipt.accepted, true);
  const [initialIntent] = firstReceipt.effect_intents;
  await until(() => {
    const current = fixture.runtime.query({ run_id: fixture.runId });
    return current.effects.find(({ card_id: cardId }) =>
      cardId === action.card_id)?.status === "unresolved";
  });
  const failed = fixture.runtime.query({ run_id: fixture.runId });
  const recovery = failed.legal_actions.find(({ type, effect_id: effectId }) =>
    type === "recovery" && effectId === failed.effects[0].effect_id);
  assert.ok(recovery);
  assert.equal(recovery.expected_watermark, failed.watermark);
  const retried = fixture.runtime.command(recovery);
  assert.equal(retried.accepted, true, JSON.stringify(retried));
  assert.deepEqual(retried.effect_intents, [initialIntent]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterRecovery = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(afterRecovery.effects.find(({ card_id: cardId }) =>
    cardId === action.card_id).status, "succeeded", JSON.stringify({
      invocations: fixture.testInvocations(),
      effects: afterRecovery.effects,
      legal_actions: afterRecovery.legal_actions,
    }));
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(fixture.testInvocations(), 2);
  assert.equal(completed.effects.filter(({ card_id: cardId }) =>
    cardId === action.card_id).length, 1);
  for (const legalAction of completed.legal_actions) {
    assert.equal(legalAction.expected_watermark, completed.watermark);
  }
});

test("feature/v1 mixed slices serialize each writer and retain operation ownership", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "mixed",
    briefAcceptance: [
      "the changed behavior is observable",
      "the configuration remains declared",
    ],
    compensatingAssertion: true,
    slices: [
      {
        schema: "flow.feature-slice/v1",
        id: "behavior",
        mode: "test",
        acceptance: ["the changed behavior is observable"],
        test: {
          schema: "flow.feature-test-request/v1",
          intended_failure: "the behavior is absent before implementation",
          environment_fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        schema: "flow.feature-slice/v1",
        id: "configuration",
        mode: "verify",
        acceptance: ["the configuration remains declared"],
      },
    ],
  });

  const order = await driveSerializedFeatureToSeal(fixture);
  assert.deepEqual(order, [
    "feature-slice-behavior-test",
    "feature-apply",
    "feature-capture-behavior",
    "feature-slice-behavior-verify",
    "feature-apply-configuration",
    "feature-capture-configuration",
    "feature-slice-configuration-verify",
    "feature-capture",
    "feature-verify",
    "feature-critique",
    "feature-seal",
  ]);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  const seal = fixture.sealIntents.at(-1);
  assert.deepEqual(
    seal.operation_input.authority_materialized_evidence.accepted_delegates.map(
      ({ card_id: cardId }) => cardId,
    ),
    ["feature-apply", "feature-apply-configuration", "feature-critique"],
  );
  assert.deepEqual(
    seal.operation_input.authority_materialized_evidence.operation_receipts
      .map(({ card_id: cardId }) => cardId),
    [
      "feature-capture",
      "feature-slice-behavior-test",
      "feature-slice-behavior-verify",
      "feature-slice-configuration-verify",
      "feature-verify",
    ],
  );
  const materialized = seal.operation_input.authority_materialized_evidence;
  const sourceEffects = new Map(completed.effects.map((effect) => [
    effect.card_id,
    effect,
  ]));
  for (const entry of materialized.operation_receipts) {
    const source = sourceEffects.get(entry.card_id);
    assert.ok(source);
    assert.equal(entry.effect_id, source.effect_id);
    assert.equal(entry.attempt_id, source.attempt_id);
    assert.equal(entry.idempotency_key, source.idempotency_key);
    assert.match(entry.source_authority_watermark, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(entry.receipt, source.receipt);
  }
  const configurationVerify = materialized.operation_receipts.find(({ card_id: cardId }) =>
    cardId === "feature-slice-configuration-verify");
  assert.deepEqual(
    configurationVerify.receipt.provider_receipt.acceptance_criteria.map(
      ({ criterion }) => criterion,
    ),
    ["the configuration remains declared"],
  );
});

test("feature/v1 mixed evidence has deterministic materialization order", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    lifecycleKernel(fold, command) {
      if (command.type === "operation_execute" &&
          command.card_id === "feature-seal") {
        const activePlan = structuredClone(fold.active_plan);
        activePlan.result_bindings.reverse();
        return decideLifecycle({ ...fold, active_plan: activePlan }, command);
      }
      return decideLifecycle(fold, command);
    },
  });

  await driveFeatureToSeal(fixture);

  const seal = fixture.sealIntents.at(-1);
  assert.deepEqual(
    seal.operation_input.authority_materialized_evidence.accepted_delegates
      .map(({ card_id: cardId }) => cardId),
    ["feature-apply", "feature-critique"],
  );
  assert.deepEqual(
    seal.operation_input.authority_materialized_evidence.operation_receipts
      .map(({ card_id: cardId }) => cardId),
    ["feature-capture", "feature-verify"],
  );
});

test("feature/v1 replacement critique binds and seals the captured candidate", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    critiqueCardId: "feature-critique-replacement",
  });

  await driveFeatureToSeal(fixture, {
    critiqueCardId: "feature-critique-replacement",
  });

  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  const seal = fixture.sealIntents.at(-1);
  const materialized = seal.operation_input.authority_materialized_evidence;
  const critiqueEntry = materialized.accepted_delegates.find(({ card_id: cardId }) =>
    cardId === "feature-critique-replacement");
  assert.ok(critiqueEntry);
  const review = fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: completed.review_candidate_reference.candidate_id,
  });
  assert.equal(review.candidate.critique.delegate_evidence.card_id,
    "feature-critique-replacement");
  const authorityCritiqueBinding =
    seal.operation_input.authority_materialized_critique_binding;
  const critiqueResultBinding =
    seal.operation_input.authority_materialized_result_bindings.find(
      ({ producer_card_id: cardId }) => cardId === "feature-critique-replacement",
    );
  assert.equal(authorityCritiqueBinding.card_id,
    "feature-critique-replacement");
  assert.equal(authorityCritiqueBinding.role, "critique");
  assert.equal(authorityCritiqueBinding.result_identity,
    critiqueResultBinding.result_identity);
  assert.equal(authorityCritiqueBinding.binding_digest,
    critiqueResultBinding.binding_digest);
  assert.equal(completed.review_candidate_reference.candidate_id,
    seal.operation_input.authority_materialized_candidate.candidate_id);
});

test("feature/v1 seal rejects provider critique that selects apply evidence", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    forgeCritiqueAsApply: true,
  });
  await driveFeatureToSeal(fixture);
  const projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.notEqual(projection.phase, "succeeded");
  assert.deepEqual(projection.handoffs, []);
  assert.equal(
    fixture.reviewAuthority.query({
      contract: "work.review/v1",
      subject_id: "candidate:feature",
    }).status,
    undefined,
  );
});

test("feature/v1 serialized slices advance honest workspace snapshots", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    mode: "mixed",
    briefAcceptance: [
      "the changed behavior is observable",
      "the configuration remains declared",
    ],
    baselineFingerprint: digestValue({ git: exactGitFacts() }),
    sliceSnapshots: [intermediateGitFacts(), promotedGitFacts()],
    slices: [
      {
        schema: "flow.feature-slice/v1",
        id: "configuration",
        mode: "verify",
        acceptance: ["the configuration remains declared"],
      },
      {
        schema: "flow.feature-slice/v1",
        id: "behavior",
        mode: "test",
        acceptance: ["the changed behavior is observable"],
        test: {
          schema: "flow.feature-test-request/v1",
          intended_failure: "the behavior is absent before implementation",
          environment_fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
    ],
  });

  await driveSerializedFeatureToSeal(fixture);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  const seal = fixture.sealIntents.at(-1);
  const receipts = seal.operation_input.authority_materialized_evidence
    .operation_receipts;
  const firstVerify = receipts.find(({ card_id: cardId }) =>
    cardId === "feature-slice-configuration-verify");
  const secondTest = receipts.find(({ card_id: cardId }) =>
    cardId === "feature-slice-behavior-test");
  const secondVerify = receipts.find(({ card_id: cardId }) =>
    cardId === "feature-slice-behavior-verify");
  const firstPost = firstVerify.receipt.provider_receipt.workspace;
  const secondPre = secondTest.receipt.provider_receipt.workspace;
  const secondPost = secondVerify.receipt.provider_receipt.workspace;
  assert.deepEqual(secondPre, {
    subject_id: firstPost.subject_id,
    generation: firstPost.generation,
    mutation_epoch: firstPost.mutation_epoch,
    fingerprint: firstPost.fingerprint,
  });
  assert.notEqual(firstPost.fingerprint,
    digestValue({ git: promotedGitFacts() }));
  assert.deepEqual(secondPost.git, promotedGitFacts());
  assert.equal(secondPost.fingerprint, digestValue({
    git: promotedGitFacts(),
  }));
  assert.equal(completed.phase, "succeeded");
});

test("feature/v1 serialized slices reject stale, skipped, and reordered snapshots", async (t) => {
  for (const snapshotMode of ["stale", "skip", "reordered"]) {
    await t.test(snapshotMode, async (caseTest) => {
      const fixture = await createFeatureFailureFixture(caseTest, {
        mode: "mixed",
        briefAcceptance: [
          "the changed behavior is observable",
          "the configuration remains declared",
        ],
        baselineFingerprint: digestValue({ git: exactGitFacts() }),
        snapshotMode,
        sliceSnapshots: [intermediateGitFacts(), promotedGitFacts()],
        slices: [
          {
            schema: "flow.feature-slice/v1",
            id: "configuration",
            mode: "verify",
            acceptance: ["the configuration remains declared"],
          },
          {
            schema: "flow.feature-slice/v1",
            id: "behavior",
            mode: "test",
            acceptance: ["the changed behavior is observable"],
            test: {
              schema: "flow.feature-test-request/v1",
              intended_failure: "the behavior is absent before implementation",
              environment_fingerprint: `sha256:${"a".repeat(64)}`,
            },
          },
        ],
      });

      if (snapshotMode === "stale") {
        const blocked = await driveUntilTestReceiptBlocked(fixture);
        assert.equal(blocked.phase, "active");
        assert.equal(blocked.effects.find(({ card_id: cardId }) =>
          cardId === "feature-slice-behavior-test").status, "unresolved");
        return;
      }
      await driveSerializedFeatureToSeal(fixture, { allowSealRefusal: true });
      const projection = fixture.runtime.query({ run_id: fixture.runId });
      assert.equal(projection.phase, "active");
      assert.equal(projection.effects.find(({ card_id: cardId }) =>
        cardId === "feature-seal").status, "unresolved");
      assert.equal(fixture.reviewAuthority.query({
        contract: "work.review/v1",
        subject_id: "candidate:feature",
      }).status, undefined);
    });
  }
});

test("feature/v1 fences apply behind the exact workspace writer", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    workspaceClaimHolder: "run:competing-writer",
  });
  executeCard(fixture.runtime, fixture.runId, "delegate_execute", "feature-apply");
  await settleFeatureEffect(fixture.runtime, fixture.runId, "feature-apply");

  const projection = fixture.runtime.query({ run_id: fixture.runId });
  const effect = projection.effects.find(({ card_id: cardId }) =>
    cardId === "feature-apply");
  assert.equal(effect.status, "unresolved");
  assert.equal(fixture.delegateDispatches(), 0);
  const recovery = projection.legal_actions.find(({ type, effect_id: effectId }) =>
    type === "recovery" && effectId === effect.effect_id);
  assert.ok(recovery);
  assert.equal(recovery.expected_watermark, projection.watermark);
});

test("feature/v1 seals with an explicit non-destructive compensating assertion", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    compensatingAssertion: true,
  });
  await driveFeatureToSeal(fixture);
  assert.equal(fixture.runtime.query({ run_id: fixture.runId }).phase, "succeeded");
});

test("feature/v1 cancellation stops admission without sealing a candidate", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {});
  const before = fixture.runtime.query({ run_id: fixture.runId });
  const cancel = before.legal_actions.find(({ type }) => type === "cancel");
  assert.ok(cancel);
  assert.equal(cancel.expected_watermark, before.watermark);
  assert.equal(fixture.runtime.command(cancel).accepted, true);
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).phase ===
    "cancelled");

  const cancelled = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(fixture.delegateDispatches(), 0);
  assert.deepEqual(cancelled.handoffs, []);
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: "candidate:feature",
  }).code, "unknown_subject");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("feature/v1 rechecks current route, resource, and generation providers on absent launch", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {});
  const cases = [
    {
      id: "route:facts",
      observation: {
        status: "stale",
        watermark: digestValue("feature-route-drift"),
      },
    },
    {
      id: "resource:facts",
      observation: {
        status: "stale",
        watermark: digestValue("feature-resource-drift"),
      },
    },
    {
      id: "generation:facts",
      observation: {
        status: "stale",
        generation: 9,
      },
    },
  ];

  for (const [index, { id, observation }] of cases.entries()) {
    const inputs = structuredClone(fixture.inputs);
    inputs.brief.summary = `drifted feature ${index}`;
    const prepared = fixture.runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "feature/v1",
      inputs,
      explicit_facts: fixture.facts,
    });
    const original = fixture.authorityState[id];
    fixture.authorityState[id] = observation;
    const rejection = fixture.runtime.launch(
      confirmedPredefinedLaunchRequest(prepared),
    );
    fixture.authorityState[id] = original;

    assert.equal(rejection.code, "required_authority_stale", id);
    assert.equal(rejection.authority_fact.authority_id, id);
    assert.deepEqual(fixture.runtime.query().runs, [fixture.runId]);
  }
});

test("feature/v1 reboot admission rechecks the current shipped resource provider", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {});
  fixture.runAuthority.close();
  fixture.authorityState["resource:facts"] = {
    status: "stale",
    watermark: digestValue("feature-reboot-resource-drift"),
  };

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory: fixture.authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
    }),
    hostIdentityAdapter: fixedHostIdentity(
      "boot-feature-reboot",
      "feature-process-reboot",
    ),
    rebootObservationAdapter: {
      observe({ prepared }) {
        const observation = preparedObservation(prepared);
        return {
          ...observation,
          time_facts: observation.time_facts.map((fact) =>
            fact.kind === "boot" ? { ...fact, boot_id: "boot-feature-reboot" } : fact),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebootedRuntime = createFlowRuntime({
    runAuthority: rebootedAuthority,
    registeredAuthorities: fixture.registeredAuthorities,
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
    },
  });
  const suspended = rebootedRuntime.query({ run_id: fixture.runId });
  const action = suspended.legal_actions[0];
  assert.equal(action.type, "reboot_admission");
  assert.equal(action.revalidation.authority_bindings.valid, false);
  assert.equal(
    action.revalidation.authority_bindings.issues[0].authority_id,
    "resource:facts",
  );

  const rejection = rebootedRuntime.command(action);
  assert.equal(rejection.code, "required_authority_stale");
  assert.equal(rejection.authority_fact.authority_id, "resource:facts");
  assert.equal(suspended.admission, "suspended_after_reboot");
});

test("feature/v1 verify executes and seals one durable local candidate", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-feature-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
    }),
    reviewTargetObservationAdapter: featureReviewTargetObservationAdapter(),
    hostIdentityAdapter: fixedHostIdentity("boot-feature", "feature-process"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  const reviewAuthority = getReviewAuthority({ runAuthority });
  const handoffAuthority = getResourceHandoffAuthority({ runAuthority });
  const bytes = Buffer.from("feature candidate bytes\n");
  const artifactDigest = sha256(bytes);
  workspaceAuthority.command(workspaceRegistration());

  const applyDescription = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "feature-flow" },
  }, {});
  const critiqueDescription = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "feature-flow" },
  }, {});
  const inputs = featureInputs();
  inputs.workspace = {
    ...inputs.workspace,
    subject_id: "workspace:producer",
    fingerprint: digestValue({ git: exactGitFacts() }),
  };
  inputs.delegation = {
    ...inputs.delegation,
    apply: featureDelegateBindingFromDescription("apply", applyDescription),
    critique: featureDelegateBindingFromDescription(
      "critique",
      critiqueDescription,
    ),
  };
  inputs.finalization = {
    schema: "flow.feature-finalization-binding/v1",
    candidate_id: "candidate:feature",
    publication: handoffPublication(artifactDigest),
  };
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.operation_contracts = Object.values(FEATURE_OPERATION_CONTRACTS);
  facts.validator_contracts.push("flow.validator/operation-receipt/v1");
  facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_CAPTURE_RECEIPT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_TEST_RECEIPT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_VERIFICATION_RECEIPT_VALIDATOR);
  facts.resource_claims.push({
    kind: "workspace",
    id: "workspace:producer",
    generation: 1,
    mutation_epoch: 7,
    fingerprint: digestValue({ git: exactGitFacts() }),
  });
  const slices = inputs.slices ?? [];
  const serializedCardCount = slices.reduce(
    (count, slice) => count + 3 + (slice.mode === "test" ? 1 : 0),
    4 + (inputs.setup === undefined ? 0 : 1),
  );
  facts.limits.max_cards = Math.max(8, serializedCardCount);
  facts.limits.max_resources = 4;
  const authorityState = shippedAuthorityStateFromFacts(facts);
  const registeredAuthorities = shippedAuthorityRegistrations({
    current: authorityState,
  });

  let runtime;
  let verifyReceipt = null;
  let captureObserved = false;
  let captureReceipt = null;
  let applyEvidence = null;
  let critiqueEvidence = null;
  let sealIntent = null;
  const turnRecords = new Map();
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    async describe() {},
    async send() {},
    async observe() {},
    async cancel() {},
    async reconcile() {},
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      const role = request.agent_id.endsWith("apply") ? "apply" : "critique";
      const turnId = `turn:feature-${role}`;
      turnRecords.set(turnId, {
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        output: `${role} accepted`,
        prompt: request.prompt,
      });
      return workingProjection(request, turnId);
    },
    async wait(request) {
      const record = turnRecords.get(request.turn_id);
      return completedTurnProjection({
        agentId: record.agentId,
        callerKey: record.callerKey,
        description: record.description,
        output: record.output,
        prompt: record.prompt,
        turnId: request.turn_id,
      });
    },
    async retire(request) {
      return retiredProjection(request);
    },
  };
  runtime = createFlowRuntime({
    runAuthority,
    registeredAuthorities,
    delegatedAgentPort,
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output.endsWith("accepted");
        },
      },
    },
    registeredOperations: {
      [FEATURE_OPERATION_CONTRACTS.capture]: createFeatureCaptureOperation({
        observe(intent) {
          captureObserved = true;
          const artifact = {
            artifact_schema: "example.candidate/v1",
            digest: sha256(bytes),
            size: bytes.length,
          };
          captureReceipt = featureCaptureReceipt(intent, inputs, {
            git: promotedGitFacts(),
            generation: 2,
            mutationEpoch: 8,
            artifacts: [artifact],
          });
          return {
            receipt: captureReceipt,
            artifacts: [{
              artifact_schema: artifact.artifact_schema,
              bytes,
            }],
          };
        },
        storeArtifacts({ intent, artifacts }) {
          for (const artifact of artifacts) {
            const stored = artifactAuthority.command(artifactRegistration(
              artifact.bytes,
              artifact.digest,
              intent.run_id,
            ));
            if (stored.accepted !== true) return stored;
          }
          return { accepted: true };
        },
      }),
      [FEATURE_OPERATION_CONTRACTS.verify]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
        validateReceipt: validateFeatureVerificationReceipt,
        invoke(intent) {
          const providerReceipt = completeVerificationReceipt(intent, inputs);
          verifyReceipt = operationReceipt(intent, providerReceipt);
          return verifyReceipt;
        },
      },
      [FEATURE_OPERATION_CONTRACTS.seal]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          sealIntent = intent;
          const materialized = intent.operation_input
            .authority_materialized_evidence;
          const finalization = intent.operation_input.finalization;
          const publication = finalization.publication;
          const verification = materialized?.verify_receipt?.receipt
              ?.provider_receipt ??
            materialized?.verify_receipt?.provider_receipt ??
            verifyReceipt?.provider_receipt ?? {
              schema: "work.feature-verification-receipt/v1",
              baseline_fingerprint: inputs.verification.baseline.fingerprint,
              receipt_digest: digestValue("missing-verify-receipt"),
            };
          const critique = completeCritiqueReceipt(
            intent,
            materialized,
            critiqueEvidence,
            [],
          );
          const candidateIdentity = {
            schema: "work.review-candidate/v1",
            candidate_id: intent.operation_input.authority_materialized_candidate
              ?.candidate_id ?? finalization.candidate_id,
            git: promotedGitFacts(),
            workspace: {
              contract: "work.workspace/v1",
              subject_id: "workspace:producer",
              generation: 2,
              mutation_epoch: 8,
              fingerprint: digestValue({ git: promotedGitFacts() }),
            },
            verification,
            critique,
            artifacts: [{
              digest: artifactDigest,
              generation: 1,
              artifact_schema: "example.candidate/v1",
            }],
            git_retention: {
              schema: "flow.git-retention-receipt/v1",
              repository_id: "github.com/Seavenly/example",
              commit_sha: promotedGitFacts().commit_sha,
              tree_sha: promotedGitFacts().tree_sha,
              retention_ref: `refs/flow/review/${promotedGitFacts().commit_sha}`,
            },
          };
          const candidate = {
            ...candidateIdentity,
            candidate_fingerprint: digestValue(candidateIdentity),
          };
          return operationReceipt(intent, {
            schema: "flow.feature-seal-receipt/v1",
            review_candidate: candidate,
            publication_digest: digestValue(publication),
            git_retention: {
              schema: "flow.git-retention-receipt/v1",
              repository_id: "github.com/Seavenly/example",
              commit_sha: promotedGitFacts().commit_sha,
              tree_sha: promotedGitFacts().tree_sha,
              retention_ref: `refs/flow/review/${promotedGitFacts().commit_sha}`,
            },
          });
        },
      },
    },
    registeredAuthorities,
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
      "review/v1": createReviewDefinition(),
    },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs,
    explicit_facts: facts,
  });
  const preparedSeal = prepared.graph.cards.find(({ id }) =>
    id === "feature-seal");
  assert.deepEqual(preparedSeal.inputs.finalization, inputs.finalization);
  assert.equal(captureObserved, false);
  assert.equal(captureReceipt, null);
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.created, true, JSON.stringify(launch));
  const registeredWorkspace = workspaceAuthority.query(workspaceQuery());
  assert.equal(workspaceAuthority.command(workspaceClaim({
    expectedWatermark: registeredWorkspace.watermark,
    expectedFingerprint: digestValue({ git: exactGitFacts() }),
    holder: launch.run_id,
    operations: [
      "feature-apply",
      "feature-verify",
      "feature-critique",
      "feature-seal",
      "handoff_publication",
    ],
  })).accepted, true);

  executeCard(runtime, launch.run_id, "delegate_execute", "feature-apply");
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  applyEvidence = runtime.query({ run_id: launch.run_id }).delegate_attempts
    .find(({ card_id: cardId }) => cardId === "feature-apply").evidence;

  executeCard(runtime, launch.run_id, "operation_execute", "feature-capture");
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-capture" && status === "succeeded",
  ));
  assert.equal(captureObserved, true);
  const resultBindings = runtime.query({ run_id: launch.run_id }).result_bindings;
  const applyBinding = resultBindings
    .find(({ producer_card_id: cardId }) => cardId === "feature-apply");
  const captureBinding = resultBindings
    .find(({ producer_card_id: cardId }) => cardId === "feature-capture");
  assert.ok(applyBinding);
  assert.ok(captureBinding);
  assert.equal(captureBinding.content_digest, digest(captureReceipt));
  assert.deepEqual(captureBinding.content.workspace.git, promotedGitFacts());

  const verifyAction = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type, card_id: cardId }) =>
      type === "operation_execute" && cardId === "feature-verify",
  );
  assert.ok(verifyAction);
  const verifyCommand = runtime.command(verifyAction);
  assert.equal(verifyCommand.accepted, true, JSON.stringify(verifyCommand));
  const verifyIntent = verifyCommand.effect_intents.find(
    ({ card_id: cardId }) => cardId === "feature-verify",
  );
  assert.deepEqual(
    verifyIntent.operation_input.authority_materialized_result_bindings,
    [applyBinding, captureBinding],
  );
  assert.equal(
    verifyIntent.operation_input.authority_materialized_result_bindings_digest,
    digest([applyBinding, captureBinding]),
  );
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-verify" && status === "succeeded",
  ));

  const critiqueAction = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type, card_id: cardId }) =>
      type === "delegate_execute" && cardId === "feature-critique",
  );
  assert.ok(critiqueAction);
  const critiqueCommand = runtime.command(critiqueAction);
  assert.equal(critiqueCommand.accepted, true, JSON.stringify(critiqueCommand));
  const critiqueIntent = critiqueCommand.effect_intents.find(
    ({ card_id: cardId }) => cardId === "feature-critique",
  );
  assert.deepEqual(
    critiqueIntent.delegate_input.authority_materialized_result_bindings,
    [applyBinding, captureBinding],
  );
  assert.equal(
    critiqueIntent.delegate_input.authority_materialized_result_bindings_digest,
    digest([applyBinding, captureBinding]),
  );
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-critique" && status === "succeeded",
  ));
  critiqueEvidence = runtime.query({ run_id: launch.run_id }).delegate_attempts
    .find(({ card_id: cardId }) => cardId === "feature-critique").evidence;

  const sealAction = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type, card_id: cardId }) =>
      type === "operation_execute" && cardId === "feature-seal",
  );
  assert.ok(sealAction);
  const sealCommand = runtime.command(sealAction);
  assert.equal(sealCommand.accepted, true, JSON.stringify(sealCommand));
  const committedSealIntent = sealCommand.effect_intents.find(
    ({ card_id: cardId }) => cardId === "feature-seal",
  );
  assert.ok(committedSealIntent);
  const sealBindings = prepared.graph.result_bindings
    .filter(({ consumer_card_id: cardId }) => cardId === "feature-seal")
    .map((declaration) => runtime.query({ run_id: launch.run_id })
      .result_bindings.find((record) =>
        record.producer_card_id === declaration.producer_card_id &&
        record.output_contract === declaration.output_contract &&
        record.expected_schema === declaration.expected_schema));
  assert.ok(sealBindings.every((binding) => binding !== undefined));
  assert.deepEqual(
    committedSealIntent.operation_input.authority_materialized_result_bindings,
    sealBindings,
  );
  assert.equal(
    committedSealIntent.operation_input.authority_materialized_result_bindings_digest,
    digest(sealBindings),
  );
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  const materialized = sealIntent?.operation_input
    ?.authority_materialized_evidence;
  const expectedCandidateId =
    `candidate:${captureBinding.result_identity.slice("sha256:".length)}`;
  assert.deepEqual(sealIntent.operation_input.finalization, {
    ...inputs.finalization,
    candidate_id: expectedCandidateId,
  });
  assert.ok(materialized, "seal intent must materialize upstream authority evidence");
  assert.deepEqual(materialized.accepted_delegates.map(({ card_id: cardId }) =>
    cardId), ["feature-apply", "feature-critique"]);
  assert.deepEqual(materialized.accepted_delegates.map(({ evidence }) => evidence), [
    applyEvidence,
    critiqueEvidence,
  ]);
  const sourceEffects = new Map(completed.effects.map((effect) => [
    effect.card_id,
    effect,
  ]));
  for (const entry of materialized.accepted_delegates) {
    const source = sourceEffects.get(entry.card_id);
    assert.equal(entry.effect_id, source.effect_id);
    assert.equal(entry.attempt_id, source.attempt_id);
    assert.equal(entry.idempotency_key, source.idempotency_key);
    assert.match(entry.source_authority_watermark, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(entry.evidence, source.receipt.provider_receipt);
  }
  const verifyEntry = materialized.operation_receipts.find(({ card_id: cardId }) =>
    cardId === "feature-verify");
  const verifyEffect = sourceEffects.get("feature-verify");
  assert.equal(verifyEntry.effect_id, verifyEffect.effect_id);
  assert.equal(verifyEntry.attempt_id, verifyEffect.attempt_id);
  assert.equal(verifyEntry.idempotency_key, verifyEffect.idempotency_key);
  assert.equal(verifyEntry.source_authority_watermark,
    verifyReceipt.provider_receipt.source_authority_watermark);
  assert.deepEqual(verifyEntry.receipt, verifyReceipt);
  assert.deepEqual(materialized.verify_receipt, verifyReceipt);

  const capturedResults = completed.result_bindings;
  assert.ok(Array.isArray(capturedResults));
  const applyResult = capturedResults.find(({ producer_card_id: cardId }) =>
    cardId === "feature-apply");
  assert.deepEqual({
    producer_card_id: applyResult.producer_card_id,
    output_contract: applyResult.output_contract,
    expected_schema: applyResult.expected_schema,
    observed_schema: applyResult.observed_schema,
    attempt_id: applyResult.attempt_id,
    producer_generation: applyResult.producer_generation,
    workspace_mutation_epoch: applyResult.workspace_mutation_epoch,
    effect_id: applyResult.provenance.effect_id,
    result_identity: applyResult.result_identity,
    content_digest: applyResult.content_digest,
  }, {
    producer_card_id: "feature-apply",
    output_contract: "workspace_mutation_observation",
    expected_schema: "flow.delegate-evidence/v1",
    observed_schema: "flow.delegate-evidence/v1",
    attempt_id: applyResult.attempt_id,
    producer_generation: 1,
    workspace_mutation_epoch: 7,
    effect_id: applyResult.provenance.effect_id,
    result_identity: applyResult.result_identity,
    content_digest: applyResult.content_digest,
  });
  assert.equal(applyResult.content_digest, digest(applyResult.content));
  const {
    binding_digest: _bindingDigest,
    self_digest: _selfDigest,
    ...bindingIdentity
  } = applyResult;
  assert.equal(applyResult.binding_digest, digest(bindingIdentity));

  const review = reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: expectedCandidateId,
  });
  assert.equal(review.status, "sealed");
  const workspace = workspaceAuthority.query(workspaceQuery());
  assert.equal(workspace.generation, 2);
  assert.equal(workspace.mutation_epoch, 8);
  assert.deepEqual(workspace.git, promotedGitFacts());
  assert.equal(workspace.disposition, "retained_for_handoff");
  assert.equal(completed.handoffs.length, 1);
  const handoff = handoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: completed.handoffs[0].handoff_id,
  });
  assert.equal(handoff.status, "active");
  assert.deepEqual(artifactAuthority.query({
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
  }).pins, [{ holder: "handoff", id: handoff.handoff_id }]);
  const reviewReference = {
    schema: "flow.review-candidate-reference/v1",
    candidate_id: expectedCandidateId,
    candidate_fingerprint: review.candidate_fingerprint,
    review_authority_watermark: review.watermark,
    authority_watermark: completed.watermark,
    legal_actions: [],
  };
  assert.deepEqual(completed.review_candidate_reference, reviewReference);
  assert.deepEqual(completed.views.operator.review_candidate_reference,
    reviewReference);
  assert.deepEqual(completed.views.trust.review_candidate_reference,
    reviewReference);
  for (const view of [completed, completed.views.operator, completed.views.trust]) {
    assert.equal(view.review_candidate_reference.authority_watermark,
      completed.watermark);
    assert.deepEqual(view.legal_actions, []);
    assert.deepEqual(view.review_candidate_reference.legal_actions, []);
  }
  assert.deepEqual(completed.views.operator.handoffs.published, [{
    handoff_id: handoff.handoff_id,
    handoff_watermark: handoff.watermark,
  }]);
  assert.deepEqual(completed.views.trust.handoffs.published,
    completed.views.operator.handoffs.published);
  assert.equal(completed.views.operator.legal_actions.some(({ type }) =>
    ["review", "integration", "push", "pull_request", "cleanup", "tracker"].includes(type)),
  false);

  let receiptLoss = true;
  let firstReviewRecordCommand = null;
  const reviewAuthorityWithReceiptLoss = Object.freeze({
    ...reviewAuthority,
    command(command) {
      if (command?.schema === "work.review-record-command/v1" &&
          firstReviewRecordCommand === null) {
        firstReviewRecordCommand = structuredClone(command);
      }
      const receipt = reviewAuthority.command(command);
      if (receiptLoss && command?.schema === "work.review-record-command/v1" &&
          receipt?.accepted === true && receipt?.created === true) {
        receiptLoss = false;
        throw new Error("simulated crash after durable review record append");
      }
      return receipt;
    },
  });
  const descriptions = await Promise.all([
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6", "security"), {}),
    supportedDescription(reviewDescriptionRequest("claude", "haiku", "correctness"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  const [securityDescription, correctnessDescription, criticDescription] = descriptions;
  const reviewInputs = {
    schema: "flow.review-request/v1",
    target: {
      schema: "flow.review-local-candidate/v1",
      candidate: review.candidate,
      candidate_fingerprint: review.candidate_fingerprint,
      candidate_authority_watermark: review.watermark,
      lifecycle_generation: 4,
    },
    lenses: ["security", "correctness"],
    delegation: {
      schema: "flow.review-delegation-bindings/v1",
      lenses: {
        security: reviewBinding(
          "agent:review-security",
          securityDescription,
        ),
        correctness: reviewBinding(
          "agent:review-correctness",
          correctnessDescription,
        ),
      },
      critic: reviewBinding("agent:review-critic", criticDescription),
    },
  };
  const reviewFacts = structuredClone(dynamicCheckpointProposal().explicit_facts);
  reviewFacts.operation_contracts.push("flow.operation/review-record/v1");
  reviewFacts.validator_contracts.push(
    REVIEW_DELEGATE_OUTPUT_VALIDATOR,
    "flow.validator/operation-receipt/v1",
  );
  reviewFacts.limits.max_cards = 8;
  reviewFacts.limits.max_resources = 2;
  Object.assign(authorityState, shippedAuthorityStateFromFacts(reviewFacts));
  const reviewPrompts = [];
  const reviewDelegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    describe() {},
    discover() {
      return absentDiscovery();
    },
    dispatch(request) {
      reviewPrompts.push(request.prompt);
      const lens = request.agent_id === "agent:review-critic"
        ? "critic"
        : request.agent_id.endsWith("security") ? "security" : "correctness";
      const output = lens === "critic"
        ? JSON.stringify({
            schema: "flow.review-result/v1",
            posture: "no_findings",
            findings: [],
            evidence: { critic: true },
          })
        : reviewResult(lens);
      return completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        output,
        prompt: request.prompt,
        turnId: `turn:${request.caller_key}`,
      });
    },
    send() {},
    observe() {},
    cancel() {},
    reconcile() {},
    wait() {
      throw new Error("wait is not needed for completed review dispatches");
    },
    retire({ agent_id: agentId, turn_id: turnId }) {
      return reviewRetiredProjection(agentId, turnId);
    },
  };
  const reviewRuntime = createFlowRuntime({
    runAuthority,
    registeredAuthorities,
    reviewAuthority: reviewAuthorityWithReceiptLoss,
    delegatedAgentPort: reviewDelegatedAgentPort,
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
      "review/v1": createReviewDefinition(),
    },
  });
  const preparedReview = reviewRuntime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs: reviewInputs,
    explicit_facts: reviewFacts,
  });
  const reviewLaunch = reviewRuntime.launch(
    confirmedPredefinedLaunchRequest(preparedReview),
  );
  assert.equal(reviewLaunch.created, true, JSON.stringify(reviewLaunch));
  let recoverySeen = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = reviewRuntime.query({ run_id: reviewLaunch.run_id });
    if (["failed", "succeeded", "cancelled"].includes(projection.phase)) break;
    const action = projection.legal_actions?.find(({ type }) => [
      "checkpoint_decision",
      "delegate_execute",
      "operation_execute",
      "recovery",
    ].includes(type));
    if (action) {
      recoverySeen ||= action.type === "recovery";
      reviewRuntime.command(action);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const completedReviewRun = reviewRuntime.query({ run_id: reviewLaunch.run_id });
  assert.equal(completedReviewRun.phase, "succeeded");
  assert.equal(receiptLoss, false);
  assert.equal(recoverySeen, true);
  assert.deepEqual(reviewPrompts.filter((prompt) =>
    prompt.includes("Authority-settled finding lens results:")).length, 1);
  assert.match(
    reviewPrompts.find((prompt) => prompt.includes("Authority-settled")),
    /review-lens-security/,
  );
  assert.match(
    reviewPrompts.find((prompt) => prompt.includes("Authority-settled")),
    /review-lens-correctness/,
  );
  const sourceRecordEffect = completedReviewRun.effects.find(({ card_id: cardId }) =>
    cardId === "review-record");
  assert.equal(sourceRecordEffect.status, "succeeded");
  assert.equal(sourceRecordEffect.operation_input, undefined);
  assert.equal(completedReviewRun.views.operator.effects.find(({ card_id: cardId }) =>
    cardId === "review-record").operation_input, undefined);
  assert.equal(completedReviewRun.views.trust.effects.find(({ card_id: cardId }) =>
    cardId === "review-record").operation_input, undefined);
  const privateReviewIntent = getRunEffectIntentReader({ runAuthority })
    .query(completedReviewRun.run_id, sourceRecordEffect.effect_id);
  assert.ok(privateReviewIntent.operation_input.authority_materialized_evidence);
  assert.equal(Object.isFrozen(privateReviewIntent), true);
  assert.equal(completed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-seal").operation_input, undefined);
  assert.equal(completed.views.operator.effects.find(({ card_id: cardId }) =>
    cardId === "feature-seal").operation_input, undefined);
  assert.equal(completed.views.trust.effects.find(({ card_id: cardId }) =>
    cardId === "feature-seal").operation_input, undefined);

  const reviewId = `review:${review.candidate_fingerprint}:4`;
  const reviewedCandidate = reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: reviewId,
  });
  assert.equal(reviewedCandidate.schema, "flow.review-projection/v1");
  assert.equal(reviewedCandidate.append_only_event_count, 1);
  assert.equal(reviewedCandidate.findings.length, 2);
  assert.equal(reviewedCandidate.legal_actions.length, 0);
  assert.equal(reviewedCandidate.integration_authorized, false);
  assert.equal(reviewedCandidate.merge_authorized, false);
  assert.equal(reviewedCandidate.tracker_completion_authorized, false);
  assert.equal(reviewedCandidate.remote_submission_authorized, false);
  const stableWatermark = reviewedCandidate.watermark;
  assert.equal(firstReviewRecordCommand?.subject_id, reviewId);
  const replayed = reviewAuthority.command(firstReviewRecordCommand);
  assert.equal(replayed.accepted, true, JSON.stringify(replayed));
  assert.equal(replayed.created, false);
  assert.equal(replayed.authority_watermark, stableWatermark);
  assert.equal(reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: reviewId,
  }).watermark, stableWatermark);
  const conflictingRecord = reviewAuthority.command({
    ...firstReviewRecordCommand,
    command_id: "review-record:conflicting-command-id",
    expected_watermark: stableWatermark,
  });
  assert.equal(conflictingRecord.code, "idempotency_conflict");
  const afterConflict = reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: reviewId,
  });
  assert.equal(afterConflict.watermark, stableWatermark);
  assert.equal(afterConflict.append_only_event_count, 1);

  const invalidationA = {
    schema: "work.review-target-invalidation-command/v1",
    type: "review_target_invalidated",
    contract: "work.review/v1",
    subject_id: reviewId,
    command_id: `review-target-invalidate:${reviewId}:sha256:${"d".repeat(64)}:5`,
    expected_watermark: stableWatermark,
    prior_candidate_fingerprint: reviewedCandidate.candidate_fingerprint,
    prior_lifecycle_generation: reviewedCandidate.lifecycle_generation,
    observed_candidate_fingerprint: `sha256:${"d".repeat(64)}`,
    observed_lifecycle_generation: 5,
    reason: "target_moved",
  };
  const invalidationB = {
    ...invalidationA,
    command_id: `review-target-invalidate:${reviewId}:sha256:${"e".repeat(64)}:6`,
    observed_candidate_fingerprint: `sha256:${"e".repeat(64)}`,
    observed_lifecycle_generation: 6,
  };
  const [invalidationReceiptA, invalidationReceiptB] = await Promise.all([
    Promise.resolve().then(() => reviewRuntime.command(invalidationA)),
    Promise.resolve().then(() => reviewRuntime.command(invalidationB)),
  ]);
  const invalidationReceipts = [invalidationReceiptA, invalidationReceiptB];
  assert.equal(
    invalidationReceipts.filter(({ accepted }) => accepted === true).length,
    1,
  );
  const staleReceipt = invalidationReceipts.find(({ accepted }) => accepted !== true);
  assert.equal(staleReceipt.code, "stale_authority_watermark");
  const staleReview = reviewRuntime.query({ review_id: reviewId });
  assert.equal(staleReview.status, "stale");
  assert.equal(staleReview.current, false);
  assert.equal(staleReview.evidence_currency, "stale");
  assert.deepEqual(staleReview.summary, reviewedCandidate.summary);
  assert.deepEqual(staleReview.findings, reviewedCandidate.findings);
  assert.deepEqual(staleReview.artifacts, reviewedCandidate.artifacts);
  assert.equal(staleReview.artifacts.watermark, stableWatermark);
  assert.equal(staleReview.artifacts.provenance.review_authority_watermark,
    stableWatermark);
  assert.deepEqual(staleReview.automated_evidence, reviewedCandidate.automated_evidence);
  assert.equal(staleReview.append_only_event_count, 2);
  assert.deepEqual(staleReview.legal_actions.map(({ type }) => type), [
    "review_target_refresh",
  ]);
  assert.equal(staleReview.legal_actions[0].schema,
    "work.review-target-refresh-command/v1");
  assert.equal(staleReview.approval_eligible, false);
  assert.equal(staleReview.submission_eligible, false);
  assert.equal(staleReview.integration_eligible, false);
  assert.equal(staleReview.merge_eligible, false);
  assert.equal(staleReview.tracker_completion_eligible, false);
  assert.equal(staleReview.remote_submission_authorized, false);
  assert.equal(staleReceipt.authority_watermark, staleReview.authority_watermark);
  assert.deepEqual(staleReceipt.legal_actions, staleReview.legal_actions);

  const refreshCommand = staleReview.legal_actions[0];
  const refreshReceipt = reviewRuntime.command(refreshCommand);
  assert.equal(refreshReceipt.accepted, true);
  assert.equal(refreshReceipt.created, true);
  const acknowledgedReview = reviewRuntime.query({ review_id: reviewId });
  assert.equal(acknowledgedReview.status, "stale");
  assert.equal(acknowledgedReview.current, false);
  assert.equal(acknowledgedReview.append_only_event_count, 3);
  assert.deepEqual(acknowledgedReview.legal_actions, []);
  assert.deepEqual(acknowledgedReview.summary, staleReview.summary);
  assert.deepEqual(acknowledgedReview.artifacts, staleReview.artifacts);
  assert.equal(acknowledgedReview.artifacts.watermark, stableWatermark);
  assert.equal(acknowledgedReview.artifacts.provenance.review_authority_watermark,
    stableWatermark);
  assert.deepEqual(acknowledgedReview.automated_evidence, staleReview.automated_evidence);
  assert.deepEqual(acknowledgedReview.refresh, {
    schema: "flow.review-target-refresh/v1",
    subject_id: reviewId,
    prior_candidate_fingerprint: reviewedCandidate.candidate_fingerprint,
    prior_lifecycle_generation: reviewedCandidate.lifecycle_generation,
    observed_candidate_fingerprint: refreshCommand.observed_candidate_fingerprint,
    observed_lifecycle_generation: refreshCommand.observed_lifecycle_generation,
    observation: refreshCommand.authority_observation,
  });
  const replayRefresh = reviewRuntime.command(refreshCommand);
  assert.equal(replayRefresh.accepted, true);
  assert.equal(replayRefresh.created, false);
  const staleRefresh = reviewRuntime.command({
    ...refreshCommand,
    command_id: `${refreshCommand.command_id}:stale-writer`,
    observed_candidate_fingerprint: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(staleRefresh.code, "stale_authority_watermark");

  runAuthority.close();
  const recoveredRunAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
    }),
    hostIdentityAdapter: fixedHostIdentity("boot-review-recovered", "review-process"),
  });
  t.after(() => recoveredRunAuthority.close());
  const recoveredReviewAuthority = getReviewAuthority({
    runAuthority: recoveredRunAuthority,
  });
  const recovered = recoveredReviewAuthority.query({
    contract: "work.review/v1",
    subject_id: reviewId,
  });
  assert.deepEqual(recovered, acknowledgedReview);
  const recoveredWatch = await recoveredReviewAuthority.watch({
    subject_id: reviewId,
  }).next();
  assert.deepEqual(recoveredWatch.value, acknowledgedReview);
});

test("feature/v1 derives finalization from the captured candidate", async (t) => {
  const fixture = await createFeatureFailureFixture(t, { identityFree: true });
  const { runId, runtime } = fixture;

  executeCard(runtime, runId, "delegate_execute", "feature-apply");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  executeCard(runtime, runId, "operation_execute", "feature-capture");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-capture" && status === "succeeded",
  ));
  executeCard(runtime, runId, "operation_execute", "feature-verify");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-verify" && status === "succeeded",
  ));
  executeCard(runtime, runId, "delegate_execute", "feature-critique");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-critique" && status === "succeeded",
  ));

  const sealAction = runtime.query({ run_id: runId }).legal_actions.find(
    ({ type, card_id: cardId }) =>
      type === "operation_execute" && cardId === "feature-seal",
  );
  assert.ok(sealAction);
  const sealCommand = runtime.command(sealAction);
  assert.equal(sealCommand.accepted, true, JSON.stringify(sealCommand));
  const sealIntent = sealCommand.effect_intents.find(({ card_id: cardId }) =>
    cardId === "feature-seal");
  assert.equal(sealIntent.operation_input.finalization.schema,
    "flow.feature-finalization-binding/v1");
  assert.equal(sealIntent.operation_input.publication.schema,
    "flow.resource-handoff-publication/v1");
  await until(() => runtime.query({ run_id: runId }).phase === "succeeded");
});

test("feature/v1 derives candidate identity from captured bindings", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    callerCandidateId: "candidate:caller-supplied",
  });
  await driveFeatureToSeal(fixture);

  const completed = fixture.runtime.query({ run_id: fixture.runId });
  const capture = completed.result_bindings.find(({ producer_card_id: cardId }) =>
    cardId === "feature-capture");
  assert.ok(capture?.result_identity);
  assert.equal(
    completed.review_candidate_reference.candidate_id,
    `candidate:${capture.result_identity.slice("sha256:".length)}`,
  );
  assert.notEqual(
    completed.review_candidate_reference.candidate_id,
    "candidate:caller-supplied",
  );
});

test("legacy feature replay rejects critique receipts that select apply evidence", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    legacyNoResultBindings: true,
    forgeCritiqueAsApply: true,
  });

  assert.equal(Object.hasOwn(fixture.prepared.graph, "result_bindings"), false);
  await driveFeatureToSeal(fixture);

  const projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.notEqual(projection.phase, "succeeded", JSON.stringify({
    phase: projection.phase,
    seal: projection.effects.find(({ card_id: cardId }) =>
      cardId === "feature-seal"),
  }));
  assert.deepEqual(projection.handoffs, []);
});

test("legacy feature-critique receipts are accepted and replay unchanged", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    legacyNoResultBindings: true,
  });
  await driveFeatureToSeal(fixture);

  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  const sealEffect = completed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-seal");
  assert.equal(
    sealEffect.receipt.provider_receipt.review_candidate.critique
      .delegate_evidence.card_id,
    "feature-critique",
  );
  const beforeReplay = structuredClone(completed);
  fixture.runAuthority.close();
  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory: fixture.authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
      promotedGit: fixture.promotedGit(),
    }),
    hostIdentityAdapter: fixedHostIdentity("boot-feature-red", "legacy-replay"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createFlowRuntime({ runAuthority: recoveredAuthority });
  const replayed = recoveredRuntime.query({ run_id: fixture.runId });

  assert.equal(replayed.phase, "succeeded");
  assert.deepEqual(replayed.cards, beforeReplay.cards);
  assert.deepEqual(replayed.effects, beforeReplay.effects);
  assert.equal(
    replayed.review_candidate_reference.candidate_id,
    beforeReplay.review_candidate_reference.candidate_id,
  );
});

test("feature/v1 identity-free repair captures and consumes a fresh candidate", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    repair: "critique",
  });
  await driveFeatureToSeal(fixture, { allowSealRefusal: true });

  let projection = fixture.runtime.query({ run_id: fixture.runId });
  const revisionAction = projection.legal_actions.find(({ type }) =>
    type === "revision_decision");
  assert.ok(revisionAction);
  assert.equal(fixture.runtime.command(revisionAction).accepted, true);
  projection = fixture.runtime.query({ run_id: fixture.runId });

  const captureAction = projection.legal_actions.find(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-capture-repair");
  assert.ok(captureAction);
  assert.equal(fixture.runtime.command(captureAction).accepted, true);
  await settleFeatureEffect(fixture.runtime, fixture.runId, "feature-capture-repair");

  projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.ok(Array.isArray(projection.active_plan.result_bindings),
    JSON.stringify(projection.active_plan));
  assert.ok(projection.active_plan.result_bindings.some(({ consumer_card_id: id }) =>
    id === "feature-seal-repair"), JSON.stringify(projection.active_plan.result_bindings));
  const captureBinding = projection.result_bindings.find(({ producer_card_id: id }) =>
    id === "feature-capture-repair");
  assert.ok(captureBinding);
  const sealAction = projection.legal_actions.find(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-seal-repair");
  assert.ok(sealAction);
  assert.equal(fixture.runtime.command(sealAction).accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fixture.runtime.query({ run_id: fixture.runId }).phase,
    "succeeded");
  assert.equal(
    fixture.runtime.query({ run_id: fixture.runId }).review_candidate_reference
      .candidate_id,
    `candidate:${captureBinding.result_identity.slice("sha256:".length)}`,
  );
});

test("feature/v1 identity-free repair rejects remapping to a pre-repair capture", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    repair: "critique",
  });
  const inputs = structuredClone(fixture.inputs);
  const repairCard = inputs.repairs[0].template.changes.add_cards
    .find(({ id }) => id === "feature-seal-repair");
  repairCard.inputs.operation_evidence_card_ids = [
    "feature-capture",
    "feature-verify",
  ];

  assert.throws(
    () => fixture.runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "feature/v1",
      inputs,
      explicit_facts: fixture.facts,
    }),
    (error) => error?.reason === "feature_repair_result_binding",
  );
});

test("feature/v1 identity-free seal repair preserves every operation evidence binding", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    repair: "critique",
  });
  const inputs = structuredClone(fixture.inputs);
  const repairCard = inputs.repairs[0].template.changes.add_cards
    .find(({ id }) => id === "feature-seal-repair");
  repairCard.inputs.operation_evidence_card_ids = ["feature-capture-repair"];

  assert.throws(
    () => fixture.runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "feature/v1",
      inputs,
      explicit_facts: fixture.facts,
    }),
    (error) => error?.reason === "feature_repair_result_binding",
  );
});

test("feature/v1 captures and publishes a candidate from a real Git workspace", async (t) => {
  const realGit = await createRealGitScenario(t);
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    realGit,
  });
  const preparedText = JSON.stringify(fixture.prepared);
  assert.equal(preparedText.includes('"finalization"'), false);
  assert.equal(preparedText.includes('"patch"'), false);
  assert.equal(realGit.candidateGit, null);
  assert.equal(realGit.captureCount, 0);

  await driveFeatureToSeal(fixture);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  assert.equal(realGit.captureCount, 1);
  assert.ok(realGit.candidateGit);
  assert.deepEqual(realGit.candidateGit, realGitFactsSync(realGit.repositoryDirectory));
  assert.equal(realGit.candidateGit.clean, true);
  assert.equal(realGit.candidateGit.ref, "refs/heads/ticket/feature");
  assert.equal(preparedText.includes(realGit.candidateGit.commit_sha), false);
  assert.equal(preparedText.includes(realGit.candidateGit.tree_sha), false);

  const captureBinding = completed.result_bindings.find(({ producer_card_id }) =>
    producer_card_id === "feature-capture");
  assert.ok(captureBinding);
  assert.deepEqual(captureBinding.content.git, realGit.candidateGit);
  assert.equal(captureBinding.content_digest, digest(captureBinding.content));
  assert.equal(captureBinding.content.artifacts.length, 1);
  const artifactDigest = fixture.currentArtifactDigest();
  assert.equal(captureBinding.content.artifacts[0].digest, artifactDigest);
  const storedBytes = await readFile(join(
    fixture.authorityDirectory,
    "artifacts",
    artifactDigest.slice("sha256:".length),
  ));
  assert.deepEqual(storedBytes, realGit.candidateBytes);
  assert.equal(sha256(storedBytes), artifactDigest);

  const workspace = fixture.workspaceAuthority.query(workspaceQuery());
  assert.equal(workspace.generation, 2);
  assert.equal(workspace.mutation_epoch, 8);
  assert.deepEqual(workspace.git, realGit.candidateGit);
  assert.equal(workspace.disposition, "retained_for_handoff");
  assert.equal(completed.handoffs.length, 1);
  const handoff = fixture.handoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: completed.handoffs[0].handoff_id,
  });
  assert.equal(handoff.status, "active");
  assert.deepEqual(fixture.artifactAuthority.query({
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
  }).pins, [{ holder: "handoff", id: handoff.handoff_id }]);
  assert.ok(completed.review_candidate_reference?.candidate_id);
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: completed.review_candidate_reference.candidate_id,
  }).status, "sealed");
});

test("feature/v1 rejects Git or artifact drift after capture", async (t) => {
  for (const drift of ["git", "artifact"]) {
    await t.test(`rejects ${drift} drift`, async (caseTest) => {
      const realGit = await createRealGitScenario(caseTest);
      const fixture = await createFeatureFailureFixture(caseTest, {
        identityFree: true,
        realGit,
      });
      realGit.beforeSeal = ({ artifactDigest, authorityDirectory }) => {
        if (drift === "git") {
          writeFileSync(join(realGit.repositoryDirectory, "feature.txt"), "drift\n");
          return;
        }
        writeFileSync(join(
          authorityDirectory,
          "artifacts",
          artifactDigest.slice("sha256:".length),
        ), Buffer.from("tampered artifact bytes\n"));
      };

      await driveFeatureToSeal(fixture);
      const blocked = fixture.runtime.query({ run_id: fixture.runId });
      const sealEffect = blocked.effects.find(({ card_id: cardId }) =>
        cardId === "feature-seal");
      assert.equal(blocked.phase, "active");
      assert.equal(sealEffect.status, "unresolved");
      assert.deepEqual(blocked.handoffs, []);
      assert.equal(fixture.workspaceAuthority.query(workspaceQuery()).generation, 1);
      assert.equal(realGit.captureCount, 1);
      assert.equal(blocked.result_bindings.filter(({ producer_card_id }) =>
        producer_card_id === "feature-capture").length, 1);
      if (drift === "artifact") {
        assert.notEqual(fixture.artifactAuthority.query({
          contract: "work.artifact/v1",
          subject_id: fixture.currentArtifactDigest(),
        }).byte_availability, "available");
      }
    });
  }
});

test("feature/v1 durable reopen preserves the exact real Git capture and seal", async (t) => {
  const realGit = await createRealGitScenario(t);
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    realGit,
  });
  await driveFeatureToSeal(fixture);
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(completed.phase, "succeeded");
  const sealEffect = completed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-seal");
  const originalSealIntent = fixture.sealIntents.at(-1);
  assert.ok(originalSealIntent);

  fixture.runAuthority.close();
  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory: fixture.authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: realGitWorkspaceObservationAdapter(
      realGit.repositoryDirectory,
    ),
    hostIdentityAdapter: fixedHostIdentity("boot-feature-recovered", "feature-recovered"),
  });
  t.after(() => recoveredAuthority.close());
  const recovered = recoveredAuthority.query(fixture.runId);
  assert.deepEqual(recovered.result_bindings, completed.result_bindings);
  assert.deepEqual(recovered.handoffs, completed.handoffs);
  const recoveredIntent = getRunEffectIntentReader({
    runAuthority: recoveredAuthority,
  }).query(fixture.runId, sealEffect.effect_id);
  assert.ok(recoveredIntent);
  assert.deepEqual(
    recoveredIntent.operation_input.authority_materialized_candidate,
    originalSealIntent.operation_input.authority_materialized_candidate,
  );
  assert.equal(
    recoveredIntent.operation_input.authority_materialized_candidate_digest,
    originalSealIntent.operation_input.authority_materialized_candidate_digest,
  );
  assert.equal(recovered.handoffs.length, 1);
  assert.deepEqual(getArtifactAuthority({ runAuthority: recoveredAuthority }).query({
    contract: "work.artifact/v1",
    subject_id: fixture.currentArtifactDigest(),
  }).pins, [{ holder: "handoff", id: recovered.handoffs[0].handoff_id }]);
});

test("feature/v1 durable reopen after capture preserves the next exact action", async (t) => {
  const realGit = await createRealGitScenario(t);
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    realGit,
  });
  executeCard(fixture.runtime, fixture.runId, "delegate_execute", "feature-apply");
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  executeCard(fixture.runtime, fixture.runId, "operation_execute", "feature-capture");
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-capture" && status === "succeeded",
  ));
  const beforeReopen = fixture.runtime.query({ run_id: fixture.runId });
  const captureBinding = beforeReopen.result_bindings.find(({ producer_card_id }) =>
    producer_card_id === "feature-capture");
  assert.ok(captureBinding);

  fixture.runAuthority.close();
  const recoveredAuthority = createDurableRunAuthority({
    access: "inspect",
    authorityDirectory: fixture.authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: realGitWorkspaceObservationAdapter(
      realGit.repositoryDirectory,
    ),
    hostIdentityAdapter: fixedHostIdentity("boot-feature-capture-recovered", "feature-recovered"),
  });
  t.after(() => recoveredAuthority.close());
  const recovered = recoveredAuthority.query(fixture.runId);
  assert.deepEqual(recovered.result_bindings, beforeReopen.result_bindings);
  assert.equal(recovered.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture").status, "succeeded");
  assert.ok(recovered.legal_actions.some(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-verify"));
  assert.deepEqual(getArtifactAuthority({ runAuthority: recoveredAuthority }).query({
    contract: "work.artifact/v1",
    subject_id: fixture.currentArtifactDigest(),
  }).pins, [{ holder: "run", id: fixture.runId }]);
  assert.equal(captureBinding.content.git.commit_sha, realGit.candidateGit.commit_sha);
});

test("feature/v1 recovers a crash before capture settlement without partial evidence", async (t) => {
  let crashed = false;
  const realGit = await createRealGitScenario(t);
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    realGit,
    beforeEffect(intent) {
      if (intent.operation_contract === FEATURE_OPERATION_CONTRACTS.capture &&
          !crashed) {
        crashed = true;
        throw new Error("simulated crash before capture settlement");
      }
    },
  });

  executeCard(fixture.runtime, fixture.runId, "delegate_execute", "feature-apply");
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  const captureAction = fixture.runtime.query({ run_id: fixture.runId }).legal_actions
    .find(({ card_id: cardId }) => cardId === "feature-capture");
  assert.ok(captureAction);
  assert.equal(fixture.runtime.command(captureAction).accepted, true);
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, invocation_started: invocationStarted, status }) =>
      cardId === "feature-capture" && invocationStarted && status === "unresolved",
  ));
  const crashedProjection = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(crashedProjection.result_bindings.some(({ producer_card_id: cardId }) =>
    cardId === "feature-capture"), false);
  assert.equal(crashedProjection.result_bindings.filter(({ producer_card_id: cardId }) =>
    cardId === "feature-apply").length, 1);
  const captureEffect = crashedProjection.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture");
  const recovery = crashedProjection.legal_actions.find(({ type, effect_id: effectId }) =>
    type === "recovery" && effectId === captureEffect.effect_id);
  assert.ok(recovery);

  assert.equal(fixture.runtime.command(recovery).accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const recovered = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(realGit.captureCount, 0);
  assert.equal(recovered.result_bindings.some(({ producer_card_id: cardId }) =>
    cardId === "feature-capture"), false);
  assert.equal(recovered.effects.filter(({ card_id: cardId }) =>
    cardId === "feature-capture").length, 1);
  assert.equal(recovered.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture").status, "reconciling");
});

test("feature/v1 adopts the exact capture after a crash before settlement", async (t) => {
  const realGit = await createRealGitScenario(t);
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    realGit,
    captureCrashAfterStorage: true,
  });
  executeCard(fixture.runtime, fixture.runId, "delegate_execute", "feature-apply");
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  const captureAction = fixture.runtime.query({ run_id: fixture.runId }).legal_actions
    .find(({ card_id: cardId }) => cardId === "feature-capture");
  assert.ok(captureAction);
  assert.equal(fixture.runtime.command(captureAction).accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(realGit.captureCount, 1);

  writeFileSync(join(realGit.repositoryDirectory, "feature.txt"), "ambient drift\n");
  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory: fixture.authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: realGitWorkspaceObservationAdapter(
      realGit.repositoryDirectory,
    ),
    hostIdentityAdapter: fixedHostIdentity("boot-feature-red", "feature-recovered"),
  });
  t.after(() => recoveredAuthority.close());
  const freshCaptureOperation = createFeatureCaptureOperation({
    observe() {
      throw new Error("fresh recovery must not reinvoke capture");
    },
    reconcile() {
      return fixture.captureReceipt();
    },
  });
  const recoveredRuntime = createFlowRuntime({
    runAuthority: recoveredAuthority,
    registeredOperations: {
      [FEATURE_OPERATION_CONTRACTS.capture]: freshCaptureOperation,
    },
    registeredAuthorities: fixture.registeredAuthorities,
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
    },
  });
  const crashed = recoveredRuntime.query({ run_id: fixture.runId });
  const captureEffect = crashed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture");
  const recovery = crashed.legal_actions.find(({ type, effect_id: effectId }) =>
    type === "recovery" && effectId === captureEffect.effect_id);
  assert.ok(recovery);
  assert.equal(recoveredRuntime.command(recovery).accepted, true);
  await until(() => recoveredRuntime.query({ run_id: fixture.runId }).result_bindings
    .some(({ producer_card_id: cardId }) => cardId === "feature-capture"));

  const recovered = recoveredRuntime.query({ run_id: fixture.runId });
  const captureBinding = recovered.result_bindings.find(({ producer_card_id: cardId }) =>
    cardId === "feature-capture");
  assert.deepEqual(captureBinding.content.git, realGit.candidateGit);
  assert.equal(realGit.captureCount, 1);
});

test("feature/v1 late capture after cancellation remains unusable evidence", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    capturePending: true,
  });
  executeCard(fixture.runtime, fixture.runId, "delegate_execute", "feature-apply");
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  const captureAction = fixture.runtime.query({ run_id: fixture.runId }).legal_actions
    .find(({ card_id: cardId }) => cardId === "feature-capture");
  assert.ok(captureAction);
  assert.equal(fixture.runtime.command(captureAction).accepted, true);
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, invocation_started: invocationStarted, status }) =>
      cardId === "feature-capture" && invocationStarted && status === "unresolved",
  ));
  const beforeCancel = fixture.runtime.query({ run_id: fixture.runId });
  const cancel = beforeCancel.legal_actions.find(({ type }) => type === "cancel");
  assert.ok(cancel);
  assert.equal(fixture.runtime.command(cancel).accepted, true);
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).phase ===
    "cancelled");

  fixture.releaseCapture();
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-capture" && status === "late_succeeded",
  ));
  const cancelled = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(cancelled.result_bindings.some(({ producer_card_id: cardId }) =>
    cardId === "feature-capture"), false);
});

test("feature/v1 rejects a capture that does not advance the workspace fence", async (t) => {
  const fixture = await createFeatureFailureFixture(t, {
    identityFree: true,
    captureGeneration: 1,
    captureMutationEpoch: 7,
  });
  executeCard(fixture.runtime, fixture.runId, "delegate_execute", "feature-apply");
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  const captureAction = fixture.runtime.query({ run_id: fixture.runId }).legal_actions
    .find(({ card_id: cardId }) => cardId === "feature-capture");
  assert.ok(captureAction);
  assert.equal(fixture.runtime.command(captureAction).accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const projection = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(projection.result_bindings.some(({ producer_card_id: cardId }) =>
    cardId === "feature-capture"), false);
  assert.equal(projection.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture").status, "unresolved");
});

test("durable review target observation rejects a partial movement adapter at construction", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-review-observation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  assert.throws(
    () => createDurableRunAuthority({
      authorityDirectory,
      reviewTargetObservationAdapter: {
        movement_shapes: ["combined"],
        observe() {
          return null;
        },
      },
      hostIdentityAdapter: fixedHostIdentity("boot-observation", "observation-process"),
    }),
    /all target movement shapes/u,
  );
});

test("feature/v1 seal rejects invalid verification and publication evidence", async (t) => {
  const criterion = "the changed behavior is observable";
  const cases = [
    {
      name: "verification omits an accepted criterion",
      verification: { omit_criteria: [criterion] },
    },
    {
      name: "verification contains a non-passed verdict",
      verification: { verdicts: { [criterion]: "failed" } },
    },
    {
      name: "verification contains a missing verdict",
      verification: { missing_verdicts: [criterion] },
    },
    {
      name: "verification does not distinguish the safe baseline",
      verification: { distinguished: false },
    },
    {
      name: "verification discriminator names a stale post-mutation state",
      verification: {
        post_mutation_fingerprint: `sha256:${"8".repeat(64)}`,
      },
    },
    {
      name: "critique contains a blocking finding",
      critiqueFindings: [{ classification: "blocking", summary: "unsafe change" }],
    },
    {
      name: "verification evidence is stale against workspace and authority",
      verification: {
        workspace: {
          subject_id: "workspace:producer",
          generation: 0,
          mutation_epoch: 6,
          fingerprint: `sha256:${"8".repeat(64)}`,
          git: exactGitFacts(),
        },
        source_authority_watermark: `sha256:${"9".repeat(64)}`,
      },
    },
    {
      name: "delegate self-report cannot replace an absent verify receipt",
      forgedDelegateSelfReport: true,
      verifyReceiptMode: "absent",
    },
    {
      name: "feature seal omits the ReviewAuthority candidate",
      omitReviewCandidate: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (caseTest) => {
      const fixture = await createFeatureFailureFixture(caseTest, scenario);
      await driveFeatureToSeal(fixture);
      const projection = fixture.runtime.query({ run_id: fixture.runId });
      assert.notEqual(projection.phase, "succeeded");
      assert.equal(
        fixture.reviewAuthority.query({
          contract: "work.review/v1",
          subject_id: "candidate:feature",
        }).status,
        undefined,
      );
      assert.deepEqual(projection.handoffs, []);
      assert.equal(fixture.workspaceAuthority.query(workspaceQuery()).generation, 1);
      assert.deepEqual(
        fixture.artifactAuthority.query({
          contract: "work.artifact/v1",
          subject_id: fixture.artifactDigest,
        }).pins,
        [{ holder: "run", id: fixture.runId }],
      );
      for (const action of projection.legal_actions) {
        assert.equal(action.expected_watermark, projection.watermark);
      }
    });
  }
});

test("feature/v1 seal rollback keeps all authorities unpromoted and exposes exact recovery", async (t) => {
  let injected = true;
  const fixture = await createFeatureFailureFixture(t, {
    beforeHandoffCommit() {
      if (injected) {
        injected = false;
        throw new Error("injected feature handoff commit failure");
      }
    },
  });

  await driveFeatureToSeal(fixture);
  const failed = fixture.runtime.query({ run_id: fixture.runId });
  const effect = failed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-seal");
  const failedWorkspace = fixture.workspaceAuthority.query(workspaceQuery());
  assert.equal(failed.phase, "active");
  assert.equal(effect.status, "unresolved");
  assert.equal(fixture.sealIntents.length, 1);
  assert.deepEqual(failed.handoffs, []);
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: "candidate:feature",
  }).code, "unknown_subject");
  assert.equal(failedWorkspace.generation, 1);
  assert.equal(failedWorkspace.mutation_epoch, 7);
  assert.deepEqual(failedWorkspace.git, exactGitFacts());
  assert.deepEqual(fixture.artifactAuthority.query({
    contract: "work.artifact/v1",
    subject_id: fixture.artifactDigest,
  }).pins, [{ holder: "run", id: fixture.runId }]);
  const recovery = failed.legal_actions.find(({ type, effect_id: effectId }) =>
    type === "recovery" && effectId === effect.effect_id);
  assert.ok(recovery);
  assert.equal(recovery.expected_watermark, failed.watermark);

  const retried = fixture.runtime.command(recovery);
  assert.equal(retried.accepted, true, JSON.stringify(retried));
  await until(() => fixture.runtime.query({ run_id: fixture.runId }).phase ===
    "succeeded");
  const completed = fixture.runtime.query({ run_id: fixture.runId });
  assert.equal(fixture.sealIntents.length, 2);
  assert.equal(digest(fixture.sealIntents[0]), digest(fixture.sealIntents[1]));
  assert.deepEqual(
    fixture.sealIntents[0].operation_input.authority_materialized_evidence,
    fixture.sealIntents[1].operation_input.authority_materialized_evidence,
  );
  assert.equal(completed.effects.filter(({ card_id: cardId }) =>
    cardId === "feature-seal").length, 1);
  const candidateId = completed.review_candidate_reference.candidate_id;
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: candidateId,
  }).status, "sealed");
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: candidateId,
  }).generation, 1);
  assert.equal(completed.handoffs.length, 1);
  assert.equal(fixture.handoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: completed.handoffs[0].handoff_id,
  }).status, "active");
});

function reviewDescriptionRequest(harness, model, owner) {
  return {
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness,
      role: "reviewer",
      model,
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner },
  };
}

function reviewBinding(agentId, description) {
  return {
    description,
    route: {
      agent_id: agentId,
      configuration_watermark: description.watermark.content_sha256,
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    },
  };
}

function reviewResult(lens) {
  return JSON.stringify({
    schema: "flow.review-result/v1",
    posture: "findings",
    findings: [{
      lens,
      urgency: "high",
      classification: "blocking",
      summary: `${lens} finding`,
      detail: `${lens} detail`,
      location: { path: "src/feature.mjs", start_line: 1, end_line: 1 },
    }],
    evidence: { lens },
  });
}

function reviewRetiredProjection(agentId, turnId) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "retire",
    status: "retired",
    watermark: {
      schema: "drovr.agent-authority-watermark/v1",
      authority: "drovr.registry",
      agent_id: agentId,
      record_sha256: digestValue(agentId),
    },
    delegation: {
      agent_id: agentId,
      task_id: `task:${agentId}`,
      group_id: "group:review-flow",
    },
    turn: { id: turnId, status: "completed" },
    legal_next_actions: [],
  };
}

function featureDelegateBindingFromDescription(role, description) {
  const boundDescription = structuredClone(description);
  delete boundDescription.description_digest;
  boundDescription.description_digest = digestValue(boundDescription);
  return {
    description: boundDescription,
    route: {
      agent_id: `agent:feature-${role}`,
      configuration_watermark: boundDescription.watermark.content_sha256,
      description_digest: boundDescription.description_digest,
      launch_comparison_key: boundDescription.comparison_keys.launch,
    },
    validators: [DELEGATE_OUTPUT_VALIDATOR],
  };
}

function featureCaptureReceipt(
  intent,
  inputs,
  {
    git = promotedGitFacts(),
    generation = inputs.workspace.generation + 1,
    mutationEpoch = inputs.workspace.mutation_epoch + 1,
    artifacts = [],
  } = {},
) {
  const capturedArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    bytes_digest: artifact.bytes_digest ?? artifact.digest,
  }));
  const workspace = {
    subject_id: inputs.workspace.subject_id,
    generation,
    mutation_epoch: mutationEpoch,
    fingerprint: digestValue({ git }),
    git,
  };
  const identity = {
    schema: "work.feature-capture-receipt/v1",
    operation_contract: FEATURE_OPERATION_CONTRACTS.capture,
    outcome: "captured",
    effect_id: intent.effect_id,
    attempt_id: intent.attempt_id,
    idempotency_key: intent.idempotency_key,
    source_authority_watermark: intent.source_authority_watermark,
    workspace,
    git,
    artifacts: capturedArtifacts,
  };
  const selfDigest = digestValue(identity);
  return {
    ...identity,
    receipt_digest: selfDigest,
    self_digest: selfDigest,
  };
}

function completeVerificationReceipt(
  intent,
  inputs,
  overrides = {},
  materialized = null,
) {
  const sliceTest = intent.operation_input.phase === "slice_verify" &&
    intent.operation_input.slice?.mode === "test";
  const testOnly = sliceTest || inputs.mode === "test" &&
    !inputs.verification?.baseline &&
    !inputs.verification?.compensating_assertion;
  const discriminatingEvidence = testOnly
    ? testSelectionForInputs(inputs)
    : inputs.verification.baseline ?? inputs.verification.compensating_assertion;
  const expectedCriteria = overrides.criteria ??
    intent.operation_input.slice?.acceptance ?? inputs.brief.acceptance;
  const acceptanceCriteria = expectedCriteria.map((criterion) => {
    if (overrides.omit_criteria?.includes(criterion)) return null;
    const verdict = overrides.verdicts?.[criterion] ?? "passed";
    const criterionReceipt = {
      criterion,
      evidence_digest: digestValue({
        brief_id: inputs.brief.id,
        criterion,
        verdict,
      }),
    };
    if (!overrides.missing_verdicts?.includes(criterion)) {
      criterionReceipt.verdict = verdict;
    }
    return criterionReceipt;
  }).filter(Boolean);
  const workspace = overrides.workspace ?? {
    subject_id: inputs.workspace.subject_id,
    generation: inputs.workspace.generation,
    mutation_epoch: inputs.workspace.mutation_epoch,
    fingerprint: digestValue({ git: promotedGitFacts() }),
    git: promotedGitFacts(),
  };
  const evidenceKind = overrides.discriminating_kind ?? (testOnly
    ? "test_failure"
    : inputs.verification.baseline ? "safe_baseline" : "compensating_assertion");
  const selectedFingerprint = overrides.discriminating_fingerprint ??
    discriminatingEvidence.fingerprint;
  const testFailures = testOnly
    ? (materialized?.operation_receipts ?? [])
      .filter(({ card_id: cardId, receipt }) =>
        cardId.endsWith("-test") && receipt?.provider_receipt !== null &&
        receipt?.provider_receipt !== undefined)
      .map((entry) => ({
        card_id: entry.card_id,
        effect_id: entry.effect_id,
        receipt_digest: digestValue(entry.receipt.provider_receipt),
        slice_id: entry.receipt.provider_receipt.slice_id,
      }))
    : undefined;
  const discriminating = evidenceKind === "test_failure"
    ? {
        schema: "flow.feature-discriminating-evidence/v1",
        kind: evidenceKind,
        selected_fingerprint: selectedFingerprint,
        post_mutation_fingerprint: overrides.post_mutation_fingerprint ??
          workspace.fingerprint,
        distinguished: overrides.distinguished ?? true,
        test_failures: testFailures,
      }
    : evidenceKind === "safe_baseline"
    ? {
        schema: "flow.feature-discriminating-evidence/v1",
        kind: evidenceKind,
        selected_fingerprint: selectedFingerprint,
        post_mutation_fingerprint: overrides.post_mutation_fingerprint ??
          workspace.fingerprint,
        distinguished: overrides.distinguished ?? true,
      }
    : {
        schema: "flow.feature-discriminating-evidence/v1",
        kind: evidenceKind,
        selected_fingerprint: selectedFingerprint,
        post_mutation_fingerprint: overrides.post_mutation_fingerprint ??
          workspace.fingerprint,
        assertion_receipt_digest: digestValue({
          assertion: discriminatingEvidence.assertion,
          post_mutation_fingerprint: workspace.fingerprint,
        }),
        non_destructive: overrides.non_destructive ?? true,
        satisfied: overrides.satisfied ?? true,
        distinguished: overrides.distinguished ?? true,
      };
  const identity = {
    schema: "work.feature-verification-receipt/v1",
    brief_id: inputs.brief.id,
    acceptance_criteria: acceptanceCriteria,
    discriminating_evidence: discriminating,
    selected_evidence_fingerprint: discriminatingEvidence.fingerprint,
    workspace,
    source_authority_watermark: overrides.source_authority_watermark ??
      intent.source_authority_watermark,
    operation_contract: intent.operation_contract,
    effect_id: intent.effect_id,
    attempt_id: intent.attempt_id,
    idempotency_key: intent.idempotency_key,
  };
  const selfDigest = digestValue(identity);
  return {
    ...identity,
    receipt_digest: selfDigest,
    self_digest: selfDigest,
  };
}

function featureSlicePostGit(inputs, scenario, slice, promotedGit) {
  const sliceIndex = inputs.slices.findIndex(({ id }) => id === slice.id);
  if (scenario.snapshotMode === "skip" &&
      sliceIndex < inputs.slices.length - 1) {
    return promotedGit;
  }
  if (scenario.snapshotMode === "reordered") {
    const snapshots = scenario.sliceSnapshots ?? [];
    return snapshots[snapshots.length - sliceIndex - 1] ?? promotedGit;
  }
  return scenario.sliceSnapshots?.[sliceIndex] ??
    (sliceIndex === inputs.slices.length - 1
      ? promotedGit
      : intermediateGitFacts());
}

function featureSlicePreGit(inputs, scenario, slice, promotedGit) {
  const sliceIndex = inputs.slices.findIndex(({ id }) => id === slice.id);
  if (sliceIndex === 0) return exactGitFacts();
  if (scenario.snapshotMode === "stale") return exactGitFacts();
  const previousSlice = inputs.slices[sliceIndex - 1];
  return featureSlicePostGit(inputs, scenario, previousSlice, promotedGit);
}

function featureWorkspaceSnapshot(workspace, git) {
  return {
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: digestValue({ git }),
    git,
  };
}

function featureTestWorkspaceSnapshot(workspace, git) {
  return {
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    fingerprint: digestValue({ git }),
  };
}

function testSelectionForInputs(inputs) {
  const identity = {
    schema: "flow.feature-test-selection/v1",
    slices: inputs.slices.filter(({ mode }) => mode === "test").map((slice) => ({
      id: slice.id,
      acceptance: [...(slice.acceptance ?? inputs.brief.acceptance)],
      intended_failure: slice.test.intended_failure,
      environment_fingerprint: slice.test.environment_fingerprint,
      environment_status: slice.test.environment_status ?? "healthy",
    })),
  };
  return {
    ...identity,
    fingerprint: digestValue(identity),
  };
}

function completeCritiqueReceipt(
  intent,
  materialized,
  critiqueEvidence,
  findings,
  overrides = {},
) {
  const delegateEvidence = materialized?.accepted_delegates?.at(-1) ?? {
    card_id: "feature-critique",
    evidence: critiqueEvidence,
  };
  const identity = {
    schema: "work.feature-critique-receipt/v1",
    delegate_evidence: overrides.delegate_evidence ?? delegateEvidence,
    findings: overrides.findings ?? findings,
    operation_contract: intent.operation_contract,
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    source_authority_watermark: intent.source_authority_watermark,
  };
  const selfDigest = digestValue(identity);
  return {
    ...identity,
    receipt_digest: selfDigest,
    self_digest: selfDigest,
  };
}

function featureDefinitionWithCritiqueId(
  critiqueCardId,
  { legacyNoResultBindings = false } = {},
) {
  const definition = createFeatureDefinition();
  const replacementCritiqueCardId = critiqueCardId ?? "feature-critique";
  if ((critiqueCardId === undefined || critiqueCardId === "feature-critique") &&
      !legacyNoResultBindings) {
    return definition;
  }
  return {
    ...definition,
    compile(selection) {
      const proposal = definition.compile(selection);
      const replaceId = (value) => value === "feature-critique"
        ? replacementCritiqueCardId
        : value;
      const replaceList = (values) => Array.isArray(values)
        ? values.map(replaceId)
        : values;
      const cards = proposal.graph.cards.map((card) => {
        const inputs = { ...card.inputs };
        for (const field of [
          "delegate_evidence_card_ids",
          "operation_evidence_card_ids",
          "test_card_ids",
        ]) {
          if (Object.hasOwn(inputs, field)) {
            inputs[field] = replaceList(inputs[field]);
          }
        }
        return {
          ...card,
          id: replaceId(card.id),
          dependencies: replaceList(card.dependencies),
          inputs,
        };
      });
      const resultBindings = proposal.graph.result_bindings?.map((binding) => ({
        ...binding,
        consumer_card_id: replaceId(binding.consumer_card_id),
        producer_card_id: replaceId(binding.producer_card_id),
      }));
      const { result_bindings: _resultBindings, ...legacyGraph } = proposal.graph;
      return {
        ...proposal,
        graph: {
          ...(legacyNoResultBindings ? legacyGraph : proposal.graph),
          cards,
          ...(legacyNoResultBindings ? {} : { result_bindings: resultBindings }),
        },
      };
    },
  };
}

async function createFeatureFailureFixture(t, scenario) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-feature-red-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const realGit = scenario.realGit ?? null;
  const startingGit = realGit?.initialGit ?? exactGitFacts();
  let promotedGit = scenario.publication?.promotedGit ?? promotedGitFacts();
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    beforeEffect: scenario.beforeEffect,
    beforeHandoffCommit: scenario.beforeHandoffCommit,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: realGit === null
      ? deterministicGitWorkspaceObservationAdapter({
          promotion: true,
          promotedGit,
        })
      : realGitWorkspaceObservationAdapter(realGit.repositoryDirectory),
    hostIdentityAdapter: fixedHostIdentity("boot-feature-red", "feature-process-red"),
    lifecycleKernel: scenario.lifecycleKernel,
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  const reviewAuthority = getReviewAuthority({ runAuthority });
  const handoffAuthority = getResourceHandoffAuthority({ runAuthority });
  let bytes = scenario.identityFree
    ? null
    : Buffer.from("feature red candidate bytes\n");
  let artifactDigest = bytes === null ? null : sha256(bytes);
  workspaceAuthority.command(realGit === null
    ? workspaceRegistration()
    : workspaceRegistrationForRealGit(realGit, startingGit));

  const applyDescription = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "feature-flow-red" },
  }, {});
  const critiqueDescription = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "feature-flow-red" },
  }, {});
  const inputs = featureInputs();
  if (scenario.mode !== undefined) inputs.mode = scenario.mode;
  if (scenario.briefAcceptance !== undefined) {
    inputs.brief.acceptance = [...scenario.briefAcceptance];
  }
  if (scenario.slices !== undefined) inputs.slices = structuredClone(scenario.slices);
  if (scenario.setup !== undefined) inputs.setup = structuredClone(scenario.setup);
  if (scenario.compensatingAssertion === true) {
    delete inputs.verification.baseline;
    inputs.verification.compensating_assertion = {
      schema: "flow.feature-compensating-assertion/v1",
      assertion: "the changed behavior remains bounded by an independent invariant",
      non_destructive: true,
      fingerprint: `sha256:${"7".repeat(64)}`,
    };
  }
  if (scenario.baselineFingerprint !== undefined) {
    inputs.verification.baseline.fingerprint = scenario.baselineFingerprint;
  }
  if (scenario.testOnlyWithoutVerification === true) {
    delete inputs.verification.baseline;
  }
  if (scenario.repair === "critique") {
    inputs.repairs = [{
      schema: "flow.feature-repair/v1",
      id: "repair:critique",
      kind: "critique",
      card_id: "feature-seal",
      acceptance: [...inputs.brief.acceptance],
      remaining_scope: ["re-run the independent critique and seal"],
      template: {
        schema: "flow.plan-revision-template/v1",
        id: "feature-repair-critique",
        trigger: {
          schema: "flow.revision-trigger/v1",
          type: "plan_revision_required",
          code: "feature_critique_repair_required",
        },
        limits: { max_applications: 1 },
        changes: {
          add_cards: [{
            id: "feature-seal-repair",
            replaces_card_id: "feature-seal",
            executor: {
              kind: "operation",
              contract: FEATURE_OPERATION_CONTRACTS.seal,
              effect_classification: "caller_idempotent",
            },
            dependencies: [],
            inputs: {
              phase: "seal",
              receipt_owner: "registered_operation",
            },
            outputs: ["review_candidate_receipt"],
            success_criteria: ["registered_operation_receipt:succeeded"],
            validators: ["flow.validator/operation-receipt/v1"],
            data_references: [inputs.brief.id],
            evidence_references: [],
            route: null,
            limits: { max_attempts: 1 },
            resource_claims: [],
            recovery: "caller_idempotent",
          }],
          add_edges: [{ from: "feature-critique", to: "feature-seal-repair" }],
          supersede_cards: ["feature-seal"],
          capability_additions: [],
          resource_additions: [],
          limit_changes: {},
        },
      },
    }];
  }
  inputs.workspace = {
    ...inputs.workspace,
    subject_id: "workspace:producer",
    fingerprint: digestValue({ git: startingGit }),
  };
  if (scenario.identityFree === true) inputs.workspace.git = startingGit;
  inputs.delegation = {
    ...inputs.delegation,
    apply: featureDelegateBindingFromDescription("apply", applyDescription),
    critique: featureDelegateBindingFromDescription(
      "critique",
      critiqueDescription,
    ),
  };
  inputs.finalization = {
    schema: "flow.feature-finalization-binding/v1",
    candidate_id: "candidate:feature",
    publication: handoffPublication(artifactDigest, scenario.publication),
  };
  if (scenario.callerCandidateId !== undefined) {
    inputs.finalization.candidate_id = scenario.callerCandidateId;
  }
  if (scenario.identityFree === true) delete inputs.finalization;
  if (scenario.capturePolicy !== undefined) {
    inputs.capture_policy = structuredClone(scenario.capturePolicy);
  }
  if (scenario.repair === "critique") {
    const baseInputs = structuredClone(inputs);
    delete baseInputs.repairs;
    const baseSelection = prepareFeatureSelection(baseInputs);
    const originalSeal = baseSelection.graph.cards.find(({ id }) =>
      id === "feature-seal");
    const originalCapture = baseSelection.graph.cards.find(({ id }) =>
      id === "feature-capture");
    const repairCard = structuredClone(originalSeal);
    repairCard.id = "feature-seal-repair";
    repairCard.replaces_card_id = "feature-seal";
    repairCard.dependencies = ["feature-critique"];
    inputs.repairs[0].template.changes.add_cards = [repairCard];
    if (scenario.identityFree === true) {
      const captureRepairCard = structuredClone(originalCapture);
      captureRepairCard.id = "feature-capture-repair";
      captureRepairCard.dependencies = ["feature-critique"];
      inputs.repairs[0].template.changes.add_cards = [
        captureRepairCard,
        repairCard,
      ];
      repairCard.dependencies = ["feature-critique", captureRepairCard.id];
      repairCard.inputs.operation_evidence_card_ids = [
        captureRepairCard.id,
        "feature-verify",
      ];
    }
  }
  if (scenario.repair === "scope") {
    const baseSelection = prepareFeatureSelection(inputs);
    const originalSeal = baseSelection.graph.cards.find(({ id }) =>
      id === "feature-seal");
    const repairTemplateId = "feature-repair-scope";
    const trigger = {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: "feature_scope_expansion_required",
    };
    const checkpointId = "feature-repair-checkpoint";
    const repairCard = {
      id: "feature-seal-repair",
      replaces_card_id: "feature-seal",
      executor: {
        kind: "operation",
        contract: FEATURE_OPERATION_CONTRACTS.seal,
        effect_classification: "caller_idempotent",
      },
      dependencies: ["feature-critique"],
      outputs: ["review_candidate_receipt"],
      success_criteria: ["registered_operation_receipt:succeeded"],
      validators: ["flow.validator/operation-receipt/v1"],
      data_references: [inputs.brief.id],
      evidence_references: [
        `flow.feature-verification-request/v1:${inputs.verification.baseline.fingerprint}`,
      ],
      route: null,
      limits: { max_attempts: 1 },
      resource_claims: [{
        kind: "workspace",
        id: inputs.workspace.subject_id,
        generation: inputs.workspace.generation,
        mutation_epoch: inputs.workspace.mutation_epoch,
        fingerprint: inputs.workspace.fingerprint,
      }],
      recovery: "caller_idempotent",
      inputs: {
        brief: inputs.brief,
        mode: inputs.mode,
        workspace: inputs.workspace,
        verification: normalizedFeatureVerificationInput(inputs),
        phase: "seal",
        finalization: inputs.finalization,
        publication: inputs.finalization.publication,
        negative_outcomes: [
          "no review, integration, push, pull request, cleanup, or tracker completion",
        ],
        receipt_owner: "registered_operation",
        delegate_output_usage: "evidence_input_only",
        delegate_evidence_card_ids: ["feature-apply", "feature-critique"],
        operation_evidence_card_ids: ["feature-capture", "feature-verify"],
        capture_policy: structuredClone(originalSeal.inputs.capture_policy),
      },
    };
    inputs.repairs = [{
      schema: "flow.feature-repair/v1",
      id: "repair:scope",
      kind: "replan",
      card_id: "feature-seal",
      acceptance: [...inputs.brief.acceptance],
      remaining_scope: ["accept the exact scope checkpoint before re-running seal"],
      scope_expansion: true,
      checkpoint_id: checkpointId,
      template: {
        schema: "flow.plan-revision-template/v1",
        id: repairTemplateId,
        trigger,
        limits: { max_applications: 1 },
        changes: {
          add_cards: [{
            id: checkpointId,
            executor: {
              kind: "checkpoint",
              contract: "flow.checkpoint/confirmation/v1",
            },
            dependencies: [],
            inputs: { prompt: "Confirm the bounded repair scope" },
            outputs: [],
            success_criteria: ["decision:approve"],
            validators: ["flow.validator/checkpoint-decision/v1"],
            data_references: [],
            evidence_references: [],
            route: null,
            limits: {},
            resource_claims: [],
            recovery: "human_decision",
          }, repairCard],
          add_edges: [{ from: checkpointId, to: repairCard.id }],
          supersede_cards: ["feature-seal"],
          capability_additions: [{
            capability: "repository:write",
            card_ids: [repairCard.id],
          }],
          resource_additions: [{ kind: "artifact", id: "repair-output" }],
          limit_changes: {},
        },
      },
    }];
  }
  const facts = featureFactsForInputs(inputs);
  if (scenario.repair === "critique") {
    facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
    facts.validator_contracts.push("flow.validator/card-block-observation/v1");
    Object.assign(facts.limits, {
      max_revisions: 1,
      max_cards_per_revision: scenario.identityFree === true ? 2 : 1,
    });
    facts.block_observations.push(observeCardBlock({
      card_id: "feature-seal",
      block: {
        schema: "flow.card-block/v1",
        id: "feature-seal:critique-repair",
        type: "plan_revision_required",
        trigger: inputs.repairs[0].template.trigger,
        required_capabilities: [],
        revision_template_ids: ["feature-repair-critique"],
      },
    }));
  }
  if (scenario.repair === "scope") {
    facts.operation_contracts.push("flow.adapter/card-block-observation/v1");
    facts.validator_contracts.push("flow.validator/card-block-observation/v1");
    facts.capability_envelopes.push("repository:write");
    Object.assign(facts.limits, {
      max_revisions: 1,
      max_cards_per_revision: 2,
      max_capabilities: 1,
    });
    facts.block_observations.push(observeCardBlock({
      card_id: "feature-seal",
      block: {
        schema: "flow.card-block/v1",
        id: "feature-seal:scope-repair",
        type: "plan_revision_required",
        trigger: inputs.repairs[0].template.trigger,
        required_capabilities: [],
        revision_template_ids: ["feature-repair-scope"],
      },
    }));
  }
  const authorityState = shippedAuthorityStateFromFacts(facts);
  const registeredAuthorities = shippedAuthorityRegistrations({
    current: authorityState,
  });

  let verifyReceipt = null;
  let captureReceipt = null;
  let critiqueEvidence = null;
  let delegateDispatches = 0;
  let testInvocations = 0;
  let captureOperation = null;
  const sealIntents = [];
  const turnRecords = new Map();
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    async describe() {},
    async send() {},
    async observe() {},
    async cancel() {},
    async reconcile() {},
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      delegateDispatches += 1;
      const role = request.agent_id.includes("apply") ? "apply" : "critique";
      const turnId = `turn:feature-red-${role}`;
      turnRecords.set(turnId, {
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        output: scenario.forgedDelegateSelfReport
          ? `${role} verification passed accepted`
          : `${role} accepted`,
        prompt: request.prompt,
      });
      return workingProjection(request, turnId);
    },
    async wait(request) {
      const record = turnRecords.get(request.turn_id);
      return completedTurnProjection({
        agentId: record.agentId,
        callerKey: record.callerKey,
        description: record.description,
        output: record.output,
        prompt: record.prompt,
        turnId: request.turn_id,
      });
    },
    async retire(request) {
      return retiredProjection(request);
    },
  };
  const runtime = createFlowRuntime({
    runAuthority,
    registeredAuthorities,
    delegatedAgentPort,
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output.endsWith("accepted");
        },
      },
    },
    registeredOperations: {
      [FEATURE_OPERATION_CONTRACTS.capture]: captureOperation = createFeatureCaptureOperation({
        async observe(intent) {
          if (scenario.capturePending === true) {
            await new Promise((resolve) => {
              scenario.releaseCapture = resolve;
            });
          }
          if (realGit !== null) {
            const captured = realGit.captureAfterLaunch();
            promotedGit = captured.git;
            bytes = captured.bytes;
            artifactDigest = sha256(bytes);
          }
          if (bytes === null) {
            bytes = Buffer.from("post-launch feature red candidate bytes\n");
            artifactDigest = sha256(bytes);
          }
          const artifact = {
            artifact_schema: "example.candidate/v1",
            digest: artifactDigest,
            size: bytes.length,
          };
          captureReceipt = featureCaptureReceipt(intent, inputs, {
            git: promotedGit,
            generation: scenario.captureGeneration ?? 2,
            mutationEpoch: scenario.captureMutationEpoch ?? 8,
            artifacts: [artifact],
          });
          return {
            receipt: captureReceipt,
            artifacts: [{
              artifact_schema: artifact.artifact_schema,
              bytes,
            }],
          };
        },
        storeArtifacts({ intent, artifacts }) {
          for (const artifact of artifacts) {
            const stored = artifactAuthority.command(artifactRegistration(
              artifact.bytes,
              artifact.digest,
              intent.run_id,
            ));
            if (stored.accepted !== true) return stored;
          }
          if (scenario.captureCrashAfterStorage === true &&
              scenario.captureCrashTriggered !== true) {
            scenario.captureCrashTriggered = true;
            runAuthority.close();
          }
          return { accepted: true };
        },
      }),
      [FEATURE_OPERATION_CONTRACTS.setup]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          return operationReceipt(intent, {
            schema: "work.feature-setup-receipt/v1",
            setup_id: intent.operation_input.setup.id,
            evidence_role: intent.operation_input.evidence_role,
          });
        },
      },
      [FEATURE_OPERATION_CONTRACTS.test]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        provider_receipt_validator: FEATURE_TEST_RECEIPT_VALIDATOR,
        validateReceipt: validateFeatureTestReceipt,
        invoke(intent) {
          testInvocations += 1;
          if (scenario.testReceiptMode === "missing") {
            return operationReceipt(intent, null);
          }
          if (scenario.testReceiptMode === "throw" &&
              !scenario.testReceiptRecovered) {
            scenario.testReceiptRecovered = true;
            throw new Error("test environment became unavailable");
          }
          const slice = intent.operation_input.slice;
          const slicePreGit = featureSlicePreGit(
            inputs,
            scenario,
            slice,
            promotedGit,
          );
          const providerReceipt = {
            attempt_id: intent.attempt_id,
            effect_id: intent.effect_id,
            idempotency_key: intent.idempotency_key,
            schema: "work.feature-test-receipt/v1",
            slice_id: slice.id,
            phase: intent.operation_input.phase,
            outcome: "expected_failure",
            intended_failure: slice.test.intended_failure,
            environment_status: slice.test.environment_status,
            environment_fingerprint: slice.test.environment_fingerprint,
            operation_contract: intent.operation_contract,
            source_authority_watermark: intent.source_authority_watermark,
            workspace: featureTestWorkspaceSnapshot(
              intent.operation_input.workspace,
              slicePreGit,
            ),
          };
          if (scenario.testReceiptMode === "unrelated") {
            providerReceipt.intended_failure =
              "an unrelated failure from another behavior";
          }
          if (scenario.testReceiptMode === "broken_environment") {
            providerReceipt.environment_status = "broken";
          }
          if (scenario.testReceiptMode === "stale_epoch") {
            providerReceipt.workspace.mutation_epoch -= 1;
          }
          if (scenario.testReceiptMode === "setup_only") {
            providerReceipt.schema = "work.feature-setup-receipt/v1";
          }
          const receipt = operationReceipt(intent, providerReceipt);
          return receipt;
        },
      },
      [FEATURE_OPERATION_CONTRACTS.verify]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
        validateReceipt: validateFeatureVerificationReceipt,
        invoke(intent) {
          if (scenario.verifyReceiptMode === "absent") return undefined;
          if (intent.operation_input.phase === "slice_verify" &&
              scenario.sliceVerifyReceiptMode === "missing") {
            return operationReceipt(intent, null);
          }
          if (scenario.verifyReceiptMode === "invalid") {
            return operationReceipt(intent, { schema: "invalid" });
          }
          const sliceVerify = intent.operation_input.phase === "slice_verify";
          const sliceMode = sliceVerify ? scenario.sliceVerifyReceiptMode : null;
          const discriminatorMode = sliceVerify
            ? scenario.sliceDiscriminatorMode
            : null;
          const slice = intent.operation_input.slice;
          const slicePostGit = sliceVerify
            ? featureSlicePostGit(inputs, scenario, slice, promotedGit)
            : promotedGit;
          const staleWorkspace = sliceMode === "stale_epoch"
            ? {
                subject_id: inputs.workspace.subject_id,
                generation: inputs.workspace.generation,
                mutation_epoch: inputs.workspace.mutation_epoch - 1,
                fingerprint: digestValue({ git: promotedGitFacts() }),
                git: promotedGitFacts(),
              }
            : undefined;
          const providerReceipt = completeVerificationReceipt(
            intent,
            inputs,
            {
              ...scenario.verification,
              ...(realGit === null ? {} : {
                workspace: featureWorkspaceSnapshot(inputs.workspace, promotedGit),
              }),
              ...(sliceVerify && staleWorkspace === undefined ? {
                workspace: featureWorkspaceSnapshot(
                  inputs.workspace,
                  slicePostGit,
                ),
              } : {}),
              ...(staleWorkspace === undefined ? {} : {
                workspace: staleWorkspace,
              }),
              ...(sliceMode === "missing_verdict" ? {
                missing_verdicts: [slice.acceptance[0]],
              } : {}),
              ...(sliceMode === "wrong_acceptance" ? {
                criteria: inputs.brief.acceptance,
              } : {}),
            },
            intent.operation_input.authority_materialized_evidence,
          );
          if (sliceMode === "wrong_operation") {
            providerReceipt.operation_contract = FEATURE_OPERATION_CONTRACTS.test;
          }
          if (sliceMode === "setup_only") {
            providerReceipt.schema = "work.feature-setup-receipt/v1";
          }
          if (discriminatorMode === "missing_discriminator") {
            delete providerReceipt.discriminating_evidence;
          }
          if (discriminatorMode === "malformed_discriminator") {
            providerReceipt.discriminating_evidence = {
              schema: "flow.feature-discriminating-evidence/v1",
              kind: "unknown",
            };
          }
          if (discriminatorMode === "undistinguished_discriminator") {
            providerReceipt.discriminating_evidence.distinguished = false;
          }
          if (discriminatorMode === "stale_discriminator") {
            providerReceipt.discriminating_evidence.post_mutation_fingerprint =
              `sha256:${"8".repeat(64)}`;
          }
          if (discriminatorMode?.endsWith("_discriminator")) {
            const {
              receipt_digest: _receiptDigest,
              self_digest: _selfDigest,
              ...identity
            } = providerReceipt;
            const selfDigest = digestValue(identity);
            providerReceipt.receipt_digest = selfDigest;
            providerReceipt.self_digest = selfDigest;
          }
          verifyReceipt = operationReceipt(intent, providerReceipt);
          return verifyReceipt;
        },
      },
      [FEATURE_OPERATION_CONTRACTS.seal]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          sealIntents.push(structuredClone(intent));
          const materialized = intent.operation_input
            .authority_materialized_evidence;
          const publication = intent.operation_input.finalization.publication;
          const verification = materialized?.verify_receipt?.receipt
              ?.provider_receipt ??
            materialized?.verify_receipt?.provider_receipt ??
            verifyReceipt?.provider_receipt;
          const critique = completeCritiqueReceipt(
            intent,
            materialized,
            critiqueEvidence,
            scenario.critiqueFindings ?? [],
            scenario.forgeCritiqueAsApply === true
              ? {
                  delegate_evidence: materialized?.accepted_delegates?.find(
                    ({ card_id: cardId }) => cardId === "feature-apply",
                  ),
                }
              : {},
          );
          const candidateView = intent.operation_input.authority_materialized_candidate;
          realGit?.beforeSeal?.({
            artifactDigest,
            authorityDirectory,
          });
          const candidateGit = candidateView?.git ??
            publication.workspace.promoted_git;
          const retention = gitRetentionReceipt(candidateGit, realGit?.repositoryId);
          const candidateIdentity = {
            schema: "work.review-candidate/v1",
            candidate_id: candidateView?.candidate_id ?? "candidate:feature",
            git: candidateGit,
            workspace: {
              contract: "work.workspace/v1",
              subject_id: publication.workspace.subject_id,
              generation: publication.workspace.promoted_generation,
              mutation_epoch: publication.workspace.promoted_mutation_epoch,
              fingerprint: digestValue({ git: candidateGit }),
            },
            verification,
            critique,
            artifacts: candidateView?.artifacts ?? [{
              digest: artifactDigest,
              generation: 1,
              artifact_schema: "example.candidate/v1",
            }],
            git_retention: retention,
          };
          const candidate = {
            ...candidateIdentity,
            candidate_fingerprint: digestValue(candidateIdentity),
          };
          return operationReceipt(intent, {
            schema: "flow.feature-seal-receipt/v1",
            ...(scenario.omitReviewCandidate ? {} : {
              review_candidate: candidate,
            }),
            publication_digest: digestValue(publication),
            git_retention: retention,
          });
        },
      },
    },
    registeredAuthorities,
    predefinedDefinitions: {
      "feature/v1": featureDefinitionWithCritiqueId(scenario.critiqueCardId, {
        legacyNoResultBindings: scenario.legacyNoResultBindings === true,
      }),
    },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs,
    explicit_facts: facts,
  });
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.created, true, JSON.stringify(launch));
  const registeredWorkspace = workspaceAuthority.query(workspaceQuery());
  const workspaceOperations = prepared.graph.cards
    .concat(prepared.revision_templates.flatMap(({ changes }) => changes.add_cards))
    .filter(({ resource_claims: resourceClaims }) => resourceClaims.some(({ kind }) =>
      kind === "workspace"))
    .map(({ id }) => id);
  assert.equal(workspaceAuthority.command(workspaceClaim({
    expectedWatermark: registeredWorkspace.watermark,
    expectedFingerprint: digestValue({ git: startingGit }),
    holder: scenario.workspaceClaimHolder ?? launch.run_id,
    operations: [...workspaceOperations, "handoff_publication"],
  })).accepted, true);
  return {
    artifactAuthority,
    artifactDigest,
    authorityDirectory,
    authorityState,
    captureOperation,
    prepared,
    handoffAuthority,
    inputs,
    facts,
    registeredAuthorities,
    reviewAuthority,
    runId: launch.run_id,
    runAuthority,
    runtime,
    sealIntents,
    delegateDispatches() {
      return delegateDispatches;
    },
    testInvocations() {
      return testInvocations;
    },
    setCritiqueEvidence(evidence) {
      critiqueEvidence = evidence;
    },
    setTestReceiptMode(mode) {
      scenario.testReceiptMode = mode;
    },
    captureReceipt() {
      return captureReceipt;
    },
    releaseCapture() {
      scenario.releaseCapture?.();
    },
    currentArtifactDigest() {
      return artifactDigest;
    },
    promotedGit() {
      return promotedGit;
    },
    realGit,
    workspaceAuthority,
  };
}

async function driveFeatureToSeal(fixture, {
  allowSealRefusal = false,
  critiqueCardId = "feature-critique",
} = {}) {
  const { runId, runtime } = fixture;
  executeCard(runtime, runId, "delegate_execute", "feature-apply");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  const captureAction = runtime.query({ run_id: runId }).legal_actions.find(
    ({ type, card_id: cardId }) =>
      type === "operation_execute" && cardId === "feature-capture",
  );
  if (captureAction) {
    const captureCommand = runtime.command(captureAction);
    assert.equal(captureCommand.accepted, true, JSON.stringify(captureCommand));
    await settleFeatureEffect(runtime, runId, "feature-capture");
  }
  executeCard(runtime, runId, "operation_execute", "feature-verify");
  await settleFeatureEffect(runtime, runId, "feature-verify");
  let projection = runtime.query({ run_id: runId });
  if (projection.effects.find(({ card_id: cardId }) => cardId === "feature-verify")
    ?.status !== "succeeded") return;
  executeCard(runtime, runId, "delegate_execute", critiqueCardId);
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === critiqueCardId && status === "succeeded",
  ));
  projection = runtime.query({ run_id: runId });
  fixture.critiqueEvidence = projection.delegate_attempts.find(
    ({ card_id: cardId }) => cardId === critiqueCardId,
  )?.evidence ?? null;
  fixture.setCritiqueEvidence(fixture.critiqueEvidence);
  const sealAction = projection.legal_actions.find(({ type, card_id: cardId }) =>
    type === "operation_execute" && cardId === "feature-seal");
  if (!sealAction) return;
  const result = runtime.command(sealAction);
  if (result.accepted !== true) return;
  if (allowSealRefusal) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return;
  }
  await until(() => {
    const current = runtime.query({ run_id: runId });
    const effect = current.effects.find(({ card_id: cardId }) =>
      cardId === "feature-seal");
    return current.phase !== "active" || effect?.invocation_started === true;
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
}

async function driveSerializedFeatureToSeal(
  fixture,
  { allowSealRefusal = false } = {},
) {
  const { runId, runtime } = fixture;
  const order = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = runtime.query({ run_id: runId });
    if (projection.phase === "succeeded") return order;
    const action = projection.legal_actions.find(({ type }) =>
      ["operation_execute", "delegate_execute"].includes(type));
    assert.ok(action, `serialized feature should expose a runnable action: ${
      JSON.stringify(projection.legal_actions)}`);
    assert.equal(action.expected_watermark, projection.watermark);
    const result = runtime.command(action);
    order.push(action.card_id);
    if (result.accepted !== true) return order;
    if (allowSealRefusal && action.card_id === "feature-seal") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = runtime.query({ run_id: runId });
    if (current.effects.find(({ card_id: cardId }) => cardId === action.card_id)
      ?.status !== "succeeded") return order;
    for (const legalAction of current.legal_actions) {
      assert.equal(legalAction.expected_watermark, current.watermark);
    }
    if (action.card_id === "feature-critique") {
      fixture.critiqueEvidence = current.delegate_attempts.find(
        ({ card_id: cardId }) => cardId === "feature-critique",
      )?.evidence ?? null;
      fixture.setCritiqueEvidence(fixture.critiqueEvidence);
    }
  }
  assert.fail("serialized feature did not reach its terminal candidate");
}

async function driveUntilTestReceiptBlocked(fixture) {
  const { runId, runtime } = fixture;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const projection = runtime.query({ run_id: runId });
    const action = projection.legal_actions.find(({ type }) =>
      ["operation_execute", "delegate_execute"].includes(type));
    assert.ok(action, `test slice should expose a runnable action: ${
      JSON.stringify(projection.legal_actions)}`);
    const result = runtime.command(action);
    assert.equal(result.accepted, true, JSON.stringify(result));
    if (action.card_id.endsWith("-test")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return runtime.query({ run_id: runId });
    }
    await until(() => runtime.query({ run_id: runId }).effects.some(
      ({ card_id: cardId, status }) =>
        cardId === action.card_id && status === "succeeded",
    ));
  }
  assert.fail("serialized feature did not reach its test slice");
}

async function settleFeatureEffect(runtime, runId, cardId) {
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: effectCardId, status, invocation_started: invocationStarted }) =>
      effectCardId === cardId && (status === "succeeded" || invocationStarted),
  ));
  await new Promise((resolve) => setTimeout(resolve, 75));
}

function operationReceipt(intent, providerReceipt) {
  return {
    schema: "flow.effect-receipt/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    outcome: "succeeded",
    provider_receipt: providerReceipt,
  };
}

function executeCard(runtime, runId, type, cardId) {
  const action = runtime.query({ run_id: runId }).legal_actions.find((candidate) =>
    candidate.type === type && candidate.card_id === cardId);
  assert.ok(action, `${type} ${cardId} should be actionable`);
  const receipt = runtime.command(action);
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
}

function confirmedPredefinedLaunchRequest(prepared) {
  return {
    prepared,
    confirmation: {
      schema: "flow.predefined-flow-confirmation-decision/v1",
      decision: "accept",
      bundle_digest: prepared.bundle_digest,
      confirmation_digest: prepared.confirmation_digest,
    },
    closed_facts: {
      schema: "flow.closed-fact-observation/v1",
      bundle_digest: prepared.bundle_digest,
      facts: structuredClone(prepared.explicit_facts),
    },
  };
}

function absentDiscovery() {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "proven_absent",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: `sha256:${"0".repeat(64)}`,
    },
    delegation: null,
    turn: null,
    legal_next_actions: ["dispatch_exact_turn"],
  };
}

function workingProjection(request, turnId) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: "working",
    watermark: absentDiscovery().watermark,
    delegation: {
      agent_id: request.agent_id,
      task_id: `task:${request.agent_id}`,
      group_id: "group:feature-flow",
    },
    turn: { id: turnId, status: "working" },
    legal_next_actions: ["wait_bounded"],
  };
}

function retiredProjection(request) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "retire",
    status: "retired",
    watermark: {
      schema: "drovr.agent-authority-watermark/v1",
      authority: "drovr.registry",
      agent_id: request.agent_id,
      record_sha256: digestValue(request.agent_id),
    },
    delegation: {
      agent_id: request.agent_id,
      task_id: `task:${request.agent_id}`,
      group_id: "group:feature-flow",
    },
    turn: null,
    legal_next_actions: [],
  };
}

function workspaceRegistration() {
  return {
    schema: "work.workspace-register-command/v1",
    command_id: "workspace-register:feature",
    type: "workspace_register",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_generation: 0,
    registration: {
      repository: { canonical_id: "github.com/Seavenly/example" },
      workspace: {
        canonical_id: "workspace:producer",
        canonical_path: "/tmp/feature-worktree",
      },
      git: exactGitFacts(),
      mutation_epoch: 7,
      disposition: "producer_owned",
    },
  };
}

function workspaceRegistrationForRealGit(realGit, git) {
  const registration = workspaceRegistration();
  return {
    ...registration,
    registration: {
      ...registration.registration,
      repository: {
        canonical_id: realGit.repositoryId,
      },
      workspace: {
        ...registration.registration.workspace,
        canonical_path: realGit.repositoryDirectory,
      },
      git,
    },
  };
}

async function createRealGitScenario(t) {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), "flow-real-git-"));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  runGitSync(repositoryDirectory, ["init", "--initial-branch", "ticket/feature"]);
  runGitSync(repositoryDirectory, ["config", "user.email", "flow@example.invalid"]);
  runGitSync(repositoryDirectory, ["config", "user.name", "Flow Test"]);
  writeFileSync(join(repositoryDirectory, "feature.txt"), "before\n");
  runGitSync(repositoryDirectory, ["add", "--", "feature.txt"]);
  runGitSync(repositoryDirectory, ["commit", "--message", "initial"]);
  const initialGit = realGitFactsSync(repositoryDirectory);
  const scenario = {
    repositoryDirectory,
    repositoryId: `local:${repositoryDirectory}`,
    initialGit,
    candidateGit: null,
    candidateBytes: null,
    captureCount: 0,
    captureAfterLaunch() {
      assert.equal(this.captureCount, 0, "capture must settle exactly once");
      this.captureCount += 1;
      writeFileSync(join(repositoryDirectory, "feature.txt"), "after\n");
      runGitSync(repositoryDirectory, ["add", "--", "feature.txt"]);
      runGitSync(repositoryDirectory, ["commit", "--message", "candidate"]);
      this.candidateBytes = Buffer.from("real feature candidate bytes\n");
      this.candidateGit = realGitFactsSync(repositoryDirectory);
      return {
        git: this.candidateGit,
        bytes: this.candidateBytes,
      };
    },
  };
  return scenario;
}

function realGitWorkspaceObservationAdapter(repositoryDirectory) {
  return {
    observe() {
      return {
        schema: "work.git-observation/v1",
        git: realGitFactsSync(repositoryDirectory),
      };
    },
  };
}

function realGitFactsSync(repositoryDirectory) {
  const commitSha = runGitSync(repositoryDirectory, ["rev-parse", "HEAD"]);
  const treeSha = runGitSync(repositoryDirectory, ["rev-parse", "HEAD^{tree}"]);
  const ref = runGitSync(repositoryDirectory, ["symbolic-ref", "--quiet", "HEAD"]);
  const status = runGitSync(repositoryDirectory, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return {
    commit_sha: commitSha,
    tree_sha: treeSha,
    ref,
    clean: status.length === 0,
  };
}

function runGitSync(repositoryDirectory, args) {
  return execFileSync("git", args, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function workspaceQuery() {
  return {
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
  };
}

function workspaceClaim({
  expectedWatermark,
  expectedFingerprint,
  holder,
  operations,
}) {
  return {
    schema: "work.workspace-claim-command/v1",
    command_id: `workspace-claim:${holder}`,
    type: "workspace_claim",
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    expected_generation: 1,
    expected_watermark: expectedWatermark,
    expected_fingerprint: expectedFingerprint,
    claim: {
      claim_id: `claim:${holder}`,
      holder,
      operations,
    },
  };
}

function artifactRegistration(bytes, artifactDigest, producerRunId) {
  return {
    schema: "work.artifact-record-command/v1",
    command_id: `artifact-record:${artifactDigest}`,
    type: "artifact_record",
    contract: "work.artifact/v1",
    subject_id: artifactDigest,
    expected_generation: 0,
    artifact: {
      digest: artifactDigest,
      artifact_schema: "example.candidate/v1",
      size: bytes.length,
      provenance: {
        producer: { run_id: producerRunId, evidence: "sha256:producer" },
        validator: {
          contract: "example.validator/v1",
          receipt: "sha256:validator",
        },
      },
      classification: "internal",
      retention: "durable_handoff",
      pins: [{ holder: "run", id: producerRunId }],
    },
    bytes_base64: bytes.toString("base64"),
  };
}

function handoffPublication(artifactDigest, options = {}) {
  const {
    expectedGeneration = 1,
    expectedMutationEpoch = 7,
    expectedGit = exactGitFacts(),
    promotedGeneration = 2,
    promotedMutationEpoch = 8,
    promotedGit = promotedGitFacts(),
    disposition = "retained_for_handoff",
  } = options;
  return {
    schema: "flow.resource-handoff-publication/v1",
    workspace: {
      subject_id: "workspace:producer",
      expected_generation: expectedGeneration,
      expected_mutation_epoch: expectedMutationEpoch,
      expected_git: expectedGit,
      promoted_generation: promotedGeneration,
      promoted_mutation_epoch: promotedMutationEpoch,
      promoted_git: promotedGit,
      disposition,
    },
    artifacts: [{ digest: artifactDigest, expected_generation: 1 }],
    subject: {
      contract: "work.workspace/v1",
      subject_id: "workspace:producer",
    },
    allowed_consumer_operations: ["read_workspace"],
    consumer_operation_authority: [{
      operation: "read_workspace",
      access: "read_only",
    }],
    authority_envelope: { capabilities: ["repository:read"] },
    retention: "durable_handoff",
    cleanup_obligations: ["retain_artifact_bytes"],
    intended_consumer: null,
  };
}

function deterministicGitRetentionAdapter() {
  return {
    observe(receipt) {
      return {
        schema: "flow.git-retention-observation/v1",
        available: true,
        repository_id: receipt.repository_id,
        commit_sha: receipt.commit_sha,
        tree_sha: receipt.tree_sha,
        retention_ref: receipt.retention_ref,
      };
    },
  };
}

function deterministicGitWorkspaceObservationAdapter({
  promotion = false,
  promotedGit = promotedGitFacts(),
} = {}) {
  return {
    observe({ ref } = {}) {
      return {
        schema: "work.git-observation/v1",
        git: promotion && ref === promotedGit.ref
          ? promotedGit
          : exactGitFacts(),
      };
    },
  };
}

function fixedHostIdentity(bootId, processIdentity) {
  return {
    observe() {
      return {
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: processIdentity,
      };
    },
  };
}

function exactGitFacts() {
  return {
    commit_sha: "1".repeat(40),
    tree_sha: "2".repeat(40),
    ref: "refs/heads/ticket/feature",
    clean: true,
  };
}

function promotedGitFacts() {
  return {
    commit_sha: "3".repeat(40),
    tree_sha: "4".repeat(40),
    ref: "refs/heads/ticket/feature-promoted",
    clean: true,
  };
}

function intermediateGitFacts() {
  return {
    commit_sha: "5".repeat(40),
    tree_sha: "6".repeat(40),
    ref: "refs/heads/ticket/feature-intermediate",
    clean: true,
  };
}

function gitRetentionReceipt(git, repositoryId = "github.com/Seavenly/example") {
  return {
    schema: "flow.git-retention-receipt/v1",
    repository_id: repositoryId,
    commit_sha: git.commit_sha,
    tree_sha: git.tree_sha,
    retention_ref: `refs/flow/review/${git.commit_sha}`,
  };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestValue(value) {
  return digest(value);
}

function featureReviewTargetObservationAdapter() {
  return {
    movement_shapes: ["fingerprint_only", "generation_only", "combined"],
    observe({ command, review }) {
      return buildReviewTargetObservation({
        subjectId: command.subject_id,
        candidateId: review?.candidate?.candidate_id ?? "candidate:feature",
        candidateFingerprint: command.observed_candidate_fingerprint,
        lifecycleGeneration: command.observed_lifecycle_generation,
        authorityWatermark: digestValue("feature-review-target-observation"),
        source: "named_mechanism_observation",
      });
    },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

function featureInputs() {
  return {
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:example",
      summary: "Add an observable feature",
      acceptance: ["the changed behavior is observable"],
    },
    mode: "verify",
    workspace: {
      schema: "flow.feature-workspace-binding/v1",
      subject_id: "workspace:producer",
      generation: 1,
      mutation_epoch: 7,
      fingerprint: digestValue({ git: exactGitFacts() }),
    },
    verification: {
      schema: "flow.feature-verification-request/v1",
      baseline: {
        schema: "flow.feature-safe-baseline/v1",
        assertion: "the behavior is absent before the change",
        fingerprint: `sha256:${"3".repeat(64)}`,
      },
    },
    finalization: {
      schema: "flow.feature-finalization-binding/v1",
      candidate_id: "candidate:feature",
      publication: handoffPublication(`sha256:${"6".repeat(64)}`),
    },
    delegation: {
      schema: "flow.feature-delegation-bindings/v1",
      apply: featureDelegateBinding("apply", "1", "3", "5"),
      critique: featureDelegateBinding("critique", "2", "4", "6"),
    },
  };
}

function normalizedFeatureVerificationInput(inputs) {
  const evidence = inputs.verification.baseline ??
    inputs.verification.compensating_assertion;
  return {
    ...inputs.verification,
    evidence_id: `${inputs.verification.schema}:${evidence.fingerprint}`,
  };
}

function prepareFeatureSelection(
  inputs,
  explicitFacts = null,
  flowRuntime = undefined,
) {
  const facts = explicitFacts ?? featureFactsForInputs(inputs);
  const runtime = flowRuntime ?? featurePreparationRuntime(
    createInMemoryRunAuthority(),
    facts,
  );
  return runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs,
    explicit_facts: facts,
  });
}

function featurePreparationRuntime(
  runAuthority = createInMemoryRunAuthority(),
  explicitFacts = dynamicCheckpointProposal().explicit_facts,
) {
  const captureOperation = createFeatureCaptureOperation({
    observe() {
      return undefined;
    },
    storeArtifacts() {
      return { accepted: true };
    },
  });
  return createFlowRuntime({
    runAuthority,
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      async describe() {},
      async send() {},
      async observe() {},
      async cancel() {},
      async reconcile() {},
      async discover() {
        return absentDiscovery();
      },
      async dispatch() {
        throw new Error("feature preparation runtime does not dispatch delegates");
      },
      async wait() {
        throw new Error("feature preparation runtime does not wait delegates");
      },
      async retire() {
        throw new Error("feature preparation runtime does not retire delegates");
      },
    },
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate() {
          return true;
        },
      },
    },
    registeredOperations: Object.fromEntries(
      Object.values(FEATURE_OPERATION_CONTRACTS).map((contract) => [
        contract,
        contract === FEATURE_OPERATION_CONTRACTS.capture
          ? captureOperation
          : {
              classification: "caller_idempotent",
              ...(contract === FEATURE_OPERATION_CONTRACTS.test ? {
                provider_receipt_validator: FEATURE_TEST_RECEIPT_VALIDATOR,
                validateReceipt: validateFeatureTestReceipt,
              } : {}),
              ...(contract === FEATURE_OPERATION_CONTRACTS.verify ? {
                provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
                validateReceipt: validateFeatureVerificationReceipt,
              } : {}),
              invoke() {
                throw new Error(
                  "feature operations are not invoked during preparation",
                );
              },
            },
      ]),
    ),
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(explicitFacts),
    }),
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
    },
  });
}

function featurePreparationOperations() {
  return Object.fromEntries(
    Object.values(FEATURE_OPERATION_CONTRACTS).map((contract) => [contract, {
      classification: contract === FEATURE_OPERATION_CONTRACTS.capture
        ? "reconcilable"
        : "caller_idempotent",
      ...(contract === FEATURE_OPERATION_CONTRACTS.test ? {
        provider_receipt_validator: FEATURE_TEST_RECEIPT_VALIDATOR,
        validateReceipt: validateFeatureTestReceipt,
      } : {}),
      ...(contract === FEATURE_OPERATION_CONTRACTS.capture ? {
        provider_receipt_validator: FEATURE_CAPTURE_RECEIPT_VALIDATOR,
        validateReceipt: validateFeatureCaptureReceipt,
      } : {}),
      ...(contract === FEATURE_OPERATION_CONTRACTS.verify ? {
        provider_receipt_validator: FEATURE_VERIFICATION_RECEIPT_VALIDATOR,
        validateReceipt: validateFeatureVerificationReceipt,
      } : {}),
      ...(contract === FEATURE_OPERATION_CONTRACTS.capture ? {
        observe() {
          return undefined;
        },
      } : {}),
      invoke() {
        throw new Error("feature operations are not invoked during preparation");
      },
    }]),
  );
}

function featureFactsForInputs(inputs) {
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.operation_contracts = Object.values(FEATURE_OPERATION_CONTRACTS);
  facts.validator_contracts.push("flow.validator/operation-receipt/v1");
  facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_CAPTURE_RECEIPT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_TEST_RECEIPT_VALIDATOR);
  facts.validator_contracts.push(FEATURE_VERIFICATION_RECEIPT_VALIDATOR);
  facts.resource_claims.push({
    kind: "workspace",
    id: inputs.workspace.subject_id,
    generation: inputs.workspace.generation,
    mutation_epoch: inputs.workspace.mutation_epoch,
    fingerprint: inputs.workspace.fingerprint,
  });
  const slices = inputs.slices ?? [];
  const serializedCardCount = slices.reduce(
    (count, slice) => count + 3 + (slice.mode === "test" ? 1 : 0),
    4 + (inputs.setup === undefined ? 0 : 1),
  );
  facts.limits.max_cards = Math.max(8, serializedCardCount);
  facts.limits.max_resources = 4;
  return facts;
}

function featureDelegateBinding(role, launchByte, authorityByte, watermarkByte) {
  const descriptionIdentity = {
    schema: "drovr.delegated-agent-description/v1",
    comparison_keys: {
      launch: `sha256:${launchByte.repeat(64)}`,
      effective_authority: `sha256:${authorityByte.repeat(64)}`,
    },
    watermark: {
      content_sha256: `sha256:${watermarkByte.repeat(64)}`,
    },
  };
  const description = {
    ...descriptionIdentity,
    description_digest: digest(descriptionIdentity),
  };
  return {
    description,
    route: {
      agent_id: `agent:feature-${role}`,
      configuration_watermark: description.watermark.content_sha256,
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    },
    validators: [DELEGATE_OUTPUT_VALIDATOR],
  };
}

function downstreamClosure(cards, rootId) {
  const closure = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const card of cards) {
      if (!closure.has(card.id) && card.dependencies.some((id) => closure.has(id))) {
        closure.add(card.id);
        changed = true;
      }
    }
  }
  return cards.filter(({ id }) => closure.has(id));
}

function rebindFeatureCardInputs(inputs, replacements) {
  const rebound = structuredClone(inputs ?? {});
  for (const field of [
    "delegate_evidence_card_ids",
    "operation_evidence_card_ids",
    "test_card_ids",
    "setup_card_id",
    "mutation_owner",
  ]) {
    if (Array.isArray(rebound[field])) {
      rebound[field] = rebound[field].map((id) => replacements.get(id) ?? id);
    } else if (typeof rebound[field] === "string") {
      rebound[field] = replacements.get(rebound[field]) ?? rebound[field];
    }
  }
  return rebound;
}

function rebindFeatureManagedAgent(binding, replacements) {
  return {
    ...binding,
    card_ids: binding.card_ids.map((id) => replacements.get(id) ?? id),
    terminal_card_id: replacements.get(binding.terminal_card_id) ??
      binding.terminal_card_id,
  };
}

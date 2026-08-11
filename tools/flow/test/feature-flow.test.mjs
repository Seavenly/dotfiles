import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createFeatureDefinition,
  FEATURE_OPERATION_CONTRACTS,
} from "../src/feature-flow.mjs";
import { createDurableRunAuthority, createInMemoryRunAuthority } from
  "../src/run-authority.mjs";
import {
  getArtifactAuthority,
  getResourceHandoffAuthority,
  getReviewAuthority,
  getWorkspaceAuthority,
} from "../src/work-authority.mjs";
import { completedTurnProjection } from "../test-support/delegate-card.mjs";
import {
  dynamicCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import { supportedDescription } from
  "../test-support/delegated-agent-description.mjs";

const DELEGATE_OUTPUT_VALIDATOR =
  "flow.validator/delegate-output-conformance/v1";

test("feature/v1 verify selection prepares an honest candidate plan", () => {
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.operation_contracts = Object.values(FEATURE_OPERATION_CONTRACTS);
  facts.validator_contracts.push("flow.validator/operation-receipt/v1");
  facts.validator_contracts.push("flow.validator/feature-evidence/v1");
  facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
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
    registeredOperations: Object.fromEntries(
      Object.values(FEATURE_OPERATION_CONTRACTS).map((contract) => [contract, {
        classification: "caller_idempotent",
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
  assert.equal(
    prepared.trust_posture.delegation,
    "bounded_implementation_and_independent_critique_only",
  );
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  assert.equal(cards.get("feature-apply").executor.kind, "delegate");
  assert.equal(cards.get("feature-critique").executor.kind, "delegate");
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
  assert.deepEqual(cards.get("feature-seal").inputs.delegate_evidence_card_ids, [
    "feature-apply",
    "feature-critique",
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

test("feature/v1 is verify-only and requires one explicit non-destructive assertion", () => {
  const testMode = featureInputs();
  testMode.mode = "test";
  assert.throws(
    () => prepareFeatureSelection(testMode),
    /mode must be verify/,
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

test("feature/v1 verify rejects an unchanged promoted workspace", () => {
  const inputs = featureInputs();
  inputs.finalization.publication.workspace.promoted_git =
    inputs.finalization.publication.workspace.expected_git;
  assert.throws(
    () => prepareFeatureSelection(inputs),
    /finalization must bind and advance the selected clean workspace/,
  );
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

test("feature/v1 verify executes and seals one durable local candidate", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-feature-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
    }),
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
  facts.validator_contracts.push("flow.validator/feature-evidence/v1");
  facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  facts.resource_claims.push({
    kind: "workspace",
    id: "workspace:producer",
    generation: 1,
    mutation_epoch: 7,
    fingerprint: digestValue({ git: exactGitFacts() }),
  });
  facts.limits.max_cards = 8;
  facts.limits.max_resources = 4;

  let runtime;
  let verifyReceipt = null;
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
        prompt: role === "apply"
          ? "apply the accepted brief in the exact fenced workspace"
          : "critique the changed behavior independently of implementation",
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
    delegatedAgentPort,
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output.endsWith("accepted");
        },
      },
    },
    registeredOperations: {
      [FEATURE_OPERATION_CONTRACTS.verify]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
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
            candidate_id: finalization.candidate_id,
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
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
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
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.created, true, JSON.stringify(launch));
  artifactAuthority.command(artifactRegistration(
    bytes,
    artifactDigest,
    launch.run_id,
  ));
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

  executeCard(runtime, launch.run_id, "operation_execute", "feature-verify");
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-verify" && status === "succeeded",
  ));

  executeCard(runtime, launch.run_id, "delegate_execute", "feature-critique");
  await until(() => runtime.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-critique" && status === "succeeded",
  ));
  critiqueEvidence = runtime.query({ run_id: launch.run_id }).delegate_attempts
    .find(({ card_id: cardId }) => cardId === "feature-critique").evidence;

  executeCard(runtime, launch.run_id, "operation_execute", "feature-seal");
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  const materialized = sealIntent?.operation_input
    ?.authority_materialized_evidence;
  assert.deepEqual(sealIntent.operation_input.finalization, inputs.finalization);
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

  const review = reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: "candidate:feature",
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
    candidate_id: "candidate:feature",
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
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: "candidate:feature",
  }).status, "sealed");
  assert.equal(fixture.reviewAuthority.query({
    contract: "work.review/v1",
    subject_id: "candidate:feature",
  }).generation, 1);
  assert.equal(completed.handoffs.length, 1);
  assert.equal(fixture.handoffAuthority.query({
    contract: "flow.resource-handoff/v1",
    subject_id: completed.handoffs[0].handoff_id,
  }).status, "active");
});

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

function completeVerificationReceipt(intent, inputs, overrides = {}) {
  const discriminatingEvidence = inputs.verification.baseline ??
    inputs.verification.compensating_assertion;
  const acceptanceCriteria = inputs.brief.acceptance.map((criterion) => {
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
  const evidenceKind = overrides.discriminating_kind ??
    (inputs.verification.baseline ? "safe_baseline" : "compensating_assertion");
  const selectedFingerprint = overrides.discriminating_fingerprint ??
    discriminatingEvidence.fingerprint;
  const discriminating = evidenceKind === "safe_baseline"
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

function completeCritiqueReceipt(
  intent,
  materialized,
  critiqueEvidence,
  findings,
  overrides = {},
) {
  const delegateEvidence = materialized?.accepted_delegates?.find(({ card_id: cardId }) =>
    cardId === "feature-critique") ?? {
    card_id: "feature-critique",
    evidence: critiqueEvidence,
  };
  const identity = {
    schema: "work.feature-critique-receipt/v1",
    delegate_evidence: delegateEvidence,
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

async function createFeatureFailureFixture(t, scenario) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-feature-red-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const promotedGit = scenario.publication?.promotedGit ?? promotedGitFacts();
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    beforeHandoffCommit: scenario.beforeHandoffCommit,
    gitRetentionAdapter: deterministicGitRetentionAdapter(),
    gitWorkspaceObservationAdapter: deterministicGitWorkspaceObservationAdapter({
      promotion: true,
      promotedGit,
    }),
    hostIdentityAdapter: fixedHostIdentity("boot-feature-red", "feature-process-red"),
  });
  t.after(() => runAuthority.close());
  const workspaceAuthority = getWorkspaceAuthority({ runAuthority });
  const artifactAuthority = getArtifactAuthority({ runAuthority });
  const reviewAuthority = getReviewAuthority({ runAuthority });
  const handoffAuthority = getResourceHandoffAuthority({ runAuthority });
  const bytes = Buffer.from("feature red candidate bytes\n");
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
  if (scenario.compensatingAssertion === true) {
    delete inputs.verification.baseline;
    inputs.verification.compensating_assertion = {
      schema: "flow.feature-compensating-assertion/v1",
      assertion: "the changed behavior remains bounded by an independent invariant",
      non_destructive: true,
      fingerprint: `sha256:${"7".repeat(64)}`,
    };
  }
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
    publication: handoffPublication(artifactDigest, scenario.publication),
  };
  const facts = featureFactsForInputs(inputs);

  let verifyReceipt = null;
  let critiqueEvidence = null;
  let delegateDispatches = 0;
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
      const role = request.agent_id.endsWith("apply") ? "apply" : "critique";
      const turnId = `turn:feature-red-${role}`;
      turnRecords.set(turnId, {
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        output: scenario.forgedDelegateSelfReport
          ? `${role} verification passed accepted`
          : `${role} accepted`,
        prompt: role === "apply"
          ? "apply the accepted brief in the exact fenced workspace"
          : "critique the changed behavior independently of implementation",
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
    delegatedAgentPort,
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output.endsWith("accepted");
        },
      },
    },
    registeredOperations: {
      [FEATURE_OPERATION_CONTRACTS.verify]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke(intent) {
          if (scenario.verifyReceiptMode === "absent") return undefined;
          if (scenario.verifyReceiptMode === "invalid") {
            return operationReceipt(intent, { schema: "invalid" });
          }
          const providerReceipt = completeVerificationReceipt(
            intent,
            inputs,
            scenario.verification,
          );
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
          );
          const candidateGit = publication.workspace.promoted_git;
          const retention = gitRetentionReceipt(candidateGit);
          const candidateIdentity = {
            schema: "work.review-candidate/v1",
            candidate_id: "candidate:feature",
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
            artifacts: [{
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
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
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
  artifactAuthority.command(artifactRegistration(bytes, artifactDigest, launch.run_id));
  const registeredWorkspace = workspaceAuthority.query(workspaceQuery());
  assert.equal(workspaceAuthority.command(workspaceClaim({
    expectedWatermark: registeredWorkspace.watermark,
    expectedFingerprint: digestValue({ git: exactGitFacts() }),
    holder: scenario.workspaceClaimHolder ?? launch.run_id,
    operations: [
      "feature-apply",
      "feature-verify",
      "feature-critique",
      "feature-seal",
      "handoff_publication",
    ],
  })).accepted, true);
  return {
    artifactAuthority,
    artifactDigest,
    handoffAuthority,
    reviewAuthority,
    runId: launch.run_id,
    runtime,
    sealIntents,
    delegateDispatches() {
      return delegateDispatches;
    },
    setCritiqueEvidence(evidence) {
      critiqueEvidence = evidence;
    },
    workspaceAuthority,
  };
}

async function driveFeatureToSeal(fixture, { allowSealRefusal = false } = {}) {
  const { runId, runtime } = fixture;
  executeCard(runtime, runId, "delegate_execute", "feature-apply");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-apply" && status === "succeeded",
  ));
  executeCard(runtime, runId, "operation_execute", "feature-verify");
  await settleFeatureEffect(runtime, runId, "feature-verify");
  let projection = runtime.query({ run_id: runId });
  if (projection.effects.find(({ card_id: cardId }) => cardId === "feature-verify")
    ?.status !== "succeeded") return;
  executeCard(runtime, runId, "delegate_execute", "feature-critique");
  await until(() => runtime.query({ run_id: runId }).effects.some(
    ({ card_id: cardId, status }) =>
      cardId === "feature-critique" && status === "succeeded",
  ));
  projection = runtime.query({ run_id: runId });
  fixture.critiqueEvidence = projection.delegate_attempts.find(
    ({ card_id: cardId }) => cardId === "feature-critique",
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

function gitRetentionReceipt(git) {
  return {
    schema: "flow.git-retention-receipt/v1",
    repository_id: "github.com/Seavenly/example",
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

function prepareFeatureSelection(inputs) {
  const facts = featureFactsForInputs(inputs);
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredOperations: Object.fromEntries(
      Object.values(FEATURE_OPERATION_CONTRACTS).map((contract) => [contract, {
        classification: "caller_idempotent",
        invoke() {
          throw new Error("feature operations are not invoked during preparation");
        },
      }]),
    ),
    predefinedDefinitions: {
      "feature/v1": createFeatureDefinition(),
    },
  });
  return runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "feature/v1",
    inputs,
    explicit_facts: facts,
  });
}

function featureFactsForInputs(inputs) {
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.operation_contracts = Object.values(FEATURE_OPERATION_CONTRACTS);
  facts.validator_contracts.push("flow.validator/operation-receipt/v1");
  facts.validator_contracts.push("flow.validator/feature-evidence/v1");
  facts.validator_contracts.push(DELEGATE_OUTPUT_VALIDATOR);
  facts.resource_claims.push({
    kind: "workspace",
    id: inputs.workspace.subject_id,
    generation: inputs.workspace.generation,
    mutation_epoch: inputs.workspace.mutation_epoch,
    fingerprint: inputs.workspace.fingerprint,
  });
  facts.limits.max_cards = 8;
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest, idempotencyCommandDigest } from "../src/canonical.mjs";
import {
  createFlowRuntime,
  validateReviewDelegateOutput,
} from "../src/flow-runtime.mjs";
import { operationEffectIdentity } from "../src/effect-identity.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import {
  foldWorkStream,
  getReviewAuthority,
  getRunEffectIntentReader,
} from "../src/work-authority.mjs";
import {
  buildReviewSummary,
  normalizeReviewFindings,
  parseReviewDelegateResult,
  renderReviewArtifacts,
  REVIEW_CAP_REASON_CODE_MAX_LENGTH,
  REVIEW_CAP_REASON_DETAIL_MAX_LENGTH,
  REVIEW_CAP_REASON_MAX_COUNT,
} from "../src/review-rendering.mjs";
import {
  createInMemoryReviewAuthority,
  createInMemoryGitHubReviewAuthority,
  createReviewDefinition,
  createReviewOperationRegistration,
  buildReviewTargetObservation,
  buildReviewTargetInvalidationEvent,
  buildReviewTargetRefreshEvent,
  materializeReviewDelegateResult,
  projectReviewRecord,
  GITHUB_REVIEW_OPERATION_CONTRACTS,
  GITHUB_REVIEW_TARGET_SCHEMA,
  githubPendingEffectIdentity,
  reviewCompletionAuthority,
  reviewEventWatermark,
  reviewAuthorityEventWatermark,
  reviewRecordWatermarkIdentity,
  reviewSubjectId,
  REVIEW_OPERATION_CONTRACTS,
  REVIEW_DELEGATE_OUTPUT_VALIDATOR,
} from "../src/review-flow.mjs";
import { completedTurnProjection } from "../test-support/delegate-card.mjs";
import {
  shippedAuthorityRegistrations,
  shippedAuthorityStateFromFacts,
} from "../test-support/authority-bindings.mjs";
import { supportedDescription } from "../test-support/delegated-agent-description.mjs";
import { dynamicCheckpointProposal } from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";

const DIGEST = (byte) => `sha256:${byte.repeat(64)}`;

test("review/v1 rejects a minimal self-digest candidate before launch", () => {
  const candidate = minimalReviewCandidate();
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  assert.throws(
    () => runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "review/v1",
      inputs: reviewInputsForCandidate(candidate),
      explicit_facts: reviewRuntimeFacts(),
    }),
    (error) => error.reason === "invalid_verified_review_candidate",
  );
});

test("review/v1 reports invalid urgency_floor as typed caller input", () => {
  const candidate = reviewCandidate();
  const inputs = reviewInputsForCandidate(candidate);
  assert.throws(
    () => createReviewDefinition().compile({
      inputs: { ...inputs, urgency_floor: "urgent-but-unknown" },
      explicit_facts: reviewRuntimeFacts(),
    }),
    (error) => error.reason === "invalid_urgency_floor",
  );
});

test("review/v1 prepares an exact GitHub snapshot with an optional pending-review checkpoint", () => {
  const target = githubReviewTarget();
  const inputs = githubReviewInputs(target, { createPendingReview: true });
  const facts = reviewRuntimeFacts();
  facts.operation_contracts.push(GITHUB_REVIEW_OPERATION_CONTRACTS.pending);
  facts.validator_contracts.push("flow.validator/github-review-receipt/v1");
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    githubReviewForge: {},
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });

  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  assert.equal(cards.get("review-record").inputs.target.schema, GITHUB_REVIEW_TARGET_SCHEMA);
  assert.equal(cards.get("review-github-pending-checkpoint").executor.kind, "checkpoint");
  assert.equal(
    cards.get("review-github-pending").executor.effect_classification,
    "one_shot_uncertain",
  );
  assert.deepEqual(cards.get("review-github-pending").dependencies, [
    "review-github-pending-checkpoint",
  ]);
});

test("review/v1 rejects unversioned or aliased pending-review requests", () => {
  const target = githubReviewTarget();
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    githubReviewForge: {},
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  for (const pendingRequest of [
    true,
    { create: true },
    { enabled: true },
    { schema: "flow.github-pending-review-request/v1", enabled: true },
  ]) {
    assert.throws(
      () => runtime.prepare({
        schema: "flow.predefined-flow-selection/v1",
        definition: "review/v1",
        inputs: {
          ...githubReviewInputs(target),
          pending_review: pendingRequest,
        },
        explicit_facts: reviewRuntimeFacts(),
      }),
      (error) => error.reason === "invalid_github_pending_request",
    );
  }
});

test("declining the exact GitHub pending-review checkpoint completes locally without Forge mutation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-github-review-decline-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-decline-boot", "writer"),
  });
  t.after(() => runAuthority.close());
  const forge = githubForge();
  const target = githubReviewTarget();
  const inputs = githubReviewInputs(target, { createPendingReview: true });
  const [securityDescription, criticDescription] = await Promise.all([
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-sol", "security"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  inputs.delegation.lenses.security = {
    description: securityDescription,
    route: reviewRoute("agent:github-security", securityDescription),
  };
  inputs.delegation.critic = {
    description: criticDescription,
    route: reviewRoute("agent:github-critic", criticDescription),
  };
  const facts = reviewRuntimeFacts();
  facts.operation_contracts.push(GITHUB_REVIEW_OPERATION_CONTRACTS.pending);
  facts.validator_contracts.push("flow.validator/github-review-receipt/v1");
  const runtime = createFlowRuntime({
    runAuthority,
    githubReviewForge: forge,
    delegatedAgentPort: githubReviewDelegatedPort(),
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  const launch = runtime.launch(reviewLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  const declined = runtime.command({ ...checkpoint, decision: "decline" });
  assert.equal(declined.accepted, true, JSON.stringify(declined));
  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(projection.phase, "declined");
  assert.equal(forge.createCount, 0);
  const declinedCheckpoint = projection.checkpoints.find(({ card_id: cardId }) =>
    cardId === "review-github-pending-checkpoint");
  assert.equal(declinedCheckpoint.decision, "decline");
  assert.deepEqual(declinedCheckpoint.checkpoint_binding, {
    schema: "flow.checkpoint-binding/v1",
    checkpoint_id: "review-github-pending-checkpoint",
    draft: checkpoint.draft,
    draft_digest: checkpoint.draft_digest,
  });
  assert.equal(projection.effects.some(({ card_id: cardId }) =>
    cardId === "review-github-pending"), false);
  assert.deepEqual(projection.legal_actions, []);
});

test("accepting the exact GitHub checkpoint creates one unsubmitted pending review only", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-github-review-accept-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-accept-boot", "writer"),
  });
  t.after(() => runAuthority.close());
  const forge = githubForge();
  const target = githubReviewTarget();
  const inputs = githubReviewInputs(target, { createPendingReview: true });
  const [securityDescription, criticDescription] = await Promise.all([
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-sol", "security"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  inputs.delegation.lenses.security = {
    description: securityDescription,
    route: reviewRoute("agent:github-accept-security", securityDescription),
  };
  inputs.delegation.critic = {
    description: criticDescription,
    route: reviewRoute("agent:github-accept-critic", criticDescription),
  };
  const facts = reviewRuntimeFacts();
  facts.operation_contracts.push(GITHUB_REVIEW_OPERATION_CONTRACTS.pending);
  facts.validator_contracts.push("flow.validator/github-review-receipt/v1");
  const runtime = createFlowRuntime({
    runAuthority,
    githubReviewForge: forge,
    delegatedAgentPort: githubReviewDelegatedPort(),
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  const launch = runtime.launch(reviewLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  const approved = runtime.command({ ...checkpoint, decision: "approve" });
  assert.equal(approved.accepted, true, JSON.stringify(approved));
  await driveUntilTerminal(runtime, launch.run_id);
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  assert.equal(forge.createCount, 1);
  assert.equal(forge.submitCount, 0);
  assert.deepEqual(forge.forbiddenMutationCalls, []);
  assert.equal(forge.createRequests.length, 1);
  assert.deepEqual(forge.createRequests[0].target, target);
  assert.equal(forge.createRequests[0].target_fingerprint, target.snapshot_fingerprint);
  assert.equal(forge.createRequests[0].commit_id, target.snapshot.head_sha);
  assert.deepEqual(forge.createRequests[0].expected_snapshot, target.snapshot);
  assert.equal(forge.createRequests[0].submitted, false);
  assert.equal(forge.createRequests[0].draft.schema, "flow.github-pending-review-draft/v1");
  assert.match(forge.createRequests[0].marker, /^flow-github-review:/u);
  const pendingEffect = completed.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(pendingEffect.status, "succeeded");
  assert.equal(pendingEffect.receipt.provider_receipt.submitted, false);
  assert.equal(pendingEffect.receipt.provider_receipt.state, "pending");
  assert.deepEqual(
    pendingEffect.receipt.provider_receipt.target_fingerprint,
    target.snapshot_fingerprint,
  );
  assert.match(completed.watermark, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(completed.legal_actions, []);
  const runWatch = runtime.watch({ run_id: launch.run_id });
  const watchedRun = await runWatch.next();
  assert.equal(watchedRun.value.watermark, completed.watermark);
  assert.deepEqual(watchedRun.value.legal_actions, []);
  const review = runtime.query({ review_id: reviewSubjectId(target) });
  assert.equal(review.target_kind, "github", JSON.stringify(review));
  assert.deepEqual(review.target, target);
  assert.equal(review.watermark, review.authority_watermark);
  assert.equal(review.target_authority_watermark, target.target_authority_watermark);
  assert.equal(review.remote_review.status, "created");
  assert.equal(review.remote_review.state, "pending");
  assert.equal(review.remote_review.submitted, false);
  assert.equal(review.remote_review.review_id, pendingEffect.receipt.provider_receipt.review_id);
  assert.equal(review.remote_review.draft_digest, pendingEffect.receipt.provider_receipt.draft_digest);
  assert.equal(review.remote_review.effect_id, pendingEffect.receipt.provider_receipt.effect_id);
  assert.deepEqual(review.legal_actions, []);
  const reviewWatch = runtime.watch({ review_id: reviewSubjectId(target) });
  const watchedReview = await reviewWatch.next();
  assert.equal(watchedReview.value.watermark, review.watermark);
  assert.deepEqual(watchedReview.value.legal_actions, []);
});

test("GitHub checkpoint exposes and binds the exact rendered pending-review draft", async (t) => {
  const forge = githubForge();
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(checkpoint.draft?.schema, "flow.github-pending-review-draft/v1");
  assert.equal(checkpoint.draft_digest, digest(checkpoint.draft));
  assert.equal(checkpoint.draft.target_fingerprint, githubReviewTarget().snapshot_fingerprint);
  const checkpointCard = runtime.query({ run_id: launch.run_id }).active_plan.cards.find(({ id }) =>
    id === "review-github-pending-checkpoint");
  assert.deepEqual(checkpointCard.inputs.draft, checkpoint.draft);
  assert.equal(checkpointCard.inputs.draft_digest, checkpoint.draft_digest);

  const tampered = runtime.command({
    ...checkpoint,
    decision: "approve",
    draft: { ...checkpoint.draft, body: `${checkpoint.draft.body}\nforged` },
  });
  assert.equal(tampered.accepted, undefined);
  assert.equal(tampered.code, "github_review_checkpoint_draft_mismatch");
  assert.equal(forge.createCount, 0);

  const approved = runtime.command({ ...checkpoint, decision: "approve" });
  assert.equal(approved.accepted, true, JSON.stringify(approved));
  await driveUntilTerminal(runtime, launch.run_id);
  assert.equal(forge.createCount, 1);
  assert.deepEqual(forge.createRequests[0].draft, checkpoint.draft);
  assert.equal(forge.createRequests[0].draft_digest, checkpoint.draft_digest);
});

test("durable RunAuthority requires the declarative GitHub checkpoint binding", async (t) => {
  const forge = githubForge();
  const { runtime, runAuthority, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(
    runAuthority.query(launch.run_id).active_plan.cards.find(({ id }) =>
      id === "review-github-pending-checkpoint").inputs.required_checkpoint_binding_schema,
    "flow.checkpoint-binding/v1",
  );
  const { draft: _draft, draft_digest: _draftDigest, ...identity } = checkpoint;
  assert.equal(Object.hasOwn(identity, "checkpoint_binding"), false);
  const missing = runAuthority.command({ ...identity, decision: "approve" });
  assert.equal(missing.accepted, undefined);
  assert.equal(missing.code, "checkpoint_binding_required");
  const tamperedDraft = { ...checkpoint.draft, body: `${checkpoint.draft.body}\nforged` };
  const tampered = runAuthority.command({
    ...identity,
    decision: "approve",
    checkpoint_binding: {
      schema: "flow.checkpoint-binding/v1",
      checkpoint_id: checkpoint.checkpoint_id,
      draft: tamperedDraft,
      draft_digest: checkpoint.draft_digest,
    },
  });
  assert.equal(tampered.accepted, undefined);
  assert.equal(tampered.code, "invalid_checkpoint_binding");
  assert.equal(forge.createCount, 0);
});

test("GitHub draft pre-render uses the lifecycle operation effect identity", async (t) => {
  const forge = githubForge();
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  const identity = githubPendingEffectIdentity({ runId: launch.run_id });
  assert.ok(identity);
  assert.match(
    checkpoint.draft.body,
    new RegExp(`flow-github-review:${identity.idempotency_key}`),
  );
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const operation = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.find(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "succeeded"));
  const effect = operation.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(effect.effect_id, identity.effect_id);
  assert.equal(effect.idempotency_key, identity.idempotency_key);
  assert.equal(effect.attempt_id, identity.attempt_id);
});

test("generic operation identity requires explicit operation identity fields", () => {
  assert.equal(operationEffectIdentity({ runId: "run:test" }), null);
  assert.equal(operationEffectIdentity({
    runId: "run:test",
    cardId: "card:test",
    operationContract: "flow.operation/test/v1",
  }).attempt_id, "run:test:card:test:attempt:1");
});

test("durable FlowRuntime reopens the exact GitHub semantic review projection", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-github-review-reopen-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-reopen-a", "writer"),
  });
  const forge = githubForge();
  const first = await launchGitHubPendingScenario(t, {
    forge,
    runAuthority: firstAuthority,
  });
  const checkpoint = await driveToAction(first.runtime, first.launch.run_id, "checkpoint_decision");
  assert.equal(first.runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const completed = await driveUntilTerminal(first.runtime, first.launch.run_id);
  const subjectId = reviewSubjectId(first.target);
  const beforeClose = first.runtime.query({ review_id: subjectId });
  assert.equal(completed.phase, "succeeded");
  assert.equal(beforeClose.target_kind, "github");
  assert.equal(beforeClose.remote_review.status, "created");
  assert.equal(beforeClose.remote_review.state, "pending");
  firstAuthority.close();

  const reopenedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-reopen-b", "writer"),
  });
  t.after(() => reopenedAuthority.close());
  const reopened = createFlowRuntime({
    runAuthority: reopenedAuthority,
    githubReviewForge: forge,
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const afterReopen = reopened.query({ review_id: subjectId });
  assert.equal(afterReopen.target_kind, "github");
  assert.deepEqual(afterReopen.target, beforeClose.target);
  assert.equal(afterReopen.watermark, beforeClose.watermark);
  assert.deepEqual(afterReopen.remote_review, beforeClose.remote_review);
  assert.deepEqual(afterReopen.command_receipts, beforeClose.command_receipts);
  assert.deepEqual(afterReopen.artifacts, beforeClose.artifacts);
  assert.deepEqual(afterReopen.legal_actions, []);
  const watched = await reopened.watch({ review_id: subjectId }).next();
  assert.equal(watched.value.watermark, beforeClose.watermark);
  assert.deepEqual(watched.value.legal_actions, []);
});

test("reopened FlowRuntime recovers a pending intent with its durable exact draft binding", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-github-review-draft-reopen-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-draft-reopen-boot", "writer"),
  });
  t.after(() => runAuthority.close());
  const forge = githubForge({
    onCreate(request) {
      const review = {
        id: "github-review:draft-reopen",
        state: "pending",
        submitted: false,
        marker: request.marker,
        target_fingerprint: request.target_fingerprint,
        target_authority_watermark: request.target_authority_watermark,
        draft_digest: request.draft_digest,
        repository: request.repository,
        pull_request_number: request.pull_request_number,
        commit_id: request.commit_id,
      };
      this.pendingReviews.push(review);
      throw Object.assign(new Error("pending review response was lost"), {
        code: "github_review_receipt_ambiguous",
      });
    },
  });
  const first = await launchGitHubPendingScenario(t, { forge, runAuthority });
  const checkpoint = await driveToAction(first.runtime, first.launch.run_id, "checkpoint_decision");
  const acceptedDraft = checkpoint.draft;
  const acceptedDraftDigest = checkpoint.draft_digest;
  assert.equal(first.runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const unresolved = await waitForProjection(first.runtime, first.launch.run_id, (projection) =>
    forge.createCount === 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "unresolved"));
  const pendingEffect = unresolved.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(
    pendingEffect.checkpoint_binding?.draft_digest,
    acceptedDraftDigest,
  );

  runAuthority.close();
  const reopenedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-draft-reopen-boot", "writer"),
  });
  t.after(() => reopenedAuthority.close());
  const reopened = createFlowRuntime({
    runAuthority: reopenedAuthority,
    githubReviewForge: forge,
    delegatedAgentPort: githubReviewDelegatedPort(),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const immediatelyReopened = reopened.query({ run_id: first.launch.run_id });
  assert.ok(
    immediatelyReopened.effects.find(({ card_id: cardId }) =>
      cardId === "review-github-pending")?.checkpoint_binding,
    JSON.stringify(immediatelyReopened),
  );
  const recovery = immediatelyReopened.legal_actions.find(({ type }) => type === "recovery");
  if (recovery) assert.equal(reopened.command(recovery).accepted, true);
  const reopenedProjection = await waitForProjection(reopened, first.launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "succeeded"));
  const reopenedEffect = reopenedProjection.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(
    reopenedEffect.checkpoint_binding.draft_digest,
    acceptedDraftDigest,
  );
  assert.deepEqual(
    reopenedEffect.checkpoint_binding.draft,
    acceptedDraft,
  );
  assert.equal(forge.createCount, 1);
  assert.equal(forge.submitCount, 0);
  assert.equal(
    reopenedEffect.receipt.provider_receipt.draft_digest,
    acceptedDraftDigest,
  );
});

test("GitHub pending creation requires complete provider identity evidence", async (t) => {
  const forge = githubForge({
    onCreate() {
      return { id: "github-review:incomplete", state: "pending" };
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const unresolved = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.createCount === 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "unresolved"));
  const pending = unresolved.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(pending.receipt, null);
  assert.equal(forge.createCount, 1);
  assert.equal(forge.submitCount, 0);
});

test("an unrelated pending GitHub review is preserved and cannot satisfy this flow", async (t) => {
  const unrelated = {
    id: "human-review:existing",
    state: "pending",
    submitted: false,
    body: "A reviewer draft for a different purpose",
  };
  const forge = githubForge({ pendingReviews: [unrelated] });
  const { runtime, launch, target } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const completed = await driveUntilTerminal(runtime, launch.run_id);
  assert.equal(completed.phase, "succeeded");
  assert.equal(forge.createCount, 1);
  assert.equal(forge.submitCount, 0);
  assert.deepEqual(forge.pendingReviews[0], unrelated);
  assert.equal(forge.pendingReviews.length, 2);
  assert.notEqual(forge.pendingReviews[1].id, unrelated.id);
  assert.equal(
    forge.pendingReviews[1].target_fingerprint,
    target.snapshot_fingerprint,
  );
  assert.equal(
    forge.pendingReviews[1].draft_digest,
    forge.createRequests[0].draft_digest,
  );
  assert.notEqual(forge.pendingReviews[1].marker, undefined);
});

test("an ambiguous GitHub receipt stays one-shot uncertain without reposting", async (t) => {
  const forge = githubForge({
    onCreate(request) {
      const exact = {
        state: "pending",
        submitted: false,
        marker: request.marker,
        target_fingerprint: request.target_fingerprint,
        target_authority_watermark: request.target_authority_watermark,
        draft_digest: request.draft_digest,
        repository: request.repository,
        pull_request_number: request.pull_request_number,
        commit_id: request.commit_id,
      };
      this.pendingReviews.push({ ...exact, id: "github-review:ambiguous-1" });
      this.pendingReviews.push({ ...exact, id: "github-review:ambiguous-2" });
      throw Object.assign(new Error("Forge response was lost"), {
        code: "github_review_receipt_ambiguous",
      });
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const uncertain = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.createCount === 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "unresolved"));
  assert.equal(forge.createCount, 1);
  const pendingEffect = uncertain.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(pendingEffect.receipt, null);
  assert.equal(pendingEffect.last_observation, null);
  assert.ok(uncertain.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(uncertain.legal_actions.some(({ type }) => type === "cancel"));
  assert.equal(
    uncertain.legal_actions.some(({ type }) => type === "operation_execute"),
    false,
  );

  const recovery = uncertain.legal_actions.find(({ type }) => type === "recovery");
  assert.equal(runtime.command(recovery).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, last_observation: observation }) =>
      cardId === "review-github-pending" &&
      observation?.presence === "indeterminate"));
  const blockedEffect = blocked.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(blockedEffect.status, "uncertain");
  assert.equal(forge.createCount, 1);
  assert.equal(forge.submitCount, 0);
  assert.ok(blocked.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(blocked.legal_actions.some(({ type }) => type === "cancel"));
  assert.equal(
    blocked.legal_actions.some(({ type }) => type === "operation_execute"),
    false,
  );
  // Even if a later listing observes zero exact matches, the one-shot intent
  // remains unresolved and is never replayed as a new creation.
  forge.pendingReviews = [];
  const secondRecovery = blocked.legal_actions.find(({ type }) => type === "recovery");
  assert.equal(runtime.command(secondRecovery).accepted, true);
  const stillUnresolved = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, last_observation: observation }) =>
      cardId === "review-github-pending" &&
      observation?.provider_observation?.matching_review_count === 0));
  assert.equal(stillUnresolved.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending").status, "uncertain");
  assert.equal(forge.createCount, 1);
  const watcher = runtime.watch({ run_id: launch.run_id });
  const watched = await watcher.next();
  assert.equal(watched.value.watermark, stillUnresolved.watermark);
  assert.deepEqual(watched.value.legal_actions, stillUnresolved.legal_actions);
});

test("GitHub target movement before mutation blocks with zero creation calls", async (t) => {
  const movedSnapshot = githubReviewTarget({ headSha: "f".repeat(40) }).snapshot;
  const forge = githubForge({ snapshot: movedSnapshot });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  assert.ok(forge.readCount >= 1);
  assert.equal(forge.createCount, 0);
  assert.equal(forge.submitCount, 0);
  assert.ok(blocked.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(blocked.legal_actions.some(({ type }) => type === "cancel"));
  assert.equal(
    blocked.legal_actions.some(({ type }) => type === "operation_execute"),
    false,
  );
  const invalidated = runtime.query({ review_id: reviewSubjectId(githubReviewTarget()) });
  assert.equal(invalidated.status, "invalidated");
  assert.equal(invalidated.automated_completion, false);
  assert.equal(invalidated.invalidation.code, "github_review_target_moved");
  assert.ok(invalidated.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(invalidated.legal_actions.some(({ type }) => type === "cancel"));
});

test("Forge target-moved error codes cannot invalidate without snapshot movement", async (t) => {
  const forge = githubForge({
    onRead() {
      throw Object.assign(new Error("provider reported a stale target"), {
        code: "github_review_target_moved",
      });
    },
  });
  const { runtime, launch, target } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, last_observation: observation }) =>
      cardId === "review-github-pending" &&
      observation?.provider_observation?.provider_error_code ===
        "github_review_target_moved"));
  const pending = blocked.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(
    pending.last_observation.provider_observation.code,
    "github_review_target_observation_unavailable",
  );
  assert.equal(
    pending.last_observation.provider_observation.provider_error_code,
    "github_review_target_moved",
  );
  assert.equal(pending.status, "uncertain");
  const review = runtime.query({ review_id: reviewSubjectId(target) });
  assert.notEqual(review.status, "invalidated");
  assert.equal(review.invalidation, undefined);
  assert.equal(forge.createCount, 0);
});

test("initial GitHub target movement is durable across restart before recovery", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-github-review-moved-reopen-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const movedSnapshot = githubReviewTarget({ headSha: "f".repeat(40) }).snapshot;
  const forge = githubForge({ snapshot: movedSnapshot });
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-moved-reopen-a", "writer"),
  });
  const first = await launchGitHubPendingScenario(t, {
    forge,
    runAuthority: firstAuthority,
  });
  const checkpoint = await driveToAction(first.runtime, first.launch.run_id, "checkpoint_decision");
  assert.equal(first.runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(first.runtime, first.launch.run_id, (projection) =>
    forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  const subjectId = reviewSubjectId(first.target);
  const beforeClose = first.runtime.query({ review_id: subjectId });
  assert.equal(beforeClose.status, "invalidated");
  assert.equal(beforeClose.invalidation.code, "github_review_target_moved");
  assert.ok(blocked.effects.find(({ card_id: cardId }) => cardId === "review-github-pending")
    ?.last_observation?.provider_observation);
  firstAuthority.close();

  const reopenedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-moved-reopen-b", "writer"),
  });
  t.after(() => reopenedAuthority.close());
  const durableAfterRestart = reopenedAuthority.query(first.launch.run_id);
  assert.equal(durableAfterRestart.admission, "suspended_after_reboot");
  const durableEffect = durableAfterRestart.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(
    durableEffect.last_observation.provider_observation.code,
    "github_review_target_moved",
  );
  const reopened = createFlowRuntime({
    runAuthority: reopenedAuthority,
    githubReviewForge: forge,
    delegatedAgentPort: githubReviewDelegatedPort(),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const runAfterReopen = reopened.query({ run_id: first.launch.run_id });
  assert.equal(runAfterReopen.admission, "suspended_after_reboot");
  assert.equal(runAfterReopen.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending").last_observation.provider_observation.code,
  "github_review_target_moved");
  const afterReopen = reopened.query({ review_id: subjectId });
  assert.equal(afterReopen.status, "invalidated");
  assert.equal(afterReopen.invalidation.code, "github_review_target_moved");
  assert.deepEqual(afterReopen.findings, beforeClose.findings);
  assert.equal(forge.createCount, 0);
});

test("GitHub snapshot revalidation requires an explicit open state", async (t) => {
  const forge = githubForge({
    onRead() {
      const { state: _state, ...withoutState } = githubReviewTarget().snapshot;
      return withoutState;
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  assert.equal(forge.createCount, 0);
  assert.equal(forge.submitCount, 0);
  assert.ok(blocked.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(blocked.legal_actions.some(({ type }) => type === "cancel"));
});

test("GitHub snapshot revalidation requires an explicit target authority watermark", async (t) => {
  const target = githubReviewTarget();
  const forge = githubForge({
    includeTargetAuthorityWatermark: false,
    onRead() {
      return target.snapshot;
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge, target });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  assert.equal(forge.createCount, 0);
  assert.equal(forge.submitCount, 0);
  assert.ok(blocked.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(blocked.legal_actions.some(({ type }) => type === "cancel"));
});

test("non-canonical GitHub snapshots become typed observation evidence", async (t) => {
  const forge = githubForge({
    onRead() {
      return { ...githubReviewTarget().snapshot, diff_sha256: undefined };
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  const pending = blocked.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(
    pending.last_observation?.provider_observation?.code,
    "github_review_observation_incomplete",
  );
  assert.equal(forge.createCount, 0);
});

test("missing GitHub target watermark is observation-incomplete, never target-moved", async (t) => {
  const target = githubReviewTarget();
  const forge = githubForge({
    includeTargetAuthorityWatermark: false,
    onRead() {
      return target.snapshot;
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge, target });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  const pending = blocked.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending");
  assert.equal(
    pending.last_observation?.provider_observation?.code,
    "github_review_observation_incomplete",
  );
  const review = runtime.query({ review_id: reviewSubjectId(target) });
  assert.notEqual(review.status, "invalidated");
  assert.equal(review.invalidation, undefined);
  assert.equal(forge.createCount, 0);
});

test("Forge pending-review listing requires one explicit complete page", async (t) => {
  for (const listing of ["bare", "incomplete"]) {
    const forge = githubForge({
      bareListing: listing === "bare",
      incompleteListing: listing === "incomplete",
    });
    const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
    const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
    assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
    const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
      forge.readCount >= 1 && projection.effects?.some(({ card_id: cardId, status }) =>
        cardId === "review-github-pending" && status === "uncertain"));
    const pending = blocked.effects.find(({ card_id: cardId }) =>
      cardId === "review-github-pending");
    assert.equal(
      pending.last_observation?.provider_observation?.code,
      listing === "bare"
        ? "github_review_listing_invalid"
        : "github_review_listing_incomplete",
    );
    assert.equal(forge.createCount, 0);
  }
});

test("Forge Adapter exposes only the canonical three provider methods", async (t) => {
  const target = githubReviewTarget();
  const forge = {
    readPullRequest() {
      return {
        snapshot: target.snapshot,
        target_authority_watermark: target.target_authority_watermark,
      };
    },
    listPullRequestReviews() {
      return { reviews: [], complete: true };
    },
    createReview() {},
  };
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge, target });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "uncertain"));
  assert.equal(
    blocked.effects.find(({ card_id: cardId }) => cardId === "review-github-pending")
      .last_observation.provider_observation.code,
    "github_review_adapter_incomplete",
  );
});

test("GitHub target movement during recovery remains indeterminate without reposting", async (t) => {
  let moved = false;
  const forge = githubForge({
    onRead() {
      return moved
        ? githubReviewTarget({ headSha: "f".repeat(40) }).snapshot
        : githubReviewTarget().snapshot;
    },
    onCreate() {
      throw Object.assign(new Error("creation response was lost"), {
        code: "github_review_receipt_ambiguous",
      });
    },
  });
  const { runtime, launch } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const uncertain = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.createCount === 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "unresolved"));
  assert.equal(forge.createCount, 1);
  moved = true;
  const recovery = uncertain.legal_actions.find(({ type }) => type === "recovery");
  assert.ok(recovery);
  assert.equal(runtime.command(recovery).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, last_observation: observation }) =>
      cardId === "review-github-pending" &&
      observation?.presence === "indeterminate"));
  assert.equal(blocked.effects.find(({ card_id: cardId }) =>
    cardId === "review-github-pending").status, "uncertain");
  assert.equal(forge.createCount, 1);
  assert.equal(forge.submitCount, 0);
  assert.ok(blocked.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(blocked.legal_actions.some(({ type }) => type === "cancel"));
});

test("GitHub target movement invalidates semantic review authority without losing history", async (t) => {
  let moved = false;
  const forge = githubForge({
    onRead() {
      return moved
        ? githubReviewTarget({ headSha: "f".repeat(40) }).snapshot
        : githubReviewTarget().snapshot;
    },
    onCreate() {
      throw Object.assign(new Error("creation response was lost"), {
        code: "github_review_receipt_ambiguous",
      });
    },
  });
  const { runtime, launch, target } = await launchGitHubPendingScenario(t, { forge });
  const checkpoint = await driveToAction(runtime, launch.run_id, "checkpoint_decision");
  assert.equal(runtime.command({ ...checkpoint, decision: "approve" }).accepted, true);
  const uncertain = await waitForProjection(runtime, launch.run_id, (projection) =>
    forge.createCount === 1 && projection.effects?.some(({ card_id: cardId, status }) =>
      cardId === "review-github-pending" && status === "unresolved"));
  const subjectId = reviewSubjectId(target);
  const beforeMovement = runtime.query({ review_id: subjectId });
  moved = true;
  const recovery = uncertain.legal_actions.find(({ type }) => type === "recovery");
  assert.equal(runtime.command(recovery).accepted, true);
  const blocked = await waitForProjection(runtime, launch.run_id, (projection) =>
    projection.effects?.some(({ card_id: cardId, last_observation: observation }) =>
      cardId === "review-github-pending" &&
      observation?.provider_observation?.code === "github_review_target_moved"));

  const invalidated = runtime.query({ review_id: subjectId });
  assert.equal(invalidated.status, "invalidated");
  assert.equal(invalidated.posture, "blocked");
  assert.equal(invalidated.automated_completion, false);
  assert.equal(invalidated.approval, "blocked");
  assert.equal(invalidated.integration_authorized, false);
  assert.equal(invalidated.merge_authorized, false);
  assert.equal(invalidated.tracker_completion_authorized, false);
  assert.equal(invalidated.remote_submission_authorized, false);
  assert.deepEqual(invalidated.findings, beforeMovement.findings);
  assert.equal(invalidated.review_authority_watermark, beforeMovement.watermark);
  assert.equal(invalidated.invalidation.code, "github_review_target_moved");
  assert.equal(invalidated.invalidation.run_authority_watermark, blocked.watermark);
  assert.ok(invalidated.legal_actions.some(({ type }) => type === "recovery"));
  assert.ok(invalidated.legal_actions.some(({ type }) => type === "cancel"));
  assert.equal(
    invalidated.legal_actions.some(({ type }) =>
      ["operation_execute", "submit", "approve", "request_changes", "delete"].includes(type)),
    false,
  );
  const watched = await runtime.watch({ review_id: subjectId }).next();
  assert.equal(watched.value.status, "invalidated");
  assert.equal(watched.value.invalidation.run_authority_watermark, blocked.watermark);
  assert.deepEqual(watched.value.legal_actions, invalidated.legal_actions);
});

test("FlowRuntime launch rechecks candidate fingerprint and owning seal watermark", () => {
  const candidate = reviewCandidate();
  const facts = reviewRuntimeFacts();
  const baseAuthority = createInMemoryReviewAuthority();
  let candidateProjection = candidateAuthorityProjection(candidate, DIGEST("c"));
  const reviewAuthority = Object.freeze({
    ...baseAuthority,
    query(request = {}) {
      if (request.subject_id === candidate.candidate_id) return candidateProjection;
      return baseAuthority.query(request);
    },
  });
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority,
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const inputs = reviewInputsForCandidate(candidate);
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  assert.deepEqual(prepared.required_authorities.map(({ id }) => id), [
    "contract:facts",
    "generation:facts",
    "resource:facts",
    "route:facts",
  ]);
  assert.equal(prepared.required_authorities.every(({ observation }) =>
    observation.status === "available" && observation.watermark.startsWith("sha256:")), true);

  candidateProjection = candidateAuthorityProjection({
    ...candidate,
    candidate_fingerprint: DIGEST("d"),
  }, DIGEST("c"));
  const staleFingerprint = runtime.launch(reviewLaunchRequest(prepared));
  assert.equal(staleFingerprint.code, "candidate_fingerprint_mismatch");
  assert.equal(staleFingerprint.authority_watermark, DIGEST("c"));
  assert.equal(staleFingerprint.authority_watermark_domain, "review");

  candidateProjection = candidateAuthorityProjection(candidate, DIGEST("d"));
  const staleWatermark = runtime.launch(reviewLaunchRequest(prepared));
  assert.equal(staleWatermark.code, "stale_candidate_authority_watermark");
  assert.equal(staleWatermark.authority_watermark, DIGEST("d"));
  assert.deepEqual(staleWatermark.legal_actions, []);

  candidateProjection = {
    ...candidateAuthorityProjection(candidate, DIGEST("c")),
    subject_id: "candidate:other",
  };
  const staleId = runtime.launch(reviewLaunchRequest(prepared));
  assert.equal(staleId.code, "candidate_authority_target_mismatch");

  const baseDefinition = createReviewDefinition();
  const multiTargetDefinition = {
    ...baseDefinition,
    id: "review-multi-target/v1",
    compile(request) {
      const proposal = baseDefinition.compile(request);
      const critic = proposal.graph.cards.find(({ id }) => id === "review-critic");
      critic.inputs.target = {
        ...critic.inputs.target,
        candidate_authority_watermark: DIGEST("e"),
      };
      return proposal;
    },
  };
  candidateProjection = candidateAuthorityProjection(candidate, DIGEST("c"));
  const multiTargetRuntime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority,
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: {
      "review-multi-target/v1": multiTargetDefinition,
    },
  });
  const multiTargetPrepared = multiTargetRuntime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review-multi-target/v1",
    inputs,
    explicit_facts: facts,
  });
  const secondTargetStale = multiTargetRuntime.launch(
    reviewLaunchRequest(multiTargetPrepared),
  );
  assert.equal(secondTargetStale.code, "stale_candidate_authority_watermark");
});

test("review/v1 absent launch rechecks the current shipped route provider", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-review-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("review-provider-boot", "review-provider-process"),
  });
  t.after(() => runAuthority.close());
  const candidate = reviewCandidate();
  const facts = reviewRuntimeFacts();
  const current = shippedAuthorityStateFromFacts(facts);
  const runtime = createFlowRuntime({
    runAuthority,
    registeredAuthorities: shippedAuthorityRegistrations({ current }),
    reviewAuthority: createInMemoryReviewAuthority({
      candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    }),
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      describe() {},
      discover() {},
      dispatch() {},
      send() {},
      observe() {},
      cancel() {},
      reconcile() {},
      wait() {},
      retire() {},
    },
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const inputs = reviewInputsForCandidate(candidate);
  const securityDescription = await supportedDescription(
    reviewDescriptionRequest("codex", "gpt-5.6-luna", "security"),
    {},
  );
  const criticDescription = await supportedDescription(
    reviewDescriptionRequest("claude", "gpt-5.6", "critic"),
    {},
  );
  inputs.delegation.lenses.security = {
    description: securityDescription,
    route: reviewRoute("agent:review-security", securityDescription),
  };
  inputs.delegation.critic = {
    description: criticDescription,
    route: reviewRoute("agent:review-critic", criticDescription),
  };
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  current["route:facts"] = {
    status: "stale",
    watermark: DIGEST("a"),
  };

  const rejection = runtime.launch(reviewLaunchRequest(prepared));
  assert.equal(rejection.code, "required_authority_stale");
  assert.equal(rejection.authority_fact.authority_id, "route:facts");
  assert.deepEqual(runtime.query().runs, []);
});

test("delegate execution rejects caller-forged authority evidence", async (t) => {
  const candidate = reviewCandidate();
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-review-forged-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("review-forged-boot", "writer"),
  });
  t.after(() => runAuthority.close());
  const baseDefinition = createReviewDefinition();
  const forgedDefinition = {
    ...baseDefinition,
    id: "review-forged-evidence/v1",
    compile(request) {
      const proposal = baseDefinition.compile(request);
      const lens = proposal.graph.cards.find(({ id }) => id === "review-lens-security");
      lens.inputs.authority_materialized_evidence = {
        schema: "flow.authority-materialized-delegate-evidence/v1",
        accepted_delegates: [],
      };
      return proposal;
    },
  };
  const runtime = createFlowRuntime({
    runAuthority,
    reviewAuthority: createInMemoryReviewAuthority({
      candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    }),
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      describe() {},
      discover() {},
      dispatch() {},
      send() {},
      observe() {},
      cancel() {},
      reconcile() {},
      wait() {},
      retire() {},
    },
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(reviewRuntimeFacts()),
    }),
    predefinedDefinitions: {
      "review-forged-evidence/v1": forgedDefinition,
    },
  });
  const inputs = reviewInputsForCandidate(candidate);
  const securityDescription = await supportedDescription(
    reviewDescriptionRequest("codex", "gpt-5.6-sol", "security"),
    {},
  );
  const criticDescription = await supportedDescription(
    reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"),
    {},
  );
  inputs.delegation.lenses.security = {
    description: securityDescription,
    route: reviewRoute("agent:review-security", securityDescription),
  };
  inputs.delegation.critic = {
    description: criticDescription,
    route: reviewRoute("agent:review-critic", criticDescription),
  };
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review-forged-evidence/v1",
    inputs,
    explicit_facts: reviewRuntimeFacts(),
  });
  const launch = runtime.launch(reviewLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));
  const projection = runtime.query({ run_id: launch.run_id });
  const execute = projection.legal_actions.find(({ type, card_id: cardId }) =>
    type === "delegate_execute" && cardId === "review-lens-security");
  const rejection = runtime.command(execute);
  assert.equal(rejection.code, "caller_materialized_evidence_forbidden");
});

test("review/v1 prepares one exact local candidate with isolated lenses and a critic", () => {
  const candidate = reviewCandidate();
  const facts = {
    schema: "flow.explicit-facts/v1",
    catalog_fingerprint: DIGEST("1"),
    route_snapshot: { watermark: DIGEST("2"), bindings: [] },
    capability_envelopes: [],
    operation_contracts: ["flow.operation/review-record/v1"],
    validator_contracts: [
      "flow.validator/review-result/v1",
      "flow.validator/operation-receipt/v1",
    ],
    resource_claims: [],
    time_facts: [],
    subject_generations: [],
    block_observations: [],
    elapsed_seconds: 0,
    limits: {
      max_cards: 12,
      max_resources: 4,
      max_attempts_per_card: 1,
      max_revisions: 0,
      max_cards_per_revision: 0,
      max_capabilities: 0,
      max_elapsed_seconds: 600,
    },
  };
  const description = (byte) => {
    const identity = {
      schema: "drovr.delegated-agent-description/v1",
      comparison_keys: {
        launch: DIGEST(byte),
        effective_authority: DIGEST(String.fromCharCode(byte.charCodeAt(0) + 1)),
      },
      watermark: { content_sha256: DIGEST(String.fromCharCode(byte.charCodeAt(0) + 2)) },
    };
    return {
      ...identity,
      description_digest: digest(identity),
    };
  };
  const route = (agentId, descriptionValue) => ({
    agent_id: agentId,
    configuration_watermark: descriptionValue.watermark.content_sha256,
    description_digest: descriptionValue.description_digest,
    launch_comparison_key: descriptionValue.comparison_keys.launch,
  });
  const lensSecurityDescription = description("3");
  const lensCorrectnessDescription = description("4");
  const criticDescription = description("7");
  const inputs = {
    schema: "flow.review-request/v1",
    target: {
      schema: "flow.review-local-candidate/v1",
      candidate,
      candidate_fingerprint: candidate.candidate_fingerprint,
      candidate_authority_watermark: DIGEST("c"),
      lifecycle_generation: 4,
    },
    lenses: ["security", "correctness"],
    delegation: {
      schema: "flow.review-delegation-bindings/v1",
      lenses: {
        security: {
          description: lensSecurityDescription,
          route: route("agent:review-security", lensSecurityDescription),
        },
        correctness: {
          description: lensCorrectnessDescription,
          route: route("agent:review-correctness", lensCorrectnessDescription),
        },
      },
      critic: {
        description: criticDescription,
        route: route("agent:review-critic", criticDescription),
      },
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });

  assert.equal(prepared.definition.id, "review/v1");
  const cards = new Map(prepared.graph.cards.map((card) => [card.id, card]));
  assert.equal(cards.get("review-lens-security").executor.kind, "delegate");
  assert.equal(cards.get("review-lens-correctness").executor.kind, "delegate");
  assert.equal(cards.get("review-critic").executor.kind, "delegate");
  assert.deepEqual(cards.get("review-critic").dependencies, [
    "review-lens-correctness",
    "review-lens-security",
  ]);
  assert.equal(cards.get("review-critic").inputs.finding_lens_join, "all_enabled");
  assert.notEqual(
    cards.get("review-critic").route.agent_id,
    cards.get("review-lens-security").route.agent_id,
  );
  assert.equal(cards.get("review-record").inputs.completion_authority, "automated_only");

  const forgedCard = structuredClone(cards.get("review-record"));
  forgedCard.inputs.lenses = ["security", "unregistered-lens"];
  forgedCard.inputs.delegate_evidence_card_ids = [
    "review-lens-security",
    "review-lens-unregistered-lens",
    "review-critic",
  ];
  const registration = createReviewOperationRegistration({
    reviewAuthority: createInMemoryReviewAuthority(),
  });
  assert.throws(
    () => registration.validateCard(forgedCard),
    /not bound to ReviewAuthority/u,
  );
});

test("review artifacts are deterministic and preserve findings, provenance, and watermark", () => {
  const candidate = reviewCandidate();
  const sourceWatermark = `sha256:${"1".repeat(64)}`;
  const summary = buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: {
      security: reviewResult("security"),
    },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: sourceWatermark,
    findingCap: 1,
  });
  assert.equal(summary.posture, "findings");
  const watermark = `sha256:${"2".repeat(64)}`;
  const provenance = {
    operation_contract: "flow.operation/review-record/v1",
    operation_idempotency_key: "idempotency:review",
    run_id: "run:review",
    operation_effect_id: "effect:review",
    operation_attempt_id: "run:review:review-record:attempt:1",
  };
  const first = renderReviewArtifacts({ summary, watermark, provenance });
  const second = renderReviewArtifacts({ summary, watermark, provenance });
  assert.deepEqual(first, second);
  assert.match(first.formats.json, new RegExp(watermark));
  assert.match(first.formats.json, /operation_effect_id/);
  assert.match(first.formats.markdown, /effect:review/);
  assert.match(first.formats.html, /effect:review/);
  assert.match(first.formats.markdown, /flow\.operation\/review-record\/v1/);
  assert.match(first.formats.markdown, /<!-- flow\.review-artifact-markdown\/v1 -->/u);
  assert.match(first.formats.html, /flow\.operation\/review-record\/v1/);
  assert.match(first.formats.markdown, /idempotency:review/);
  assert.match(first.formats.html, /idempotency:review/);
  assert.match(first.formats.markdown, /automated completion is not approval/);
  assert.match(first.formats.markdown, /security finding/);
  assert.equal(first.formats.html.includes(`data-watermark="${watermark}"`), true);
  assert.match(first.formats.html, new RegExp(`data-watermark="${watermark}"`));
  assert.equal(first.digests.json, digest(first.formats.json));
  assert.equal(first.digests.markdown, digest(first.formats.markdown));
  assert.equal(first.digests.html, digest(first.formats.html));

  const incompleteSummary = buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: {
      security: reviewResult("security", {
        coverage: { status: "degraded", reason: "bounded_timeout" },
        findings: [],
      }),
    },
    criticResult: reviewResult("critic", {
      coverage: { status: "unavailable", reason: "delegate_unavailable" },
      findings: [],
    }),
    sourceAuthorityWatermark: sourceWatermark,
    urgencyFloor: "high",
  });
  const incomplete = renderReviewArtifacts({
    summary: incompleteSummary,
    watermark,
    provenance,
  });
  assert.match(incomplete.formats.markdown, /Urgency floor: high/u);
  assert.match(incomplete.formats.markdown, /## Coverage/u);
  assert.match(incomplete.formats.markdown, /Lens security: degraded \(bounded_timeout\)/u);
  assert.match(incomplete.formats.markdown, /Critic: unavailable \(delegate_unavailable\)/u);
  assert.match(incomplete.formats.html, /bounded_timeout/u);
  assert.match(incomplete.formats.html, /delegate_unavailable/u);
  assert.deepEqual(
    renderReviewArtifacts({ summary: incompleteSummary, watermark, provenance }),
    incomplete,
  );
  assert.throws(
    () => renderReviewArtifacts({
      summary,
      watermark,
      provenance: {
        ...provenance,
        operation_contract: "flow.operation/caller-supplied/v1",
      },
    }),
    (error) => error.code === "invalid_render_input",
  );

  const repeatedByCritic = buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: { security: reviewResult("security") },
    criticResult: reviewResult("critic", {
      findings: JSON.parse(reviewResult("security")).findings,
    }),
    sourceAuthorityWatermark: sourceWatermark,
  });
  assert.equal(repeatedByCritic.findings.length, 1);
});

test("ReviewAuthority replays exact records, fences target and lifecycle drift, and exposes a watermarked watch", async () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
    targetObservationAdapter: reviewTargetObservationAdapter(candidate),
  });
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority: authority,
  });
  assert.equal(authority.command(command).accepted, true);
  const replay = authority.command(command);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  const replayWithValidationObservation = authority.command({
    ...command,
    evidence_validation: { observed: true },
  });
  assert.equal(replayWithValidationObservation.accepted, true);
  assert.equal(replayWithValidationObservation.replayed, true);

  const reviewId = reviewSubjectId({
    candidate,
    lifecycle_generation: 4,
  });
  const projection = runtime.query({ review_id: reviewId });
  assert.equal(projection.schema, "flow.review-projection/v1");
  assert.equal(projection.watermark, command.artifacts.watermark);
  assert.equal(projection.authority_watermark, projection.watermark);
  assert.equal(projection.authority_watermark_domain, "review");
  assert.equal(projection.candidate_authority_watermark, DIGEST("c"));
  assert.equal(
    projection.summary.candidate_authority_watermark,
    projection.candidate_authority_watermark,
  );
  assert.equal(
    JSON.parse(projection.artifacts.formats.json).provenance.candidate_authority_watermark,
    projection.candidate_authority_watermark,
  );
  assert.equal(projection.append_only_event_count, 1);
  assert.deepEqual(projection.command_receipts, [{
    schema: "work.idempotency-receipt/v1",
    command_id: command.command_id,
    command_digest: idempotencyCommandDigest(command),
  }]);
  assert.equal(projection.automated_completion, true);
  assert.deepEqual(projection.legal_actions, []);
  assert.deepEqual(
    projection.approval,
    "not_requested",
  );
  assert.deepEqual(reviewCompletionAuthority(), {
    automated_completion: true,
    approval: "not_requested",
    integration_authorized: false,
    merge_authorized: false,
    tracker_completion_authorized: false,
    remote_submission_authorized: false,
  });

  const watch = runtime.watch({ review_id: reviewId });
  const watched = await watch.next();
  assert.equal(watched.value.watermark, projection.watermark);
  await watch.return();
  const queryWatch = runtime.watch({
    schema: "flow.watch/v1",
    query: "review",
    subject_id: reviewId,
  });
  assert.equal((await queryWatch.next()).value.watermark, projection.watermark);
  await queryWatch.return();

  const stale = authority.command({
    ...command,
    command_id: "review-record:stale-watermark",
    expected_watermark: `sha256:${"3".repeat(64)}`,
  });
  assert.equal(stale.code, "stale_authority_watermark");
  const targetMismatch = authority.command({
    ...command,
    command_id: "review-record:target-mismatch",
    expected_watermark: projection.watermark,
    candidate_fingerprint: `sha256:${"4".repeat(64)}`,
  });
  assert.equal(targetMismatch.code, "review_target_mismatch");
  const lifecycleMismatch = authority.command({
    ...command,
    command_id: "review-record:lifecycle-mismatch",
    expected_watermark: projection.watermark,
    lifecycle_generation: 5,
  });
  assert.equal(lifecycleMismatch.code, "review_target_mismatch");
  const conflict = authority.command({
    ...command,
    summary: { ...command.summary, posture: "blocked" },
  });
  assert.equal(conflict.code, "idempotency_conflict");
});

test("ReviewAuthority serializes same-watermark writers and preserves stale history", async () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
    targetObservationAdapter: reviewTargetObservationAdapter(candidate),
  });
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority: authority,
  });

  const staleCommand = {
    ...command,
    command_id: "review-record:concurrent-stale-writer",
  };
  const [writerA, writerB] = await Promise.all([
    Promise.resolve().then(() => authority.command(command)),
    Promise.resolve().then(() => authority.command(staleCommand)),
  ]);
  assert.equal(writerA.accepted, true);
  assert.equal(writerA.created, true);
  assert.equal(writerB.code, "stale_authority_watermark");

  const reviewId = reviewSubjectId({ candidate, lifecycle_generation: 4 });
  const committed = runtime.query({ review_id: reviewId });
  assert.equal(committed.append_only_event_count, 1);
  assert.deepEqual(committed.command_receipts, [{
    schema: "work.idempotency-receipt/v1",
    command_id: command.command_id,
    command_digest: idempotencyCommandDigest(command),
  }]);

  assert.equal(writerB.authority_watermark, committed.authority_watermark);
  assert.deepEqual(writerB.legal_actions, committed.legal_actions);

  const afterRejection = runtime.query({ review_id: reviewId });
  assert.equal(afterRejection.authority_watermark, committed.authority_watermark);
  assert.equal(afterRejection.append_only_event_count, 1);
  assert.deepEqual(afterRejection.command_receipts, committed.command_receipts);
});

test("durable review fold chains event watermarks and rebuilds artifacts after restart", () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const body = {
    schema: "flow.review-record/v1",
    review_id: command.subject_id,
    candidate_fingerprint: command.candidate_fingerprint,
    candidate_authority_watermark: command.candidate_authority_watermark,
    lifecycle_generation: command.lifecycle_generation,
    candidate: command.candidate,
    summary: command.summary,
    automated_evidence: command.automated_evidence,
    artifacts: command.artifacts,
    source_authority_watermark: command.source_authority_watermark,
    source_run_id: command.source_run_id,
    operation_contract: command.operation_contract,
    operation_effect_id: command.operation_effect_id,
    operation_attempt_id: command.operation_attempt_id,
    operation_idempotency_key: command.operation_idempotency_key,
  };
  const recordWatermark = reviewEventWatermark({
    previousWatermark: EMPTY_WATERMARK,
    event: reviewRecordWatermarkIdentity(body),
  });
  assert.equal(command.artifacts.watermark, recordWatermark);
  const records = [{
    payload: {
      type: "review_recorded",
      body,
      watermark: recordWatermark,
      command_receipt: {
        schema: "work.idempotency-receipt/v1",
        command_id: command.command_id,
        command_digest: idempotencyCommandDigest(command),
      },
    },
  }];
  const physicalHead = DIGEST("f");
  const recorded = foldWorkStream("review", command.subject_id, records, physicalHead);
  assert.equal(recorded.watermark, recordWatermark);
  assert.notEqual(recorded.watermark, physicalHead);
  assert.equal(recorded.artifacts.watermark, recorded.watermark);
  assert.equal(
    recorded.artifacts.provenance.review_authority_watermark,
    recorded.watermark,
  );

  const observedCandidateFingerprint = DIGEST("d");
  const observedLifecycleGeneration = 5;
  const observation = buildReviewTargetObservation({
    subjectId: command.subject_id,
    candidateId: candidate.candidate_id,
    candidateFingerprint: observedCandidateFingerprint,
    lifecycleGeneration: observedLifecycleGeneration,
    authorityWatermark: DIGEST("a"),
  });
  const invalidationCommand = {
    schema: "work.review-target-invalidation-command/v1",
    type: "review_target_invalidated",
    contract: "work.review/v1",
    subject_id: command.subject_id,
    command_id: `review-target-invalidate:${command.subject_id}:${observedCandidateFingerprint}:5`,
    expected_watermark: recorded.watermark,
    prior_candidate_fingerprint: command.candidate_fingerprint,
    prior_lifecycle_generation: command.lifecycle_generation,
    observed_candidate_fingerprint: observedCandidateFingerprint,
    observed_lifecycle_generation: observedLifecycleGeneration,
    reason: "target_moved",
  };
  const invalidation = buildReviewTargetInvalidationEvent({
    command: invalidationCommand,
    current: recorded,
    authorityObservation: observation,
  });
  assert.equal(invalidation.issue, undefined);
  records.push({ payload: invalidation.event.payload });
  const stale = foldWorkStream("review", command.subject_id, records, physicalHead);
  assert.equal(stale.watermark, invalidation.watermark);
  assert.deepEqual(stale.artifacts, recorded.artifacts);
  assert.equal(stale.artifacts.watermark, recorded.artifacts.watermark);
  assert.equal(
    stale.artifacts.provenance.review_authority_watermark,
    recorded.artifacts.provenance.review_authority_watermark,
  );
  assert.deepEqual(stale.command_receipts.at(-1), {
    schema: "work.idempotency-receipt/v1",
    command_id: invalidationCommand.command_id,
    command_digest: idempotencyCommandDigest(invalidationCommand),
  });

  const refreshCommand = stale.legal_actions[0];
  const refresh = buildReviewTargetRefreshEvent({
    command: refreshCommand,
    current: stale,
    authorityObservation: observation,
  });
  assert.equal(refresh.issue, undefined);
  records.push({ payload: refresh.event.payload });
  const acknowledged = foldWorkStream(
    "review",
    command.subject_id,
    records,
    physicalHead,
  );
  assert.equal(acknowledged.watermark, refresh.watermark);
  assert.notEqual(acknowledged.watermark, physicalHead);
  assert.deepEqual(acknowledged.artifacts, recorded.artifacts);
  assert.equal(acknowledged.artifacts.watermark, recorded.artifacts.watermark);
  assert.equal(
    acknowledged.artifacts.provenance.review_authority_watermark,
    recorded.artifacts.provenance.review_authority_watermark,
  );
  assert.deepEqual(acknowledged.legal_actions, []);
  assert.deepEqual(
    foldWorkStream("review", command.subject_id, records, DIGEST("0")),
    acknowledged,
  );
});

test("durable review fold maps malformed and replay-corrupt events to integrity failures", () => {
  assert.throws(
    () => reviewAuthorityEventWatermark([{
      type: "review_recorded",
      body: {},
      watermark: DIGEST("a"),
    }]),
    (error) => error.code === "review_authority_integrity_failure" &&
      error.reason === "watermark_chain_conflict",
  );
  assert.throws(
    () => reviewAuthorityEventWatermark([{
      type: "review_event_from_the_future",
      watermark: DIGEST("a"),
    }]),
    (error) => error.code === "review_authority_integrity_failure" &&
      error.reason === "unknown_event",
  );
  assert.throws(
    () => foldWorkStream("review", "review:corrupt", [{
      payload: { type: "review_event_from_the_future" },
    }], DIGEST("f")),
    (error) => error.code === "review_authority_integrity_failure" &&
      error.reason === "malformed_event",
  );
});

test("ReviewAuthority invalidates a recorded review when the target moves", async () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
    targetObservationAdapter: reviewTargetObservationAdapter(candidate),
  });
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority: authority,
  });
  assert.equal(authority.command(command).accepted, true);
  const reviewId = reviewSubjectId({ candidate, lifecycle_generation: 4 });
  const before = runtime.query({ review_id: reviewId });
  const observedCandidateFingerprint = DIGEST("d");
  const invalidation = {
    schema: "work.review-target-invalidation-command/v1",
    type: "review_target_invalidated",
    contract: "work.review/v1",
    subject_id: reviewId,
    command_id: `review-target-invalidate:${reviewId}:${observedCandidateFingerprint}:5`,
    expected_watermark: before.watermark,
    prior_candidate_fingerprint: command.candidate_fingerprint,
    prior_lifecycle_generation: command.lifecycle_generation,
    observed_candidate_fingerprint: observedCandidateFingerprint,
    observed_lifecycle_generation: 5,
    reason: "target_moved",
  };

  const noObservationAuthority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
  });
  assert.equal(noObservationAuthority.command(command).accepted, true);
  assert.equal(
    noObservationAuthority.command(invalidation).code,
    "review_target_observation_unavailable",
  );
  const noObservationRuntime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority: noObservationAuthority,
  });
  assert.equal(
    noObservationRuntime.command(invalidation).code,
    "review_target_observation_unavailable",
  );
  const forgedObservationAuthority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
    targetObservationAdapter: {
      observe({ command: observedCommand }) {
        return buildReviewTargetObservation({
          subjectId: observedCommand.subject_id,
          candidateId: candidate.candidate_id,
          candidateFingerprint: observedCommand.prior_candidate_fingerprint,
          lifecycleGeneration: observedCommand.prior_lifecycle_generation,
          authorityWatermark: DIGEST("9"),
        });
      },
    },
  });
  assert.equal(forgedObservationAuthority.command(command).accepted, true);
  assert.equal(
    forgedObservationAuthority.command(invalidation).code,
    "review_target_observation_mismatch",
  );

  const malformed = authority.command({
    ...invalidation,
    command_id: `${invalidation.command_id}:forged`,
    prior_candidate_fingerprint: DIGEST("f"),
  });
  assert.equal(malformed.code, "invalid_review_target_invalidation");
  assert.equal(
    authority.query({ contract: "work.review/v1", subject_id: reviewId }).watermark,
    before.watermark,
  );

  const receipt = runtime.command(invalidation);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.created, true);
  const stale = runtime.query({ review_id: reviewId });
  assert.notEqual(stale.watermark, before.watermark);
  assert.deepEqual(stale.artifacts, before.artifacts);
  assert.equal(stale.artifacts.watermark, before.artifacts.watermark);
  assert.equal(stale.artifacts.provenance.review_authority_watermark,
    before.artifacts.provenance.review_authority_watermark);
  assert.equal(stale.status, "stale");
  assert.equal(stale.current, false);
  assert.equal(stale.evidence_currency, "stale");
  assert.equal(stale.candidate_fingerprint, command.candidate_fingerprint);
  assert.equal(stale.lifecycle_generation, command.lifecycle_generation);
  assert.equal(stale.observed_candidate_fingerprint, observedCandidateFingerprint);
  assert.equal(stale.observed_lifecycle_generation, 5);
  assert.deepEqual(stale.summary, before.summary);
  assert.deepEqual(stale.findings, before.findings);
  assert.deepEqual(stale.automated_evidence, before.automated_evidence);
  assert.equal(stale.approval, "ineligible");
  assert.equal(stale.approval_eligible, false);
  assert.equal(stale.submission_pending, false);
  assert.equal(stale.submission_eligible, false);
  assert.equal(stale.remote_submission_authorized, false);
  assert.equal(stale.integration_eligible, false);
  assert.equal(stale.integration_authorized, false);
  assert.equal(stale.merge_eligible, false);
  assert.equal(stale.merge_authorized, false);
  assert.equal(stale.tracker_completion_eligible, false);
  assert.equal(stale.tracker_completion_authorized, false);
  assert.equal(stale.append_only_event_count, 2);
  assert.equal(stale.command_receipts.length, 2);
  assert.deepEqual(stale.legal_actions, [{
    schema: "work.review-target-refresh-command/v1",
    type: "review_target_refresh",
    contract: "work.review/v1",
    subject_id: reviewId,
    command_id: `review-target-refresh:${reviewId}:${observedCandidateFingerprint}:5`,
    expected_watermark: stale.watermark,
    prior_candidate_fingerprint: command.candidate_fingerprint,
    prior_lifecycle_generation: command.lifecycle_generation,
    observed_candidate_fingerprint: observedCandidateFingerprint,
    observed_lifecycle_generation: 5,
    authority_observation: stale.invalidation.observation,
  }]);
  const refreshReceipt = runtime.command(stale.legal_actions[0]);
  assert.equal(refreshReceipt.accepted, true);
  assert.equal(refreshReceipt.created, true);
  const acknowledged = runtime.query({ review_id: reviewId });
  assert.equal(acknowledged.status, "stale");
  assert.equal(acknowledged.current, false);
  assert.deepEqual(acknowledged.artifacts, before.artifacts);
  assert.equal(acknowledged.artifacts.watermark, before.artifacts.watermark);
  assert.equal(
    acknowledged.artifacts.provenance.review_authority_watermark,
    before.artifacts.provenance.review_authority_watermark,
  );
  assert.equal(acknowledged.append_only_event_count, 3);
  assert.deepEqual(acknowledged.legal_actions, []);
  assert.deepEqual(acknowledged.summary, stale.summary);
  assert.deepEqual(acknowledged.artifacts, stale.artifacts);
  assert.deepEqual(acknowledged.automated_evidence, stale.automated_evidence);
  assert.deepEqual(acknowledged.refresh, {
    schema: "flow.review-target-refresh/v1",
    subject_id: reviewId,
    prior_candidate_fingerprint: command.candidate_fingerprint,
    prior_lifecycle_generation: command.lifecycle_generation,
    observed_candidate_fingerprint: observedCandidateFingerprint,
    observed_lifecycle_generation: 5,
    observation: stale.invalidation.observation,
  });
  const watched = await runtime.watch({ review_id: reviewId }).next();
  assert.deepEqual(watched.value, acknowledged);
});

test("ReviewAuthority accepts fingerprint-only and lifecycle-only target movement", () => {
  const candidate = reviewCandidate();
  const record = reviewRecordCommand(candidate, 4);
  const reviewId = reviewSubjectId({ candidate, lifecycle_generation: 4 });
  const cases = [
    { name: "fingerprint", candidateFingerprint: DIGEST("d"), generation: 4 },
    { name: "lifecycle", candidateFingerprint: candidate.candidate_fingerprint, generation: 5 },
    { name: "both", candidateFingerprint: DIGEST("e"), generation: 6 },
  ];
  for (const scenario of cases) {
    const authority = createInMemoryReviewAuthority({
      candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
      sourceEffectIntentReader: sourceEffectIntentReaderFor(record),
      targetObservationAdapter: reviewTargetObservationAdapter(candidate),
    });
    assert.equal(authority.command(record).accepted, true);
    const before = authority.query({ contract: "work.review/v1", subject_id: reviewId });
    const movement = {
      schema: "work.review-target-invalidation-command/v1",
      type: "review_target_invalidated",
      contract: "work.review/v1",
      subject_id: reviewId,
      command_id: `review-target-invalidate:${reviewId}:${scenario.candidateFingerprint}:${scenario.generation}`,
      expected_watermark: before.watermark,
      prior_candidate_fingerprint: candidate.candidate_fingerprint,
      prior_lifecycle_generation: 4,
      observed_candidate_fingerprint: scenario.candidateFingerprint,
      observed_lifecycle_generation: scenario.generation,
      reason: "target_moved",
    };
    const receipt = authority.command(movement);
    assert.equal(receipt.accepted, true, scenario.name);
    const stale = authority.query({ contract: "work.review/v1", subject_id: reviewId });
    assert.equal(stale.observed_candidate_fingerprint, scenario.candidateFingerprint);
    assert.equal(stale.observed_lifecycle_generation, scenario.generation);
  }
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(record),
  });
  assert.equal(authority.command(record).accepted, true);
  const before = authority.query({ contract: "work.review/v1", subject_id: reviewId });
  const unchanged = {
    schema: "work.review-target-invalidation-command/v1",
    type: "review_target_invalidated",
    contract: "work.review/v1",
    subject_id: reviewId,
    command_id: `review-target-invalidate:${reviewId}:${candidate.candidate_fingerprint}:4`,
    expected_watermark: before.watermark,
    prior_candidate_fingerprint: candidate.candidate_fingerprint,
    prior_lifecycle_generation: 4,
    observed_candidate_fingerprint: candidate.candidate_fingerprint,
    observed_lifecycle_generation: 4,
    reason: "target_moved",
  };
  assert.equal(authority.command(unchanged).code, "invalid_review_target_invalidation");
});

test("ReviewAuthority fences concurrent invalidations and preserves rebuilt stale history", async () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
    targetObservationAdapter: reviewTargetObservationAdapter(candidate),
  });
  assert.equal(authority.command(command).accepted, true);
  const reviewId = reviewSubjectId({ candidate, lifecycle_generation: 4 });
  const before = authority.query({ contract: "work.review/v1", subject_id: reviewId });
  const invalidationA = {
    schema: "work.review-target-invalidation-command/v1",
    type: "review_target_invalidated",
    contract: "work.review/v1",
    subject_id: reviewId,
    command_id: `review-target-invalidate:${reviewId}:${DIGEST("d")}:5`,
    expected_watermark: before.watermark,
    prior_candidate_fingerprint: command.candidate_fingerprint,
    prior_lifecycle_generation: command.lifecycle_generation,
    observed_candidate_fingerprint: DIGEST("d"),
    observed_lifecycle_generation: 5,
    reason: "target_moved",
  };
  const invalidationB = {
    ...invalidationA,
    command_id: `review-target-invalidate:${reviewId}:${DIGEST("e")}:6`,
    observed_candidate_fingerprint: DIGEST("e"),
    observed_lifecycle_generation: 6,
  };
  const [writerA, writerB] = await Promise.all([
    Promise.resolve().then(() => authority.command(invalidationA)),
    Promise.resolve().then(() => authority.command(invalidationB)),
  ]);
  const accepted = [writerA, writerB].filter(({ accepted: value }) => value === true);
  const rejected = [writerA, writerB].find(({ accepted: value }) => value !== true);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.code, "stale_authority_watermark");
  const committed = authority.query({ contract: "work.review/v1", subject_id: reviewId });
  assert.equal(committed.append_only_event_count, 2);
  assert.equal(rejected.authority_watermark, committed.authority_watermark);
  assert.deepEqual(rejected.legal_actions, committed.legal_actions);

  const winningCommand = writerA.accepted === true ? invalidationA : invalidationB;
  const replay = authority.command(winningCommand);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  const tampered = authority.command({
    ...winningCommand,
    observed_candidate_fingerprint: DIGEST("f"),
  });
  assert.equal(tampered.code, "idempotency_conflict");
  const afterRejection = authority.query({
    contract: "work.review/v1",
    subject_id: reviewId,
  });
  assert.deepEqual(afterRejection, committed);
  assert.deepEqual(
    (await authority.watch({ subject_id: reviewId }).next()).value,
    committed,
  );
});

test("ReviewAuthority rejects a non-canonical first-record command id", () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
  });
  const result = authority.command({
    ...command,
    command_id: "review-record:forged-first-record",
  });
  assert.equal(result.code, "invalid_review_record");
});

test("ReviewAuthority never writes a null digest for non-plain commands", () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
  });
  const nonPlainCommand = Object.assign(Object.create({ inherited: true }), command);
  assert.equal(authority.command(nonPlainCommand).accepted, true);
  const projection = authority.query({
    contract: "work.review/v1",
    subject_id: command.subject_id,
  });
  assert.match(projection.command_receipts[0].command_digest, /^sha256:/u);
  const divergentReplay = Object.assign(Object.create({ inherited: true }), {
    ...command,
    summary: { ...command.summary, posture: "blocked" },
  });
  assert.equal(authority.command(divergentReplay).code, "idempotency_conflict");
});

test("ReviewAuthority converts malformed settled evidence into a typed rejection", () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const malformedCommand = {
    ...command,
    summary: {
      ...command.summary,
      enabled_lenses: ["security", "correctness"],
    },
  };
  const sourceEffect = structuredClone(sourceEffectIntentReaderFor(command).query(
    command.source_run_id,
    command.operation_effect_id,
  ));
  const input = sourceEffect.operation_input;
  input.lenses = ["security", "correctness"];
  input.delegate_evidence_card_ids = [
    "review-lens-security",
    "review-lens-correctness",
    "review-critic",
  ];
  input.authority_materialized_evidence.accepted_delegates.splice(1, 0, {
    card_id: "review-lens-correctness",
    evidence: {
      validated_output: {
        schema: "flow.review-result/v1",
        posture: "findings",
        findings: "not-an-array",
      },
    },
  });
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: { query: () => sourceEffect },
  });
  assert.doesNotThrow(() => authority.command(malformedCommand));
  assert.equal(authority.command(malformedCommand).code, "malformed_delegate_result");
});

test("ReviewAuthority rejects a summary mutation that retains original delegate evidence", () => {
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const tamperedSummary = {
    ...command.summary,
    findings: [],
    rendered_findings: [],
    posture: "no_findings",
  };
  const tamperedArtifacts = renderReviewArtifacts({
    summary: tamperedSummary,
    watermark: command.artifacts.watermark,
    provenance: command.artifacts.provenance,
  });
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: sourceEffectIntentReaderFor(command),
  });
  const result = authority.command({
    ...command,
    summary: tamperedSummary,
    artifacts: tamperedArtifacts,
  });
  assert.equal(result.accepted, undefined);
  assert.equal(result.code, "review_summary_mismatch");
});

test("ReviewAuthority binds the exact candidate seal at its command boundary", () => {
  const sealedCandidate = reviewCandidate();
  const { candidate_fingerprint: _sealedFingerprint, ...candidateIdentity } = sealedCandidate;
  const forgedIdentity = {
    ...candidateIdentity,
    artifacts: [{
      ...sealedCandidate.artifacts[0],
      digest: DIGEST("f"),
    }],
  };
  const forgedCandidate = {
    ...forgedIdentity,
    candidate_fingerprint: digest(forgedIdentity),
  };
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(sealedCandidate, DIGEST("c")),
  });
  const result = authority.command(reviewRecordCommand(forgedCandidate, 4));
  assert.equal(result.accepted, undefined);
  assert.equal(result.code, "candidate_fingerprint_mismatch");

  const staleWatermark = authority.command(reviewRecordCommand(sealedCandidate, 4, {
    candidateAuthorityWatermark: DIGEST("d"),
  }));
  assert.equal(staleWatermark.accepted, undefined);
  assert.equal(staleWatermark.code, "stale_candidate_authority_watermark");

  const missingProjection = createInMemoryReviewAuthority();
  const missing = missingProjection.command(reviewRecordCommand(sealedCandidate, 4));
  assert.equal(missing.accepted, undefined);
  assert.equal(missing.code, "candidate_authority_projection_missing");
});

test("ReviewAuthority rejects a structurally valid record without the settled source run intent", () => {
  const candidate = reviewCandidate();
  const authority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
  });
  const result = authority.command(reviewRecordCommand(candidate, 4));
  assert.equal(result.accepted, undefined);
  assert.equal(result.code, "review_source_intent_mismatch");
});

test("review evidence rejects malformed or duplicate findings and incomplete lens joins", () => {
  const candidate = reviewCandidate();
  assert.throws(
    () => parseReviewDelegateResult("not-json", { lens: "security" }),
    (error) => error.code === "malformed_delegate_result",
  );
  assert.throws(
    () => normalizeReviewFindings([
      {
        lens: "security",
        urgency: "high",
        classification: "blocking",
        summary: "same finding",
        detail: "same detail",
      },
      {
        lens: "security",
        urgency: "high",
        classification: "blocking",
        summary: "same finding",
        detail: "same detail",
      },
    ]),
    (error) => error.code === "duplicate_finding",
  );
  assert.throws(
    () => buildReviewSummary({
      candidateFingerprint: candidate.candidate_fingerprint,
      candidateAuthorityWatermark: DIGEST("c"),
      lifecycleGeneration: 4,
      enabledLenses: ["security", "correctness"],
      lensResults: { security: reviewResult("security") },
      criticResult: reviewResult("critic", { findings: [] }),
      sourceAuthorityWatermark: `sha256:${"1".repeat(64)}`,
    }),
    (error) => error.code === "incomplete_lens_join",
  );
});

test("trusted review parsing rejects unsafe finding text and incomplete coverage", () => {
  const result = (overrides = {}) => JSON.stringify({
    schema: "flow.review-result/v1",
    posture: "no_findings",
    findings: [],
    ...overrides,
  });
  for (const findings of [
    [{
      lens: "security",
      urgency: "high",
      classification: "blocking",
      summary: "injected\n# heading",
      detail: "detail",
    }],
    [{
      lens: "security",
      urgency: "high",
      classification: "blocking",
      summary: "```fence```",
      detail: "detail",
    }],
  ]) {
    assert.throws(
      () => parseReviewDelegateResult(result({ findings }), { lens: "security" }),
      (error) => error.code === "malformed_finding",
    );
  }
  for (const coverage of [
    { status: "degraded" },
    { status: "unavailable", reason: "# injected heading" },
  ]) {
    assert.throws(
      () => parseReviewDelegateResult(result({ coverage }), { lens: "security" }),
      (error) => error.code === "malformed_review_coverage",
    );
  }
  assert.deepEqual(
    parseReviewDelegateResult(result({
      coverage: { status: "produced", reason: "legacy optional reason" },
    }), { lens: "security" }).coverage,
    {
      schema: "flow.review-coverage/v1",
      status: "produced",
      reason: null,
    },
  );
});

test("trusted review validator uses the card lens context", () => {
  assert.equal(
    validateReviewDelegateOutput(reviewResult("security"), {
      card_id: "review-lens-security",
    }),
    true,
  );
  assert.equal(
    validateReviewDelegateOutput(reviewResult("correctness"), {
      card_id: "review-lens-security",
    }),
    false,
  );
  assert.equal(
    validateReviewDelegateOutput(JSON.stringify({
      schema: "flow.review-result/v1",
      posture: "findings",
      findings: [{
        lens: "security",
        urgency: "high",
        classification: "blocking",
        summary: "invalid\n# heading",
        detail: "detail",
      }],
    }), {
      card_id: "review-lens-security",
    }),
    false,
  );
});

test("trusted review validator bounds Markdown-controlled cap reasons", () => {
  const output = (capReasons) => JSON.stringify({
    schema: "flow.review-result/v1",
    posture: "no_findings",
    findings: [],
    cap_reasons: capReasons,
  });
  const context = { card_id: "review-lens-security" };
  const boundaryReason = {
    code: "c".repeat(REVIEW_CAP_REASON_CODE_MAX_LENGTH),
    detail: "d".repeat(REVIEW_CAP_REASON_DETAIL_MAX_LENGTH),
  };
  assert.equal(validateReviewDelegateOutput(output([boundaryReason]), context), true);
  for (const capReason of [
    { code: "# heading", detail: "detail" },
    { code: "code", detail: "- list item" },
    { code: "code", detail: "```fence```" },
    { code: "code\ninjected", detail: "detail" },
    {
      code: "c".repeat(REVIEW_CAP_REASON_CODE_MAX_LENGTH + 1),
      detail: "detail",
    },
    {
      code: "code",
      detail: "d".repeat(REVIEW_CAP_REASON_DETAIL_MAX_LENGTH + 1),
    },
  ]) {
    assert.equal(validateReviewDelegateOutput(output([capReason]), context), false);
  }
  const atCountBoundary = Array.from({ length: REVIEW_CAP_REASON_MAX_COUNT }, (_, index) => ({
    code: `reason-${index}`,
    detail: "detail",
  }));
  assert.equal(validateReviewDelegateOutput(output(atCountBoundary), context), true);
  assert.equal(
    validateReviewDelegateOutput(output([
      ...atCountBoundary,
      { code: "reason-overflow", detail: "detail" },
    ]), context),
    false,
  );
});

test("review coverage preserves every lens terminal disposition and stays incomplete", () => {
  const candidate = reviewCandidate();
  const summary = buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security", "correctness", "tests"],
    lensResults: {
      security: reviewResult("security", {
        coverage: { status: "produced" },
        findings: [],
      }),
      correctness: reviewResult("correctness", {
        coverage: { status: "degraded", reason: "bounded_timeout" },
        findings: [],
      }),
      tests: reviewResult("tests", {
        coverage: { status: "unavailable", reason: "delegate_unavailable" },
        findings: [],
      }),
    },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: DIGEST("1"),
  });

  assert.deepEqual(summary.coverage, {
    schema: "flow.review-coverage/v1",
    complete: false,
    lenses: [
      { lens: "correctness", status: "degraded", reason: "bounded_timeout" },
      { lens: "security", status: "produced", reason: null },
      { lens: "tests", status: "unavailable", reason: "delegate_unavailable" },
    ],
    critic: { status: "produced", reason: null },
  });
  assert.equal(summary.posture, "review_incomplete");
  assert.equal(summary.merge_ready, false);
});

test("review coverage ignores opaque evidence.coverage and requires canonical participant shape", () => {
  const parsed = parseReviewDelegateResult(JSON.stringify({
    schema: "flow.review-result/v1",
    findings: [],
    evidence: { coverage: { status: "unavailable", reason: "forged" } },
  }), { lens: "security" });
  assert.deepEqual(parsed.coverage, {
    schema: "flow.review-coverage/v1",
    status: "produced",
    reason: null,
  });
  const summary = buildReviewSummary({
    candidateFingerprint: DIGEST("a"),
    candidateAuthorityWatermark: DIGEST("b"),
    lifecycleGeneration: 1,
    enabledLenses: ["security"],
    lensResults: { security: parsed },
    criticResult: {
      schema: "flow.review-result/v1",
      findings: [],
      coverage: { status: "degraded", reason: "critic_timeout" },
    },
    sourceAuthorityWatermark: DIGEST("c"),
  });
  assert.deepEqual(summary.coverage.critic, {
    status: "degraded",
    reason: "critic_timeout",
  });
  assert.equal(summary.coverage.complete, false);
});

test("review delegate coverage cannot be upgraded by an authority disposition", () => {
  const degraded = materializeReviewDelegateResult({
    evidence: {
      validated_output: reviewResult("security", {
        posture: "review_incomplete",
        findings: [],
        coverage: { status: "degraded", reason: "delegate_self_report" },
      }),
      authority_terminal_disposition: {
        schema: "flow.review-terminal-disposition/v1",
        authority: "RunAuthority",
        status: "produced",
        reason: null,
      },
    },
  });
  assert.equal(degraded.posture, "review_incomplete");
  assert.deepEqual(degraded.coverage, {
    schema: "flow.review-coverage/v1",
    status: "degraded",
    reason: "delegate_self_report",
  });

  const unavailableCritic = materializeReviewDelegateResult({
    evidence: {
      validated_output: reviewResult("critic", {
        posture: "no_findings",
        findings: [],
      }),
      authority_terminal_disposition: {
        schema: "flow.review-terminal-disposition/v1",
        authority: "RunAuthority",
        status: "unavailable",
        reason: "delegated_agent_port_unavailable",
      },
    },
  });
  assert.equal(unavailableCritic.posture, "review_incomplete");
  assert.deepEqual(unavailableCritic.coverage, {
    schema: "flow.review-coverage/v1",
    status: "unavailable",
    reason: "delegated_agent_port_unavailable",
  });
});

test("equal-rank authority coverage reason overrides delegate self-report", () => {
  const result = materializeReviewDelegateResult({
    card_id: "review-lens-security",
    evidence: {
      validated_output: reviewResult("security", {
        posture: "review_incomplete",
        findings: [],
        coverage: { status: "degraded", reason: "delegate_reason" },
      }),
      authority_terminal_disposition: {
        schema: "flow.review-terminal-disposition/v1",
        authority: "RunAuthority",
        status: "degraded",
        reason: "authority_reason",
      },
    },
  });
  assert.deepEqual(result.coverage, {
    schema: "flow.review-coverage/v1",
    status: "degraded",
    reason: "authority_reason",
  });
});

test("FlowRuntime reserves the trusted review validator against an always-true injection", async (t) => {
  const candidate = reviewCandidate();
  const [securityDescription, criticDescription] = await Promise.all([
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-sol", "security"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-review-validator-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("review-validator-boot", "review-validator"),
  });
  t.after(() => runAuthority.close());
  const reviewAuthority = createInMemoryReviewAuthority({
    candidateProjection: candidateAuthorityProjection(candidate, DIGEST("c")),
    sourceEffectIntentReader: getRunEffectIntentReader({ runAuthority }),
  });
  const malformedOutput = JSON.stringify({
    schema: "flow.review-result/v1",
    posture: "no_findings",
    findings: [],
    cap_reasons: [{ code: "cap", detail: "# heading injection" }],
  });
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    describe() {},
    discover() {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "proven_absent",
        watermark: null,
        delegation: null,
        turn: null,
        legal_next_actions: ["dispatch"],
      };
    },
    dispatch(request) {
      const critic = request.agent_id === "agent:review-critic";
      const output = critic ? reviewResult("critic", { findings: [] }) : malformedOutput;
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
    wait() {},
    retire({ agent_id: agentId, turn_id: turnId }) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: { schema: "drovr.agent-authority-watermark/v1", agent_id: agentId },
        delegation: { agent_id: agentId },
        turn: { id: turnId, status: "completed" },
        legal_next_actions: [],
      };
    },
  };
  const facts = reviewRuntimeFacts();
  facts.limits.max_cards = 4;
  const inputs = {
    schema: "flow.review-request/v1",
    target: {
      schema: "flow.review-local-candidate/v1",
      candidate,
      candidate_fingerprint: candidate.candidate_fingerprint,
      candidate_authority_watermark: DIGEST("c"),
      lifecycle_generation: 4,
    },
    lenses: ["security"],
    delegation: {
      schema: "flow.review-delegation-bindings/v1",
      lenses: {
        security: {
          description: securityDescription,
          route: reviewRoute("agent:review-security", securityDescription),
        },
      },
      critic: {
        description: criticDescription,
        route: reviewRoute("agent:review-critic", criticDescription),
      },
    },
  };
  const runtime = createFlowRuntime({
    runAuthority,
    reviewAuthority,
    delegatedAgentPort,
    delegateOutputValidators: {
      [REVIEW_DELEGATE_OUTPUT_VALIDATOR]: { validate: () => true },
    },
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  const launch = runtime.launch(reviewLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = runtime.query({ run_id: launch.run_id });
    if (projection.phase === "succeeded") break;
    const action = projection.legal_actions?.find(({ type }) => [
      "checkpoint_decision",
      "delegate_execute",
      "operation_execute",
      "recovery",
    ].includes(type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  const review = runtime.query({
    review_id: `review:${candidate.candidate_fingerprint}:4`,
  });
  assert.deepEqual(review.summary.coverage.lenses, [{
    lens: "security",
    status: "unavailable",
    reason: "independent_validation_failed",
  }]);
  assert.equal(review.findings.length, 0);
  assert.equal(review.posture, "review_incomplete");
});

test("review projection preserves legacy recorded artifacts across later event folds", () => {
  const command = reviewRecordCommand(reviewCandidate(), 4);
  const legacySummary = { ...command.summary };
  delete legacySummary.coverage;
  delete legacySummary.orientation;
  delete legacySummary.diagrams;
  const legacyArtifacts = {
    schema: "flow.review-artifacts/v1",
    watermark: DIGEST("a"),
    formats: { markdown: "legacy recorded markdown" },
    digests: { markdown: DIGEST("b") },
    provenance: { operation_contract: "flow.operation/review-record/v1" },
  };
  const body = {
    ...command,
    review_id: command.subject_id,
    summary: legacySummary,
    artifacts: legacyArtifacts,
  };
  const projection = projectReviewRecord(body, DIGEST("f"), [
    { type: "review_recorded", body, watermark: DIGEST("f") },
  ]);
  assert.deepEqual(projection.artifacts, legacyArtifacts);
  assert.equal(projection.watermark, DIGEST("f"));
  assert.notEqual(projection.artifacts.watermark, projection.watermark);
  assert.equal(projection.coverage, undefined);
  assert.deepEqual(projection.summary, legacySummary);
});

test("implicit single-line finding anchors reject reversed end columns", () => {
  assert.throws(
    () => normalizeReviewFindings([{
      lens: "security",
      urgency: "high",
      classification: "blocking",
      summary: "reversed columns",
      detail: "the end column precedes the start column",
      location: {
        path: "src/review.mjs",
        start_line: 8,
        start_column: 9,
        end_column: 3,
      },
    }]),
    (error) => error.code === "malformed_finding",
  );
});

test("review urgency presets retain native urgency and filter below the selected floor", () => {
  const candidate = reviewCandidate();
  const findings = ["critical", "high", "medium", "low", "info"].map((urgency) => ({
    lens: "security",
    urgency,
    classification: urgency === "critical" ? "blocking" : "non_blocking",
    summary: `${urgency} concern`,
    detail: `${urgency} detail`,
  }));
  const build = (urgencyFloor) => buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: {
      security: reviewResult("security", { findings }),
    },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: DIGEST("1"),
    urgencyFloor,
  });

  const hotfix = build("hotfix");
  const fast = build("fast");
  const standard = build("standard");
  assert.equal(hotfix.urgency_floor, "critical");
  assert.equal(fast.urgency_floor, "high");
  assert.equal(standard.urgency_floor, "info");
  assert.deepEqual(hotfix.findings.map(({ urgency }) => urgency), ["critical"]);
  assert.deepEqual(fast.findings.map(({ urgency }) => urgency), ["critical", "high"]);
  assert.deepEqual(standard.findings.map(({ urgency }) => urgency), findings.map(
    ({ urgency }) => urgency,
  ));
  assert.deepEqual(fast.lens_results[0].findings.map(({ urgency }) => urgency), [
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ]);
  assert.equal(
    fast.lens_results[0].findings.find(({ urgency }) => urgency === "low").finding_id,
    standard.lens_results[0].findings.find(({ urgency }) => urgency === "low").finding_id,
  );
  assert.deepEqual(fast.cap_reasons.find(({ code }) => code === "urgency_floor"), {
    code: "urgency_floor",
    detail: "3 findings omitted below the high urgency floor",
    count: 3,
    omitted_urgencies: ["medium", "low", "info"],
  });
});

test("review finding identity deduplicates sources while preserving anchors and general findings", () => {
  const candidate = reviewCandidate();
  const anchored = {
    lens: "security",
    urgency: "high",
    classification: "blocking",
    summary: "anchored concern",
    detail: "anchored detail",
    location: { path: "src/review.mjs", start_line: 8, end_line: 8 },
  };
  const inline = {
    ...anchored,
    location: undefined,
    inline: { path: "src/review.mjs", start_line: 8, end_line: 8 },
  };
  const general = {
    ...anchored,
    location: undefined,
    summary: "general concern",
    detail: "general detail",
  };
  const build = (criticFindings) => buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: {
      security: reviewResult("security", { findings: [anchored] }),
    },
    criticResult: reviewResult("critic", { findings: criticFindings }),
    sourceAuthorityWatermark: DIGEST("1"),
  });
  const first = build([inline, general]);
  const second = build([general, inline]);

  assert.deepEqual(first.findings, second.findings);
  assert.equal(first.findings.length, 2);
  const anchoredFinding = first.findings.find(({ location }) => location !== null);
  const generalFinding = first.findings.find(({ location }) => location === null);
  assert.equal(anchoredFinding.location.path, "src/review.mjs");
  assert.equal(generalFinding.location, null);
  assert.notEqual(anchoredFinding.finding_id, generalFinding.finding_id);
  assert.throws(
    () => normalizeReviewFindings([{
      ...anchored,
      location: {
        path: "src/review.mjs",
        start_line: 8,
        end_line: 8,
        start_column: 9,
        end_column: 3,
      },
    }]),
    (error) => error.code === "malformed_finding",
  );
});

test("review orientation and diagrams stay human-facing and out of critic evidence", () => {
  const candidate = reviewCandidate();
  const summary = buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: { security: reviewResult("security", { findings: [] }) },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: DIGEST("1"),
    orientation: "The review starts at the authority boundary.",
    diagrams: [{ name: "review path", source: "flowchart LR\n  lens --> critic" }],
  });
  const artifacts = renderReviewArtifacts({
    summary,
    watermark: DIGEST("2"),
    provenance: {
      operation_contract: "flow.operation/review-record/v1",
      operation_idempotency_key: "idempotency:review",
      run_id: "run:review",
      operation_effect_id: "effect:review",
      operation_attempt_id: "run:review:review-record:attempt:1",
    },
  });

  assert.equal(summary.orientation.markdown, "The review starts at the authority boundary.");
  assert.equal(summary.diagrams[0].name, "review path");
  assert.match(artifacts.formats.markdown, /The review starts at the authority boundary/u);
  assert.match(artifacts.formats.markdown, /review path/u);
  assert.equal(summary.automated_evidence.orientation, undefined);
  assert.equal(summary.automated_evidence.diagrams, undefined);
});

test("review cap preserves semantic overflow and renders deterministic urgency order", () => {
  const candidate = reviewCandidate();
  const findings = [
    {
      lens: "security",
      urgency: "low",
      classification: "non_blocking",
      summary: "low overflow",
      detail: "low detail",
    },
    {
      lens: "security",
      urgency: "high",
      classification: "blocking",
      summary: "high retained or overflow",
      detail: "high detail one",
    },
    {
      lens: "security",
      urgency: "critical",
      classification: "blocking",
      summary: "critical retained",
      detail: "critical detail",
    },
    {
      lens: "security",
      urgency: "high",
      classification: "blocking",
      summary: "high overflow",
      detail: "high detail two",
    },
  ];
  const build = (orderedFindings) => buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark: DIGEST("c"),
    lifecycleGeneration: 4,
    enabledLenses: ["security"],
    lensResults: {
      security: reviewResult("security", { findings: orderedFindings }),
    },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: DIGEST("1"),
    findingCap: 2,
  });
  const first = build(findings);
  const second = build([...findings].reverse());
  assert.deepEqual(first.findings, second.findings);
  assert.deepEqual(first.rendered_findings, second.rendered_findings);
  assert.equal(first.findings.length, 4);
  assert.deepEqual(first.rendered_findings.map(({ urgency }) => urgency), [
    "critical",
    "high",
  ]);
  assert.equal(first.rendered_findings.length, 2);
  const capReason = first.cap_reasons.find(({ code }) => code === "finding_cap");
  assert.deepEqual(capReason, {
    code: "finding_cap",
    detail: "2 findings retained outside the rendered cap",
    count: 2,
    overflow_urgencies: ["high", "low"],
  });
  const provenance = {
    operation_contract: "flow.operation/review-record/v1",
    operation_idempotency_key: "idempotency:review",
    run_id: "run:review",
    operation_effect_id: "effect:review",
    operation_attempt_id: "run:review:review-record:attempt:1",
  };
  const firstArtifacts = renderReviewArtifacts({
    summary: first,
    watermark: DIGEST("2"),
    provenance,
  });
  const secondArtifacts = renderReviewArtifacts({
    summary: second,
    watermark: DIGEST("2"),
    provenance,
  });
  assert.equal(firstArtifacts.formats.json, secondArtifacts.formats.json);
  assert.equal(firstArtifacts.formats.markdown, secondArtifacts.formats.markdown);
  assert.equal(firstArtifacts.formats.html, secondArtifacts.formats.html);
});

test("durable ReviewAuthority fails closed when its source intent is missing", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-review-recovery-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const candidate = reviewCandidate();
  const command = reviewRecordCommand(candidate, 4);
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("review-recovery-boot-a", "writer"),
  });
  const firstReviewAuthority = getReviewAuthority({ runAuthority: firstAuthority });
  const missing = firstReviewAuthority.command(command);
  assert.equal(missing.accepted, undefined);
  assert.equal(missing.code, "review_source_intent_mismatch");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("review-recovery-boot-b", "reader"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredReviewAuthority = getReviewAuthority({ runAuthority: recoveredAuthority });
  const missingAfterRecovery = recoveredReviewAuthority.command(command);
  assert.equal(missingAfterRecovery.accepted, undefined);
  assert.equal(missingAfterRecovery.code, "review_source_intent_mismatch");
  const unknown = recoveredReviewAuthority.query({
    contract: "work.review/v1",
    subject_id: command.subject_id,
  });
  assert.equal(unknown.code, "unknown_subject");
});

test("durable GitHub ReviewAuthority rejects forged source identity and evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-github-review-forgery-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-forgery-boot", "writer"),
  });
  t.after(() => runAuthority.close());
  const target = githubReviewTarget();
  const authority = getReviewAuthority({ runAuthority });
  const validCommand = githubReviewRecordCommand(target);
  const forgedSourceRunId = "run:forged";
  const forgedBody = {
    schema: "flow.github-review-record/v1",
    review_id: validCommand.subject_id,
    target: validCommand.target,
    target_fingerprint: validCommand.target_fingerprint,
    target_authority_watermark: validCommand.target_authority_watermark,
    lifecycle_generation: validCommand.lifecycle_generation,
    summary: validCommand.summary,
    automated_evidence: validCommand.automated_evidence,
    source_authority_watermark: validCommand.source_authority_watermark,
    source_run_id: forgedSourceRunId,
    operation_contract: validCommand.operation_contract,
    operation_effect_id: validCommand.operation_effect_id,
    operation_attempt_id: validCommand.operation_attempt_id,
    operation_idempotency_key: validCommand.operation_idempotency_key,
  };
  const forgedWatermark = reviewEventWatermark({
    previousWatermark: validCommand.expected_watermark,
    event: forgedBody,
  });
  const forgedArtifacts = renderReviewArtifacts({
    summary: validCommand.summary,
    watermark: forgedWatermark,
    provenance: {
      ...validCommand.artifacts.provenance,
      run_id: forgedSourceRunId,
    },
  });
  const result = authority.command({
    ...validCommand,
    source_run_id: forgedSourceRunId,
    artifacts: forgedArtifacts,
  });
  assert.equal(result.accepted, undefined);
  assert.equal(result.code, "review_source_intent_mismatch");
});

test("in-memory GitHub ReviewAuthority fails closed without a source intent reader", () => {
  const authority = createInMemoryGitHubReviewAuthority();
  const result = authority.command(githubReviewRecordCommand(githubReviewTarget()));
  assert.equal(result.accepted, undefined);
  assert.equal(result.code, "review_source_intent_mismatch");
});

test("review/v1 runs every enabled lens and a fresh critic through FlowRuntime", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-review-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("review-boot", "review-process"),
  });
  t.after(() => authority.close());

  const candidate = reviewCandidate();
  const descriptions = await Promise.all([
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-sol", "security"), {}),
    supportedDescription(reviewDescriptionRequest("claude", "haiku", "correctness"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-aurora", "tests"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  const [securityDescription, correctnessDescription, testsDescription, criticDescription] = descriptions;
  const candidateProjection = candidateAuthorityProjection(candidate, DIGEST("c"));
  let lifecycleMismatch = false;
  let lifecycleRejection = null;
  let crashAfterReviewRecord = true;
  let firstRecordCommand = null;
  const reviewAuthorityBase = createInMemoryReviewAuthority({
    candidateProjection,
    sourceEffectIntentReader: getRunEffectIntentReader({ runAuthority: authority }),
  });
  const reviewAuthority = Object.freeze({
    ...reviewAuthorityBase,
    command(command) {
      if (firstRecordCommand === null &&
          command?.schema === "work.review-record-command/v1") {
        firstRecordCommand = structuredClone(command);
      }
      if (lifecycleMismatch && command?.schema === "work.review-record-command/v1") {
        lifecycleRejection = {
          code: "review_target_mismatch",
          authority_watermark: DIGEST("e"),
          legal_actions: [],
        };
        return { accepted: false, ...lifecycleRejection };
      }
      const receipt = reviewAuthorityBase.command(command);
      if (crashAfterReviewRecord && command?.schema === "work.review-record-command/v1" &&
          receipt?.accepted === true && receipt?.created === true) {
        crashAfterReviewRecord = false;
        throw new Error("simulated crash after review record append");
      }
      return receipt;
    },
  });
  const facts = dynamicCheckpointProposal().explicit_facts;
  facts.operation_contracts.push("flow.operation/review-record/v1");
  facts.validator_contracts.push(
    "flow.validator/review-result/v1",
    "flow.validator/operation-receipt/v1",
  );
  facts.limits.max_cards = 10;
  facts.limits.max_resources = 2;
  const inputs = {
    schema: "flow.review-request/v1",
    target: {
      schema: "flow.review-local-candidate/v1",
      candidate,
      candidate_fingerprint: candidate.candidate_fingerprint,
      candidate_authority_watermark: DIGEST("c"),
      lifecycle_generation: 4,
    },
    lenses: ["security", "correctness", "tests"],
    urgency: "fast",
    orientation: "The review starts at the authority boundary.",
    diagrams: [{ name: "review path", source: "flowchart LR\n  lens --> critic" }],
    delegation: {
      schema: "flow.review-delegation-bindings/v1",
      lenses: {
        security: {
          description: securityDescription,
          route: reviewRoute("agent:review-security", securityDescription),
        },
        correctness: {
          description: correctnessDescription,
          route: reviewRoute("agent:review-correctness", correctnessDescription),
        },
        tests: {
          description: testsDescription,
          route: reviewRoute("agent:review-tests", testsDescription),
        },
      },
      critic: {
        description: criticDescription,
        route: reviewRoute("agent:review-critic", criticDescription),
      },
    },
  };
  const prompts = [];
  const dispatches = [];
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    describe() {},
    discover() {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "proven_absent",
        watermark: null,
        delegation: null,
        turn: null,
        legal_next_actions: ["dispatch"],
      };
    },
    dispatch(request) {
      dispatches.push(request);
      prompts.push(request.prompt);
      const lens = request.agent_id === "agent:review-critic"
        ? "critic"
        : request.agent_id.endsWith("security") ? "security"
          : request.agent_id.endsWith("tests") ? "tests" : "correctness";
      const coverage = lens === "security"
        ? { status: "degraded", reason: "delegate_self_report" }
        : undefined;
      const output = lens === "critic"
        ? JSON.stringify({
            schema: "flow.review-result/v1",
            posture: "no_findings",
            findings: [],
            evidence: { critic: true },
          })
        : reviewResult(lens, {
            coverage,
            findings: lens === "tests"
              ? []
              : lens === "security"
                ? [{
                    lens,
                    urgency: "high",
                    classification: "blocking",
                    summary: "security finding",
                    detail: "security detail",
                  }, {
                    lens,
                    urgency: "low",
                    classification: "non_blocking",
                    summary: "security lower-priority finding",
                    detail: "security lower-priority detail",
                  }]
                : undefined,
          });
      const completed = completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        output,
        prompt: request.prompt,
        turnId: `turn:${request.caller_key}`,
      });
      if (lens === "correctness") {
        return {
          ...completed,
          status: "still_running",
          turn: { ...completed.turn, status: "working" },
          legal_next_actions: ["wait"],
        };
      }
      if (lens === "tests") {
        return {
          schema: "flow.delegated-agent-lifecycle-projection/v1",
          operation: "dispatch",
          status: "unavailable",
          watermark: null,
          delegation: null,
          turn: null,
          legal_next_actions: [],
        };
      }
      return completed;
    },
    send() {},
    observe() {},
    cancel() {},
    reconcile() {},
    wait({ turn_id: turnId }) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "wait",
        status: "still_running",
        watermark: null,
        delegation: { agent_id: "agent:review-correctness" },
        turn: { id: turnId, status: "working" },
        legal_next_actions: ["wait"],
      };
    },
    retire({ agent_id: agentId, turn_id: turnId }) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: { schema: "drovr.agent-authority-watermark/v1", agent_id: agentId },
        delegation: { agent_id: agentId },
        turn: { id: turnId, status: "completed" },
        legal_next_actions: [],
      };
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    reviewAuthority,
    registeredOperations: {
      [REVIEW_OPERATION_CONTRACTS.record]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        validateCard() {
          throw new Error("caller registration must not replace ReviewAuthority");
        },
        invoke() {
          throw new Error("caller registration must not execute");
        },
      },
    },
    delegatedAgentPort,
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  const launch = runtime.launch({
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
  });
  assert.ok(launch.run_id);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = runtime.query({ run_id: launch.run_id });
    if (projection.phase === "succeeded") break;
    const action = projection.legal_actions?.find(({ type }) => [
      "checkpoint_decision",
      "delegate_execute",
      "operation_execute",
      "recovery",
    ].includes(type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  const reviewId = `review:${candidate.candidate_fingerprint}:4`;
  const review = runtime.query({ review_id: reviewId });
  assert.equal(review.schema, "flow.review-projection/v1");
  assert.equal(review.candidate_fingerprint, candidate.candidate_fingerprint);
  assert.equal(review.lifecycle_generation, 4);
  assert.equal(review.watermark, review.artifacts.watermark);
  assert.equal(review.findings.length, 1);
  assert.equal(review.urgency_floor, "high");
  assert.deepEqual(review.orientation, {
    schema: "flow.review-orientation/v1",
    markdown: "The review starts at the authority boundary.",
  });
  assert.deepEqual(review.diagrams, [{
    schema: "flow.review-diagram/v1",
    name: "review path",
    source: "flowchart LR\n  lens --> critic",
  }]);
  assert.match(review.artifacts.formats.markdown, /The review starts at the authority boundary/u);
  assert.match(review.artifacts.formats.markdown, /review path/u);
  assert.equal(
    review.findings.find(({ lens }) => lens === "security").urgency,
    "high",
  );
  const securityResult = review.summary.lens_results[
    review.summary.enabled_lenses.indexOf("security")
  ];
  assert.equal(securityResult.coverage.status, "degraded");
  assert.equal(
    securityResult.findings.find(({ urgency }) => urgency === "low")?.urgency ?? "missing",
    "low",
  );
  assert.deepEqual(review.cap_reasons.find(({ code }) => code === "urgency_floor"), {
    code: "urgency_floor",
    detail: "1 findings omitted below the high urgency floor",
    count: 1,
    omitted_urgencies: ["low"],
  });
  assert.deepEqual(review.summary.coverage, {
    schema: "flow.review-coverage/v1",
    complete: false,
      critic: { status: "produced", reason: null },
    lenses: [
      { lens: "correctness", status: "degraded", reason: "bounded_timeout" },
      { lens: "security", status: "degraded", reason: "delegate_self_report" },
      { lens: "tests", status: "unavailable", reason: "delegate_unavailable" },
    ],
  });
  assert.equal(review.posture, "review_incomplete");
  assert.equal(review.merge_ready, false);
  assert.deepEqual(review.legal_actions, []);
  assert.equal(review.integration_authorized, false);
  assert.equal(review.merge_authorized, false);
  assert.equal(review.tracker_completion_authorized, false);
  assert.equal(review.remote_submission_authorized, false);
  assert.deepEqual(
    dispatches.map(({ agent_id: agentId }) => agentId).sort(),
    [
      "agent:review-correctness",
      "agent:review-critic",
      "agent:review-security",
      "agent:review-tests",
    ],
  );
  assert.equal(prompts.filter((prompt) => prompt.includes("Authority-settled finding lens results:")).length, 1);
  const findingLensPrompt = prompts.find((prompt) => prompt.includes("Authority-settled"));
  assert.match(findingLensPrompt, /review-lens-security/);
  assert.match(findingLensPrompt, /review-lens-correctness/);
  const findingLensEvidence = JSON.parse(
    findingLensPrompt.slice(findingLensPrompt.indexOf("{", findingLensPrompt.indexOf("Authority-settled"))),
  );
  assert.equal(
    findingLensEvidence.schema,
    "flow.authority-materialized-delegate-evidence/v1",
  );
  assert.equal(Object.hasOwn(findingLensEvidence, "evidence_digest"), false);
  const criticPrompt = prompts.find((prompt) => prompt.includes("Authority-settled"));
  const criticDispatch = dispatches.find(({ agent_id: agentId }) =>
    agentId === "agent:review-critic");
  assert.equal(Object.hasOwn(criticDispatch, "orientation"), false);
  assert.equal(Object.hasOwn(criticDispatch, "diagrams"), false);
  assert.equal(criticDispatch.prompt.includes("The review starts at the authority boundary."), false);
  assert.equal(criticDispatch.prompt.includes("review path"), false);
  assert.equal(JSON.stringify(criticDispatch).includes("orientation"), false);
  assert.equal(JSON.stringify(criticDispatch).includes("diagrams"), false);
  const materialized = JSON.parse(
    criticPrompt.split("Authority-settled finding lens results:\n")[1],
  );
  assert.equal(JSON.stringify(materialized).includes("orientation"), false);
  assert.equal(JSON.stringify(materialized).includes("diagrams"), false);
  assert.equal(JSON.stringify(materialized).includes("The review starts at the authority boundary."), false);
  assert.equal(JSON.stringify(materialized).includes("review path"), false);
  assert.deepEqual(
    materialized.accepted_delegates.map(({ card_id: cardId, evidence }) => {
      const result = JSON.parse(evidence.validated_output);
      const disposition = evidence.authority_terminal_disposition;
      return {
        card_id: cardId,
        status: disposition.status,
        reason: disposition.reason ?? null,
        self_reported_status: result.coverage.status,
      };
    }),
    [
      {
        card_id: "review-lens-correctness",
        status: "degraded",
        reason: "bounded_timeout",
        self_reported_status: "degraded",
      },
      {
        card_id: "review-lens-security",
        status: "produced",
        reason: null,
        self_reported_status: "degraded",
      },
      {
        card_id: "review-lens-tests",
        status: "unavailable",
        reason: "delegate_unavailable",
        self_reported_status: "unavailable",
      },
    ],
  );
  const watched = await runtime.watch({ review_id: reviewId }).next();
  assert.equal(watched.value.watermark, review.watermark);

  lifecycleMismatch = true;
  const changedInputs = structuredClone(inputs);
  changedInputs.target.lifecycle_generation = 5;
  const changedPrepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs: changedInputs,
    explicit_facts: facts,
  });
  const changedLaunch = runtime.launch(reviewLaunchRequest(changedPrepared));
  assert.ok(changedLaunch.run_id);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = runtime.query({ run_id: changedLaunch.run_id });
    if (["failed", "succeeded", "cancelled"].includes(projection.phase)) break;
    const action = projection.legal_actions?.find(({ type }) => [
      "checkpoint_decision",
      "delegate_execute",
      "operation_execute",
    ].includes(type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const changedProjection = runtime.query({ run_id: changedLaunch.run_id });
  assert.equal(changedProjection.phase, "active");
  assert.ok(changedProjection.legal_actions.some(({ type }) => type === "recovery"));
  assert.equal(lifecycleRejection.code, "review_target_mismatch");
  const durableCandidateFence = getReviewAuthority({ runAuthority: authority })
    .command(firstRecordCommand);
  assert.equal(durableCandidateFence.code, "candidate_authority_projection_missing");
  const nonCanonicalCommand = getReviewAuthority({ runAuthority: authority })
    .command({
      ...firstRecordCommand,
      command_id: "review-record:forged-first-record",
    });
  assert.equal(nonCanonicalCommand.code, "invalid_review_record");
});

function reviewInputsForCandidate(candidate, target = {}) {
  const description = (byte) => {
    const identity = {
      schema: "drovr.delegated-agent-description/v1",
      comparison_keys: {
        launch: DIGEST(byte),
        effective_authority: DIGEST(String.fromCharCode(byte.charCodeAt(0) + 1)),
      },
      watermark: { content_sha256: DIGEST(String.fromCharCode(byte.charCodeAt(0) + 2)) },
    };
    return { ...identity, description_digest: digest(identity) };
  };
  const route = (agentId, value) => ({
    agent_id: agentId,
    configuration_watermark: value.watermark.content_sha256,
    description_digest: value.description_digest,
    launch_comparison_key: value.comparison_keys.launch,
  });
  const security = description("1");
  const critic = description("2");
  return {
    schema: "flow.review-request/v1",
    target: {
      schema: "flow.review-local-candidate/v1",
      candidate,
      candidate_fingerprint: candidate.candidate_fingerprint,
      candidate_authority_watermark: DIGEST("c"),
      lifecycle_generation: 4,
      ...target,
    },
    lenses: ["security"],
    delegation: {
      schema: "flow.review-delegation-bindings/v1",
      lenses: { security: { description: security, route: route("agent:security", security) } },
      critic: { description: critic, route: route("agent:critic", critic) },
    },
  };
}

function githubReviewInputs(target, { createPendingReview = false } = {}) {
  const inputs = target?.schema === GITHUB_REVIEW_TARGET_SCHEMA
    ? { ...reviewInputsForCandidate(reviewCandidate()), target }
    : reviewInputsForCandidate(reviewCandidate(), target);
  return {
    ...inputs,
    ...(createPendingReview
      ? {
          pending_review: {
            schema: "flow.github-pending-review-request/v1",
            mode: "create_pending_unsubmitted",
          },
        }
      : {}),
  };
}

function githubReviewTarget({ headSha = "c".repeat(40) } = {}) {
  const snapshotIdentity = {
    schema: "flow.github-pull-request-snapshot/v1",
    repository: { owner: "acme", name: "example" },
    pull_request_number: 42,
    state: "open",
    base_sha: "b".repeat(40),
    head_sha: headSha,
    diff_sha256: DIGEST("d"),
  };
  return {
    schema: GITHUB_REVIEW_TARGET_SCHEMA,
    repository: { owner: "acme", name: "example" },
    pull_request_number: 42,
    lifecycle_generation: 4,
    target_authority_watermark: DIGEST("e"),
    snapshot: snapshotIdentity,
    snapshot_fingerprint: digest(snapshotIdentity),
  };
}

function githubForge({
  pendingReviews = [],
  snapshot = githubReviewTarget().snapshot,
  onCreate = null,
  onRead = null,
  includeTargetAuthorityWatermark = true,
  bareListing = false,
  incompleteListing = false,
} = {}) {
  const forge = {
    createCount: 0,
    submitCount: 0,
    forbiddenMutationCalls: [],
    readCount: 0,
    createRequests: [],
    pendingReviews: [...pendingReviews],
    observePullRequest(request) {
      this.readCount += 1;
      return {
        snapshot: onRead?.(request, this) ?? snapshot,
        ...(includeTargetAuthorityWatermark ? {
          target_authority_watermark: request.target_authority_watermark,
        } : {}),
      };
    },
    listPendingReviews() {
      if (bareListing) return [...this.pendingReviews];
      return {
        reviews: [...this.pendingReviews],
        complete: !incompleteListing,
      };
    },
    createPendingReview(request) {
      this.createCount += 1;
      this.createRequests.push(request);
      if (onCreate) return onCreate.call(this, request);
      const review = {
        id: `github-review:${this.createCount}`,
        submitted: false,
        state: "pending",
        marker: request.marker,
        target_fingerprint: request.target_fingerprint,
        target_authority_watermark: request.target_authority_watermark,
        draft_digest: request.draft_digest,
        repository: request.repository,
        pull_request_number: request.pull_request_number,
        commit_id: request.commit_id,
      };
      this.pendingReviews.push(review);
      return review;
    },
  };
  const forbiddenMutationNames = new Set([
    "submitReview",
    "approveReview",
    "requestChanges",
    "deleteReview",
    "repostReview",
  ]);
  return new Proxy(forge, {
    get(target, property, receiver) {
      if (!forbiddenMutationNames.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      return () => {
        target.forbiddenMutationCalls.push(property);
        if (property === "submitReview") target.submitCount += 1;
        throw new Error(`forbidden GitHub review mutation: ${property}`);
      };
    },
  });
}

async function launchGitHubPendingScenario(t, {
  forge = githubForge(),
  target = githubReviewTarget(),
  runAuthority: suppliedRunAuthority = null,
} = {}) {
  const authorityDirectory = suppliedRunAuthority === null
    ? await mkdtemp(join(tmpdir(), "flow-github-review-scenario-"))
    : null;
  if (authorityDirectory !== null) {
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  }
  const runAuthority = suppliedRunAuthority ?? createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("github-review-scenario-boot", "writer"),
  });
  if (suppliedRunAuthority === null) t.after(() => runAuthority.close());
  const inputs = githubReviewInputs(target, { createPendingReview: true });
  const [securityDescription, criticDescription] = await Promise.all([
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-sol", "security"), {}),
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  inputs.delegation.lenses.security = {
    description: securityDescription,
    route: reviewRoute("agent:scenario-security", securityDescription),
  };
  inputs.delegation.critic = {
    description: criticDescription,
    route: reviewRoute("agent:scenario-critic", criticDescription),
  };
  const facts = reviewRuntimeFacts();
  facts.operation_contracts.push(GITHUB_REVIEW_OPERATION_CONTRACTS.pending);
  facts.validator_contracts.push("flow.validator/github-review-receipt/v1");
  const runtime = createFlowRuntime({
    runAuthority,
    githubReviewForge: forge,
    delegatedAgentPort: githubReviewDelegatedPort(),
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(facts),
    }),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });
  const launch = runtime.launch(reviewLaunchRequest(prepared));
  assert.ok(launch.run_id, JSON.stringify(launch));
  return { forge, runAuthority, runtime, target, launch };
}

function githubReviewDelegatedPort() {
  return {
    contract: "flow.delegated-agent-port/v1",
    describe() {},
    discover() {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "proven_absent",
        watermark: null,
        delegation: null,
        turn: null,
        legal_next_actions: ["dispatch"],
      };
    },
    dispatch(request) {
      const lens = request.agent_id.includes("critic") ? "critic" : "security";
      return completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description: request.description,
        output: reviewResult(lens, lens === "critic" ? { findings: [] } : {}),
        prompt: request.prompt,
        turnId: `turn:${request.caller_key}`,
      });
    },
    send() {},
    observe() {},
    cancel() {},
    reconcile() {},
    wait() {},
    retire({ agent_id: agentId, turn_id: turnId }) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: { schema: "drovr.agent-authority-watermark/v1", agent_id: agentId },
        delegation: { agent_id: agentId },
        turn: { id: turnId, status: "completed" },
        legal_next_actions: [],
      };
    },
  };
}

function githubReviewDescription() {
  const identity = {
    schema: "drovr.delegated-agent-description/v1",
    comparison_keys: { launch: DIGEST("1"), effective_authority: DIGEST("2") },
    watermark: { content_sha256: DIGEST("3") },
  };
  return { ...identity, description_digest: digest(identity) };
}

async function driveToAction(runtime, runId, type) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = runtime.query({ run_id: runId });
    const action = projection.legal_actions?.find((candidate) => candidate.type === type);
    if (action) return action;
    if (["failed", "succeeded", "declined", "cancelled"].includes(projection.phase)) {
      assert.fail(`run reached ${projection.phase} before ${type}: ${JSON.stringify(projection)}`);
    }
    const next = projection.legal_actions?.find((candidate) => [
      "checkpoint_decision",
      "delegate_execute",
      "operation_execute",
      "recovery",
    ].includes(candidate.type));
    if (next) runtime.command(next);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const current = runtime.query({ run_id: runId });
  assert.fail(`timed out waiting for ${type}: phase=${current.phase} legal=${JSON.stringify(current.legal_actions)} effects=${JSON.stringify(current.effects?.map(({ card_id: cardId, status, receipt, last_observation: observation }) => ({ cardId, status, receipt, observation })))}`);
}

async function driveUntilTerminal(runtime, runId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = runtime.query({ run_id: runId });
    if (["failed", "succeeded", "declined", "cancelled"].includes(projection.phase)) {
      return projection;
    }
    const action = projection.legal_actions?.find((candidate) => [
      "checkpoint_decision",
      "delegate_execute",
      "operation_execute",
      "recovery",
    ].includes(candidate.type));
    if (action) runtime.command(action);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for terminal run ${runId}`);
}

async function waitForProjection(runtime, runId, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = runtime.query({ run_id: runId });
    if (predicate(projection)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for run projection ${runId}`);
}

function minimalReviewCandidate() {
  const identity = {
    schema: "work.review-candidate/v1",
    candidate_id: "candidate:review",
    git: {
      commit_sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      ref: "refs/heads/review-candidate",
      clean: true,
    },
  };
  return { ...identity, candidate_fingerprint: digest(identity) };
}

function reviewCandidate() {
  const git = {
    commit_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    ref: "refs/heads/review-candidate",
    clean: true,
  };
  const workspace = {
    contract: "work.workspace/v1",
    subject_id: "workspace:producer",
    generation: 1,
    mutation_epoch: 7,
    fingerprint: digest({ git }),
  };
  const verificationIdentity = {
    schema: "work.feature-verification-receipt/v1",
    brief_id: "brief:local",
    acceptance_criteria: [{
      criterion: "the local candidate is ready for review",
      evidence_digest: DIGEST("7"),
      verdict: "passed",
    }],
    discriminating_evidence: {
      schema: "flow.feature-discriminating-evidence/v1",
      kind: "safe_baseline",
      selected_fingerprint: DIGEST("3"),
      post_mutation_fingerprint: workspace.fingerprint,
      distinguished: true,
    },
    selected_evidence_fingerprint: DIGEST("3"),
    workspace: {
      subject_id: workspace.subject_id,
      generation: workspace.generation,
      mutation_epoch: workspace.mutation_epoch,
      fingerprint: workspace.fingerprint,
      git: { ...git },
    },
    source_authority_watermark: DIGEST("8"),
    operation_contract: "flow.operation/feature-verify/v1",
    effect_id: "effect:verify",
    attempt_id: "attempt:verify",
    idempotency_key: "idempotency:verify",
  };
  const verification = {
    ...verificationIdentity,
    receipt_digest: digest(verificationIdentity),
    self_digest: digest(verificationIdentity),
  };
  const critiqueIdentity = {
    schema: "work.feature-critique-receipt/v1",
    delegate_evidence: {
      card_id: "feature-critique",
      effect_id: "effect:critique",
      attempt_id: "attempt:critique",
      idempotency_key: "idempotency:critique",
      source_authority_watermark: DIGEST("9"),
      evidence: "independent critique evidence",
    },
    findings: [],
    operation_contract: "flow.delegated-agent-port/v1",
    effect_id: "effect:critique",
    idempotency_key: "idempotency:critique",
    source_authority_watermark: DIGEST("9"),
  };
  const critique = {
    ...critiqueIdentity,
    receipt_digest: digest(critiqueIdentity),
    self_digest: digest(critiqueIdentity),
  };
  const identity = {
    schema: "work.review-candidate/v1",
    candidate_id: "candidate:review",
    git,
    workspace,
    verification,
    critique,
    artifacts: [{
      digest: DIGEST("6"),
      generation: 1,
      artifact_schema: "example.candidate/v1",
    }],
    git_retention: {
      schema: "flow.git-retention-receipt/v1",
      repository_id: "github.com/Seavenly/example",
      commit_sha: git.commit_sha,
      tree_sha: git.tree_sha,
      retention_ref: "refs/flow/review/candidate-review",
    },
  };
  return { ...identity, candidate_fingerprint: digest(identity) };
}

function reviewResult(lens, overrides = {}) {
  return JSON.stringify({
    schema: "flow.review-result/v1",
    posture: overrides.posture ?? (overrides.findings ? "no_findings" : "findings"),
    findings: overrides.findings ?? [{
      lens,
      urgency: "high",
      classification: "blocking",
      summary: `${lens} finding`,
      detail: `${lens} detail`,
      location: { path: "src/review.mjs", start_line: 4, end_line: 4 },
    }],
    ...(overrides.coverage === undefined ? {} : { coverage: overrides.coverage }),
    evidence: { lens },
  });
}

function reviewTargetObservationAdapter(candidate) {
  return {
    observe({ command }) {
      return buildReviewTargetObservation({
        subjectId: command.subject_id,
        candidateId: candidate.candidate_id,
        candidateFingerprint: command.observed_candidate_fingerprint,
        lifecycleGeneration: command.observed_lifecycle_generation,
        authorityWatermark: DIGEST("9"),
        source: "named_mechanism_observation",
      });
    },
  };
}

function reviewRecordCommand(
  candidate,
  lifecycleGeneration,
  { candidateAuthorityWatermark = DIGEST("c") } = {},
) {
  const summary = buildReviewSummary({
    candidateFingerprint: candidate.candidate_fingerprint,
    candidateAuthorityWatermark,
    lifecycleGeneration,
    enabledLenses: ["security"],
    lensResults: { security: reviewResult("security") },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: `sha256:${"1".repeat(64)}`,
  });
  const body = {
    schema: "flow.review-record/v1",
    review_id: `review:${candidate.candidate_fingerprint}:${lifecycleGeneration}`,
    candidate_fingerprint: candidate.candidate_fingerprint,
    candidate_authority_watermark: candidateAuthorityWatermark,
    lifecycle_generation: lifecycleGeneration,
    candidate,
    summary,
    automated_evidence: summary.automated_evidence,
    source_authority_watermark: summary.automated_evidence.source_authority_watermark,
    operation_contract: "flow.operation/review-record/v1",
    operation_effect_id: "effect:review",
    operation_attempt_id: "run:review:review-record:attempt:1",
    operation_idempotency_key: "idempotency:review",
    source_run_id: "run:review",
  };
  const watermark = reviewEventWatermark({
    previousWatermark: EMPTY_WATERMARK,
    event: reviewRecordWatermarkIdentity(body),
  });
  const artifacts = renderReviewArtifacts({
    summary,
    watermark,
    provenance: {
      operation_contract: "flow.operation/review-record/v1",
    operation_idempotency_key: "idempotency:review",
    source_run_id: "run:review",
      run_id: "run:review",
      operation_effect_id: "effect:review",
      operation_attempt_id: "run:review:review-record:attempt:1",
    },
  });
  return {
    schema: "work.review-record-command/v1",
    type: "review_record",
    contract: "work.review/v1",
    subject_id: body.review_id,
    command_id: `review-record:${candidate.candidate_fingerprint}:${lifecycleGeneration}`,
    expected_watermark: EMPTY_WATERMARK,
    candidate_fingerprint: candidate.candidate_fingerprint,
    candidate_authority_watermark: body.candidate_authority_watermark,
    lifecycle_generation: lifecycleGeneration,
    candidate,
    summary,
    automated_evidence: summary.automated_evidence,
    artifacts,
    source_authority_watermark: body.source_authority_watermark,
    operation_contract: body.operation_contract,
    operation_effect_id: body.operation_effect_id,
    operation_attempt_id: body.operation_attempt_id,
    operation_idempotency_key: body.operation_idempotency_key,
    source_run_id: body.source_run_id,
  };
}

function githubReviewRecordCommand(target) {
  const sourceAuthorityWatermark = DIGEST("a");
  const sourceRunId = "run:valid";
  const operationEffectId = "effect:valid";
  const operationAttemptId = "attempt:valid";
  const operationIdempotencyKey = "idempotency:valid";
  const summary = buildReviewSummary({
    candidateFingerprint: target.snapshot_fingerprint,
    candidateAuthorityWatermark: target.target_authority_watermark,
    lifecycleGeneration: target.lifecycle_generation,
    enabledLenses: ["security"],
    lensResults: { security: reviewResult("security") },
    criticResult: reviewResult("critic", { findings: [] }),
    sourceAuthorityWatermark: sourceAuthorityWatermark,
  });
  const body = {
    schema: "flow.github-review-record/v1",
    review_id: reviewSubjectId(target),
    target,
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    lifecycle_generation: target.lifecycle_generation,
    summary,
    automated_evidence: summary.automated_evidence,
    source_authority_watermark: sourceAuthorityWatermark,
    source_run_id: sourceRunId,
    operation_contract: REVIEW_OPERATION_CONTRACTS.record,
    operation_effect_id: operationEffectId,
    operation_attempt_id: operationAttemptId,
    operation_idempotency_key: operationIdempotencyKey,
  };
  const watermark = reviewEventWatermark({
    previousWatermark: EMPTY_WATERMARK,
    event: body,
  });
  const artifacts = renderReviewArtifacts({
    summary,
    watermark,
    provenance: {
      operation_contract: REVIEW_OPERATION_CONTRACTS.record,
      source_run_id: sourceRunId,
      run_id: sourceRunId,
      operation_effect_id: operationEffectId,
      operation_attempt_id: operationAttemptId,
      operation_idempotency_key: operationIdempotencyKey,
    },
  });
  return {
    schema: "work.github-review-record-command/v1",
    type: "github_review_record",
    contract: "work.review/v1",
    subject_id: body.review_id,
    command_id: `github-review-record:${target.snapshot_fingerprint}:${target.lifecycle_generation}`,
    expected_watermark: EMPTY_WATERMARK,
    target,
    target_fingerprint: target.snapshot_fingerprint,
    target_authority_watermark: target.target_authority_watermark,
    lifecycle_generation: target.lifecycle_generation,
    summary,
    automated_evidence: summary.automated_evidence,
    artifacts,
    source_authority_watermark: sourceAuthorityWatermark,
    source_run_id: sourceRunId,
    operation_contract: REVIEW_OPERATION_CONTRACTS.record,
    operation_effect_id: operationEffectId,
    operation_attempt_id: operationAttemptId,
    operation_idempotency_key: operationIdempotencyKey,
  };
}

function sourceEffectIntentReaderFor(command) {
  const accepted = [
    ...command.summary.lens_results.map((result, index) => ({
      card_id: `review-lens-${command.summary.enabled_lenses[index]}`,
      evidence: { validated_output: result },
    })),
    { card_id: "review-critic", evidence: { validated_output: command.summary.critic_result } },
  ];
  return {
    query(runId, effectId) {
      if (runId !== command.source_run_id ||
          effectId !== command.operation_effect_id) return null;
      return {
        run_id: runId,
        effect_id: command.operation_effect_id,
        operation_contract: command.operation_contract,
        attempt_id: command.operation_attempt_id,
        idempotency_key: command.operation_idempotency_key,
        source_authority_watermark: command.source_authority_watermark,
        operation_input: {
          target: {
            schema: "flow.review-local-candidate/v1",
            candidate: command.candidate,
            candidate_fingerprint: command.candidate_fingerprint,
            candidate_authority_watermark: command.candidate_authority_watermark,
            lifecycle_generation: command.lifecycle_generation,
          },
          lenses: command.summary.enabled_lenses,
          finding_cap: command.summary.finding_cap,
          urgency_floor: command.summary.urgency_floor,
          orientation: command.summary.orientation,
          diagrams: command.summary.diagrams,
          delegate_evidence_card_ids: accepted.map(({ card_id: id }) => id),
          authority_materialized_evidence: {
            schema: "flow.authority-materialized-delegate-evidence/v1",
            accepted_delegates: accepted,
          },
        },
      };
    },
  };
}

function candidateAuthorityProjection(candidate, watermark) {
  return {
    schema: "work.review-candidate-projection/v1",
    contract: "work.review/v1",
    subject_id: candidate.candidate_id,
    watermark,
    generation: 1,
    status: "sealed",
    candidate_fingerprint: candidate.candidate_fingerprint,
    candidate,
    legal_actions: [],
  };
}

function reviewRuntimeFacts() {
  const facts = structuredClone(dynamicCheckpointProposal().explicit_facts);
  facts.operation_contracts.push("flow.operation/review-record/v1");
  facts.validator_contracts.push(
    "flow.validator/review-result/v1",
    "flow.validator/operation-receipt/v1",
  );
  facts.limits.max_cards = 8;
  facts.limits.max_resources = 2;
  return facts;
}

function reviewLaunchRequest(prepared) {
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

function reviewRoute(agentId, description) {
  return {
    agent_id: agentId,
    configuration_watermark: description.watermark.content_sha256,
    description_digest: description.description_digest,
    launch_comparison_key: description.comparison_keys.launch,
  };
}

const EMPTY_WATERMARK = `sha256:${"0".repeat(64)}`;

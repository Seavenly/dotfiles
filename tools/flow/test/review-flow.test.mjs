import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest, idempotencyCommandDigest } from "../src/canonical.mjs";
import { operationEffectIdentity } from "../src/effect-identity.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import {
  getReviewAuthority,
  getRunEffectIntentReader,
} from "../src/work-authority.mjs";
import {
  buildReviewSummary,
  normalizeReviewFindings,
  parseReviewDelegateResult,
  renderReviewArtifacts,
} from "../src/review-rendering.mjs";
import {
  createInMemoryReviewAuthority,
  createInMemoryGitHubReviewAuthority,
  createReviewDefinition,
  createReviewOperationRegistration,
  GITHUB_REVIEW_OPERATION_CONTRACTS,
  GITHUB_REVIEW_TARGET_SCHEMA,
  githubPendingEffectIdentity,
  reviewCompletionAuthority,
  reviewEventWatermark,
  reviewSubjectId,
  REVIEW_OPERATION_CONTRACTS,
} from "../src/review-flow.mjs";
import { completedTurnProjection } from "../test-support/delegate-card.mjs";
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

test("review/v1 prepares an exact GitHub snapshot with an optional pending-review checkpoint", () => {
  const target = githubReviewTarget();
  const inputs = githubReviewInputs(target, { createPendingReview: true });
  const facts = reviewRuntimeFacts();
  facts.operation_contracts.push(GITHUB_REVIEW_OPERATION_CONTRACTS.pending);
  facts.validator_contracts.push("flow.validator/github-review-receipt/v1");
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    githubReviewForge: {},
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
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const facts = reviewRuntimeFacts();
  const inputs = reviewInputsForCandidate(candidate);
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs,
    explicit_facts: facts,
  });

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
    supportedDescription(reviewDescriptionRequest("codex", "gpt-5.6-luna", "critic"), {}),
  ]);
  const [securityDescription, correctnessDescription, criticDescription] = descriptions;
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
  facts.limits.max_cards = 8;
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
    lenses: ["security", "correctness"],
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
      },
      critic: {
        description: criticDescription,
        route: reviewRoute("agent:review-critic", criticDescription),
      },
    },
  };
  const prompts = [];
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
      prompts.push(request.prompt);
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
    wait() { throw new Error("wait is not needed for completed dispatches"); },
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
  assert.equal(review.findings.length, 2);
  assert.deepEqual(review.legal_actions, []);
  assert.equal(review.integration_authorized, false);
  assert.equal(review.merge_authorized, false);
  assert.equal(review.tracker_completion_authorized, false);
  assert.equal(review.remote_submission_authorized, false);
  assert.equal(prompts.filter((prompt) => prompt.includes("Authority-settled finding lens results:")).length, 1);
  assert.match(prompts.find((prompt) => prompt.includes("Authority-settled")), /review-lens-security/);
  assert.match(prompts.find((prompt) => prompt.includes("Authority-settled")), /review-lens-correctness/);
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
    evidence: { lens },
  });
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
    event: body,
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import { getReviewAuthority } from "../src/work-authority.mjs";
import {
  buildReviewSummary,
  normalizeReviewFindings,
  parseReviewDelegateResult,
  renderReviewArtifacts,
} from "../src/review-rendering.mjs";
import {
  createInMemoryReviewAuthority,
  createReviewDefinition,
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
    sourceRunAuthority: sourceRunAuthorityFor(command),
  });
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewAuthority: authority,
  });
  assert.equal(authority.command(command).accepted, true);
  const replay = authority.command(command);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);

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
    sourceRunAuthority: sourceRunAuthorityFor(command),
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

test("durable ReviewAuthority fails closed when the candidate seal projection is missing", async (t) => {
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
  const reviewAuthorityBase = createInMemoryReviewAuthority({
    candidateProjection,
    sourceRunAuthority: authority,
  });
  const reviewAuthority = Object.freeze({
    ...reviewAuthorityBase,
    command(command) {
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

function sourceRunAuthorityFor(command) {
  const accepted = [
    ...command.summary.lens_results.map((result, index) => ({
      card_id: `review-lens-${command.summary.enabled_lenses[index]}`,
      evidence: { validated_output: result },
    })),
    { card_id: "review-critic", evidence: { validated_output: command.summary.critic_result } },
  ];
  return {
    query(runId) {
      return {
        schema: "flow.run-projection/v1",
        run_id: runId,
        effects: [{
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
        }],
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

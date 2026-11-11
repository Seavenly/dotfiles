import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { digest } from "../../../tools/flow/src/canonical.mjs";
import {
  createInMemoryRunAuthority,
} from "../../../tools/flow/src/run-authority.mjs";
import { attachWorkAuthorities } from "../../../tools/flow/src/work-authority.mjs";
import {
  getReviewAuthority,
  getWorkspaceAuthority,
} from "../../../tools/flow/src/work-authority.mjs";
import { createFlowRuntime } from "../../../tools/flow/src/flow-runtime.mjs";
import { createInMemoryReviewAuthority } from "../../../tools/flow/src/review-flow.mjs";
import { createProductionComposition } from "../src/production-composition.mjs";
import { createFlowRuntime as createProductionFlowRuntime } from "../src/runtime.mjs";

const DIGEST = (byte) => `sha256:${byte.repeat(64)}`;
const schemaRoot = new URL("../schemas/", import.meta.url);
const rejectionAjv = new Ajv2020({ allErrors: true, strict: true });
for (const name of [
  "flow.authority-fact.v1.schema.json",
  "flow.rejection.v1.schema.json",
]) {
  rejectionAjv.addSchema(JSON.parse(readFileSync(new URL(name, schemaRoot), "utf8")));
}
const validateRejection = rejectionAjv.getSchema(
  "https://dotfiles.local/schemas/flow.rejection.v1.schema.json",
);

test("production review preparation provider reads owner projections and rechecks route drift", async (t) => {
  const candidateFingerprint = DIGEST("a");
  const git = {
    commit_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    ref: "refs/heads/review-candidate",
    clean: true,
  };
  const workspace = {
    subject_id: "workspace:repository",
    generation: 2,
    mutation_epoch: 3,
    fingerprint: digest({ git }),
  };
  const candidateProjection = {
    schema: "work.review-candidate-projection/v1",
    contract: "work.review/v1",
    subject_id: "candidate:sealed",
    watermark: DIGEST("b"),
    generation: 4,
    status: "sealed",
    candidate_fingerprint: candidateFingerprint,
    candidate: {
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      workspace,
    },
    authority_fact: {
      schema: "flow.authority-fact/v1",
      authority_id: "review:candidate",
      authority_contract: "work.review/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "test.review-authority",
        version: "7",
      },
      watermark: DIGEST("b"),
      generation: 4,
      legal_actions: ["replace_candidate"],
    },
    legal_actions: [],
  };
  const sourceRunProjection = {
    schema: "flow.run-projection/v1",
    run_id: "run:source",
    phase: "succeeded",
    watermark: DIGEST("c"),
    sequence: 12,
    current_revision: { ordinal: 0, plan_fingerprint: DIGEST("f") },
    bundle_digest: DIGEST("f"),
    review_candidate_reference: {
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
    },
  };
  const workspaceProjection = {
    schema: "work.workspace-projection/v1",
    contract: "work.workspace/v1",
    subject_id: workspace.subject_id,
    generation: workspace.generation,
    mutation_epoch: workspace.mutation_epoch,
    git,
    taint: null,
    watermark: DIGEST("d"),
    provider_identity: {
      schema: "flow.registered-authority/v1",
      id: "test.workspace-authority",
      version: "9",
    },
    disposition: "retained_for_handoff",
    authority_facts: {
      schema: "flow.workspace-facts/v1",
      mutation_epoch: workspace.mutation_epoch,
      generation: workspace.generation,
    },
    legal_actions: ["clean_workspace", "refresh_workspace"],
    authority_fact: {
      schema: "flow.authority-fact/v1",
      authority_id: "workspace:review",
      authority_contract: "work.workspace/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "test.workspace-authority",
        version: "9",
      },
      watermark: DIGEST("d"),
      generation: workspace.generation,
      legal_actions: ["clean_workspace", "refresh_workspace"],
    },
  };
  let candidateStatus = "sealed";
  const reviewAuthority = createInMemoryReviewAuthority({
    candidateProjection: () => ({
      ...candidateProjection,
      status: candidateStatus,
      legal_actions: candidateStatus === "sealed"
        ? []
        : [`recover_${candidateStatus}`],
    }),
  });
  const workspaceAuthority = {
    schema: "work.workspace-authority/v1",
    query() { return workspaceProjection; },
    command() { return { accepted: false }; },
  };
  const artifactAuthority = {
    schema: "work.artifact-authority/v1",
    query() { return { schema: "flow.rejection/v1", code: "unknown_subject" }; },
    command() { return { accepted: false }; },
  };
  const handoffAuthority = {
    schema: "flow.resource-handoff-authority/v1",
    query() { return { schema: "flow.rejection/v1", code: "unknown_subject" }; },
    command() { return { accepted: false }; },
  };
  const runAuthority = createInMemoryRunAuthority();
  attachWorkAuthorities(runAuthority, {
    workspace: workspaceAuthority,
    artifact: artifactAuthority,
    review: reviewAuthority,
    handoff: handoffAuthority,
  });
  const sourceLookupAuthority = {
    ...runAuthority,
    queryByReviewCandidateReference() { return sourceRunProjection; },
    query() { return { schema: "flow.run-index-projection/v1", watermark: DIGEST("e"), runs: [] }; },
  };
  attachWorkAuthorities(sourceLookupAuthority, {
    workspace: workspaceAuthority,
    artifact: artifactAuthority,
    review: reviewAuthority,
    handoff: handoffAuthority,
  });
  let routeChanged = false;
  const timeFacts = [
    {
      schema: "flow.time-fact/v1",
      kind: "wall_clock",
      value_ms: 1_700_000_000_000,
      uncertainty_ms: 0,
      clock_source_id: "wall:test",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "suspend_excluding_monotonic",
      value_ns: "1000000000",
      uncertainty_ns: "0",
      clock_source_id: "mono:test",
    },
    { schema: "flow.time-fact/v1", kind: "boot", boot_id: "boot:test" },
    { schema: "flow.time-fact/v1", kind: "clock_source", identity: "clock:test" },
  ];
  const compositionOptions = {
    delegatedAgentPort: {
      describe({ caller_metadata: callerMetadata }) {
        const digit = routeChanged
          ? callerMetadata.role === "critic" ? "5" : "4"
          : callerMetadata.role === "critic" ? "2" : "1";
        const identity = {
          schema: "drovr.delegated-agent-description/v1",
          comparison_keys: {
            launch: DIGEST(digit),
            effective_authority: DIGEST(digit),
          },
          watermark: { content_sha256: DIGEST(digit) },
        };
        return {
          schema: "flow.delegated-agent-description-projection/v1",
          status: "compatible",
          description: {
            ...identity,
            description_digest: digest(identity),
          },
        };
      },
    },
    authorityOptions: {
      timeObservationAdapter: { observe() { return timeFacts; } },
    },
  };
  const composition = createProductionComposition(compositionOptions);
  composition.bindAuthority(sourceLookupAuthority);
  assert.equal(getReviewAuthority({ runAuthority: sourceLookupAuthority }), reviewAuthority);
  assert.equal(getWorkspaceAuthority({ runAuthority: sourceLookupAuthority }), workspaceAuthority);
  const provider = composition.reviewPreparationProvider;
  const result = await provider.derive({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: candidateFingerprint,
    selection: reviewSelection(),
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.facts.source_run.run_id, "run:source");
  assert.equal(result.facts.workspace.subject_id, workspace.subject_id);
  assert.equal(result.facts.route.route_id, "route:review");
  assert.equal(result.facts.route.bindings.length, 2);
  assert.equal(result.facts.catalog.id, "flow.contract-catalog/v1@40");

  await t.test("async route observations revalidate configured catalog drift", async () => {
    let catalogIdentity = result.facts.catalog;
    const asyncComposition = createProductionComposition({
      ...compositionOptions,
      delegatedAgentPort: {
        async describe(request) {
          return compositionOptions.delegatedAgentPort.describe(request);
        },
      },
      authorityOptions: {
        ...compositionOptions.authorityOptions,
        contractCatalogAdapter: { observe() { return catalogIdentity; } },
      },
    });
    asyncComposition.bindAuthority(sourceLookupAuthority);
    const runtime = createFlowRuntime({
      runAuthority: sourceLookupAuthority,
      reviewPreparationProvider: asyncComposition.reviewPreparationProvider,
    });
    const query = {
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    };
    const initial = await runtime.query(query);
    assert.equal(initial.schema, "flow.review-preparation-facts/v1");
    catalogIdentity = { ...catalogIdentity, fingerprint: DIGEST("0") };

    const currentQuery = await runtime.query(query);
    assert.equal(currentQuery.code, "catalog_changed");
    const launchRevalidation = await asyncComposition.reviewPreparationProvider.revalidate({
      facts: initial,
      inputs: { preparation_selection: reviewSelection() },
    });
    assert.equal(launchRevalidation.accepted, false);
    assert.equal(launchRevalidation.issue.code, "catalog_changed");
    assert.deepEqual(runtime.query().runs, []);
  });

  await t.test("async owner observations cannot replace owning authority projections", async () => {
    const asyncComposition = createProductionComposition({
      ...compositionOptions,
      authorityOptions: {
        ...compositionOptions.authorityOptions,
        reviewPreparationFactsAdapter: {
          async observe(context) {
            return {
              routeSnapshot: result.facts.route,
              candidateProjection: { ...context.candidateProjection, generation: 99 },
              sourceRunProjection: { ...context.sourceRunProjection, phase: "failed" },
              workspaceProjection: { ...context.workspaceProjection, generation: 99 },
              ownerAuthorities: {},
            };
          },
        },
      },
    });
    asyncComposition.bindAuthority(sourceLookupAuthority);
    const runtime = createFlowRuntime({
      runAuthority: sourceLookupAuthority,
      reviewPreparationProvider: asyncComposition.reviewPreparationProvider,
    });
    const currentQuery = await runtime.query({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    });
    assert.equal(currentQuery.schema, "flow.review-preparation-facts/v1");
    assert.equal(currentQuery.workspace.generation, 2);
    assert.deepEqual(currentQuery.owner_authorities, result.facts.owner_authorities);
    const launchRevalidation = await asyncComposition.reviewPreparationProvider.revalidate({
      facts: currentQuery,
      inputs: { preparation_selection: reviewSelection() },
    });
    assert.equal(launchRevalidation.accepted, true, JSON.stringify(launchRevalidation));
    assert.deepEqual(launchRevalidation.facts, currentQuery);
  });

  const replay = await composition.reviewPreparationProvider.derive({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("c"),
    selection: reviewSelection(),
  });
  assert.equal(replay.accepted, false);
  assert.equal(replay.issue.code, "candidate_fingerprint_mismatch");

  routeChanged = true;
  const drift = await provider.revalidate({
    facts: result.facts,
    inputs: {
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      preparation_selection: reviewSelection(),
    },
    prepared: null,
  });
  assert.equal(drift.accepted, false);
  assert.equal(drift.issue.code, "route_changed");
  const driftAuthorityFact = result.facts.owner_authorities.review;
  assert.equal(drift.issue.authority_watermark, driftAuthorityFact.watermark);
  assert.equal(drift.issue.authority_watermark_domain,
    driftAuthorityFact.watermark_domain);
  assert.equal(drift.issue.authority_fact.authority_id, "ReviewAuthority");
  assert.equal(drift.issue.authority_fact.authority_contract,
    driftAuthorityFact.authority_contract);
  assert.deepEqual(drift.issue.authority_fact.provider_identity,
    driftAuthorityFact.provider_identity);
  assert.equal(drift.issue.authority_fact.disposition,
    driftAuthorityFact.disposition);
  assert.equal(drift.issue.authority_fact.generation,
    driftAuthorityFact.generation);
  assert.deepEqual(drift.issue.authority_fact.facts,
    driftAuthorityFact.facts);
  assert.deepEqual(drift.issue.legal_actions, driftAuthorityFact.legal_actions);

  for (const [status, code] of [
    ["stale", "candidate_workspace_moved"],
    ["blocked", "candidate_workspace_blocked"],
  ]) {
    candidateStatus = status;
    const outcome = await provider.derive({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    });
    assert.equal(outcome.accepted, false, status);
    assert.equal(outcome.rejection.code, code, status);
    assert.equal(outcome.rejection.authority_watermark, DIGEST("b"), status);
    assert.equal(outcome.rejection.authority_watermark_domain, "host", status);
    assert.deepEqual(outcome.rejection.legal_actions, [`recover_${status}`], status);
    assert.equal(outcome.rejection.authority_fact.authority_id, "ReviewAuthority", status);
    assert.equal(outcome.rejection.authority_fact.watermark_domain, "review", status);
    assert.equal(outcome.rejection.authority_fact.disposition, status, status);
    assert.equal(outcome.rejection.authority_fact.provider_identity.id,
      "flow.production.review-authority", status);
    const rejectedCandidateProjection = reviewAuthority.query({
      contract: "work.review/v1",
      subject_id: "candidate:sealed",
    });
    assert.equal(outcome.rejection.authority_fact.facts.projection_digest,
      digest(rejectedCandidateProjection), status);
    const runtime = createFlowRuntime({
      runAuthority: sourceLookupAuthority,
      reviewPreparationProvider: provider,
    });
    const publicOutcome = await runtime.query({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    });
    assert.equal(publicOutcome.schema, "flow.rejection/v1", status);
    assert.equal(publicOutcome.code, code, status);
    assert.equal(publicOutcome.authority_watermark, DIGEST("e"), status);
    assert.equal(publicOutcome.authority_watermark_domain, "host", status);
    assert.equal(publicOutcome.authority_fact.watermark, DIGEST("b"), status);
    assert.equal(publicOutcome.authority_fact.watermark_domain, "review", status);
    assert.equal(publicOutcome.authority_fact.disposition, status, status);
    assert.deepEqual(publicOutcome.legal_actions, [`recover_${status}`], status);
  }

  candidateStatus = "sealed";
  git.clean = false;
  const workspaceDirty = await provider.derive({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: candidateFingerprint,
    selection: reviewSelection(),
  });
  assert.equal(workspaceDirty.accepted, false);
  assert.equal(workspaceDirty.rejection.code, "workspace_dirty");
  assert.equal(workspaceDirty.rejection.authority_watermark, DIGEST("d"));
  assert.equal(workspaceDirty.rejection.authority_watermark_domain, "host");
  assert.deepEqual(workspaceDirty.rejection.legal_actions,
    workspaceProjection.legal_actions);
  assert.equal(workspaceDirty.rejection.authority_fact.authority_contract,
    workspaceProjection.contract);
  assert.deepEqual(workspaceDirty.rejection.authority_fact.provider_identity, {
    schema: "flow.registered-authority/v1",
    id: "flow.production.workspace-authority",
    version: "1",
  });
  assert.equal(workspaceDirty.rejection.authority_fact.watermark_domain, "workspace");
  assert.equal(workspaceDirty.rejection.authority_fact.disposition,
    "retained_for_handoff");

  for (const [disposition, code] of [
    ["cleaned", "workspace_disposed"],
    ["released", "workspace_not_reviewable"],
    ["disposed", "workspace_not_reviewable"],
    ["unavailable", "workspace_not_reviewable"],
  ]) {
    workspaceProjection.disposition = disposition;
    workspaceProjection.legal_actions = [];
    const unavailableWorkspace = await provider.derive({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: "candidate:sealed",
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    });
    assert.equal(unavailableWorkspace.accepted, false, disposition);
    assert.equal(unavailableWorkspace.rejection.code, code, disposition);
    assert.equal(unavailableWorkspace.rejection.authority_watermark, DIGEST("d"), disposition);
    assert.equal(unavailableWorkspace.rejection.authority_watermark_domain, "host", disposition);
    assert.equal(unavailableWorkspace.rejection.authority_fact.authority_id,
      "WorkspaceAuthority", disposition);
    assert.equal(unavailableWorkspace.rejection.authority_fact.authority_contract,
      "work.workspace/v1", disposition);
    assert.equal(unavailableWorkspace.rejection.authority_fact.disposition,
      disposition, disposition);
    assert.equal(unavailableWorkspace.rejection.authority_fact.generation,
      workspace.generation, disposition);
    assert.equal(unavailableWorkspace.rejection.authority_fact.provider_identity.id,
      "flow.production.workspace-authority", disposition);
    if (["cleaned", "released", "disposed"].includes(disposition)) {
      assert.deepEqual(unavailableWorkspace.rejection.legal_actions, [], disposition);
      assert.deepEqual(unavailableWorkspace.rejection.authority_fact.legal_actions,
        [], disposition);
    } else {
      const [nextAction] = unavailableWorkspace.rejection.legal_actions;
      assert.equal(nextAction.schema, "work.legal-next-action/v1", disposition);
      assert.equal(nextAction.type, "workspace_reobservation_required", disposition);
      assert.equal(nextAction.subject_id, workspace.subject_id, disposition);
      assert.equal(nextAction.expected_watermark, DIGEST("d"), disposition);
    }
  }
});

function reviewSelection() {
  return {
    schema: "flow.review-preparation-selection/v1",
    lenses: ["security"],
    routes: {
      lenses: {
        security: {
          launch: {
            harness: "codex",
            role: "reviewer",
            model: "gpt-5.6",
            effort: "high",
            capability: "read-only",
          },
        },
      },
      critic: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
  };
}

test("production runtime publishes the authority-owned preparation query seam", async () => {
  const runtime = createProductionFlowRuntime({
    autonomous: false,
    runAuthority: createInMemoryRunAuthority(),
    delegatedAgentPort: { describe() {} },
  });
  const result = await runtime.query({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:missing",
    candidate_fingerprint: DIGEST("a"),
    selection: reviewSelection(),
  });
  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "authority_unavailable");
});

test("public preparation rejections bind the current host watermark and retain owner facts", async () => {
  const candidateFingerprint = DIGEST("a");
  const workspaceSubject = "workspace:review-rejection";
  const git = {
    commit_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    ref: "refs/heads/review-rejection",
    clean: true,
  };
  const candidateProjection = {
    schema: "work.review-candidate-projection/v1",
    contract: "work.review/v1",
    subject_id: "candidate:rejection",
    watermark: DIGEST("b"),
    generation: 1,
    status: "sealed",
    candidate_fingerprint: candidateFingerprint,
    candidate: {
      candidate_id: "candidate:rejection",
      candidate_fingerprint: candidateFingerprint,
      workspace: {
        subject_id: workspaceSubject,
        generation: 2,
        fingerprint: digest({ git }),
      },
    },
  };
  const sourceProjection = {
    schema: "flow.run-projection/v1",
    run_id: "run:rejection-source",
    phase: "succeeded",
    watermark: DIGEST("c"),
    review_candidate_reference: {
      candidate_id: candidateProjection.subject_id,
      candidate_fingerprint: candidateFingerprint,
    },
  };
  const workspaceProjection = {
    schema: "work.workspace-projection/v1",
    subject_id: workspaceSubject,
    generation: 2,
    mutation_epoch: 1,
    git,
    taint: null,
    watermark: DIGEST("d"),
  };
  const cases = [
    {
      owner: "review",
      rejection: {
        schema: "work.rejection/v1",
        operation: "query",
        code: "candidate_foreign",
        reason: "candidate belongs to another review authority",
        contract: "work.review/v1",
        subject_id: candidateProjection.subject_id,
        authority_watermark: DIGEST("e"),
        legal_actions: ["inspect_review_authority"],
        authority_fact: { owner: "ReviewAuthority", generation: 4 },
      },
    },
    {
      owner: "run",
      rejection: {
        schema: "flow.rejection/v1",
        operation: "query",
        code: "source_run_missing",
        reason: "RunAuthority has no retained source run",
        command_type: null,
        run_id: null,
        bundle_digest: null,
        authority_watermark: DIGEST("f"),
        authority_watermark_domain: "host",
        legal_actions: ["retain_source_run"],
        authority_fact: { owner: "RunAuthority", generation: 5 },
      },
    },
    {
      owner: "workspace",
      rejection: {
        schema: "work.rejection/v1",
        operation: "query",
        code: "workspace_dirty",
        reason: "WorkspaceAuthority reports a dirty workspace",
        contract: "work.workspace/v1",
        subject_id: workspaceSubject,
        authority_watermark: DIGEST("0"),
        legal_actions: ["refresh_workspace", "clean_workspace"],
        authority_fact: { owner: "WorkspaceAuthority", generation: 6 },
      },
    },
    {
      owner: "workspace",
      rejection: {
        schema: "work.rejection/v1",
        operation: "query",
        code: "workspace_unavailable",
        reason: "WorkspaceAuthority cannot reobserve this workspace",
        contract: "work.workspace/v1",
        subject_id: workspaceSubject,
        authority_watermark: DIGEST("0"),
        legal_actions: [],
        authority_fact: { owner: "WorkspaceAuthority", generation: 6 },
      },
    },
  ];

  for (const { owner, rejection } of cases) {
    const reviewAuthority = {
      schema: "work.review-authority/v1",
      query() {
        return owner === "review" ? rejection : candidateProjection;
      },
      command() { return { accepted: false }; },
    };
    const workspaceAuthority = {
      schema: "work.workspace-authority/v1",
      query() {
        return owner === "workspace" ? rejection : workspaceProjection;
      },
      command() { return { accepted: false }; },
    };
    const runAuthority = {
      query() {
        return {
          schema: "flow.run-index-projection/v1",
          watermark: DIGEST("1"),
          runs: [],
        };
      },
      queryByReviewCandidateReference() {
        return owner === "run" ? rejection : sourceProjection;
      },
    };
    attachWorkAuthorities(runAuthority, {
      workspace: workspaceAuthority,
      artifact: {
        schema: "work.artifact-authority/v1",
        query() { return rejection; },
        command() { return { accepted: false }; },
      },
      review: reviewAuthority,
      handoff: {
        schema: "flow.resource-handoff-authority/v1",
        query() { return rejection; },
        command() { return { accepted: false }; },
      },
    });
    const composition = createProductionComposition({
      delegatedAgentPort: { describe() { return null; } },
      authorityOptions: {
        timeObservationAdapter: { observe() { return []; } },
      },
    });
    composition.bindAuthority(runAuthority);
    const result = await composition.reviewPreparationProvider.derive({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: candidateProjection.subject_id,
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    });
    assert.equal(result.accepted, false, `${owner}: ${JSON.stringify(result)}`);
    assert.equal(result.rejection?.schema, "flow.rejection/v1",
      `${owner}: ${JSON.stringify(result)}`);
    assert.equal(result.rejection.code, rejection.code, owner);
    assert.equal(result.rejection.reason, rejection.reason, owner);
    assert.equal(result.rejection.authority_watermark, rejection.authority_watermark, owner);
    if (owner === "workspace" && rejection.legal_actions.length === 0) {
      assert.deepEqual(result.rejection.legal_actions, [{
        schema: "work.legal-next-action/v1",
        type: "workspace_reobservation_required",
        contract: "work.workspace/v1",
        command_schema: "work.workspace-observation-command/v1",
        subject_id: workspaceSubject,
        expected_watermark: rejection.authority_watermark,
        expected_generation: 6,
        expected_mutation_epoch: null,
        expected_fingerprint: null,
      }], owner);
    } else {
      assert.deepEqual(result.rejection.legal_actions, rejection.legal_actions, owner);
    }
    assert.equal(result.rejection.authority_fact.provider_identity.id,
      `flow.production.${owner === "run" ? "run-authority" : `${owner}-authority`}`, owner);
    assert.equal(result.rejection.authority_fact.watermark_domain, owner, owner);

    const runtime = createProductionFlowRuntime({
      autonomous: false,
      runAuthority,
      delegatedAgentPort: { describe() { return null; } },
      authorityOptions: {
        timeObservationAdapter: { observe() { return []; } },
      },
    });
    const publicResult = await runtime.query({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: candidateProjection.subject_id,
      candidate_fingerprint: candidateFingerprint,
      selection: reviewSelection(),
    });
    assert.equal(publicResult.schema, "flow.rejection/v1", owner);
    assert.equal(publicResult.code, rejection.code, owner);
    assert.equal(publicResult.reason, rejection.reason, owner);
    assert.equal(publicResult.authority_watermark, DIGEST("1"), owner);
    assert.equal(publicResult.authority_watermark_domain, "host", owner);
    assert.deepEqual(publicResult.legal_actions, result.rejection.legal_actions, owner);
    assert.deepEqual(publicResult.authority_fact, result.rejection.authority_fact, owner);
    assert.equal(publicResult.authority_fact.watermark,
      rejection.authority_watermark, owner);
    assert.equal(publicResult.authority_fact.watermark_domain, owner, owner);
    assert.notEqual(publicResult.authority_watermark,
      publicResult.authority_fact.watermark, owner);
    assert.equal(validateRejection(publicResult), true,
      `${owner}: ${rejectionAjv.errorsText(validateRejection.errors)}`);
  }
});

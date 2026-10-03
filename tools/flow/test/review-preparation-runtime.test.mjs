import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { digest } from "../src/canonical.mjs";
import {
  createFlowRuntime,
  revalidatePreparedReviewFacts,
} from "../src/flow-runtime.mjs";
import {
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import {
  createInMemoryReviewAuthority,
  createReviewDefinition,
} from "../src/review-flow.mjs";
import {
  deriveReviewPreparationFacts,
  reviewOwnerProjectionDigest,
  reviewExplicitFactsFromPreparationFacts,
} from "../src/review-preparation-facts.mjs";
import {
  shippedAuthorityRegistrations,
  shippedAuthorityStateFromFacts,
} from "../test-support/authority-bindings.mjs";

const DIGEST = (digit) => `sha256:${digit.repeat(64)}`;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function publicRejectionValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const name of [
    "flow.authority-fact.v1.schema.json",
    "flow.rejection.v1.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(join(
      repositoryRoot,
      "config/flow/schemas",
      name,
    ), "utf8")));
  }
  return ajv.getSchema(
    "https://dotfiles.local/schemas/flow.rejection.v1.schema.json",
  );
}

function facts() {
  const descriptionIdentity = {
    schema: "drovr.delegated-agent-description/v1",
    comparison_keys: {
      launch: DIGEST("6"),
      effective_authority: DIGEST("7"),
    },
    watermark: { content_sha256: DIGEST("8") },
  };
  const description = {
    ...descriptionIdentity,
    description_digest: digest(descriptionIdentity),
  };
  const routeBinding = {
    card_id: "review-lens-security",
    route: {
      agent_id: "agent:review-security",
      configuration_watermark: description.watermark.content_sha256,
      description_digest: description.description_digest,
      launch_comparison_key: description.comparison_keys.launch,
    },
    description,
  };
  const routeBindings = [routeBinding];
  const candidateProjection = {
      schema: "work.review-candidate-projection/v1",
      contract: "work.review/v1",
      subject_id: "candidate:sealed",
      watermark: DIGEST("b"),
      generation: 1,
      status: "sealed",
      candidate_fingerprint: DIGEST("a"),
      candidate: {
        candidate_id: "candidate:sealed",
        candidate_fingerprint: DIGEST("a"),
        workspace: {
          subject_id: "workspace:repository",
          generation: 2,
          mutation_epoch: 3,
          fingerprint: DIGEST("d"),
        },
      },
    };
  const sourceRunProjection = {
      run_id: "run:source",
      phase: "succeeded",
      watermark: DIGEST("c"),
      sequence: 12,
      current_revision: { ordinal: 0, plan_fingerprint: DIGEST("9") },
      bundle_digest: DIGEST("9"),
      review_candidate_reference: {
        candidate_id: "candidate:sealed",
        candidate_fingerprint: DIGEST("a"),
      },
    };
  const workspaceProjection = {
      schema: "work.workspace-projection/v1",
      contract: "work.workspace/v1",
      subject_id: "workspace:repository",
      generation: 2,
      mutation_epoch: 3,
      fingerprint: DIGEST("d"),
      clean: true,
      disposition: "retained_for_handoff",
      git: {
        commit_sha: "a".repeat(40),
        tree_sha: "b".repeat(40),
        ref: "refs/heads/test",
        clean: true,
      },
      taint: null,
      claims: [],
      watermark: DIGEST("e"),
    };
  const provider = (id) => ({
    schema: "flow.registered-authority/v1",
    id,
    version: "1",
  });
  const ownerFact = ({ owner, contract, domain, projection, generation,
    disposition, providerIdentity, facts }) => ({
    schema: "flow.authority-fact/v1",
    authority_id: owner,
    authority_contract: contract,
    provider_identity: providerIdentity,
    watermark: projection.watermark,
    watermark_domain: domain,
    subject_id: projection.run_id ?? projection.subject_id,
    disposition,
    generation,
    facts: {
      ...facts,
      projection_digest: reviewOwnerProjectionDigest(
        owner === "RunAuthority" ? "run" :
          owner === "WorkspaceAuthority" ? "workspace" : "review",
        projection,
      ),
    },
    legal_actions: projection.legal_actions ?? [],
  });
  const ownerAuthorities = {
    run: ownerFact({
      owner: "RunAuthority",
      contract: "flow.run-projection/v1",
      domain: "run",
      projection: sourceRunProjection,
      generation: sourceRunProjection.sequence,
      disposition: sourceRunProjection.phase,
      providerIdentity: provider("flow.production.run-authority"),
      facts: {
        run_id: sourceRunProjection.run_id,
        phase: sourceRunProjection.phase,
        candidate_id: "candidate:sealed",
        candidate_fingerprint: DIGEST("a"),
        sequence: sourceRunProjection.sequence,
        current_revision: sourceRunProjection.current_revision,
        bundle_digest: sourceRunProjection.bundle_digest,
      },
    }),
    review: ownerFact({
      owner: "ReviewAuthority",
      contract: "work.review/v1",
      domain: "review",
      projection: candidateProjection,
      generation: candidateProjection.generation,
      disposition: candidateProjection.status,
      providerIdentity: provider("flow.production.review-authority"),
      facts: {
        candidate_fingerprint: candidateProjection.candidate_fingerprint,
        workspace_subject_id: "workspace:repository",
        workspace_generation: 2,
        workspace_fingerprint: DIGEST("d"),
      },
    }),
    workspace: ownerFact({
      owner: "WorkspaceAuthority",
      contract: "work.workspace/v1",
      domain: "workspace",
      projection: workspaceProjection,
      generation: workspaceProjection.generation,
      disposition: workspaceProjection.disposition,
      providerIdentity: provider("flow.production.workspace-authority"),
      facts: {
        fingerprint: workspaceProjection.fingerprint,
        git_commit_sha: workspaceProjection.git.commit_sha,
        git_tree_sha: workspaceProjection.git.tree_sha,
        git_ref: workspaceProjection.git.ref,
        git_clean: true,
        mutation_epoch: workspaceProjection.mutation_epoch,
        taint_status: "clear",
        claims_digest: digest([]),
      },
    }),
  };
  return deriveReviewPreparationFacts({
    candidateProjection,
    sourceRunProjection,
    workspaceProjection,
    ownerAuthorities,
    authorityBindings: [
      authorityBinding("route:facts", "flow.route-authority/v1", "route_snapshot", DIGEST("f")),
      authorityBinding("resource:facts", "flow.resource-authority/v1", "resource_claims", DIGEST("0")),
      authorityBinding("contract:facts", "flow.contract-authority/v1", "contract_facts", DIGEST("1")),
      authorityBinding("generation:facts", "flow.subject-generation/v1", "subject_generations", DIGEST("2")),
    ],
    routeSnapshot: {
      route_id: "route:review",
      configuration_watermark: digest(routeBindings.map(({ card_id, route, description }) => ({
        card_id,
        route,
        description_digest: description.description_digest,
      }))),
      comparison_key: digest(routeBindings.map(({ card_id, route }) => ({
        card_id,
        launch_comparison_key: route.launch_comparison_key,
      }))),
      bindings: routeBindings,
    },
    catalog: { id: "flow.contract-catalog/v1@37", fingerprint: DIGEST("1") },
    operationContracts: ["flow.operation/review-record/v1"],
    validatorContracts: [
      "flow.validator/operation-receipt/v1",
      "flow.validator/review-result/v1",
    ],
    timeFacts: [
      {
        schema: "flow.time-fact/v1",
        kind: "wall_clock",
        value_ms: 1_700_000_000_000,
        uncertainty_ms: 0,
        clock_source_id: "wall:review",
      },
      {
        schema: "flow.time-fact/v1",
        kind: "suspend_excluding_monotonic",
        value_ns: "1000000000",
        uncertainty_ns: "0",
        clock_source_id: "mono:review",
      },
      {
        schema: "flow.time-fact/v1",
        kind: "boot",
        boot_id: "boot:review",
      },
      {
        schema: "flow.time-fact/v1",
        kind: "clock_source",
        identity: "clock:review",
      },
    ],
  }).facts;
}

function authorityBinding(id, contract, fact, watermark) {
  return {
    schema: "flow.required-authority-binding/v1",
    id,
    contract,
    provider_identity: {
      schema: "flow.registered-authority/v1",
      id: `test.provider.${id.replace(":", "-")}`,
      version: "1",
    },
    observation_input: { fact },
    observation: {
      schema: "flow.authority-observation/v1",
      status: "available",
      watermark,
      observation_input: { fact },
      legal_actions: [],
    },
  };
}

function reviewSelection() {
  return {
    schema: "flow.review-preparation-selection/v1",
    lenses: ["security"],
    routes: {
      lenses: { security: { launch: { harness: "codex" } } },
      critic: { launch: { harness: "claude" } },
    },
  };
}

test("public query derives review preparation facts through the runtime seam", async () => {
  const authority = createInMemoryRunAuthority();
  const calls = [];
  const runtime = createFlowRuntime({
    runAuthority: authority,
    reviewPreparationProvider: {
      derive(request) {
        calls.push(request);
        return { accepted: true, facts: facts() };
      },
    },
  });

  const result = await runtime.query({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
    selection: reviewSelection(),
  });

  assert.equal(result.schema, "flow.review-preparation-facts/v1");
  assert.deepEqual(calls, [{
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
    selection: reviewSelection(),
  }]);
});

test("public preparation query rejects malformed closed-schema requests before provider invocation", async (t) => {
  let calls = 0;
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewPreparationProvider: {
      derive() {
        calls += 1;
        return { accepted: true, facts: facts() };
      },
    },
  });
  const base = {
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
    selection: reviewSelection(),
  };
  const malformed = [
    { name: "foreign schema version", request: { ...base, schema: "flow.query/v2" } },
    { name: "null schema", request: { ...base, schema: null } },
    { name: "selection missing", request: (({ selection: _selection, ...request }) => request)(base) },
    { name: "candidate reference alias", request: {
      ...base,
      review_candidate_reference: {
        candidate_id: base.candidate_id,
        candidate_fingerprint: base.candidate_fingerprint,
      },
    } },
    { name: "selection alias", request: {
      ...((({ selection: _selection, ...request }) => request)(base)),
      review_selection: base.selection,
    } },
    { name: "extra top-level field", request: { ...base, extra: true } },
    { name: "empty selection candidate", request: {
      ...base,
      selection: {
        ...reviewSelection(),
        target: {
          candidate_id: "",
          candidate_fingerprint: DIGEST("a"),
        },
      },
    } },
    { name: "extra route field", request: {
      ...base,
      selection: {
        ...base.selection,
        routes: {
          ...base.selection.routes,
          lenses: { security: { launch: { harness: "codex" }, extra: {} } },
        },
      },
    } },
  ];
  for (const { name, request } of malformed) {
    await t.test(name, async () => {
      const result = await runtime.query(request);
      assert.equal(result.schema, "flow.rejection/v1", name);
      assert.equal(result.code, "invalid_review_preparation_query", name);
    });
  }
  assert.equal(calls, 0);
});

test("core accepts only the canonical reviewPreparationProvider option", async () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewPreparationFactsProvider: {
      derive() {
        return { accepted: true, facts: facts() };
      },
    },
  });
  const result = await runtime.query({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
    selection: reviewSelection(),
  });
  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "review_preparation_unavailable");
});

test("public preparation query rejects a candidate fingerprint replay", async () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewPreparationProvider: {
      derive() {
        return { accepted: true, facts: facts() };
      },
    },
  });
  const result = await runtime.query({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("b"),
    selection: {
      schema: "flow.review-preparation-selection/v1",
      lenses: ["security"],
      routes: {
        lenses: { security: { launch: { harness: "codex" } } },
        critic: { launch: { harness: "claude" } },
      },
    },
  });
  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "candidate_fingerprint_mismatch");
});

test("public preparation query preserves typed rejection wrappers", async () => {
  const validateRejection = await publicRejectionValidator();
  const authority = createInMemoryRunAuthority();
  const typedRejection = {
    schema: "flow.rejection/v1",
    operation: "prepare",
    code: "workspace_dirty",
    reason: "workspace is dirty",
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: DIGEST("e"),
    authority_watermark_domain: "workspace",
    legal_actions: ["refresh_workspace"],
    authority_fact: {
      schema: "flow.authority-fact/v1",
      authority_id: "workspace:facts",
      authority_contract: "flow.workspace-authority/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "test.workspace",
        version: "1",
      },
      watermark: DIGEST("e"),
      generation: 3,
      legal_actions: ["refresh_workspace"],
    },
  };
  for (const result of [
    typedRejection,
    { accepted: false, rejection: typedRejection },
    { accepted: false, issue: {
      code: typedRejection.code,
      reason: typedRejection.reason,
      authority_watermark: typedRejection.authority_watermark,
      authority_watermark_domain: typedRejection.authority_watermark_domain,
      legal_actions: typedRejection.legal_actions,
      authority_fact: typedRejection.authority_fact,
    } },
  ]) {
    const runtime = createFlowRuntime({
      runAuthority: authority,
      reviewPreparationProvider: { derive: () => result },
    });
    const observed = await runtime.query({
      schema: "flow.query/v1",
      query: "review_preparation_facts",
      candidate_id: "candidate:sealed",
      candidate_fingerprint: DIGEST("a"),
      selection: reviewSelection(),
    });
    assert.equal(observed.schema, "flow.rejection/v1");
    assert.equal(observed.code, typedRejection.code);
    assert.equal(observed.reason, typedRejection.reason);
    assert.equal(observed.authority_watermark_domain, "host");
    assert.equal(observed.authority_watermark, authority.query().watermark);
    assert.deepEqual(observed.legal_actions, typedRejection.legal_actions);
    assert.deepEqual(observed.authority_fact, typedRejection.authority_fact);
    assert.equal(validateRejection(observed), true,
      validateRejection.errors?.map(({ instancePath, message }) =>
        `${instancePath} ${message}`).join(", "));
  }
});

test("provider exceptions preserve the owner fact through public rejection wrapping", () => {
  const authorityFact = {
    schema: "flow.authority-fact/v1",
    authority_id: "WorkspaceAuthority",
    authority_contract: "work.workspace/v1",
    provider_identity: {
      schema: "flow.registered-authority/v1",
      id: "flow.production.workspace-authority",
      version: "1",
    },
    watermark: DIGEST("e"),
    watermark_domain: "workspace",
    subject_id: "workspace:review",
    disposition: "cleaned",
    generation: 4,
    facts: { projection_digest: DIGEST("f") },
    legal_actions: [{
      schema: "work.legal-next-action/v1",
      type: "workspace_reobservation_required",
      contract: "work.workspace/v1",
      command_schema: "work.workspace-observation-command/v1",
      subject_id: "workspace:review",
      expected_watermark: DIGEST("e"),
      expected_generation: 4,
      expected_mutation_epoch: 8,
      expected_fingerprint: DIGEST("a"),
    }],
  };
  const error = Object.assign(new Error("workspace was cleaned"), {
    code: "workspace_disposed",
    reason: "workspace disposition is cleaned",
    authority_watermark: DIGEST("e"),
    authority_watermark_domain: "workspace",
    legal_actions: authorityFact.legal_actions,
    authority_fact: authorityFact,
  });
  const authority = createInMemoryRunAuthority();
  const runtime = createFlowRuntime({
    runAuthority: authority,
    reviewPreparationProvider: {
      derive() { throw error; },
    },
  });
  const result = runtime.query({
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
    selection: reviewSelection(),
  });
  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "workspace_disposed");
  assert.equal(result.authority_watermark, authority.query().watermark);
  assert.equal(result.authority_watermark_domain, "host");
  assert.equal(result.authority_fact.watermark, DIGEST("e"));
  assert.deepEqual(result.authority_fact.legal_actions, []);
  assert.deepEqual(result.legal_actions, []);
});

test("prepare rejects invalid caller facts without echoing their owner provenance", () => {
  const suppliedFacts = structuredClone(facts());
  const forgedAction = { type: "attacker_supplied_recovery" };
  suppliedFacts.owner_authorities.review.legal_actions = [forgedAction];
  suppliedFacts.facts_digest = DIGEST("f");
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });

  const result = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs: {
      schema: "flow.review-request/v1",
      preparation_facts: suppliedFacts,
    },
  });

  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "facts_changed");
  assert.equal(result.authority_watermark, null);
  assert.equal(result.authority_watermark_domain, "host");
  assert.deepEqual(result.legal_actions, []);
  assert.equal(result.authority_fact, undefined);
  assert.equal(JSON.stringify(result).includes("attacker_supplied_recovery"), false);
});

test("facts-bound launch awaits async authority drift before RunAuthority.launch", async () => {
  let launches = 0;
  let adoptions = 0;
  const innerAuthority = createInMemoryRunAuthority();
  const authority = {
    launch(...args) {
      launches += 1;
      return innerAuthority.launch(...args);
    },
    query(...args) { return innerAuthority.query(...args); },
    queryByReviewCandidateReference(...args) {
      return innerAuthority.queryByReviewCandidateReference(...args);
    },
    adoptExactLaunch() {
      adoptions += 1;
      return {
        schema: "flow.launch-receipt/v1",
        run_id: "run:adopted-review",
      };
    },
  };
  const baseFacts = facts();
  const preparationFacts = {
    ...baseFacts,
    operation: {
      contracts: [...baseFacts.operation.contracts, "flow.operation/test-runtime/v1"].sort(),
    },
    owner_authorities: structuredClone(baseFacts.owner_authorities),
  };
  const workspaceFact = preparationFacts.owner_authorities.workspace;
  const workspaceRecoveryAction = {
    schema: "work.legal-next-action/v1",
    type: "workspace_reobservation_required",
    contract: "work.workspace/v1",
    command_schema: "work.workspace-observation-command/v1",
    subject_id: workspaceFact.subject_id,
    expected_watermark: workspaceFact.watermark,
    expected_generation: workspaceFact.generation,
    expected_mutation_epoch: workspaceFact.facts.mutation_epoch,
    expected_fingerprint: workspaceFact.facts.fingerprint,
  };
  workspaceFact.legal_actions = [workspaceRecoveryAction];
  preparationFacts.facts_digest = digest(Object.fromEntries(
    Object.entries(preparationFacts).filter(([key]) => key !== "facts_digest"),
  ));
  const explicitFacts = reviewExplicitFactsFromPreparationFacts(preparationFacts);
  const baseDefinition = createReviewDefinition();
  const definition = {
    ...baseDefinition,
    compile({ explicit_facts: selectedFacts }) {
      return {
        schema: "flow.dynamic-plan-proposal/v1",
        graph: {
          schema: "flow.run-plan/v1",
          cards: [{
            id: "test-runtime-operation",
            executor: {
              kind: "operation",
              contract: "flow.operation/test-runtime/v1",
              effect_classification: "caller_idempotent",
            },
            dependencies: [],
            inputs: {},
            outputs: ["test-runtime-receipt"],
            success_criteria: ["registered_operation_receipt:succeeded"],
            validators: ["flow.validator/operation-receipt/v1"],
            data_references: [],
            evidence_references: [],
            route: null,
            limits: { max_attempts: 1 },
            resource_claims: [],
            recovery: "caller_idempotent",
          }],
        },
        requested_authority: {
          commands: ["operation_execute"],
          capabilities: [],
          mutations: ["flow.operation/test-runtime/v1"],
        },
        explicit_facts: selectedFacts,
        revision_templates: [],
      };
    },
  };
  const candidateProjection = {
    schema: "work.review-candidate-projection/v1",
    contract: "work.review/v1",
    subject_id: preparationFacts.candidate.candidate_id,
    watermark: preparationFacts.candidate.authority_watermark,
    generation: preparationFacts.candidate.lifecycle_generation,
    status: "sealed",
    candidate_fingerprint: preparationFacts.candidate.candidate_fingerprint,
    candidate: {
      candidate_id: preparationFacts.candidate.candidate_id,
      candidate_fingerprint: preparationFacts.candidate.candidate_fingerprint,
      workspace: {
        subject_id: preparationFacts.workspace.subject_id,
        generation: preparationFacts.workspace.generation,
        mutation_epoch: preparationFacts.workspace.mutation_epoch,
        fingerprint: preparationFacts.workspace.fingerprint,
      },
    },
    legal_actions: [],
  };
  let ownerRevalidationIssue = {
    code: "workspace_disposed",
    reason: "workspace disposition changed to cleaned",
    authority_watermark: workspaceFact.watermark,
    authority_watermark_domain: "workspace",
    legal_actions: workspaceFact.legal_actions,
    authority_fact: workspaceFact,
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    reviewAuthority: createInMemoryReviewAuthority({ candidateProjection }),
    predefinedDefinitions: { "review/v1": definition },
    registeredAuthorities: shippedAuthorityRegistrations({
      current: shippedAuthorityStateFromFacts(explicitFacts),
    }),
    registeredOperations: {
      "flow.operation/test-runtime/v1": {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        validateCard() {},
        invoke() {
          return { schema: "flow.operation-receipt/v1", outcome: "succeeded" };
        },
      },
    },
    reviewPreparationProvider: {
      revalidate() {
        return Promise.resolve({
          valid: false,
          issue: ownerRevalidationIssue,
        });
      },
    },
  });

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs: {
      schema: "flow.review-request/v1",
      preparation_facts: preparationFacts,
    },
    explicit_facts: explicitFacts,
  });
  assert.equal(prepared.schema, "flow.prepared-run/v1", JSON.stringify(prepared));
  const request = {
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
      facts: prepared.explicit_facts,
    },
  };
  const launch = runtime.launch(request);
  assert.equal(typeof launch?.then, "function");
  const result = await launch;

  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "workspace_disposed", JSON.stringify(result));
  assert.equal(result.authority_watermark, authority.query().watermark);
  assert.notEqual(result.authority_watermark, workspaceFact.watermark);
  assert.equal(result.authority_watermark_domain, "host");
  assert.deepEqual(result.legal_actions, [workspaceRecoveryAction]);
  assert.deepEqual(result.authority_fact, workspaceFact);
  const validatesRejection = await publicRejectionValidator();
  assert.equal(validatesRejection(result), true, JSON.stringify(validatesRejection.errors));

  const sourceRunFact = preparationFacts.owner_authorities.run;
  ownerRevalidationIssue = {
    code: "run_authority_changed",
    reason: "retained source run authority changed",
    authority_watermark: sourceRunFact.watermark,
    authority_watermark_domain: "run",
    legal_actions: sourceRunFact.legal_actions,
    authority_fact: sourceRunFact,
  };
  const sourceRunResult = await runtime.launch(request);
  assert.equal(sourceRunResult.code, "run_authority_changed");
  assert.equal(sourceRunResult.authority_watermark_domain, "run");
  assert.equal(sourceRunResult.authority_watermark, sourceRunFact.watermark);
  assert.equal(sourceRunResult.run_id, sourceRunFact.subject_id);
  assert.deepEqual(sourceRunResult.authority_fact, sourceRunFact);
  assert.equal(validatesRejection(sourceRunResult), true,
    JSON.stringify(validatesRejection.errors));
  ownerRevalidationIssue.authority_watermark = null;
  const sourceRunFallback = await runtime.launch(request);
  assert.equal(sourceRunFallback.authority_watermark_domain, "run");
  assert.equal(sourceRunFallback.authority_watermark, sourceRunFact.watermark);
  assert.equal(sourceRunFallback.run_id, sourceRunFact.subject_id);
  assert.equal(adoptions, 0);
  assert.equal(launches, 0);
  assert.deepEqual(authority.query().runs, []);
});

test("local review rejects caller facts without an authority-derived envelope", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "review/v1": createReviewDefinition() },
  });
  const result = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "review/v1",
    inputs: {
      schema: "flow.review-request/v1",
      target: { schema: "flow.review-local-candidate/v1" },
      lenses: ["security"],
    },
    explicit_facts: { forged: true },
  });
  assert.equal(result.schema, "flow.rejection/v1", JSON.stringify(result));
  assert.equal(result.code, "review_preparation_required");
});

test("RunAuthority resolves the retained source run by candidate reference", () => {
  const authority = createInMemoryRunAuthority();
  assert.equal(typeof authority.queryByReviewCandidateReference, "function");
  const reference = {
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
  };
  const result = authority.queryByReviewCandidateReference(reference);
  assert.equal(result.schema, "flow.rejection/v1");
  assert.equal(result.code, "source_run_missing");
});

test("facts identity is never accepted from a private operation input", () => {
  const provider = {
    derive({ operation_input }) {
      assert.equal(operation_input, undefined);
      return { accepted: false, issue: { code: "authority_missing", legal_actions: [] } };
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewPreparationProvider: provider,
  });
  assert.equal(typeof runtime.query, "function");
});

test("malformed review preparation queries are rejected before review subject routing", () => {
  let providerCalls = 0;
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    reviewPreparationProvider: {
      derive() {
        providerCalls += 1;
        return facts();
      },
    },
  });
  const validRequest = {
    schema: "flow.query/v1",
    query: "review_preparation_facts",
    candidate_id: "candidate:sealed",
    candidate_fingerprint: DIGEST("a"),
    selection: {
      schema: "flow.review-preparation-selection/v1",
      lenses: ["security"],
      routes: {
        lenses: { security: { launch: { harness: "codex" } } },
        critic: { launch: { harness: "claude" } },
      },
    },
  };
  const malformed = [
    { ...validRequest, review_id: "review:forged" },
    { ...validRequest, contract: "work.review/v1", subject_id: "candidate:sealed" },
    { ...validRequest, contract: "work.review/v1", subject_id: "review:forged" },
  ];
  for (const request of malformed) {
    const result = runtime.query(request);
    assert.equal(result.schema, "flow.rejection/v1");
    assert.equal(result.code, "invalid_review_preparation_query");
  }
  assert.equal(providerCalls, 0);
});

test("review preparation revalidation binds local targets to the owning candidate", async (t) => {
  const preparationFacts = facts();
  const target = {
    schema: "flow.review-local-candidate/v1",
    candidate: { candidate_id: "candidate:sealed" },
    candidate_fingerprint: DIGEST("a"),
  };
  const preparedFixture = () => ({
    selection: {
      inputs: {
        target: structuredClone(target),
        preparation_facts: preparationFacts,
      },
    },
    graph: { cards: [{ inputs: { target: structuredClone(target) } }] },
    revision_templates: [{
      changes: { add_cards: [{ inputs: { target: structuredClone(target) } }] },
    }],
  });
  const cases = [
    ["matching identities", () => {}, false],
    ["selection candidate id differs", (prepared) => {
      prepared.selection.inputs.target.candidate.candidate_id = "candidate:other";
    }, true],
    ["selection candidate fingerprint differs", (prepared) => {
      prepared.selection.inputs.target.candidate_fingerprint = DIGEST("b");
    }, true],
    ["card candidate id differs", (prepared) => {
      prepared.graph.cards[0].inputs.target.candidate.candidate_id = "candidate:other";
    }, true],
    ["card candidate fingerprint differs", (prepared) => {
      prepared.graph.cards[0].inputs.target.candidate_fingerprint = DIGEST("b");
    }, true],
    ["revision addition candidate id differs", (prepared) => {
      prepared.revision_templates[0].changes.add_cards[0]
        .inputs.target.candidate.candidate_id = "candidate:other";
    }, true],
    ["revision addition candidate fingerprint differs", (prepared) => {
      prepared.revision_templates[0].changes.add_cards[0]
        .inputs.target.candidate_fingerprint = DIGEST("b");
    }, true],
  ];
  for (const [name, change, mismatch] of cases) {
    await t.test(name, () => {
      const prepared = preparedFixture();
      change(prepared);
      let providerCalls = 0;
      const issue = revalidatePreparedReviewFacts(prepared, {
        revalidate() {
          providerCalls += 1;
          return { valid: true, facts: preparationFacts };
        },
      });
      if (mismatch) {
        assert.equal(issue?.code, "preparation_facts_candidate_mismatch");
        assert.equal(providerCalls, 0);
      } else {
        assert.equal(issue, null);
        assert.equal(providerCalls, 1);
      }
    });
  }
});

test("fresh review preparation drift is closed for every required binding class", () => {
  const prepared = {
    selection: { inputs: { preparation_facts: facts() } },
  };
  for (const code of [
    "candidate_changed",
    "workspace_changed",
    "source_run_changed",
    "route_changed",
    "catalog_changed",
    "operation_changed",
    "validator_changed",
    "time_changed",
    "authority_changed",
  ]) {
    const issue = revalidatePreparedReviewFacts(prepared, {
      revalidate() {
        return {
          valid: false,
          issue: { code, reason: `${code} owner changed`, legal_actions: [] },
        };
      },
    });
    assert.equal(issue.code, code);
    assert.deepEqual(issue.legal_actions, []);
  }
});

assert.equal(typeof digest, "function");

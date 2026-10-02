import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { digest } from "../src/canonical.mjs";
import {
  REVIEW_PREPARATION_FACTS_SCHEMA,
  deriveReviewPreparationFacts,
  reviewOwnerProjectionDigest,
  reviewExplicitFactsFromPreparationFacts,
  validateReviewPreparationFacts,
  workspaceRecoveryActions,
} from "../src/review-preparation-facts.mjs";

const DIGEST = (digit) => `sha256:${digit.repeat(64)}`;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PROVIDER_IDENTITIES = Object.freeze({
  route: provider("flow.production.route-snapshot"),
  resource: provider("flow.production.resource-claims"),
  contract: provider("flow.production.contract-facts"),
  generation: provider("flow.production.subject-generations"),
});

function provider(id) {
  return {
    schema: "flow.registered-authority/v1",
    id,
    version: "1",
  };
}

function ownerAuthority({
  owner,
  contract,
  domain,
  projection,
  generation,
  disposition,
  facts,
  providerIdentity,
}) {
  return {
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
  };
}

function binding(id, contract, providerIdentity, watermark, fact) {
  return {
    schema: "flow.required-authority-binding/v1",
    id,
    contract,
    provider_identity: providerIdentity,
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

test("RunAuthority provenance ignores only its refreshable execution-time view", () => {
  const input = sourceInput();
  input.sourceRunProjection.execution_time = {
    schema: "flow.execution-time-projection/v1",
    status: "current",
    active_elapsed_seconds: 12,
  };
  const first = deriveReviewPreparationFacts(input);
  assert.equal(first.accepted, true, JSON.stringify(first));

  input.sourceRunProjection.execution_time = {
    schema: "flow.execution-time-projection/v1",
    status: "current",
    active_elapsed_seconds: 13,
  };
  const refreshed = deriveReviewPreparationFacts(input);
  assert.equal(refreshed.accepted, true, JSON.stringify(refreshed));
  assert.deepEqual(
    refreshed.facts.owner_authorities.run,
    first.facts.owner_authorities.run,
  );

  const changedStream = structuredClone(input);
  changedStream.sourceRunProjection.sequence += 1;
  const rejected = deriveReviewPreparationFacts(changedStream);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.rejection.code, "authority_changed");
  assert.equal(rejected.rejection.authority_fact.authority_id, "RunAuthority");
});

function sourceInput(overrides = {}) {
  const candidateFingerprint = DIGEST("a");
  const workspaceFingerprint = DIGEST("b");
  const sourceRunWatermark = DIGEST("c");
  const candidateWatermark = DIGEST("d");
  const workspaceWatermark = DIGEST("e");
  const bindings = [
    binding(
      "route:facts",
      "flow.route-authority/v1",
      PROVIDER_IDENTITIES.route,
      DIGEST("f"),
      "route_snapshot",
    ),
    binding(
      "resource:facts",
      "flow.resource-authority/v1",
      PROVIDER_IDENTITIES.resource,
      DIGEST("0"),
      "resource_claims",
    ),
    binding(
      "contract:facts",
      "flow.contract-authority/v1",
      PROVIDER_IDENTITIES.contract,
      DIGEST("1"),
      "contract_facts",
    ),
    binding(
      "generation:facts",
      "flow.subject-generation/v1",
      PROVIDER_IDENTITIES.generation,
      DIGEST("2"),
      "subject_generations",
    ),
  ];
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
  const route = {
    agent_id: "agent:review-security",
    configuration_watermark: description.watermark.content_sha256,
    description_digest: description.description_digest,
    launch_comparison_key: description.comparison_keys.launch,
  };
  const routeBindings = [{
    card_id: "review-lens-security",
    route,
    description,
  }];
  const input = {
    candidateProjection: {
      schema: "work.review-candidate-projection/v1",
      contract: "work.review/v1",
      subject_id: "candidate:sealed",
      watermark: candidateWatermark,
      generation: 1,
      status: "sealed",
      candidate_fingerprint: candidateFingerprint,
      candidate: {
        schema: "work.review-candidate/v1",
        candidate_id: "candidate:sealed",
        candidate_fingerprint: candidateFingerprint,
        workspace: {
          subject_id: "workspace:repository",
          generation: 4,
          mutation_epoch: 7,
          fingerprint: workspaceFingerprint,
        },
      },
      legal_actions: [],
    },
    sourceRunProjection: {
      run_id: "run:feature",
      phase: "succeeded",
      watermark: sourceRunWatermark,
      sequence: 12,
      current_revision: { ordinal: 0, plan_fingerprint: DIGEST("8") },
      bundle_digest: DIGEST("9"),
      review_candidate_reference: {
        candidate_id: "candidate:sealed",
        candidate_fingerprint: candidateFingerprint,
      },
    },
    workspaceProjection: {
      schema: "work.workspace-projection/v1",
      contract: "work.workspace/v1",
      subject_id: "workspace:repository",
      generation: 4,
      mutation_epoch: 7,
      fingerprint: workspaceFingerprint,
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
      watermark: workspaceWatermark,
    },
    authorityBindings: bindings,
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
    catalog: {
      id: "flow.contract-catalog/v1@36",
      fingerprint: DIGEST("5"),
    },
    operationContracts: ["flow.operation/review-record/v1"],
    validatorContracts: [
      "flow.validator/review-result/v1",
      "flow.validator/operation-receipt/v1",
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
        identity: "clock:utc",
      },
    ],
    ...overrides,
  };
  const candidate = input.candidateProjection;
  const sourceRun = input.sourceRunProjection;
  const workspace = input.workspaceProjection;
  input.ownerAuthorities = candidate === null || sourceRun === null || workspace === null
    ? undefined
    : {
    run: ownerAuthority({
      owner: "RunAuthority",
      contract: "flow.run-projection/v1",
      domain: "run",
      projection: sourceRun,
      disposition: sourceRun.phase,
      generation: sourceRun.sequence,
      providerIdentity: provider("flow.production.run-authority"),
      facts: {
        run_id: sourceRun.run_id,
        phase: sourceRun.phase,
        candidate_id: sourceRun.review_candidate_reference.candidate_id,
        candidate_fingerprint: sourceRun.review_candidate_reference.candidate_fingerprint,
        sequence: sourceRun.sequence,
        current_revision: sourceRun.current_revision,
        bundle_digest: sourceRun.bundle_digest,
      },
    }),
    review: ownerAuthority({
      owner: "ReviewAuthority",
      contract: "work.review/v1",
      domain: "review",
      projection: candidate,
      disposition: candidate.status,
      generation: candidate.generation,
      providerIdentity: provider("flow.production.review-authority"),
      facts: {
        candidate_fingerprint: candidate.candidate_fingerprint,
        workspace_subject_id: candidate.candidate.workspace.subject_id,
        workspace_generation: candidate.candidate.workspace.generation,
        workspace_fingerprint: candidate.candidate.workspace.fingerprint,
      },
    }),
    workspace: ownerAuthority({
      owner: "WorkspaceAuthority",
      contract: "work.workspace/v1",
      domain: "workspace",
      projection: workspace,
      disposition: workspace.disposition,
      generation: workspace.generation,
      providerIdentity: provider("flow.production.workspace-authority"),
      facts: {
        fingerprint: workspace.fingerprint,
        git_commit_sha: workspace.git.commit_sha,
        git_tree_sha: workspace.git.tree_sha,
        git_ref: workspace.git.ref,
        git_clean: workspace.git.clean,
        mutation_epoch: workspace.mutation_epoch,
        taint_status: "clear",
        claims_digest: digest(workspace.claims),
      },
    }),
    };
  return input;
}

test("derives a canonical, self-digested local-review facts envelope", () => {
  const result = deriveReviewPreparationFacts(sourceInput());

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.facts.schema, REVIEW_PREPARATION_FACTS_SCHEMA);
  assert.equal(result.facts.candidate.candidate_id, "candidate:sealed");
  assert.equal(result.facts.source_run.run_id, "run:feature");
  assert.equal(result.facts.workspace.subject_id, "workspace:repository");
  assert.equal(result.facts.workspace.generation, 4);
  assert.equal(result.facts.workspace.fingerprint, DIGEST("b"));
  assert.equal(result.facts.operation.contracts[0], "flow.operation/review-record/v1");
  assert.equal(result.facts.validator.contracts.length, 2);
  const { facts_digest: factsDigest, ...factsIdentity } = result.facts;
  assert.equal(factsDigest, digest(factsIdentity));
  assert.equal(validateReviewPreparationFacts(result.facts).valid, true);
  assert.equal(Object.isFrozen(result.facts), true);
});

test("facts contract lists match the strict schema and runtime contract", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const name of [
    "flow.time-fact.v1.schema.json",
    "flow.review-preparation-facts.v1.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(join(
      repositoryRoot,
      "config/flow/schemas",
      name,
    ), "utf8")));
  }
  const validateSchema = ajv.getSchema(
    "https://dotfiles.local/schemas/flow.review-preparation-facts.v1.schema.json",
  );
  const valid = deriveReviewPreparationFacts(sourceInput()).facts;
  assert.equal(validateSchema(valid), true, ajv.errorsText(validateSchema.errors));
  assert.equal(validateReviewPreparationFacts(valid).valid, true);

  const invalidContractLists = [
    (copy) => { copy.operation.contracts = []; },
    (copy) => { copy.operation.contracts.push(copy.operation.contracts[0]); },
    (copy) => { copy.validator.contracts = [copy.validator.contracts[0]]; },
    (copy) => { copy.validator.contracts.push(copy.validator.contracts[0]); },
  ];
  for (const mutate of invalidContractLists) {
    const copy = structuredClone(valid);
    mutate(copy);
    const { facts_digest: _oldDigest, ...identity } = copy;
    copy.facts_digest = digest(identity);
    assert.equal(validateSchema(copy), false, ajv.errorsText(validateSchema.errors));
    assert.equal(validateReviewPreparationFacts(copy).valid, false);
  }

  const noncanonical = structuredClone(valid);
  noncanonical.validator.contracts.reverse();
  const { facts_digest: _noncanonicalDigest, ...noncanonicalIdentity } = noncanonical;
  noncanonical.facts_digest = digest(noncanonicalIdentity);
  assert.equal(validateSchema(noncanonical), true,
    "the schema enforces required unique contracts but cannot compare dynamic string ordering");
  assert.equal(validateReviewPreparationFacts(noncanonical).valid, false,
    "runtime validation enforces the canonical lexical order");

  const noncanonicalOperation = structuredClone(valid);
  noncanonicalOperation.operation.contracts.push(
    "flow.operation/z-after-review/v1",
  );
  noncanonicalOperation.operation.contracts.sort().reverse();
  const { facts_digest: _noncanonicalOperationDigest, ...noncanonicalOperationIdentity } =
    noncanonicalOperation;
  noncanonicalOperation.facts_digest = digest(noncanonicalOperationIdentity);
  assert.equal(validateSchema(noncanonicalOperation), true,
    "the schema cannot compare ordering for dynamic operation contract extensions");
  assert.equal(validateReviewPreparationFacts(noncanonicalOperation).valid, false,
    "runtime validation enforces operation contract ordering too");

  const extension = structuredClone(valid);
  extension.operation.contracts.push("flow.operation/a-before-review/v1");
  extension.operation.contracts.sort();
  const { facts_digest: _oldDigest, ...extensionIdentity } = extension;
  extension.facts_digest = digest(extensionIdentity);
  assert.equal(validateSchema(extension), true, ajv.errorsText(validateSchema.errors));
  assert.equal(validateReviewPreparationFacts(extension).valid, true);
});

test("terminal workspace dispositions have no reobservation recovery action", () => {
  for (const disposition of ["cleaned", "released", "disposed"]) {
    assert.deepEqual(workspaceRecoveryActions({
      subject_id: "workspace:review",
      watermark: DIGEST("e"),
      generation: 4,
      mutation_epoch: 8,
      fingerprint: DIGEST("a"),
      disposition,
    }), [], disposition);
  }
  assert.equal(workspaceRecoveryActions({
    subject_id: "workspace:review",
    watermark: DIGEST("e"),
    generation: 4,
    mutation_epoch: 8,
    fingerprint: DIGEST("a"),
    disposition: "retained_for_handoff",
  })[0]?.type, "workspace_reobservation_required");
});

test("derivation rejects an empty route identity before facts validation", () => {
  const input = sourceInput();
  input.routeSnapshot.route_id = "";

  const result = deriveReviewPreparationFacts(input);

  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, "route_changed");
  assert.equal(result.rejection.reason, "review route identity is unavailable");
});

test("facts construction is deterministic and excludes private operation input", () => {
  const first = deriveReviewPreparationFacts(sourceInput());
  const second = deriveReviewPreparationFacts(sourceInput());

  assert.deepEqual(first, second);
  assert.equal("operation_input" in first.facts, false);
  assert.equal(JSON.stringify(first.facts).includes("operation_input"), false);
  assert.equal(JSON.stringify(first.facts).includes("authority_materialized"), false);
});

test("runtime validation rejects empty source run and route identities", () => {
  const accepted = deriveReviewPreparationFacts(sourceInput());
  assert.equal(accepted.accepted, true);
  for (const mutate of [
    (facts) => { facts.source_run.run_id = ""; },
    (facts) => { facts.route.route_id = ""; },
  ]) {
    const identity = structuredClone(accepted.facts);
    delete identity.facts_digest;
    mutate(identity);
    const tampered = { ...identity, facts_digest: digest(identity) };
    assert.equal(validateReviewPreparationFacts(tampered).valid, false);
  }
});

test("materialization carries every selected route and never invents a placeholder", () => {
  const prepared = reviewExplicitFactsFromPreparationFacts(
    deriveReviewPreparationFacts(sourceInput()).facts,
  );
  assert.deepEqual(
    prepared.route_snapshot.bindings.map(({ card_id }) => card_id),
    ["review-lens-security"],
  );
  assert.equal(prepared.route_snapshot.bindings[0].description.schema,
    "drovr.delegated-agent-description/v1");
  assert.equal(prepared.route_snapshot.bindings[0].route.agent_id,
    "agent:review-security");
  assert.doesNotMatch(JSON.stringify(prepared), /review-route/u);
});

for (const [label, override, code] of [
  ["missing candidate", { candidateProjection: null }, "candidate_missing"],
  ["stale candidate", { candidateProjection: {
    ...sourceInput().candidateProjection,
    status: "stale",
  } }, "candidate_stale"],
  ["foreign source run", { sourceRunProjection: {
    ...sourceInput().sourceRunProjection,
    review_candidate_reference: {
      candidate_id: "candidate:other",
      candidate_fingerprint: DIGEST("a"),
    },
  } }, "source_run_foreign"],
  ["dirty workspace", { workspaceProjection: {
    ...sourceInput().workspaceProjection,
    clean: false,
  } }, "workspace_dirty"],
  ["unavailable provider", { authorityBindings: [
    ...sourceInput().authorityBindings.slice(0, 3),
    {
      ...sourceInput().authorityBindings[3],
      observation: {
        ...sourceInput().authorityBindings[3].observation,
        status: "unavailable",
        legal_actions: ["refresh_authority"],
      },
    },
  ] }, "authority_unavailable"],
]) {
  test(`rejects ${label} with a typed redacted outcome`, () => {
    const result = deriveReviewPreparationFacts(sourceInput(override));

    assert.equal(result.accepted, false);
    assert.equal(result.rejection.schema, "flow.rejection/v1");
    assert.equal(result.rejection.code, code);
    if (code === "authority_unavailable") {
      assert.deepEqual(result.rejection.legal_actions, ["refresh_authority"]);
    } else if (code === "workspace_dirty") {
      assert.deepEqual(result.rejection.legal_actions, [{
        schema: "work.legal-next-action/v1",
        type: "workspace_reobservation_required",
        contract: "work.workspace/v1",
        command_schema: "work.workspace-observation-command/v1",
        subject_id: "workspace:repository",
        expected_watermark: DIGEST("e"),
        expected_generation: 4,
        expected_mutation_epoch: 7,
        expected_fingerprint: DIGEST("b"),
      }]);
    } else {
      assert.deepEqual(result.rejection.legal_actions, []);
    }
    assert.equal("operation_input" in result.rejection, false);
    assert.equal(JSON.stringify(result.rejection).includes("private"), false);
  });
}

test("review preparation rejects any partial canonical time-fact set", () => {
  const complete = sourceInput().timeFacts;
  for (const kind of [
    "wall_clock",
    "suspend_excluding_monotonic",
    "boot",
    "clock_source",
  ]) {
    const result = deriveReviewPreparationFacts(sourceInput({
      timeFacts: complete.filter((fact) => fact.kind !== kind),
    }));
    assert.equal(result.accepted, false, kind);
    assert.equal(result.rejection.code, "time_unavailable", kind);
  }
});

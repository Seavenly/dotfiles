import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  digest,
  freezeCanonical,
} from "../../../tools/flow/src/canonical.mjs";
import { validateRebootEffectRechecks } from "../../../tools/flow/src/reboot-effects.mjs";
import { executionTimeFacts } from "../../../tools/flow/test-support/time-facts.mjs";
import { completedTurnProjection } from
  "../../../tools/flow/test-support/delegate-card.mjs";
import { supportedDescription, repositoryDrovrDependencies } from "../../../tools/flow/test-support/delegated-agent-description.mjs";
import {
  closeFlowRuntime,
  createFlowRuntime,
  statusFlowRuntime,
} from "../src/runtime.mjs";
import { createProductionComposition } from "../src/production-composition.mjs";
import { validateFeatureCritiqueOutput } from
  "../src/production-feature-operations.mjs";

const execFile = promisify(execFileCallback);

test("default FlowRuntime is durable and autonomous", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-runtime-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(repository, { recursive: true });
  await execFile("git", ["-C", repository, "init", "--quiet"]);
  await execFile("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await execFile("git", ["-C", repository, "add", "README.md"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "initial"]);

  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: {
      async describe() {
        return null;
      },
    },
  });
  t.after(() => closeFlowRuntime(runtime));

  await stat(join(state, "flow", "authority.sqlite"));
  assert.equal(statusFlowRuntime(runtime).state, "running");
});

test("default production work evidence fails closed without authoritative bytes", () => {
  const composition = createProductionComposition({
    delegatedAgentPort: supportedDelegatedAgentPort(),
  });
  const validation = composition.authorityOptions.workEvidenceAdapter.validate({
    workspace: { subject_id: "workspace:caller-shaped" },
    command: {
      disposition: "evidence_backed_adoption",
      evidence: { digest: `sha256:${"a".repeat(64)}` },
    },
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.taint_evidence_digest, null);
  assert.equal(validation.evidence_digest, null);
});

test("production reboot observation uses exact synchronous registered effect evidence", () => {
  const contract = "flow.operation/test-reboot-observation/v1";
  const observedIntents = [];
  const composition = createProductionComposition({
    delegatedAgentPort: supportedDelegatedAgentPort(),
    registeredOperations: {
      [contract]: {
        schema: "flow.registered-operation/v1",
        classification: "reconcilable",
        invoke() {},
        observe(intent) {
          observedIntents.push(intent);
          return {
            schema: "flow.effect-observation/v1",
            effect_id: intent.effect_id,
            idempotency_key: intent.idempotency_key,
            presence: "present",
            causation: {
              effect_id: intent.effect_id,
              idempotency_key: intent.idempotency_key,
            },
            provider_observation: {
              found: true,
              proof: "provider-record",
              secret_material: "token=do-not-project",
              unknown_nested: { credential: "must-not-escape" },
            },
          };
        },
      },
    },
  });
  const intent = {
    effect_id: "effect:reboot-observation",
    idempotency_key: "idempotency:reboot-observation",
    classification: "reconcilable",
    operation_contract: contract,
  };
  const prepared = {
    explicit_facts: {
      catalog_fingerprint: "catalog",
      route_snapshot: {},
      capability_envelopes: [],
      operation_contracts: [],
      validator_contracts: [],
      subject_generations: [],
    },
  };

  const observation = composition.authorityOptions.rebootObservationAdapter.observe({
    prepared,
    currentFacts: {
      resource_claims: [],
      limits: {},
      elapsed_seconds: 0,
    },
    unresolvedEffects: [intent],
  });

  assert.deepEqual(observedIntents, [intent]);
  assert.equal(observedIntents.length, 1);
  assert.deepEqual(observation.effect_rechecks, [{
    schema: "flow.reboot-effect-recheck/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    classification: intent.classification,
    operation_contract: intent.operation_contract,
    recovery: "reconcile",
    observed_status: "reconciling",
    observation: {
      schema: "flow.effect-observation/v1",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      presence: "present",
      causation: {
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
      },
      provider_observation: {
        found: true,
        proof: "provider-record",
      },
    },
  }]);
});

test("production reboot observation normalizes causation by proven presence", () => {
  const contract = "flow.operation/test-reboot-causation/v1";
  const composition = createProductionComposition({
    delegatedAgentPort: supportedDelegatedAgentPort(),
    registeredOperations: {
      [contract]: {
        schema: "flow.registered-operation/v1",
        classification: "reconcilable",
        invoke() {},
        observe(intent) {
          const presence = intent.effect_id.endsWith("present")
            ? "present"
            : intent.effect_id.endsWith("absent")
              ? "absent"
              : "indeterminate";
          return {
            schema: "flow.effect-observation/v1",
            effect_id: intent.effect_id,
            idempotency_key: intent.idempotency_key,
            presence,
            causation: {
              effect_id: "effect:forged",
              idempotency_key: "idempotency:forged",
              secret_material: "must-not-escape",
            },
            provider_observation: presence === "present"
              ? { found: true, proof: "provider-record" }
              : presence === "absent"
                ? { found: false, proof: "provider-record" }
                : { status: "unknown", secret_material: "must-not-escape" },
          };
        },
      },
    },
  });
  const prepared = {
    explicit_facts: {
      catalog_fingerprint: "catalog",
      route_snapshot: {},
      capability_envelopes: [],
      operation_contracts: [],
      validator_contracts: [],
      subject_generations: [],
    },
  };
  const intents = ["present", "absent", "indeterminate"].map((state) => ({
    effect_id: `effect:causation-${state}`,
    idempotency_key: `idempotency:causation-${state}`,
    classification: "reconcilable",
    operation_contract: contract,
  }));

  const observation = composition.authorityOptions.rebootObservationAdapter.observe({
    prepared,
    currentFacts: {
      resource_claims: [],
      limits: {},
      elapsed_seconds: 0,
    },
    unresolvedEffects: intents,
  });

  assert.deepEqual(observation.effect_rechecks.map(({ observation: effect }) => ({
    presence: effect.presence,
    causation: effect.causation,
    provider_observation: effect.provider_observation,
  })), [
    {
      presence: "present",
      causation: {
        effect_id: intents[0].effect_id,
        idempotency_key: intents[0].idempotency_key,
      },
      provider_observation: {
        found: true,
        proof: "provider-record",
      },
    },
    {
      presence: "absent",
      causation: null,
      provider_observation: {
        found: false,
        proof: "provider-record",
      },
    },
    {
      presence: "indeterminate",
      causation: null,
      provider_observation: {
        schema: "flow.provider-observation/v1",
        status: "unavailable",
        reason: "registered_observation_invalid",
      },
    },
  ]);
});

test("production reboot observation leaves repeat-exact effects indeterminate without fabricated presence", () => {
  const intent = {
    effect_id: "effect:repeat-exact-reboot",
    idempotency_key: "idempotency:repeat-exact-reboot",
    classification: "caller_idempotent",
    operation_contract: "flow.operation/feature-verify/v1",
  };
  const prepared = {
    explicit_facts: {
      catalog_fingerprint: "catalog",
      route_snapshot: {},
      capability_envelopes: [],
      operation_contracts: [],
      validator_contracts: [],
      subject_generations: [],
    },
  };
  const composition = createProductionComposition({
    delegatedAgentPort: supportedDelegatedAgentPort(),
  });
  const observation = composition.authorityOptions.rebootObservationAdapter.observe({
    prepared,
    currentFacts: {
      resource_claims: [],
      limits: {},
      elapsed_seconds: 0,
    },
    unresolvedEffects: [intent],
  });
  const [recheck] = observation.effect_rechecks;

  assert.equal(recheck.observation.presence, "indeterminate");
  assert.equal(
    validateRebootEffectRechecks([recheck], [intent]),
    true,
  );
});

test("ordinary feature preparation derives immutable facts from a brief and repository", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-preparation-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(repository, { recursive: true });
  await execFile("git", ["-C", repository, "init", "--quiet"]);
  await execFile("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await execFile("git", ["-C", repository, "add", "README.md"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "initial"]);

  const delegatedAgentPort = {
    async describe(request) {
      const description = await supportedDescription(
        request,
        repositoryDrovrDependencies(),
      );
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "compatible",
        watermark: description.watermark,
        description,
        compatibility: {
          contract: "flow.delegated-agent-port/v1",
          code: null,
          findings: [],
        },
        legal_next_actions: ["bind_exact_launch_description"],
      };
    },
  };
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const prepared = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:production-test",
      summary: "Add an observable feature",
      acceptance: ["the changed behavior is observable"],
    },
    repository: { path: repository },
    mode: "verify",
    routes: {
      apply: {
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "workspace-write",
        },
      },
      critique: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
    limits: { max_elapsed_seconds: 600 },
  });

  assert.equal(prepared.kind, "predefined");
  assert.deepEqual(prepared.definition, {
    schema: "flow.predefined-definition/v1",
    id: "feature/v1",
    contract: "flow.definition/feature/v1",
  });
  assert.equal(prepared.selection.inputs.brief.id, "brief:production-test");
  assert.equal(prepared.selection.inputs.finalization, undefined);
  assert.equal(prepared.selection.inputs.patch, undefined);
  assert.equal(prepared.selection.inputs.workspace.git.clean, true);
  assert.match(prepared.selection.inputs.workspace.git.commit_sha, /^[0-9a-f]{40}$/u);
  assert.match(prepared.selection.inputs.workspace.git.tree_sha, /^[0-9a-f]{40}$/u);
  assert.equal(
    prepared.selection.inputs.workspace.fingerprint,
    digest({ git: prepared.selection.inputs.workspace.git }),
  );
  assert.deepEqual(
    prepared.required_authorities.map(({ id }) => id),
    ["contract:facts", "generation:facts", "resource:facts", "route:facts"],
  );
});

test("production preparation enforces the closed published request schema", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-preparation-schema-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repository = await createCommittedRepository(scratch, "schema");
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
    delegatedAgentPort: supportedDelegatedAgentPort(),
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));
  const valid = preparationRequest(repository, "brief:closed-schema");
  const missingSchema = structuredClone(valid);
  delete missingSchema.schema;
  const missingMode = structuredClone(valid);
  delete missingMode.mode;
  const missingRoutes = structuredClone(valid);
  delete missingRoutes.routes;
  const delegationAlias = structuredClone(valid);
  delete delegationAlias.routes;
  delegationAlias.delegation = valid.routes;
  const unknownTopLevel = { ...valid, undocumented: true };
  const unknownNested = structuredClone(valid);
  unknownNested.routes.apply.launch.undocumented = true;

  for (const [label, request] of [
    ["schema", missingSchema],
    ["mode", missingMode],
    ["routes", missingRoutes],
    ["delegation alias", delegationAlias],
    ["top-level key", unknownTopLevel],
    ["nested key", unknownNested],
  ]) {
    await assert.rejects(
      runtime.prepare(request),
      (error) => error?.code === "invalid_preparation_request",
      label,
    );
  }
  const prepared = await runtime.prepare(valid);
  assert.equal(prepared.schema, "flow.prepared-run/v1");
});

test("concurrent production preparations keep authority observations selection-scoped", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-concurrent-"));
  const state = join(scratch, "state");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const firstRepository = await createCommittedRepository(scratch, "first");
  const secondRepository = await createCommittedRepository(scratch, "second");
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: supportedDelegatedAgentPort(),
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  const [first, second] = await Promise.all([
    runtime.prepare(preparationRequest(firstRepository, "brief:concurrent-first")),
    runtime.prepare(preparationRequest(secondRepository, "brief:concurrent-second")),
  ]);

  assert.notEqual(
    first.selection.inputs.workspace.subject_id,
    second.selection.inputs.workspace.subject_id,
  );
  for (const prepared of [first, second]) {
    const facts = prepared.selection.explicit_facts;
    const authorityById = new Map(
      prepared.required_authorities.map((binding) => [binding.id, binding]),
    );
    assert.equal(
      authorityById.get("route:facts").observation.watermark,
      digest(facts.route_snapshot),
    );
    assert.equal(
      authorityById.get("resource:facts").observation.watermark,
      digest(facts.resource_claims),
    );
    assert.equal(
      authorityById.get("contract:facts").observation.watermark,
      digest({
        operation_contracts: facts.operation_contracts,
        validator_contracts: facts.validator_contracts,
      }),
    );
    assert.equal(
      authorityById.get("generation:facts").observation.watermark,
      digest(facts.subject_generations),
    );
  }
});

test("production preparation rejects a dirty repository before route description", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-dirty-"));
  const state = join(scratch, "state");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repository = await createCommittedRepository(scratch, "dirty");
  await writeFile(join(repository, "uncommitted.txt"), "dirty\n");
  let described = false;
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: {
      async describe() {
        described = true;
        throw new Error("route description should not be reached");
      },
    },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  await assert.rejects(
    runtime.prepare(preparationRequest(repository, "brief:dirty")),
    (error) => error?.name === "ProductionPreparationError" &&
      error.code === "repository_dirty",
  );
  assert.equal(described, false);
});

test("production feature runs a real Git mutation through a local candidate", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-feature-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  const initialGit = await gitFacts(repository);
  let mutationCount = 0;
  let candidateText = "after\n";
  const retainedFinding = critiqueFinding(
    "non_blocking",
    "retained finding",
    "the production seal must retain this exact finding",
  );
  const turns = new Map();
  const delegatedAgentPort = productionDelegatedAgentPort({
    repository,
    turns,
    onApply() {
      mutationCount += 1;
      return initializeCandidate(repository, candidateText);
    },
    criterionExpected: () => candidateText,
    critiqueFindings: [retainedFinding],
  });
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
  });
  t.after(() => closeFlowRuntime(runtime));

  const prepared = await runtime.prepare({
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:production-feature",
      summary: "Record a real production feature",
      acceptance: [
        "the changed behavior is observable",
        "the candidate preserves the changed behavior",
      ],
    },
    repository: { path: repository },
    mode: "verify",
    routes: {
      apply: {
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "workspace-write",
        },
      },
      critique: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
  });
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));

  let lastProjection;
  try {
    await until(() => {
      lastProjection = runtime.query({ run_id: launch.run_id });
      return ["succeeded", "failed", "cancelled"].includes(lastProjection.phase);
    });
  } catch (error) {
    error.message += `\nlast projection: ${JSON.stringify(lastProjection)}`;
    throw error;
  }

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded", JSON.stringify(completed));
  assert.equal(mutationCount, 1);
  const candidate = completed.review_candidate_reference;
  assert.match(candidate.candidate_id, /^candidate:/u);
  assert.equal(completed.handoffs.length, 1);
  const review = runtime.query({
    contract: "work.review/v1",
    subject_id: candidate.candidate_id,
  });
  assert.equal(review.status, "sealed");
  assert.equal(review.candidate.artifacts.length, 1);
  assert.equal(review.candidate.verification.acceptance_criteria.length, 2);
  assert.ok(review.candidate.verification.acceptance_criteria.every(({ verdict }) =>
    verdict === "passed"));
  assert.equal(review.candidate.critique.delegate_evidence.card_id,
    "feature-critique");
  assert.deepEqual(review.candidate.critique.findings, [retainedFinding]);
  assert.equal(review.candidate.git.clean, true);
  assert.notEqual(review.candidate.git.commit_sha, initialGit.commit_sha);
  assert.notEqual(review.candidate.git.tree_sha, initialGit.tree_sha);
  assert.equal(review.candidate.git_retention.commit_sha,
    review.candidate.git.commit_sha);
  assert.equal(completed.views.operator.legal_actions.some(({ type }) =>
    ["review", "integration", "push", "pull_request", "cleanup", "tracker"]
      .includes(type)), false);

  candidateText = "after-again\n";
  const secondPrepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:production-feature-second",
  ));
  assert.equal(secondPrepared.selection.inputs.workspace.generation, 2);
  assert.equal(secondPrepared.selection.inputs.workspace.mutation_epoch >
    prepared.selection.inputs.workspace.mutation_epoch, true);
  const secondLaunch = runtime.launch(
    confirmedPredefinedLaunchRequest(secondPrepared),
  );
  assert.equal(secondLaunch.schema, "flow.launch-receipt/v1", JSON.stringify(secondLaunch));
  let secondLastProjection;
  try {
    await until(() => {
      secondLastProjection = runtime.query({ run_id: secondLaunch.run_id });
      return ["succeeded", "failed", "cancelled"].includes(
        secondLastProjection.phase,
      );
    });
  } catch (error) {
    error.message += `\nsecond projection: ${JSON.stringify(secondLastProjection)}`;
    throw error;
  }
  const secondCompleted = runtime.query({ run_id: secondLaunch.run_id });
  assert.equal(secondCompleted.phase, "succeeded", JSON.stringify(secondCompleted));
  assert.equal(mutationCount, 2);
});

test("production feature launch fails closed when an operation is missing", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-missing-operation-"));
  const state = join(scratch, "state");
  const repository = await createCommittedRepository(scratch, "missing-operation");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: supportedDelegatedAgentPort(),
    registeredOperations: {
      "flow.operation/feature-verify/v1": null,
    },
    autonomous: false,
  });
  t.after(() => closeFlowRuntime(runtime));

  await assert.rejects(
    runtime.prepare(preparationRequest(repository, "brief:missing-operation")),
    (error) => error?.name === "DynamicPlanValidationError" &&
      /operation contract is not registered: flow\.operation\/feature-verify\/v1/u
        .test(error.message),
  );
  assert.deepEqual(runtime.query().runs, []);
});

test("production feature does not seal when apply omits criterion evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-invalid-evidence-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  const turns = new Map();
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: productionDelegatedAgentPort({
      repository,
      turns,
      includeCriterionEvidence: false,
      onApply: () => initializeCandidate(repository),
    }),
  });
  t.after(() => closeFlowRuntime(runtime));
  const prepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:invalid-evidence",
  ));
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => {
    const projection = runtime.query({ run_id: launch.run_id });
    return projection.effects?.[0] !== undefined &&
      projection.effects[0].receipt !== null;
  });
  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(projection.phase, "active");
  assert.equal(projection.effects[0].receipt.outcome, "quarantined");
  assert.equal(projection.handoffs.length, 0);
});

test("production feature does not seal when apply criterion evidence disagrees with Git", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-mismatched-evidence-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  const turns = new Map();
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: productionDelegatedAgentPort({
      repository,
      turns,
      criterionExpected: "forged\n",
      onApply: () => initializeCandidate(repository),
    }),
  });
  t.after(() => closeFlowRuntime(runtime));
  const prepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:mismatched-evidence",
  ));
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => {
    const projection = runtime.query({ run_id: launch.run_id });
    return projection.effects?.some(({ last_observation: observation }) =>
      observation?.provider_observation?.diagnostic?.code ===
        "operation_failure");
  });
  const projection = runtime.query({ run_id: launch.run_id });
  assert.notEqual(projection.phase, "succeeded");
  assert.equal(projection.handoffs.length, 0);
  assert.ok(projection.effects.some(({ last_observation: observation }) =>
    observation?.provider_observation?.diagnostic?.code === "operation_failure"));
});

test("production critique evidence is strict, independently bound, and ordered", () => {
  const expectedCriteria = ["criterion:one", "criterion:two"];
  const candidate = { schema: "flow.feature-candidate-view/v1", id: "candidate:one" };
  const predecessor = {
    schema: "flow.authority-materialized-evidence/v1",
    evidence_digest: digest({ schema: "flow.authority-materialized-evidence/v1" }),
  };
  const { evidence_digest: _predecessorDigest, ...predecessorIdentity } = predecessor;
  const predecessorEvidenceDigest = digest(predecessorIdentity);
  const taskInputs = {
    schema: "flow.delegate-task-inputs/v1",
    flow: "feature/v1",
    phase: "critique",
    mode: "verify",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:critique-contract",
      summary: "critique contract",
      acceptance: expectedCriteria,
    },
    candidate_digest: digest(candidate),
    predecessor_evidence_digest: predecessorEvidenceDigest,
  };
  const candidateDigest = digest(candidate);
  const firstFinding = critiqueFinding(
    "non_blocking",
    "one finding",
    "the first finding is retained exactly",
  );
  const secondFinding = critiqueFinding(
    "non_blocking",
    "two finding",
    "the second finding is retained exactly",
  );
  const findings = [firstFinding, secondFinding].sort((left, right) =>
    left.finding_id.localeCompare(right.finding_id));
  const criteria = expectedCriteria.map((criterion) => {
    const evidence = {
      kind: "git_file_equals",
      target: "feature.txt",
      expected: "after\n",
    };
    return {
      criterion,
      evidence,
      evidence_digest: digest({ criterion, evidence, verdict: "passed" }),
      verdict: "passed",
    };
  });
  const valid = critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings,
  });
  const validate = (output, options = {}) => validateFeatureCritiqueOutput(
    output,
    {
      taskInputs,
      expectedCriteria,
      candidateDigest,
      predecessorEvidenceDigest,
      requireAuthorityBinding: true,
      ...options,
    },
  );

  const accepted = validate(valid);
  assert.deepEqual(accepted.findings, findings);
  assert.equal(accepted.candidate_digest, candidateDigest);
  assert.equal(accepted.predecessor_evidence_digest, predecessorEvidenceDigest);
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria: criteria.slice(0, 1),
    findings,
  })), null, "missing criterion must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria: criteria.map((entry, index) => index === 0
      ? { ...entry, verdict: "failed" }
      : entry),
    findings,
  })), null, "forged verdict must fail its evidence digest");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria: criteria.map((entry, index) => index === 0
      ? {
          ...entry,
          evidence: { ...entry.evidence, expected: "forged\n" },
        }
      : entry),
    findings,
  })), null, "forged criterion evidence must fail its digest");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria: [criteria[1], criteria[0]],
    findings,
  })), null, "reordered criteria must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria: [criteria[0], criteria[0]],
    findings,
  })), null, "duplicate criterion evidence must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings: [findings[0], findings[0]],
  })), null, "duplicate findings must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings: [...findings].reverse(),
  })), null, "reordered findings must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings: [
      {
        ...findings[0],
        detail: "forged finding detail",
      },
    ],
  })), null, "forged finding evidence must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings: undefined,
  })), null, "missing findings must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest: digest({ forged: true }),
    criteria,
    findings,
  })), null, "forged predecessor binding must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest: digest({ forged: true }),
    predecessorEvidenceDigest,
    criteria,
    findings,
  })), null, "forged candidate binding must fail closed");
  assert.equal(validate(valid, {
    taskInputs: { ...taskInputs, mode: "test" },
  }), null, "task input digest mismatch must fail closed");
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria: criteria.map((entry) => ({
      ...entry,
      evidence: { ...entry.evidence, expected: "x".repeat(1_048_577) },
    })),
    findings,
  })), null, "oversized criterion evidence must fail closed");
  const oversizedFinding = critiqueFinding(
    "non_blocking",
    "oversized",
    "x".repeat(8 * 1024 + 1),
  );
  assert.equal(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings: [oversizedFinding],
  })), null, "oversized finding must fail closed");
  const blocking = critiqueFinding("blocking", "blocked", "must not seal");
  assert.ok(validate(critiqueOutput({
    taskInputs,
    candidateDigest,
    predecessorEvidenceDigest,
    criteria,
    findings: [blocking],
  })), "blocking findings remain valid evidence for the seal gate");
});

test("production seal refuses an independently validated blocking critique", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-blocking-critique-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  const turns = new Map();
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: productionDelegatedAgentPort({
      repository,
      turns,
      onApply: () => initializeCandidate(repository),
      critiqueFindings: [critiqueFinding(
        "blocking",
        "unsafe behavior",
        "the candidate must not be sealed",
      )],
    }),
  });
  t.after(() => closeFlowRuntime(runtime));
  const prepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:blocking-critique",
  ));
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => {
    const projection = runtime.query({ run_id: launch.run_id });
    return projection.effects?.some(({ last_observation: observation }) =>
      observation?.provider_observation?.diagnostic?.code === "operation_failure");
  });
  const projection = runtime.query({ run_id: launch.run_id });
  assert.notEqual(projection.phase, "succeeded");
  assert.equal(projection.handoffs.length, 0);
});

test("a failed production feature releases its workspace claim for a later run", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-reuse-after-decline-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  let candidateText = "after-first\n";
  let critiqueAvailable = false;
  const turns = new Map();
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: productionDelegatedAgentPort({
      repository,
      turns,
      onApply: () => initializeCandidate(repository, candidateText),
      criterionExpected: () => candidateText,
      includeCritiqueEvidence: () => critiqueAvailable,
    }),
  });
  t.after(() => closeFlowRuntime(runtime));
  const firstPrepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:reuse-after-decline-first",
  ));
  const firstLaunch = runtime.launch(confirmedPredefinedLaunchRequest(firstPrepared));
  assert.equal(firstLaunch.schema, "flow.launch-receipt/v1", JSON.stringify(firstLaunch));
  await until(() => runtime.query({ run_id: firstLaunch.run_id }).legal_actions
    ?.some(({ type }) => type === "terminal_disposition"));
  const failed = runtime.query({ run_id: firstLaunch.run_id });
  const terminal = failed.legal_actions.find(({ type }) => type ===
    "terminal_disposition");
  const terminalReceipt = runtime.command(terminal);
  assert.equal(terminalReceipt.accepted, true, JSON.stringify(terminalReceipt));
  assert.equal(terminalReceipt.effect_intents?.length ?? 0, 0);
  assert.equal(runtime.query({ run_id: firstLaunch.run_id }).phase, "declined");

  critiqueAvailable = true;
  candidateText = "after-second\n";
  const secondPrepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:reuse-after-decline-second",
  ));
  assert.equal(
    secondPrepared.selection.inputs.workspace.generation,
    firstPrepared.selection.inputs.workspace.generation + 1,
  );
  const secondLaunch = runtime.launch(
    confirmedPredefinedLaunchRequest(secondPrepared),
  );
  assert.equal(secondLaunch.schema, "flow.launch-receipt/v1", JSON.stringify(secondLaunch));
  await until(() => ["succeeded", "failed", "cancelled"].includes(
    runtime.query({ run_id: secondLaunch.run_id }).phase,
  ));
  assert.equal(runtime.query({ run_id: secondLaunch.run_id }).phase, "succeeded");
});

test("a sealed production feature reobserves a clean external commit before a later run", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-reobserve-after-seal-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  let candidateText = "after-first\n";
  const turns = new Map();
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: productionDelegatedAgentPort({
      repository,
      turns,
      onApply: () => initializeCandidate(repository, candidateText),
      criterionExpected: () => candidateText,
    }),
  });
  t.after(() => closeFlowRuntime(runtime));

  const firstPrepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:reobserve-after-seal-first",
  ));
  const firstLaunch = runtime.launch(
    confirmedPredefinedLaunchRequest(firstPrepared),
  );
  assert.equal(firstLaunch.schema, "flow.launch-receipt/v1", JSON.stringify(firstLaunch));
  await until(() => ["succeeded", "failed", "cancelled"].includes(
    runtime.query({ run_id: firstLaunch.run_id }).phase,
  ));
  const firstCompleted = runtime.query({ run_id: firstLaunch.run_id });
  assert.equal(firstCompleted.phase, "succeeded", JSON.stringify(firstCompleted));
  const firstReview = runtime.query({
    contract: "work.review/v1",
    subject_id: firstCompleted.review_candidate_reference.candidate_id,
  });
  const promotedGeneration = firstReview.candidate.workspace.generation;
  const promotedMutationEpoch = firstReview.candidate.workspace.mutation_epoch;

  await writeFile(join(repository, "external.txt"), "external\n");
  await execFile("git", ["-C", repository, "add", "external.txt"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "external clean advance"]);
  const externalGit = await gitFacts(repository);
  assert.equal(externalGit.clean, true);
  assert.notEqual(externalGit.commit_sha, firstReview.candidate.git.commit_sha);

  candidateText = "after-second\n";
  const secondPrepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:reobserve-after-seal-second",
  ));
  assert.equal(
    secondPrepared.selection.inputs.workspace.generation,
    promotedGeneration + 1,
  );
  assert.equal(
    secondPrepared.selection.inputs.workspace.mutation_epoch,
    promotedMutationEpoch + 1,
  );
  assert.deepEqual(secondPrepared.selection.inputs.workspace.git, externalGit);

  const secondLaunch = runtime.launch(
    confirmedPredefinedLaunchRequest(secondPrepared),
  );
  assert.equal(secondLaunch.schema, "flow.launch-receipt/v1", JSON.stringify(secondLaunch));
  await until(() => ["succeeded", "failed", "cancelled"].includes(
    runtime.query({ run_id: secondLaunch.run_id }).phase,
  ));
  const secondCompleted = runtime.query({ run_id: secondLaunch.run_id });
  assert.equal(secondCompleted.phase, "succeeded", JSON.stringify(secondCompleted));
});

test("production feature captures a candidate archive larger than one MiB", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-large-archive-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  await writeFile(join(repository, "large.bin"), Buffer.alloc(2 * 1024 * 1024, 0x61));
  await execFile("git", ["-C", repository, "add", "large.bin"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "large candidate archive"]);
  const turns = new Map();
  const runtime = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort: productionDelegatedAgentPort({
      repository,
      turns,
      onApply: () => initializeCandidate(repository),
    }),
  });
  t.after(() => closeFlowRuntime(runtime));

  const prepared = await runtime.prepare(preparationRequest(
    repository,
    "brief:large-archive",
  ));
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => ["succeeded", "failed", "cancelled"].includes(
    runtime.query({ run_id: launch.run_id }).phase,
  ), 10_000);

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded", JSON.stringify(completed));
  const candidate = runtime.query({
    contract: "work.review/v1",
    subject_id: completed.review_candidate_reference.candidate_id,
  });
  assert.equal(candidate.status, "sealed");
  assert.equal(candidate.candidate.artifacts.length, 1);
  assert.match(candidate.candidate.artifacts[0].digest, /^sha256:[0-9a-f]{64}$/u);
});

test("production capture reboot admission resumes an interrupted capture exactly once", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-capture-reboot-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  let interrupted = true;
  let mutationCount = 0;
  const turns = new Map();
  const delegatedAgentPort = productionDelegatedAgentPort({
    repository,
    turns,
    onApply() {
      mutationCount += 1;
      return initializeCandidate(repository);
    },
  });
  let bootId = "boot-capture-a";
  const authorityOptions = {
    hostIdentityAdapter: {
      observe() {
        return {
          schema: "flow.host-authority-identity/v1",
          boot_id: bootId,
          process_identity: `process:${bootId}`,
        };
      },
    },
    timeObservationAdapter: {
      observe() {
        return executionTimeFacts({
          wallValueMs: 1_700_000_000_000,
          wallClockSourceId: "wall:flow-production-test",
          monotonicValueNs: "1000000000",
          monotonicClockSourceId: "mono:flow-production-test",
          clockSourceIdentity: "flow-production-test",
          bootId,
        });
      },
    },
    beforeEffect(intent) {
      if (interrupted && intent.card_id === "feature-capture") {
        interrupted = false;
        throw new Error("interrupt capture before provider dispatch");
      }
    },
  };
  const runtimeA = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
    authorityOptions,
  });
  const prepared = await runtimeA.prepare(preparationRequest(
    repository,
    "brief:capture-reboot",
  ));
  const launch = runtimeA.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => runtimeA.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, invocation_started: invocationStarted, status }) =>
      cardId === "feature-capture" && invocationStarted && status === "unresolved",
  ));
  closeFlowRuntime(runtimeA);
  bootId = "boot-capture-b";

  const runtimeB = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
    authorityOptions,
  });
  t.after(() => closeFlowRuntime(runtimeB));
  const suspended = runtimeB.query({ run_id: launch.run_id });
  const admission = suspended.legal_actions.find(({ type }) =>
    type === "reboot_admission");
  assert.ok(admission);
  const admissionReceipt = runtimeB.command(admission);
  assert.equal(admissionReceipt.accepted, true, JSON.stringify(admissionReceipt));
  try {
    await until(() => runtimeB.query({ run_id: launch.run_id }).effects.some(
      ({ card_id: cardId, status }) =>
        cardId === "feature-capture" && status === "succeeded",
    ));
  } catch (error) {
    const projection = runtimeB.query({ run_id: launch.run_id });
    error.message += `; last projection: ${JSON.stringify({
      phase: projection.phase,
      cards: projection.active_plan.cards.map(({ id, executor, status, dependencies }) => ({
        id,
        executor: executor.kind,
        status,
        dependencies,
      })),
      effects: projection.effects.map((effect) => ({
        card_id: effect.card_id,
        status: effect.status,
        invocation_started: effect.invocation_started,
        retry: effect.retry,
        observation: effect.observation,
        error: effect.error,
      })),
      legal_actions: projection.legal_actions,
    })}`;
    throw error;
  }
  try {
    await until(() => runtimeB.query({ run_id: launch.run_id }).phase === "succeeded");
  } catch (error) {
    const projection = runtimeB.query({ run_id: launch.run_id });
    error.message += `; last terminal projection: ${JSON.stringify({
      phase: projection.phase,
      execution_time: projection.execution_time,
      cards: projection.cards,
      effects: projection.effects,
      result_bindings: projection.result_bindings,
      blocks: projection.blocks,
      legal_actions: projection.legal_actions,
    })}`;
    throw error;
  }

  const completed = runtimeB.query({ run_id: launch.run_id });
  assert.equal(mutationCount, 1);
  const captureEffect = completed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture");
  assert.ok(captureEffect);
  assert.equal(captureEffect.retry.consumed_attempts, 1);
  assert.equal(completed.handoffs.length, 1);
  const candidate = runtimeB.query({
    contract: "work.review/v1",
    subject_id: completed.review_candidate_reference.candidate_id,
  });
  assert.equal(candidate.status, "sealed");
  assert.equal(candidate.candidate.artifacts.length, 1);
});

test("production same-boot owner recomposition resumes an interrupted capture exactly once", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-capture-recompose-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  let interrupted = true;
  let mutationCount = 0;
  const turns = new Map();
  const delegatedAgentPort = productionDelegatedAgentPort({
    repository,
    turns,
    onApply() {
      mutationCount += 1;
      return initializeCandidate(repository);
    },
  });
  const bootId = "boot-capture-same-boot";
  const authorityOptions = {
    hostIdentityAdapter: {
      observe() {
        return {
          schema: "flow.host-authority-identity/v1",
          boot_id: bootId,
          process_identity: `process:${bootId}`,
        };
      },
    },
    timeObservationAdapter: {
      observe() {
        return executionTimeFacts({
          wallValueMs: 1_700_000_000_000,
          wallClockSourceId: "wall:flow-production-test",
          monotonicValueNs: "1000000000",
          monotonicClockSourceId: "mono:flow-production-test",
          clockSourceIdentity: "flow-production-test",
          bootId,
        });
      },
    },
    beforeEffect(intent) {
      if (interrupted && intent.card_id === "feature-capture") {
        interrupted = false;
        throw new Error("interrupt capture before provider dispatch");
      }
    },
  };
  const runtimeA = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
    authorityOptions,
  });
  const prepared = await runtimeA.prepare(preparationRequest(
    repository,
    "brief:capture-same-boot",
  ));
  const launch = runtimeA.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => runtimeA.query({ run_id: launch.run_id }).effects.some(
    ({ card_id: cardId, invocation_started: invocationStarted, status }) =>
      cardId === "feature-capture" && invocationStarted && status === "unresolved",
  ));
  closeFlowRuntime(runtimeA);

  const runtimeB = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
    authorityOptions,
  });
  t.after(() => closeFlowRuntime(runtimeB));
  let lastProjection;
  try {
    await until(() => {
      lastProjection = runtimeB.query({ run_id: launch.run_id });
      return lastProjection.phase === "succeeded";
    }, 10_000);
  } catch (error) {
    error.message += `\nlast projection: ${JSON.stringify(lastProjection)}`;
    throw error;
  }

  const completed = runtimeB.query({ run_id: launch.run_id });
  assert.equal(mutationCount, 1);
  const captureEffect = completed.effects.find(({ card_id: cardId }) =>
    cardId === "feature-capture");
  assert.ok(captureEffect);
  assert.equal(captureEffect.retry.consumed_attempts, 1);
  assert.equal(completed.handoffs.length, 1);
  const candidate = runtimeB.query({
    contract: "work.review/v1",
    subject_id: completed.review_candidate_reference.candidate_id,
  });
  assert.equal(candidate.status, "sealed");
  assert.equal(candidate.candidate.artifacts.length, 1);
});

test("production owner recomposition resumes a real feature after delegate settlement", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-production-recompose-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await initializeRepository(repository);
  let releaseApply;
  const applySettled = new Promise((resolve) => {
    releaseApply = resolve;
  });
  let mutationCount = 0;
  const turns = new Map();
  const delegatedAgentPort = productionDelegatedAgentPort({
    repository,
    turns,
    waitForApply: applySettled,
    onApply() {
      mutationCount += 1;
      return initializeCandidate(repository);
    },
  });
  const runtimeA = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
  });
  const prepared = await runtimeA.prepare(preparationRequest(
    repository,
    "brief:recompose",
  ));
  const launch = runtimeA.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  await until(() => turns.size === 1 && mutationCount === 1);
  const inFlight = runtimeA.query({ run_id: launch.run_id });
  assert.equal(inFlight.phase, "active");
  assert.equal(inFlight.effects[0].receipt, null);

  closeFlowRuntime(runtimeA);
  releaseApply();

  const runtimeB = createFlowRuntime({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    delegatedAgentPort,
  });
  t.after(() => closeFlowRuntime(runtimeB));
  let lastProjection;
  try {
    await until(() => {
      lastProjection = runtimeB.query({ run_id: launch.run_id });
      return ["succeeded", "failed", "cancelled"].includes(lastProjection.phase);
    }, 10_000);
  } catch (error) {
    error.message += `\nlast projection: ${JSON.stringify(lastProjection)}`;
    throw error;
  }
  const completed = runtimeB.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded", JSON.stringify(completed));
  assert.equal(mutationCount, 1);
  assert.equal(completed.handoffs.length, 1);
});

async function createCommittedRepository(parent, name) {
  const repository = join(parent, `repository-${name}`);
  await mkdir(repository, { recursive: true });
  await execFile("git", ["-C", repository, "init", "--quiet"]);
  await execFile("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "README.md"), `initial ${name}\n`);
  await execFile("git", ["-C", repository, "add", "README.md"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", `initial ${name}`]);
  return repository;
}

function supportedDelegatedAgentPort() {
  return {
    async describe(request) {
      const description = await supportedDescription(
        request,
        repositoryDrovrDependencies(),
      );
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "compatible",
        watermark: description.watermark,
        description,
        compatibility: {
          contract: "flow.delegated-agent-port/v1",
          code: null,
          findings: [],
        },
        legal_next_actions: ["bind_exact_launch_description"],
      };
    },
  };
}

function preparationRequest(repository, briefId) {
  return {
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: briefId,
      summary: "Add an observable feature",
      acceptance: ["the changed behavior is observable"],
    },
    repository: { path: repository },
    mode: "verify",
    routes: {
      apply: {
        launch: {
          harness: "codex",
          role: "reviewer",
          model: "gpt-5.6",
          effort: "high",
          capability: "workspace-write",
        },
      },
      critique: {
        launch: {
          harness: "claude",
          role: "reviewer",
          model: "haiku",
          effort: "high",
          capability: "read-only",
        },
      },
    },
    limits: { max_elapsed_seconds: 600 },
  };
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

async function initializeRepository(repository) {
  await mkdir(repository, { recursive: true });
  await execFile("git", ["-C", repository, "init", "--quiet", "--initial-branch", "main"]);
  await execFile("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "feature.txt"), "before\n");
  await execFile("git", ["-C", repository, "add", "feature.txt"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "initial"]);
}

async function initializeCandidate(repository, content = "after\n") {
  await writeFile(join(repository, "feature.txt"), content);
  await execFile("git", ["-C", repository, "add", "feature.txt"]);
  await execFile("git", ["-C", repository, "commit", "--quiet", "-m", "candidate"]);
}

async function gitFacts(repository) {
  const [commit_sha, tree_sha, ref, status] = await Promise.all([
    execFile("git", ["-C", repository, "rev-parse", "HEAD"]),
    execFile("git", ["-C", repository, "rev-parse", "HEAD^{tree}"]),
    execFile("git", ["-C", repository, "symbolic-ref", "--quiet", "HEAD"]),
    execFile("git", ["-C", repository, "status", "--porcelain", "--untracked-files=all"]),
  ]);
  return {
    commit_sha: commit_sha.stdout.trim(),
    tree_sha: tree_sha.stdout.trim(),
    ref: ref.stdout.trim(),
    clean: status.stdout.trim() === "",
  };
}

function productionDelegatedAgentPort({
  repository,
  turns,
  onApply,
  waitForApply = null,
  includeCriterionEvidence = true,
  criterionExpected = "after\n",
  includeCritiqueEvidence = true,
  critiqueExpected = criterionExpected,
  critiqueFindings = [],
}) {
  return {
    contract: "flow.delegated-agent-port/v1",
    async describe(request) {
      const description = await supportedDescription(
        request,
        repositoryDrovrDependencies(),
      );
      return {
        schema: "flow.delegated-agent-description-projection/v1",
        status: "compatible",
        watermark: description.watermark,
        description,
        compatibility: {
          contract: "flow.delegated-agent-port/v1",
          code: null,
          findings: [],
        },
        legal_next_actions: ["bind_exact_launch_description"],
      };
    },
    async discover(request) {
      const existing = [...turns.values()].find(({ request: turnRequest }) =>
        turnRequest.caller_key === request.caller_key);
      if (existing !== undefined) {
        return {
          schema: "flow.delegated-agent-lifecycle-projection/v1",
          operation: "discover",
          status: "working",
          watermark: {
            schema: "drovr.registry-authority-watermark/v1",
            authority: "drovr.registry",
            turns_sha256: digest(existing.turnId),
          },
          delegation: {
            agent_id: existing.request.agent_id,
            task_id: `task:${existing.request.agent_id}`,
            group_id: "group:production-feature",
          },
          turn: {
            id: existing.turnId,
            status: "working",
            caller: { dispatch_key: existing.request.caller_key },
            launch_binding: {
              schema: "drovr.launch-binding/v1",
              comparison_key: existing.request.description.comparison_keys.launch,
              configuration_watermark:
                existing.request.description.watermark.content_sha256,
              description_digest: existing.request.description.description_digest,
            },
            inputs: [{
              sequence: 1,
              caller_key: existing.request.input_key,
              payload_sha256: existing.request.payload_sha256,
              delivery: { status: "submitted" },
            }],
          },
          legal_next_actions: ["wait_bounded"],
        };
      }
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
    },
    async dispatch(request) {
      const turnId = `turn:${request.caller_key}`;
      const description = request.description;
      if (description.launch.capability === "workspace-write") {
        await onApply();
      }
      turns.set(turnId, { request, turnId });
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "dispatch",
        status: "working",
        watermark: {
          schema: "drovr.registry-authority-watermark/v1",
          authority: "drovr.registry",
          turns_sha256: digest(turnId),
        },
        delegation: {
          agent_id: request.agent_id,
          task_id: `task:${request.agent_id}`,
          group_id: "group:production-feature",
        },
        turn: { id: turnId, status: "working" },
        legal_next_actions: ["wait_bounded"],
      };
    },
    async wait(request) {
      const turn = turns.get(request.turn_id);
      assert.ok(turn);
      if (waitForApply !== null &&
          turn.request.description.launch.capability === "workspace-write") {
        await waitForApply;
      }
      const outputValue = {
        schema: "flow.delegate-evidence/v1",
        observation: turn.request.description.launch.capability,
      };
      if (turn.request.description.launch.capability === "workspace-write" &&
          includeCriterionEvidence) {
        const envelope = parseDelegateEnvelope(turn.request.prompt);
        const criteria = envelope?.task_inputs?.brief?.acceptance ?? [];
        outputValue.feature_evidence = {
          schema: "flow.feature-criterion-evidence/v1",
          criteria: criteria.map((criterion) => ({
          criterion,
          kind: "git_file_equals",
          target: "feature.txt",
          expected: typeof criterionExpected === "function"
            ? criterionExpected(criterion)
            : criterionExpected,
          })),
        };
      }
      const critiqueEnabled = typeof includeCritiqueEvidence === "function"
        ? includeCritiqueEvidence(turn)
        : includeCritiqueEvidence;
      if (turn.request.description.launch.capability === "read-only" &&
          critiqueEnabled) {
        const envelope = parseDelegateEnvelope(turn.request.prompt);
        const taskInputs = envelope?.task_inputs;
        const criteria = taskInputs?.brief?.acceptance ?? [];
        const critique = {
          schema: "flow.feature-critique-output/v1",
          candidate_digest: taskInputs.candidate_digest,
          predecessor_evidence_digest: taskInputs.predecessor_evidence_digest,
          task_inputs_digest: digest(taskInputs),
          criteria: criteria.map((criterion) => {
            const evidence = {
              kind: "git_file_equals",
              target: "feature.txt",
              expected: typeof critiqueExpected === "function"
                ? critiqueExpected(criterion)
                : critiqueExpected,
            };
            return {
              criterion,
              evidence,
              evidence_digest: digest({
                criterion,
                evidence,
                verdict: "passed",
              }),
              verdict: "passed",
            };
          }),
          findings: critiqueFindings,
        };
        outputValue.feature_critique = critique;
      }
      const output = JSON.stringify(freezeCanonical(outputValue));
      return completedTurnProjection({
        agentId: turn.request.agent_id,
        callerKey: turn.request.caller_key,
        description: turn.request.description,
        output,
        prompt: turn.request.prompt,
        turnId: turn.turnId,
      });
    },
    send() {
      throw new Error("production feature test does not steer delegates");
    },
    observe() {
      return null;
    },
    cancel() {
      throw new Error("production feature test does not cancel delegates");
    },
    reconcile() {
      return null;
    },
    async retire(request) {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "drovr.registry",
          agent_id: request.agent_id,
          record_sha256: digest(request.agent_id),
        },
        delegation: {
          agent_id: request.agent_id,
          task_id: `task:${request.agent_id}`,
          group_id: "group:production-feature",
        },
        turn: null,
        legal_next_actions: [],
      };
    },
  };
}

function parseDelegateEnvelope(prompt) {
  try {
    const bytes = typeof prompt === "string" ? prompt : Buffer.from(prompt);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function critiqueOutput({
  taskInputs,
  candidateDigest,
  predecessorEvidenceDigest,
  criteria,
  findings,
}) {
  const featureCritique = {
    schema: "flow.feature-critique-output/v1",
    candidate_digest: candidateDigest,
    predecessor_evidence_digest: predecessorEvidenceDigest,
    task_inputs_digest: digest(taskInputs),
    criteria,
    ...(findings === undefined ? {} : { findings }),
  };
  return JSON.stringify(freezeCanonical({
    schema: "flow.delegate-evidence/v1",
    observation: "independent",
    feature_critique: featureCritique,
  }));
}

function critiqueFinding(classification, summary, detail) {
  const identity = { classification, detail, summary };
  return freezeCanonical({
    ...identity,
    finding_id: `finding:${digest(identity).slice("sha256:".length)}`,
  });
}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true before timeout");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { PlanCompiler } from "../src/plan-compiler.mjs";
import { preparedObservation } from "../src/reboot-revalidation.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import { normalizeRequiredAuthorities } from "../src/authority-bindings.mjs";
import {
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
  revisionBlockedCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";

test("the pure PlanCompiler exposes dynamic and predefined compilation", () => {
  assert.equal(PlanCompiler.compileDynamic, PlanCompiler.compile);
  assert.equal(typeof PlanCompiler.compilePredefined, "function");
});

test("predefined selection prepares one confirmed bundle without creating a run", () => {
  const definition = {
    schema: "flow.predefined-definition/v1",
    id: "example/v1",
    contract: "flow.definition/example/v1",
    promised_outcomes: ["an exact example outcome"],
    negative_outcomes: ["no remote mutation"],
    trust_posture: {
      authority: "RunAuthority",
      operator_confirmation: "required",
    },
    compile({ inputs, explicit_facts }) {
      const proposal = dynamicCheckpointProposal();
      proposal.graph.cards[0].inputs.prompt = inputs.prompt;
      proposal.explicit_facts = explicit_facts;
      return proposal;
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": definition },
  });
  const facts = dynamicCheckpointProposal().explicit_facts;

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Confirm the example" },
    explicit_facts: facts,
  });

  assert.equal(prepared.kind, "predefined");
  assert.equal(prepared.definition.id, "example/v1");
  assert.deepEqual(prepared.confirmation.inputs, {
    prompt: "Confirm the example",
  });
  assert.deepEqual(runtime.query().runs, []);
});

test("predefined launch accepts only its one confirmation decision and exact closed facts", () => {
  const definition = exampleDefinition();
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = prepareExample(runtime);
  const launchRequest = confirmedPredefinedLaunchRequest(prepared);

  const launch = runtime.launch(launchRequest);
  assert.equal(launch.created, true);
  assert.equal(launch.bundle_digest, prepared.bundle_digest);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).legal_actions.map(
    ({ type }) => type,
  ), ["checkpoint_decision", "checkpoint_decision"]);

  const adopted = runtime.launch(structuredClone(launchRequest));
  assert.deepEqual(adopted, { ...launch, created: false });

  const declined = runtime.launch({
    ...launchRequest,
    confirmation: {
      ...launchRequest.confirmation,
      decision: "decline",
    },
  });
  assert.equal(declined.code, "confirmation_declined");
  assert.deepEqual(runtime.query().runs, [launch.run_id]);

  const changedFacts = runtime.launch({
    ...launchRequest,
    closed_facts: {
      ...launchRequest.closed_facts,
      facts: {
        ...launchRequest.closed_facts.facts,
        catalog_fingerprint: `sha256:${"9".repeat(64)}`,
      },
    },
  });
  assert.equal(changedFacts.code, "closed_facts_changed");
});

test("declined predefined confirmation and invalid decisions create no run", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const prepared = prepareExample(runtime);
  const declined = runtime.launch(
    confirmedPredefinedLaunchRequest(prepared, "decline"),
  );
  assert.equal(declined.code, "confirmation_declined");
  assert.deepEqual(runtime.query().runs, []);

  const malformed = runtime.launch({
    ...confirmedPredefinedLaunchRequest(prepared),
    confirmation: {
      ...confirmedPredefinedLaunchRequest(prepared).confirmation,
      schema: "flow.dynamic-plan-confirmation-decision/v1",
    },
  });
  assert.equal(malformed.code, "invalid_confirmation");
  assert.equal(malformed.reason, "confirmation_binding_mismatch");
  assert.deepEqual(runtime.query().runs, []);
});

test("dynamic launch rejects a predefined confirmation decision", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
  });
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const request = confirmedLaunchRequest(prepared);

  const rejection = runtime.launch({
    ...request,
    confirmation: {
      ...request.confirmation,
      schema: "flow.predefined-flow-confirmation-decision/v1",
    },
  });

  assert.equal(rejection.code, "invalid_confirmation");
  assert.equal(rejection.reason, "confirmation_binding_mismatch");
  assert.deepEqual(runtime.query().runs, []);
});

test("predefined preparation supports ungated and plan-checkpoint definitions", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke() {
          throw new Error("not reached during preparation");
        },
      },
    },
    predefinedDefinitions: {
      "ungated/v1": {
        ...exampleDefinition(),
        id: "ungated/v1",
        contract: "flow.definition/ungated/v1",
        compile({ explicit_facts }) {
          const proposal = registeredOperationProposal({ checkpointBound: false });
          proposal.explicit_facts = explicit_facts;
          return proposal;
        },
      },
      "example/v1": exampleDefinition(),
    },
  });

  const ungatedFacts = registeredOperationProposal({ checkpointBound: false })
    .explicit_facts;
  const ungated = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "ungated/v1",
    inputs: { mode: "ungated" },
    explicit_facts: ungatedFacts,
  });
  const checkpointed = prepareExample(runtime);

  assert.equal(ungated.graph.cards[0].executor.kind, "operation");
  assert.deepEqual(
    checkpointed.graph.cards.map(({ executor }) => executor.kind),
    ["checkpoint"],
  );
  assert.deepEqual(runtime.query().runs, []);
});

test("ungated predefined launch projects and advances its exact operation action", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-predefined-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-predefined", "process-predefined"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          return operationReceipt(intent);
        },
      },
    },
    predefinedDefinitions: {
      "ungated/v1": {
        ...exampleDefinition(),
        id: "ungated/v1",
        contract: "flow.definition/ungated/v1",
        compile({ explicit_facts }) {
          const proposal = registeredOperationProposal({ checkpointBound: false });
          proposal.explicit_facts = explicit_facts;
          return proposal;
        },
      },
    },
  });
  const facts = registeredOperationProposal({ checkpointBound: false })
    .explicit_facts;
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "ungated/v1",
    inputs: { mode: "ungated" },
    explicit_facts: facts,
  });
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  const ready = runtime.query({ run_id: launch.run_id });
  const action = ready.legal_actions.find(({ type }) => type === "operation_execute");
  assert.ok(action);
  assert.equal(action.expected_watermark, ready.watermark);

  const watcher = runtime.watch({ run_id: launch.run_id });
  assert.deepEqual((await watcher.next()).value, ready);
  const update = watcher.next();
  const receipt = runtime.command(action);
  assert.equal(receipt.accepted, true);
  const completed = await untilProjection(runtime, launch.run_id, "succeeded");
  let watched = await update;
  while (watched.value.phase !== "succeeded") watched = await watcher.next();
  assert.deepEqual(watched.value, completed);
  assert.equal(completed.legal_actions.length, 0);
  assert.equal(completed.views.operator.authority_watermark, completed.watermark);
  await watcher.return();
});

test("same-boot recovery rebuilds a predefined run without recompiling its definition", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-predefined-recovery-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const definition = exampleDefinition();
  let compileCount = 0;
  const originalCompile = definition.compile;
  definition.compile = (context) => {
    compileCount += 1;
    return originalCompile(context);
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-predefined-recovery", "process-a"),
  });
  t.after(() => firstAuthority.close());
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = prepareExample(firstRuntime);
  const launch = firstRuntime.launch(confirmedPredefinedLaunchRequest(prepared));
  const beforeRecovery = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(compileCount, 1);

  firstAuthority.close();
  definition.compile = () => {
    throw new Error("recovery must not recompile the original definition");
  };
  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity(
      "boot-predefined-recovery",
      "process-b",
    ),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createFlowRuntime({ runAuthority: recoveredAuthority });

  const recovered = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(recovered.run_id, launch.run_id);
  assert.equal(recovered.bundle_digest, prepared.bundle_digest);
  assert.equal(recovered.plan_fingerprint, prepared.plan_fingerprint);
  assert.equal(recovered.phase, beforeRecovery.phase);
  assert.deepEqual(
    recovered.legal_actions.map(({ expected_watermark: _watermark, ...action }) => action),
    beforeRecovery.legal_actions.map(({ expected_watermark: _watermark, ...action }) => action),
  );
  assert.equal(recovered.authority_boot_id, "boot-predefined-recovery");
  assert.equal(recovered.authority_epoch, 2);
  assert.equal(recovered.views.operator.authority_watermark, recovered.watermark);
  assert.ok(recovered.legal_actions.every(
    ({ expected_watermark }) => expected_watermark === recovered.watermark,
  ));

  const watcher = recoveredRuntime.watch({ run_id: launch.run_id });
  const initial = await watcher.next();
  assert.deepEqual(initial.value, recovered);
  assert.equal(initial.value.watermark, recovered.watermark);
  assert.deepEqual(initial.value.legal_actions, recovered.legal_actions);
  await watcher.return();
  assert.equal(compileCount, 1);
});

test("same-boot recovery repeats an unresolved predefined caller-idempotent effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-predefined-effect-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const attemptedKeys = [];
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-predefined-effect", "process-a"),
  });
  t.after(() => firstAuthority.close());
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          attemptedKeys.push(intent.idempotency_key);
          throw new Error("receipt lost after provider mutation");
        },
      },
    },
    predefinedDefinitions: {
      "operation/v1": {
        ...exampleDefinition(),
        id: "operation/v1",
        contract: "flow.definition/operation/v1",
        compile({ explicit_facts }) {
          const proposal = registeredOperationProposal();
          proposal.explicit_facts = explicit_facts;
          return proposal;
        },
      },
    },
  });
  const prepared = firstRuntime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "operation/v1",
    inputs: {},
    explicit_facts: registeredOperationProposal().explicit_facts,
  });
  const launch = firstRuntime.launch(confirmedPredefinedLaunchRequest(prepared));
  const waiting = firstRuntime.query({ run_id: launch.run_id });
  firstRuntime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await untilProjection(firstRuntime, launch.run_id, "active");
  await untilCondition(() => attemptedKeys.length === 1);
  const unresolved = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(unresolved.effects[0].status, "unresolved");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-predefined-effect", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createFlowRuntime({
    runAuthority: recoveredAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          attemptedKeys.push(intent.idempotency_key);
          return operationReceipt(intent, { adopted: true });
        },
      },
    },
  });
  const recovered = await untilProjection(
    recoveredRuntime,
    launch.run_id,
    "succeeded",
  );
  assert.deepEqual(attemptedKeys, [attemptedKeys[0], attemptedKeys[0]]);
  assert.equal(recovered.effects[0].effect_id, unresolved.effects[0].effect_id);
  assert.equal(recovered.effects[0].attempt_id, unresolved.effects[0].attempt_id);
});

test("predefined confirmation covers outcomes, authority, routes, trust, limits, and revisions", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const prepared = prepareExample(runtime);
  const confirmation = prepared.confirmation;

  assert.equal(confirmation.schema, "flow.predefined-flow-confirmation/v1");
  assert.equal(Object.hasOwn(confirmation, "graph"), false);
  assert.deepEqual(confirmation.definition, prepared.definition);
  assert.deepEqual(confirmation.inputs, prepared.selection.inputs);
  assert.deepEqual(confirmation.promised_outcomes, [
    "an exact example outcome",
  ]);
  assert.deepEqual(confirmation.negative_outcomes, ["no remote mutation"]);
  assert.deepEqual(confirmation.requested_authority, prepared.requested_authority);
  assert.deepEqual(confirmation.mutations, prepared.requested_authority.mutations);
  assert.deepEqual(confirmation.capabilities, prepared.requested_authority.capabilities);
  assert.deepEqual(confirmation.routes, prepared.routes);
  assert.deepEqual(confirmation.limits, prepared.explicit_facts.limits);
  assert.deepEqual(confirmation.trust_posture, prepared.trust_posture);
  assert.deepEqual(confirmation.revision_templates, prepared.revision_templates);
});

test("predefined confirmation includes routes added by revision templates", () => {
  const definition = {
    ...exampleDefinition(),
    compile({ explicit_facts }) {
      const proposal = revisionBlockedCheckpointProposal();
      proposal.explicit_facts = explicit_facts;
      return proposal;
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": definition },
  });
  const proposal = revisionBlockedCheckpointProposal();
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: {},
    explicit_facts: proposal.explicit_facts,
  });

  assert.deepEqual(prepared.routes.map(({ card_id }) => card_id), [
    "confirm-plan",
    "confirm-revised-plan",
  ]);
  assert.equal(
    runtime.launch(confirmedPredefinedLaunchRequest(prepared)).created,
    true,
  );
});

test("predefined bundles are deeply immutable and byte-identical for equivalent inputs", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const first = prepareExample(runtime, { prompt: "Confirm the example", extra: {
    z: true,
    a: "stable",
  } });
  const equivalent = prepareExample(runtime, { extra: {
    a: "stable",
    z: true,
  }, prompt: "Confirm the example" });

  assert.deepEqual(equivalent, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.confirmation), true);
  assert.equal(Object.isFrozen(first.confirmation.trust_posture), true);
  assert.throws(() => {
    first.confirmation.promised_outcomes.push("changed");
  }, TypeError);
  assert.throws(() => {
    first.selection.inputs.prompt = "changed";
  }, TypeError);
});

test("predefined explicit facts normalize unordered identity arrays once", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const firstFacts = dynamicCheckpointProposal().explicit_facts;
  firstFacts.capability_envelopes = [
    "zeta:observe",
    "scope:approve",
    "alpha:observe",
  ];
  const equivalentFacts = structuredClone(firstFacts);
  equivalentFacts.capability_envelopes = [
    "alpha:observe",
    "zeta:observe",
    "scope:approve",
  ];
  const selection = (explicitFacts) => ({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Confirm the example" },
    explicit_facts: explicitFacts,
  });

  const first = runtime.prepare(selection(firstFacts));
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(first));
  const equivalent = runtime.prepare(selection(equivalentFacts));

  assert.equal(launch.schema, "flow.launch-receipt/v1");
  assert.deepEqual(equivalent, first);
});

test("selection cannot supply or replace a predefined graph or contract", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const facts = dynamicCheckpointProposal().explicit_facts;

  for (const field of ["graph", "contract", "requested_authority"]) {
    assert.throws(() => runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "example/v1",
      inputs: { prompt: "Confirm the example" },
      explicit_facts: facts,
      [field]: {},
    }), /predefined flow selection must name/);
  }
});

test("predefined registration and selection use one exact versioned shape", () => {
  const complete = exampleDefinition();
  const malformed = [
    ["missing schema", (definition) => delete definition.schema],
    ["missing compiler", (definition) => delete definition.compile],
    ["mismatched identity", (definition) => definition.id = "example"],
    ["missing promised outcomes", (definition) =>
      definition.promised_outcomes = {}],
    ["missing negative outcomes", (definition) =>
      definition.negative_outcomes = {}],
    ["missing trust posture", (definition) => definition.trust_posture = []],
    ["caller-supplied graph", (definition) => definition.graph = {}],
  ];
  for (const [label, mutate] of malformed) {
    const definition = { ...complete };
    mutate(definition);
    assert.throws(
      () => createFlowRuntime({
        runAuthority: createInMemoryRunAuthority(),
        predefinedDefinitions: { "example/v1": definition },
      }),
      /predefined definition/,
      label,
    );
  }
  assert.throws(
    () => createFlowRuntime({
      runAuthority: createInMemoryRunAuthority(),
      predefinedDefinitions: { "example/v1": () => ({}) },
    }),
    /predefined definition/,
  );
  assert.throws(
    () => createFlowRuntime({
      runAuthority: createInMemoryRunAuthority(),
      predefinedDefinitions: {
        example: { ...complete, id: "example" },
      },
    }),
    /predefined definition/,
  );

  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": complete },
  });
  const facts = dynamicCheckpointProposal().explicit_facts;
  assert.throws(
    () => runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: "unknown/v1",
      inputs: { request: "stable" },
      explicit_facts: facts,
    }),
    /predefined definition is not registered/,
  );
  assert.throws(
    () => runtime.prepare({
      schema: "flow.predefined-flow-selection/v1",
      definition: { id: "example", version: "v1" },
      inputs: { request: "stable" },
      explicit_facts: facts,
    }),
    /predefined flow selection must name/,
  );
});

test("launch binds the prepared predefined bundle without recompiling or refreshing registration", () => {
  let compileCount = 0;
  const definition = exampleDefinition();
  const originalCompile = definition.compile;
  definition.compile = (context) => {
    compileCount += 1;
    return originalCompile(context);
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = prepareExample(runtime);
  definition.compile = () => {
    throw new Error("registration was refreshed during launch");
  };
  const launchRequest = confirmedPredefinedLaunchRequest(prepared);

  const launch = runtime.launch(launchRequest);
  assert.equal(launch.created, true);
  assert.equal(compileCount, 1);

  const tampered = structuredClone(prepared);
  tampered.graph.cards[0].inputs.prompt = "a different graph";
  const tamperRejection = runtime.launch({
    ...launchRequest,
    prepared: tampered,
  });
  assert.equal(tamperRejection.code, "invalid_prepared_bundle");
  assert.equal(tamperRejection.reason, "plan_fingerprint_mismatch");

  const routeTampered = structuredClone(prepared);
  routeTampered.routes = [{ card_id: "forged", route: {} }];
  const routeRejection = runtime.launch({
    ...launchRequest,
    prepared: routeTampered,
  });
  assert.equal(routeRejection.code, "invalid_prepared_bundle");
  assert.equal(routeRejection.reason, "routes_mismatch");

  for (const [field, replacement] of [
    ["promised_outcomes", ["forged outcome"]],
    ["negative_outcomes", ["forged boundary"]],
    ["trust_posture", { authority: "forged" }],
  ]) {
    const metadataTampered = structuredClone(prepared);
    metadataTampered[field] = replacement;
    const rejection = runtime.launch({
      ...launchRequest,
      prepared: metadataTampered,
    });
    assert.equal(rejection.code, "invalid_prepared_bundle");
    assert.equal(rejection.reason, "bundle_digest_mismatch");
  }

  const wrongDecisionBinding = runtime.launch({
    ...launchRequest,
    confirmation: {
      ...launchRequest.confirmation,
      confirmation_digest: `sha256:${"8".repeat(64)}`,
    },
  });
  assert.equal(wrongDecisionBinding.code, "invalid_confirmation");
  assert.equal(wrongDecisionBinding.reason, "confirmation_binding_mismatch");
  assert.deepEqual(runtime.query().runs, [launch.run_id]);
});

test("launch returns a typed rejection for nonplain predefined selection inputs", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const prepared = prepareExample(runtime);
  const malformed = structuredClone(prepared);
  malformed.selection.inputs = new Date("2026-08-10T00:00:00Z");

  const rejection = runtime.launch({
    ...confirmedPredefinedLaunchRequest(prepared),
    prepared: malformed,
  });

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "invalid_prepared_bundle");
  assert.equal(rejection.reason, "invalid_predefined_selection");
  assert.deepEqual(runtime.query().runs, []);
});

test("predefined compiler faults are reported as definition validation errors", () => {
  const definition = exampleDefinition();
  const internal = new Error("implementation detail");
  definition.compile = () => {
    throw internal;
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": definition },
  });
  assert.throws(
    () => prepareExample(runtime),
    (error) => error.name === "PredefinedFlowValidationError" &&
      error.reason === "invalid_predefined_definition" &&
      !error.message.includes("implementation detail") &&
      error.cause === internal,
  );
});

test("predefined selections reject iterable identity facts before normalization", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  for (const [field, value] of [
    ["capability_envelopes", "scope:approve"],
    ["block_observations", new Set()],
  ]) {
    const facts = dynamicCheckpointProposal().explicit_facts;
    facts[field] = value;
    assert.throws(
      () => runtime.prepare({
        schema: "flow.predefined-flow-selection/v1",
        definition: "example/v1",
        inputs: {},
        explicit_facts: facts,
      }),
      (error) => error.name === "PredefinedFlowValidationError" &&
        error.reason === "invalid_predefined_selection",
    );
  }
});

test("predefined query and watch expose the exact authority watermark and legal actions", async () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const prepared = prepareExample(runtime);
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  const action = waiting.legal_actions.find(({ decision }) => decision === "approve");
  const watcher = runtime.watch({ run_id: launch.run_id });
  const initial = await watcher.next();

  assert.deepEqual(initial.value, waiting);
  for (const view of Object.values(waiting.views)) {
    assert.equal(view.authority_watermark, waiting.watermark);
    assert.deepEqual(view.legal_actions, waiting.legal_actions);
  }

  const update = watcher.next();
  const receipt = runtime.command(action);
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(receipt.accepted, true);
  assert.deepEqual((await update).value, completed);
  assert.equal(completed.phase, "succeeded");
  assert.deepEqual(completed.legal_actions, []);
  for (const view of Object.values(completed.views)) {
    assert.equal(view.authority_watermark, completed.watermark);
    assert.deepEqual(view.legal_actions, []);
  }
  await watcher.return();
});

test("declining a predefined checkpoint reaches a terminal negative outcome", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: { "example/v1": exampleDefinition() },
  });
  const prepared = prepareExample(runtime);
  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  const decline = waiting.legal_actions.find(
    ({ decision }) => decision === "decline",
  );

  assert.equal(runtime.command(decline).accepted, true);
  const declined = runtime.query({ run_id: launch.run_id });
  assert.equal(declined.phase, "declined");
  assert.deepEqual(declined.legal_actions, []);
});

test("predefined preparation binds required authority contracts and launch rechecks them", () => {
  const observations = new Map();
  const authority = (id, contract, providerId, digit, generation) =>
    registeredAuthority({
      id,
      contract,
      providerId,
      observe({ observation_input }) {
        observations.set(id, (observations.get(id) ?? 0) + 1);
        return {
          schema: "flow.authority-observation/v1",
          status: "available",
          watermark: `sha256:${digit.repeat(64)}`,
          generation,
          observation_input,
        };
      },
    });
  const routeAuthority = authority(
    "route:example",
    "flow.route-authority/v1",
    "route-adapter",
    "a",
    3,
  );
  const resourceAuthority = authority(
    "resource:example",
    "flow.resource-authority/v1",
    "resource-adapter",
    "b",
    7,
  );
  const contractAuthority = authority(
    "contract:example",
    "flow.contract-authority/v1",
    "contract-adapter",
    "c",
    11,
  );
  const requiredAuthorities = [
    {
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    },
    {
      schema: "flow.required-authority/v1",
      id: "resource:example",
      contract: "flow.resource-authority/v1",
      observation_input: { resource: "example", generation: 7 },
    },
    {
      schema: "flow.required-authority/v1",
      id: "contract:example",
      contract: "flow.contract-authority/v1",
      observation_input: { contract: "example", generation: 11 },
    },
  ];
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: {
      "route:example": routeAuthority,
      "resource:example": resourceAuthority,
      "contract:example": contractAuthority,
    },
    predefinedDefinitions: {
      "example/v1": {
        ...exampleDefinition(),
        required_authorities: requiredAuthorities,
      },
    },
  });

  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Confirm the example" },
    explicit_facts: dynamicCheckpointProposal().explicit_facts,
  });

  assert.deepEqual(prepared.required_authorities.map((binding) => ({
    id: binding.id,
    contract: binding.contract,
    provider_identity: binding.provider_identity,
    observation_input: binding.observation_input,
    observation: binding.observation,
  })), [
    {
      id: "contract:example",
      contract: "flow.contract-authority/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "contract-adapter",
        version: "v1",
      },
      observation_input: { contract: "example", generation: 11 },
      observation: {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${"c".repeat(64)}`,
        generation: 11,
        observation_input: { contract: "example", generation: 11 },
      },
    },
    {
      id: "resource:example",
      contract: "flow.resource-authority/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "resource-adapter",
        version: "v1",
      },
      observation_input: { resource: "example", generation: 7 },
      observation: {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${"b".repeat(64)}`,
        generation: 7,
        observation_input: { resource: "example", generation: 7 },
      },
    },
    {
      id: "route:example",
      contract: "flow.route-authority/v1",
      provider_identity: {
        schema: "flow.registered-authority/v1",
        id: "route-adapter",
        version: "v1",
      },
      observation_input: { route: "example" },
      observation: {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${"a".repeat(64)}`,
        generation: 3,
        observation_input: { route: "example" },
      },
    },
  ]);
  assert.equal(prepared.required_authorities.every((binding) =>
    !Object.values(binding).some((value) => typeof value === "function")), true);
  assert.deepEqual([...observations], [
    ["contract:example", 1],
    ["resource:example", 1],
    ["route:example", 1],
  ]);

  const launch = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(launch.created, true);
  assert.deepEqual([...observations], [
    ["contract:example", 2],
    ["resource:example", 2],
    ["route:example", 2],
  ]);
});

test("authority preparation requires the exact observation input", () => {
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
  };
  for (const [label, input] of [
    ["missing", undefined],
    ["augmented", { route: "example", extra: true }],
    ["substituted", { route: "other" }],
  ]) {
    const runtime = createFlowRuntime({
      runAuthority: createInMemoryRunAuthority(),
      registeredAuthorities: {
        "route:example": registeredAuthority({
          id: "route:example",
          contract: "flow.route-authority/v1",
          providerId: "route-adapter",
          observe() {
            return {
              schema: "flow.authority-observation/v1",
              status: "available",
              watermark: `sha256:${"a".repeat(64)}`,
              ...(input === undefined
                ? {}
                : { observation_input: input }),
            };
          },
        }),
      },
      predefinedDefinitions: { "example/v1": definition },
    });
    assert.throws(
      () => prepareExample(runtime),
      (error) => error.name === "PredefinedFlowValidationError" &&
        error.reason === "required_authority_unavailable",
      label,
    );
  }
});

test("required authority declarations are records, not string shorthands", () => {
  assert.throws(
    () => normalizeRequiredAuthorities(["route:example"]),
    TypeError,
  );
  assert.deepEqual(
    normalizeRequiredAuthorities([{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }]),
    [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
  );
});

test("definition-scoped authority issues identify the prepared definition", () => {
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
  };
  const source = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: {
      "route:example": registeredAuthority({
        id: "route:example",
        contract: "flow.route-authority/v1",
        providerId: "route-adapter",
        observe({ observation_input }) {
          return {
            schema: "flow.authority-observation/v1",
            status: "available",
            watermark: `sha256:${"a".repeat(64)}`,
            observation_input,
          };
        },
      }),
    },
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = prepareExample(source);
  const request = confirmedPredefinedLaunchRequest(prepared);
  const expectedFact = {
    schema: "flow.authority-fact/v1",
    authority_id: "example/v1",
    authority_contract: "flow.definition/example/v1",
    provider_identity: null,
    watermark: null,
    generation: null,
    legal_actions: [],
  };

  const unavailable = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
  }).launch(request);
  assert.equal(unavailable.code, "required_authority_catalog_unavailable");
  assert.deepEqual(unavailable.authority_fact, expectedFact);

  const mismatch = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    predefinedDefinitions: {
      "example/v1": {
        ...definition,
        contract: "flow.definition/other/v1",
      },
    },
  }).launch(request);
  assert.equal(mismatch.code, "required_authority_binding_mismatch");
  assert.deepEqual(mismatch.authority_fact, expectedFact);
});

test("exact existing predefined launch is adopted before authority rechecks", () => {
  let observations = 0;
  let available = true;
  const authority = registeredAuthority({
    id: "route:example",
    contract: "flow.route-authority/v1",
    providerId: "route-adapter",
    observe({ observation_input }) {
      observations += 1;
      if (!available) throw new Error("provider unavailable");
      return {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${"a".repeat(64)}`,
        generation: 3,
        observation_input,
      };
    },
  });
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: { "route:example": authority },
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Confirm the example" },
    explicit_facts: dynamicCheckpointProposal().explicit_facts,
  });
  const request = confirmedPredefinedLaunchRequest(prepared);
  const first = runtime.launch(request);
  assert.equal(first.created, true);
  const observationsAtLaunch = observations;
  available = false;

  const adopted = runtime.launch(structuredClone(request));
  assert.equal(adopted.created, false);
  assert.equal(observations, observationsAtLaunch);
});

test("exact existing predefined launch is adopted before operation compatibility checks", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-adoption-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => runAuthority.close());
  let compatible = true;
  const definition = {
    ...exampleDefinition(),
    compile({ inputs, explicit_facts }) {
      const proposal = registeredOperationProposal({ checkpointBound: false });
      proposal.graph.cards[0].inputs.value = inputs.value;
      const facts = structuredClone(explicit_facts);
      proposal.explicit_facts = facts;
      return proposal;
    },
  };
  const operation = {
    schema: "flow.registered-operation/v1",
    contract: TEST_OPERATION_CONTRACT,
    classification: "caller_idempotent",
    validateCard() {
      if (!compatible) throw new Error("operation registration drifted");
    },
    invoke() {},
  };
  const runtime = createFlowRuntime({
    runAuthority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: operation },
    predefinedDefinitions: { "example/v1": definition },
  });
  const explicitFacts = registeredOperationProposal({ checkpointBound: false })
    .explicit_facts;
  const prepareOperation = (value) => runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { value },
    explicit_facts: explicitFacts,
  });
  const prepared = prepareOperation("first");
  const request = confirmedPredefinedLaunchRequest(prepared);
  const first = runtime.launch(request);
  assert.equal(first.created, true);

  const absentPrepared = prepareOperation("second");
  compatible = false;
  const adopted = runtime.launch(structuredClone(request));
  assert.equal(adopted.created, false);

  const absent = runtime.launch(confirmedPredefinedLaunchRequest(
    absentPrepared,
  ));
  assert.equal(absent.code, "invalid_operation_input");
});

test("predefined launch rejects an absent run when its registered authority drifts", () => {
  const firstAuthority = registeredAuthority({
    id: "route:example",
    contract: "flow.route-authority/v1",
    providerId: "route-adapter",
    observe({ observation_input }) {
      return {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${"a".repeat(64)}`,
        generation: 3,
        observation_input,
      };
    },
  });
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
  };
  const authority = createInMemoryRunAuthority();
  const preparing = createFlowRuntime({
    runAuthority: authority,
    registeredAuthorities: { "route:example": firstAuthority },
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = preparing.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Confirm the example" },
    explicit_facts: dynamicCheckpointProposal().explicit_facts,
  });
  const request = confirmedPredefinedLaunchRequest(prepared);
  const replacementAuthority = registeredAuthority({
    id: "route:example",
    contract: "flow.route-authority/v1",
    providerId: "route-adapter",
    observe({ observation_input }) {
      return {
        schema: "flow.authority-observation/v1",
        status: "stale",
        watermark: `sha256:${"b".repeat(64)}`,
        generation: 4,
        observation_input,
      };
    },
  });
  const replacing = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: { "route:example": replacementAuthority },
    predefinedDefinitions: { "example/v1": definition },
  });

  const rejection = replacing.launch(request);
  assert.equal(rejection.code, "required_authority_stale");
  assert.equal(rejection.authority_watermark, replacing.query().watermark);
  assert.deepEqual(replacing.query().runs, []);
});

test("predefined launch rejects an absent run when a resource generation drifts", () => {
  let generation = 7;
  const authority = createInMemoryRunAuthority();
  const resourceAuthority = registeredAuthority({
    id: "resource:example",
    contract: "flow.resource-authority/v1",
    providerId: "resource-adapter",
    observe({ observation_input }) {
      return {
        schema: "flow.authority-observation/v1",
        status: "available",
        watermark: `sha256:${(generation === 7 ? "a" : "b").repeat(64)}`,
        generation,
        observation_input,
      };
    },
  });
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "resource:example",
      contract: "flow.resource-authority/v1",
      observation_input: { resource: "example" },
    }],
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredAuthorities: { "resource:example": resourceAuthority },
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = prepareExample(runtime);
  generation = 8;

  const rejection = runtime.launch(confirmedPredefinedLaunchRequest(prepared));
  assert.equal(rejection.code, "required_authority_stale");
  assert.equal(rejection.authority_watermark, runtime.query().watermark);
  assert.deepEqual(runtime.query().runs, []);
});

test("predefined launch rejects a same-contract adapter substitution", () => {
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
  };
  const authority = createInMemoryRunAuthority();
  const original = createFlowRuntime({
    runAuthority: authority,
    registeredAuthorities: {
      "route:example": registeredAuthority({
        id: "route:example",
        contract: "flow.route-authority/v1",
        providerId: "route-adapter-a",
        observe({ observation_input }) {
          return {
            schema: "flow.authority-observation/v1",
            status: "available",
            watermark: `sha256:${"a".repeat(64)}`,
            generation: 3,
            observation_input,
          };
        },
      }),
    },
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = prepareExample(original);
  const replacement = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: {
      "route:example": registeredAuthority({
        id: "route:example",
        contract: "flow.route-authority/v1",
        providerId: "route-adapter-b",
        observe({ observation_input }) {
          return {
            schema: "flow.authority-observation/v1",
            status: "available",
            watermark: `sha256:${"a".repeat(64)}`,
            generation: 3,
            observation_input,
          };
        },
      }),
    },
    predefinedDefinitions: { "example/v1": definition },
  });

  const rejection = replacement.launch(
    confirmedPredefinedLaunchRequest(prepared),
  );
  assert.equal(rejection.code, "required_authority_provider_mismatch");
  assert.deepEqual(replacement.query().runs, []);
});

test("predefined launch preserves typed authority status and recovery facts", () => {
  const cases = [
    ["missing", "required_authority_missing", "c"],
    ["unavailable", "required_authority_unavailable", "d"],
    ["contradictory", "required_authority_contradictory", "e"],
    ["uncertain", "required_authority_uncertain", "f"],
  ];
  for (const [status, code, digit] of cases) {
    const authorityId = `route:${status}`;
    const definition = {
      ...exampleDefinition(),
      required_authorities: [{
        schema: "flow.required-authority/v1",
        id: authorityId,
        contract: "flow.route-authority/v1",
        observation_input: { route: status },
      }],
    };
    const runtime = createFlowRuntime({
      runAuthority: createInMemoryRunAuthority(),
      registeredAuthorities: {
        [authorityId]: registeredAuthority({
          id: authorityId,
          contract: "flow.route-authority/v1",
          providerId: `${status}-adapter`,
          observe({ observation_input }) {
            return {
              schema: "flow.authority-observation/v1",
              status,
              watermark: `sha256:${digit.repeat(64)}`,
              generation: 4,
              observation_input,
              legal_actions: [{ decision: "retry" }],
            };
          },
        }),
      },
      predefinedDefinitions: { "example/v1": definition },
    });
    const prepared = prepareExample(runtime);
    const rejection = runtime.launch(confirmedPredefinedLaunchRequest(prepared));

    assert.equal(rejection.code, code, status);
    assert.equal(rejection.authority_watermark, runtime.query().watermark, status);
    assert.deepEqual(rejection.legal_actions, [{ decision: "retry" }], status);
    assert.deepEqual(runtime.query().runs, [], status);
  }
});

test("authority rejection keeps the host watermark for stale retry", () => {
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "resource:example",
      contract: "flow.resource-authority/v1",
      observation_input: { resource: "example" },
    }],
  };
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
    registeredAuthorities: {
      "resource:example": registeredAuthority({
        id: "resource:example",
        contract: "flow.resource-authority/v1",
        providerId: "resource-adapter",
        observe({ observation_input }) {
          return {
            schema: "flow.authority-observation/v1",
            status: "stale",
            generation: 9,
            observation_input,
            legal_actions: [{ decision: "refresh" }],
          };
        },
      }),
    },
    predefinedDefinitions: { "example/v1": definition },
  });
  const rejection = runtime.launch(
    confirmedPredefinedLaunchRequest(prepareExample(runtime)),
  );

  assert.equal(rejection.code, "required_authority_stale");
  assert.equal(rejection.authority_watermark, runtime.query().watermark);
  assert.deepEqual(rejection.legal_actions, [{ decision: "refresh" }]);
  assert.deepEqual(rejection.authority_fact, {
    schema: "flow.authority-fact/v1",
    authority_id: "resource:example",
    authority_contract: "flow.resource-authority/v1",
    provider_identity: {
      schema: "flow.registered-authority/v1",
      id: "resource-adapter",
      version: "v1",
    },
    watermark: null,
    generation: 9,
    legal_actions: [{ decision: "refresh" }],
  });
});

test("predefined reboot admission rechecks every bound authority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-binding-reboot-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authoritySpecs = [
    ["contract:example", "flow.contract-authority/v1", "c", 11],
    ["generation:example", "flow.subject-generation/v1", "d", 13],
    ["resource:example", "flow.resource-authority/v1", "b", 7],
    ["route:example", "flow.route-authority/v1", "a", 3],
  ];
  const observations = new Map();
  const requiredAuthority = ([id, contract, digit, initialGeneration], status,
    generationOnly = false) =>
    registeredAuthority({
      id,
      contract,
      providerId: `${id}-adapter`,
      observe({ observation_input }) {
        observations.set(id, (observations.get(id) ?? 0) + 1);
        return {
          schema: "flow.authority-observation/v1",
          status,
          ...(generationOnly ? {} : {
            watermark: `sha256:${digit.repeat(64)}`,
          }),
          generation: status === "available"
            ? initialGeneration
            : initialGeneration + 1,
          observation_input,
          legal_actions: [{ decision: "refresh" }],
        };
      },
    });
  const definition = {
    ...exampleDefinition(),
    required_authorities: authoritySpecs.map(([id, contract]) => ({
      schema: "flow.required-authority/v1",
      id,
      contract,
      observation_input: { authority: id },
    })),
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => firstAuthority.close());
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredAuthorities: Object.fromEntries(authoritySpecs.map((spec) => [
      spec[0], requiredAuthority(spec, "available"),
    ])),
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = firstRuntime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Confirm the example" },
    explicit_facts: dynamicCheckpointProposal().explicit_facts,
  });
  const launch = firstRuntime.launch(confirmedPredefinedLaunchRequest(prepared));
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared: observedPrepared }) {
        return {
          ...preparedObservation(observedPrepared),
          time_facts: observedPrepared.explicit_facts.time_facts.map((fact) =>
            fact.kind === "boot" ? { ...fact, boot_id: "boot-b" } : fact),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({
    runAuthority: rebootedAuthority,
    registeredAuthorities: Object.fromEntries(authoritySpecs.map((spec) => [
      spec[0], requiredAuthority(
        spec,
        spec[0] === "generation:example" ? "stale" : "available",
        spec[0] === "generation:example",
      ),
    ])),
  });

  const suspended = rebooted.query({ run_id: launch.run_id });
  const action = suspended.legal_actions[0];
  assert.equal(action.revalidation.valid, false);
  assert.equal(action.revalidation.authority_bindings.valid, false);
  assert.deepEqual(action.revalidation.authority_bindings.expected.map(
    ({ id }) => id,
  ), authoritySpecs.map(([id]) => id));
  assert.deepEqual(action.revalidation.authority_bindings.observed.map(
    ({ id }) => id,
  ), authoritySpecs.map(([id]) => id));
  assert.equal(action.revalidation.authority_bindings.issues[0].code,
    "required_authority_stale");
  assert.equal(action.revalidation.authority_bindings.issues[0].authority_id,
    "generation:example");
  assert.deepEqual([...observations], authoritySpecs.map(([id]) => [id, 3]));
  const rejection = rebooted.command(action);
  assert.equal(rejection.code, "required_authority_stale");
  assert.equal(rejection.authority_watermark,
    rebooted.query({ run_id: launch.run_id }).watermark);
  assert.deepEqual(rejection.authority_fact, {
    schema: "flow.authority-fact/v1",
    authority_id: "generation:example",
    authority_contract: "flow.subject-generation/v1",
    provider_identity: {
      schema: "flow.registered-authority/v1",
      id: "generation:example-adapter",
      version: "v1",
    },
    watermark: null,
    generation: 14,
    legal_actions: [{ decision: "refresh" }],
  });
  assert.deepEqual(rebooted.query({ run_id: launch.run_id }).legal_actions.map(
    ({ type }) => type,
  ), ["reboot_admission"]);

  const schemaRoot = new URL("../../../config/flow/schemas/", import.meta.url).pathname;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schemaNames = [
    "flow.time-fact.v1.schema.json",
    "flow.subject-generation.v1.schema.json",
    "flow.reboot-effect-recheck.v1.schema.json",
    "flow.authority-observation.v1.schema.json",
    "flow.required-authority-binding.v1.schema.json",
    "flow.required-authority-revalidation.v1.schema.json",
    "flow.reboot-revalidation.v1.schema.json",
  ];
  for (const name of schemaNames) {
    ajv.addSchema(JSON.parse(readFileSync(join(schemaRoot, name), "utf8")));
  }
  const validateReboot = ajv.getSchema(
    "https://dotfiles.local/schemas/flow.reboot-revalidation.v1.schema.json",
  );
  assert.equal(validateReboot(action.revalidation), true,
    JSON.stringify(validateReboot.errors));
});

test("public FlowRuntime reports base reboot failure before authority failure", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-binding-effects-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const operationProposal = registeredOperationProposal({ checkpointBound: false });
  let authorityStatus = "available";
  let authorityWatermarkDigit = "a";
  let rebootObservationRequest;
  const authorityRegistration = registeredAuthority({
    id: "route:example",
    contract: "flow.route-authority/v1",
    providerId: "route-adapter",
    observe(request) {
      if (request.phase === "reboot") rebootObservationRequest = request;
      return {
        schema: "flow.authority-observation/v1",
        status: authorityStatus,
        watermark: `sha256:${authorityWatermarkDigit.repeat(64)}`,
        observation_input: request.observation_input,
        legal_actions: [{ decision: "refresh" }],
      };
    },
  });
  const definition = {
    ...exampleDefinition(),
    required_authorities: [{
      schema: "flow.required-authority/v1",
      id: "route:example",
      contract: "flow.route-authority/v1",
      observation_input: { route: "example" },
    }],
    compile() {
      return registeredOperationProposal({ checkpointBound: false });
    },
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredAuthorities: { "route:example": authorityRegistration },
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke() {
          return new Promise(() => {});
        },
      },
    },
    predefinedDefinitions: { "example/v1": definition },
  });
  const prepared = firstRuntime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs: { prompt: "Record the example" },
    explicit_facts: operationProposal.explicit_facts,
  });
  const launch = firstRuntime.launch(confirmedPredefinedLaunchRequest(prepared));
  const operation = firstRuntime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "operation_execute");
  const effectReceipt = firstRuntime.command(operation);
  assert.equal(effectReceipt.accepted, true);
  assert.equal(effectReceipt.effect_intents.length, 1);
  firstAuthority.close();

  authorityStatus = "stale";
  authorityWatermarkDigit = "b";
  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared: observedPrepared }) {
        const observation = preparedObservation(observedPrepared);
        return {
          ...observation,
          time_facts: observation.time_facts.map((fact) =>
            fact.kind === "boot" ? { ...fact, boot_id: "boot-b" } : fact),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({
    runAuthority: rebootedAuthority,
    registeredAuthorities: { "route:example": authorityRegistration },
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke: operationReceipt,
      },
    },
    predefinedDefinitions: { "example/v1": definition },
  });
  const suspended = rebooted.query({ run_id: launch.run_id });
  const action = suspended.legal_actions[0];
  assert.equal(action.type, "reboot_admission");
  assert.equal(action.revalidation.base_valid, false);
  assert.equal(action.revalidation.valid, false);
  assert.equal(action.revalidation.unresolved_effects.length, 1);
  assert.equal(action.revalidation.authority_bindings.valid, false);
  assert.equal(action.revalidation.authority_bindings.issues[0].code,
    "required_authority_stale");
  assert.deepEqual(suspended.reboot_revalidation, action.revalidation);
  assert.equal(Object.hasOwn(rebootObservationRequest, "expected_observation"), false);

  const rejection = rebooted.command(action);
  assert.equal(rejection.code, "reboot_revalidation_failed");
  assert.equal(rejection.authority_fact.authority_id, "route:example");
  assert.equal(rejection.authority_fact.generation, null);
  assert.equal(rejection.authority_fact.watermark,
    `sha256:${"b".repeat(64)}`);
});

function exampleDefinition() {
  return {
    schema: "flow.predefined-definition/v1",
    id: "example/v1",
    contract: "flow.definition/example/v1",
    promised_outcomes: ["an exact example outcome"],
    negative_outcomes: ["no remote mutation"],
    trust_posture: {
      authority: "RunAuthority",
      operator_confirmation: "required",
    },
    compile({ inputs, explicit_facts }) {
      const proposal = dynamicCheckpointProposal();
      proposal.graph.cards[0].inputs.prompt = inputs.prompt;
      proposal.explicit_facts = explicit_facts;
      return proposal;
    },
  };
}

function registeredAuthority({ id, contract, providerId, observe }) {
  return {
    schema: "flow.registered-authority/v1",
    id,
    contract,
    provider_identity: {
      schema: "flow.registered-authority/v1",
      id: providerId,
      version: "v1",
    },
    observe,
  };
}

function prepareExample(runtime, inputs = { prompt: "Confirm the example" }) {
  return runtime.prepare({
    schema: "flow.predefined-flow-selection/v1",
    definition: "example/v1",
    inputs,
    explicit_facts: dynamicCheckpointProposal().explicit_facts,
  });
}

function confirmedPredefinedLaunchRequest(prepared, decision = "accept") {
  return {
    prepared,
    confirmation: {
      schema: "flow.predefined-flow-confirmation-decision/v1",
      decision,
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

async function untilProjection(runtime, runId, phase) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = runtime.query({ run_id: runId });
    if (projection.phase === phase) return projection;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${phase}`);
}

async function untilCondition(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for condition");
}

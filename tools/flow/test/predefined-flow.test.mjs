import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { PlanCompiler } from "../src/plan-compiler.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import { dynamicCheckpointProposal } from "../test-support/dynamic-checkpoint.mjs";
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

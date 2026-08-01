import assert from "node:assert/strict";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { compileDynamicPlan } from "../src/plan-compiler.mjs";
import { createInMemoryRunAuthority } from "../src/run-authority.mjs";
import {
  confirmedLaunchRequest,
  dependencyCheckpointProposal,
  dynamicCheckpointProposal,
  independentCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";

test("prepare returns an immutable content-addressed dynamic graph without creating a run", () => {
  const runtime = createTestRuntime();
  const request = dynamicCheckpointProposal();

  const prepared = runtime.prepare(request);

  assert.equal(prepared.schema, "flow.prepared-run/v1");
  assert.equal(prepared.kind, "dynamic");
  assert.match(prepared.bundle_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(prepared.plan_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(prepared.confirmation_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(prepared.confirmation.graph, prepared.graph);
  assert.deepEqual(
    prepared.confirmation.requested_authority,
    request.requested_authority,
  );
  assert.equal(prepared.confirmation.bundle_digest, prepared.bundle_digest);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.graph.cards[0]), true);
  assert.throws(() => {
    prepared.graph.cards[0].id = "changed";
  }, TypeError);
  assert.deepEqual(runtime.query(), {
    schema: "flow.run-index-projection/v1",
    watermark: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    runs: [],
  });

  const equivalentRequest = dynamicCheckpointProposal();
  equivalentRequest.explicit_facts = Object.fromEntries(
    Object.entries(equivalentRequest.explicit_facts).reverse(),
  );
  assert.deepEqual(runtime.prepare(equivalentRequest), prepared);
});

test("prepare rejects incomplete or cyclic dynamic graphs", () => {
  const runtime = createTestRuntime();
  const incompleteCard = dynamicCheckpointProposal();
  delete incompleteCard.graph.cards[0].outputs;
  assert.throws(
    () => runtime.prepare(incompleteCard),
    /dynamic plan card contract is incomplete: confirm-plan/,
  );

  const incompleteFacts = dynamicCheckpointProposal();
  delete incompleteFacts.explicit_facts.operation_contracts;
  assert.throws(
    () => runtime.prepare(incompleteFacts),
    /dynamic plan identity facts are incomplete/,
  );

  const cyclic = dynamicCheckpointProposal();
  cyclic.graph.cards[0].dependencies = ["confirm-plan"];
  assert.throws(
    () => runtime.prepare(cyclic),
    /dynamic plan graph must be acyclic/,
  );

  const missingAuthority = dynamicCheckpointProposal();
  missingAuthority.requested_authority.commands = [];
  assert.throws(
    () => runtime.prepare(missingAuthority),
    /dynamic plan checkpoint authority is incomplete/,
  );

  const ambiguous = dynamicCheckpointProposal();
  ambiguous.graph.cards[0].inputs.optional = undefined;
  assert.throws(
    () => runtime.prepare(ambiguous),
    /canonical values must use lossless JSON types/,
  );

  const unsupportedExecutor = dynamicCheckpointProposal();
  unsupportedExecutor.graph.cards[0].executor = {
    kind: "operation",
    contract: "flow.operation/example/v1",
  };
  assert.throws(
    () => runtime.prepare(unsupportedExecutor),
    /dynamic checkpoint plan does not support executor kind: operation/,
  );

  const unknownDependency = dynamicCheckpointProposal();
  unknownDependency.graph.cards[0].dependencies = ["missing-card"];
  assert.throws(
    () => runtime.prepare(unknownDependency),
    /dynamic plan dependency is unknown: confirm-plan/,
  );

  const decoratedArray = dynamicCheckpointProposal();
  decoratedArray.requested_authority.commands.description = "ambient metadata";
  assert.throws(
    () => runtime.prepare(decoratedArray),
    /canonical arrays must not contain extra properties/,
  );

  const privateCheckpoint = dynamicCheckpointProposal();
  privateCheckpoint.graph.cards[0].executor.contract =
    "flow.checkpoint/private-controller/v1";
  assert.throws(
    () => runtime.prepare(privateCheckpoint),
    /unsupported checkpoint contract: flow\.checkpoint\/private-controller\/v1/,
  );

  const missingValidator = dynamicCheckpointProposal();
  missingValidator.graph.cards[0].validators = [];
  assert.throws(
    () => runtime.prepare(missingValidator),
    /unsupported checkpoint validator contract: confirm-plan/,
  );

  const privateValidator = dynamicCheckpointProposal();
  privateValidator.graph.cards[0].validators = ["flow.validator/private/v1"];
  privateValidator.explicit_facts.validator_contracts = [
    "flow.validator/private/v1",
  ];
  assert.throws(
    () => runtime.prepare(privateValidator),
    /unsupported checkpoint validator contract: confirm-plan/,
  );
});

test("duplicate launch adopts the exact confirmed bundle without recompiling facts", () => {
  let compilationCount = 0;
  const runtime = createTestRuntime({
    planCompiler(proposal) {
      compilationCount += 1;
      return compileDynamicPlan(proposal);
    },
  });
  const request = dynamicCheckpointProposal();
  const prepared = runtime.prepare(request);
  request.explicit_facts.catalog_fingerprint = `sha256:${"9".repeat(64)}`;
  const launchRequest = confirmedLaunchRequest(prepared);

  const created = runtime.launch(launchRequest);
  const adopted = runtime.launch(structuredClone(launchRequest));

  assert.equal(compilationCount, 1);
  assert.equal(created.schema, "flow.launch-receipt/v1");
  assert.match(created.run_id, /^run:[0-9a-f]{64}$/);
  assert.equal(created.bundle_digest, prepared.bundle_digest);
  assert.equal(created.created, true);
  assert.deepEqual(adopted, { ...created, created: false });
  const runIndex = runtime.query();
  assert.equal(runIndex.schema, "flow.run-index-projection/v1");
  assert.match(runIndex.watermark, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(runIndex.runs, [created.run_id]);

  const tampered = structuredClone(prepared);
  tampered.graph.cards[0].inputs.prompt = "Different authority";
  const tamperedRejection = runtime.launch({ ...launchRequest, prepared: tampered });
  assert.equal(tamperedRejection.code, "invalid_prepared_bundle");
  assert.equal(tamperedRejection.reason, "plan_fingerprint_mismatch");
  assert.equal(
    runtime.launch({
      ...launchRequest,
      closed_facts: {
        ...launchRequest.closed_facts,
        facts: {
          ...prepared.explicit_facts,
          catalog_fingerprint: `sha256:${"8".repeat(64)}`,
        },
      },
    }).code,
    "closed_facts_changed",
  );

  const forgedConfirmation = structuredClone(prepared);
  forgedConfirmation.confirmation.graph.cards[0].id = "operator-saw-another-plan";
  const confirmationRejection = runtime.launch({
    ...confirmedLaunchRequest(forgedConfirmation),
    prepared: forgedConfirmation,
  });
  assert.equal(confirmationRejection.code, "invalid_prepared_bundle");
  assert.equal(confirmationRejection.reason, "confirmation_binding_mismatch");

  const selfConsistentUnsupported = structuredClone(prepared);
  selfConsistentUnsupported.graph.cards[0].executor = {
    kind: "operation",
    contract: "flow.operation/example/v1",
  };
  rebindPreparedIdentity(selfConsistentUnsupported);
  const executorRejection = runtime.launch(
    confirmedLaunchRequest(selfConsistentUnsupported),
  );
  assert.equal(executorRejection.code, "invalid_prepared_bundle");
  assert.equal(executorRejection.reason, "unsupported_executor_kind");

  const invalidDecision = runtime.launch({
      ...launchRequest,
      confirmation: {
        ...launchRequest.confirmation,
        decision: "later",
      },
    });
  assert.equal(invalidDecision.code, "invalid_confirmation");
  assert.equal(invalidDecision.reason, "unsupported_confirmation_decision");
});

test("launch rejects a self-consistent prepared graph that is not canonical", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dependencyCheckpointProposal());
  const noncanonical = structuredClone(prepared);
  noncanonical.graph.cards.reverse();
  rebindPreparedIdentity(noncanonical);

  const rejection = runtime.launch(confirmedLaunchRequest(noncanonical));

  assert.equal(rejection.code, "invalid_prepared_bundle");
  assert.equal(rejection.reason, "noncanonical_graph");
  assert.deepEqual(runtime.query().runs, []);
});

test("launch returns a typed rejection for a null request", () => {
  const runtime = createTestRuntime();

  assert.deepEqual(runtime.launch(null), {
    schema: "flow.rejection/v1",
    operation: "launch",
    code: "invalid_prepared_bundle",
    reason: "invalid_prepared_contract",
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: `sha256:${"0".repeat(64)}`,
    authority_watermark_domain: "host",
    legal_actions: [],
  });
});

test("launch rejects unsigned fields on the prepared envelope", () => {
  const runtime = createTestRuntime();
  const prepared = structuredClone(runtime.prepare(dynamicCheckpointProposal()));
  prepared.private_controller = { command: "complete" };

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.code, "invalid_prepared_bundle");
  assert.equal(rejection.reason, "invalid_prepared_contract");
  assert.deepEqual(runtime.query().runs, []);
});

test("runtime interfaces in one process share one host authority", () => {
  const firstRuntime = createFlowRuntime();
  const secondRuntime = createFlowRuntime();
  const request = dynamicCheckpointProposal();
  request.explicit_facts.catalog_fingerprint = `sha256:${"7".repeat(64)}`;
  const prepared = firstRuntime.prepare(request);
  const launchRequest = confirmedLaunchRequest(prepared);

  const created = firstRuntime.launch(launchRequest);
  const adopted = secondRuntime.launch(launchRequest);

  assert.equal(created.created, true);
  assert.deepEqual(adopted, { ...created, created: false });
});

test("query dispatches registered contracts through the five-operation runtime", async () => {
  const projection = {
    schema: "flow.legacy-compatibility-inventory/v1",
    watermark: { content_sha256: "1".repeat(64) },
    inventory: { runs: [] },
    legal_next_actions: ["reinventory"],
  };
  const runtime = createTestRuntime({
    registeredQueries: {
      legacy_compatibility_inventory(request) {
        assert.deepEqual(request, {
          schema: "flow.query/v1",
          query: "legacy_compatibility_inventory",
        });
        return projection;
      },
    },
  });

  assert.deepEqual(Object.keys(runtime), [
    "prepare",
    "launch",
    "command",
    "query",
    "watch",
  ]);
  assert.deepEqual(await runtime.query({
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  }), projection);
  const unsupportedQuery = {
    schema: "flow.rejection/v1",
    operation: "query",
    code: "unsupported_query",
    reason: null,
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: `sha256:${"0".repeat(64)}`,
    authority_watermark_domain: "host",
    legal_actions: [],
  };
  for (const query of ["private_query", "constructor", "toString"]) {
    assert.deepEqual(await runtime.query({
      schema: "flow.query/v1",
      query,
    }), unsupportedQuery);
  }
  assert.equal(runtime.query().schema, "flow.run-index-projection/v1");
});

test("a typed checkpoint command completes the authority-derived run", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));

  const waiting = runtime.query({ run_id: launch.run_id });

  assert.equal(waiting.schema, "flow.run-projection/v1");
  assert.equal(waiting.run_id, launch.run_id);
  assert.equal(waiting.watermark, launch.authority_watermark);
  assert.equal(waiting.sequence, 1);
  assert.equal(waiting.phase, "active");
  assert.equal(waiting.bundle_digest, prepared.bundle_digest);
  assert.equal(waiting.plan_fingerprint, prepared.plan_fingerprint);
  assert.deepEqual(waiting.cards, [
    {
      id: "confirm-plan",
      executor_kind: "checkpoint",
      status: "waiting_checkpoint",
    },
  ]);
  assert.deepEqual(waiting.legal_actions, [
    {
      schema: "flow.command/v1",
      type: "checkpoint_decision",
      run_id: launch.run_id,
      checkpoint_id: "confirm-plan",
      decision: "approve",
      expected_watermark: launch.authority_watermark,
    },
    {
      schema: "flow.command/v1",
      type: "checkpoint_decision",
      run_id: launch.run_id,
      checkpoint_id: "confirm-plan",
      decision: "decline",
      expected_watermark: launch.authority_watermark,
    },
  ]);

  const receipt = runtime.command(waiting.legal_actions[0]);
  const completed = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(receipt, {
    schema: "flow.command-receipt/v1",
    command_type: "checkpoint_decision",
    run_id: launch.run_id,
    authority_watermark: completed.watermark,
    accepted: true,
  });
  assert.notEqual(completed.watermark, waiting.watermark);
  assert.equal(completed.sequence, 3);
  assert.equal(completed.phase, "succeeded");
  assert.deepEqual(completed.cards, [
    {
      id: "confirm-plan",
      executor_kind: "checkpoint",
      status: "completed",
    },
  ]);
  assert.deepEqual(completed.legal_actions, []);

  const stale = runtime.command(waiting.legal_actions[0]);
  assert.equal(stale.schema, "flow.rejection/v1");
  assert.equal(stale.code, "stale_authority_watermark");
  assert.equal(stale.authority_watermark, completed.watermark);
  assert.equal(runtime.query({ run_id: launch.run_id }).watermark, completed.watermark);
});

test("declining confirmation or a checkpoint records a typed negative outcome", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());

  assert.deepEqual(
    runtime.launch(confirmedLaunchRequest(prepared, { decision: "decline" })),
    {
      schema: "flow.rejection/v1",
      operation: "launch",
      code: "confirmation_declined",
      reason: null,
      command_type: null,
      run_id: null,
      bundle_digest: prepared.bundle_digest,
      authority_watermark: `sha256:${"0".repeat(64)}`,
      authority_watermark_domain: "host",
      legal_actions: [],
    },
  );
  assert.deepEqual(runtime.query().runs, []);

  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  const decline = waiting.legal_actions.find(({ decision }) => decision === "decline");
  const receipt = runtime.command(decline);
  const declined = runtime.query({ run_id: launch.run_id });

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.authority_watermark, declined.watermark);
  assert.equal(declined.sequence, 3);
  assert.equal(declined.phase, "declined");
  assert.deepEqual(declined.cards, [
    {
      id: "confirm-plan",
      executor_kind: "checkpoint",
      status: "declined",
    },
  ]);
  assert.deepEqual(declined.legal_actions, []);
});

test("a terminal run fences decisions on other independent checkpoints", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(independentCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const active = runtime.query({ run_id: launch.run_id });
  const decline = active.legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-plan" && decision === "decline",
  );

  runtime.command(decline);
  const terminal = runtime.query({ run_id: launch.run_id });
  const otherCard = terminal.cards.find(({ id }) => id === "confirm-scope");
  const postTerminal = runtime.command({
    schema: "flow.command/v1",
    type: "checkpoint_decision",
    run_id: launch.run_id,
    checkpoint_id: otherCard.id,
    decision: "approve",
    expected_watermark: terminal.watermark,
  });

  assert.equal(terminal.phase, "declined");
  assert.equal(otherCard.status, "pending");
  assert.deepEqual(terminal.legal_actions, []);
  assert.equal(postTerminal.code, "run_terminal");
  assert.deepEqual(postTerminal, {
    schema: "flow.rejection/v1",
    operation: "command",
    code: "run_terminal",
    reason: null,
    command_type: "checkpoint_decision",
    run_id: launch.run_id,
    bundle_digest: prepared.bundle_digest,
    authority_watermark: terminal.watermark,
    authority_watermark_domain: "run",
    legal_actions: [],
  });
  assert.equal(
    runtime.query({ run_id: launch.run_id }).watermark,
    terminal.watermark,
  );
});

test("dependency checkpoints expose only currently legal typed actions", () => {
  const runtime = createTestRuntime();
  const proposal = dependencyCheckpointProposal();
  const prepared = runtime.prepare(proposal);
  const equivalent = dependencyCheckpointProposal();
  equivalent.graph.cards.reverse();
  equivalent.graph.cards.find(({ id }) => id === "confirm-plan").dependencies.push(
    "confirm-scope",
  );
  assert.deepEqual(runtime.prepare(equivalent), prepared);

  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const first = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(first.cards, [
    { id: "confirm-plan", executor_kind: "checkpoint", status: "pending" },
    {
      id: "confirm-scope",
      executor_kind: "checkpoint",
      status: "waiting_checkpoint",
    },
  ]);
  assert.deepEqual(
    [...new Set(first.legal_actions.map(({ checkpoint_id: id }) => id))],
    ["confirm-scope"],
  );

  const premature = runtime.command({
    schema: "flow.command/v1",
    type: "checkpoint_decision",
    run_id: launch.run_id,
    checkpoint_id: "confirm-plan",
    decision: "approve",
    expected_watermark: first.watermark,
  });
  assert.equal(premature.code, "checkpoint_not_actionable");
  assert.equal(runtime.query({ run_id: launch.run_id }).watermark, first.watermark);

  runtime.command(first.legal_actions.find(({ decision }) => decision === "approve"));
  const second = runtime.query({ run_id: launch.run_id });
  assert.equal(second.sequence, 2);
  assert.equal(second.phase, "active");
  assert.deepEqual(
    [...new Set(second.legal_actions.map(({ checkpoint_id: id }) => id))],
    ["confirm-plan"],
  );

  runtime.command(second.legal_actions.find(({ decision }) => decision === "approve"));
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.sequence, 4);
  assert.equal(completed.phase, "succeeded");
  assert.deepEqual(completed.cards.map(({ status }) => status), [
    "completed",
    "completed",
  ]);
});

test("unknown run operations return typed machine-readable outcomes", async () => {
  const runtime = createTestRuntime();
  const runId = `run:${"0".repeat(64)}`;
  const watermark = `sha256:${"0".repeat(64)}`;
  const commandRejection = runtime.command({
    schema: "flow.command/v1",
    type: "checkpoint_decision",
    run_id: runId,
    checkpoint_id: "missing",
    decision: "approve",
    expected_watermark: watermark,
  });
  assert.deepEqual(commandRejection, {
    schema: "flow.rejection/v1",
    operation: "command",
    code: "unknown_run",
    reason: null,
    command_type: "checkpoint_decision",
    run_id: runId,
    bundle_digest: null,
    authority_watermark: watermark,
    authority_watermark_domain: "host",
    legal_actions: [],
  });
  assert.deepEqual(runtime.query({ run_id: runId }), {
    schema: "flow.rejection/v1",
    operation: "query",
    code: "unknown_run",
    reason: null,
    command_type: null,
    run_id: runId,
    bundle_digest: null,
    authority_watermark: watermark,
    authority_watermark_domain: "host",
    legal_actions: [],
  });

  const iterator = runtime.watch()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      schema: "flow.rejection/v1",
      operation: "watch",
      code: "unknown_run",
      reason: null,
      command_type: null,
      run_id: null,
      bundle_digest: null,
      authority_watermark: watermark,
      authority_watermark_domain: "host",
      legal_actions: [],
    },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("generic lifecycle controls are rejected without mutating authority", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const { run_id: runId } = runtime.launch(confirmedLaunchRequest(prepared));
  const before = runtime.query({ run_id: runId });

  for (const commandType of [
    "generic_setter",
    "force_unlock",
    "generic_unblock",
    "timer_lease_takeover",
  ]) {
    assert.deepEqual(runtime.command({
      schema: "flow.command/v1",
      type: commandType,
      run_id: runId,
      expected_watermark: before.watermark,
    }), {
      schema: "flow.rejection/v1",
      operation: "command",
      code: "forbidden_command",
      reason: null,
      command_type: commandType,
      run_id: runId,
      bundle_digest: prepared.bundle_digest,
      authority_watermark: before.watermark,
      authority_watermark_domain: "run",
      legal_actions: before.legal_actions,
    });
  }

  assert.deepEqual(runtime.query({ run_id: runId }), before);
});

test("watch streams the current and next watermarked authority projections", async () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const iterator = runtime.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  const current = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(await iterator.next(), { done: false, value: current });

  const update = iterator.next();
  runtime.command(current.legal_actions[0]);
  const completed = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(await update, { done: false, value: completed });
  assert.equal(completed.phase, "succeeded");
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
});

function createTestRuntime(options = {}) {
  return createFlowRuntime({
    ...options,
    runAuthority: createInMemoryRunAuthority(),
  });
}

function rebindPreparedIdentity(prepared) {
  prepared.plan_fingerprint = digest(prepared.graph);
  prepared.bundle_digest = digest({
    schema: "flow.prepared-bundle/v1",
    kind: prepared.kind,
    graph: prepared.graph,
    plan_fingerprint: prepared.plan_fingerprint,
    requested_authority: prepared.requested_authority,
    explicit_facts: prepared.explicit_facts,
  });
  prepared.confirmation = {
    schema: "flow.dynamic-plan-confirmation/v1",
    bundle_digest: prepared.bundle_digest,
    graph: prepared.graph,
    requested_authority: prepared.requested_authority,
    explicit_facts: prepared.explicit_facts,
  };
  prepared.confirmation_digest = digest(prepared.confirmation);
}

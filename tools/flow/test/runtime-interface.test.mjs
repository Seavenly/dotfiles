import assert from "node:assert/strict";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { compileDynamicPlan } from "../src/plan-compiler.mjs";
import { createInMemoryRunAuthority } from "../src/run-authority.mjs";
import { dynamicCheckpointProposal } from "../test-support/dynamic-checkpoint.mjs";

test("prepare returns an immutable content-addressed dynamic graph without creating a run", () => {
  const runtime = createTestRuntime();
  const request = dynamicCheckpointProposal();

  const prepared = runtime.prepare(request);

  assert.equal(prepared.schema, "flow.prepared-run/v1");
  assert.equal(prepared.kind, "dynamic");
  assert.match(prepared.bundle_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(prepared.plan_fingerprint, /^sha256:[0-9a-f]{64}$/);
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
  const launchRequest = {
    prepared,
    confirmation: prepared.confirmation,
    closed_facts: prepared.explicit_facts,
  };

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
  assert.throws(
    () => runtime.launch({ ...launchRequest, prepared: tampered }),
    /prepared (?:plan fingerprint|bundle digest) mismatch/,
  );
  assert.throws(
    () => runtime.launch({
      ...launchRequest,
      closed_facts: {
        ...prepared.explicit_facts,
        catalog_fingerprint: `sha256:${"8".repeat(64)}`,
      },
    }),
    /closed identity facts differ from the prepared bundle/,
  );

  const forgedConfirmation = structuredClone(prepared);
  forgedConfirmation.confirmation.graph.cards[0].id = "operator-saw-another-plan";
  assert.throws(
    () => runtime.launch({
      prepared: forgedConfirmation,
      confirmation: forgedConfirmation.confirmation,
      closed_facts: forgedConfirmation.explicit_facts,
    }),
    /prepared confirmation is not bound to the bundle/,
  );
});

test("separate runtime interfaces share host launch idempotency", () => {
  const firstRuntime = createFlowRuntime();
  const secondRuntime = createFlowRuntime();
  const request = dynamicCheckpointProposal();
  request.explicit_facts.catalog_fingerprint = `sha256:${"7".repeat(64)}`;
  const prepared = firstRuntime.prepare(request);
  const launchRequest = {
    prepared,
    confirmation: prepared.confirmation,
    closed_facts: prepared.explicit_facts,
  };

  const created = firstRuntime.launch(launchRequest);
  const adopted = secondRuntime.launch(launchRequest);

  assert.equal(created.created, true);
  assert.deepEqual(adopted, { ...created, created: false });
});

test("a typed checkpoint command completes the authority-derived run", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const launch = runtime.launch({
    prepared,
    confirmation: prepared.confirmation,
    closed_facts: prepared.explicit_facts,
  });

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

test("generic lifecycle controls are rejected without mutating authority", () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const { run_id: runId } = runtime.launch({
    prepared,
    confirmation: prepared.confirmation,
    closed_facts: prepared.explicit_facts,
  });
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
      code: "forbidden_command",
      command_type: commandType,
      run_id: runId,
      authority_watermark: before.watermark,
      legal_actions: before.legal_actions,
    });
  }

  assert.deepEqual(runtime.query({ run_id: runId }), before);
});

test("watch streams the current and next watermarked authority projections", async () => {
  const runtime = createTestRuntime();
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const launch = runtime.launch({
    prepared,
    confirmation: prepared.confirmation,
    closed_facts: prepared.explicit_facts,
  });
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

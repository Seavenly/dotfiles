import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { confirmedLaunchRequest, dynamicCheckpointProposal } from
  "../test-support/dynamic-checkpoint.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";

test("cancellation irreversibly stops new admission", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cancel-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const proposal = dynamicCheckpointProposal();
  proposal.requested_authority.commands.push("cancel");
  proposal.explicit_facts.resource_claims.push({
    kind: "workspace",
    id: "cancelled-before-use",
  });
  proposal.explicit_facts.limits.max_resources = 1;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const active = runtime.query({ run_id: launch.run_id });
  const cancel = active.legal_actions.find(({ type }) => type === "cancel");

  assert.deepEqual(cancel, {
    schema: "flow.command/v1",
    type: "cancel",
    run_id: launch.run_id,
    expected_watermark: active.watermark,
  });
  const receipt = runtime.command(cancel);
  const cancelled = runtime.query({ run_id: launch.run_id });

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.command_type, "cancel");
  assert.equal(receipt.authority_watermark, cancelled.watermark);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.progress, "complete");
  assert.deepEqual(cancelled.cards, [{
    id: "confirm-plan",
    executor_kind: "checkpoint",
    status: "abandoned",
  }]);
  assert.deepEqual(cancelled.legal_actions, []);
  assert.deepEqual(cancelled.resource_dispositions, [{
    claim: { kind: "workspace", id: "cancelled-before-use" },
    disposition: "released",
  }]);
  assert.equal(runtime.query().admission.active_runs, 0);

  const repeated = runtime.command(cancel);
  assert.equal(repeated.code, "stale_authority_watermark");
  assert.deepEqual(repeated.legal_actions, []);
  const forgedAdvance = runtime.command({
    ...active.legal_actions.find(({ type }) => type === "checkpoint_decision"),
    expected_watermark: cancelled.watermark,
  });
  assert.equal(forgedAdvance.code, "run_terminal");
  assert.deepEqual(runtime.query({ run_id: launch.run_id }), cancelled);
});

test("cancellation fences an operation before Adapter admission", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cancel-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invocationCount += 1;
          return operationReceipt(intent);
        },
      },
    },
  });
  const proposal = registeredOperationProposal();
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const intentCommitted = runtime.query({ run_id: launch.run_id });
  runtime.command(intentCommitted.legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = runtime.query({ run_id: launch.run_id });

  assert.equal(invocationCount, 0);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.effects[0].status, "abandoned");
  assert.equal(cancelled.effects[0].disposition, "quarantined");
  assert.equal(cancelled.attempts[0].status, "abandoned");
  assert.deepEqual(cancelled.resource_dispositions, [{
    claim: { kind: "test-record", id: "outcome" },
    disposition: "quarantined",
  }]);
  assert.deepEqual(cancelled.legal_actions, []);
});

test("a late operation result after cancellation remains quarantined evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cancel-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let settle;
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          return new Promise((resolve) => {
            settle = () => resolve(operationReceipt(intent, {
              record: "arrived-after-cancellation",
            }));
          });
        },
      },
    },
  });
  const proposal = registeredOperationProposal();
  proposal.requested_authority.commands.push("cancel");
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "accept-result",
    dependencies: ["record-outcome"],
    inputs: { prompt: "Accept the operation result" },
  });
  proposal.explicit_facts.limits.max_cards = 3;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type, decision }) => type === "checkpoint_decision" &&
      decision === "approve",
  ));
  await until(() => typeof settle === "function");

  const executing = runtime.query({ run_id: launch.run_id });
  const cancel = executing.legal_actions.find(({ type }) => type === "cancel");
  assert.ok(cancel);
  runtime.command(cancel);
  const cancelled = runtime.query({ run_id: launch.run_id });

  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.cards.find(({ id }) => id === "record-outcome").status,
    "abandoned");
  assert.deepEqual(cancelled.attempts, [{
    attempt_id: `${launch.run_id}:record-outcome:attempt:1`,
    card_id: "record-outcome",
    effect_id: executing.effects[0].effect_id,
    status: "abandoned",
  }]);
  assert.equal(cancelled.effects[0].status, "unresolved");
  assert.equal(cancelled.effects[0].disposition, "quarantined");
  assert.equal(runtime.query().admission.active_runs, 0);

  settle();
  await until(() => runtime.query({ run_id: launch.run_id }).effects[0].status ===
    "late_succeeded");
  const late = runtime.query({ run_id: launch.run_id });

  assert.equal(late.phase, "cancelled");
  assert.equal(late.cards.find(({ id }) => id === "record-outcome").status,
    "abandoned");
  assert.equal(late.cards.find(({ id }) => id === "accept-result").status,
    "abandoned");
  assert.equal(late.attempts[0].status, "abandoned");
  assert.equal(late.effects[0].disposition, "quarantined");
  assert.equal(late.effects[0].receipt.provider_receipt.record,
    "arrived-after-cancellation");
  assert.deepEqual(late.resource_dispositions, [{
    claim: { kind: "test-record", id: "outcome" },
    disposition: "quarantined",
  }]);
  assert.deepEqual(late.legal_actions, []);

  authority.close();
  const replayedAuthority = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => replayedAuthority.close());
  assert.deepEqual(
    replayedAuthority.query(launch.run_id),
    late,
  );
});

test("cancellation preserves evidence completed before the terminal fence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cancel-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke: operationReceipt,
      },
    },
  });
  const proposal = registeredOperationProposal();
  proposal.requested_authority.commands.push("cancel");
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "accept-result",
    dependencies: ["record-outcome"],
    inputs: { prompt: "Accept the operation result" },
  });
  proposal.explicit_facts.limits.max_cards = 3;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0]?.status === "succeeded");
  const partiallyComplete = runtime.query({ run_id: launch.run_id });
  runtime.command(partiallyComplete.legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  const cancelled = runtime.query({ run_id: launch.run_id });

  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.cards.find(({ id }) => id === "record-outcome").status,
    "completed");
  assert.equal(cancelled.cards.find(({ id }) => id === "accept-result").status,
    "abandoned");
  assert.equal(cancelled.attempts[0].status, "completed");
  assert.equal(cancelled.effects[0].status, "succeeded");
  assert.equal(cancelled.effects[0].disposition, "accepted");
  assert.deepEqual(cancelled.resource_dispositions, [{
    claim: { kind: "test-record", id: "outcome" },
    disposition: "released",
  }]);
  assert.deepEqual(cancelled.legal_actions, []);
});

test("cancelled uncertain work can only reconcile into quarantined evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cancel-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  let invokedIntent;
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "one_shot_uncertain",
        observe: () => null,
        invoke(intent) {
          invocationCount += 1;
          invokedIntent = intent;
          throw new Error("provider result was lost");
        },
      },
    },
  });
  const proposal = registeredOperationProposal({
    classification: "one_shot_uncertain",
  });
  proposal.requested_authority.commands.push("cancel");
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "cancel"));
  firstAuthority.close();

  const uncertainAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  let uncertainObservationCount = 0;
  const uncertainRuntime = createFlowRuntime({
    runAuthority: uncertainAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "one_shot_uncertain",
        invoke() {
          assert.fail("cancelled one-shot work must never be invoked again");
        },
        observe(intent) {
          uncertainObservationCount += 1;
          return {
            schema: "flow.effect-observation/v1",
            effect_id: intent.effect_id,
            idempotency_key: intent.idempotency_key,
            presence: "indeterminate",
            causation: null,
            provider_observation: { timeout: true },
          };
        },
      },
    },
  });
  uncertainRuntime.command(uncertainRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery"));
  await until(() => uncertainObservationCount === 1);
  const uncertain = uncertainRuntime.query({ run_id: launch.run_id });
  assert.equal(uncertain.effects[0].status, "uncertain");
  assert.equal(uncertain.effects[0].disposition, "quarantined");
  assert.equal(uncertain.legal_actions[0].recovery, "settle_cancelled");
  uncertainAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-c"),
  });
  t.after(() => recoveredAuthority.close());
  let observationCount = 0;
  const recoveredRuntime = createFlowRuntime({
    runAuthority: recoveredAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "one_shot_uncertain",
        invoke() {
          invocationCount += 1;
          assert.fail("cancelled work must never be invoked again");
        },
        observe(intent) {
          observationCount += 1;
          return {
            schema: "flow.effect-observation/v1",
            effect_id: intent.effect_id,
            idempotency_key: intent.idempotency_key,
            presence: "present",
            causation: {
              effect_id: invokedIntent.effect_id,
              idempotency_key: invokedIntent.idempotency_key,
            },
            provider_observation: { record: "found-after-cancellation" },
          };
        },
      },
    },
  });
  const cancelled = recoveredRuntime.query({ run_id: launch.run_id });
  const settlement = cancelled.legal_actions.find(
    ({ type }) => type === "recovery",
  );

  assert.equal(cancelled.phase, "cancelled");
  assert.equal(settlement.recovery, "settle_cancelled");
  assert.equal(recoveredRuntime.command(settlement).accepted, true);
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].status === "late_succeeded");
  const settled = recoveredRuntime.query({ run_id: launch.run_id });

  assert.equal(invocationCount, 1);
  assert.equal(observationCount, 1);
  assert.equal(settled.phase, "cancelled");
  assert.equal(settled.cards.find(({ id }) => id === "record-outcome").status,
    "abandoned");
  assert.equal(settled.attempts[0].status, "abandoned");
  assert.equal(settled.effects[0].status, "late_succeeded");
  assert.equal(settled.effects[0].disposition, "quarantined");
  assert.deepEqual(settled.resource_dispositions, [{
    claim: { kind: "test-record", id: "outcome" },
    disposition: "quarantined",
  }]);
  assert.deepEqual(settled.legal_actions, []);
});

test("cancellation is rolled back before commit and adopted after commit", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-cancel-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const beforeAuthority = createDurableRunAuthority({
    authorityDirectory,
    beforeCancellationCommit(boundary) {
      assert.equal(boundary.schema, "flow.cancellation-commit-boundary/v1");
      throw new Error("injected failure before cancellation commit");
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const beforeRuntime = createFlowRuntime({ runAuthority: beforeAuthority });
  const proposal = dynamicCheckpointProposal();
  proposal.requested_authority.commands.push("cancel");
  const prepared = beforeRuntime.prepare(proposal);
  const launch = beforeRuntime.launch(confirmedLaunchRequest(prepared));
  const active = beforeRuntime.query({ run_id: launch.run_id });

  assert.throws(
    () => beforeRuntime.command(active.legal_actions.find(
      ({ type }) => type === "cancel",
    )),
    /injected failure before cancellation commit/,
  );
  assert.deepEqual(beforeRuntime.query({ run_id: launch.run_id }), active);
  assert.equal(beforeRuntime.query().admission.active_runs, 1);
  beforeAuthority.close();

  const afterAuthority = createDurableRunAuthority({
    authorityDirectory,
    afterCancellationCommit(boundary) {
      assert.equal(boundary.run_id, launch.run_id);
      throw new Error("injected failure after cancellation commit");
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  const afterRuntime = createFlowRuntime({ runAuthority: afterAuthority });
  const replayedActive = afterRuntime.query({ run_id: launch.run_id });

  assert.throws(
    () => afterRuntime.command(replayedActive.legal_actions.find(
      ({ type }) => type === "cancel",
    )),
    /injected failure after cancellation commit/,
  );
  const committed = afterRuntime.query({ run_id: launch.run_id });
  assert.equal(committed.phase, "cancelled");
  assert.deepEqual(committed.legal_actions, []);
  assert.equal(afterRuntime.query().admission.active_runs, 0);
  afterAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-c"),
  });
  t.after(() => recoveredAuthority.close());
  assert.deepEqual(recoveredAuthority.query(launch.run_id), committed);
});

function fixedHostIdentity(bootId, processIdentity) {
  return {
    observe() {
      return {
        schema: "flow.host-authority-identity/v1",
        boot_id: bootId,
        process_identity: processIdentity,
      };
    },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

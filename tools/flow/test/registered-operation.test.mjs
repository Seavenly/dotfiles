import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { confirmedLaunchRequest } from "../test-support/dynamic-checkpoint.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";

test("a registered caller-idempotent operation executes from committed intent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invokedIntent;
  let projectionAtInvocation;
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invokedIntent = intent;
          projectionAtInvocation = runtime.query({ run_id: intent.run_id });
          return operationReceipt(intent);
        },
      },
    },
  });
  const proposal = registeredOperationProposal();
  proposal.explicit_facts.resource_claims.push({
    kind: "test-record",
    id: "unrelated",
  });
  proposal.explicit_facts.limits.max_resources = 2;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(waiting.cards, [
    { id: "confirm-plan", executor_kind: "checkpoint", status: "waiting_checkpoint" },
    { id: "record-outcome", executor_kind: "operation", status: "pending" },
  ]);
  const commandReceipt = runtime.command(
    waiting.legal_actions.find(({ decision }) => decision === "approve"),
  );
  assert.equal(commandReceipt.accepted, true);
  assert.equal(commandReceipt.effect_intents.length, 1);

  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(invokedIntent.effect_id, commandReceipt.effect_intents[0].effect_id);
  assert.equal(projectionAtInvocation.effects[0].status, "unresolved");
  assert.equal(projectionAtInvocation.phase, "active");
  assert.equal(invokedIntent.idempotency_key,
    commandReceipt.effect_intents[0].idempotency_key);
  assert.equal(invokedIntent.attempt_id, `${launch.run_id}:record-outcome:attempt:1`);
  assert.deepEqual(invokedIntent.route_binding, {
    adapter: "conformance-recorder",
  });
  assert.deepEqual(invokedIntent.resource_claims, [{
    kind: "test-record",
    id: "outcome",
  }]);
  assert.equal(completed.phase, "succeeded");
  assert.equal(completed.cards[1].status, "completed");
  assert.equal(completed.effects[0].status, "succeeded");
  assert.deepEqual(completed.legal_actions, []);
});

test("safe effect classes execute without an unrelated human checkpoint", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const execution = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );

  assert.equal(runtime.command(execution).accepted, true);
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 1);
});

test("caller-idempotent recovery repeats only the committed identity", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const attemptedKeys = [];
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      attemptedKeys.push(intent.idempotency_key);
      throw new Error("receipt lost after provider mutation");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal());
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  const waiting = firstRuntime.query({ run_id: launch.run_id });
  firstRuntime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await until(() => attemptedKeys.length === 1);
  const unresolved = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(unresolved.effects[0].status, "unresolved");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "caller_idempotent",
    invoke(intent) {
      attemptedKeys.push(intent.idempotency_key);
      return operationReceipt(intent, { adopted: true });
    },
  });
  const recovery = recoveredRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery");

  assert.equal(recovery.effect_id, unresolved.effects[0].effect_id);
  const receipt = recoveredRuntime.command(recovery);
  assert.equal(receipt.accepted, true);
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.deepEqual(attemptedKeys, [attemptedKeys[0], attemptedKeys[0]]);
});

test("read-only recovery repeats the exact committed observation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const observedKeys = [];
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "read_only",
    invoke(intent) {
      observedKeys.push(intent.idempotency_key);
      throw new Error("observation response lost");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "read_only",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => observedKeys.length === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "read_only",
    invoke(intent) {
      observedKeys.push(intent.idempotency_key);
      return operationReceipt(intent, { observation: "current" });
    },
  });
  recoveredRuntime.command(recoveredRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery"));
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.deepEqual(observedKeys, [observedKeys[0], observedKeys[0]]);
});

test("reconcilable recovery adopts exact positive causation without reinvocation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let providerMutations = 0;
  let originalIntent;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke(intent) {
      providerMutations += 1;
      originalIntent = intent;
      throw new Error("receipt lost after provider mutation");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => providerMutations === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    invoke() {
      providerMutations += 1;
      assert.fail("a positively observed effect must not be invoked again");
    },
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "present",
        causation: {
          effect_id: originalIntent.effect_id,
          idempotency_key: originalIntent.idempotency_key,
        },
        provider_observation: { record: "accepted" },
      };
    },
  });
  const recovery = recoveredRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery");

  recoveredRuntime.command(recovery);
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const reconciled = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(providerMutations, 1);
  assert.equal(reconciled.effects[0].receipt.provider_receipt.record, "accepted");
});

test("reconcilable recovery invokes only after proven absence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let initialIntent;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke(intent) {
      initialIntent = intent;
      throw new Error("process stopped before invocation was observed");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => initialIntent !== undefined);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const order = [];
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    observe(intent) {
      order.push("observe");
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: { found: false },
      };
    },
    invoke(intent) {
      order.push("invoke");
      assert.equal(intent.effect_id, initialIntent.effect_id);
      assert.equal(intent.idempotency_key, initialIntent.idempotency_key);
      return operationReceipt(intent);
    },
  });
  recoveredRuntime.command(recoveredRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery"));
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.deepEqual(order, ["observe", "invoke"]);
});

test("reconcilable recovery rejects absence without affirmative evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "reconcilable",
    observe: indeterminateObservation,
    invoke() {
      invocationCount += 1;
      throw new Error("receipt lost");
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "reconcilable",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "reconcilable",
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: null,
      };
    },
    invoke() {
      invocationCount += 1;
      assert.fail("absence without evidence must not authorize invocation");
    },
  });
  recoveredRuntime.command(recoveredRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery"));
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].last_observation !== null);

  const unresolved = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 1);
  assert.equal(unresolved.effects[0].last_observation.presence, "indeterminate");
  assert.equal(unresolved.effects[0].status, "reconciling");
});

test("a one-shot uncertain effect is checkpoint-bound and never retried", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  let invocationCount = 0;
  const firstRuntime = operationRuntime(firstAuthority, {
    classification: "one_shot_uncertain",
    observe: indeterminateObservation,
    invoke() {
      invocationCount += 1;
      throw new Error("one-shot result is uncertain");
    },
  });
  const proposal = registeredOperationProposal({
    classification: "one_shot_uncertain",
  });
  const unbound = structuredClone(proposal);
  delete unbound.graph.cards[0].inputs.operation_card_id;
  assert.throws(
    () => firstRuntime.prepare(unbound),
    /one-shot operation requires one exact operation-bound checkpoint/,
  );
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = operationRuntime(recoveredAuthority, {
    classification: "one_shot_uncertain",
    invoke() {
      invocationCount += 1;
      assert.fail("one-shot effect must never be retried automatically");
    },
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: { found: false },
      };
    },
  });
  recoveredRuntime.command(recoveredRuntime.query({ run_id: launch.run_id })
    .legal_actions.find(({ type }) => type === "recovery"));
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects[0].status === "uncertain");
  const uncertain = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 1);
  assert.equal(uncertain.phase, "active");
  assert.equal(uncertain.effects[0].last_observation.presence, "absent");
});

test("a checkpoint-bound operation rejects additional dependencies", () => {
  const runtime = operationRuntime(createNoopAuthority(), {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal();
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "other-confirmation",
    inputs: {},
  });
  proposal.graph.cards.find(({ id }) => id === "record-outcome")
    .dependencies.push("other-confirmation");
  proposal.explicit_facts.limits.max_cards = 3;

  assert.throws(
    () => runtime.prepare(proposal),
    /checkpoint-bound operation requires one exact dependency/,
  );
});

test("prepare rejects operation resource claims absent from prepared facts", () => {
  const runtime = operationRuntime(createNoopAuthority(), {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal();
  proposal.explicit_facts.resource_claims = [];

  assert.throws(
    () => runtime.prepare(proposal),
    /operation resource claim is outside the prepared facts/,
  );
});

test("a negative provider receipt leaves the exact effect unresolved", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      invocationCount += 1;
      return {
        ...operationReceipt(intent),
        outcome: "absent",
      };
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  await until(() => invocationCount === 1);
  const unresolved = runtime.query({ run_id: launch.run_id });

  assert.equal(unresolved.effects[0].status, "unresolved");
  assert.deepEqual(unresolved.effects[0].receipt, null);
  assert.equal(unresolved.legal_actions.filter(
    ({ type }) => type === "recovery",
  ).length, 1);
});

test("a crash before intent commit authorizes no operation effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    beforeIntentCommit() {
      throw new Error("injected crash before intent commit");
    },
  });
  t.after(() => authority.close());
  let invocationCount = 0;
  const runtime = operationRuntime(authority, {
    classification: "read_only",
    invoke(intent) {
      invocationCount += 1;
      return operationReceipt(intent);
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({
    classification: "read_only",
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  assert.throws(
    () => runtime.command(waiting.legal_actions.find(
      ({ decision }) => decision === "approve",
    )),
    /injected crash before intent commit/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invocationCount, 0);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).effects, []);
});

test("operation settlement does not terminate a graph with pending work", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const proposal = registeredOperationProposal();
  proposal.graph.cards.push({
    ...structuredClone(proposal.graph.cards[0]),
    id: "final-confirmation",
    inputs: {},
    dependencies: ["record-outcome"],
  });
  proposal.explicit_facts.limits.max_cards = 3;
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-plan" && decision === "approve",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0]?.status === "succeeded");

  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(projection.phase, "active");
  assert.equal(projection.cards.find(({ id }) => id === "final-confirmation").status,
    "waiting_checkpoint");
  assert.equal(projection.legal_actions.some(({ checkpoint_id: checkpointId }) =>
    checkpointId === "final-confirmation"), true);
});

test("launch rejects an operation whose adapter is not registered", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const preparingRuntime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  });
  const prepared = preparingRuntime.prepare(registeredOperationProposal());
  const unregisteredRuntime = createFlowRuntime({ runAuthority: authority });

  const rejection = unregisteredRuntime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "unregistered_operation_contract");
  assert.deepEqual(unregisteredRuntime.query().runs, []);
});

test("prepare rejects incomplete operation adapter registrations", () => {
  for (const registration of [
    { classification: "caller_idempotent" },
    { classification: "reconcilable", invoke() {} },
  ]) {
    const runtime = operationRuntime(createNoopAuthority(), registration);
    assert.throws(
      () => runtime.prepare(registeredOperationProposal({
        classification: registration.classification,
      })),
      /operation adapter registration is incomplete/,
    );
  }
});

test("operation launch requires durable effect authority", () => {
  const registration = {
    classification: "caller_idempotent",
    invoke(intent) { return operationReceipt(intent); },
  };
  const runtime = operationRuntime(createNoopAuthority(), registration);
  const prepared = runtime.prepare(registeredOperationProposal());

  const rejection = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejection.code, "durable_authority_required");
});

test("watch publishes intent commitment and receipt settlement", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-operation-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let settle;
  const runtime = operationRuntime(authority, {
    classification: "caller_idempotent",
    invoke(intent) {
      return new Promise((resolve) => {
        settle = () => resolve(operationReceipt(intent));
      });
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const watcher = runtime.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  const waiting = (await watcher.next()).value;
  const intentUpdate = watcher.next();
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const executing = (await intentUpdate).value;
  assert.equal(executing.effects[0].status, "unresolved");

  const receiptUpdate = watcher.next();
  settle();
  const completed = await withTimeout(receiptUpdate, 1_000);
  assert.equal(completed.value.effects[0].status, "succeeded");
  assert.equal(completed.value.phase, "succeeded");
  await watcher.return();
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

function operationRuntime(runAuthority, registration) {
  return createFlowRuntime({
    runAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: registration,
    },
  });
}

function createNoopAuthority() {
  return {
    launch() {},
    command() {},
    query() {
      return { watermark: `sha256:${"0".repeat(64)}` };
    },
    watch() {},
  };
}

function indeterminateObservation(intent) {
  return {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "indeterminate",
    causation: null,
    provider_observation: null,
  };
}

async function until(condition) {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

function withTimeout(promise, milliseconds) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("timed out waiting for watch update")),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

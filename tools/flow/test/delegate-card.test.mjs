import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  delegateCompatibilityIssue,
  snapshotRequiredDrovrFeatures,
} from "../src/delegate-effects.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import {
  capabilityBlockedDelegateProposal,
  completedTurnProjection,
  DELEGATE_OUTPUT_VALIDATOR,
  delegateCardProposal,
} from "../test-support/delegate-card.mjs";
import { supportedDescription } from
  "../test-support/delegated-agent-description.mjs";
import { confirmedLaunchRequest } from
  "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from
  "../test-support/fixed-host-identity.mjs";

test("FlowRuntime executes one exact delegate card from reserved authority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const calls = [];
  let projectionAtDiscovery;
  const delegatedAgentPort = {
    contract: "flow.delegated-agent-port/v1",
    ...completePortOperations(calls),
    async discover(request) {
      calls.push(["discover", request]);
      projectionAtDiscovery = runtime.query({ run_id: launch.run_id });
      return absentDiscovery();
    },
    async dispatch(request) {
      calls.push(["dispatch", request]);
      return workingProjection(request);
    },
    async wait(request) {
      calls.push(["wait", request]);
      return completedTurnProjection({
        callerKey: calls[0][1].caller_key,
        description,
      });
    },
  };
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort,
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate(output) {
          return output === "accepted output";
        },
      },
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });

  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const ready = runtime.query({ run_id: launch.run_id });
  const execute = ready.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  );
  const receipt = runtime.command(execute);

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.effect_intents.length, 1);
  assert.equal(receipt.effect_intents[0].attempt_id,
    `${launch.run_id}:delegate-review:attempt:1`);
  assert.deepEqual(receipt.effect_intents[0].route_binding,
    prepared.graph.cards[1].route);
  assert.equal(receipt.effect_intents[0].terminal_disposition_policy.schema,
    "flow.delegate-terminal-disposition-policy/v1");
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.deepEqual(calls.map(([operation]) => operation), [
    "discover",
    "dispatch",
    "wait",
    "retire",
  ]);
  const callerKey =
    `${launch.run_id}:delegate-review:attempt:1`;
  assert.equal(calls[0][1].caller_key, callerKey);
  assert.equal(calls[1][1].caller_key, callerKey);
  assert.equal(calls[1][1].input_key, `${callerKey}:input:1`);
  assert.equal(projectionAtDiscovery.cards[1].status, "executing");
  assert.equal(projectionAtDiscovery.delegate_attempts[0].status, "reserved");
  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.delegate_attempts[0].status, "accepted");
  assert.equal(completed.delegate_attempts[0].validated_output,
    "accepted output");
  assert.equal(completed.delegate_attempts[0].evidence
    .terminal_disposition.status, "retired");
  assert.deepEqual(completed.quarantined_delegate_outputs, []);
  assert.deepEqual(completed.legal_actions, []);
});

test("delegate recovery discovers the reserved attempt before dispatch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const description = await compatibleDescription();
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstCalls = [];
  const firstRuntime = delegateRuntime(firstAuthority, {
    async discover(request) {
      firstCalls.push(request);
      throw new Error("process exited after intent commit");
    },
  });
  const prepared = firstRuntime.prepare(delegateCardProposal(description));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(firstRuntime, launch.run_id);
  await until(() => firstCalls.length === 1);
  const unresolved = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(unresolved.delegate_attempts[0].status, "reserved");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredCalls = [];
  const recoveredRuntime = delegateRuntime(recoveredAuthority, {
    async discover(request) {
      recoveredCalls.push(["discover", request]);
      return completedTurnProjection({
        callerKey: request.caller_key,
        description,
      });
    },
    async dispatch() {
      recoveredCalls.push(["dispatch"]);
      assert.fail("recovery must adopt the discovered exact turn");
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.deepEqual(recoveredCalls.map(([operation]) => operation), ["discover"]);
  assert.equal(recoveredCalls[0][1].caller_key,
    `${launch.run_id}:delegate-review:attempt:1`);
  assert.equal(recoveredRuntime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status, "accepted");
});

test("delegate recovery settles retirement before accepting output", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let discoverCalls = 0;
  let dispatchCalls = 0;
  let retireCalls = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      discoverCalls += 1;
      return discoverCalls === 1
        ? absentDiscovery()
        : completedTurnProjection({ callerKey: request.caller_key, description });
    },
    async dispatch(request) {
      dispatchCalls += 1;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
    async retire(request) {
      retireCalls += 1;
      if (retireCalls === 1) throw new Error("retirement unavailable");
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => retireCalls === 1);

  const unresolved = runtime.query({ run_id: launch.run_id });
  assert.equal(unresolved.delegate_attempts[0].status, "reserved");
  runtime.command(unresolved.legal_actions.find(
    ({ type }) => type === "recovery",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.equal(dispatchCalls, 1);
  assert.equal(discoverCalls, 2);
  assert.equal(retireCalls, 2);
});

test("bounded wait recovery preserves one live attempt without cancellation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const calls = [];
  let discovery = 0;
  let waits = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      calls.push("discover");
      discovery += 1;
      return discovery === 1
        ? absentDiscovery()
        : workingProjection({
            agent_id: "agent:delegate-review",
            caller_key: request.caller_key,
          });
    },
    async dispatch(request) {
      calls.push("dispatch");
      return workingProjection(request);
    },
    async wait() {
      calls.push("wait");
      waits += 1;
      if (waits === 1) return stillWorkingProjection();
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
    async cancel() {
      calls.push("cancel");
      assert.fail("bounded wait recovery must not cancel live work");
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => waits === 1);

  const unresolved = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(unresolved.delegate_attempts.map(({ status }) => status), [
    "reserved",
  ]);
  assert.deepEqual(unresolved.quarantined_delegate_outputs, []);
  assert.deepEqual(unresolved.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
  const attemptId = unresolved.delegate_attempts[0].attempt_id;
  runtime.command(unresolved.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.equal(completed.delegate_attempts.length, 1);
  assert.equal(completed.delegate_attempts[0].attempt_id, attemptId);
  assert.equal(calls.filter((operation) => operation === "dispatch").length, 1);
  assert.equal(calls.includes("cancel"), false);
});

for (const status of ["needs_input", "cancelled"]) {
  test(`${status} delegate result is quarantined as a terminal attempt`, async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${status}`),
    });
    t.after(() => authority.close());
    const description = await compatibleDescription();
    const runtime = delegateRuntime(authority, {
      async wait() {
        const projection = completedTurnProjection({
          callerKey: runtime.query({ run_id: launch.run_id })
            .delegate_attempts[0].caller_key,
          description,
        });
        projection.status = status;
        projection.turn.status = status === "needs_input" ? "working" : status;
        delete projection.turn.result;
        return projection;
      },
    });
    const prepared = runtime.prepare(delegateCardProposal(description));
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    approveAndExecute(runtime, launch.run_id);
    await until(() => runtime.query({ run_id: launch.run_id })
      .delegate_attempts[0].status === "quarantined");

    const quarantined = runtime.query({ run_id: launch.run_id });
    assert.equal(quarantined.quarantined_delegate_outputs[0]
      .quarantine_record.quarantine_reason, "terminal_output_not_completed");
    assert.equal(quarantined.quarantined_delegate_outputs[0]
      .quarantine_record.terminal_disposition.status, "retired");
    assert.deepEqual(quarantined.legal_actions.map(({ type }) => type), [
      "terminal_disposition",
    ]);
  });
}

test("a working quarantined turn is cancelled before retry handoff", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-retry-cancel"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let attempt = 0;
  const cancellations = [];
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      attempt += 1;
      return workingProjection(request);
    },
    async wait() {
      const projection = completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts.at(-1).caller_key,
        description,
      });
      if (attempt === 1) {
        projection.status = "needs_input";
        projection.turn.status = "working";
        delete projection.turn.result;
      }
      return projection;
    },
    async cancel(request) {
      cancellations.push(request);
      return cancelledTurnProjection(request.turn_id);
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  const retryable = runtime.query({ run_id: launch.run_id });
  const disposition = retryable.quarantined_delegate_outputs[0]
    .quarantine_record.terminal_disposition;
  assert.deepEqual(cancellations, [{
    schema: "flow.delegated-agent-cancel-request/v1",
    turn_id: "turn:delegate-review",
  }]);
  assert.equal(disposition.durable_holder, "drovr.registry");
  assert.equal(disposition.turn_disposition.status, "cancelled");
  assert.deepEqual(retryable.legal_actions.map(({ type }) => type), [
    "delegate_execute",
  ]);

  runtime.command(retryable.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.equal(attempt, 2);
});

test("an observed capability block gates delegate execution", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let attempt = 0;
  let discoveries = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      discoveries += 1;
      return absentDiscovery();
    },
    async dispatch(request) {
      attempt += 1;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts.at(-1).caller_key,
        description,
        output: attempt === 1 ? "rejected output" : "accepted output",
      });
    },
  });
  const prepared = runtime.prepare(capabilityBlockedDelegateProposal(
    description,
    { maxAttempts: 2 },
  ));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const checkpoint = runtime.query({ run_id: launch.run_id }).legal_actions
    .find(({ type }) => type === "checkpoint_decision");
  runtime.command(checkpoint);
  const blocked = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(blocked.legal_actions.map(({ type }) => type), [
    "capability_grant",
  ]);
  assert.equal(discoveries, 0);
  runtime.command(blocked.legal_actions[0]);
  const ready = runtime.query({ run_id: launch.run_id });
  assert.equal(ready.cards.find(({ id }) => id === "delegate-review").status,
    "ready");
  assert.deepEqual(ready.legal_actions.map(({ type }) => type), [
    "delegate_execute",
  ]);
  runtime.command(ready.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const retryable = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(retryable.legal_actions.map(({ type }) => type), [
    "delegate_execute",
  ]);
  assert.equal(retryable.blocks[0].schema, "flow.delegate-card-block/v1");
  runtime.command(retryable.legal_actions[0]);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
});

test("late delegate output stays correlated and quarantined before a bounded retry", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let attempt = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      attempt += 1;
      return workingProjection(request);
    },
    async wait() {
      const callerKey = runtime.query({ run_id: launch.run_id })
        .delegate_attempts.at(-1).caller_key;
      const projection = completedTurnProjection({ callerKey, description });
      if (attempt === 1) {
        projection.status = "interrupted";
        projection.turn.status = "interrupted";
        projection.turn.late_result = {
          turn_id: projection.turn.id,
          disposition: "quarantined",
          proof_classification: "exact_transcript_correlation",
          text: projection.turn.result.text,
        };
        delete projection.turn.result;
        projection.turn.settlement_proof.classification =
          "interruption_unconfirmed";
        projection.turn.settlement_proof.ordered_inputs[0].delivery_proof =
          "unproven";
      }
      return projection;
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const blocked = runtime.query({ run_id: launch.run_id });

  assert.equal(blocked.phase, "active");
  assert.equal(blocked.progress, "blocked");
  assert.equal(blocked.delegate_attempts[0].evidence, null);
  assert.equal(blocked.quarantined_delegate_outputs[0]
    .quarantine_record.quarantine_reason, "late_output");
  assert.equal(blocked.quarantined_delegate_outputs[0]
    .quarantine_record.correlated_output, "accepted output");
  assert.equal(blocked.quarantined_delegate_outputs[0]
    .quarantine_record.terminal_disposition.durable_holder, "drovr.registry");
  runtime.command(blocked.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const completed = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(completed.delegate_attempts.map(({ status }) => status), [
    "quarantined",
    "accepted",
  ]);
  assert.equal(completed.delegate_attempts[1].attempt_id,
    `${launch.run_id}:delegate-review:attempt:2`);
  assert.equal(completed.quarantined_delegate_outputs.length, 1);
});

test("accepted Drovr output cannot schedule cards or advance RunAuthority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      return workingProjection(request);
    },
    async wait() {
      const projection = completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
      projection.flow_events = [{ type: "run_declined" }];
      projection.scheduled_cards = [{ id: "drovr-invented-card" }];
      projection.legal_next_actions = ["advance_run"];
      return projection;
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  const projection = runtime.query({ run_id: launch.run_id });

  assert.equal(projection.phase, "succeeded");
  assert.deepEqual(projection.cards.map(({ id }) => id), [
    "confirm-plan",
    "delegate-review",
  ]);
  assert.equal(projection.delegate_attempts[0].status, "accepted");
  assert.deepEqual(projection.legal_actions, []);
});

test("incompatible Drovr lifecycle claims remain quarantined", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-boundary"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async wait() {
      const projection = completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
      projection.turn.settlement_proof.description_digest =
        `sha256:${"f".repeat(64)}`;
      projection.flow_events = [{ type: "run_succeeded" }];
      projection.scheduled_cards = [{ id: "drovr-invented-card" }];
      return projection;
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const projection = runtime.query({ run_id: launch.run_id });

  assert.equal(projection.phase, "active");
  assert.deepEqual(projection.cards.map(({ id }) => id), [
    "confirm-plan",
    "delegate-review",
  ]);
  assert.equal(projection.blocks[0].quarantine_reason,
    "incompatible_settlement_proof");
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "terminal_disposition",
  ]);
  runtime.command(projection.legal_actions[0]);
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "declined");
});

test("required feature snapshot preserves integrity and availability codes", async () => {
  const description = await compatibleDescription();
  const card = delegateCardProposal(description).graph.cards[1];
  const port = {
    contract: "flow.delegated-agent-port/v1",
    ...completePortOperations(),
    async dispatch() {},
    async discover() {},
    async wait() {},
  };
  const validators = new Map([[DELEGATE_OUTPUT_VALIDATOR, {
    validate() { return true; },
  }]]);
  const integrity = snapshotRequiredDrovrFeatures({
    loadBytes: () => Buffer.from("drifted contract"),
  });
  const unavailable = snapshotRequiredDrovrFeatures({
    loadBytes() { throw new Error("offline"); },
  });
  const malformed = snapshotRequiredDrovrFeatures({
    loadBytes: () => ({ not: "bytes" }),
  });

  assert.equal(delegateCompatibilityIssue(
    card, port, validators, integrity,
  ), "required_feature_contract_integrity_failed");
  assert.equal(delegateCompatibilityIssue(
    card, port, validators, unavailable,
  ), "required_feature_contract_unavailable");
  assert.equal(delegateCompatibilityIssue(
    card, port, validators, malformed,
  ), "required_feature_contract_unavailable");
});

test("settled output becomes evidence only after independent validation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async discover() {
      return absentDiscovery();
    },
    async dispatch(request) {
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
  }, () => false);
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");
  const projection = runtime.query({ run_id: launch.run_id });

  assert.equal(projection.phase, "active");
  assert.equal(projection.delegate_attempts[0].validated_output, null);
  assert.equal(projection.delegate_attempts[0].evidence, null);
  assert.equal(projection.quarantined_delegate_outputs[0]
    .quarantine_record.quarantine_reason, "independent_validation_failed");
  assert.deepEqual(projection.quarantined_delegate_outputs[0]
    .quarantine_record.validator_receipts, [{
      contract: DELEGATE_OUTPUT_VALIDATOR,
      accepted: false,
    }]);
});

test("missing Drovr features block launch with typed compatibility", async (t) => {
  const description = await compatibleDescription();
  description.feature_advertisement.features[0].availability = "unavailable";
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = delegateRuntime(authority, {
    async discover() {
      assert.fail("incompatible delegation must not execute");
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const rejected = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "incompatible_feature_advertisement");
  assert.equal(rejected.authority_watermark_domain, "host");
});

test("weakened required Drovr guarantees block launch", async (t) => {
  const description = await compatibleDescription();
  description.feature_advertisement.features[0].guarantees.pop();
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = delegateRuntime(authority, {});
  const prepared = runtime.prepare(delegateCardProposal(description));
  const rejected = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejected.code, "incompatible_feature_advertisement");
});

test("incomplete DelegatedAgentPort blocks launch without degraded execution", async (t) => {
  const description = await compatibleDescription();
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      async discover() {},
      async dispatch() {},
      async wait() {},
    },
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: { validate: () => true },
    },
  });

  const prepared = runtime.prepare(delegateCardProposal(description));
  const rejected = runtime.launch(confirmedLaunchRequest(prepared));

  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "delegated_agent_port_unavailable");
});

test("missing or unordered delivered input is quarantined", async (t) => {
  const description = await compatibleDescription();
  for (const inputs of [[], [{
    sequence: 2,
    caller_key: "unexpected",
    payload_sha256: digestForTest("unexpected"),
    delivery: { status: "submitted" },
  }]]) {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${inputs.length}`),
    });
    t.after(() => authority.close());
    const runtime = delegateRuntime(authority, {
      async wait() {
        const projection = completedTurnProjection({
          callerKey: runtime.query({ run_id: launch.run_id })
            .delegate_attempts[0].caller_key,
          description,
        });
        projection.turn.inputs = inputs;
        return projection;
      },
    });
    const prepared = runtime.prepare(delegateCardProposal(description));
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    approveAndExecute(runtime, launch.run_id);
    await until(() => runtime.query({ run_id: launch.run_id })
      .delegate_attempts[0].status === "quarantined");
    const quarantined = runtime.query({ run_id: launch.run_id });
    assert.equal(quarantined.delegate_attempts[0].evidence, null);
    assert.equal(quarantined.quarantined_delegate_outputs[0]
      .quarantine_record.quarantine_reason, "incompatible_ordered_inputs");
  }
});

test("a pre-approved independent fallback binds only the exact retry attempt", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-fallback"),
  });
  t.after(() => authority.close());
  const primary = await compatibleDescription();
  const fallback = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  proposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };
  const attempts = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      attempts.push(request);
      return workingProjection(request);
    },
    async wait() {
      const request = attempts.at(-1);
      const description = attempts.length === 1 ? primary : fallback;
      const projection = completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description,
        output: attempts.length === 1 ? "rejected output" : "accepted output",
      });
      return projection;
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  const retry = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "delegate_execute",
  );
  runtime.command(retry);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(attempts[0].agent_id, "agent:delegate-review");
  assert.equal(attempts[1].agent_id, "agent:delegate-review-fallback");
  assert.deepEqual(projection.delegate_attempts.map(({ route_binding }) =>
    route_binding.description_digest), [
    primary.description_digest,
    fallback.description_digest,
  ]);
});

test("prepare rejects fallback that widens the accepted authority envelope", async () => {
  const primary = await compatibleDescription();
  const fallback = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "workspace-write",
    },
    caller_metadata: { owner: "flow" },
  }, {});
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  proposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "fallback_capability_widening",
  );
});

test("prepare rejects fallback that is not independent of the failed route", async () => {
  const primary = await compatibleDescription();
  const fallback = await compatibleDescription();
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  proposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "fallback_not_independent",
  );
});

test("ordered steering caller identities are bound into settlement evidence", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-steering"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const steering = [
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "correctness",
      prompt: "prioritize correctness",
    },
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "tests",
      prompt: "then inspect test coverage",
    },
  ];
  proposal.graph.cards[1].inputs.steering = steering;
  const calls = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      calls.push(["dispatch", request]);
      return workingProjection(request);
    },
    async send(request) {
      calls.push(["send", request]);
      return workingProjection({
        agent_id: "agent:delegate-review",
        caller_key: calls[0][1].caller_key,
      });
    },
    async wait() {
      calls.push(["wait"]);
      return completedTurnProjection({
        callerKey: calls[0][1].caller_key,
        description,
        steering,
      });
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const attemptId = `${launch.run_id}:delegate-review:attempt:1`;
  assert.deepEqual(calls.map(([operation]) => operation), [
    "dispatch", "send", "send", "wait",
  ]);
  assert.deepEqual(calls.slice(1, 3).map(([, request]) => request.input_key), [
    `${attemptId}:steering:correctness`,
    `${attemptId}:steering:tests`,
  ]);
  const evidence = runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].evidence;
  assert.deepEqual(evidence.settlement_proof.ordered_inputs.map(
    ({ caller_key: callerKey }) => callerKey,
  ), [
    `${attemptId}:input:1`,
    `${attemptId}:steering:correctness`,
    `${attemptId}:steering:tests`,
  ]);
});

test("omitted or reordered steering input remains quarantined", async (t) => {
  const description = await compatibleDescription();
  const steering = [
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "correctness",
      prompt: "check correctness",
    },
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "tests",
      prompt: "check tests",
    },
  ];
  for (const mode of ["omitted", "reordered"]) {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", `process-${mode}`),
    });
    t.after(() => authority.close());
    const proposal = delegateCardProposal(description);
    proposal.graph.cards[1].inputs.steering = steering;
    let callerKey;
    const runtime = delegateRuntime(authority, {
      async dispatch(request) {
        callerKey = request.caller_key;
        return workingProjection(request);
      },
      async send() {
        return workingProjection({
          agent_id: "agent:delegate-review",
          caller_key: callerKey,
        });
      },
      async wait() {
        const projection = completedTurnProjection({
          callerKey,
          description,
          steering,
        });
        projection.turn.inputs = mode === "omitted"
          ? projection.turn.inputs.slice(0, -1)
          : [
            projection.turn.inputs[0],
            projection.turn.inputs[2],
            projection.turn.inputs[1],
          ];
        return projection;
      },
    });
    const prepared = runtime.prepare(proposal);
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    approveAndExecute(runtime, launch.run_id);
    await until(() => runtime.query({ run_id: launch.run_id })
      .delegate_attempts[0].status === "quarantined");

    assert.equal(runtime.query({ run_id: launch.run_id })
      .quarantined_delegate_outputs[0].quarantine_record.quarantine_reason,
    "incompatible_ordered_inputs");
  }
});

test("prepare rejects ambiguous steering caller identities", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  proposal.graph.cards[1].inputs.steering = [
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "focus",
      prompt: "first",
    },
    {
      schema: "flow.delegate-steering-input/v1",
      caller_id: "focus",
      prompt: "second",
    },
  ];

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "invalid_delegate_steering",
  );
});

test("declared cards reuse one exact managed agent until terminal retirement", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-reuse"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  delete second.inputs.fallback;
  second.inputs.prompt = "follow up on the accepted review";
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  const dispatches = [];
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
    async wait() {
      const request = dispatches.at(-1);
      return completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description,
        prompt: request.prompt,
      });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1", JSON.stringify(launch));
  const waiting = runtime.query({ run_id: launch.run_id });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  const afterFirst = runtime.query({ run_id: launch.run_id });

  assert.equal(retirements.length, 0);
  assert.equal(afterFirst.delegate_attempts[0].evidence
    .terminal_disposition.durable_holder, `flow.run:${launch.run_id}`);
  runtime.command(afterFirst.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  assert.deepEqual(dispatches.map(({ agent_id: agentId }) => agentId), [
    "agent:delegate-review",
    "agent:delegate-review",
  ]);
  assert.equal(retirements.length, 1);
  assert.equal(retirements[0].attempt_id,
    `${launch.run_id}:delegate-followup:attempt:1`);
});

test("cancelling between managed cards retires the held agent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  proposal.requested_authority.commands.push("cancel");
  let callerKey;
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover() {
      if (!callerKey) return absentDiscovery();
      return completedTurnProjection({ callerKey, description });
    },
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({ callerKey, description });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  const betweenCards = runtime.query({ run_id: launch.run_id });

  assert.equal(retirements.length, 0);
  runtime.command(betweenCards.legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  await until(() => retirements.length === 1);
  const cancelled = runtime.query({ run_id: launch.run_id });
  const cancellation = cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  );

  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancellation.receipt.provider_receipt
    .terminal_disposition.status, "retired");
  assert.equal(retirements[0].agent_id, "agent:delegate-review");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("cancelling a proven-absent held managed turn delegates cleanup", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-absent-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;
  proposal.requested_authority.commands.push("cancel");
  let callerKey;
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({ callerKey, description });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  await until(() => runtime.query({ run_id: launch.run_id }).effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  )?.status === "succeeded");
  const cancelled = runtime.query({ run_id: launch.run_id });
  const disposition = cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  ).receipt.provider_receipt.terminal_disposition;

  assert.equal(retirements.length, 0);
  assert.equal(disposition.durable_holder, "drovr.registry");
  assert.equal(cancelled.phase, "cancelled");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("declining between managed cards retires the held agent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-declined-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const decisionCheckpoint = structuredClone(proposal.graph.cards[0]);
  decisionCheckpoint.id = "confirm-followup";
  decisionCheckpoint.dependencies = [first.id];
  decisionCheckpoint.inputs = { prompt: "Confirm the managed follow-up" };
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id, decisionCheckpoint.id];
  proposal.graph.cards.push(decisionCheckpoint, second);
  proposal.explicit_facts.limits.max_cards = 4;
  let callerKey;
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover() {
      if (!callerKey) return absentDiscovery();
      return completedTurnProjection({ callerKey, description });
    },
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return completedTurnProjection({ callerKey, description });
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === decisionCheckpoint.id).status ===
      "waiting_checkpoint");
  const awaitingDecision = runtime.query({ run_id: launch.run_id });
  runtime.command(awaitingDecision.legal_actions.find((action) =>
    action.type === "checkpoint_decision" &&
      action.checkpoint_id === decisionCheckpoint.id &&
      action.decision === "decline"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "declined");
  const declined = runtime.query({ run_id: launch.run_id });

  assert.equal(retirements.length, 1);
  assert.equal(retirements[0].agent_id, "agent:delegate-review");
  assert.equal(retirements[0].attempt_id,
    `${launch.run_id}:delegate-review:attempt:1`);
  assert.deepEqual(declined.legal_actions, []);
});

test("terminal disposition retires an agent held by the declining run", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-disposed-held-agent"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const first = proposal.graph.cards[1];
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  const rejected = structuredClone(first);
  rejected.id = "delegate-rejected";
  rejected.dependencies = [proposal.graph.cards[0].id];
  rejected.inputs.prompt = "produce a rejected result";
  delete rejected.inputs.managed_agent;
  delete rejected.inputs.fallback;
  rejected.route.agent_id = "agent:delegate-rejected";
  proposal.graph.cards.push(second, rejected);
  proposal.explicit_facts.limits.max_cards = 4;
  const dispatches = [];
  const completed = new Map();
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      return completed.get(request.caller_key) ?? absentDiscovery();
    },
    async dispatch(request) {
      dispatches.push(request);
      return workingProjection(request);
    },
    async wait() {
      const request = dispatches.at(-1);
      const projection = completedTurnProjection({
        agentId: request.agent_id,
        callerKey: request.caller_key,
        description,
        output: request.agent_id === "agent:delegate-rejected"
          ? "rejected output"
          : "accepted output",
        prompt: request.prompt,
        turnId: `turn:${request.agent_id}`,
      });
      completed.set(request.caller_key, projection);
      return projection;
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const waiting = runtime.query({ run_id: launch.run_id });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    (action) => action.type === "delegate_execute" &&
      action.card_id === first.id));
  await until(() => runtime.query({ run_id: launch.run_id })
    .cards.find(({ id }) => id === second.id).status === "ready");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    (action) => action.type === "delegate_execute" &&
      action.card_id === rejected.id));
  await until(() => runtime.query({ run_id: launch.run_id }).legal_actions.some(
    ({ type }) => type === "terminal_disposition"));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "terminal_disposition"));
  await until(() => runtime.query({ run_id: launch.run_id }).phase === "declined");

  assert.equal(retirements.filter(
    ({ agent_id: agentId }) => agentId === "agent:delegate-review",
  ).length, 1);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).legal_actions, []);
});

test("prepare rejects ambient managed-agent reuse", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  const second = structuredClone(proposal.graph.cards[1]);
  second.id = "delegate-followup";
  second.dependencies = ["delegate-review"];
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "ambient_managed_agent_reuse",
  );
});

test("prepare rejects fallback inside an immutable managed-agent binding", async () => {
  const primary = await compatibleDescription();
  const fallback = await supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "claude",
      role: "reviewer",
      model: "claude-sonnet-4-5",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
  const proposal = delegateCardProposal(primary, { maxAttempts: 2 });
  const first = proposal.graph.cards[1];
  first.inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallback,
    route: {
      agent_id: "agent:delegate-review-fallback",
      configuration_watermark: fallback.watermark.content_sha256,
      description_digest: fallback.description_digest,
      launch_comparison_key: fallback.comparison_keys.launch,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: primary.description_digest,
    },
  };
  const binding = {
    schema: "flow.managed-agent-binding/v1",
    binding_id: "managed-agent:review",
    card_ids: ["delegate-review", "delegate-followup"],
    terminal_card_id: "delegate-followup",
  };
  first.inputs.managed_agent = binding;
  const second = structuredClone(first);
  second.id = "delegate-followup";
  second.dependencies = [first.id];
  delete second.inputs.fallback;
  proposal.graph.cards.push(second);
  proposal.explicit_facts.limits.max_cards = 3;

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "invalid_managed_agent_binding",
  );
});

test("prepare rejects missing delegate authority digests", async () => {
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  delete proposal.graph.cards[1].inputs.description.comparison_keys
    .effective_authority;

  assert.throws(
    () => createFlowRuntime().prepare(proposal),
    (error) => error.reason === "invalid_delegate_binding",
  );

  const fallbackPrimary = await compatibleDescription();
  const fallbackDescription = structuredClone(fallbackPrimary);
  fallbackDescription.launch.harness = "claude";
  const fallbackProposal = delegateCardProposal(fallbackPrimary, {
    maxAttempts: 2,
  });
  fallbackProposal.graph.cards[1].inputs.fallback = {
    schema: "flow.delegate-route-fallback/v1",
    activate_for_attempt: 2,
    description: fallbackDescription,
    route: {
      agent_id: "agent:delegate-fallback",
      description_digest: fallbackDescription.description_digest,
      launch_comparison_key: fallbackDescription.comparison_keys.launch,
      configuration_watermark: fallbackDescription.watermark.content_sha256,
    },
    independent_from: {
      relation: "different_harness",
      description_digest: fallbackPrimary.description_digest,
    },
  };
  delete fallbackDescription.comparison_keys.effective_authority;

  assert.throws(
    () => createFlowRuntime().prepare(fallbackProposal),
    (error) => error.reason === "invalid_delegate_fallback",
  );
});

test("a wrong discovered agent receives no steering input", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-wrong-steering"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const proposal = delegateCardProposal(description);
  proposal.graph.cards[1].inputs.steering = [{
    schema: "flow.delegate-steering-input/v1",
    caller_id: "security",
    prompt: "inspect sensitive context",
  }];
  let sends = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      return workingProjection({
        agent_id: "agent:unexpected",
        caller_key: request.caller_key,
      });
    },
    async send() {
      sends += 1;
      assert.fail("steering must not be sent to a mismatched agent");
    },
  });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects[0]
    .status === "reconciling");

  assert.equal(sends, 0);
});

test("a result from the wrong routed agent remains quarantined", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-agent-mismatch"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  const runtime = delegateRuntime(authority, {
    async wait() {
      return completedTurnProjection({
        agentId: "agent:wrong",
        callerKey: runtime.query({ run_id: launch.run_id })
          .delegate_attempts[0].caller_key,
        description,
      });
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .delegate_attempts[0].status === "quarantined");

  assert.equal(runtime.query({ run_id: launch.run_id })
    .quarantined_delegate_outputs[0].quarantine_record.quarantine_reason,
  "incompatible_dispatch_identity");
});

test("ambiguous dispatch remains reconciling without activating fallback", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-ambiguous"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let dispatches = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "discover",
        status: "reconciling",
        watermark: absentDiscovery().watermark,
        delegation: null,
        turn: null,
        legal_next_actions: ["reconcile_exact_dispatch"],
      };
    },
    async dispatch() {
      dispatches += 1;
      assert.fail("ambiguous discovery cannot authorize dispatch or fallback");
    },
  });
  const prepared = runtime.prepare(delegateCardProposal(description, {
    maxAttempts: 2,
  }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects[0]?.status === "reconciling");

  const projection = runtime.query({ run_id: launch.run_id });
  assert.equal(dispatches, 0);
  assert.equal(projection.delegate_attempts.length, 1);
  assert.deepEqual(projection.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("cancellation closes the exact live delegate and quarantines its result", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-cancel-delegate"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let callerKey;
  let finishWait;
  const cancellations = [];
  const retirements = [];
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      if (callerKey === undefined) return absentDiscovery();
      return workingProjection({
        agent_id: "agent:delegate-review",
        caller_key: request.caller_key,
      });
    },
    async dispatch(request) {
      callerKey = request.caller_key;
      return workingProjection(request);
    },
    async wait() {
      return new Promise((resolve) => {
        finishWait = resolve;
      });
    },
    async cancel(request) {
      cancellations.push(request);
      const projection = completedTurnProjection({ callerKey, description });
      projection.status = "cancelled";
      projection.turn.status = "cancelled";
      delete projection.turn.result;
      finishWait(projection);
      return cancelledTurnProjection(request.turn_id);
    },
    async retire(request) {
      retirements.push(request);
      return completePortOperations().retire(request);
    },
  });
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => typeof finishWait === "function");
  const active = runtime.query({ run_id: launch.run_id });
  runtime.command(active.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects.find(({ effect_kind: effectKind }) => effectKind === "delegate")
    ?.status === "late_quarantined");

  const cancelled = runtime.query({ run_id: launch.run_id });
  assert.deepEqual(cancellations, [{
    schema: "flow.delegated-agent-cancel-request/v1",
    turn_id: "turn:delegate-review",
  }]);
  assert.equal(retirements.length, 1);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate",
  ).disposition, "quarantined");
  assert.equal(cancelled.quarantined_delegate_outputs[0]
    .quarantine_record.terminal_disposition.status, "retired");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("cancelled delegate settlement recovers after same-boot process loss", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-cancel-recovery"),
  });
  const description = await compatibleDescription();
  let discoveries = 0;
  const runtime = delegateRuntime(authority, {
    async discover() {
      discoveries += 1;
      if (discoveries === 1) return absentDiscovery();
      throw new Error("process exited after cancellation intent commit");
    },
    async wait() {
      return stillWorkingProjection();
    },
  });
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id })
    .effects.find(({ effect_kind: effectKind }) => effectKind === "delegate")
    ?.status === "reconciling");
  const active = runtime.query({ run_id: launch.run_id });
  runtime.command(active.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => discoveries === 2);
  authority.close();

  let callerKey;
  let cancelled = false;
  let retirements = 0;
  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-recovered"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = delegateRuntime(recoveredAuthority, {
    async discover(request) {
      callerKey = request.caller_key;
      const projection = completedTurnProjection({ callerKey, description });
      projection.operation = "discover";
      projection.status = cancelled ? "cancelled" : "working";
      projection.turn.status = cancelled ? "cancelled" : "working";
      delete projection.turn.result;
      return projection;
    },
    async cancel(request) {
      cancelled = true;
      return cancelledTurnProjection(request.turn_id);
    },
    async retire(request) {
      retirements += 1;
      return completePortOperations().retire(request);
    },
  });
  await until(() => recoveredRuntime.query({ run_id: launch.run_id })
    .effects.find(({ effect_kind: effectKind }) => effectKind === "delegate")
    ?.status === "late_quarantined");

  const awaitingSettlement = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(awaitingSettlement.phase, "cancelled");
  assert.equal(awaitingSettlement.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  ).receipt.provider_receipt.terminal_disposition.durable_holder,
  "drovr.registry");
  assert.equal(retirements, 1);
  assert.deepEqual(awaitingSettlement.legal_actions, []);
});

test("cancelled settlement rejects a discovered turn from the wrong agent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-delegate-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-wrong-cancel"),
  });
  t.after(() => authority.close());
  const description = await compatibleDescription();
  let discoveries = 0;
  let retirements = 0;
  const runtime = delegateRuntime(authority, {
    async discover(request) {
      discoveries += 1;
      if (discoveries === 1) return absentDiscovery();
      const projection = completedTurnProjection({
        agentId: "agent:unexpected",
        callerKey: request.caller_key,
        description,
      });
      projection.operation = "discover";
      projection.status = "cancelled";
      projection.turn.status = "cancelled";
      delete projection.turn.result;
      return projection;
    },
    async wait() {
      return stillWorkingProjection();
    },
    async retire(request) {
      retirements += 1;
      return completePortOperations().retire(request);
    },
  });
  const proposal = delegateCardProposal(description);
  proposal.requested_authority.commands.push("cancel");
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  approveAndExecute(runtime, launch.run_id);
  await until(() => runtime.query({ run_id: launch.run_id }).effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate",
  )?.status === "reconciling");
  const active = runtime.query({ run_id: launch.run_id });
  runtime.command(active.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => runtime.query({ run_id: launch.run_id }).effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  )?.status === "reconciling");

  const cancelled = runtime.query({ run_id: launch.run_id });
  assert.equal(retirements, 0);
  assert.equal(cancelled.legal_actions.length, 1);
  assert.equal(cancelled.legal_actions[0].effect_id, cancelled.effects.find(
    ({ effect_kind: effectKind }) => effectKind === "delegate_cancellation",
  ).effect_id);
});

async function compatibleDescription() {
  return supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
}

function absentDiscovery() {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "discover",
    status: "proven_absent",
    watermark: {
      schema: "drovr.registry-authority-watermark/v1",
      authority: "drovr.registry",
      turns_sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    delegation: null,
    turn: null,
    legal_next_actions: ["dispatch_exact_turn"],
  };
}

function workingProjection(request) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "dispatch",
    status: "working",
    watermark: absentDiscovery().watermark,
    delegation: {
      agent_id: request.agent_id,
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn: { id: "turn:delegate-review", status: "working" },
    legal_next_actions: ["wait_bounded"],
  };
}

function stillWorkingProjection() {
  return {
    ...workingProjection({ agent_id: "agent:delegate-review" }),
    operation: "wait",
    status: "still_running",
  };
}

function cancelledTurnProjection(turnId) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "cancel",
    status: "cancelled",
    watermark: {
      schema: "drovr.turn-authority-watermark/v1",
      authority: "drovr.registry",
      turn_id: turnId,
      record_sha256: digestForTest(turnId),
    },
    delegation: {
      agent_id: "agent:delegate-review",
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn: { id: turnId, status: "cancelled" },
    legal_next_actions: [],
  };
}

function delegateRuntime(
  authority,
  portOverrides,
  validate = (output) => output === "accepted output",
) {
  return createFlowRuntime({
    runAuthority: authority,
    delegatedAgentPort: {
      contract: "flow.delegated-agent-port/v1",
      ...completePortOperations(),
      async discover() {
        return absentDiscovery();
      },
      async dispatch(request) {
        return workingProjection(request);
      },
      async wait() {
        throw new Error("wait was not configured");
      },
      ...portOverrides,
    },
    delegateOutputValidators: {
      [DELEGATE_OUTPUT_VALIDATOR]: {
        validate,
      },
    },
  });
}

function completePortOperations(calls = []) {
  return {
    async describe() {},
    async send() {},
    async observe() {},
    async cancel() {},
    async reconcile() {},
    async retire(request) {
      calls.push(["retire", request]);
      return {
        schema: "flow.delegated-agent-lifecycle-projection/v1",
        operation: "retire",
        status: "retired",
        watermark: {
          schema: "drovr.agent-authority-watermark/v1",
          authority: "drovr.registry",
          agent_id: request.agent_id,
          record_sha256: digestForTest(request.agent_id),
        },
        delegation: {
          agent_id: request.agent_id,
          task_id: "task:delegate-review",
          group_id: "group:flow",
        },
        turn: null,
        legal_next_actions: [],
      };
    },
  };
}

function digestForTest(value) {
  return `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function approveAndExecute(runtime, runId) {
  const waiting = runtime.query({ run_id: runId });
  runtime.command(waiting.legal_actions.find(
    ({ decision }) => decision === "approve",
  ));
  const ready = runtime.query({ run_id: runId });
  return runtime.command(ready.legal_actions.find(
    ({ type }) => type === "delegate_execute",
  ));
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

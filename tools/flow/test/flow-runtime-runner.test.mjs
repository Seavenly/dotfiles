import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createFlowRuntime,
  statusAutonomousFlowRuntime,
  stopAutonomousFlowRuntime,
} from "../src/flow-runtime.mjs";
import {
  createFlowRuntimeRunner,
  summarizeFlowRuntimeError,
} from "../src/flow-runtime-runner.mjs";
import { validateDelegateEvidenceSafety } from "../src/evidence-safety.mjs";
import {
  SUBRUN_CONTRACT,
  SUBRUN_RECEIPT_VALIDATOR,
} from "../src/subrun-effects.mjs";
import {
  createFixedTimeDurableRunAuthority,
  fixedHostIdentity,
} from "../test-support/fixed-host-identity.mjs";
import {
  confirmedLaunchRequest,
  capabilityBlockedCheckpointProposal,
  dynamicCheckpointProposal,
  revisionBlockedCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import {
  operationReceipt,
  OPERATION_RECEIPT_VALIDATOR,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";
import {
  completedTurnProjection,
  delegateCardProposal,
  DELEGATE_CONTRACT,
  DELEGATE_OUTPUT_VALIDATOR,
} from "../test-support/delegate-card.mjs";
import { supportedDescription } from
  "../test-support/delegated-agent-description.mjs";

test("runner error summaries expose only registered bounded codes", () => {
  assert.equal(
    summarizeFlowRuntimeError({ code: "provider_secret_token" }).code,
    "runner_error",
  );
  assert.equal(
    summarizeFlowRuntimeError({ code: "frame_too_large" }, "transport").code,
    "frame_too_large",
  );
  assert.equal(
    summarizeFlowRuntimeError({ code: "transport_secret_token" }, "transport").code,
    "transport_error",
  );
});

test("autonomous FlowRuntime advances a ready operation after launch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createFixedTimeDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-runner"),
  });
  t.after(() => authority.close());

  let invocationCount = 0;
  const runtime = createFlowRuntime({
    autonomous: true,
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
  const proposal = registeredOperationProposal({ checkpointBound: false });
  const prepared = runtime.prepare(proposal);
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(launch.created, true);

  await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  assert.equal(invocationCount, 1);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).legal_actions, []);
});

test("autonomous restart leaves one-shot uncertainty at an explicit stop", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let invocations = 0;
  const firstAuthority = createFixedTimeDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-first"),
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "one_shot_uncertain",
        observe(intent) {
          return indeterminateObservation(intent);
        },
        invoke() {
          invocations += 1;
          throw new Error("one-shot outcome is uncertain");
        },
      },
    },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "one_shot_uncertain",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  const waiting = firstRuntime.query({ run_id: launch.run_id });
  firstRuntime.command(waiting.legal_actions.find(({ decision }) =>
    decision === "approve"));
  await until(() => invocations === 1);
  await until(() => firstRuntime.query({ run_id: launch.run_id })
    .effects[0].status === "uncertain");
  firstAuthority.close();

  let observations = 0;
  const recoveredAuthority = createFixedTimeDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-second"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createFlowRuntime({
    autonomous: true,
    runAuthority: recoveredAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "one_shot_uncertain",
        observe(intent) {
          observations += 1;
          return {
            ...indeterminateObservation(intent),
            presence: "absent",
            provider_observation: { found: false },
          };
        },
        invoke() {
          assert.fail("one-shot uncertainty must never be reinvoked");
        },
      },
    },
  });

  await ticks(8);
  const unresolved = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(observations, 0);
  assert.equal(unresolved.effects[0].status, "uncertain");
  assert.equal(unresolved.effects[0].last_observation.presence,
    "indeterminate");
  assert.deepEqual(unresolved.resource_claims, [{
    kind: "test-record",
    id: "outcome",
  }]);
  assert.deepEqual(unresolved.resource_dispositions, [{
    claim: { kind: "test-record", id: "outcome" },
    disposition: "held",
  }]);
  assert.deepEqual(unresolved.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
});

test("autonomous FlowRuntime leaves checkpoints and plan expansion to an operator",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      declaredCapacity: 6,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-stops"),
    });
    t.after(() => authority.close());
    let invocations = 0;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: {
          classification: "caller_idempotent",
          invoke(intent) {
            invocations += 1;
            return operationReceipt(intent);
          },
        },
      },
    });

    const checkpointLaunch = runtime.launch(confirmedLaunchRequest(
      runtime.prepare(registeredOperationProposal()),
    ));
    const capabilityLaunch = runtime.launch(confirmedLaunchRequest(
      runtime.prepare(capabilityBlockedCheckpointProposal()),
    ));
    const revisionLaunch = runtime.launch(confirmedLaunchRequest(
      runtime.prepare(revisionBlockedCheckpointProposal()),
    ));
    await ticks(8);

    const checkpoint = runtime.query({ run_id: checkpointLaunch.run_id });
    assert.equal(checkpoint.phase, "active");
    assert.deepEqual(checkpoint.legal_actions.map(({ type }) => type), [
      "checkpoint_decision",
      "checkpoint_decision",
    ]);
    assert.equal(invocations, 0);

    const capability = runtime.query({ run_id: capabilityLaunch.run_id });
    assert.equal(capability.phase, "active");
    assert.equal(capability.legal_actions.some(({ type }) =>
      type === "capability_grant"), true);
    assert.equal(capability.legal_actions.some(({ type }) =>
      ["checkpoint_decision", "operation_execute", "delegate_execute",
        "revision_decision"].includes(type)), false);

    const revision = runtime.query({ run_id: revisionLaunch.run_id });
    assert.equal(revision.phase, "active");
    assert.equal(revision.legal_actions.some(({ type }) =>
      type === "capability_grant"), true);
    assert.equal(revision.legal_actions.some(({ type }) =>
      ["capability_grant", "revision_decision"].includes(type)), true);
    assert.equal(revision.legal_actions.some(({ type }) =>
      ["checkpoint_decision", "operation_execute", "delegate_execute"]
        .includes(type)), false);
  });

test("autonomous FlowRuntime leaves quarantined delegate disposition explicit",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-disposition"),
    });
    t.after(() => authority.close());
    const description = await supportedDescription({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        model: "gpt-5.6",
        effort: "high",
        capability: "read-only",
      },
      caller_metadata: { owner: "flow-runner" },
    }, {});
    let dispatches = 0;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      delegatedAgentPort: {
        contract: DELEGATE_CONTRACT,
        async describe() {},
        async send() {},
        async observe() {},
        async wait() {},
        async cancel() {},
        async reconcile() {},
        async discover() {
          return absentDiscovery();
        },
        async dispatch(request) {
          dispatches += 1;
          return completedTurnProjection({
            callerKey: request.caller_key,
            description,
            output: "not accepted",
          });
        },
        async retire(request) {
          return retiredAgentProjection(request.agent_id);
        },
      },
      delegateOutputValidators: {
        [DELEGATE_OUTPUT_VALIDATOR]: {
          validate() {
            return false;
          },
          evidenceSafety: validateDelegateEvidenceSafety,
        },
      },
    });
    const prepared = runtime.prepare(delegateCardProposal(description));
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    const waiting = runtime.query({ run_id: launch.run_id });
    runtime.command(waiting.legal_actions.find(({ decision }) =>
      decision === "approve"));

    await until(() => runtime.query({ run_id: launch.run_id })
      .effects[0]?.status === "quarantined");
    await ticks(8);
    const blocked = runtime.query({ run_id: launch.run_id });
    assert.equal(dispatches, 1);
    assert.equal(blocked.phase, "active");
    assert.deepEqual(blocked.legal_actions.map(({ type }) => type), [
      "terminal_disposition",
    ]);
  });

test("autonomous runner separates capacities and keeps independent runs moving",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      declaredCapacity: 4,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-capacity"),
    });
    t.after(() => authority.close());
    const description = await supportedDescription({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        model: "gpt-5.6",
        effort: "high",
        capability: "read-only",
      },
      caller_metadata: { owner: "flow-runner-capacity" },
    }, {});
    const operationCalls = [];
    let settleSlowOperation;
    let delegateStarted = false;
    let delegateCallerKey;
    let settleDelegate;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      runnerOptions: { delegateCapacity: 1, operationCapacity: 1 },
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: {
          classification: "caller_idempotent",
          invoke(intent) {
            operationCalls.push(intent.run_id);
            if (operationCalls.length === 1) {
              return new Promise((resolve) => {
                settleSlowOperation = () => resolve(operationReceipt(intent));
              });
            }
            return operationReceipt(intent);
          },
        },
      },
      delegatedAgentPort: {
        contract: DELEGATE_CONTRACT,
        async describe() {},
        async send() {},
        async observe() {},
        async cancel() {},
        async reconcile() {},
        async discover() {
          return absentDiscovery();
        },
        async dispatch(request) {
          delegateStarted = true;
          delegateCallerKey = request.caller_key;
          return workingDelegateProjection(request);
        },
        async wait(request) {
          return new Promise((resolve) => {
            settleDelegate = () => resolve(completedTurnProjection({
              callerKey: delegateCallerKey,
              description,
            }));
          });
        },
        async retire(request) {
          return retiredAgentProjection(request.agent_id);
        },
      },
      delegateOutputValidators: {
        [DELEGATE_OUTPUT_VALIDATOR]: {
          validate(output) {
            return output === "accepted output";
          },
          evidenceSafety: validateDelegateEvidenceSafety,
        },
      },
    });
    const operationLaunches = ["slow", "waiting"].map((value) => {
      const proposal = registeredOperationProposal({ checkpointBound: false });
      proposal.graph.cards[0].inputs.value = value;
      return runtime.launch(confirmedLaunchRequest(runtime.prepare(proposal)));
    });
    const delegateLaunch = runtime.launch(confirmedLaunchRequest(
      runtime.prepare(delegateCardProposal(description)),
    ));
    runtime.command(runtime.query({ run_id: delegateLaunch.run_id })
      .legal_actions.find(({ decision }) => decision === "approve"));

    await until(() => operationCalls.length === 1 && delegateStarted);
    await ticks(8);
    const waitingOperation = operationLaunches.find(({ run_id: runId }) =>
      !runtime.query({ run_id: runId }).effects.length);
    assert.ok(waitingOperation);
    assert.equal(runtime.query({ run_id: waitingOperation.run_id }).cards[0].status,
      "ready");
    const activeOperation = runtime.query({ run_id: operationCalls[0] });
    assert.equal(activeOperation.effects[0].status, "unresolved");
    assert.equal(delegateStarted, true);
    assert.equal(typeof settleSlowOperation, "function");
    assert.equal(typeof settleDelegate, "function");
    const activeStatus = statusAutonomousFlowRuntime(runtime);
    assert.equal(activeStatus.runs.active, 3);
    assert.equal(activeStatus.runs.waiting, 1);
    assert.equal(activeStatus.runs.retained, 0);
    assert.equal(activeStatus.delegates.active, 1);
    assert.equal(activeStatus.operations.active, 1);

    settleSlowOperation();
    await until(() => operationCalls.length === 2);
    await until(() => operationLaunches.every(({ run_id: runId }) =>
      runtime.query({ run_id: runId }).phase === "succeeded"));
    settleDelegate();
    await until(() => runtime.query({ run_id: delegateLaunch.run_id }).phase ===
      "succeeded");
    const retainedStatus = statusAutonomousFlowRuntime(runtime);
    assert.equal(retainedStatus.runs.active, 0);
    assert.equal(retainedStatus.runs.waiting, 0);
    assert.equal(retainedStatus.runs.retained, 3);
    assert.equal(retainedStatus.delegates.active, 0);
    assert.equal(retainedStatus.operations.active, 0);
    stopAutonomousFlowRuntime(runtime);
  });

test("autonomous cancellation closes a live delegate without admitting new work",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-cancel"),
    });
    t.after(() => authority.close());
    const description = await supportedDescription({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        model: "gpt-5.6",
        effort: "high",
        capability: "read-only",
      },
      caller_metadata: { owner: "flow-runner-cancel" },
    }, {});
    let callerKey;
    let cancelled = false;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      delegatedAgentPort: {
        contract: DELEGATE_CONTRACT,
        async describe() {},
        async send() {},
        async observe() {},
        async wait() {
          return new Promise(() => {});
        },
        async cancel() {
          cancelled = true;
          return cancelledTurnProjection("turn:delegate-review");
        },
        async reconcile() {},
        async discover(request) {
          if (!callerKey) {
            callerKey = request.caller_key;
            return absentDiscovery();
          }
          const projection = workingDelegateProjection({
            caller_key: callerKey,
            description,
          });
          projection.operation = "discover";
          if (cancelled) {
            projection.status = "cancelled";
            projection.turn.status = "cancelled";
            delete projection.turn.result;
          }
          return projection;
        },
        async dispatch(request) {
          callerKey = request.caller_key;
          return workingDelegateProjection(request);
        },
        async retire(request) {
          return retiredAgentProjection(request.agent_id);
        },
      },
      delegateOutputValidators: {
        [DELEGATE_OUTPUT_VALIDATOR]: {
          validate() {
            return true;
          },
          evidenceSafety: validateDelegateEvidenceSafety,
        },
      },
    });
    const proposal = delegateCardProposal(description);
    proposal.requested_authority.commands.push("cancel");
    const launch = runtime.launch(confirmedLaunchRequest(runtime.prepare(proposal)));
    runtime.command(runtime.query({ run_id: launch.run_id })
      .legal_actions.find(({ decision }) => decision === "approve"));
    await until(() => runtime.query({ run_id: launch.run_id })
      .effects.some(({ effect_kind: kind }) => kind === "delegate"));

    const active = runtime.query({ run_id: launch.run_id });
    const cancel = active.legal_actions.find(({ type }) => type === "cancel");
    assert.ok(cancel);
    assert.equal(runtime.command(cancel).accepted, true);
    await until(() => {
      const projection = runtime.query({ run_id: launch.run_id });
      return projection.phase === "cancelled" &&
        projection.effects.some(({ effect_kind: kind, receipt }) =>
          kind === "delegate_cancellation" && receipt !== null);
    });
    const cancelledProjection = runtime.query({ run_id: launch.run_id });
    assert.equal(cancelled, true);
    assert.equal(cancelledProjection.phase, "cancelled");
    assert.equal(cancelledProjection.legal_actions.some(({ type }) =>
      type === "delegate_execute"), false);
    assert.equal(statusAutonomousFlowRuntime(runtime).delegates.active, 0);
  });

test("autonomous runner observes a settling delegate and runs its newly ready operation",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      declaredCapacity: 4,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-watch"),
    });
    t.after(() => authority.close());
    const description = await supportedDescription({
      schema: "drovr.delegated-agent-description-request/v1",
      launch: {
        harness: "codex",
        role: "reviewer",
        model: "gpt-5.6",
        effort: "high",
        capability: "read-only",
      },
      caller_metadata: { owner: "flow-runner-watch" },
    }, {});
    let delegateCallerKey;
    let delegateStarted = false;
    let settleDelegate;
    let operationCalls = 0;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: {
          classification: "caller_idempotent",
          invoke(intent) {
            operationCalls += 1;
            return operationReceipt(intent);
          },
        },
      },
      delegatedAgentPort: {
        contract: DELEGATE_CONTRACT,
        async describe() {},
        async send() {},
        async observe() {},
        async cancel() {},
        async reconcile() {},
        async discover() {
          return absentDiscovery();
        },
        async dispatch(request) {
          delegateStarted = true;
          delegateCallerKey = request.caller_key;
          return workingDelegateProjection(request);
        },
        async wait() {
          return new Promise((resolve) => {
            settleDelegate = () => resolve(completedTurnProjection({
              callerKey: delegateCallerKey,
              description,
            }));
          });
        },
        async retire(request) {
          return retiredAgentProjection(request.agent_id);
        },
      },
      delegateOutputValidators: {
        [DELEGATE_OUTPUT_VALIDATOR]: {
          validate(output) {
            return output === "accepted output";
          },
          evidenceSafety: validateDelegateEvidenceSafety,
        },
      },
    });
    const launch = runtime.launch(confirmedLaunchRequest(runtime.prepare(
      delegateThenOperationProposal(description),
    )));
    assert.equal(launch.created, true);
    runtime.command(runtime.query({ run_id: launch.run_id })
      .legal_actions.find(({ decision }) => decision === "approve"));

    await until(() => delegateStarted);
    assert.equal(operationCalls, 0);
    assert.equal(typeof settleDelegate, "function");
    settleDelegate();
    await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
    assert.equal(operationCalls, 1);
    assert.equal(statusAutonomousFlowRuntime(runtime).runs.retained, 1);
  });

test("autonomous runner stop returns host and indexed run watchers", async () => {
  const hostProjection = {
    schema: "flow.run-index-projection/v1",
    watermark: "sha256:host",
    runs: ["run:watch", "run:done"],
  };
  const runProjection = {
    schema: "flow.run-projection/v1",
    run_id: "run:watch",
    phase: "active",
    admission: "admitted",
    effects: [],
    legal_actions: [],
  };
  const terminalProjection = {
    ...runProjection,
    run_id: "run:done",
    phase: "succeeded",
  };
  const returned = [];
  const watchers = [];
  const createWatcher = (label, initialProjection) => {
    let initial = true;
    let resolvePending;
    const watcher = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (initial) {
          initial = false;
          return Promise.resolve({ done: false, value: initialProjection });
        }
        return new Promise((resolve) => {
          resolvePending = resolve;
        });
      },
      return() {
        returned.push(label);
        resolvePending?.({ done: true, value: undefined });
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    watchers.push(label);
    return watcher;
  };
  const runtime = {
    query({ run_id: runId } = {}) {
      if (runId === undefined) return hostProjection;
      return runId === "run:done" ? terminalProjection : runProjection;
    },
    command() {
      assert.fail("watch lifecycle test must not issue commands");
    },
    watch(request = {}) {
      return request.host === true
        ? createWatcher("host", hostProjection)
        : createWatcher(request.run_id, runProjection);
    },
  };
  const runner = createFlowRuntimeRunner({
    runtime,
    runAuthority: { query: () => hostProjection },
  });
  runner.start();
  await until(() => watchers.includes("host") && watchers.includes("run:watch"));
  assert.equal(watchers.includes("run:done"), false);
  runner.stop();
  await until(() => returned.length === 2);
  assert.deepEqual([...returned].sort(), ["host", "run:watch"]);
  runner.stop();
  assert.deepEqual([...returned].sort(), ["host", "run:watch"]);
});

test("autonomous runner does not recover its own live dispatch but restart does", async () => {
  const hostProjection = {
    schema: "flow.run-index-projection/v1",
    watermark: "sha256:host-live-dispatch",
    runs: ["run:live-dispatch"],
  };
  const operation = {
    type: "operation_execute",
    run_id: "run:live-dispatch",
    card_id: "operation",
  };
  const recovery = {
    type: "recovery",
    run_id: "run:live-dispatch",
    effect_id: "effect:live-dispatch",
    recovery: "repeat_exact",
  };
  const projection = {
    schema: "flow.run-projection/v1",
    run_id: "run:live-dispatch",
    phase: "active",
    admission: "admitted",
    effects: [{
      effect_id: "effect:live-dispatch",
      effect_kind: "operation",
      classification: "caller_idempotent",
      operation_contract: "test.operation/v1",
      status: "unresolved",
      receipt: null,
      last_observation: null,
    }],
    legal_actions: [operation],
  };
  const commands = [];
  const watchers = new Set();
  let live = false;
  const runtime = {
    query(request = {}) {
      return request.run_id === undefined ? hostProjection : {
        ...projection,
        effects: live ? projection.effects : [],
        legal_actions: live ? [recovery] : [operation],
      };
    },
    command(action) {
      commands.push(action.type);
      if (action.type === "operation_execute") live = true;
      return action.type === "operation_execute"
        ? {
            accepted: true,
            effect_intents: [
              {
                run_id: "run:live-dispatch",
                card_id: "operation",
                effect_id: "effect:live-dispatch",
              },
              {
                run_id: "run:live-dispatch",
                card_id: "other-operation",
                effect_id: "effect:unrelated",
              },
            ],
          }
        : { accepted: true };
    },
    watch(request = {}) {
      let initial = true;
      let resolvePending;
      const watcher = {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (initial) {
            initial = false;
            return Promise.resolve({
              done: false,
              value: request.host === true ? hostProjection : projection,
            });
          }
          return new Promise((resolve) => { resolvePending = resolve; });
        },
        return() {
          resolvePending?.({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
      };
      watchers.add(watcher);
      return watcher;
    },
  };
  const runAuthority = { query: () => hostProjection };
  const first = createFlowRuntimeRunner({ runtime, runAuthority });
  first.start();
  await until(() => commands.length === 1);
  first.wake();
  await ticks(4);
  assert.deepEqual(commands, ["operation_execute"]);
  first.stop();

  const second = createFlowRuntimeRunner({ runtime, runAuthority });
  second.start();
  await until(() => commands.length === 2);
  assert.deepEqual(commands, ["operation_execute", "recovery"]);
  second.stop();
  assert.equal(watchers.size > 0, true);
});

test("autonomous runner retires exact execution dispatch keys after settlement",
  async () => {
    const hostProjection = {
      schema: "flow.run-index-projection/v1",
      watermark: "sha256:host-live-dispatch-retirement",
      runs: ["run:live-dispatch-retirement"],
    };
    const operation = {
      type: "operation_execute",
      run_id: "run:live-dispatch-retirement",
      card_id: "operation",
    };
    const recovery = {
      type: "recovery",
      run_id: "run:live-dispatch-retirement",
      effect_id: "effect:live-dispatch-retirement",
      recovery: "repeat_exact",
    };
    const commands = [];
    let state = "ready";
    let resolvePending;
    const effect = (overrides = {}) => ({
      effect_id: "effect:live-dispatch-retirement",
      effect_kind: "operation",
      classification: "caller_idempotent",
      operation_contract: "test.operation/v1",
      status: "unresolved",
      receipt: null,
      last_observation: null,
      ...overrides,
    });
    const runtime = {
      query(request = {}) {
        if (request.run_id === undefined) return hostProjection;
        if (state === "ready") {
          return {
            schema: "flow.run-projection/v1",
            run_id: "run:live-dispatch-retirement",
            phase: "active",
            admission: "admitted",
            effects: [],
            legal_actions: [operation],
          };
        }
        if (state === "unresolved") {
          return {
            schema: "flow.run-projection/v1",
            run_id: "run:live-dispatch-retirement",
            phase: "active",
            admission: "admitted",
            effects: [effect()],
            legal_actions: [recovery],
          };
        }
        if (state === "settled") {
          return {
            schema: "flow.run-projection/v1",
            run_id: "run:live-dispatch-retirement",
            phase: "active",
            admission: "admitted",
            effects: [effect({
              status: "succeeded",
              receipt: { outcome: "succeeded" },
            })],
            legal_actions: [recovery],
          };
        }
        return {
          schema: "flow.run-projection/v1",
          run_id: "run:live-dispatch-retirement",
          phase: "succeeded",
          admission: "admitted",
          effects: [effect({
            status: "succeeded",
            receipt: { outcome: "succeeded" },
          })],
          legal_actions: [],
        };
      },
      command(action) {
        commands.push(action.type);
        if (action.type === "operation_execute") state = "unresolved";
        if (action.type === "recovery") state = "done";
        return action.type === "operation_execute"
          ? {
              accepted: true,
              effect_intents: [{
                run_id: "run:live-dispatch-retirement",
                card_id: "operation",
                effect_id: "effect:live-dispatch-retirement",
              }],
            }
          : { accepted: true };
      },
      watch(request = {}) {
        let initial = true;
        const watcher = {
          [Symbol.asyncIterator]() { return this; },
          next() {
            if (initial) {
              initial = false;
              return Promise.resolve({
                done: false,
                value: request.host === true
                  ? hostProjection
                  : runtime.query({ run_id: request.run_id }),
              });
            }
            return new Promise((resolve) => { resolvePending = resolve; });
          },
          return() {
            resolvePending?.({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        return watcher;
      },
    };
    const runner = createFlowRuntimeRunner({
      runtime,
      runAuthority: { query: () => hostProjection },
    });
    runner.start();
    await until(() => commands.length === 1);
    await ticks(4);
    assert.deepEqual(commands, ["operation_execute"]);

    state = "settled";
    runner.wake();
    await until(() => commands.length === 2);
    assert.deepEqual(commands, ["operation_execute", "recovery"]);
    runner.stop();
  });

test("autonomous runner stops on a caller-idempotent indeterminate effect",
  async () => {
    const hostProjection = {
      schema: "flow.run-index-projection/v1",
      watermark: "sha256:host-live-dispatch-indeterminate",
      runs: ["run:live-dispatch-indeterminate"],
    };
    const operation = {
      type: "operation_execute",
      run_id: "run:live-dispatch-indeterminate",
      card_id: "operation",
    };
    const recovery = {
      type: "recovery",
      run_id: "run:live-dispatch-indeterminate",
      card_id: "operation",
      effect_id: "effect:live-dispatch-indeterminate",
      recovery: "repeat_exact",
    };
    const commands = [];
    let state = "ready";
    let resolvePending;
    const effect = (overrides = {}) => ({
      effect_id: "effect:live-dispatch-indeterminate",
      effect_kind: "operation",
      classification: "caller_idempotent",
      operation_contract: "test.operation/v1",
      status: "unresolved",
      receipt: null,
      last_observation: null,
      ...overrides,
    });
    const runtime = {
      query(request = {}) {
        if (request.run_id === undefined) return hostProjection;
        if (state === "ready") {
          return {
            schema: "flow.run-projection/v1",
            run_id: "run:live-dispatch-indeterminate",
            phase: "active",
            admission: "admitted",
            effects: [],
            legal_actions: [operation],
          };
        }
        if (state === "indeterminate") {
          return {
            schema: "flow.run-projection/v1",
            run_id: "run:live-dispatch-indeterminate",
            phase: "active",
            admission: "admitted",
            effects: [effect({
              last_observation: { presence: "indeterminate" },
            })],
            legal_actions: [recovery],
          };
        }
        return {
          schema: "flow.run-projection/v1",
          run_id: "run:live-dispatch-indeterminate",
          phase: "succeeded",
          admission: "admitted",
          effects: [effect({
            status: "succeeded",
            receipt: { outcome: "succeeded" },
          })],
          legal_actions: [],
        };
      },
      command(action) {
        commands.push(action.type);
        if (action.type === "operation_execute") state = "indeterminate";
        if (action.type === "recovery") state = "done";
        return action.type === "operation_execute"
          ? {
              accepted: true,
              effect_intents: [{
                run_id: "run:live-dispatch-indeterminate",
                card_id: "operation",
                effect_id: "effect:live-dispatch-indeterminate",
              }],
            }
          : { accepted: true };
      },
      watch(request = {}) {
        let initial = true;
        const watcher = {
          [Symbol.asyncIterator]() { return this; },
          next() {
            if (initial) {
              initial = false;
              return Promise.resolve({
                done: false,
                value: request.host === true
                  ? hostProjection
                  : runtime.query({ run_id: request.run_id }),
              });
            }
            return new Promise((resolve) => { resolvePending = resolve; });
          },
          return() {
            resolvePending?.({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        return watcher;
      },
    };
    const runner = createFlowRuntimeRunner({
      runtime,
      runAuthority: { query: () => hostProjection },
    });
    runner.start();
    await until(() => commands.length === 1);
    runner.wake();
    await ticks(12);
    assert.deepEqual(commands, ["operation_execute"],
      "durable indeterminacy is an explicit stop for every effect class");
    assert.equal(runner.status().pending_commands, 0);
    runner.stop();
  });

test("durable autonomous runner tracks effect ids returned for an execution action",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-live-id"),
    });
    t.after(() => authority.close());

    let invocationCount = 0;
    let settle;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: {
          classification: "caller_idempotent",
          invoke(intent) {
            invocationCount += 1;
            return new Promise((resolve) => {
              settle = () => resolve(operationReceipt(intent));
            });
          },
        },
      },
    });
    t.after(() => stopAutonomousFlowRuntime(runtime));

    const proposal = registeredOperationProposal({
      checkpointBound: false,
    });
    proposal.graph.cards[0].limits.max_attempts = 2;
    const prepared = runtime.prepare(proposal);
    const launch = runtime.launch(confirmedLaunchRequest(prepared));
    assert.equal(launch.created, true);

    await until(() => {
      const projection = runtime.query({ run_id: launch.run_id });
      return invocationCount === 1 && typeof settle === "function" &&
        projection.effects.some(({ invocation_started: started }) => started);
    });
    assert.equal(runtime.query({ run_id: launch.run_id }).legal_actions.some(
      ({ type }) => type === "recovery",
    ), true);
    await ticks(12);
    assert.equal(invocationCount, 1,
      "a same-runner watch update must not request recovery for its live effect");
    assert.equal(statusAutonomousFlowRuntime(runtime).errors.count, 0);
    const database = new DatabaseSync(
      join(authorityDirectory, "authority.sqlite"),
      { readOnly: true },
    );
    const recoveryEvents = database.prepare(`
      SELECT COUNT(*) AS count
        FROM authority_events
       WHERE stream_id = ?
         AND json_extract(payload_json, '$.type') =
           'effect_recovery_requested'
    `).get(launch.run_id);
    database.close();
    assert.equal(Number(recoveryEvents.count), 0);
    assert.equal(
      runtime.query({ run_id: launch.run_id }).effects[0].status,
      "unresolved",
    );

    settle();
    await until(() => runtime.query({ run_id: launch.run_id }).phase === "succeeded");
  });

test("reconstructed durable runner recovers an unresolved exact effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-restart-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createFixedTimeDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-first"),
  });
  t.after(() => firstAuthority.close());

  let invocationCount = 0;
  let initialEffectId;
  const firstRuntime = createFlowRuntime({
    autonomous: true,
    runAuthority: firstAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invocationCount += 1;
          initialEffectId = intent.effect_id;
          return new Promise(() => {});
        },
      },
    },
  });
  t.after(() => stopAutonomousFlowRuntime(firstRuntime));

  const proposal = registeredOperationProposal({ checkpointBound: false });
  proposal.graph.cards[0].limits.max_attempts = 2;
  const launch = firstRuntime.launch(confirmedLaunchRequest(
    firstRuntime.prepare(proposal),
  ));
  assert.equal(launch.created, true);
  await until(() => {
    const projection = firstRuntime.query({ run_id: launch.run_id });
    return invocationCount === 1 && projection.effects[0]?.invocation_started;
  });
  assert.equal(firstRuntime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");

  stopAutonomousFlowRuntime(firstRuntime);
  firstAuthority.close();
  const beforeRestart = new DatabaseSync(
    join(authorityDirectory, "authority.sqlite"),
    { readOnly: true },
  );
  const recoveryBeforeRestart = beforeRestart.prepare(`
    SELECT COUNT(*) AS count
      FROM authority_events
     WHERE stream_id = ?
       AND json_extract(payload_json, '$.type') =
         'effect_recovery_requested'
  `).get(launch.run_id);
  beforeRestart.close();
  assert.equal(Number(recoveryBeforeRestart.count), 0);

  const secondAuthority = createFixedTimeDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-second"),
  });
  t.after(() => secondAuthority.close());
  const secondRuntime = createFlowRuntime({
    autonomous: true,
    runAuthority: secondAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke(intent) {
          invocationCount += 1;
          assert.equal(intent.effect_id, initialEffectId);
          return operationReceipt(intent, { record: "recovered" });
        },
      },
    },
  });
  t.after(() => stopAutonomousFlowRuntime(secondRuntime));

  await until(() => secondRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");
  assert.equal(invocationCount, 2);
  const afterRestart = new DatabaseSync(
    join(authorityDirectory, "authority.sqlite"),
    { readOnly: true },
  );
  const recoveryAfterRestart = afterRestart.prepare(`
    SELECT COUNT(*) AS count
      FROM authority_events
     WHERE stream_id = ?
       AND json_extract(payload_json, '$.type') =
         'effect_recovery_requested'
  `).get(launch.run_id);
  afterRestart.close();
  assert.equal(Number(recoveryAfterRestart.count), 1);
  assert.equal(statusAutonomousFlowRuntime(secondRuntime).errors.count, 0);
});

test("durable indeterminate registered effects stop across runner reconstruction",
  async (t) => {
    const authorityDirectory = await mkdtemp(
      join(tmpdir(), "flow-runner-indeterminate-stop-"),
    );
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));

    let invocationCount = 0;
    const registration = {
      classification: "caller_idempotent",
      invoke() {
        invocationCount += 1;
        const error = new Error("persistent provider rejection secret");
        error.execution_status = "uncertain_external_outcome";
        throw error;
      },
    };
    const firstAuthority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-first"),
    });
    t.after(() => firstAuthority.close());
    const firstRuntime = createFlowRuntime({
      autonomous: true,
      runAuthority: firstAuthority,
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: registration,
      },
    });
    t.after(() => stopAutonomousFlowRuntime(firstRuntime));

    const proposal = registeredOperationProposal({ checkpointBound: false });
    proposal.graph.cards[0].limits.max_attempts = 3;
    const launch = firstRuntime.launch(confirmedLaunchRequest(
      firstRuntime.prepare(proposal),
    ));
    await until(() => {
      const effect = firstRuntime.query({ run_id: launch.run_id }).effects[0];
      return invocationCount === 1 &&
        effect?.last_observation?.presence === "indeterminate";
    });
    const firstProjection = firstRuntime.query({ run_id: launch.run_id });
    assert.deepEqual(firstProjection.legal_actions.map(({ type }) => type), [
      "recovery",
    ]);
    await ticks(24);
    assert.equal(invocationCount, 1);
    assert.equal(recoveryEventCount(authorityDirectory, launch.run_id), 0);
    assert.equal(statusAutonomousFlowRuntime(firstRuntime).errors.count, 0);

    stopAutonomousFlowRuntime(firstRuntime);
    firstAuthority.close();
    const secondAuthority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-second"),
    });
    t.after(() => secondAuthority.close());
    const secondRuntime = createFlowRuntime({
      autonomous: true,
      runAuthority: secondAuthority,
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: registration,
      },
    });
    t.after(() => stopAutonomousFlowRuntime(secondRuntime));

    await ticks(24);
    const reconstructed = secondRuntime.query({ run_id: launch.run_id });
    assert.equal(invocationCount, 1,
      "reconstruction must preserve the explicit indeterminate stop");
    assert.equal(reconstructed.effects[0].last_observation.presence,
      "indeterminate");
    assert.deepEqual(reconstructed.legal_actions.map(({ type }) => type), [
      "recovery",
    ]);
    assert.equal(recoveryEventCount(authorityDirectory, launch.run_id), 0);
    assert.equal(statusAutonomousFlowRuntime(secondRuntime).errors.count, 0);
  });

test("autonomous child progress is not blocked by its passive parent observation",
  async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-runner-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createFixedTimeDurableRunAuthority({
      authorityDirectory,
      declaredCapacity: 2,
      hostIdentityAdapter: fixedHostIdentity("boot-runner", "process-subrun"),
    });
    t.after(() => authority.close());
    let settleChild;
    const runtime = createFlowRuntime({
      autonomous: true,
      runAuthority: authority,
      runnerOptions: { delegateCapacity: 1, operationCapacity: 1 },
      registeredOperations: {
        [TEST_OPERATION_CONTRACT]: {
          classification: "caller_idempotent",
          invoke(intent) {
            return new Promise((resolve) => {
              settleChild = () => resolve(operationReceipt(intent));
            });
          },
        },
      },
    });
    const childProposal = registeredOperationProposal({ checkpointBound: false });
    childProposal.requested_authority.commands.push("cancel");
    const childPrepared = runtime.prepare(childProposal);
    const parentPrepared = runtime.prepare(parentSubrunProposal(
      confirmedLaunchRequest(childPrepared),
    ));
    const launch = runtime.launch(confirmedLaunchRequest(parentPrepared));
    assert.equal(launch.created, true);

    await until(() => {
      const parent = runtime.query({ run_id: launch.run_id });
      return parent.subruns?.[0]?.child_run_id !== undefined &&
        typeof settleChild === "function";
    });
    const parent = runtime.query({ run_id: launch.run_id });
    const childRunId = parent.subruns[0].child_run_id;
    const child = runtime.query({ run_id: childRunId });
    const status = statusAutonomousFlowRuntime(runtime);
    assert.equal(parent.phase, "active");
    assert.equal(parent.subruns[0].status, "active");
    assert.equal(parent.effects[0].operation_contract, SUBRUN_CONTRACT);
    assert.equal(parent.effects[0].receipt, null);
    assert.equal(child.phase, "active");
    assert.equal(child.effects[0].status, "unresolved");
    assert.equal(status.delegates.active, 0);
    assert.equal(status.operations.active, 1);

    settleChild();
    await until(() => runtime.query({ run_id: launch.run_id }).phase ===
      "succeeded");
    assert.equal(runtime.query({ run_id: childRunId }).phase, "succeeded");
  });

function until(condition) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for autonomous FlowRuntime"));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

function ticks(count) {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      if (remaining-- <= 0) {
        resolve();
        return;
      }
      setImmediate(tick);
    };
    tick();
  });
}

function recoveryEventCount(authorityDirectory, runId) {
  const database = new DatabaseSync(
    join(authorityDirectory, "authority.sqlite"),
    { readOnly: true },
  );
  try {
    const result = database.prepare(`
      SELECT COUNT(*) AS count
        FROM authority_events
       WHERE stream_id = ?
         AND json_extract(payload_json, '$.type') =
           'effect_recovery_requested'
    `).get(runId);
    return Number(result.count);
  } finally {
    database.close();
  }
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

function absentDiscovery() {
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
}

function retiredAgentProjection(agentId) {
  return {
    schema: "flow.delegated-agent-lifecycle-projection/v1",
    operation: "retire",
    status: "retired",
    watermark: {
      schema: "drovr.agent-authority-watermark/v1",
      authority: "drovr.registry",
      agent_id: agentId,
      record_sha256: `sha256:${"1".repeat(64)}`,
    },
    delegation: {
      agent_id: agentId,
      task_id: "task:delegate-review",
      group_id: "group:flow",
    },
    turn: null,
    legal_next_actions: [],
  };
}

function workingDelegateProjection(request) {
  const projection = completedTurnProjection({
    callerKey: request.caller_key,
    description: request.description,
    prompt: request.prompt,
  });
  projection.operation = "dispatch";
  projection.status = "working";
  projection.turn.status = "working";
  delete projection.turn.result;
  projection.legal_next_actions = ["wait_bounded"];
  return projection;
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
      record_sha256: `sha256:${"2".repeat(64)}`,
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

function delegateThenOperationProposal(description) {
  const proposal = delegateCardProposal(description);
  const delegate = proposal.graph.cards.find(({ id }) => id === "delegate-review");
  proposal.graph.cards.push({
    id: "capture-result",
    executor: {
      kind: "operation",
      contract: TEST_OPERATION_CONTRACT,
      effect_classification: "caller_idempotent",
    },
    dependencies: [delegate.id],
    inputs: { value: "captured" },
    outputs: ["receipt"],
    success_criteria: ["receipt:succeeded"],
    validators: [OPERATION_RECEIPT_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: { adapter: "conformance-recorder" },
    limits: { max_attempts: 1 },
    resource_claims: [{ kind: "test-record", id: "capture" }],
    recovery: "caller_idempotent",
  });
  proposal.requested_authority.commands.push("operation_execute");
  proposal.requested_authority.mutations.push(TEST_OPERATION_CONTRACT);
  proposal.explicit_facts.operation_contracts.push(TEST_OPERATION_CONTRACT);
  proposal.explicit_facts.validator_contracts.push(OPERATION_RECEIPT_VALIDATOR);
  proposal.explicit_facts.resource_claims.push({
    kind: "test-record",
    id: "capture",
  });
  proposal.explicit_facts.limits.max_cards = 3;
  proposal.explicit_facts.limits.max_resources = 1;
  return proposal;
}

function parentSubrunProposal(childLaunchRequest) {
  const proposal = dynamicCheckpointProposal();
  proposal.graph.cards = [{
    id: "child",
    executor: {
      kind: "subrun",
      contract: SUBRUN_CONTRACT,
      effect_classification: "reconcilable",
    },
    dependencies: [],
    inputs: { child_launch_request: childLaunchRequest },
    outputs: ["child_terminal_result"],
    success_criteria: ["child:succeeded"],
    validators: [SUBRUN_RECEIPT_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: { adapter: "run-authority" },
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "reconcile",
  }];
  proposal.requested_authority = {
    commands: ["subrun_execute", "cancel"],
    capabilities: [],
    mutations: [SUBRUN_CONTRACT],
  };
  proposal.explicit_facts.operation_contracts = [SUBRUN_CONTRACT];
  proposal.explicit_facts.validator_contracts = [SUBRUN_RECEIPT_VALIDATOR];
  return proposal;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { captureTranscriptCursor } from "../src/codex-transcript.mjs";
import { captureClaudeTranscriptCursor } from "../src/claude-transcript.mjs";
import { digestCanonical } from "../src/canonical-json.mjs";
import { describeDelegatedAgent } from "../src/description.mjs";
import { createBlockRecord } from "../src/block-record.mjs";
import { readRecords, stateDirectory, writeRecord } from "../src/registry.mjs";
import {
  bindStagedInputToken,
  stagedInputTextToken,
} from "../src/staged-input-receipt.mjs";
import { appendTurnInput, createTurnRecord } from "../src/turn-record.mjs";
import {
  cancelTurn,
  discoverTurn,
  dispatchTurn,
  getTurn,
  reconcileTurn,
  sendToTurn,
  startTurn,
  turnCommandResult,
  waitForTurn,
} from "../src/turns.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("public turn summaries expose managed runtime evidence without private identity", () => {
  const managedRuntimeIdentity = {
    schema: "drovr.managed-pane-runtime-identity/v1",
    pane_id: "private-pane",
    executable: { canonical_path: "/private/codex" },
  };
  const report = turnCommandResult("turn get", {
    group: { id: "group-1", key: "group" },
    task: { id: "task-1", key: "task", label: "Task", cwd: "/private/work" },
    agent: {
      id: "agent-1",
      key: "agent",
      label: "Agent",
      launch: {
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        capability: "read-only",
      },
      launch_binding: {
        managed_runtime_evidence_digest: digestCanonical(managedRuntimeIdentity),
      },
    },
    turn: {
      id: "turn-1",
      status: "completed",
      inputs: [],
      launch_binding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: `sha256:${"a".repeat(64)}`,
        configuration_watermark: `sha256:${"b".repeat(64)}`,
        description_digest: `sha256:${"c".repeat(64)}`,
        managed_runtime_identity: managedRuntimeIdentity,
      },
    },
  });

  assert.equal(
    report.result.turn.launch_binding.managed_runtime_evidence_digest,
    digestCanonical(managedRuntimeIdentity),
  );
  assert.equal(
    Object.hasOwn(report.result.turn.launch_binding, "managed_runtime_identity"),
    false,
  );
});

test("caller-owned dispatch and ordered input survive caller exit and fail closed on conflicts", async (t) => {
  const fixture = await turnFixture(t);
  const [existing] = await readRecords(fixture.registryDirectory, "turns");
  existing.status = "cancelled";
  existing.settled_at = "2026-07-23T09:59:59.000Z";
  await writeRecord(fixture.registryDirectory, "turns", existing);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  const copiedConfig = join(
    fixture.env.XDG_STATE_HOME,
    "..",
    "drovr-config",
  );
  await cp(join(root, "config", "drovr"), copiedConfig, { recursive: true });
  fixture.env.DROVR_CONFIG_DIR = copiedConfig;
  const callerMetadata = { run_id: "run:1", card_id: "review" };
  const description = await describeDelegatedAgent({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: agent.launch.harness,
      model: agent.launch.model,
      effort: agent.launch.effort,
      capability: agent.launch.capability,
    },
    caller_metadata: callerMetadata,
  }, { env: fixture.env });
  agent.launch_binding = {
    schema: "drovr.agent-launch-binding/v1",
    comparison_key: description.comparison_keys.launch,
    configuration_watermark: description.watermark.content_sha256,
  };
  await writeRecord(fixture.registryDirectory, "agents", agent);

  let deliveries = 0;
  const herdr = {
    async ensureSession() {},
    async agentRecord() {
      return {
        agent_status: deliveries === 0 ? "idle" : "working",
        state_change_seq: deliveries,
        agent_session: { value: "codex-session-1" },
      };
    },
    async prompt() {
      deliveries += 1;
    },
    async waitForAgent() {
      return { drovr_status: "still_running" };
    },
  };
  const launchBinding = {
    schema: "drovr.launch-binding/v1",
    comparison_key: description.comparison_keys.launch,
    configuration_watermark: description.watermark.content_sha256,
    description_digest: description.description_digest,
  };
  const request = {
    callerKey: "run:1/card:review/attempt:1",
    callerMetadata,
    inputKey: "input:1",
    launchBinding,
    prompt: "inspect the candidate",
  };

  const dispatched = await dispatchTurn(agent.id, request, {
    env: fixture.env,
    herdr,
    now: () => "2026-07-23T10:00:00.000Z",
  });
  assert.equal(deliveries, 1);
  assert.equal(dispatched.turn.caller.dispatch_key, request.callerKey);

  const discovered = await discoverTurn(request.callerKey, {
    env: fixture.env,
  });
  assert.equal(discovered.discovery_status, "found");
  assert.equal(discovered.turn.id, dispatched.turn.id);

  const interruptedDelivery = (await readRecords(
    fixture.registryDirectory,
    "turns",
  )).find(({ id }) => id === dispatched.turn.id);
  interruptedDelivery.inputs[0].delivery = { status: "recorded" };
  await writeRecord(fixture.registryDirectory, "turns", interruptedDelivery);
  const reconcilingDispatch = await dispatchTurn(agent.id, request, {
    env: fixture.env,
    herdr,
  });
  assert.equal(reconcilingDispatch.dispatch_status, "reconciling");
  assert.equal(deliveries, 1);
  interruptedDelivery.inputs[0].delivery = {
    status: "submitted",
    accepted_at: "2026-07-23T10:00:00.000Z",
  };
  await writeRecord(fixture.registryDirectory, "turns", interruptedDelivery);

  const adopted = await dispatchTurn(agent.id, request, {
    env: fixture.env,
    herdr,
  });
  assert.equal(adopted.dispatch_status, "adopted");
  assert.equal(adopted.turn.id, dispatched.turn.id);
  assert.equal(deliveries, 1);

  const normalizedDispatchRetry = await dispatchTurn(agent.id, {
    ...request,
    prompt: `${request.prompt}\n`,
  }, { env: fixture.env, herdr });
  assert.equal(normalizedDispatchRetry.dispatch_status, "adopted");
  assert.equal(deliveries, 1);

  const otherLaunchDescription = await describeDelegatedAgent({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: { harness: "claude", capability: "read-only" },
    caller_metadata: callerMetadata,
  }, { env: fixture.env });
  await assert.rejects(
    () => dispatchTurn(agent.id, {
      ...request,
      callerKey: "run:1/card:wrong-agent/attempt:1",
      launchBinding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: otherLaunchDescription.comparison_keys.launch,
        configuration_watermark:
          otherLaunchDescription.watermark.content_sha256,
        description_digest: otherLaunchDescription.description_digest,
      },
    }, { env: fixture.env, herdr }),
    { outcome: "launch_binding_conflict" },
  );
  assert.equal(deliveries, 1);

  await assert.rejects(
    () => dispatchTurn(agent.id, { ...request, prompt: "different" }, {
      env: fixture.env,
      herdr,
    }),
    { outcome: "caller_key_conflict" },
  );

  const sent = await sendToTurn(dispatched.turn.id, {
    callerKey: "input:2",
    prompt: "prioritize correctness",
  }, { env: fixture.env, herdr });
  assert.equal(sent.turn.inputs.length, 2);
  assert.equal(deliveries, 2);

  const normalizedInputRetry = await sendToTurn(dispatched.turn.id, {
    callerKey: "input:2",
    prompt: "prioritize correctness\n",
  }, { env: fixture.env, herdr });
  assert.equal(normalizedInputRetry.input_status, "adopted");
  assert.equal(deliveries, 2);

  await assert.rejects(
    () => sendToTurn(dispatched.turn.id, {
      prompt: "unkeyed steering",
    }, { env: fixture.env, herdr }),
    { outcome: "invalid_arguments" },
  );
  assert.equal(deliveries, 2);

  const storedTurns = await readRecords(fixture.registryDirectory, "turns");
  const storedDispatch = storedTurns.find(({ id }) => id === dispatched.turn.id);
  storedDispatch.inputs[1].delivery = { status: "recorded" };
  await writeRecord(fixture.registryDirectory, "turns", storedDispatch);
  const uncertainInput = await sendToTurn(dispatched.turn.id, {
    callerKey: "input:2",
    prompt: "prioritize correctness",
  }, { env: fixture.env, herdr });
  assert.equal(uncertainInput.input_status, "reconciling");
  assert.equal(deliveries, 2);

  const resent = await sendToTurn(dispatched.turn.id, {
    callerKey: "input:2",
    prompt: "prioritize correctness",
  }, { env: fixture.env, herdr });
  assert.equal(resent.input_status, "reconciling");
  assert.equal(resent.turn.inputs.length, 2);
  assert.equal(deliveries, 2);

  const fencedLaterInput = await sendToTurn(dispatched.turn.id, {
    callerKey: "input:3",
    prompt: "do not overtake input two",
  }, { env: fixture.env, herdr });
  assert.equal(fencedLaterInput.input_status, "reconciling");
  assert.equal(fencedLaterInput.turn.inputs.length, 2);
  assert.equal(deliveries, 2);
  assert.deepEqual(
    turnCommandResult("turn send", fencedLaterInput).result.legal_next_actions,
    ["observe_bounded", "wait_bounded", "reconcile_exact_turn"],
  );

  const reconciledPendingInput = await reconcileTurn(
    dispatched.turn.id,
    { timeoutMs: 1 },
    { env: fixture.env, herdr },
  );
  assert.equal(reconciledPendingInput.wait_status, "still_running");
  assert.equal(deliveries, 2);

  await assert.rejects(
    () => sendToTurn(dispatched.turn.id, {
      callerKey: "input:2",
      prompt: "different steering",
    }, { env: fixture.env, herdr }),
    { outcome: "caller_key_conflict" },
  );

  const absent = await discoverTurn("run:1/card:missing/attempt:1", {
    env: fixture.env,
  });
  assert.equal(absent.discovery_status, "proven_absent");

  await appendFile(join(copiedConfig, "config.toml"), "\n# catalog drift\n");
  const adoptedAfterDrift = await dispatchTurn(agent.id, request, {
    env: fixture.env,
    herdr,
  });
  assert.equal(adoptedAfterDrift.dispatch_status, "adopted");
  assert.equal(adoptedAfterDrift.turn.id, dispatched.turn.id);
  await assert.rejects(
    () => dispatchTurn(agent.id, {
      ...request,
      callerKey: "run:1/card:other/attempt:1",
    }, { env: fixture.env, herdr }),
    { outcome: "launch_binding_conflict" },
  );
  const refreshedDescription = await describeDelegatedAgent({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: agent.launch.harness,
      model: agent.launch.model,
      effort: agent.launch.effort,
      capability: agent.launch.capability,
    },
    caller_metadata: callerMetadata,
  }, { env: fixture.env });
  await assert.rejects(
    () => dispatchTurn(agent.id, {
      ...request,
      callerKey: "run:1/card:fresh/attempt:1",
      launchBinding: {
        schema: "drovr.launch-binding/v1",
        comparison_key: refreshedDescription.comparison_keys.launch,
        configuration_watermark:
          refreshedDescription.watermark.content_sha256,
        description_digest: refreshedDescription.description_digest,
      },
    }, { env: fixture.env, herdr }),
    { outcome: "launch_binding_stale" },
  );
  const unboundAgent = (await readRecords(
    fixture.registryDirectory,
    "agents",
  )).find(({ id }) => id === agent.id);
  delete unboundAgent.launch_binding;
  await writeRecord(fixture.registryDirectory, "agents", unboundAgent);
  await assert.rejects(
    () => dispatchTurn(agent.id, {
      ...request,
      callerKey: "run:1/card:legacy/attempt:1",
    }, { env: fixture.env, herdr }),
    { outcome: "launch_binding_missing" },
  );
  assert.equal(deliveries, 2);
});

test("start refuses unknown staged Claude input before creating a logical turn", async (t) => {
  const fixture = await settledClaudeAgentFixture(t);
  const observed = {
    name: "managed-agent",
    pane_id: "pane-agent-1",
    agent_status: "idle",
    state_change_seq: 12,
    agent_session: { value: "claude-session-1" },
  };
  const herdr = {
    async ensureSession() {},
    async agentRecords() {
      return [observed];
    },
    async agentRecord() {
      return observed;
    },
    async inspectStagedInput() {
      return {
        token: stagedInputTextToken("operator staged work"),
        display_text: "operator staged work",
      };
    },
    async prompt() {
      assert.fail("a new prompt must not be delivered over staged input");
    },
  };

  await assert.rejects(
    startTurn(
      fixture.agent.id,
      { prompt: "new Drovr work" },
      { env: fixture.env, herdr },
    ),
    (error) => {
      assert.equal(error.outcome, "recovery_blocked");
      assert.equal(error.details.staged_input.ownership, "unknown");
      assert.equal(
        error.details.staged_input.token,
        bindStagedInputToken(stagedInputTextToken("operator staged work"), 12),
      );
      return true;
    },
  );
  assert.deepEqual(await readRecords(fixture.registryDirectory, "turns"), []);
});

test("failed delivery persists the exact Drovr-owned staged-input receipt", async (t) => {
  const fixture = await settledClaudeAgentFixture(t);
  const observed = {
    name: "managed-agent",
    pane_id: "pane-agent-1",
    agent_status: "idle",
    state_change_seq: 12,
    agent_session: { value: "claude-session-1" },
  };
  const token = "b".repeat(64);
  const herdr = {
    async ensureSession() {},
    async agentRecords() {
      return [observed];
    },
    async agentRecord() {
      return observed;
    },
    async inspectStagedInput() {
      return null;
    },
    async prompt() {
      const error = new Error("submission was not confirmed");
      error.details = {
        staged_input: {
          token,
          display_text: "new Drovr work",
          ownership: "drovr",
        },
      };
      throw error;
    },
  };

  await assert.rejects(
    startTurn(
      fixture.agent.id,
      { prompt: "new Drovr work" },
      { env: fixture.env, herdr },
    ),
    /submission was not confirmed/u,
  );

  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  assert.equal(turn.status, "uncertain");
  assert.deepEqual(turn.staged_input, {
    token,
    display_text: "new Drovr work",
    ownership: "drovr",
  });
});

test("cancel explicitly interrupts, confirms settlement, and leaves the agent reusable", async (t) => {
  const fixture = await turnFixture(t);
  let interrupted = false;
  const herdr = {
    async ensureSession() {},
    async agentRecord() {
      return {
        agent_status: interrupted ? "idle" : "working",
        agent_session: { value: "codex-session-1" },
      };
    },
    async interruptAgent(name) {
      assert.equal(name, "managed-agent");
      interrupted = true;
    },
    async waitForAgent() {
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
    async prompt() {},
  };

  const cancelled = await cancelTurn(
    fixture.turn.id,
    {},
    {
      env: fixture.env,
      herdr,
      now: () => "2026-07-23T10:00:02.000Z",
    },
  );

  assert.equal(cancelled.turn.status, "cancelled");
  assert.equal(cancelled.turn.settled_at, "2026-07-23T10:00:02.000Z");
  const started = await startTurn(
    fixture.turn.agent_id,
    { prompt: "later explicit work" },
    { env: fixture.env, herdr },
  );
  assert.equal(started.turn.status, "working");
  assert.equal(started.turn.inputs[0].text, "later explicit work");
});

test("cancel waits through Herdr's stale settled snapshot before interrupting", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.herdr = { state_change_seq_before_delivery: 7 };
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let observations = 0;
  let interrupted = false;
  const result = await cancelTurn(fixture.turn.id, {}, {
    env: fixture.env,
    delay: async () => {},
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        observations += 1;
        if (interrupted) {
          return {
            agent_status: "idle",
            state_change_seq: 9,
            agent_session: { value: "codex-session-1" },
          };
        }
        if (observations === 1) {
          return {
            agent_status: "done",
            state_change_seq: 7,
            agent_session: { value: "codex-session-1" },
          };
        }
        return {
          agent_status: "working",
          state_change_seq: 8,
          agent_session: { value: "codex-session-1" },
        };
      },
      async interruptAgent() {
        interrupted = true;
      },
    },
  });

  assert.equal(result.turn.status, "cancelled");
  assert.equal(interrupted, true);
  assert.ok(observations >= 4);
});

test("cancel does not interrupt a turn already owned by force cleanup", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.cleanup_requested_at = "2026-07-23T10:00:01.000Z";
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let herdrCalls = 0;

  const result = await cancelTurn(fixture.turn.id, {}, {
    env: fixture.env,
    herdr: {
      async ensureSession() {
        herdrCalls += 1;
      },
      async interruptAgent() {
        herdrCalls += 1;
      },
    },
  });

  assert.equal(result.command_status, "task_busy");
  assert.equal(herdrCalls, 0);
});

test("cancel settles uncertain when only a different native session is observable", async (t) => {
  const fixture = await turnFixture(t);
  let interrupts = 0;

  const result = await cancelTurn(fixture.turn.id, {}, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecords() {
        return [
          {
            name: "managed-agent",
            pane_id: "caller-pane",
            agent_status: "done",
            agent_session: { value: "caller-native-session" },
          },
        ];
      },
      async interruptAgent() {
        interrupts += 1;
      },
    },
    now: () => "2026-07-23T10:00:02.000Z",
  });

  assert.equal(result.command_status, "recovery_blocked");
  assert.equal(result.recovery_reason, "native_session_mismatch");
  assert.equal(result.turn.status, "uncertain");
  assert.match(result.turn.error, /cancellation could not proceed/u);
  assert.equal(interrupts, 0);
});

test("cancel reports uncertain when an idle prompt was never delivered", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.herdr = { state_change_seq_before_delivery: 7 };
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let interrupts = 0;
  const settled = {
    agent_status: "idle",
    state_change_seq: 7,
    agent_session: { value: "codex-session-1" },
  };

  const result = await cancelTurn(fixture.turn.id, {}, {
    env: fixture.env,
    herdr: {
      async ensureSession() {},
      async agentRecord() {
        return settled;
      },
      async waitForAgent() {
        return settled;
      },
      async interruptAgent() {
        interrupts += 1;
      },
    },
    wallClock: () => Date.parse("2026-07-23T10:00:06.000Z"),
  });

  assert.equal(result.turn.status, "uncertain");
  assert.equal(result.command_status, "uncertain");
  assert.equal(interrupts, 0);
});

test("failed interruption and ambiguous settlement never report cancellation", async (t) => {
  await t.test("failed interruption is uncertain", async (t) => {
    const fixture = await turnFixture(t);
    const result = await cancelTurn(fixture.turn.id, {}, {
      env: fixture.env,
      herdr: {
        async ensureSession() {},
        async agentRecord() {
          return {
            agent_status: "working",
            agent_session: { value: "codex-session-1" },
          };
        },
        async interruptAgent() {
          throw new Error("delivery failed");
        },
      },
    });
    assert.equal(result.turn.status, "uncertain");
    assert.match(result.turn.error, /could not be delivered/u);
  });

  await t.test("settlement timeout is interrupted", async (t) => {
    const fixture = await turnFixture(t);
    const herdr = {
      async ensureSession() {},
      async agentRecord() {
        return {
          agent_status: "working",
          agent_session: { value: "codex-session-1" },
        };
      },
      async interruptAgent() {},
      async waitForAgent() {
        return { drovr_status: "still_running" };
      },
    };
    const result = await cancelTurn(fixture.turn.id, { timeoutMs: 1 }, {
      env: fixture.env,
      herdr,
    });
    assert.equal(result.turn.status, "interrupted");
    assert.notEqual(result.turn.status, "cancelled");
    await assert.rejects(
      () =>
        startTurn(
          fixture.turn.agent_id,
          { prompt: "must not overlap native work" },
          { env: fixture.env, herdr },
        ),
      { outcome: "task_busy" },
    );
  });

  await t.test("different native settlement is uncertain", async (t) => {
    const fixture = await turnFixture(t);
    const result = await cancelTurn(fixture.turn.id, {}, {
      env: fixture.env,
      herdr: {
        async ensureSession() {},
        async agentRecord() {
          return {
            agent_status: "working",
            agent_session: { value: "codex-session-1" },
          };
        },
        async interruptAgent() {},
        async waitForAgent() {
          return {
            agent_status: "idle",
            agent_session: { value: "different-session" },
          };
        },
      },
    });
    assert.equal(result.turn.status, "uncertain");
    assert.notEqual(result.turn.status, "cancelled");
  });
});

test("read-only wait settles agent loss without launching recovery", async (t) => {
  const fixture = await turnFixture(t);
  let launches = 0;
  const result = await waitForTurn(fixture.turn.id, {}, {
    env: fixture.env,
    herdr: {
      async waitForAgent() {
        return { drovr_status: "agent_lost" };
      },
      async resumeCodexAgent() {
        launches += 1;
      },
    },
  });
  const [turn] = await readRecords(fixture.registryDirectory, "turns");

  assert.equal(result.turn.status, "uncertain");
  assert.equal(turn.status, "uncertain");
  assert.match(turn.error, /managed agent was lost while waiting/u);
  assert.equal(launches, 0);
});

test("turn send rejects a pane remapped after recovery validation", async (t) => {
  const fixture = await turnFixture(t);
  let prompts = 0;
  const result = await sendToTurn(
    fixture.turn.id,
    { prompt: "must not reach the caller" },
    {
      env: fixture.env,
      herdr: {
        async ensureSession() {},
        async agentRecords() {
          return [
            {
              name: "managed-agent",
              pane_id: "managed-pane",
              agent_status: "working",
              agent_session: { value: "codex-session-1" },
            },
          ];
        },
        async agentRecord() {
          return {
            name: "managed-agent",
            pane_id: "caller-pane",
            agent_status: "working",
            agent_session: { value: "caller-native-session" },
          };
        },
        async prompt() {
          prompts += 1;
        },
      },
      now: () => "2026-07-23T10:00:02.000Z",
    },
  );
  const [turn] = await readRecords(fixture.registryDirectory, "turns");

  assert.equal(result.turn.status, "uncertain");
  assert.match(result.turn.error, /different Codex native session/u);
  assert.equal(turn.inputs.length, 1);
  assert.equal(prompts, 0);
});

test("turn send binds a native session that appears after work begins", async (t) => {
  const fixture = await turnFixture(t);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  agent.native_session = null;
  await writeRecord(fixture.registryDirectory, "agents", agent);
  let prompts = 0;
  const result = await sendToTurn(
    fixture.turn.id,
    { prompt: "follow-up after native registration" },
    {
      env: fixture.env,
      herdr: {
        async ensureSession() {},
        async agentRecord() {
          return {
            agent_status: "working",
            agent_session: { value: "codex-session-1" },
          };
        },
        async prompt() {
          prompts += 1;
        },
      },
    },
  );
  const [persisted] = await readRecords(fixture.registryDirectory, "agents");

  assert.equal(result.turn.status, "working");
  assert.equal(result.turn.inputs.length, 2);
  assert.equal(persisted.native_session, "codex-session-1");
  assert.equal(prompts, 1);
});

test("turn send waits through Herdr's stale settled snapshot before steering", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.herdr = { state_change_seq_before_delivery: 7 };
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let observations = 0;
  let prompts = 0;
  const result = await sendToTurn(
    fixture.turn.id,
    { prompt: "steer after native activation" },
    {
      env: fixture.env,
      delay: async () => {},
      herdr: {
        async ensureSession() {},
        async agentRecord() {
          observations += 1;
          if (observations < 3) {
            return {
              agent_status: "done",
              state_change_seq: 7,
              agent_session: { value: "codex-session-1" },
            };
          }
          return {
            agent_status: "working",
            state_change_seq: 8,
            agent_session: { value: "codex-session-1" },
          };
        },
        async prompt() {
          prompts += 1;
        },
      },
    },
  );

  assert.equal(result.turn.status, "working");
  assert.equal(result.turn.inputs.length, 2);
  assert.equal(prompts, 1);
  assert.ok(observations >= 4);
});

test("wait rejects a settled caller pane without the durable native session", async (t) => {
  const fixture = await turnFixture(t);
  let clockMs = 0;

  const result = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 1 },
    {
      env: fixture.env,
      herdr: {
        async waitForAgent() {
          return {
            name: "caller-agent",
            pane_id: "caller-pane",
            agent_status: "done",
          };
        },
      },
      clock: () => clockMs,
      async delay(milliseconds) {
        clockMs += milliseconds;
      },
    },
  );

  assert.equal(result.turn.status, "uncertain");
  assert.match(result.turn.error, /did not report the Codex native session/u);
});

test("wait rejects a blocked caller pane without reading its excerpt", async (t) => {
  const fixture = await turnFixture(t);
  let excerptReads = 0;

  const result = await waitForTurn(fixture.turn.id, {}, {
    env: fixture.env,
    herdr: {
      async waitForAgent() {
        return {
          name: "managed-agent",
          pane_id: "caller-pane",
          agent_status: "blocked",
          agent_session: { value: "caller-native-session" },
        };
      },
      async agentExcerpt() {
        excerptReads += 1;
        return "caller pane contents";
      },
    },
  });

  assert.equal(result.turn.status, "uncertain");
  assert.match(result.turn.error, /different Codex native session/u);
  assert.equal(excerptReads, 0);
});

test("wait retries when a steering input is recorded after settlement observation begins", async (t) => {
  const fixture = await turnFixture(t);
  await appendTranscript(fixture.transcript, userMessage("initial"));
  let waitCalls = 0;
  const herdr = {
    async waitForAgent() {
      waitCalls += 1;
      if (waitCalls === 1) {
        const [turn] = await readRecords(fixture.registryDirectory, "turns");
        appendTurnInput(turn, {
          text: "steer",
          submittedAt: "2026-07-23T10:00:01.000Z",
        });
        await writeRecord(fixture.registryDirectory, "turns", turn);
        await appendTranscript(
          fixture.transcript,
          userMessage("steer"),
          assistantMessage("settled after steering"),
        );
      }
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const context = await waitForTurn(
    fixture.turn.id,
    {},
    {
      env: fixture.env,
      herdr,
    },
  );

  assert.equal(waitCalls, 2);
  assert.equal(context.turn.status, "completed");
  assert.equal(context.turn.result.text, "settled after steering");
  assert.equal(context.turn.inputs.length, 2);
});

test("wait rejects a stale idle observation until the submitted input reaches the transcript", async (t) => {
  const fixture = await turnFixture(t);
  let waitCalls = 0;
  const herdr = {
    async waitForAgent() {
      waitCalls += 1;
      if (waitCalls === 2) {
        await appendTranscript(
          fixture.transcript,
          userMessage("initial"),
          assistantMessage("settled after delivery"),
        );
      }
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const context = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 1000 },
    {
      env: fixture.env,
      herdr,
    },
  );

  assert.equal(waitCalls, 2);
  assert.equal(context.turn.status, "completed");
  assert.equal(context.turn.result.text, "settled after delivery");
});

test("wait settles unobserved prompt delivery as uncertain after a bounded grace", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.herdr = { state_change_seq_before_delivery: 7 };
  await writeRecord(fixture.registryDirectory, "turns", turn);
  let clockMs = 0;

  const context = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 1 },
    {
      env: fixture.env,
      herdr: {
        async waitForAgent() {
          return {
            agent_status: "idle",
            state_change_seq: 7,
            agent_session: { value: "codex-session-1" },
          };
        },
      },
      clock: () => clockMs,
      wallClock: () => Date.parse("2026-07-23T10:00:06.000Z"),
      async delay(milliseconds) {
        clockMs += milliseconds;
      },
    },
  );

  assert.equal(context.turn.status, "uncertain");
  assert.match(
    context.turn.error,
    /submitted input was not observed after the transcript cursor/u,
  );
});

test("wait starts transcript grace after a newer Herdr settlement", async (t) => {
  const fixture = await settledClaudeAgentFixture(t);
  let clockMs = 0;
  let waitCalls = 0;
  const herdr = {
    async ensureSession() {},
    async agentRecord() {
      return {
        agent_status: "idle",
        state_change_seq: 7,
        agent_session: { value: "claude-session-1" },
      };
    },
    async prompt(_name, prompt) {
      await appendTranscript(
        fixture.transcript,
        claudeUserMessage(prompt),
      );
    },
    async waitForAgent() {
      waitCalls += 1;
      if (waitCalls === 2) clockMs += 70_000;
      if (waitCalls === 3) {
        await appendTranscript(
          fixture.transcript,
          claudeAssistantMessage("settled after actual idle"),
        );
      }
      return {
        agent_status: "idle",
        state_change_seq: waitCalls === 1 ? 7 : 9,
        agent_session: { value: "claude-session-1" },
      };
    },
  };
  const started = await startTurn(
    fixture.agent.id,
    { prompt: "initial" },
    { env: fixture.env, herdr },
  );

  const context = await waitForTurn(
    started.turn.id,
    { timeoutMs: 120_000 },
    {
      env: fixture.env,
      herdr,
      clock: () => clockMs,
      delay: async () => {},
    },
  );

  assert.equal(waitCalls, 3);
  assert.equal(context.turn.status, "completed");
  assert.equal(context.turn.result.text, "settled after actual idle");
});

test("wait allows the native final result to flush after Herdr reports idle", async (t) => {
  const fixture = await turnFixture(t);
  await appendTranscript(fixture.transcript, userMessage("initial"));
  let waitCalls = 0;
  const herdr = {
    async waitForAgent() {
      waitCalls += 1;
      if (waitCalls === 2) {
        await appendTranscript(
          fixture.transcript,
          assistantMessage("flushed native result"),
        );
      }
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const context = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 1000 },
    {
      env: fixture.env,
      herdr,
    },
  );

  assert.equal(waitCalls, 2);
  assert.equal(context.turn.status, "completed");
  assert.equal(context.turn.result.text, "flushed native result");
});

test("wait grants transcript flush time after the actual native settlement", async (t) => {
  const fixture = await turnFixture(t);
  let waitCalls = 0;
  let clockMs = 0;
  const herdr = {
    async waitForAgent() {
      waitCalls += 1;
      if (waitCalls === 2) {
        clockMs += 70_000;
        await appendTranscript(fixture.transcript, userMessage("initial"));
      }
      if (waitCalls === 3) {
        await appendTranscript(
          fixture.transcript,
          assistantMessage("flushed after actual settlement"),
        );
      }
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const context = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 120_000 },
    {
      env: fixture.env,
      herdr,
      clock: () => clockMs,
      delay: async () => {},
    },
  );

  assert.equal(waitCalls, 3);
  assert.equal(context.turn.status, "completed");
  assert.equal(
    context.turn.result.text,
    "flushed after actual settlement",
  );
});

test("get discovers a late result only after the exact recorded inputs", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  appendTurnInput(turn, {
    text: "steer",
    submittedAt: "2026-07-23T10:00:01.000Z",
  });
  turn.status = "uncertain";
  turn.error = "no completed Codex assistant result followed the final input";
  turn.settled_at = "2026-07-23T10:00:02.000Z";
  await writeRecord(fixture.registryDirectory, "turns", turn);
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("intermediate"),
    userMessage("steer"),
    assistantMessage("late settled result"),
  );

  const context = await getTurn(fixture.turn.id, { env: fixture.env });
  const [stored] = await readRecords(fixture.registryDirectory, "turns");

  assert.equal(context.turn.status, "uncertain");
  assert.equal(context.late_result.text, "late settled result");
  assert.deepEqual(context.late_result.messages, [
    "intermediate",
    "late settled result",
  ]);
  assert.equal(stored.status, "uncertain");
  assert.equal(stored.result, undefined);
});

test("get quarantines a late result after restart interruption", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "interrupted";
  turn.settled_at = "2026-07-23T10:00:02.000Z";
  await writeRecord(fixture.registryDirectory, "turns", turn);
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("late after restart"),
  );

  const context = await getTurn(fixture.turn.id, { env: fixture.env });

  assert.equal(context.turn.status, "interrupted");
  assert.equal(context.late_result.text, "late after restart");
});

test("get recovers legacy unsupported-transcript turns after the transcript appears", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.status = "unsupported_transcript";
  turn.error = "Codex transcript not found for native session codex-session-1";
  turn.late_result_recovery = "exact_transcript_correlation";
  turn.settled_at = "2026-07-23T10:00:02.000Z";
  await writeRecord(fixture.registryDirectory, "turns", turn);
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("late legacy result"),
  );

  const context = await getTurn(fixture.turn.id, { env: fixture.env });

  assert.equal(context.turn.status, "unsupported_transcript");
  assert.equal(context.late_result.text, "late legacy result");
});

test("get rejects a late result when an unrecorded input interrupts the recorded order", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  appendTurnInput(turn, {
    text: "steer",
    submittedAt: "2026-07-23T10:00:01.000Z",
  });
  turn.status = "uncertain";
  turn.error = "no completed Codex assistant result followed the final input";
  turn.settled_at = "2026-07-23T10:00:02.000Z";
  await writeRecord(fixture.registryDirectory, "turns", turn);
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    userMessage("unrecorded input"),
    userMessage("steer"),
    assistantMessage("unrelated later result"),
  );

  const context = await getTurn(fixture.turn.id, { env: fixture.env });

  assert.equal(context.turn.status, "uncertain");
  assert.equal(context.late_result, undefined);
});

test("get recovers a late result after a known failed Claude prompt was concatenated", async (t) => {
  const fixture = await settledClaudeAgentFixture(t);
  const staleTurn = createTurnRecord({
    id: "stale-turn",
    agentId: fixture.agent.id,
    taskId: fixture.agent.task_id,
    prompt: "stale staged prompt",
    submittedAt: "2026-07-23T10:00:00.000Z",
    transcriptCursor: await captureClaudeTranscriptCursor(fixture.transcript),
  });
  staleTurn.status = "uncertain";
  staleTurn.error =
    "Herdr did not expose Claude's staged attachment for managed-agent";
  staleTurn.settled_at = "2026-07-23T10:00:01.000Z";
  await writeRecord(fixture.registryDirectory, "turns", staleTurn);

  const currentTurn = createTurnRecord({
    id: "current-turn",
    agentId: fixture.agent.id,
    taskId: fixture.agent.task_id,
    prompt: "current prompt",
    submittedAt: "2026-07-23T10:00:02.000Z",
    transcriptCursor: await captureClaudeTranscriptCursor(fixture.transcript),
  });
  currentTurn.status = "uncertain";
  currentTurn.error = "submitted input was not observed after the transcript cursor";
  currentTurn.late_result_recovery = "exact_transcript_correlation";
  currentTurn.settled_at = "2026-07-23T10:00:03.000Z";
  await writeRecord(fixture.registryDirectory, "turns", currentTurn);
  await appendTranscript(
    fixture.transcript,
    claudeUserMessage("stale staged promptcurrent prompt"),
    claudeAssistantMessage("recovered review"),
  );

  const context = await getTurn(currentTurn.id, { env: fixture.env });

  assert.equal(context.turn.status, "uncertain");
  assert.equal(context.late_result.text, "recovered review");
});

test("wait allows Herdr's native session identity to appear after delivery", async (t) => {
  const fixture = await turnFixture(t);
  const [agent] = await readRecords(fixture.registryDirectory, "agents");
  agent.native_session = null;
  await writeRecord(fixture.registryDirectory, "agents", agent);
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("identified native result"),
  );
  let waitCalls = 0;
  const herdr = {
    async waitForAgent() {
      waitCalls += 1;
      return {
        agent_status: "idle",
        ...(waitCalls === 2
          ? { agent_session: { value: "codex-session-1" } }
          : {}),
      };
    },
  };

  const context = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 1000 },
    {
      env: fixture.env,
      herdr,
    },
  );

  assert.equal(waitCalls, 2);
  assert.equal(context.agent.native_session, "codex-session-1");
  assert.equal(context.turn.status, "completed");
  assert.equal(context.turn.result.text, "identified native result");
});

test("ordinary waits reuse one block record while the blocked transition remains active", async (t) => {
  const fixture = await turnFixture(t);
  const herdr = {
    async waitForAgent() {
      return {
        agent_status: "blocked",
        agent_session: { value: "codex-session-1" },
      };
    },
    async agentExcerpt() {
      return "Approval required\n";
    },
  };

  const first = await waitForTurn(fixture.turn.id, {}, { env: fixture.env, herdr });
  const second = await waitForTurn(fixture.turn.id, {}, { env: fixture.env, herdr });
  const blocks = await readRecords(fixture.registryDirectory, "blocks");

  assert.equal(first.block.id, second.block.id);
  assert.equal(blocks.length, 1);
  assert.equal(first.block.turn_id, fixture.turn.id);
  assert.equal(first.block.agent_id, fixture.turn.agent_id);
  assert.equal(first.block.task_id, fixture.turn.task_id);
  assert.equal(first.block.harness, "codex");
  assert.equal(first.block.excerpt, "Approval required\n");
  assert.deepEqual(first.block.attach, { command: "drovr attach agent-1" });
});

test("blocked excerpts are captured without holding the turn registry lock", async (t) => {
  const fixture = await turnFixture(t);
  const safeKey = createHash("sha256")
    .update(`turn:${fixture.turn.id}`)
    .digest("hex");
  const lockPath = join(fixture.registryDirectory, "locks", safeKey);
  const herdr = {
    async waitForAgent() {
      return {
        agent_status: "blocked",
        agent_session: { value: "codex-session-1" },
      };
    },
    async agentExcerpt() {
      await assert.rejects(access(lockPath), { code: "ENOENT" });
      return "Approval required\n";
    },
  };

  const result = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr },
  );

  assert.equal(result.block.excerpt, "Approval required\n");
});

test("after-block durably acknowledges the current block and observes working before settlement", async (t) => {
  const fixture = await turnFixture(t);
  const blockedHerdr = {
    async waitForAgent() {
      return {
        agent_status: "blocked",
        agent_session: { value: "codex-session-1" },
      };
    },
    async agentExcerpt() {
      return "Approve in Codex\n";
    },
  };
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr: blockedHerdr },
  );
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("native result after approval"),
  );
  const statuses = ["blocked", "idle", "working"];
  let agentRecordCalls = 0;
  const resumedHerdr = {
    async agentRecord() {
      const agent_status = statuses[Math.min(agentRecordCalls, statuses.length - 1)];
      agentRecordCalls += 1;
      return {
        agent_status,
        agent_session: { value: "codex-session-1" },
      };
    },
    async waitForAgent() {
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const completed = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1000 },
    {
      env: fixture.env,
      herdr: resumedHerdr,
      delay: async () => {},
      now: () => "2026-07-23T10:00:05.000Z",
    },
  );
  const [block] = await readRecords(fixture.registryDirectory, "blocks");

  assert.equal(completed.turn.status, "completed");
  assert.equal(completed.turn.result.text, "native result after approval");
  assert.equal(agentRecordCalls, 3);
  assert.equal(block.status, "resolved");
  assert.equal(block.acknowledged_at, "2026-07-23T10:00:05.000Z");
  assert.equal(block.working_observed_at, "2026-07-23T10:00:05.000Z");
  assert.equal(block.resolved_at, "2026-07-23T10:00:05.000Z");
});

test("after-block accepts durable resume evidence when resolution finished before waiting", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    {
      env: fixture.env,
      herdr: blockedHerdr("Approve in Codex\n", 20),
    },
  );
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("native result already settled after approval"),
  );
  let agentRecordCalls = 0;
  const resumedHerdr = {
    async agentRecord() {
      agentRecordCalls += 1;
      return {
        agent_status: "idle",
        state_change_seq: 22,
        agent_session: { value: "codex-session-1" },
      };
    },
    async waitForAgent() {
      return {
        agent_status: "idle",
        state_change_seq: 22,
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const completed = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1000 },
    {
      env: fixture.env,
      herdr: resumedHerdr,
      delay: async () => {},
      now: () => "2026-07-23T10:00:05.000Z",
    },
  );
  const [block] = await readRecords(fixture.registryDirectory, "blocks");

  assert.equal(agentRecordCalls, 1);
  assert.equal(completed.turn.status, "completed");
  assert.equal(
    completed.turn.result.text,
    "native result already settled after approval",
  );
  assert.equal(block.status, "resolved");
  assert.equal(
    block.working_observation,
    "herdr_state_changed_before_settlement",
  );
});

test("a later blocked transition supersedes the acknowledged block with a new ID", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    {
      env: fixture.env,
      herdr: blockedHerdr("First approval\n"),
    },
  );
  let excerptCalls = 0;
  const herdr = {
    async agentRecord() {
      return {
        agent_status: "working",
        agent_session: { value: "codex-session-1" },
      };
    },
    async waitForAgent() {
      return {
        agent_status: "blocked",
        agent_session: { value: "codex-session-1" },
      };
    },
    async agentExcerpt() {
      excerptCalls += 1;
      return "Second approval\n";
    },
  };

  const second = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1000 },
    { env: fixture.env, herdr },
  );
  const blocks = await readRecords(fixture.registryDirectory, "blocks");
  const firstRecord = blocks.find(({ id }) => id === surfaced.block.id);

  assert.equal(second.turn.status, "working");
  assert.notEqual(second.block.id, surfaced.block.id);
  assert.equal(second.block.excerpt, "Second approval\n");
  assert.equal(excerptCalls, 1);
  assert.equal(firstRecord.status, "superseded");
  assert.equal(firstRecord.superseded_by, second.block.id);
  assert.equal(blocks.length, 2);
});

test("a changed Herdr state token surfaces a fast later blocked transition", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    {
      env: fixture.env,
      herdr: blockedHerdr("First approval\n", 10),
    },
  );
  const herdr = {
    async agentRecord() {
      return {
        agent_status: "blocked",
        state_change_seq: 12,
        agent_session: { value: "codex-session-1" },
      };
    },
    async agentExcerpt() {
      return "Second approval\n";
    },
  };

  const second = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1000 },
    { env: fixture.env, herdr },
  );
  const blocks = await readRecords(fixture.registryDirectory, "blocks");
  const firstRecord = blocks.find(({ id }) => id === surfaced.block.id);

  assert.notEqual(second.block.id, surfaced.block.id);
  assert.deepEqual(second.block.herdr, { state_change_seq: 12 });
  assert.equal(second.block.excerpt, "Second approval\n");
  assert.equal(firstRecord.status, "superseded");
  assert.equal(firstRecord.superseded_by, second.block.id);
});

test("after-block reloads a working observation persisted by another waiter", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr: blockedHerdr("Approval\n") },
  );
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("native result after concurrent wait"),
  );
  let agentRecordCalls = 0;
  const herdr = {
    async agentRecord() {
      agentRecordCalls += 1;
      const [block] = await readRecords(fixture.registryDirectory, "blocks");
      block.working_observed_at = "2026-07-23T10:00:07.000Z";
      await writeRecord(fixture.registryDirectory, "blocks", block);
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
    async waitForAgent() {
      return {
        agent_status: "idle",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const completed = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1000 },
    { env: fixture.env, herdr, delay: async () => {} },
  );

  assert.equal(agentRecordCalls, 1);
  assert.equal(completed.turn.status, "completed");
  assert.equal(completed.turn.result.text, "native result after concurrent wait");
});

test("an ordinary waiter cannot settle an acknowledged block before working is observed", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr: blockedHerdr("Approval\n") },
  );
  const acknowledgementClock = [0, 1];
  await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1 },
    {
      env: fixture.env,
      herdr: { async agentRecord() {} },
      clock: () => acknowledgementClock.shift(),
    },
  );
  await appendTranscript(
    fixture.transcript,
    userMessage("initial"),
    assistantMessage("must not settle yet"),
  );
  const ordinaryClock = [0, 0, 1];
  const result = await waitForTurn(
    fixture.turn.id,
    { timeoutMs: 1 },
    {
      env: fixture.env,
      herdr: {
        async waitForAgent() {
          return {
            agent_status: "idle",
            agent_session: { value: "codex-session-1" },
          };
        },
      },
      clock: () => ordinaryClock.shift(),
      delay: async () => {},
    },
  );

  assert.equal(result.wait_status, "still_running");
  assert.equal(result.turn.status, "working");
  assert.equal(result.turn.result, undefined);
});

test("after-block surfaces a newer block created while recording working", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr: blockedHerdr("First approval\n") },
  );
  const newer = createBlockRecord({
    id: "newer-block",
    turnId: fixture.turn.id,
    agentId: fixture.turn.agent_id,
    taskId: fixture.turn.task_id,
    harness: "codex",
    excerpt: "Second approval\n",
    createdAt: "2026-07-23T10:00:08.000Z",
  });
  const herdr = {
    async agentRecord() {
      const [turn] = await readRecords(fixture.registryDirectory, "turns");
      turn.block_ids.push(newer.id);
      await writeRecord(fixture.registryDirectory, "turns", turn);
      await writeRecord(fixture.registryDirectory, "blocks", newer);
      return {
        agent_status: "working",
        agent_session: { value: "codex-session-1" },
      };
    },
  };

  const result = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1000 },
    { env: fixture.env, herdr },
  );

  assert.equal(result.block.id, newer.id);
  assert.equal(result.block.excerpt, "Second approval\n");
});

test("after-block rejects unknown, cross-turn, non-current, and superseded block IDs", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr: blockedHerdr("Approval\n") },
  );

  await assert.rejects(
    () =>
      waitForTurn(
        fixture.turn.id,
        { afterBlockId: "unknown-block" },
        { env: fixture.env },
      ),
    { message: "block not found: unknown-block", outcome: "invalid_arguments" },
  );

  await writeRecord(fixture.registryDirectory, "blocks", {
    ...surfaced.block,
    id: "another-turn-block",
    turn_id: "turn-2",
  });
  await assert.rejects(
    () =>
      waitForTurn(
        fixture.turn.id,
        { afterBlockId: "another-turn-block" },
        { env: fixture.env },
      ),
    {
      message: "block another-turn-block belongs to another logical turn",
      outcome: "invalid_arguments",
    },
  );

  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.block_ids.push("newer-current-block");
  await writeRecord(fixture.registryDirectory, "turns", turn);
  await assert.rejects(
    () =>
      waitForTurn(
        fixture.turn.id,
        { afterBlockId: surfaced.block.id },
        { env: fixture.env },
      ),
    {
      message: `block ${surfaced.block.id} is not the current block`,
      outcome: "invalid_arguments",
    },
  );

  const blocks = await readRecords(fixture.registryDirectory, "blocks");
  const original = blocks.find(({ id }) => id === surfaced.block.id);
  original.status = "superseded";
  await writeRecord(fixture.registryDirectory, "blocks", original);
  await assert.rejects(
    () =>
      waitForTurn(
        fixture.turn.id,
        { afterBlockId: surfaced.block.id },
        { env: fixture.env },
      ),
    {
      message: `block ${surfaced.block.id} has already been superseded`,
      outcome: "invalid_arguments",
    },
  );
});

test("a turn that references a missing current block is corrupt registry state", async (t) => {
  const fixture = await turnFixture(t);
  const [turn] = await readRecords(fixture.registryDirectory, "turns");
  turn.block_ids = ["missing-block"];
  await writeRecord(fixture.registryDirectory, "turns", turn);

  await assert.rejects(
    () =>
      waitForTurn(
        fixture.turn.id,
        { afterBlockId: "missing-block" },
        { env: fixture.env },
      ),
    {
      message: `registry record ${fixture.turn.id} references missing block missing-block`,
      outcome: "corrupt_registry",
    },
  );
});

test("after-block timeout preserves the acknowledged turn for a later waiter", async (t) => {
  const fixture = await turnFixture(t);
  const surfaced = await waitForTurn(
    fixture.turn.id,
    {},
    { env: fixture.env, herdr: blockedHerdr("Approval\n") },
  );
  const clockValues = [0, 1];
  const timed = await waitForTurn(
    fixture.turn.id,
    { afterBlockId: surfaced.block.id, timeoutMs: 1 },
    {
      env: fixture.env,
      herdr: {
        async agentRecord() {
          throw new Error("the expired waiter must not touch Herdr");
        },
      },
      clock: () => clockValues.shift(),
      now: () => "2026-07-23T10:00:06.000Z",
    },
  );
  const [acknowledged] = await readRecords(
    fixture.registryDirectory,
    "blocks",
  );

  assert.equal(timed.wait_status, "still_running");
  assert.equal(timed.turn.status, "working");
  assert.equal(acknowledged.status, "acknowledged");
  assert.equal(
    acknowledged.acknowledged_at,
    "2026-07-23T10:00:06.000Z",
  );
  assert.equal(acknowledged.working_observed_at, undefined);
});

async function turnFixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-turn-race-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const codexHome = join(scratch, "codex");
  const transcriptDirectory = join(codexHome, "sessions");
  await mkdir(transcriptDirectory, { recursive: true });
  const transcript = join(transcriptDirectory, "rollout-codex-session-1.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-session-1", cwd: scratch },
    })}\n`,
  );
  const cursor = await captureTranscriptCursor(transcript);
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const registryDirectory = stateDirectory(env);
  const group = {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "group",
    label: "Group",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  };
  const task = {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: group.id,
    key: "task",
    label: "Task",
    cwd: scratch,
    status: "active",
  };
  const agent = {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: task.id,
    key: "agent",
    label: "Agent",
    status: "active",
    launch: {
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      capability: "on-approve",
    },
    herdr: { name: "managed-agent" },
    native_session: "codex-session-1",
  };
  const turn = createTurnRecord({
    id: "turn-1",
    agentId: agent.id,
    taskId: task.id,
    prompt: "initial",
    submittedAt: "2026-07-23T10:00:00.000Z",
    transcriptCursor: cursor,
  });
  await writeRecord(registryDirectory, "groups", group);
  await writeRecord(registryDirectory, "tasks", task);
  await writeRecord(registryDirectory, "agents", agent);
  await writeRecord(registryDirectory, "turns", turn);
  return { env, registryDirectory, transcript, turn };
}

async function settledClaudeAgentFixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-claude-turn-race-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeHome = join(scratch, "claude");
  const transcriptDirectory = join(claudeHome, "projects", "test-project");
  await mkdir(transcriptDirectory, { recursive: true });
  const transcript = join(transcriptDirectory, "claude-session-1.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      sessionId: "claude-session-1",
      cwd: scratch,
      message: { role: "user", content: "earlier request" },
    })}\n`,
  );
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    XDG_STATE_HOME: join(scratch, "state"),
    DROVR_CONFIG_DIR: join(root, "config", "drovr"),
  };
  const registryDirectory = stateDirectory(env);
  const group = {
    schema: "drovr.group/v1",
    id: "group-1",
    key: "group",
    label: "Group",
    status: "active",
    herdr: { session: "persisted-session", workspace_id: "workspace-1" },
  };
  const task = {
    schema: "drovr.task/v1",
    id: "task-1",
    group_id: group.id,
    key: "task",
    label: "Task",
    cwd: scratch,
    status: "active",
  };
  const agent = {
    schema: "drovr.agent/v1",
    id: "agent-1",
    task_id: task.id,
    key: "agent",
    label: "Agent",
    status: "active",
    launch: {
      harness: "claude",
      model: "opus",
      effort: "medium",
      capability: "read-only",
    },
    herdr: { name: "managed-agent" },
    native_session: "claude-session-1",
  };
  await writeRecord(registryDirectory, "groups", group);
  await writeRecord(registryDirectory, "tasks", task);
  await writeRecord(registryDirectory, "agents", agent);
  return { agent, env, registryDirectory, transcript };
}

async function appendTranscript(path, ...records) {
  await appendFile(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

function userMessage(text) {
  return {
    type: "event_msg",
    payload: { type: "user_message", message: text },
  };
}

function assistantMessage(text) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  };
}

function claudeUserMessage(text) {
  return {
    type: "user",
    sessionId: "claude-session-1",
    message: { role: "user", content: text },
  };
}

function claudeAssistantMessage(text) {
  return {
    type: "assistant",
    sessionId: "claude-session-1",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  };
}

function blockedHerdr(excerpt, stateChangeSeq) {
  return {
    async waitForAgent() {
      return {
        agent_status: "blocked",
        ...(stateChangeSeq === undefined
          ? {}
          : { state_change_seq: stateChangeSeq }),
        agent_session: { value: "codex-session-1" },
      };
    },
    async agentExcerpt() {
      return excerpt;
    },
  };
}

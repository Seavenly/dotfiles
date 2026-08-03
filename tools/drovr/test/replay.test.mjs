import assert from "node:assert/strict";
import test from "node:test";

import { TRACE_SCHEMA } from "../src/trace.mjs";
import {
  ReplayError,
  createReplayHarness,
} from "../src/harness-replay.mjs";

function trace(events) {
  return {
    schema: TRACE_SCHEMA,
    version: 1,
    scenario_id: "replay-test",
    provenance: {
      drovr: "source sha256:drovr",
      herdr: "herdr 0.7.5",
      claude: "not_applicable",
      codex: "codex-cli 0.145.0",
    },
    events,
  };
}

function agent(status, stateChangeSeq = 1) {
  return {
    name: "managed-agent",
    agent_status: status,
    state_change_seq: stateChangeSeq,
    pane_id: "pane-1",
    agent_session: { value: "native-1" },
  };
}

function command(sequence, operation, envelope, at_ms = 0) {
  return {
    sequence,
    at_ms,
    kind: "command_result",
    operation,
    payload: { envelope },
  };
}

test("replay follows ordered semantic observations and advances its clock without sleeping", async () => {
  const replay = createReplayHarness(
    trace([
      command(1, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("idle")] },
      }),
      command(2, "agent.prompt", {
        schema: "herdr.command/v1",
        result: { status: "accepted" },
      }),
      {
        sequence: 3,
        at_ms: 10,
        kind: "delay",
        operation: "clock.delay",
        payload: { duration_ms: 25 },
      },
      command(4, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("working", 2)] },
      }, 25),
      command(5, "agent.wait", {
        schema: "herdr.command/v1",
        result: { agent: agent("done", 2) },
      }, 25),
    ]),
    { harness: "codex" },
  );

  assert.equal(replay.clock.now(), 0);
  assert.equal((await replay.client.agentRecord("managed-agent")).agent_status, "idle");
  await replay.client.prompt("managed-agent", "QUALIFY-REPLAY-OK", {
    harness: "codex",
    observedBeforeDelivery: agent("idle"),
  });
  assert.equal(replay.clock.now(), 0);
  await replay.clock.delay(25);
  assert.equal(replay.clock.now(), 25);
  assert.equal(
    (await replay.client.waitForAgent("managed-agent", 100)).agent_status,
    "done",
  );
  assert.equal(replay.remainingEvents().length, 0);
});

test("replay rejects an out-of-order semantic operation instead of returning a canned result", async () => {
  const replay = createReplayHarness(
    trace([
      command(1, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("idle")] },
      }),
    ]),
    { harness: "codex" },
  );

  await assert.rejects(
    () => replay.client.prompt("managed-agent", "QUALIFY-REPLAY-OK", {
      harness: "codex",
      observedBeforeDelivery: agent("idle"),
    }),
    (error) =>
      error.adapterFailure instanceof ReplayError &&
      /agent\.prompt/u.test(error.adapterFailure.message),
  );
});

test("replay rejects a target or input that differs from the captured request", async () => {
  const replay = createReplayHarness(
    trace([
      {
        sequence: 1,
        at_ms: 0,
        kind: "command_result",
        operation: "agent.prompt",
        payload: {
          request: {
            resource: "agent",
            action: "prompt",
            target: "managed-agent",
            input: { sentinel: "QUALIFY-REQUEST-OK" },
          },
          envelope: {
            schema: "herdr.command/v1",
            result: { status: "accepted" },
          },
        },
      },
    ]),
  );

  await assert.rejects(
    () =>
      replay.client.prompt("other-agent", "QUALIFY-REQUEST-OK", {
        harness: "codex",
        observedBeforeDelivery: agent("working"),
      }),
    (error) =>
      error.adapterFailure instanceof ReplayError &&
      /request.*does not match/u.test(error.adapterFailure.message),
  );
});

test("replay surfaces captured Herdr error envelopes through the semantic client", async () => {
  const replay = createReplayHarness(
    trace([
      {
        sequence: 1,
        at_ms: 0,
        kind: "error",
        operation: "agent.prompt",
        payload: {
          error: {
            code: "pane_not_found",
            outcome: "adapter_failure",
            message: "managed pane is gone",
          },
        },
      },
    ]),
    { harness: "codex" },
  );

  await assert.rejects(
    () => replay.client.prompt("managed-agent", "QUALIFY-REPLAY-OK", {
      harness: "codex",
      observedBeforeDelivery: agent("working"),
    }),
    (error) =>
      error.outcome === "adapter_failure" &&
      error.adapterFailure?.stderr.includes("pane_not_found"),
  );
});

test("replay transcript events become visible only after the clock reaches their recorded delay", async () => {
  const replay = createReplayHarness(
    trace([
      {
        sequence: 1,
        at_ms: 10,
        kind: "transcript_event",
        operation: "transcript.read",
        payload: {
          harness: "codex",
          record: {
            type: "event_msg",
            payload: { type: "user_message", message: "QUALIFY-DELAYED-INPUT" },
          },
        },
      },
      {
        sequence: 2,
        at_ms: 10,
        kind: "transcript_event",
        operation: "transcript.read",
        payload: {
          harness: "codex",
          record: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "QUALIFY-DELAYED-OK" }],
            },
          },
        },
      },
      {
        sequence: 3,
        at_ms: 10,
        kind: "delay",
        operation: "clock.delay",
        payload: { duration_ms: 10 },
      },
    ]),
  );
  const cursor = await replay.transcript.captureCursor();

  await assert.rejects(
    () => replay.transcript.extract({ ...cursor, adapter: "other/v1" }, ["QUALIFY-DELAYED-INPUT"]),
    (error) => error instanceof ReplayError && /does not belong/u.test(error.message),
  );

  await assert.rejects(
    () => replay.transcript.extract(cursor, ["QUALIFY-DELAYED-INPUT"]),
    (error) => error.details?.correlation_pending === true,
  );
  await replay.clock.delay(10);
  assert.equal(
    (await replay.transcript.extract(cursor, ["QUALIFY-DELAYED-INPUT"])).text,
    "QUALIFY-DELAYED-OK",
  );
});

test("replay does not skip a future transcript event for a semantic operation", async () => {
  const replay = createReplayHarness(
    trace([
      {
        sequence: 1,
        at_ms: 10,
        kind: "transcript_event",
        operation: "transcript.read",
        payload: {
          harness: "codex",
          record: { type: "event_msg", payload: { type: "user_message", message: "QUALIFY-ORDER-INPUT" } },
        },
      },
      command(2, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("idle")] },
      }, 10),
    ]),
  );

  await assert.rejects(
    () => replay.client.agentRecord("managed-agent"),
    (error) =>
      error.adapterFailure instanceof ReplayError &&
      /requires consuming transcript event/u.test(error.adapterFailure.message),
  );
});

test("replay keeps staged-input token and native-session changes fail closed", async () => {
  const replay = createReplayHarness(
    trace([
      {
        sequence: 1,
        at_ms: 0,
        kind: "pane_snapshot",
        operation: "agent.read.visible",
        payload: { text: "────────\n❯ QUALIFY-STAGED-A\n────────" },
      },
      command(2, "agent.list", {
        schema: "herdr.command/v1",
        result: {
          agents: [
            {
              ...agent("idle"),
              agent_session: { value: "native-2" },
            },
          ],
        },
      }),
    ]),
    { harness: "claude" },
  );

  const staged = await replay.client.inspectStagedInput("managed-agent", {
    harness: "claude",
  });
  assert.equal(staged.display_text, "QUALIFY-STAGED-A");
  await assert.rejects(
    () =>
      replay.client.recoverStagedInput("managed-agent", {
        action: "clear",
        harness: "claude",
        nativeSession: "native-1",
        token: staged.token,
      }),
    { outcome: "recovery_blocked" },
  );
  assert.equal(
    replay.consumedEvents().some(({ operation }) => operation === "agent.send-keys"),
    false,
  );
});

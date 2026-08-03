import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TRACE_SCHEMA } from "../src/trace.mjs";
import {
  ReplayError,
  createReplayHarness,
} from "../src/harness-replay.mjs";
import {
  SEMANTIC_HARNESS_INTERFACE,
  assertSemanticHarness,
} from "../src/harness-interface.mjs";
import { COMPATIBILITY_FEATURES } from "../src/compatibility.mjs";

function trace(events, harness = "codex") {
  const harnessVersion = harness === "claude"
    ? "2.1.199 (Claude Code)"
    : "codex-cli 0.145.0";
  const integration = harness === "claude"
    ? "herdr-claude/v7"
    : "herdr-codex/v6";
  return {
    schema: TRACE_SCHEMA,
    version: 1,
    scenario_id: "replay-test",
    provenance: {
      drovr: "source sha256:drovr",
      herdr: "herdr 0.7.5",
      claude: "not_applicable",
      codex: "codex-cli 0.145.0",
      compatibility: {
        schema: "drovr.compatibility/v1",
        facts: {
          drovr: "drovr.semantic-harness/v1",
          herdr: "herdr 0.7.5",
          harness: harnessVersion,
          integration,
          adapters: [
            "drovr.trace-replay/v1",
            `${harness}-jsonl/v1`,
          ],
          features: [...COMPATIBILITY_FEATURES],
        },
      },
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

function managedAgent(nativeSession = "native-1") {
  return {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: nativeSession,
  };
}

test("replay exposes the semantic Interface and equivalent typed evidence", async () => {
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
      command(3, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("done", 2)] },
      }),
      {
        sequence: 4,
        at_ms: 0,
        kind: "transcript_event",
        operation: "transcript.read",
        payload: {
          harness: "codex",
          record: {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "QUALIFY-REPLAY-OK",
            },
          },
        },
      },
      {
        sequence: 5,
        at_ms: 0,
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
              content: [{ type: "output_text", text: "QUALIFY-REPLAY-DONE" }],
            },
          },
        },
      },
    ]),
    { harness: "codex" },
  );
  const semantic = replay.harness;
  assertSemanticHarness(semantic);
  assert.equal(semantic.schema, SEMANTIC_HARNESS_INTERFACE);
  assert.equal(semantic.implementation, "trace-replay");

  const managed = {
    id: "agent-1",
    herdr: { name: "managed-agent", pane_id: "pane-1" },
    native_session: "native-1",
  };
  const observed = await semantic.observeAgent(managed);
  assert.equal(observed.evidence, "present");
  assert.deepEqual(observed.identity, {
    managed_agent: "managed-agent",
    pane: "pane-1",
    native_session: "native-1",
  });
  const submitted = await semantic.deliverTurn({
    agent: managed,
    prompt: "QUALIFY-REPLAY-OK",
    observed,
  });
  assert.equal(submitted.outcome, "submitted");
  assert.equal(submitted.evidence, "present");
  const settled = await semantic.waitForTurn({
    agent: managed,
    turn: {
      inputs: [{ text: "QUALIFY-REPLAY-OK" }],
      transcript_cursor: await semantic.prepareTurn({
        agent: managed,
        task: { cwd: "/replay" },
      }).then(({ cursor }) => cursor),
    },
  });
  assert.equal(settled.outcome, "completed");
  assert.equal(settled.evidence, "present");
  assert.equal(settled.result.text, "QUALIFY-REPLAY-DONE");
});

test("replay does not correlate transcript output without settled identity evidence", async () => {
  const replay = createReplayHarness(
    trace([
      {
        sequence: 1,
        at_ms: 0,
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
              content: [{ type: "output_text", text: "QUALIFY-PROBE-DONE" }],
            },
          },
        },
      },
    ]),
  );

  const result = await replay.harness.waitForTurn({
    agent: managedAgent(),
    turn: { inputs: [{ text: "QUALIFY-PROBE" }] },
  });

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.evidence, "uncertain");
  assert.match(result.error, /settled identity evidence/u);
  assert.equal(replay.consumedEvents().length, 0);
});

test("replay compatibility blocks missing or changed exact facts before mutation", async () => {
  const unqualifiedTrace = trace([
    command(1, "agent.prompt", {
      schema: "herdr.command/v1",
      result: { status: "accepted" },
    }),
  ]);
  delete unqualifiedTrace.provenance.compatibility;
  const replay = createReplayHarness(
    unqualifiedTrace,
    { harness: "codex", requireCompatibility: true },
  );
  assert.equal(replay.compatibility.status, "blocked");
  assert.ok(replay.compatibility.legal_actions.length > 0);
  await assert.rejects(
    () => replay.harness.validateLaunch({ specification: { harness: "codex" } }),
    (error) => error.outcome === "compatibility_blocked" &&
      error.details?.compatibility?.status === "blocked",
  );
  assert.equal(replay.consumedEvents().length, 0);

  const qualifiedTrace = trace([
    command(1, "agent.prompt", {
      schema: "herdr.command/v1",
      result: { status: "accepted" },
    }),
  ]);
  qualifiedTrace.provenance.compatibility = {
    schema: "drovr.compatibility/v1",
    facts: {
      drovr: "drovr.semantic-harness/v1",
      herdr: "herdr 0.7.5",
      harness: "codex-cli 0.145.0",
      integration: "herdr-codex/v6",
      adapters: ["drovr.trace-replay/v1", "codex-jsonl/v1"],
      features: [...COMPATIBILITY_FEATURES],
    },
  };
  const expected = structuredClone(qualifiedTrace.provenance.compatibility);
  const changed = structuredClone(qualifiedTrace);
  changed.provenance.compatibility.facts.herdr = "herdr 0.7.6";
  const changedReplay = createReplayHarness(changed, {
    harness: "codex",
    expectedCompatibility: expected,
    requireCompatibility: true,
  });
  assert.equal(changedReplay.compatibility.status, "blocked");
  assert.equal(changedReplay.compatibility.reason, "changed");
  await assert.rejects(
    () => changedReplay.harness.deliverTurn({
      agent: {
        id: "agent-1",
        herdr: { name: "managed-agent", pane_id: "pane-1" },
        native_session: "native-1",
      },
      prompt: "QUALIFY-REPLAY-OK",
      observed: {
        evidence: "present",
        identity: {
          managed_agent: "managed-agent",
          pane: "pane-1",
          native_session: "native-1",
        },
      },
    }),
    (error) => error.outcome === "compatibility_blocked",
  );
  assert.equal(changedReplay.consumedEvents().length, 0);
});

test("replay refuses unsupported launch validation and unobserved runtime claims", async () => {
  const replay = createReplayHarness(trace([]), {
    harness: "codex",
    requireCompatibility: true,
  });
  await assert.rejects(
    () => replay.harness.validateLaunch({ specification: { harness: "claude" } }),
    (error) => error.outcome === "invalid_arguments",
  );
  await assert.rejects(
    () => replay.harness.validateLaunch({ specification: { harness: "codex" } }),
    (error) => error.outcome === "unsupported_configuration",
  );
  assert.deepEqual(await replay.harness.observeRuntime(), {
    outcome: "uncertain",
    evidence: "uncertain",
    session: "replay",
    reason: "replay did not provide runtime observation evidence",
  });
  assert.equal(replay.consumedEvents().length, 0);
});

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
  const managed = managedAgent();
  const observed = await replay.harness.observeAgent(managed);
  assert.equal(observed.state, "idle");
  await replay.harness.deliverTurn({
    agent: managed,
    prompt: "QUALIFY-REPLAY-OK",
    observed,
  });
  assert.equal(replay.clock.now(), 0);
  await replay.clock.delay(25);
  assert.equal(replay.clock.now(), 25);
  assert.equal(
    (await replay.harness.waitForAgent(managed, { timeoutMs: 100 })).state,
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
    () => replay.harness.deliverTurn({
      agent: managedAgent(),
      prompt: "QUALIFY-REPLAY-OK",
      observed: {
        evidence: "present",
        identity: {
          managed_agent: "managed-agent",
          pane: "pane-1",
          native_session: "native-1",
        },
      },
    }),
    (error) =>
      error.adapterFailure instanceof ReplayError &&
      /agent\.prompt/u.test(error.adapterFailure.message),
  );
});

test("replay consumes the guarded native identity check before interruption", async () => {
  const keyInput = "ctrl+c";
  const replay = createReplayHarness(
    trace([
      command(1, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("working")] },
      }),
      command(2, "agent.list", {
        schema: "herdr.command/v1",
        result: { agents: [agent("working", 2)] },
      }),
      {
        sequence: 3,
        at_ms: 0,
        kind: "command_result",
        operation: "agent.send-keys",
        payload: {
          request: {
            resource: "agent",
            action: "send-keys",
            target: "managed-agent",
            input: {
              length: keyInput.length,
              sha256: `sha256:${createHash("sha256").update(keyInput).digest("hex")}`,
            },
          },
          envelope: {
            schema: "herdr.command/v1",
            result: { status: "interrupted" },
          },
        },
      },
    ]),
  );
  const managed = managedAgent();
  const observed = await replay.harness.observeAgent(managed);
  const interrupted = await replay.harness.interruptTurn({
    agent: managed,
    observed,
    deferSettlementObservation: true,
  });

  assert.equal(interrupted.outcome, "interrupted");
  assert.equal(replay.remainingEvents().length, 0);
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
    () => replay.harness.deliverTurn({
      agent: {
        ...managedAgent(),
        herdr: { name: "other-agent", pane_id: "pane-1" },
      },
      prompt: "QUALIFY-REQUEST-OK",
      observed: {
        evidence: "present",
        identity: {
          managed_agent: "managed-agent",
          pane: "pane-1",
          native_session: "native-1",
        },
      },
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
    () => replay.harness.deliverTurn({
      agent: managedAgent(),
      prompt: "QUALIFY-REPLAY-OK",
      observed: {
        evidence: "present",
        identity: {
          managed_agent: "managed-agent",
          pane: "pane-1",
          native_session: "native-1",
        },
      },
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
    () => replay.harness.observeAgent(managedAgent()),
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
    ], "claude"),
    { harness: "claude" },
  );

  const staged = await replay.harness.inspectStagedInput({
    agent: managedAgent("native-1"),
  });
  assert.equal(staged.snapshot.display_text, "QUALIFY-STAGED-A");
  await assert.rejects(
    () => replay.harness.recoverStagedInput({
      agent: managedAgent("native-1"),
      action: "clear",
      token: staged.snapshot.token,
    }),
    { outcome: "recovery_blocked" },
  );
  assert.equal(
    replay.consumedEvents().some(({ operation }) => operation === "agent.send-keys"),
    false,
  );
});

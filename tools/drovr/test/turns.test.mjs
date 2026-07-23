import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { captureTranscriptCursor } from "../src/codex-transcript.mjs";
import { readRecords, stateDirectory, writeRecord } from "../src/registry.mjs";
import { appendTurnInput, createTurnRecord } from "../src/turn-record.mjs";
import { waitForTurn } from "../src/turns.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
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
import { createBlockRecord } from "../src/block-record.mjs";
import { readRecords, stateDirectory, writeRecord } from "../src/registry.mjs";
import { appendTurnInput, createTurnRecord } from "../src/turn-record.mjs";
import { cancelTurn, startTurn, waitForTurn } from "../src/turns.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

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

test("read-only wait reports agent loss without launching recovery", async (t) => {
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

  assert.equal(result.wait_status, "agent_lost");
  assert.equal(turn.status, "working");
  assert.equal(launches, 0);
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

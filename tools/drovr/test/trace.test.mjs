import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TRACE_SCHEMA,
  TraceRecorder,
  captureTrace,
  createTraceJournal,
  redactPaneSnapshot,
  readTrace,
  traceJournalFailurePath,
  traceFromJournal,
  validateTrace,
  writeTrace,
} from "../src/trace.mjs";

function rawTrace(overrides = {}) {
  return {
    schema: TRACE_SCHEMA,
    version: 1,
    scenario_id: "trace-test",
    provenance: {
      drovr: "source sha256:drovr",
      herdr: "herdr 0.7.5",
      claude: "not_applicable",
      codex: "codex-cli 0.145.0",
    },
    events: [
      {
        sequence: 1,
        at_ms: 0,
        kind: "command_result",
        operation: "agent.prompt",
        identity: { agent_id: "agent-1", native_session: "native-1" },
        payload: {
          envelope: {
            schema: "herdr.command/v1",
            result: { status: "accepted" },
          },
        },
      },
    ],
    ...overrides,
  };
}

test("captureTrace redacts credentials and machine-local paths before persistence", () => {
  const trace = captureTrace(
    rawTrace({
      events: [
        {
          sequence: 1,
          at_ms: 0,
          kind: "pane_snapshot",
          operation: "agent.read.visible",
          identity: { agent_id: "agent-1", native_session: "native-1" },
          payload: {
            cwd: "/home/operator/private-project",
            text: "QUALIFY-TRACE-OK",
            stderr: "Authorization: Bearer super-secret-token token=super-secret-token",
          },
        },
      ],
    }),
  );

  const serialized = JSON.stringify(trace);
  assert.doesNotMatch(serialized, /\/home\/operator/u);
  assert.doesNotMatch(serialized, /super-secret-token/u);
  assert.match(serialized, /QUALIFY-TRACE-OK/u);
  assert.doesNotThrow(() => validateTrace(trace));

  const stack = captureTrace(
    rawTrace({
      events: [
        {
          sequence: 1,
          at_ms: 0,
          kind: "error",
          operation: "agent.prompt",
          payload: {
            error: {
              message: "at (/home/operator/.ssh/id_ed25519:1:1)",
            },
          },
        },
      ],
    }),
  );
  assert.doesNotMatch(JSON.stringify(stack), /id_ed25519|\/home\/operator/u);

  assert.doesNotThrow(() =>
    captureTrace(
      rawTrace({
        events: [
          {
            sequence: 1,
            at_ms: 0,
            kind: "agent_observation",
            operation: "agent.list",
            payload: {
              envelope: {
                schema: "herdr.command/v1",
                result: {
                  detail: "3 / 5 turns; claude / haiku; yes / no",
                  url: "https://example.com/x",
                },
              },
            },
          },
        ],
      }),
    ),
  );

  const urls = captureTrace(
    rawTrace({
      events: [
        {
          sequence: 1,
          at_ms: 0,
          kind: "agent_observation",
          operation: "agent.list",
          payload: {
            public_url: "https://example.com/x",
            inline_url: "see https://example.com/x",
            credential_url: "https://alice:hunter2@internal.example.com/repo.git",
            token_url: "https://user:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/o/r",
            query_token_url: "https://example.com/cb?access_token=abc123",
            local_url: "file:///home/operator/private-project",
          },
        },
      ],
    }),
  );
  const serializedUrls = JSON.stringify(urls);
  assert.match(serializedUrls, /https:\/\/example\.com\/x/u);
  assert.doesNotMatch(
    serializedUrls,
    /hunter2|ghp_A{10,}|abc123|file:\/\/\/home\/operator/u,
  );
  assert.match(serializedUrls, /access_token=\[REDACTED\]/u);
  assert.match(serializedUrls, /file:<path:sha256:[0-9a-f]{64}>/u);

  assert.equal(
    redactPaneSnapshot(
      "Claude status\n────────\n❯ QUALIFY-TRACE-PANE\n────────\n/home/operator/private-project",
    ),
    "────────\n❯ QUALIFY-TRACE-PANE\n────────",
  );
  assert.match(
    redactPaneSnapshot("Claude status\n────────\n❯ private prompt\n────────"),
    /^────────\n❯ \[REDACTED_TEXT sha256:[0-9a-f]{64}\]\n────────$/u,
  );
  assert.equal(
    redactPaneSnapshot("unrelated [Pasted text #1] and [Pasted text #1]"),
    "[Pasted text #1]\n[Pasted text #1]",
  );

  const unrelated = captureTrace(
    rawTrace({
      events: [
        {
          sequence: 1,
          at_ms: 0,
          kind: "pane_snapshot",
          operation: "agent.read.visible",
          payload: { text: "unrelated terminal content" },
        },
      ],
    }),
  );
  assert.match(unrelated.events[0].payload.text, /^\[REDACTED_TEXT /u);

  const prompt = captureTrace(
    rawTrace({
      events: [
        {
          sequence: 1,
          at_ms: 0,
          kind: "transcript_event",
          operation: "transcript.read",
          payload: {
            harness: "codex",
            record: {
              type: "event_msg",
              payload: { type: "user_message", message: "private prompt text" },
            },
          },
        },
      ],
    }),
  );
  assert.match(prompt.events[0].payload.record.payload.message, /^\[REDACTED_TEXT /u);

  const tokens = captureTrace(
    rawTrace({
      events: [
        {
          sequence: 1,
          at_ms: 0,
          kind: "command_result",
          operation: "agent.staged-input",
          payload: { token: "private-token-a", access_token: "private-token-b" },
        },
      ],
    }),
  );
  assert.doesNotMatch(JSON.stringify(tokens), /private-token/u);
  assert.match(tokens.events[0].payload.token, /^<token:sha256:[0-9a-f]{64}>$/u);
  assert.notEqual(tokens.events[0].payload.token, tokens.events[0].payload.access_token);
});

test("validateTrace rejects unsafe or non-ordered traces", () => {
  assert.throws(
    () =>
      validateTrace(
        rawTrace({
          events: [
            { sequence: 2, at_ms: 20, kind: "delay", payload: { duration_ms: 20 } },
            { sequence: 1, at_ms: 10, kind: "delay", payload: { duration_ms: 10 } },
          ],
        }),
      ),
    /ordered/u,
  );

  assert.throws(
    () =>
      validateTrace(
        rawTrace({
          events: [
            {
              sequence: 1,
              at_ms: 0,
              kind: "error",
              operation: "agent.prompt",
              payload: { error: { message: "Bearer still-secret" } },
            },
          ],
        }),
      ),
    /unsafe/u,
  );

  assert.throws(
    () =>
      validateTrace(
        rawTrace({
          events: [
            {
              sequence: 1,
              at_ms: 0,
              kind: "command_result",
              operation: "agent.staged-input",
              payload: { token: "unredacted-token" },
            },
          ],
        }),
      ),
    /unredacted token/u,
  );

  assert.throws(
    () =>
      validateTrace(
        rawTrace({
          provenance: {
            ...rawTrace().provenance,
            drovr: "/home/operator/private-project",
          },
        }),
      ),
    /unsafe/u,
  );
});

test("writeTrace validates the final artifact and round-trips deterministic bytes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-trace-contract-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "trace.json");
  const trace = captureTrace(rawTrace());

  await writeTrace(path, trace);
  const first = await readFile(path, "utf8");
  assert.deepEqual(await readTrace(path), trace);

  await writeTrace(path, trace);
  assert.equal(await readFile(path, "utf8"), first);
});

test("TraceRecorder assigns stable relative ordering and provenance", () => {
  let now = 1_000;
  const recorder = new TraceRecorder({
    scenarioId: "recorder-test",
    provenance: {
      drovr: "source sha256:drovr",
      herdr: "herdr 0.7.5",
      claude: "not_applicable",
      codex: "codex-cli 0.145.0",
    },
    clock: () => now,
    startedAt: 1_000,
  });

  recorder.record({
    kind: "agent_observation",
    operation: "agent.list",
    payload: { envelope: { schema: "herdr.command/v1", result: { agents: [] } } },
  });
  now += 25;
  recorder.record({
    kind: "delay",
    operation: "clock.delay",
    payload: { duration_ms: 25 },
  });

  const trace = recorder.trace();
  assert.deepEqual(
    trace.events.map(({ sequence, at_ms }) => ({ sequence, at_ms })),
    [
      { sequence: 1, at_ms: 0 },
      { sequence: 2, at_ms: 25 },
    ],
  );
  assert.equal(trace.scenario_id, "recorder-test");
});

test("trace journals retain ordered sanitized events for later versioned persistence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-trace-journal-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "events.jsonl");
  const journal = createTraceJournal(path);
  const sharedJournal = createTraceJournal(path);
  await journal.record({
    kind: "command_result",
    operation: "agent.prompt",
    payload: {
      envelope: {
        schema: "herdr.command/v1",
        result: { status: "accepted", cwd: "/home/operator/private-project" },
      },
    },
  });
  await journal.record({
    kind: "delay",
    operation: "clock.delay",
    payload: { duration_ms: 25 },
  });
  await sharedJournal.record({
    kind: "command_result",
    operation: "agent.list",
    payload: {
      envelope: {
        schema: "herdr.command/v1",
        result: { agents: [] },
      },
    },
  });
  await journal.flush();

  const trace = await traceFromJournal(path, {
    scenarioId: "journal-test",
    provenance: {
      drovr: "source sha256:drovr",
      herdr: "herdr 0.7.5",
      claude: "not_applicable",
      codex: "codex-cli 0.145.0",
    },
  });
  assert.deepEqual(
    trace.events.map(({ sequence, kind }) => ({ sequence, kind })),
    [
      { sequence: 1, kind: "command_result" },
      { sequence: 2, kind: "delay" },
      { sequence: 3, kind: "command_result" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(trace), /\/home\/operator/u);
});

test("trace journals coordinate independent processes on one path", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-trace-journal-processes-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "events.jsonl");
  const traceModule = new URL("../src/trace.mjs", import.meta.url).href;
  const script = `
    import { createTraceJournal } from ${JSON.stringify(traceModule)};
    const journal = createTraceJournal(process.env.TRACE_PATH);
    for (let index = 0; index < 15; index += 1) {
      const operation = index % 2 === 0 ? "agent.list" : "agent.wait";
      await journal.record({
        kind: "agent_observation",
        operation,
        payload: {
          request: { resource: "agent", action: operation.slice(6), target: null },
          envelope: { schema: "herdr.command/v1", result: { agents: [] } },
        },
      });
    }
    await journal.flush();
  `;
  const env = {
    ...process.env,
    TRACE_PATH: path,
    DROVR_TRACE_STARTED_AT: String(Date.now()),
  };
  await Promise.all(
    Array.from({ length: 4 }, () => runNodeScript(script, env)),
  );

  const trace = await traceFromJournal(path, {
    scenarioId: "journal-process-test",
    provenance: rawTrace().provenance,
  });
  assert.equal(trace.events.length, 60);
  assert.deepEqual(
    trace.events.map(({ sequence }) => sequence),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  assert.ok(
    trace.events.every(
      (event, index) => index === 0 || event.at_ms >= trace.events[index - 1].at_ms,
    ),
  );
});

test("trace journal preserves captured sequence and timing instead of repairing them", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-trace-journal-validation-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "events.jsonl");
  const journal = createTraceJournal(path);
  await journal.record({
    kind: "command_result",
    operation: "agent.prompt",
    payload: { envelope: { schema: "herdr.command/v1", result: {} } },
  });
  await journal.flush();
  const source = await readFile(path, "utf8");
  const event = JSON.parse(source);
  event.sequence = 2;
  await writeFile(path, `${JSON.stringify(event)}\n`);

  await assert.rejects(
    () => traceFromJournal(path, {
      scenarioId: "journal-validation-test",
      provenance: rawTrace().provenance,
    }),
    /invalid sequence/u,
  );
});

test("trace capture failure is recorded without poisoning later Herdr calls", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-trace-journal-failure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "events.jsonl");
  const journal = createTraceJournal(path);

  await journal.record({
    kind: "command_result",
    operation: "agent.prompt",
    payload: { envelope: { schema: "herdr.command/v1", result: { value: 1n } } },
  });
  await journal.record({
    kind: "command_result",
    operation: "agent.list",
    payload: { envelope: { schema: "herdr.command/v1", result: { agents: [] } } },
  });
  await journal.flush();

  const trace = await traceFromJournal(path, {
    scenarioId: "journal-failure-test",
    provenance: rawTrace().provenance,
  });
  assert.equal(trace.events.length, 1);
  assert.equal(trace.events[0].operation, "trace.capture");
  assert.match(
    await readFile(traceJournalFailurePath(path), "utf8"),
    /trace-capture-failure\/v1/u,
  );
});

function runNodeScript(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`child exited with ${code}: ${stderr}`));
    });
  });
}

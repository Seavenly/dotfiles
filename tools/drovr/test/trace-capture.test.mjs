import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HerdrClient } from "../src/herdr.mjs";
import { createTraceJournal, traceFromJournal } from "../src/trace.mjs";

test("Herdr semantic operations capture observations, pane snapshots, and errors", async () => {
  const events = [];
  const client = new HerdrClient({
    session: "delegates",
    trace: { record: (event) => events.push(event) },
    async run(_file, args) {
      if (args.includes("agent") && args.includes("list")) {
        return JSON.stringify({
          schema: "herdr.command/v1",
          result: {
            agents: [
              {
                name: "managed-agent",
                agent_status: "idle",
                agent_session: { value: "native-1" },
              },
            ],
          },
        });
      }
      if (args.includes("agent") && args.includes("read")) {
        return "QUALIFY-TRACE-PANE";
      }
      throw new Error("unexpected Herdr request");
    },
  });

  await client.agentRecord("managed-agent");
  await client.agentVisibleText("managed-agent");
  await assert.rejects(() => client.sessionCommand(["agent", "prompt", "managed-agent", "x"]));

  assert.deepEqual(
    events.map(({ kind, operation }) => ({ kind, operation })),
    [
      { kind: "agent_observation", operation: "agent.list" },
      { kind: "pane_snapshot", operation: "agent.read.visible" },
      { kind: "error", operation: "agent.prompt" },
    ],
  );
  assert.equal(events[0].payload.envelope.result.agents[0].agent_session.value, "native-1");
  assert.equal(events[1].payload.text, "QUALIFY-TRACE-PANE");
});

test("Herdr error capture retains the sanitized native envelope", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-trace-error-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const journal = createTraceJournal(join(scratch, "events.jsonl"));
  const client = new HerdrClient({
    session: "delegates",
    trace: journal,
    async run() {
      const error = new Error("native pane failed at /home/operator/private-project");
      error.code = "pane_not_found";
      error.outcome = "adapter_failure";
      error.stdout = "native stdout";
      error.stderr = JSON.stringify({
        schema: "herdr.error/v1",
        error: {
          code: "pane_not_found",
          message: "path /home/operator/private-project",
          token: "native-secret-token",
        },
      });
      throw error;
    },
  });

  await assert.rejects(() => client.sessionCommand(["agent", "prompt", "managed-agent", "QUALIFY-ERROR"]));
  await journal.flush();
  const trace = await traceFromJournal(join(scratch, "events.jsonl"), {
    scenarioId: "error-capture-test",
    provenance: {
      drovr: "source sha256:drovr",
      herdr: "herdr 0.7.5",
      claude: "not_applicable",
      codex: "codex-cli 0.145.0",
    },
  });

  const captured = trace.events[0].payload.error;
  assert.equal(captured.code, "pane_not_found");
  assert.equal(captured.outcome, "adapter_failure");
  assert.equal(captured.envelope.schema, "herdr.error/v1");
  assert.match(captured.envelope.error.token, /^<token:sha256:[0-9a-f]{64}>$/u);
  assert.doesNotMatch(JSON.stringify(captured), /native-secret-token|\/home\/operator/u);
});

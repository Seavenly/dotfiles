import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli-command.mjs";
import { createFlowRuntime } from "../src/runtime.mjs";

test("flow CLI exposes the watermarked legacy inventory query", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-cli-inventory-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stateHome = join(scratch, "state");
  const runDirectory = join(stateHome, "agent-flow", "runs", "cli-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "run.json"), `${JSON.stringify({
    schema: "agent-flow.run/v1",
    identity: { run_id: "cli-run", flow: "review", external_root: null },
  })}\n`);
  let stdout = "";
  let stderr = "";
  const status = await runCli(
    ["query", "legacy-inventory", "--json"],
    {
      runtime: createFlowRuntime({
        env: { HOME: scratch, XDG_STATE_HOME: stateHome },
      }),
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  );

  assert.equal(status, 0);
  assert.equal(stderr, "");
  const projection = JSON.parse(stdout);
  assert.equal(projection.schema, "flow.legacy-compatibility-inventory/v1");
  assert.deepEqual(projection.inventory.runs.map(({ id }) => id), [
    "hermes-agent-flow:cli-run",
  ]);
  assert.match(projection.watermark.content_sha256, /^[0-9a-f]{64}$/u);
});

test("flow CLI rejects incomplete arguments and classifies inventory failures", async () => {
  let stderr = "";
  let stdout = "";
  assert.equal(await runCli(
    ["query", "legacy-inventory"],
    {
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  ), 2);
  assert.match(stderr, /^Usage:/u);
  assert.equal(stdout, "");

  stderr = "";
  assert.equal(await runCli(
    ["query", "legacy-inventory", "--json"],
    {
      runtime: { query: async () => { throw new Error("source disappeared"); } },
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  ), 1);
  assert.deepEqual(JSON.parse(stderr), {
    code: "inventory_unavailable",
    message: "legacy compatibility inventory is unavailable",
    schema: "flow.rejection/v1",
  });
});

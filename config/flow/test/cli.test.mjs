import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("flow CLI describes an exact Drovr launch through FlowRuntime query", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "flow-cli-delegation-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  await mkdir(bin);
  const herdr = join(bin, "herdr");
  await writeFile(herdr, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [[ "$1" == "--version" ]]; then printf \'herdr 0.8.0\\n\';',
    'elif [[ "$1" == "integration" && "$2" == "status" ]]; then printf \'codex: current (v1)\\n\';',
    "fi",
    ""
  ].join("\n"));
  await chmod(herdr, 0o755);
  const codex = join(bin, "codex");
  await writeFile(codex, "#!/usr/bin/env bash\nprintf 'codex-cli 0.147.0\\n'\n");
  await chmod(codex, 0o755);
  let stdout = "";
  let stderr = "";
  const status = await runCli(
    [
      "query",
      "delegated-agent",
      "--harness",
      "codex",
      "--role",
      "reviewer",
      "--capability",
      "read-only",
      "--caller-metadata",
      '{"run_id":"run:example","card_id":"review"}',
      "--json",
    ],
    {
      runtime: createFlowRuntime({
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOME: scratch,
          XDG_STATE_HOME: join(scratch, "state"),
          DROVR_CONFIG_DIR: join(import.meta.dirname, "../../drovr"),
        },
      }),
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  );

  assert.equal(status, 0);
  assert.equal(stderr, "");
  const projection = JSON.parse(stdout);
  assert.equal(projection.schema, "flow.delegated-agent-description-projection/v1");
  assert.equal(projection.status, "compatible");
  assert.equal(projection.description.launch.harness, "codex");
  assert.equal(projection.description.launch.capability, "read-only");
  assert.deepEqual(projection.description.caller_metadata, {
    run_id: "run:example",
    card_id: "review",
  });
  assert.deepEqual(projection.legal_next_actions, [
    "bind_exact_launch_description",
    "refresh_delegated_runtime_description",
  ]);
  assert.deepEqual(projection.compatibility.findings, []);
});

test("flow CLI classifies an invalid launch selector without suggesting retry", async () => {
  let stdout = "";
  let stderr = "";

  const status = await runCli(
    [
      "query",
      "delegated-agent",
      "--harness",
      "bogus",
      "--caller-metadata",
      "{}",
      "--json",
    ],
    {
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  );

  assert.equal(status, 0);
  assert.equal(stderr, "");
  const projection = JSON.parse(stdout);
  assert.equal(projection.status, "blocked");
  assert.equal(
    projection.compatibility.code,
    "invalid_description_request",
  );
  assert.deepEqual(projection.legal_next_actions, []);
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
    schema: "flow.rejection/v1",
    operation: "query",
    code: "inventory_unavailable",
    reason: null,
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: null,
    authority_watermark_domain: "host",
    legal_actions: [],
  });
});

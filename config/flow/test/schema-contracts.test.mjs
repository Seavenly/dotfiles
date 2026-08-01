import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { createFlowRuntime } from "../src/runtime.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("published Flow projections satisfy their JSON schemas", async (t) => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const querySchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.query.v1.schema.json"),
    "utf8",
  ));
  const inventorySchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.legacy-compatibility-inventory.v1.schema.json"),
    "utf8",
  ));
  const rejectionSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.rejection.v1.schema.json"),
    "utf8",
  ));
  const scratch = await mkdtemp(join(tmpdir(), "flow-schema-contract-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const hermesRuns = join(scratch, "agent-flow", "runs");
  const runDirectory = join(hermesRuns, "contract-run");
  const artifacts = join(runDirectory, "artifacts");
  const stacks = join(scratch, "agent-flow", "configured-stacks");
  await mkdir(artifacts, { recursive: true });
  await mkdir(stacks, { recursive: true });
  await writeJson(join(runDirectory, "run.json"), {
    schema: "agent-flow.run/v1",
    identity: {
      run_id: "contract-run",
      flow: "feature",
      external_root: { system: "github", id: "seavenly/dotfiles#4" },
    },
  });
  const transcript = join(artifacts, "native.jsonl");
  await writeFile(transcript, '{"type":"result"}\n');
  await writeJson(join(runDirectory, "materialization.json"), {
    transcript_path: transcript,
  });
  await writeJson(join(runDirectory, "delivery-state.json"), {
    schema: "agent-flow.delivery-state/v1",
    pending_completion_pr: { request_id: "completion-1" },
  });
  const summary = join(artifacts, "summary.md");
  await writeFile(summary, "summary\n");
  await writeJson(join(artifacts, "review.json"), {
    schema: "agent-flow.local-review/v1",
    artifacts: { review_summary: summary },
    review: { status: "review_ready", generation: 0 },
  });
  await writeJson(join(stacks, "stack.state.json"), {
    schema: "agent-flow.stack-state/v1",
    run_id: "contract-stack",
    generation: 1,
    status: "publish_failed",
  });

  const request = {
    schema: "flow.query/v1",
    query: "legacy_compatibility_inventory",
  };
  const projection = await createFlowRuntime({
    legacyRoots: {
      claudeRuns: join(scratch, "missing-claude-runs"),
      hermesRuns,
      hermesStacks: stacks,
    },
  }).query(request);

  for (const collection of [
    "active_ownership",
    "artifacts",
    "reviews",
    "runs",
    "sources",
    "stacks",
    "transcript_pointers",
    "unresolved_effects",
  ]) {
    assert.ok(projection.inventory[collection].length > 0, collection);
  }

  assert.equal(ajv.validate(querySchema, request), true, ajv.errorsText());
  assert.equal(ajv.validate(inventorySchema, projection), true, ajv.errorsText());
  assert.equal(ajv.validate(rejectionSchema, {
    schema: "flow.rejection/v1",
    operation: "query",
    code: "unsupported_query",
    reason: null,
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: null,
    authority_watermark_domain: "host",
    legal_actions: [],
  }), true, ajv.errorsText());
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

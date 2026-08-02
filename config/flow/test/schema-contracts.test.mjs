import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { createFlowRuntime } from "../src/runtime.mjs";
import { describeDelegatedAgent } from "../../../tools/drovr/src/description.mjs";
import {
  createDrovrDelegatedAgentPort,
} from "../../../tools/flow/src/drovr-delegated-agent-port.mjs";

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
  const delegatedDescriptionSchema = JSON.parse(await readFile(
    join(
      root,
      "schemas",
      "flow.delegated-agent-description-projection.v1.schema.json",
    ),
    "utf8",
  ));
  const delegatedLifecycleSchema = JSON.parse(await readFile(
    join(
      root,
      "schemas",
      "flow.delegated-agent-lifecycle-projection.v1.schema.json",
    ),
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
  const delegatedRequest = {
    schema: "flow.query/v1",
    query: "delegated_agent_description",
    launch: { harness: "codex", capability: "read-only" },
    caller_metadata: { run_id: "run:contract", card_id: "review" },
  };
  const delegatedProjection = await createFlowRuntime({
    env: {
      ...process.env,
      DROVR_CONFIG_DIR: join(root, "../drovr"),
    },
  }).query(delegatedRequest);
  assert.equal(
    ajv.validate(querySchema, delegatedRequest),
    true,
    ajv.errorsText(),
  );
  assert.equal(
    ajv.validate(delegatedDescriptionSchema, delegatedProjection),
    true,
    ajv.errorsText(),
  );
  const malformedProjection = await createDrovrDelegatedAgentPort({
    async describeDrovr(drovrRequest, dependencies) {
      const description = structuredClone(
        await describeDelegatedAgent(drovrRequest, dependencies),
      );
      description.feature_advertisement.features[0] = null;
      return description;
    },
    dependencies: {
      env: {
        ...process.env,
        DROVR_CONFIG_DIR: join(root, "../drovr"),
      },
    },
  }).describe({
    schema: "flow.delegated-agent-description-request/v1",
    launch: { harness: "codex", capability: "read-only" },
    caller_metadata: { run_id: "run:malformed" },
  });
  assert.equal(malformedProjection.description, null);
  assert.equal(
    ajv.validate(delegatedDescriptionSchema, malformedProjection),
    true,
    ajv.errorsText(),
  );
  const absentLifecycleProjection = await createDrovrDelegatedAgentPort({
    async discoverDrovr() {
      return {
        discovery_status: "proven_absent",
        authority_watermark: {
          schema: "drovr.registry-authority-watermark/v1",
          authority: "drovr.registry",
          turns_sha256:
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      };
    },
  }).discover({
    schema: "flow.delegated-agent-discover-request/v1",
    caller_key: "run:absent/card:review/attempt:1",
  });
  assert.equal(
    ajv.validate(delegatedLifecycleSchema, absentLifecycleProjection),
    true,
    ajv.errorsText(),
  );
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

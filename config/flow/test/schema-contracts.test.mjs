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

test("reboot admission schemas compile in strict mode", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const names = [
    "flow.required-authority.v1.schema.json",
    "flow.authority-observation.v1.schema.json",
    "flow.authority-fact.v1.schema.json",
    "flow.required-authority-binding.v1.schema.json",
    "flow.required-authority-revalidation.v1.schema.json",
    "flow.rejection.v1.schema.json",
    "flow.time-fact.v1.schema.json",
    "flow.subject-generation.v1.schema.json",
    "flow.reboot-effect-recheck.v1.schema.json",
    "flow.reboot-revalidation.v1.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(join(root, "schemas", name), "utf8"))));

  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) assert.equal(typeof ajv.getSchema(schema.$id), "function");
});

test("delegate input envelope schemas compile in strict mode", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const names = [
    "flow.required-authority-binding.v1.schema.json",
    "flow.authority-observation.v1.schema.json",
    "flow.delegate-input-envelope.v1.schema.json",
    "flow.delegate-task-inputs.v1.schema.json",
    "flow.delegate-execution-resource-selection.v1.schema.json",
    "flow.delegate-execution-resource-reference.v1.schema.json",
    "flow.delegate-execution-authority.v1.schema.json",
    "flow.delegate-failure-observation.v1.schema.json",
    "flow.delegate-predecessor-evidence.v1.schema.json",
    "flow.delegate-output-requirements.v1.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(join(root, "schemas", name), "utf8"))));

  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) {
    assert.equal(typeof ajv.getSchema(schema.$id), "function", schema.$id);
  }

  const validate = ajv.getSchema(
    "https://dotfiles.local/schemas/flow.delegate-input-envelope.v1.schema.json",
  );
  const envelope = {
    schema: "flow.delegate-input-envelope/v1",
    attempt_id: "run:contract/card:delegate/attempt:1",
    input_key: "run:contract/card:delegate/attempt:1:input:1",
    sequence: 1,
    input_kind: "initial",
    instructions: "Inspect the selected task and return canonical JSON.",
    task_inputs: {
      schema: "flow.delegate-task-inputs/v1",
      flow: "feature/v1",
      phase: "critique",
      brief_id: "brief:contract",
    },
    resource_references: [{
      schema: "flow.delegate-execution-resource-reference/v1",
      kind: "workspace",
      authority: "WorkspaceAuthority",
      contract: "work.workspace/v1",
      subject_id: "workspace:contract",
      generation: 4,
      mutation_epoch: 9,
      fingerprint: `sha256:${"a".repeat(64)}`,
      access: "read_only",
      authority_binding: {
        schema: "flow.required-authority-binding/v1",
        id: "resource:facts",
        contract: "flow.resource-authority/v1",
        provider_identity: {
          schema: "flow.registered-authority/v1",
          id: "authority:resource",
          version: "v1",
        },
        observation_input: { fact: "resource_claims" },
        observation: {
          schema: "flow.authority-observation/v1",
          status: "available",
          watermark: `sha256:${"b".repeat(64)}`,
          observation_input: { fact: "resource_claims" },
        },
      },
    }],
    execution_authority: {
      schema: "flow.delegate-execution-authority/v1",
      owner: "RunAuthority",
      capability: "read-only",
      effective_authority_digest: `sha256:${"c".repeat(64)}`,
      capability_envelope_ids: ["read-only"],
    },
    predecessor_evidence: {
      schema: "flow.authority-materialized-delegate-evidence/v1",
      accepted_delegates: [],
    },
    output_requirements: {
      schema: "flow.delegate-output-requirements/v1",
      format: "canonical-json",
      schemas: ["flow.review-result/v1"],
      validator_contracts: ["flow.validator/review-result/v1"],
    },
    envelope_digest: `sha256:${"d".repeat(64)}`,
  };
  assert.equal(validate(envelope), true, ajv.errorsText(validate.errors));

  const transmittedWithSelectionId = structuredClone(envelope);
  delete transmittedWithSelectionId.resource_references[0].authority_binding;
  transmittedWithSelectionId.resource_references[0].authority_binding_id =
    "resource:facts";
  assert.equal(validate(transmittedWithSelectionId), false);

  const forbidden = structuredClone(envelope);
  forbidden.task_inputs.working_directory = "/tmp/not-a-contract-input";
  assert.equal(validate(forbidden), false);
});

test("delegate task-input schema rejects forbidden aliases recursively", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(await readFile(join(
    root,
    "schemas",
    "flow.delegate-task-inputs.v1.schema.json",
  ), "utf8"));
  const validate = ajv.compile(schema);
  for (const alias of [
    "ambientTranscript",
    "capability-secret",
    "credentialStore",
    "workspacePath",
    "working-directory",
    "fullBundle",
    "preparedBundle",
    "private-key",
    "apiKey",
    "access-key",
  ]) {
    const value = {
      schema: "flow.delegate-task-inputs/v1",
      nested: [{ [alias]: "forbidden" }],
    };
    assert.equal(validate(value), false, JSON.stringify(value));
  }
});

test("delegate failure observation schema is strict and preserves operator fields", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(await readFile(join(
    root,
    "schemas",
    "flow.delegate-failure-observation.v1.schema.json",
  ), "utf8"));
  const validate = ajv.compile(schema);
  const valid = {
    schema: "flow.delegate-failure-observation/v1",
    code: "invalid_envelope",
    stage: "delegate_effect_materialization",
    retryable: false,
  };
  assert.equal(validate(valid), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...valid, unknown: "not-public" }), false);
  assert.equal(validate({ ...valid, retryable: "false" }), false);
});

test("predecessor evidence schema branches reject unknown fields", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(await readFile(
    join(root, "schemas", "flow.delegate-predecessor-evidence.v1.schema.json"),
    "utf8",
  ));
  const validate = ajv.compile(schema);
  const digestEvidence = {
    schema: "flow.authority-materialized-evidence/v1",
    evidence_digest: `sha256:${"a".repeat(64)}`,
  };
  const delegateEvidence = {
    schema: "flow.authority-materialized-delegate-evidence/v1",
    accepted_delegates: [],
  };
  const completeEvidence = {
    schema: "flow.authority-materialized-evidence/v1",
    accepted_delegates: [{
      card_id: "feature-critique",
      effect_id: "effect:critique",
      attempt_id: "attempt:critique",
      idempotency_key: "delegate:critique",
      source_authority_watermark: `sha256:${"b".repeat(64)}`,
      evidence: {
        schema: "flow.delegate-evidence/v1",
        validated_output: "{\"findings\":[]}",
        evidence_safety_receipt: {
          schema: "flow.evidence-safety-receipt/v1",
          policy_id: "flow.evidence-safety-policy/v1",
          catalog_id: "flow.contract-catalog/v1@29",
          classification: "delegate_evidence",
          allowed_use: ["delegate_transfer"],
          input_digest: `sha256:${"e".repeat(64)}`,
          receipt_digest: `sha256:${"f".repeat(64)}`,
          self_digest: `sha256:${"f".repeat(64)}`,
        },
        evidence_safety_binding: {
          schema: "flow.evidence-safety-binding/v1",
          boundary: "delegate_transfer",
          receipt_digest: `sha256:${"f".repeat(64)}`,
          input_digest: `sha256:${"e".repeat(64)}`,
          subject_digest: `sha256:${"e".repeat(64)}`,
          binding_digest: `sha256:${"a".repeat(64)}`,
          self_digest: `sha256:${"a".repeat(64)}`,
        },
      },
    }],
    operation_receipts: [{
      card_id: "feature-verify",
      effect_id: "effect:verify",
      attempt_id: "attempt:verify",
      idempotency_key: "operation:verify",
      source_authority_watermark: `sha256:${"c".repeat(64)}`,
      receipt: {
        schema: "flow.effect-receipt/v1",
        effect_id: "effect:verify",
        idempotency_key: "operation:verify",
        outcome: "succeeded",
        provider_receipt: { schema: "work.feature-verification-receipt/v1" },
      },
    }],
    verify_receipt: {
      schema: "flow.effect-receipt/v1",
      effect_id: "effect:verify",
      idempotency_key: "operation:verify",
      outcome: "succeeded",
      provider_receipt: { schema: "work.feature-verification-receipt/v1" },
    },
    evidence_digest: `sha256:${"d".repeat(64)}`,
  };
  assert.equal(validate(digestEvidence), true, ajv.errorsText(validate.errors));
  assert.equal(validate(delegateEvidence), true, ajv.errorsText(validate.errors));
  assert.equal(validate(completeEvidence), true, ajv.errorsText(validate.errors));
  const missingSafety = structuredClone(completeEvidence);
  delete missingSafety.accepted_delegates[0].evidence.evidence_safety_binding;
  assert.equal(validate(missingSafety), false);
  assert.equal(validate({ ...digestEvidence, transcript: "not evidence" }), false);
  assert.equal(validate({ ...delegateEvidence, authority: "not evidence" }), false);
  assert.equal(validate({ ...completeEvidence, mystery: true }), false);
});

test("delegate resource selection schema is plan-time ID-only", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const bindingSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.required-authority-binding.v1.schema.json"),
    "utf8",
  ));
  const observationSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.authority-observation.v1.schema.json"),
    "utf8",
  ));
  const schema = JSON.parse(await readFile(
    join(root, "schemas", "flow.delegate-execution-resource-selection.v1.schema.json"),
    "utf8",
  ));
  ajv.addSchema(bindingSchema);
  ajv.addSchema(observationSchema);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(schema.$id);
  const selection = {
    schema: "flow.delegate-execution-resource-selection/v1",
    kind: "workspace",
    authority: "WorkspaceAuthority",
    contract: "work.workspace/v1",
    subject_id: "workspace:contract",
    generation: 4,
    mutation_epoch: 9,
    fingerprint: `sha256:${"a".repeat(64)}`,
    access: "read_only",
    authority_binding_id: "resource:facts",
  };
  assert.equal(validate(selection), true, ajv.errorsText(validate.errors));

  const inlineBinding = structuredClone(selection);
  inlineBinding.authority_binding = { id: "resource:facts" };
  assert.equal(validate(inlineBinding), false);
});

test("authority observations require their binding observation input", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(await readFile(
    join(root, "schemas", "flow.authority-observation.v1.schema.json"),
    "utf8",
  ));
  const validate = ajv.compile(schema);
  const observation = {
    schema: "flow.authority-observation/v1",
    status: "available",
    watermark: `sha256:${"a".repeat(64)}`,
    observation_input: { fact: "route_snapshot" },
  };
  assert.equal(validate(observation), true, ajv.errorsText());
  const missingInput = structuredClone(observation);
  delete missingInput.observation_input;
  assert.equal(validate(missingInput), false);
  for (const alias of [
    "authority_watermark",
    "provider_watermark",
    "provider_generation",
  ]) {
    const aliased = {
      ...observation,
      [alias]: alias.endsWith("generation") ? 1 : observation.watermark,
    };
    assert.equal(validate(aliased), false, alias);
  }
});

test("Flow description schema accepts the current Drovr description shape", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(await readFile(
    join(
      root,
      "schemas",
      "flow.delegated-agent-description-projection.v1.schema.json",
    ),
    "utf8",
  ));
  const validate = ajv.compile({
    $schema: schema.$schema,
    ...schema.$defs.description,
    $defs: schema.$defs,
  });
  const description = await describeDelegatedAgent(
    {
      schema: "drovr.delegated-agent-description-request/v1",
      launch: { harness: "codex", capability: "read-only" },
      caller_metadata: { run_id: "run:description-schema", card_id: "review" },
    },
    {
      env: {
        ...process.env,
        DROVR_CONFIG_DIR: join(root, "../drovr"),
      },
      requireCompatibility: false,
    },
  );

  assert.equal(validate(description), true, JSON.stringify(validate.errors));
});

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
  const authorityFactSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.authority-fact.v1.schema.json"),
    "utf8",
  ));
  ajv.addSchema(authorityFactSchema);
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

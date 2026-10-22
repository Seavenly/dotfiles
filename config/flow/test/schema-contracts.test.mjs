import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { digest as canonicalDigest } from "../../../tools/flow/src/canonical.mjs";
import {
  DETERMINISTIC_QUALIFICATION_ASSERTIONS,
  DETERMINISTIC_QUALIFICATION_SCOPE,
} from "../../../tools/flow/src/qualification-recipe.mjs";
import { createFlowRuntime } from "../src/runtime.mjs";
import { describeDelegatedAgent } from "../../../tools/drovr/src/description.mjs";
import {
  createDrovrDelegatedAgentPort,
} from "../../../tools/flow/src/drovr-delegated-agent-port.mjs";
import {
  projectGitHubReviewRecord,
  projectReviewInbox,
} from "../../../tools/flow/src/review-flow.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("public host and reboot admission schemas compile in strict mode", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const names = [
    "flow.transport-error.v1.schema.json",
    "flow.transport-request.v1.schema.json",
    "flow.transport-response.v1.schema.json",
    "flow.owner-endpoint.v1.schema.json",
    "flow.owner-status.v1.schema.json",
    "flow.runtime-runner-status.v1.schema.json",
    "flow.query.v1.schema.json",
    "flow.feature-preparation-request.v1.schema.json",
    "flow.dark-opt-in.v1.schema.json",
    "flow.feature-candidate-archive.v1.schema.json",
    "flow.feature-criterion-evidence.v1.schema.json",
    "flow.feature-critique-output.v1.schema.json",
    "flow.authority-critique-input-binding.v1.schema.json",
    "flow.required-authority.v1.schema.json",
    "flow.authority-observation.v1.schema.json",
    "flow.authority-fact.v1.schema.json",
    "flow.required-authority-binding.v1.schema.json",
    "flow.required-authority-revalidation.v1.schema.json",
    "flow.rejection.v1.schema.json",
    "flow.capability-manifest.v1.schema.json",
    "flow.release-manifest.v1.schema.json",
    "flow.launch-selection.v1.schema.json",
    "flow.launch-rejection.v1.schema.json",
    "flow.transition-qualification-evidence.v1.schema.json",
    "flow.production-route-conformance-evidence.v1.schema.json",
    "flow.host-recovery-qualification-evidence.v1.schema.json",
    "flow.release-content.v1.schema.json",
    "flow.time-fact.v1.schema.json",
    "flow.subject-generation.v1.schema.json",
    "flow.reboot-effect-recheck.v1.schema.json",
    "flow.reboot-revalidation.v1.schema.json",
    "work.review-human-command.v1.schema.json",
    "work.review-target-refresh-command.v1.schema.json",
    "flow.review-integration-evidence.v1.schema.json",
    "flow.review-provenance.v1.schema.json",
    "flow.review-inbox-watermark.v1.schema.json",
    "flow.review-inbox-projection.v1.schema.json",
    "flow.review-inbox-item.v1.schema.json",
    "flow.delegated-agent-resource-ensure-request.v1.schema.json",
    "flow.delegated-agent-resource-retire-request.v1.schema.json",
    "flow.delegated-agent-resource-projection.v1.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(join(root, "schemas", name), "utf8"))));

  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) assert.equal(typeof ajv.getSchema(schema.$id), "function");
});

test("release transition contracts validate the managed manifest and receipt", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const names = [
    "flow.dark-opt-in.v1.schema.json",
    "flow.capability-manifest.v1.schema.json",
    "flow.release-manifest.v1.schema.json",
    "flow.launch-selection.v1.schema.json",
    "flow.launch-rejection.v1.schema.json",
    "flow.rejection.v1.schema.json",
    "flow.authority-fact.v1.schema.json",
    "flow.transition-qualification-evidence.v1.schema.json",
    "flow.production-route-conformance-evidence.v1.schema.json",
    "flow.release-content.v1.schema.json",
  ];
  for (const name of names) {
    ajv.addSchema(JSON.parse(await readFile(join(root, "schemas", name), "utf8")));
  }
  const validate = (name, value) => ajv.getSchema(
    `https://dotfiles.local/schemas/${name}.schema.json`,
  )(value);
  const manifest = JSON.parse(await readFile(
    join(root, "release-manifest.v1.json"),
    "utf8",
  ));
  const qualification = JSON.parse(await readFile(
    join(root, "evidence/release-qualification.v1.json"),
    "utf8",
  ));
  const productionRouteConformance = JSON.parse(await readFile(
    join(root, "evidence/production-route-conformance.v1.json"),
    "utf8",
  ));
  const releaseContent = JSON.parse(await readFile(
    join(root, "evidence/release-content.v1.json"),
    "utf8",
  ));
  qualification.candidate_tree_sha =
    releaseContent.git_binding.candidate_tree_sha ?? "a".repeat(40);
  qualification.scope = DETERMINISTIC_QUALIFICATION_SCOPE;
  qualification.assertions = DETERMINISTIC_QUALIFICATION_ASSERTIONS;
  const digest = `sha256:${"a".repeat(64)}`;
  const capabilityManifest = {
    schema: "flow.capability-manifest/v1",
    version: manifest.version,
    release_id: manifest.release_id,
    implementation: manifest.implementation,
    scope: manifest.scope,
    not_authorized_before_issue: manifest.not_authorized_before_issue,
    normal_use_authorized: manifest.normal_use_authorized,
    remote_mutations_authorized: manifest.remote_mutations_authorized,
    supported_routes: manifest.supported_routes.map(({ flow, mode }) => ({ flow, mode })),
    disabled_routes: manifest.disabled_routes.map(({ flow, mode, outcome }) => ({
      flow,
      mode,
      outcome,
    })),
    digest,
  };
  assert.equal(validate("flow.release-manifest.v1", manifest), true);
  assert.equal(validate("flow.transition-qualification-evidence.v1", qualification), true);
  assert.equal(validate(
    "flow.production-route-conformance-evidence.v1",
    productionRouteConformance,
  ), true, ajv.errorsText(ajv.getSchema(
    "https://dotfiles.local/schemas/flow.production-route-conformance-evidence.v1.schema.json",
  ).errors));
  assert.equal(validate("flow.release-content.v1", releaseContent), true);
  const phase2WithoutRecipe = structuredClone(productionRouteConformance);
  phase2WithoutRecipe.status = "passed";
  phase2WithoutRecipe.phase1_evidence_sha256 = "a".repeat(64);
  phase2WithoutRecipe.recipe = null;
  assert.equal(validate(
    "flow.production-route-conformance-evidence.v1",
    phase2WithoutRecipe,
  ), false);
  assert.equal(validate("flow.dark-opt-in.v1", {
    schema: "flow.dark-opt-in/v1",
    release_id: manifest.release_id,
    purpose: "sacrificial_qualification",
  }), true);
  assert.equal(validate("flow.capability-manifest.v1", capabilityManifest), true);
  assert.equal(validate("flow.capability-manifest.v1", {
    ...capabilityManifest,
    version: undefined,
  }), false);
  assert.equal(validate("flow.launch-selection.v1", {
    schema: "flow.launch-selection/v1",
    policy_generation: 1,
    policy_watermark: digest,
    implementation: "flow-runtime/v1",
    authority_root_spec: { base: "state", path: "flow" },
    authority_root: "/state/flow",
    release_id: manifest.release_id,
    scope: manifest.scope,
    not_authorized_before_issue: 50,
    route: { flow: "feature", mode: "verify" },
    normal_use_authorized: false,
    remote_mutations_authorized: false,
    release_manifest: {
      schema: manifest.schema,
      release_id: manifest.release_id,
      digest,
    },
    capability_manifest: capabilityManifest,
  }), true);
  assert.equal(validate("flow.launch-rejection.v1", {
    schema: "flow.launch-rejection/v1",
    operation: "launch",
    code: "route_disabled",
    outcome: "disabled",
    reason: "route is disabled",
    route: { flow: "feature", mode: "test" },
    legal_actions: [{ flow: "feature", mode: "verify" }],
  }), true);
  assert.equal(validate("flow.rejection.v1", {
    schema: "flow.rejection/v1",
    operation: "prepare",
    code: "compatibility_blocked",
    outcome: "unsupported",
    reason: "Drovr route is blocked",
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: null,
    authority_watermark_domain: "host",
    legal_actions: ["refresh_compatibility"],
    findings: [{ field: "model", reason: "changed" }],
  }), true);
  assert.equal(validate("flow.rejection.v1", {
    schema: "flow.rejection/v1",
    operation: "prepare",
    code: "compatibility_blocked",
    reason: "Drovr route is blocked",
    command_type: null,
    run_id: null,
    bundle_digest: null,
    authority_watermark: null,
    authority_watermark_domain: "host",
    legal_actions: [],
    findings: [{ field: "model" }],
  }), false);
});

test("public host schemas accept exact frames, status, and ordinary preparation", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const names = [
    "flow.transport-error.v1.schema.json",
    "flow.transport-request.v1.schema.json",
    "flow.transport-response.v1.schema.json",
    "flow.owner-endpoint.v1.schema.json",
    "flow.owner-status.v1.schema.json",
    "flow.runtime-runner-status.v1.schema.json",
    "flow.query.v1.schema.json",
    "flow.feature-preparation-request.v1.schema.json",
    "flow.dark-opt-in.v1.schema.json",
    "flow.feature-candidate-archive.v1.schema.json",
    "flow.feature-criterion-evidence.v1.schema.json",
    "flow.feature-critique-output.v1.schema.json",
    "flow.authority-critique-input-binding.v1.schema.json",
    "flow.review-integration-evidence.v1.schema.json",
    "flow.review-provenance.v1.schema.json",
    "work.review-target-refresh-command.v1.schema.json",
    "flow.review-inbox-watermark.v1.schema.json",
    "flow.review-inbox-projection.v1.schema.json",
    "flow.review-inbox-item.v1.schema.json",
  ];
  for (const name of names) {
    ajv.addSchema(JSON.parse(await readFile(join(root, "schemas", name), "utf8")));
  }
  const digest = `sha256:${"a".repeat(64)}`;
  const validate = (name, value) => ajv.getSchema(
    `https://dotfiles.local/schemas/${name}.schema.json`,
  )(value);

  assert.equal(validate("flow.transport-request.v1", {
    schema: "flow.transport-request/v1",
    interface: "flow.runtime/v1",
    version: 1,
    request_id: "request:one",
    operation: "query",
    request: { run_id: "run:one" },
  }), true);
  assert.equal(validate("flow.transport-response.v1", {
    schema: "flow.transport-response/v1",
    interface: "flow.runtime/v1",
    version: 1,
    request_id: "request:one",
    operation: "query",
    ok: true,
    done: true,
    result: { schema: "flow.run-index-projection/v1", runs: [] },
  }), true);
  assert.equal(validate("flow.query.v1", {
    schema: "flow.query/v1",
    query: "autonomous_runner_status",
  }), true);
  assert.equal(validate("flow.query.v1", {
    schema: "flow.query/v1",
    query: "review_inbox",
  }), true);
  assert.equal(validate("flow.query.v1", {
    schema: "flow.query/v1",
    query: "autonomous_runner_status",
    extra: "rejected",
  }), false);
  assert.equal(validate("flow.transport-response.v1", {
    schema: "flow.transport-response/v1",
    interface: "flow.runtime/v1",
    version: 1,
    request_id: null,
    operation: null,
    ok: false,
    done: true,
    error: {
      schema: "flow.transport-error/v1",
      version: 1,
      code: "invalid_json",
    },
  }), true);
  assert.equal(validate("flow.owner-endpoint.v1", {
    schema: "flow.owner-endpoint/v1",
    version: 1,
    owner_token: "owner:one-token",
    pid: 42,
    process_identity: "owner:one-token",
    process_start_identity: "42:one",
    authority_directory: "/state/flow",
    endpoint_path: "/state/flow/owner.json",
    socket_path: "/state/flow/owner.sock",
    started_at: "2026-09-14T00:00:00.000Z",
  }), true);
  assert.equal(validate("flow.owner-status.v1", {
    schema: "flow.owner-status/v1",
    version: 1,
    state: "stopped",
    endpoint_path: "/state/flow/owner.json",
    socket_path: "/state/flow/owner.sock",
    authority_directory: "/state/flow",
    pid: null,
    process_identity: null,
    process_start_identity: null,
    started_at: null,
  }), true);
  assert.equal(validate("flow.owner-status.v1", {
    schema: "flow.owner-status/v1",
    version: 1,
    state: "unknown",
    endpoint_path: "/state/flow/owner.json",
    socket_path: "/state/flow/owner.sock",
    authority_directory: "/state/flow",
    pid: 42,
    process_identity: "owner:one-token",
    process_start_identity: "platform-identity-unavailable",
    started_at: "2026-09-14T00:00:00.000Z",
    reason: "identity_unavailable",
  }), true);
  assert.equal(validate("flow.owner-status.v1", {
    schema: "flow.owner-status/v1",
    version: 1,
    state: "running",
    endpoint_path: "/state/flow/owner.json",
    socket_path: "/state/flow/owner.sock",
    authority_directory: "/state/flow",
    pid: 42,
    process_identity: "owner:one-token",
    process_start_identity: "42:one",
    started_at: "2026-09-14T00:00:00.000Z",
    operator_errors: {
      count: 17,
      suppressed: 1,
      last: {
        source: "transport",
        name: "Error",
        message: "Flow transport error",
        code: "transport_error",
      },
    },
  }), true);
  assert.equal(validate("flow.runtime-runner-status.v1", {
    schema: "flow.runtime-runner-status/v1",
    state: "running",
    runs: { active: 1, executing: 1, waiting: 0, suspended: 0, retained: 0 },
    delegates: { active: 1, capacity: 1, available: 0 },
    operations: { active: 0, capacity: 1, available: 1 },
    pending_commands: 1,
    errors: { count: 0, reported: 0, suppressed: 0, last: null },
  }), true);
  const preparation = {
    schema: "flow.feature-preparation-request/v1",
    brief: {
      schema: "flow.feature-brief/v1",
      id: "brief:one",
      summary: "A bounded feature",
      acceptance: ["the behavior is observable"],
    },
    repository: { path: "/work/repository" },
    mode: "verify",
    routes: {
      apply: { launch: { harness: "codex", capability: "workspace-write" } },
      critique: { launch: { harness: "claude", capability: "read-only" } },
    },
    limits: { max_elapsed_seconds: 600 },
  };
  assert.equal(validate("flow.feature-preparation-request.v1", preparation), true);
  assert.equal(validate("flow.feature-candidate-archive.v1", {
    artifact_schema: "flow.feature-candidate-archive/v1",
    bytes_digest: digest,
    digest,
    size: 12,
  }), true);
  assert.equal(validate("flow.feature-criterion-evidence.v1", {
    schema: "flow.feature-criterion-evidence/v1",
    criteria: [{
      criterion: "the changed behavior is observable",
      expected: "after\n",
      kind: "git_file_equals",
      target: "feature.txt",
    }],
  }), true);
  const critiqueDigest = `sha256:${"b".repeat(64)}`;
  const critique = {
    schema: "flow.delegate-evidence/v1",
    observation: "independent critique",
    feature_critique: {
      schema: "flow.feature-critique-output/v1",
      candidate_digest: critiqueDigest,
      predecessor_evidence_digest: `sha256:${"c".repeat(64)}`,
      task_inputs_digest: `sha256:${"d".repeat(64)}`,
      criteria: [{
        criterion: "the behavior is observable",
        evidence: {
          kind: "git_file_equals",
          target: "feature.txt",
          expected: "after\n",
        },
        evidence_digest: `sha256:${"e".repeat(64)}`,
        verdict: "passed",
      }],
      findings: [],
    },
  };
  assert.equal(validate("flow.feature-critique-output.v1", critique), true);
  assert.equal(validate("flow.authority-critique-input-binding.v1", {
    schema: "flow.authority-critique-input-binding/v1",
    card_id: "feature-critique",
    candidate_digest: critiqueDigest,
    predecessor_evidence_digest: `sha256:${"c".repeat(64)}`,
    binding_digest: `sha256:${"f".repeat(64)}`,
  }), true);
  assert.equal(validate("flow.authority-critique-input-binding.v1", {
    schema: "flow.authority-critique-input-binding/v1",
    card_id: "feature-critique",
    candidate_digest: critiqueDigest,
    predecessor_evidence_digest: `sha256:${"c".repeat(64)}`,
    binding_digest: `sha256:${"f".repeat(64)}`,
    forged: true,
  }), false);

  const forbidden = { ...preparation, future_output_hash: digest };
  assert.equal(validate("flow.feature-preparation-request.v1", forbidden), false);
  for (const field of ["schema", "mode", "routes"]) {
    const missing = structuredClone(preparation);
    delete missing[field];
    assert.equal(validate("flow.feature-preparation-request.v1", missing), false);
  }
  const delegationAlias = structuredClone(preparation);
  delete delegationAlias.routes;
  delegationAlias.delegation = preparation.routes;
  assert.equal(
    validate("flow.feature-preparation-request.v1", delegationAlias),
    false,
  );
  const unknownNested = structuredClone(preparation);
  unknownNested.routes.apply.launch.undocumented = true;
  assert.equal(
    validate("flow.feature-preparation-request.v1", unknownNested),
    false,
  );
});

test("review inbox actions are closed public commands and materialize through their input templates", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const inboxSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.review-inbox-projection.v1.schema.json"),
    "utf8",
  ));
  const inboxItemSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.review-inbox-item.v1.schema.json"),
    "utf8",
  ));
  const commandSchema = JSON.parse(await readFile(
    join(root, "schemas", "work.review-human-command.v1.schema.json"),
    "utf8",
  ));
  const refreshCommandSchema = JSON.parse(await readFile(
    join(root, "schemas", "work.review-target-refresh-command.v1.schema.json"),
    "utf8",
  ));
  const integrationEvidenceSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.review-integration-evidence.v1.schema.json"),
    "utf8",
  ));
  const provenanceSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.review-provenance.v1.schema.json"),
    "utf8",
  ));
  const inboxWatermarkSchema = JSON.parse(await readFile(
    join(root, "schemas", "flow.review-inbox-watermark.v1.schema.json"),
    "utf8",
  ));
  assert.equal(Object.hasOwn(inboxSchema.$defs ?? {}, "item"), false);
  assert.deepEqual(inboxSchema.properties.items.items, {
    "$ref": "https://dotfiles.local/schemas/flow.review-inbox-item.v1.schema.json",
  });
  ajv.addSchema(inboxSchema);
  ajv.addSchema(inboxItemSchema);
  ajv.addSchema(commandSchema);
  ajv.addSchema(refreshCommandSchema);
  ajv.addSchema(integrationEvidenceSchema);
  ajv.addSchema(provenanceSchema);
  ajv.addSchema(inboxWatermarkSchema);
  const digest = (character) => `sha256:${character.repeat(64)}`;
  const review = (subjectId, watermark, fields = {}) => {
    const candidate = schemaCandidateRecord();
    const summary = schemaReviewSummary({
      candidateFingerprint: candidate.candidate_fingerprint,
      candidateAuthorityWatermark: digest("c"),
      lifecycleGeneration: 1,
      sourceAuthorityWatermark: digest("a"),
    });
    return {
      schema: "flow.review-projection/v1",
      contract: "work.review/v1",
      subject_id: subjectId,
      watermark,
      authority_watermark: watermark,
      authority_watermark_domain: "review",
      target_fingerprint: candidate.candidate_fingerprint,
      candidate_fingerprint: candidate.candidate_fingerprint,
      target_authority_watermark: digest("c"),
      candidate_authority_watermark: digest("c"),
      lifecycle_generation: 1,
      candidate,
      status: "automated_completed",
      current: true,
      evidence_currency: "current",
      posture: summary.posture,
      findings: summary.findings,
      semantic_findings: summary.findings,
      rendered_findings: summary.rendered_findings,
      cap_reasons: summary.cap_reasons,
      urgency_floor: summary.urgency_floor,
      orientation: summary.orientation,
      diagrams: summary.diagrams,
      coverage: summary.coverage,
      merge_ready: false,
      summary,
      automated_evidence: summary.automated_evidence,
      artifacts: schemaReviewArtifacts({
        watermark,
        candidateFingerprint: candidate.candidate_fingerprint,
        candidateAuthorityWatermark: digest("c"),
        sourceAuthorityWatermark: digest("a"),
      }),
      automated_completion: true,
      approval: "not_requested",
      review_generation: 1,
      review_authority_watermark: watermark,
      comments: [],
      dispositions: [],
      session: {
        schema: "flow.review-session/v1",
        session_id: `session:${subjectId}`,
        review_id: subjectId,
        target_fingerprint: candidate.candidate_fingerprint,
        candidate_authority_watermark: digest("c"),
        lifecycle_generation: 1,
        review_authority_watermark: watermark,
      },
      integration_authorized: false,
      blocking_reasons: [],
      ...fields,
    };
  };
  const inbox = projectReviewInbox({
    reviews: [
      review("review:start", digest("d"), {
        review_generation: 0,
        session: null,
      }),
      review("review:approve", digest("e")),
      review("review:integrate", digest("f"), {
        approval: "approved",
      }),
    ],
  });
  const validateInbox = ajv.getSchema(
    "https://dotfiles.local/schemas/flow.review-inbox-projection.v1.schema.json",
  );
  const validateCommand = ajv.getSchema(
    "https://dotfiles.local/schemas/work.review-human-command.v1.schema.json",
  );
  const validateIntegrationEvidence = ajv.getSchema(
    "https://dotfiles.local/schemas/flow.review-integration-evidence.v1.schema.json",
  );
  const exactIntegrationEvidence = {
    schema: "flow.review-integration-evidence/v1",
    candidate_fingerprint: digest("b"),
    lifecycle_generation: 1,
  };
  assert.equal(validateIntegrationEvidence(exactIntegrationEvidence), true);
  assert.equal(validateIntegrationEvidence({
    ...exactIntegrationEvidence,
    receipt: "caller-shaped",
  }), false);
  const validateProvenance = ajv.getSchema(provenanceSchema.$id);
  const exactProvenance = {
    schema: "flow.review-provenance/v1",
    operation_contract: "flow.operation/review-record/v1",
    operation_idempotency_key: "idempotency:contract",
    run_id: "run:contract",
    operation_effect_id: "effect:contract",
    operation_attempt_id: "attempt:contract",
    candidate_fingerprint: digest("b"),
    lifecycle_generation: 1,
    candidate_authority_watermark: digest("c"),
    source_authority_watermark: digest("a"),
    review_authority_watermark: digest("e"),
  };
  assert.equal(validateProvenance(exactProvenance), true,
    ajv.errorsText(validateProvenance.errors));
  assert.equal(validateProvenance({}), false);
  assert.equal(validateProvenance({ ...exactProvenance, extra: true }), false);
  const missingProvenanceField = structuredClone(exactProvenance);
  delete missingProvenanceField.candidate_fingerprint;
  assert.equal(validateProvenance(missingProvenanceField), false);
  assert.equal(validateInbox(inbox), true, ajv.errorsText(validateInbox.errors));

  const legalTypes = new Set([
    "review_session_start",
    "review_comment",
    "review_disposition",
    "review_approval",
    "review_supersession",
    "review_integration",
  ]);
  const valuesFor = (action) => {
    if (action.type === "review_session_start") {
      return { session_id: `${action.subject_id}:materialized` };
    }
    if (action.type === "review_comment") {
      return {
        comment_id: `${action.subject_id}:comment`,
        body: "An operator comment supplied by the replaceable review consumer.",
      };
    }
    if (action.type === "review_disposition") return { disposition: "accept" };
    if (action.type === "review_supersession") {
      return {
        replacement: {
          candidate_fingerprint: digest("9"),
          lifecycle_generation: 1,
        },
      };
    }
    if (action.type === "review_integration") {
      return {
        evidence: {
          schema: "flow.review-integration-evidence/v1",
          candidate_fingerprint: action.candidate_fingerprint,
          lifecycle_generation: action.lifecycle_generation,
        },
      };
    }
    return {};
  };
  const materialize = (action) => {
    const { operator_input: _operatorInput, ...command } = action;
    return { ...command, ...valuesFor(action) };
  };

  const projectedActions = inbox.items.flatMap(({ legal_actions: actions }) => actions);
  assert.deepEqual(
    new Set(projectedActions.map(({ type }) => type)),
    legalTypes,
  );
  for (const action of projectedActions) {
    assert.equal(legalTypes.has(action.type), true);
    assert.equal(Object.hasOwn(action, "run_id"), false);
    assert.equal(Object.hasOwn(action, "operation"), false);
    assert.equal(Object.hasOwn(action, "git_integrate"), false);
    assert.equal(validateCommand(action), true, ajv.errorsText(validateCommand.errors));
    const command = materialize(action);
    assert.equal(validateCommand(command), true, ajv.errorsText(validateCommand.errors));
  }
  const templateAction = projectedActions.find(({ type }) =>
    type === "review_comment");
  assert.equal(validateCommand({
    ...templateAction,
    operator_input: {
      ...templateAction.operator_input,
      required: ["body"],
    },
  }), false);
  assert.equal(validateCommand({
    ...templateAction,
    operator_input: {
      ...templateAction.operator_input,
      action: "review_disposition",
    },
  }), false);
  const dispositionTemplate = projectedActions.find(({ type }) =>
    type === "review_disposition");
  const { optional: _optional, ...dispositionWithoutOptional } =
    dispositionTemplate.operator_input;
  assert.equal(validateCommand({
    ...dispositionTemplate,
    operator_input: dispositionWithoutOptional,
  }), false);
  assert.equal(validateCommand({
    ...dispositionTemplate,
    operator_input: {
      ...dispositionTemplate.operator_input,
      allowed_dispositions: ["accept"],
    },
  }), false);
  assert.equal(validateCommand({
    ...dispositionTemplate,
    finding_id: "finding:mixed-template",
  }), false);
  assert.equal(validateCommand({
    ...materialize(dispositionTemplate),
    finding_id: "finding:materialized",
  }), true);
  const refreshObservationIdentity = {
    schema: "flow.review-target-observation/v1",
    subject_id: "review:start",
    candidate_id: "candidate:start",
    candidate_fingerprint: digest("c"),
    lifecycle_generation: 2,
    authority_watermark: digest("f"),
    source: "named_mechanism_observation",
  };
  const refreshAction = {
    schema: "work.review-target-refresh-command/v1",
    type: "review_target_refresh",
    contract: "work.review/v1",
    subject_id: "review:start",
    command_id: `review-target-refresh:review:start:${digest("c")}:2`,
    expected_watermark: digest("d"),
    prior_candidate_fingerprint: digest("b"),
    prior_lifecycle_generation: 1,
    observed_candidate_fingerprint: digest("c"),
    observed_lifecycle_generation: 2,
    authority_observation: {
      ...refreshObservationIdentity,
      evidence_digest: canonicalDigest(refreshObservationIdentity),
    },
  };
  const refreshInbox = structuredClone(inbox);
  refreshInbox.items[0].status = "stale";
  refreshInbox.items[0].current = false;
  refreshInbox.items[0].review.status = "stale";
  refreshInbox.items[0].review.current = false;
  refreshInbox.items[0].review.evidence_currency = "stale";
  refreshInbox.items[0].legal_actions = [refreshAction];
  refreshInbox.items[0].review.legal_actions = [refreshAction];
  assert.equal(validateInbox(refreshInbox), true,
    ajv.errorsText(validateInbox.errors));
  const currentWithRefreshAction = structuredClone(inbox);
  currentWithRefreshAction.items[0].review.legal_actions = [refreshAction];
  assert.equal(validateInbox(currentWithRefreshAction), false);
  const staleWithHumanAction = structuredClone(refreshInbox);
  staleWithHumanAction.items[0].review.status = "stale";
  staleWithHumanAction.items[0].review.current = false;
  staleWithHumanAction.items[0].review.evidence_currency = "stale";
  staleWithHumanAction.items[0].review.legal_actions = [projectedActions[0]];
  assert.equal(validateInbox(staleWithHumanAction), false);
  const validateRefreshCommand = ajv.getSchema(
    "https://dotfiles.local/schemas/work.review-target-refresh-command.v1.schema.json",
  );
  const pairedRefreshAction = {
    ...refreshAction,
    prior_mutation_epoch: 1,
    observed_mutation_epoch: 2,
  };
  assert.equal(validateRefreshCommand(pairedRefreshAction), true,
    ajv.errorsText(validateRefreshCommand.errors));
  const refreshWithoutObservedEpoch = structuredClone(pairedRefreshAction);
  delete refreshWithoutObservedEpoch.observed_mutation_epoch;
  assert.equal(validateRefreshCommand(refreshWithoutObservedEpoch), false);
  const refreshWithoutPriorEpoch = structuredClone(pairedRefreshAction);
  delete refreshWithoutPriorEpoch.prior_mutation_epoch;
  assert.equal(validateRefreshCommand(refreshWithoutPriorEpoch), false);
  const pairedRefreshInbox = structuredClone(refreshInbox);
  pairedRefreshInbox.items[0].legal_actions = [pairedRefreshAction];
  pairedRefreshInbox.items[0].review.legal_actions = [pairedRefreshAction];
  assert.equal(validateInbox(pairedRefreshInbox), true,
    ajv.errorsText(validateInbox.errors));
  const invalidRefreshObservation = structuredClone(refreshInbox);
  invalidRefreshObservation.items[0].legal_actions[0].authority_observation
    .candidate_fingerprint = 42;
  assert.equal(validateInbox(invalidRefreshObservation), false);
  const invalidRefreshExtra = structuredClone(refreshInbox);
  invalidRefreshExtra.items[0].legal_actions[0].undocumented = true;
  assert.equal(validateInbox(invalidRefreshExtra), false);
  const invalidRefreshWatermark = structuredClone(refreshInbox);
  invalidRefreshWatermark.items[0].legal_actions[0].expected_watermark = 42;
  assert.equal(validateInbox(invalidRefreshWatermark), false);
  const supersessionTemplate = projectedActions.find(({ type }) =>
    type === "review_supersession");
  const {
    replacement: _replacement,
    ...supersessionWithoutReplacement
  } = supersessionTemplate.operator_input;
  assert.equal(validateCommand({
    ...supersessionTemplate,
    operator_input: supersessionWithoutReplacement,
  }), false);
  const integrationTemplate = projectedActions.find(({ type }) =>
    type === "review_integration");
  const { evidence_schema: _evidenceSchema, ...integrationWithoutSchema } =
    integrationTemplate.operator_input;
  assert.equal(validateCommand({
    ...integrationTemplate,
    operator_input: integrationWithoutSchema,
  }), false);
  const actionTemplates = new Map(projectedActions.map((action) => [
    action.type,
    action,
  ]));
  const crossActionOperatorInputs = [
    ["review_session_start", "allowed_dispositions", ["accept"]],
    ["review_session_start", "evidence_schema", "flow.review-integration-evidence/v1"],
    ["review_session_start", "replacement", {
      required: ["candidate_fingerprint", "lifecycle_generation"],
    }],
    ["review_comment", "allowed_dispositions", ["accept"]],
    ["review_comment", "evidence_schema", "flow.review-integration-evidence/v1"],
    ["review_comment", "replacement", {
      required: ["candidate_fingerprint", "lifecycle_generation"],
    }],
    ["review_disposition", "evidence_schema", "flow.review-integration-evidence/v1"],
    ["review_disposition", "replacement", {
      required: ["candidate_fingerprint", "lifecycle_generation"],
    }],
    ["review_supersession", "allowed_dispositions", ["accept"]],
    ["review_supersession", "evidence_schema", "flow.review-integration-evidence/v1"],
    ["review_integration", "allowed_dispositions", ["accept"]],
    ["review_integration", "replacement", {
      required: ["candidate_fingerprint", "lifecycle_generation"],
    }],
  ];
  for (const [actionType, property, value] of crossActionOperatorInputs) {
    const action = actionTemplates.get(actionType);
    assert.ok(action, `missing projected ${actionType} template`);
    assert.equal(validateCommand({
      ...action,
      operator_input: {
        ...action.operator_input,
        [property]: value,
      },
    }), false, `${actionType} unexpectedly accepted ${property}`);
  }
  const invalidAction = structuredClone(inbox);
  invalidAction.items[0].legal_actions[0].type = "review_action_alias";
  assert.equal(validateInbox(invalidAction), false);
  const invalidNestedProjection = structuredClone(inbox);
  invalidNestedProjection.items[0].review.undocumented = true;
  assert.equal(validateInbox(invalidNestedProjection), false);
  const duplicateWatermark = structuredClone(inbox);
  duplicateWatermark.subject_watermarks.push(
    structuredClone(duplicateWatermark.subject_watermarks[0]),
  );
  assert.equal(validateInbox(duplicateWatermark), false);
  const invalidStreamIdentity = structuredClone(inbox);
  invalidStreamIdentity.subject_watermarks[0].stream_id = "subject:not-a-work-stream";
  assert.equal(validateInbox(invalidStreamIdentity), false);
  const candidateGit = {
    clean: true,
    commit_sha: "a".repeat(40),
    ref: "refs/heads/contract",
    tree_sha: "b".repeat(40),
  };
  const candidateWorkspace = {
    contract: "work.workspace/v1",
    fingerprint: digest("c"),
    generation: 1,
    mutation_epoch: 1,
    subject_id: "workspace:contract",
  };
  const candidateVerification = {
    schema: "work.feature-verification-receipt/v1",
    brief_id: "brief:contract",
    acceptance_criteria: [{
      criterion: "the candidate is ready",
      evidence_digest: digest("f"),
      verdict: "passed",
    }],
    discriminating_evidence: {
      schema: "flow.feature-discriminating-evidence/v1",
      kind: "safe_baseline",
      selected_fingerprint: digest("e"),
      post_mutation_fingerprint: digest("d"),
      distinguished: true,
    },
    selected_evidence_fingerprint: digest("e"),
    workspace: {
      subject_id: candidateWorkspace.subject_id,
      generation: candidateWorkspace.generation,
      mutation_epoch: candidateWorkspace.mutation_epoch,
      fingerprint: candidateWorkspace.fingerprint,
      git: candidateGit,
    },
    source_authority_watermark: digest("a"),
    operation_contract: "flow.operation/feature-verify/v1",
    effect_id: "effect:contract-verify",
    attempt_id: "attempt:contract-verify",
    idempotency_key: "idempotency:contract-verify",
    receipt_digest: digest("b"),
    self_digest: digest("b"),
  };
  const candidateCritique = {
    schema: "work.feature-critique-receipt/v1",
    delegate_evidence: {
      card_id: "feature-critique",
      effect_id: "effect:contract-critique",
      attempt_id: "attempt:contract-critique",
      idempotency_key: "idempotency:contract-critique",
      source_authority_watermark: digest("c"),
      evidence: "independent critique evidence",
    },
    findings: [],
    operation_contract: "flow.delegated-agent-port/v1",
    effect_id: "effect:contract-critique",
    idempotency_key: "idempotency:contract-critique",
    source_authority_watermark: digest("c"),
    receipt_digest: digest("d"),
    self_digest: digest("d"),
  };
  const candidateRecord = {
    schema: "work.review-candidate/v1",
    candidate_id: "candidate:contract",
    candidate_fingerprint: digest("b"),
    git: candidateGit,
    workspace: candidateWorkspace,
    verification: candidateVerification,
    critique: candidateCritique,
    artifacts: [{
      artifact_schema: "example.candidate/v1",
      digest: digest("d"),
      generation: 1,
    }],
    git_retention: {
      schema: "flow.git-retention-receipt/v1",
      repository_id: "github.com/example/contract",
      commit_sha: candidateGit.commit_sha,
      tree_sha: candidateGit.tree_sha,
      retention_ref: "refs/flow/contract",
    },
  };
  const candidateProjection = {
    schema: "work.review-candidate-projection/v1",
    contract: "work.review/v1",
    subject_id: "candidate:contract",
    watermark: digest("a"),
    generation: 1,
    status: "sealed",
    current: true,
    evidence_currency: "current",
    candidate_fingerprint: digest("b"),
    git: candidateGit,
    workspace: candidateWorkspace,
    verification: candidateVerification,
    critique: candidateCritique,
    artifacts: candidateRecord.artifacts,
    git_retention: candidateRecord.git_retention,
    candidate: candidateRecord,
    registration_receipt: {
      schema: "work.idempotency-receipt/v1",
      command_id: "candidate-register:contract",
      command_digest: digest("e"),
    },
    command_receipts: [],
    blocking_reasons: [],
    legal_actions: [],
  };
  const inboxWithCandidate = projectReviewInbox({
    candidates: [candidateProjection],
    reviews: [review("review:contract", digest("d"), {
      candidate: candidateRecord,
    })],
  });
  assert.equal(validateInbox(inboxWithCandidate), true,
    ajv.errorsText(validateInbox.errors));

  const typedResult = {
    schema: "flow.review-result/v1",
    posture: "no_findings",
    findings: [],
    coverage: {
      schema: "flow.review-coverage/v1",
      status: "produced",
      reason: null,
    },
    evidence: null,
    cap_reasons: [],
  };
  const typedReviewSummary = {
    schema: "flow.review-summary/v1",
    candidate_fingerprint: digest("b"),
    candidate_authority_watermark: digest("c"),
    lifecycle_generation: 1,
    enabled_lenses: ["security"],
    finding_cap: 10,
    urgency_floor: "info",
    orientation: null,
    diagrams: [],
    lens_results: [typedResult],
    critic_result: typedResult,
    findings: [],
    rendered_findings: [],
    cap_reasons: [],
    posture: "no_findings",
    coverage: {
      schema: "flow.review-coverage/v1",
      complete: true,
      lenses: [{ lens: "security", status: "produced", reason: null }],
      critic: { lens: "critic", status: "produced", reason: null },
    },
    merge_ready: false,
    automated_evidence: {
      schema: "flow.review-automated-evidence/v1",
      source_authority_watermark: digest("a"),
      lens_evidence: [{ lens: "security", evidence_digest: digest("d") }],
      critic_evidence_digest: digest("e"),
    },
  };
  const githubSnapshot = {
    schema: "flow.github-pull-request-snapshot/v1",
    repository: { owner: "acme", name: "example" },
    pull_request_number: 42,
    state: "open",
    base_sha: "b".repeat(40),
    head_sha: "c".repeat(40),
    diff_sha256: digest("d"),
  };
  const githubTarget = {
    schema: "flow.review-github-pull-request/v1",
    repository: { owner: "acme", name: "example" },
    pull_request_number: 42,
    lifecycle_generation: 4,
    target_authority_watermark: digest("f"),
    snapshot: githubSnapshot,
    snapshot_fingerprint: canonicalDigest(githubSnapshot),
  };
  const githubSummary = structuredClone(typedReviewSummary);
  githubSummary.candidate_fingerprint = githubTarget.snapshot_fingerprint;
  githubSummary.candidate_authority_watermark = githubTarget.target_authority_watermark;
  githubSummary.lifecycle_generation = githubTarget.lifecycle_generation;
  const githubArtifacts = {
    schema: "flow.review-artifacts/v1",
    watermark: digest("a"),
    provenance: {
      schema: "flow.review-provenance/v1",
      operation_contract: "flow.operation/review-record/v1",
      operation_idempotency_key: "idempotency:github-contract",
      run_id: "run:github-contract",
      operation_effect_id: "effect:github-contract",
      operation_attempt_id: "attempt:github-contract",
      candidate_fingerprint: githubTarget.snapshot_fingerprint,
      lifecycle_generation: githubTarget.lifecycle_generation,
      candidate_authority_watermark: githubTarget.target_authority_watermark,
      source_authority_watermark: digest("a"),
      review_authority_watermark: digest("e"),
    },
    formats: { json: "{}", markdown: "", html: "" },
    digests: {
      json: digest("b"),
      markdown: digest("c"),
      html: digest("d"),
    },
  };
  const githubReview = projectGitHubReviewRecord({
    schema: "flow.github-review-record/v1",
    review_id: `review:github:${githubTarget.snapshot_fingerprint}:4`,
    target: githubTarget,
    target_fingerprint: githubTarget.snapshot_fingerprint,
    target_authority_watermark: githubTarget.target_authority_watermark,
    lifecycle_generation: githubTarget.lifecycle_generation,
    summary: githubSummary,
    automated_evidence: githubSummary.automated_evidence,
    artifacts: githubArtifacts,
    source_run_id: "run:github-contract",
    operation_contract: "flow.operation/review-record/v1",
    operation_effect_id: "effect:github-contract",
    operation_attempt_id: "attempt:github-contract",
    operation_idempotency_key: "idempotency:github-contract",
  }, digest("e"), [{
    command_receipt: {
      schema: "work.idempotency-receipt/v1",
      command_id: "github-review-record:contract",
      command_digest: digest("e"),
    },
  }]);
  const githubInbox = projectReviewInbox({ reviews: [githubReview] });
  assert.equal(githubInbox.items[0].review.target_kind, "github");
  assert.equal(validateInbox(githubInbox), true,
    ajv.errorsText(validateInbox.errors));
  const githubWithTopLevelHumanAction = structuredClone(githubInbox);
  githubWithTopLevelHumanAction.items[0].legal_actions = [projectedActions[0]];
  assert.equal(validateInbox(githubWithTopLevelHumanAction), false);
  const githubWithNestedHumanAction = structuredClone(githubInbox);
  githubWithNestedHumanAction.items[0].review.legal_actions = [projectedActions[0]];
  assert.equal(validateInbox(githubWithNestedHumanAction), false);
  const githubWithRefreshAction = structuredClone(githubInbox);
  githubWithRefreshAction.items[0].legal_actions = [refreshAction];
  githubWithRefreshAction.items[0].review.legal_actions = [refreshAction];
  assert.equal(validateInbox(githubWithRefreshAction), false);
  const githubWithHumanApproval = structuredClone(githubInbox);
  githubWithHumanApproval.items[0].review.approval = "approved";
  assert.equal(validateInbox(githubWithHumanApproval), false);
  const githubWithHumanSession = structuredClone(githubInbox);
  githubWithHumanSession.items[0].review.session = null;
  assert.equal(validateInbox(githubWithHumanSession), false);
  const githubWithHumanComments = structuredClone(githubInbox);
  githubWithHumanComments.items[0].review.comments = [];
  assert.equal(validateInbox(githubWithHumanComments), false);
  const githubWithHumanDispositions = structuredClone(githubInbox);
  githubWithHumanDispositions.items[0].review.dispositions = [];
  assert.equal(validateInbox(githubWithHumanDispositions), false);
  const githubWithIntegration = structuredClone(githubInbox);
  githubWithIntegration.items[0].review.integration = {
    schema: "flow.review-integration/v1",
    session_id: "session:forged",
    evidence: {
      schema: "flow.review-integration-evidence/v1",
      candidate_fingerprint: githubTarget.snapshot_fingerprint,
      lifecycle_generation: githubTarget.lifecycle_generation,
    },
    evidence_digest: digest("e"),
  };
  assert.equal(validateInbox(githubWithIntegration), false);
  const githubWithSupersession = structuredClone(githubInbox);
  githubWithSupersession.items[0].review.human_status = "superseded";
  assert.equal(validateInbox(githubWithSupersession), false);
  const githubWithInvalidation = structuredClone(githubInbox);
  githubWithInvalidation.items[0].review.invalidation = {
    schema: "flow.review-target-invalidation/v1",
    subject_id: githubTarget.snapshot_fingerprint,
    prior_candidate_fingerprint: githubTarget.snapshot_fingerprint,
    prior_lifecycle_generation: githubTarget.lifecycle_generation,
    observed_candidate_fingerprint: digest("a"),
    observed_lifecycle_generation: githubTarget.lifecycle_generation + 1,
    reason: "target_moved",
    observation: refreshAction.authority_observation,
  };
  assert.equal(validateInbox(githubWithInvalidation), false);
  const githubWithRefresh = structuredClone(githubInbox);
  githubWithRefresh.items[0].review.refresh = {
    schema: "flow.review-target-refresh/v1",
    subject_id: githubTarget.snapshot_fingerprint,
    prior_candidate_fingerprint: githubTarget.snapshot_fingerprint,
    prior_lifecycle_generation: githubTarget.lifecycle_generation,
    observed_candidate_fingerprint: digest("a"),
    observed_lifecycle_generation: githubTarget.lifecycle_generation + 1,
    observation: refreshAction.authority_observation,
  };
  assert.equal(validateInbox(githubWithRefresh), false);
  const githubStaleReview = structuredClone(githubInbox);
  githubStaleReview.items[0].status = "stale";
  githubStaleReview.items[0].current = false;
  githubStaleReview.items[0].review.status = "stale";
  githubStaleReview.items[0].review.current = false;
  githubStaleReview.items[0].review.evidence_currency = "stale";
  githubStaleReview.items[0].legal_actions = [];
  githubStaleReview.items[0].review.legal_actions = [];
  assert.equal(validateInbox(githubStaleReview), true,
    ajv.errorsText(validateInbox.errors));
  const invalidGithubOwner = structuredClone(githubInbox);
  invalidGithubOwner.items[0].review.target.repository.owner = 42;
  assert.equal(validateInbox(invalidGithubOwner), false);
  const invalidGithubSnapshot = structuredClone(githubInbox);
  invalidGithubSnapshot.items[0].review.target.snapshot.state = "closed";
  assert.equal(validateInbox(invalidGithubSnapshot), false);
  const invalidGithubTargetField = structuredClone(githubInbox);
  invalidGithubTargetField.items[0].review.target.unexpected = true;
  assert.equal(validateInbox(invalidGithubTargetField), false);
  const typedReview = review("review:typed", digest("e"), {
    candidate: candidateRecord,
    posture: typedReviewSummary.posture,
    coverage: typedReviewSummary.coverage,
    automated_evidence: typedReviewSummary.automated_evidence,
    artifacts: schemaReviewArtifacts({
      watermark: digest("e"),
      candidateFingerprint: digest("b"),
      candidateAuthorityWatermark: digest("c"),
      sourceAuthorityWatermark: digest("a"),
    }),
    session: {
      schema: "flow.review-session/v1",
      session_id: "session:typed",
      review_id: "review:typed",
      target_fingerprint: digest("b"),
      candidate_authority_watermark: digest("c"),
      lifecycle_generation: 1,
      review_authority_watermark: digest("e"),
    },
    comments: [{
      schema: "flow.review-comment/v1",
      comment_id: "comment:typed",
      session_id: "session:typed",
      body: "A typed comment.",
    }],
    dispositions: [{
      schema: "flow.review-disposition/v1",
      session_id: "session:typed",
      finding_id: "finding:typed",
      disposition: "accept",
    }],
    summary: typedReviewSummary,
  });
  const typedInbox = projectReviewInbox({ reviews: [typedReview] });
  assert.equal(validateInbox(typedInbox), true,
    ajv.errorsText(validateInbox.errors));
  const supersededInbox = structuredClone(typedInbox);
  supersededInbox.items[0].review.status = "stale";
  supersededInbox.items[0].review.current = false;
  supersededInbox.items[0].review.evidence_currency = "stale";
  supersededInbox.items[0].review.human_status = "superseded";
  supersededInbox.items[0].review.approval = "ineligible";
  supersededInbox.items[0].review.approval_eligible = false;
  supersededInbox.items[0].review.integration_authorized = false;
  supersededInbox.items[0].review.legal_actions = [];
  supersededInbox.items[0].status = "stale";
  supersededInbox.items[0].current = false;
  supersededInbox.items[0].legal_actions = [];
  assert.equal(validateInbox(supersededInbox), true,
    ajv.errorsText(validateInbox.errors));
  const supersededWithCurrentStatus = structuredClone(supersededInbox);
  supersededWithCurrentStatus.items[0].review.status = "automated_completed";
  assert.equal(validateInbox(supersededWithCurrentStatus), false);
  for (const field of [
    "candidate",
    "summary",
    "automated_evidence",
    "artifacts",
    "posture",
  ]) {
    const missingReviewField = structuredClone(typedInbox);
    delete missingReviewField.items[0].review[field];
    assert.equal(validateInbox(missingReviewField), false, field);
  }
  const missingCandidateCurrency = structuredClone(inboxWithCandidate);
  delete missingCandidateCurrency.items[0].candidate.status;
  assert.equal(validateInbox(missingCandidateCurrency), false);
  for (const field of [
    "generation",
    "git",
    "workspace",
    "verification",
    "critique",
    "artifacts",
    "git_retention",
    "candidate",
    "registration_receipt",
    "command_receipts",
    "blocking_reasons",
  ]) {
    const missingCandidateField = structuredClone(inboxWithCandidate);
    delete missingCandidateField.items[0].candidate[field];
    assert.equal(validateInbox(missingCandidateField), false, field);
  }
  const missingReviewAuthorityWatermark = structuredClone(typedInbox);
  delete missingReviewAuthorityWatermark.items[0].review.authority_watermark;
  assert.equal(validateInbox(missingReviewAuthorityWatermark), false);
  const undocumentedBlockingReason = structuredClone(typedInbox);
  undocumentedBlockingReason.items[0].review.blocking_reasons = [
    "undocumented_reason",
  ];
  assert.equal(validateInbox(undocumentedBlockingReason), false);
  const invalidComments = structuredClone(typedInbox);
  invalidComments.items[0].review.comments = 42;
  assert.equal(validateInbox(invalidComments), false);
  const invalidCommentEntry = structuredClone(typedInbox);
  invalidCommentEntry.items[0].review.comments = [42];
  assert.equal(validateInbox(invalidCommentEntry), false);
  const invalidSession = structuredClone(typedInbox);
  invalidSession.items[0].review.session.session_id = 42;
  assert.equal(validateInbox(invalidSession), false);
  const invalidDispositions = structuredClone(typedInbox);
  invalidDispositions.items[0].review.dispositions[0].disposition = 42;
  assert.equal(validateInbox(invalidDispositions), false);
  const invalidSummary = structuredClone(typedInbox);
  invalidSummary.items[0].review.summary.posture = 42;
  assert.equal(validateInbox(invalidSummary), false);
  const invalidCandidate = structuredClone(inboxWithCandidate);
  invalidCandidate.items[0].candidate.candidate.candidate_id = 42;
  assert.equal(validateInbox(invalidCandidate), false);
  const invalidTargetShape = structuredClone(typedInbox);
  invalidTargetShape.items[0].review.target = {
    schema: "flow.review-github-pull-request/v1",
    repository: { owner: 42, name: "example" },
  };
  assert.equal(validateInbox(invalidTargetShape), false);
  const invalidationShape = structuredClone(typedInbox);
  invalidationShape.items[0].review.invalidation = {
    schema: "flow.review-target-invalidation/v1",
    observed_candidate_fingerprint: 42,
  };
  assert.equal(validateInbox(invalidationShape), false);
  const refreshShape = structuredClone(typedInbox);
  refreshShape.items[0].review.refresh = {
    schema: "flow.review-target-refresh/v1",
    observed_lifecycle_generation: "moved",
  };
  assert.equal(validateInbox(refreshShape), false);
  const retentionShape = structuredClone(typedInbox);
  retentionShape.items[0].review.git_retention_observation = {
    schema: "flow.git-retention-observation/v1",
    available: "yes",
  };
  assert.equal(validateInbox(retentionShape), false);
  const invalidVerificationShape = structuredClone(typedInbox);
  invalidVerificationShape.items[0].review.candidate.verification = {
    schema: "work.feature-verification-receipt/v1",
    acceptance_criteria: "not-an-array",
  };
  assert.equal(validateInbox(invalidVerificationShape), false);
  const invalidCritiqueShape = structuredClone(typedInbox);
  invalidCritiqueShape.items[0].review.candidate.critique = {
    schema: "work.feature-critique-receipt/v1",
    findings: "not-an-array",
  };
  assert.equal(validateInbox(invalidCritiqueShape), false);
  const invalidInboxActions = structuredClone(typedInbox);
  invalidInboxActions.legal_actions = [projectedActions[0]];
  assert.equal(validateInbox(invalidInboxActions), false);
  const invalidCandidateActions = structuredClone(inboxWithCandidate);
  invalidCandidateActions.items[0].candidate.legal_actions = [projectedActions[0]];
  assert.equal(validateInbox(invalidCandidateActions), false);
  const legacyInbox = structuredClone(typedInbox);
  delete legacyInbox.items[0].review.summary.coverage;
  delete legacyInbox.items[0].review.summary.orientation;
  delete legacyInbox.items[0].review.summary.diagrams;
  legacyInbox.items[0].review.artifacts = {
    schema: "flow.review-artifacts/v1",
    watermark: digest("a"),
    formats: { markdown: "legacy recorded markdown" },
    digests: { markdown: digest("b") },
    provenance: {
      operation_contract: "flow.operation/review-record/v1",
    },
  };
  assert.equal(validateInbox(legacyInbox), true,
    ajv.errorsText(validateInbox.errors));
  const malformedLegacyInbox = structuredClone(legacyInbox);
  malformedLegacyInbox.items[0].review.artifacts.formats.markdown = 42;
  assert.equal(validateInbox(malformedLegacyInbox), false);
  const malformedLegacySummary = structuredClone(legacyInbox);
  delete malformedLegacySummary.items[0].review.summary.findings;
  assert.equal(validateInbox(malformedLegacySummary), false);
  const malformedLegacyCandidate = structuredClone(legacyInbox);
  delete malformedLegacyCandidate.items[0].review.candidate.verification;
  assert.equal(validateInbox(malformedLegacyCandidate), false);
  assert.deepEqual(inbox.legal_actions, []);
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
          catalog_id: "flow.contract-catalog/v1@34",
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

function schemaDigest(value) {
  return canonicalDigest(value);
}

function schemaCandidateRecord() {
  const git = {
    clean: true,
    commit_sha: "a".repeat(40),
    ref: "refs/heads/schema-contract",
    tree_sha: "b".repeat(40),
  };
  const workspace = {
    contract: "work.workspace/v1",
    fingerprint: schemaDigest({ git }),
    generation: 1,
    mutation_epoch: 1,
    subject_id: "workspace:schema-contract",
  };
  const verificationIdentity = {
    schema: "work.feature-verification-receipt/v1",
    brief_id: "brief:schema-contract",
    acceptance_criteria: [{
      criterion: "the candidate is ready",
      evidence_digest: schemaDigest("criterion"),
      verdict: "passed",
    }],
    discriminating_evidence: {
      schema: "flow.feature-discriminating-evidence/v1",
      kind: "safe_baseline",
      selected_fingerprint: schemaDigest("selected"),
      post_mutation_fingerprint: workspace.fingerprint,
      distinguished: true,
    },
    selected_evidence_fingerprint: schemaDigest("selected"),
    workspace: {
      subject_id: workspace.subject_id,
      generation: workspace.generation,
      mutation_epoch: workspace.mutation_epoch,
      fingerprint: workspace.fingerprint,
      git,
    },
    source_authority_watermark: schemaDigest("verify-source"),
    operation_contract: "flow.operation/feature-verify/v1",
    effect_id: "effect:schema-verify",
    attempt_id: "attempt:schema-verify",
    idempotency_key: "idempotency:schema-verify",
  };
  const verification = {
    ...verificationIdentity,
    receipt_digest: schemaDigest(verificationIdentity),
    self_digest: schemaDigest(verificationIdentity),
  };
  const critiqueIdentity = {
    schema: "work.feature-critique-receipt/v1",
    delegate_evidence: {
      card_id: "feature-critique",
      effect_id: "effect:schema-critique",
      attempt_id: "attempt:schema-critique",
      idempotency_key: "idempotency:schema-critique",
      source_authority_watermark: schemaDigest("critique-source"),
      evidence: "independent critique",
    },
    findings: [],
    operation_contract: "flow.delegated-agent-port/v1",
    effect_id: "effect:schema-critique",
    idempotency_key: "idempotency:schema-critique",
    source_authority_watermark: schemaDigest("critique-source"),
  };
  const critique = {
    ...critiqueIdentity,
    receipt_digest: schemaDigest(critiqueIdentity),
    self_digest: schemaDigest(critiqueIdentity),
  };
  const candidate = {
    schema: "work.review-candidate/v1",
    candidate_id: "candidate:schema-contract",
    candidate_fingerprint: schemaDigest("candidate"),
    git,
    workspace,
    verification,
    critique,
    artifacts: [{
      artifact_schema: "example.candidate/v1",
      digest: schemaDigest("candidate-artifact"),
      generation: 1,
    }],
    git_retention: {
      schema: "flow.git-retention-receipt/v1",
      repository_id: "github.com/example/schema-contract",
      commit_sha: git.commit_sha,
      tree_sha: git.tree_sha,
      retention_ref: "refs/flow/schema-contract",
    },
  };
  return candidate;
}

function schemaReviewSummary({
  candidateFingerprint,
  candidateAuthorityWatermark,
  lifecycleGeneration,
  sourceAuthorityWatermark,
}) {
  const result = {
    schema: "flow.review-result/v1",
    posture: "no_findings",
    findings: [],
    coverage: {
      schema: "flow.review-coverage/v1",
      status: "produced",
      reason: null,
    },
    evidence: null,
    cap_reasons: [],
  };
  return {
    schema: "flow.review-summary/v1",
    candidate_fingerprint: candidateFingerprint,
    candidate_authority_watermark: candidateAuthorityWatermark,
    lifecycle_generation: lifecycleGeneration,
    enabled_lenses: ["security"],
    finding_cap: 10,
    urgency_floor: "info",
    orientation: null,
    diagrams: [],
    lens_results: [result],
    critic_result: result,
    findings: [],
    rendered_findings: [],
    cap_reasons: [],
    posture: "no_findings",
    coverage: {
      schema: "flow.review-coverage/v1",
      complete: true,
      lenses: [{ lens: "security", status: "produced", reason: null }],
      critic: { lens: "critic", status: "produced", reason: null },
    },
    merge_ready: false,
    automated_evidence: {
      schema: "flow.review-automated-evidence/v1",
      source_authority_watermark: sourceAuthorityWatermark,
      lens_evidence: [{ lens: "security", evidence_digest: schemaDigest(result) }],
      critic_evidence_digest: schemaDigest(result),
    },
  };
}

function schemaReviewArtifacts({
  watermark,
  candidateFingerprint,
  candidateAuthorityWatermark,
  sourceAuthorityWatermark,
}) {
  return {
    schema: "flow.review-artifacts/v1",
    watermark,
    provenance: {
      schema: "flow.review-provenance/v1",
      operation_contract: "flow.operation/review-record/v1",
      operation_idempotency_key: "idempotency:schema-review",
      run_id: "run:schema-review",
      operation_effect_id: "effect:schema-review",
      operation_attempt_id: "attempt:schema-review",
      candidate_fingerprint: candidateFingerprint,
      lifecycle_generation: 1,
      candidate_authority_watermark: candidateAuthorityWatermark,
      source_authority_watermark: sourceAuthorityWatermark,
      review_authority_watermark: watermark,
    },
    formats: {
      json: "{\"schema\":\"flow.review-artifact-json/v1\"}",
      markdown: "<!-- flow.review-artifact-markdown/v1 -->\n# Review\n",
      html: "<!doctype html><article data-schema=\"flow.review-artifact-html/v1\"></article>\n",
    },
    digests: {
      json: schemaDigest("schema-review-json"),
      markdown: schemaDigest("schema-review-markdown"),
      html: schemaDigest("schema-review-html"),
    },
  };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCompletedAttempt } from "../src/attempt-validator.mjs";
import {
  validateGateForRun,
  validateSealedGate,
} from "../src/run-bundle-validator.mjs";
import { validateContract } from "../src/schema-validator.mjs";

const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validRunManifest() {
  return {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision: GIT_SHA,
      compatible_contracts: [
        "agent-flow.run/v1",
        "agent-flow.graph/v1",
        "agent-flow.gate/v1",
        "agent-flow.handoff/v1",
        "agent-flow.validation/v1",
        "agent-flow.migration-receipt/v1",
        "agent-flow.local-review/v1",
        "agent-flow.review-comments/v1",
        "agent-flow.review-result/v1",
        "agent-flow.review-comment-dispositions/v1",
        "agent-flow.integration-receipt/v1",
        "agent-flow.task-authority/v1",
        "agent-flow.command-result/v1",
      ],
      content_set_fingerprint: SHA256,
    },
    identity: {
      run_id: "review-20260714-example",
      run_directory: "/tmp/state/runs/review-20260714-example",
      artifact_directory: "/tmp/state/runs/review-20260714-example/artifacts",
      validation_directory: "/tmp/state/runs/review-20260714-example/validated",
      flow: "review",
      repository: {
        path: "/tmp/example",
        forge_coordinate: "github.com/example/project",
      },
      board: "example-project",
      tenant: "review-20260714-example",
      parent_run_id: null,
      external_root: null,
      supersedes: null,
    },
    graph: {
      name: "local-review",
      version: 1,
      flow: "review",
      sealed_path: "/tmp/state/runs/review-20260714-example/inputs/graph.json",
      sha256: SHA256,
    },
    approved_read_roots: [
      "/tmp/example",
      "/tmp/state/runs/review-20260714-example",
    ],
    approved_artifact_roots: [
      "/tmp/state/runs/review-20260714-example/artifacts",
    ],
    inputs: [
      {
        kind: "review-manifest",
        name: "review.json",
        source_path: "/tmp/example/review.json",
        sealed_path: "/tmp/state/runs/review-20260714-example/inputs/review.json",
        sha256: SHA256,
      },
      {
        kind: "gate",
        name: "review-finalize.json",
        source_path: "/tmp/example/review-finalize.json",
        sealed_path: "/tmp/state/runs/review-20260714-example/inputs/review-finalize.json",
        sha256: SHA256,
      },
      {
        kind: "skill",
        name: "code-review",
        source_path: "/tmp/example/skills/code-review/SKILL.md",
        sealed_path: "/tmp/state/runs/review-20260714-example/inputs/skills/code-review.md",
        sha256: SHA256,
      },
      {
        kind: "role-contract",
        name: "critic",
        source_path: "/tmp/example/profiles/critic/CONTRACT.md",
        sealed_path: "/tmp/state/runs/review-20260714-example/inputs/contracts/critic.md",
        sha256: SHA256,
      },
    ],
    profiles: {
      profile_set_fingerprint: SHA256,
      required: ["analyst", "artifact", "critic", "flow-controller", "gate"],
      fingerprints: {
        analyst: SHA256,
        artifact: SHA256,
        critic: SHA256,
        "flow-controller": SHA256,
        gate: SHA256,
      },
    },
    limits: {
      max_created_cards: 32,
      max_worker_attempts: 64,
      max_elapsed_seconds: 7200,
      max_feature_streams: 1,
    },
    revisions: {
      base: GIT_SHA,
      source: GIT_SHA,
      target: null,
    },
    sealed_at: "2026-07-14T12:00:00.000Z",
  };
}

function validGraph() {
  return {
    schema: "agent-flow.graph/v1",
    name: "local-review",
    version: 1,
    flow: "review",
    root: "review-root",
    stages: [
      {
        key: "review-root",
        profile: "flow-controller",
        workspace: "run-dir",
        skill: "review-flow",
        max_attempts: 2,
        semantic_measurement: false,
        validates_handoff_for: null,
        optional: false,
      },
      {
        key: "lens:correctness",
        profile: "analyst",
        workspace: "candidate-worktree",
        skill: "review-correctness",
        max_attempts: 2,
        semantic_measurement: true,
        validates_handoff_for: null,
        optional: false,
      },
      {
        key: "validate-handoff:lens:correctness",
        profile: "gate",
        workspace: "run-dir",
        skill: "handoff-validator",
        max_attempts: 1,
        semantic_measurement: false,
        validates_handoff_for: "lens:correctness",
        optional: false,
      },
    ],
    dependencies: [
      { parent: "lens:correctness", child: "validate-handoff:lens:correctness" },
      { parent: "validate-handoff:lens:correctness", child: "review-root" },
    ],
    transitions: [],
  };
}

function validGate() {
  const artifactRoot = "/tmp/state/runs/review-20260714-example/artifacts";
  const commentsValidation = `${artifactRoot}/comments.validation.json`;
  return {
    schema: "agent-flow.gate/v1",
    name: "review-finalize",
    version: 1,
    run_id: "review-20260714-example",
    stage: "finalize",
    kind: "review-finalize",
    workspace: "/tmp/state/runs/review-20260714-example",
    read_roots: ["/tmp/state/runs/review-20260714-example"],
    write_root: "/tmp/state/runs/review-20260714-example/artifacts",
    timeout_seconds: 300,
    inputs: [commentsValidation],
    outputs: [
      `${artifactRoot}/review.json`,
      `${artifactRoot}/review.md`,
      `${artifactRoot}/review.html`,
      `${artifactRoot}/draft-review.json`,
    ],
    review_policy: {
      urgency: "hotfix",
      minimum_tier: "critical",
      max_comments: 20,
      per_tier_caps: {
        critical: 20,
        important: 20,
        recommended: 0,
        nit: 0,
      },
    },
    review_finalize: {
      comments_validation: commentsValidation,
      supplements: [],
      result_output: `${artifactRoot}/review.json`,
      markdown_output: `${artifactRoot}/review.md`,
      html_output: `${artifactRoot}/review.html`,
      draft_output: `${artifactRoot}/draft-review.json`,
    },
  };
}

function validMigrationReceipt() {
  return {
    schema: "agent-flow.migration-receipt/v1",
    receipt_id: "migration-1",
    run_id: "review-20260714-example",
    from: {
      contract_version: 1,
      implementation_revision: GIT_SHA,
      profile_set_fingerprint: SHA256,
      content_set_fingerprint: SHA256,
    },
    to: {
      contract_version: 1,
      implementation_revision: "1123456789abcdef0123456789abcdef01234567",
      profile_set_fingerprint: SHA256,
      content_set_fingerprint: SHA256,
    },
    changes: [
      {
        kind: "implementation",
        name: "agent-flow",
        prior_sha256: SHA256,
        next_sha256: "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    ],
    approval: {
      actor: "operator",
      approved_at: "2026-07-14T12:30:00Z",
      reason: "Compatible validation-only update",
      evidence_path: "/tmp/state/runs/review-20260714-example/migrations/evidence.md",
    },
  };
}

function validValidationEnvelope() {
  return {
    schema: "agent-flow.validation/v1",
    run_id: "review-20260714-example",
    stage: "lens:correctness",
    task_id: "t_12345678",
    attempt: 1,
    validated_at: "2026-07-14T12:15:00Z",
    source_metadata_sha256: SHA256,
    provenance: {
      run_manifest_path: "/tmp/state/runs/review-20260714-example/run.json",
      run_manifest_sha256: SHA256,
      hermes_attempt_id: "attempt_12345678",
    },
    valid: true,
    identity: {
      handoff_schema: "agent-flow.handoff/v1",
      run_id: "review-20260714-example",
      stage: "lens:correctness",
      attempt: 1,
    },
    semantic: {
      required: true,
      passed: true,
    },
    approved_artifact_roots: [
      "/tmp/state/runs/review-20260714-example/artifacts",
    ],
    validated_artifact_root: "/tmp/state/runs/review-20260714-example/validated",
    artifacts: [
      {
        source_path:
          "/tmp/state/runs/review-20260714-example/artifacts/correctness.json",
        path:
          "/tmp/state/runs/review-20260714-example/validated/correctness.json",
        expected_sha256: SHA256,
        actual_sha256: SHA256,
        valid: true,
      },
    ],
    errors: [],
  };
}

function validHandoff() {
  return {
    schema: "agent-flow.handoff/v1",
    run_id: "review-20260714-example",
    flow: "review",
    stage: "lens:correctness",
    attempt: 1,
    passed: true,
    artifacts: [
      {
        kind: "review-findings",
        path:
          "/tmp/state/runs/review-20260714-example/artifacts/correctness.json",
        sha256: SHA256,
      },
    ],
    changed_files: [],
    verification: [],
    dependencies: [],
    retry_notes: [],
    residual_risk: [],
  };
}

test("run manifests validate sealed identity and immutable inputs", async () => {
  const valid = await validateContract(validRunManifest());
  assert.deepEqual(valid, { valid: true, errors: [] });

  const malformed = validRunManifest();
  malformed.inputs[0].sealed_path = "relative/review.json";
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(
    invalid.errors.some(
      ({ instancePath, keyword }) =>
        instancePath === "/inputs/0/sealed_path" && keyword === "pattern",
    ),
    true,
  );
});

test("run manifests require every machine-consumed input category", async () => {
  const malformed = validRunManifest();
  malformed.inputs = malformed.inputs.filter(({ kind }) => kind !== "gate");
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors[0], {
    instancePath: "/inputs",
    keyword: "requiredInputKind",
    message: "must include at least one gate input",
  });
});

test("run manifests bind tenancy, graph identity, sealed content, and profiles", async () => {
  const mutations = [
    (run) => { run.identity.tenant = "unrelated-tenant"; },
    (run) => { run.identity.supersedes = run.identity.run_id; },
    (run) => { run.identity.supersedes = "review-prior"; },
    (run) => {
      run.identity.external_root = {
        system: "github",
        id: "Example/Project#42",
      };
    },
    (run) => {
      run.identity.parent_run_id = run.identity.run_id;
      run.identity.tenant = run.identity.run_id;
    },
    (run) => { run.graph.flow = "feature"; },
    (run) => { run.graph.sealed_path = "/tmp/outside/graph.json"; },
    (run) => { run.inputs[0].sealed_path = "/tmp/outside/review.json"; },
    (run) => { run.inputs[0].sealed_path = `${run.identity.run_directory}/artifacts/input.json`; },
    (run) => { run.approved_read_roots = ["/"]; },
    (run) => { run.approved_artifact_roots = [run.identity.run_directory]; },
    (run) => { run.approved_artifact_roots = [`${run.identity.run_directory}/inputs`]; },
    (run) => { run.inputs.push({ ...run.inputs[0] }); },
    (run) => { run.profiles.required.push("builder"); },
    (run) => { run.revisions.base = null; },
    (run) => { run.implementation.compatible_contracts = ["agent-flow.run/v1"]; },
  ];

  for (const mutate of mutations) {
    const malformed = validRunManifest();
    mutate(malformed);
    assert.equal((await validateContract(malformed)).valid, false);
  }

  const child = validRunManifest();
  child.identity.parent_run_id = "epic-20260714-example";
  child.identity.tenant = "epic-20260714-example";
  assert.equal((await validateContract(child)).valid, true);

  const emptyRevisions = validRunManifest();
  emptyRevisions.identity.flow = "spike";
  emptyRevisions.graph.flow = "spike";
  emptyRevisions.revisions = { base: null, source: null, target: null };
  assert.equal((await validateContract(emptyRevisions)).valid, false);
});

test("graphs reject dependencies that do not name declared stages", async () => {
  assert.deepEqual(await validateContract(validGraph()), {
    valid: true,
    errors: [],
  });

  const malformed = validGraph();
  malformed.dependencies[0].parent = "lens:undeclared";
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors[0], {
    instancePath: "/dependencies/0/parent",
    keyword: "stageReference",
    message: "must name a declared stage",
  });
});

test("graphs reject duplicate stage keys and dependency cycles", async () => {
  const duplicate = validGraph();
  duplicate.stages.push({ ...duplicate.stages[1] });
  const duplicateResult = await validateContract(duplicate);
  assert.equal(duplicateResult.valid, false);
  assert.equal(duplicateResult.errors[0].keyword, "uniqueStageKey");

  const cyclic = validGraph();
  cyclic.dependencies.push({
    parent: "review-root",
    child: "lens:correctness",
  });
  const cycleResult = await validateContract(cyclic);
  assert.equal(cycleResult.valid, false);
  assert.equal(cycleResult.errors[0].keyword, "acyclic");
});

test("graphs require a controller root, complete root linkage, and handoff gates", async () => {
  const wrongRoot = validGraph();
  wrongRoot.stages[0].profile = "analyst";
  assert.equal((await validateContract(wrongRoot)).valid, false);

  const disconnected = validGraph();
  disconnected.dependencies.pop();
  assert.equal((await validateContract(disconnected)).valid, false);

  const bypass = validGraph();
  bypass.dependencies = [
    { parent: "lens:correctness", child: "review-root" },
    { parent: "validate-handoff:lens:correctness", child: "review-root" },
  ];
  assert.equal((await validateContract(bypass)).valid, false);

  const nonSemanticBypass = validGraph();
  nonSemanticBypass.stages[1].semantic_measurement = false;
  nonSemanticBypass.dependencies = [
    { parent: "lens:correctness", child: "review-root" },
    { parent: "validate-handoff:lens:correctness", child: "review-root" },
  ];
  assert.equal((await validateContract(nonSemanticBypass)).valid, false);

  const optionalValidator = validGraph();
  optionalValidator.stages[2].optional = true;
  assert.equal((await validateContract(optionalValidator)).valid, false);

  const misplacedValidator = validGraph();
  misplacedValidator.stages[2].workspace = "candidate-worktree";
  assert.equal((await validateContract(misplacedValidator)).valid, false);
});

test("graphs validate declared dynamic transition shapes", async () => {
  const graph = validGraph();
  graph.transitions.push({
    key: "critic-fix",
    from: "review-root",
    max_instances: 2,
    stages: [
      {
        key: "critic-fix-builder",
        profile: "builder",
        workspace: "candidate-worktree",
        skill: "implement",
        max_attempts: 2,
        semantic_measurement: false,
        validates_handoff_for: null,
        optional: false,
      },
      {
        key: "validate-handoff:critic-fix-builder",
        profile: "gate",
        workspace: "run-dir",
        skill: "handoff-validator",
        max_attempts: 1,
        semantic_measurement: false,
        validates_handoff_for: "critic-fix-builder",
        optional: false,
      },
    ],
    dependencies: [
      {
        parent: "critic-fix-builder",
        child: "validate-handoff:critic-fix-builder",
      },
      { parent: "validate-handoff:critic-fix-builder", child: "review-root" },
    ],
  });
  const valid = await validateContract(graph);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));

  const malformed = structuredClone(graph);
  malformed.transitions[0].from = "missing-controller";
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].keyword, "stageReference");

  const malformedStatic = structuredClone(graph);
  malformedStatic.dependencies[0].parent = "missing-stage";
  assert.equal((await validateContract(malformedStatic)).valid, false);

  const nonController = structuredClone(graph);
  nonController.transitions[0].from = "lens:correctness";
  assert.equal((await validateContract(nonController)).valid, false);

  const detached = structuredClone(graph);
  detached.transitions[0].dependencies = [];
  assert.equal((await validateContract(detached)).valid, false);

  const colliding = structuredClone(graph);
  colliding.transitions.push({
    ...structuredClone(graph.transitions[0]),
    key: "critic-fix-again",
  });
  assert.equal((await validateContract(colliding)).valid, false);
});

test("gate specs require the operation payload selected by their kind", async () => {
  assert.deepEqual(await validateContract(validGate()), {
    valid: true,
    errors: [],
  });

  const malformed = validGate();
  delete malformed.review_finalize;
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(
    invalid.errors.some(
      ({ instancePath, keyword }) => instancePath === "" && keyword === "required",
    ),
    true,
  );

  const handoffGate = validGate();
  handoffGate.kind = "handoff-validation";
  delete handoffGate.review_policy;
  delete handoffGate.review_finalize;
  handoffGate.handoff_validation = {
    producer_stage: "lens:correctness",
    require_passed: true,
  };
  handoffGate.outputs = [`${handoffGate.write_root}/validation.json`];
  assert.equal((await validateContract(handoffGate)).valid, true);

  handoffGate.handoff_validation.attempt = 1;
  assert.equal((await validateContract(handoffGate)).valid, false);
  delete handoffGate.handoff_validation.attempt;

  handoffGate.handoff_validation.task_id = "t_12345678";
  assert.equal((await validateContract(handoffGate)).valid, false);

  delete handoffGate.handoff_validation.task_id;
  handoffGate.outputs.push(`${handoffGate.write_root}/duplicate-validation.json`);
  assert.equal((await validateContract(handoffGate)).valid, false);
});

test("gate specs reject mixed operation payloads and incorrect urgency floors", async () => {
  const mixed = validGate();
  mixed.commands = [
    {
      argv: ["true"],
      cwd: "/tmp/state/runs/review-20260714-example",
      output_path: "/tmp/state/runs/review-20260714-example/out/true.log",
    },
  ];
  assert.equal((await validateContract(mixed)).valid, false);

  const wrongFloor = validGate();
  wrongFloor.review_policy.minimum_tier = "recommended";
  assert.equal((await validateContract(wrongFloor)).valid, false);
});

test("review-finalize gates bind every typed input and output", async () => {
  const optionalLens = validGate();
  optionalLens.review_policy.urgency = "fast";
  optionalLens.review_policy.minimum_tier = "important";
  for (const kind of [
    "diagram",
    "lens:observability",
    "lens:style",
    "orientation",
  ]) {
    const validation =
      `${optionalLens.write_root}/${kind.replaceAll(":", "-")}.validation.json`;
    optionalLens.inputs.push(validation);
    optionalLens.review_finalize.supplements.push({ kind, validation });
  }
  assert.equal((await validateContract(optionalLens)).valid, true);

  const unknownSupplement = structuredClone(optionalLens);
  unknownSupplement.review_finalize.supplements[0].kind = "lens:unknown";
  assert.equal((await validateContract(unknownSupplement)).valid, false);

  const incompleteFast = structuredClone(optionalLens);
  incompleteFast.inputs.pop();
  incompleteFast.review_finalize.supplements.pop();
  const incompleteResult = await validateContract(incompleteFast);
  assert.equal(incompleteResult.valid, false);
  assert.equal(
    incompleteResult.errors.some(({ keyword }) => keyword === "urgencySupplements"),
    true,
  );

  const supplementedHotfix = structuredClone(optionalLens);
  supplementedHotfix.review_policy.urgency = "hotfix";
  supplementedHotfix.review_policy.minimum_tier = "critical";
  assert.equal((await validateContract(supplementedHotfix)).valid, false);

  const mutations = [
    (gate) => { gate.review_finalize.comments_validation = `${gate.write_root}/other.json`; },
    (gate) => { gate.inputs.push(`${gate.write_root}/undeclared.validation.json`); },
    (gate) => { gate.review_finalize.markdown_output = `${gate.write_root}/other.md`; },
    (gate) => { gate.outputs.pop(); },
  ];
  for (const mutate of mutations) {
    const malformed = validGate();
    mutate(malformed);
    assert.equal((await validateContract(malformed)).valid, false);
  }
});

test("gate specs pin command workspaces and read and write containment", async () => {
  const commandGate = validGate();
  commandGate.kind = "command";
  delete commandGate.review_policy;
  delete commandGate.review_finalize;
  commandGate.commands = [
    {
      argv: ["npm", "test"],
      cwd: commandGate.workspace,
      output_path: `${commandGate.write_root}/test.log`,
    },
  ];
  commandGate.outputs.push(`${commandGate.write_root}/test.log`);
  assert.equal((await validateContract(commandGate)).valid, true);

  const mutations = [
    (gate) => { gate.commands[0].cwd = "/etc"; },
    (gate) => { gate.inputs[0] = "/etc/passwd"; },
    (gate) => { gate.outputs[0] = "/tmp/outside.md"; },
    (gate) => { gate.commands[0].output_path = "/tmp/outside.log"; },
    (gate) => { gate.commands[0].output_path = `${gate.write_root}/undeclared.log`; },
    (gate) => { gate.read_roots = ["/tmp/unrelated"]; },
    (gate) => { gate.commands.push(structuredClone(gate.commands[0])); },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(commandGate);
    mutate(malformed);
    assert.equal((await validateContract(malformed)).valid, false);
  }
});

test("gate roots are bounded by run authority", () => {
  assert.deepEqual(validateGateForRun(validGate(), validRunManifest()), {
    valid: true,
    errors: [],
  });

  const broadRead = validGate();
  broadRead.workspace = "/etc";
  broadRead.read_roots = ["/"];
  assert.equal(validateGateForRun(broadRead, validRunManifest()).valid, false);

  const broadWrite = validGate();
  broadWrite.write_root = "/tmp";
  assert.equal(validateGateForRun(broadWrite, validRunManifest()).valid, false);
});

test("migration receipts bind before and after compatibility identities", async () => {
  assert.deepEqual(await validateContract(validMigrationReceipt()), {
    valid: true,
    errors: [],
  });

  const malformed = validMigrationReceipt();
  malformed.to.implementation_revision = malformed.from.implementation_revision;
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].keyword, "migrationChange");
});

test("migration receipts explain each changed compatibility dimension", async () => {
  const unexplainedImplementation = validMigrationReceipt();
  unexplainedImplementation.changes[0].kind = "input";
  assert.equal((await validateContract(unexplainedImplementation)).valid, false);

  const contentChange = validMigrationReceipt();
  contentChange.to.implementation_revision = contentChange.from.implementation_revision;
  contentChange.to.content_set_fingerprint =
    "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  contentChange.changes[0].kind = "gate";
  assert.equal((await validateContract(contentChange)).valid, true);

  contentChange.changes[0].kind = "implementation";
  assert.equal((await validateContract(contentChange)).valid, false);

  const topologyProfileChange = validMigrationReceipt();
  topologyProfileChange.to.implementation_revision =
    topologyProfileChange.from.implementation_revision;
  topologyProfileChange.to.content_set_fingerprint =
    "2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  topologyProfileChange.changes = [
    { ...topologyProfileChange.changes[0], kind: "graph", name: "local-review" },
    { ...topologyProfileChange.changes[0], kind: "profile", name: "artifact" },
  ];
  assert.equal((await validateContract(topologyProfileChange)).valid, true);
});

test("successful validation envelopes cannot retain errors", async () => {
  assert.deepEqual(await validateContract(validValidationEnvelope()), {
    valid: true,
    errors: [],
  });

  const malformed = validValidationEnvelope();
  malformed.errors.push({ code: "hash_mismatch", message: "artifact changed" });
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(
    invalid.errors.some(
      ({ instancePath, keyword }) =>
        instancePath === "/errors" && keyword === "maxItems",
    ),
    true,
  );
});

test("successful validation envelopes require verified semantic and artifact evidence", async () => {
  const missingSemantic = validValidationEnvelope();
  missingSemantic.semantic.passed = null;
  assert.equal((await validateContract(missingSemantic)).valid, false);

  const hashMismatch = validValidationEnvelope();
  hashMismatch.artifacts[0].actual_sha256 =
    "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.equal((await validateContract(hashMismatch)).valid, false);

  const outsideRoot = validValidationEnvelope();
  outsideRoot.artifacts[0].source_path = "/tmp/outside.json";
  assert.equal((await validateContract(outsideRoot)).valid, false);

  const missingProvenance = validValidationEnvelope();
  delete missingProvenance.provenance;
  assert.equal((await validateContract(missingProvenance)).valid, false);

  const inlineSource = validValidationEnvelope();
  inlineSource.artifacts[0].source_path = inlineSource.artifacts[0].path;
  assert.equal((await validateContract(inlineSource)).valid, true);
});

test("handoffs distinguish file and terminal-free inline artifacts", async () => {
  assert.equal((await validateContract(validHandoff())).valid, true);

  const missingFileDigest = validHandoff();
  delete missingFileDigest.artifacts[0].sha256;
  assert.equal((await validateContract(missingFileDigest)).valid, false);

  const inline = validHandoff();
  delete inline.attempt;
  inline.artifacts = [{
    kind: "review-findings",
    inline: { findings: [] },
  }];
  assert.equal((await validateContract(inline)).valid, true);

  const mixed = structuredClone(inline);
  mixed.artifacts[0].path =
    "/tmp/state/runs/review-20260714-example/artifacts/correctness.json";
  mixed.artifacts[0].sha256 = SHA256;
  assert.equal((await validateContract(mixed)).valid, false);

  const scalar = structuredClone(inline);
  scalar.artifacts[0].inline = 42;
  assert.equal((await validateContract(scalar)).valid, false);

  const oversized = structuredClone(inline);
  oversized.artifacts = ["first", "second"].map((kind) => ({
    kind,
    inline: { content: "x".repeat(140 * 1024) },
  }));
  const oversizedResult = await validateContract(oversized);
  assert.equal(oversizedResult.valid, false);
  assert.equal(oversizedResult.errors[0].keyword, "inlineArtifactBytes");
});

test("validation envelopes bind handoffs to the expected attempt", async () => {
  const malformed = validValidationEnvelope();
  malformed.identity.attempt = 2;
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors[0], {
    instancePath: "/identity/attempt",
    keyword: "identityMatch",
    message: "must match the validation envelope",
  });
});

test("completed-attempt validation derives evidence from Hermes, the manifest, and files", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "agent-flow-attempt-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  const inputsDirectory = join(runDirectory, "inputs");
  const outputDirectory = join(runDirectory, "artifacts");
  await mkdir(inputsDirectory);
  await mkdir(outputDirectory);

  const graph = validGraph();
  const graphBytes = JSON.stringify(graph);
  const graphPath = join(inputsDirectory, "graph.json");
  await writeFile(graphPath, graphBytes);
  const artifactPath = join(outputDirectory, "correctness.json");
  const artifactBytes = JSON.stringify({ findings: [] });
  await writeFile(artifactPath, artifactBytes);

  const manifest = validRunManifest();
  manifest.identity.run_directory = runDirectory;
  manifest.identity.artifact_directory = outputDirectory;
  manifest.identity.validation_directory = join(runDirectory, "validated");
  manifest.graph.sealed_path = graphPath;
  manifest.graph.sha256 = sha256(graphBytes);
  manifest.approved_read_roots = [runDirectory, manifest.identity.repository.path];
  manifest.approved_artifact_roots = [outputDirectory];
  for (const [index, input] of manifest.inputs.entries()) {
    input.sealed_path = join(inputsDirectory, `${index}-${input.name}`);
  }
  const gate = validGate();
  gate.workspace = runDirectory;
  gate.read_roots = [runDirectory];
  gate.write_root = outputDirectory;
  gate.inputs = [artifactPath];
  gate.outputs = [
    join(outputDirectory, "review.json"),
    join(outputDirectory, "review.md"),
    join(outputDirectory, "review.html"),
    join(outputDirectory, "draft-review.json"),
  ];
  gate.review_finalize = {
    comments_validation: artifactPath,
    supplements: [],
    result_output: gate.outputs[0],
    markdown_output: gate.outputs[1],
    html_output: gate.outputs[2],
    draft_output: gate.outputs[3],
  };
  const gatePath = join(inputsDirectory, "review-finalize.json");
  const gateBytes = JSON.stringify(gate);
  await writeFile(gatePath, gateBytes);
  const gateInput = manifest.inputs.find(({ kind }) => kind === "gate");
  gateInput.sealed_path = gatePath;
  gateInput.sha256 = sha256(gateBytes);
  const manifestPath = join(runDirectory, "run.json");
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(manifestPath, manifestBytes);
  const expectedRunManifestSha256 = sha256(manifestBytes);

  const handoff = validHandoff();
  handoff.artifacts[0].path = artifactPath;
  handoff.artifacts[0].sha256 = sha256(artifactBytes);
  let taskAuthoritySha256 = SHA256;
  const adapter = {
    async getTaskAuthority({ taskId }) {
      const gateTask = taskId === "t_gate" || taskId === "t_other_gate";
      const authorityStage = taskId === "t_other_gate"
        ? "other-stage"
        : gateTask
          ? gate.stage
          : "lens:correctness";
      return {
        taskId,
        runId: manifest.identity.run_id,
        stage: authorityStage,
        runManifestPath: manifestPath,
        runManifestSha256: taskAuthoritySha256,
        ...(gateTask
          ? {
              gateSpecPath: gatePath,
              gateSpecSha256: sha256(gateBytes),
              inputTaskIds: { [artifactPath]: "t_input_validator" },
            }
          : {}),
      };
    },
    async getCompletedAttempt() {
      return {
        attemptId: "attempt_12345678",
        taskId: "t_12345678",
        attempt: 1,
        state: "completed",
        metadata: { handoff },
      };
    },
  };

  await assert.rejects(
    validateCompletedAttempt({
      adapter,
      taskId: "t_12345678",
      stage: "lens:correctness",
      attempt: 1,
    }),
    /run manifest digest/,
  );
  taskAuthoritySha256 = expectedRunManifestSha256;

  assert.deepEqual(
    await validateSealedGate({
      adapter,
      taskId: "t_gate",
    }),
    { valid: true, errors: [] },
  );
  await writeFile(gatePath, JSON.stringify({ ...gate, read_roots: ["/"] }));
  assert.equal(
    (await validateSealedGate({
      adapter,
      taskId: "t_gate",
    })).valid,
    false,
  );
  await writeFile(gatePath, gateBytes);
  assert.equal(
    (await validateSealedGate({ adapter, taskId: "t_other_gate" })).valid,
    false,
  );

  await symlink(tmpdir(), manifest.identity.validation_directory);
  await assert.rejects(
    validateCompletedAttempt({
      adapter,
      taskId: "t_12345678",
      stage: "lens:correctness",
      attempt: 1,
    }),
    /validation directory resolves outside/,
  );
  await rm(manifest.identity.validation_directory, {
    recursive: true,
    force: true,
  });

  const validation = await validateCompletedAttempt({
    adapter,
    taskId: "t_12345678",
    stage: "lens:correctness",
    attempt: 1,
    now: () => new Date("2026-07-14T12:15:00Z"),
  });
  assert.equal(validation.valid, true);
  assert.deepEqual(await validateContract(validation), { valid: true, errors: [] });

  await writeFile(artifactPath, JSON.stringify({ findings: ["tampered"] }));
  assert.equal(await readFile(validation.artifacts[0].path, "utf8"), artifactBytes);
  const hashRejected = await validateCompletedAttempt({
    adapter,
    taskId: "t_12345678",
    stage: "lens:correctness",
    attempt: 1,
  });
  assert.equal(hashRejected.valid, false);
  assert.equal(hashRejected.errors[0].code, "artifact_hash_mismatch");
  await writeFile(artifactPath, artifactBytes);

  handoff.attempt = 2;
  const identityRejected = await validateCompletedAttempt({
    adapter,
    taskId: "t_12345678",
    stage: "lens:correctness",
    attempt: 1,
  });
  assert.equal(identityRejected.valid, false);
  assert.equal(identityRejected.errors[0].code, "identity_mismatch");
  handoff.attempt = 1;

  handoff.artifacts[0].path = "/etc/passwd";
  handoff.artifacts[0].sha256 = SHA256;
  const rejected = await validateCompletedAttempt({
    adapter,
    taskId: "t_12345678",
    stage: "lens:correctness",
    attempt: 1,
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.errors[0].code, "artifact_outside_root");
  assert.equal(rejected.approved_artifact_roots.includes("/etc"), false);

  const escapePath = join(outputDirectory, "escape");
  await symlink("/etc/passwd", escapePath);
  handoff.artifacts[0].path = escapePath;
  const symlinkRejected = await validateCompletedAttempt({
    adapter,
    taskId: "t_12345678",
    stage: "lens:correctness",
    attempt: 1,
  });
  assert.equal(symlinkRejected.valid, false);
  assert.equal(symlinkRejected.errors[0].code, "artifact_outside_root");
});

test("contract validation is deterministic during concurrent first use", async () => {
  const { validateContract: validateFreshContract } = await import(
    `../src/schema-validator.mjs?race=${Date.now()}`
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, () => validateFreshContract(validRunManifest())),
  );
  assert.equal(results.every(({ valid }) => valid), true);
});

test("derived flow results and durable states are registered contracts", async () => {
  const documents = [
    {
      schema: "agent-flow.spike-result/v1", run_id: "spike-one", source_sha: GIT_SHA,
      report_path: "/tmp/report.md", prototype: null, retained_evidence: [],
      residual_gaps: [], stuck_slices: [],
    },
    {
      schema: "agent-flow.epic-state/v1", run_id: "epic-one", repository: "/tmp/repo",
      epic_path: "/tmp/epic.json", epic_sha256: SHA256,
      run_manifest_path: "/tmp/run.json", epic_root_task_id: "task-epic-root",
      source_ref: "refs/heads/epic/source", source_worktree: "/tmp/source",
      recorded_target_sha: GIT_SHA, stack_generation: 0,
      features: {
        feature: {
          status: "pending", child_run_id: null, manifest_path: null,
          root_task_id: null, worktree: null, error: null,
        },
      },
      stack_checkpoints: [],
    },
    {
      schema: "agent-flow.stack-state/v1", run_id: "stack-one", generation: 1,
      plan_fingerprint: SHA256, status: "building", created_layers: [],
      final_head_sha: null, final_tree_sha: null, prs: [], rollback_actions: [], error: null,
    },
    {
      schema: "agent-flow.delivery-state/v1", run_id: "delivery-one", generation: 1,
      status: "pending", target_sha: GIT_SHA, source_sha: GIT_SHA,
      delivery_head_sha: null, applied_layers: [], verification: null,
      completion_pr: null, pending_layer: null, rollback_actions: [], error: null,
    },
  ];
  const results = await Promise.all(documents.map((document) => validateContract(document)));
  assert.equal(results.every(({ valid }) => valid), true);

  documents[2].status = "caller-invented";
  assert.equal((await validateContract(documents[2])).valid, false);
});

test("standalone schemas keep shared scalar definitions consistent", async () => {
  const names = [
    "run",
    "graph",
    "gate",
    "migration-receipt",
    "validation",
    "handoff",
    "task-authority",
    "command-result",
  ];
  const schemas = new Map(
    await Promise.all(
      names.map(async (name) => [
        name,
        JSON.parse(
          await readFile(
            new URL(`../schemas/agent-flow.${name}.v1.schema.json`, import.meta.url),
            "utf8",
          ),
        ),
      ]),
    ),
  );
  const patterns = (definition, schemaNames) =>
    new Set(schemaNames.map((name) => schemas.get(name).$defs[definition].pattern));

  assert.equal(
    patterns("absolutePath", [
      "run",
      "gate",
      "migration-receipt",
      "validation",
      "handoff",
      "task-authority",
      "command-result",
    ]).size,
    1,
  );
  assert.equal(
    patterns("sha256", [
      "run",
      "migration-receipt",
      "validation",
      "handoff",
      "task-authority",
    ]).size,
    1,
  );
  assert.equal(
    patterns("stageKey", [
      "graph",
      "gate",
      "validation",
      "task-authority",
      "command-result",
    ]).size,
    1,
  );
  assert.equal(patterns("timestamp", ["run", "migration-receipt", "validation"]).size, 1);
});

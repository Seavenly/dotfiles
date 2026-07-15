import assert from "node:assert/strict";
import test from "node:test";

import { validateContract } from "../src/schema-validator.mjs";

const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function validRunManifest() {
  return {
    schema: "agent-flow.run/v1",
    contract_version: 1,
    implementation: {
      revision: GIT_SHA,
      compatible_contracts: ["agent-flow.run/v1"],
    },
    identity: {
      run_id: "review-20260714-example",
      flow: "review",
      repository: {
        path: "/tmp/example",
        forge_coordinate: "github.com/example/project",
      },
      board: "example-project",
      tenant: "review-20260714-example",
      external_root: null,
      supersedes: null,
    },
    graph: {
      name: "local-review",
      version: 1,
      sealed_path: "/tmp/state/runs/review-20260714-example/inputs/graph.json",
      sha256: SHA256,
    },
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
        optional: false,
      },
      {
        key: "lens:correctness",
        profile: "analyst",
        workspace: "candidate-worktree",
        skill: "review-correctness",
        max_attempts: 2,
        semantic_measurement: true,
        optional: false,
      },
    ],
    dependencies: [
      { parent: "lens:correctness", child: "review-root" },
    ],
    transitions: [],
  };
}

function validGate() {
  return {
    schema: "agent-flow.gate/v1",
    name: "review-finalize",
    version: 1,
    run_id: "review-20260714-example",
    stage: "finalize",
    kind: "review-finalize",
    workspace: "/tmp/state/runs/review-20260714-example",
    timeout_seconds: 300,
    inputs: ["/tmp/state/runs/review-20260714-example/out/comments.json"],
    outputs: ["/tmp/state/runs/review-20260714-example/out/review.md"],
    review_policy: {
      urgency: "fast",
      minimum_tier: "important",
      max_comments: 20,
      per_tier_caps: {
        critical: 20,
        important: 20,
        recommended: 0,
        nit: 0,
      },
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
    },
    to: {
      contract_version: 1,
      implementation_revision: "1123456789abcdef0123456789abcdef01234567",
      profile_set_fingerprint: SHA256,
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
    artifact_roots: ["/tmp/state/runs/review-20260714-example"],
    artifacts: [
      {
        path: "/tmp/state/runs/review-20260714-example/out/correctness.json",
        expected_sha256: SHA256,
        actual_sha256: SHA256,
        valid: true,
      },
    ],
    errors: [],
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
        optional: false,
      },
    ],
    dependencies: [
      { parent: "lens:correctness", child: "critic-fix-builder" },
    ],
  });
  assert.equal((await validateContract(graph)).valid, true);

  const malformed = structuredClone(graph);
  malformed.transitions[0].from = "missing-controller";
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].keyword, "stageReference");
});

test("gate specs require the operation payload selected by their kind", async () => {
  assert.deepEqual(await validateContract(validGate()), {
    valid: true,
    errors: [],
  });

  const malformed = validGate();
  delete malformed.review_policy;
  const invalid = await validateContract(malformed);

  assert.equal(invalid.valid, false);
  assert.equal(
    invalid.errors.some(
      ({ instancePath, keyword }) => instancePath === "" && keyword === "required",
    ),
    true,
  );
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
  outsideRoot.artifacts[0].path = "/tmp/outside.json";
  assert.equal((await validateContract(outsideRoot)).valid, false);
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

test("contract validation is deterministic during concurrent first use", async () => {
  const { validateContract: validateFreshContract } = await import(
    `../src/schema-validator.mjs?race=${Date.now()}`
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, () => validateFreshContract(validRunManifest())),
  );
  assert.equal(results.every(({ valid }) => valid), true);
});

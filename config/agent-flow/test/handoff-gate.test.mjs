import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli-command.mjs";
import { validateContract } from "../src/schema-validator.mjs";

const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

test("agent-flow gate validates the producer's terminal completed attempt", async (t) => {
  const fixture = await handoffGateFixture(t);
  const stdout = captureStream();
  const stderr = captureStream();

  const exitCode = await runCli(["gate", "--spec", fixture.gatePath], {
    adapter: fixture.adapter,
    env: { HERMES_KANBAN_TASK: fixture.validatorTaskId },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.value(), "ok - handoff-validation gate passed\n");
  assert.equal(stderr.value(), "");
  const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
  assert.deepEqual(await validateContract(evidence), { valid: true, errors: [] });
  assert.equal(evidence.valid, true);
  assert.equal(evidence.task_id, fixture.producerTaskId);
  assert.equal(evidence.attempt, 2);
  assert.equal(evidence.identity.stage, "lens:correctness");
  assert.equal(evidence.semantic.passed, true);
  assert.equal(
    await readFile(evidence.artifacts[0].path, "utf8"),
    fixture.artifactBytes,
  );
});

test("handoff-validation gate records semantic failure without releasing work", async (t) => {
  const fixture = await handoffGateFixture(t);
  fixture.handoff.passed = false;
  const stdout = captureStream();
  const stderr = captureStream();

  assert.equal(
    await runCli(["gate", "--spec", fixture.gatePath], {
      adapter: fixture.adapter,
      env: { HERMES_KANBAN_TASK: fixture.validatorTaskId },
      stdout: stdout.stream,
      stderr: stderr.stream,
    }),
    1,
  );

  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "not ok - handoff-validation gate failed\n");
  const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
  assert.equal(evidence.valid, false);
  assert.deepEqual(evidence.errors, [
    {
      code: "semantic_failure",
      message: "handoff must pass before downstream work can be released",
    },
  ]);
  assert.deepEqual(await validateContract(evidence), { valid: true, errors: [] });
});

test("handoff-validation gate persists malformed metadata evidence", async (t) => {
  const fixture = await handoffGateFixture(t);
  fixture.completed.metadata.handoff = { passed: true };
  const stderr = captureStream();

  assert.equal(
    await runCli(["gate", "--spec", fixture.gatePath], {
      adapter: fixture.adapter,
      env: { HERMES_KANBAN_TASK: fixture.validatorTaskId },
      stdout: captureStream().stream,
      stderr: stderr.stream,
    }),
    1,
  );

  assert.equal(stderr.value(), "not ok - handoff-validation gate failed\n");
  const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
  assert.equal(evidence.valid, false);
  assert.equal(evidence.errors[0].code, "invalid_handoff");
  assert.deepEqual(await validateContract(evidence), { valid: true, errors: [] });
});

test("handoff-validation gate requires launcher-pinned producer authority", async (t) => {
  const fixture = await handoffGateFixture(t);
  const getTaskAuthority = fixture.adapter.getTaskAuthority;
  fixture.adapter.getTaskAuthority = async (request) => {
    const authority = await getTaskAuthority(request);
    if (request.taskId === fixture.validatorTaskId) {
      delete authority.producerTaskId;
    }
    return authority;
  };
  const stderr = captureStream();

  assert.equal(
    await runCli(["gate", "--spec", fixture.gatePath], {
      adapter: fixture.adapter,
      env: { HERMES_KANBAN_TASK: fixture.validatorTaskId },
      stdout: captureStream().stream,
      stderr: stderr.stream,
    }),
    1,
  );

  assert.match(stderr.value(), /not bound to a producer task/);
  await assert.rejects(readFile(fixture.evidencePath), { code: "ENOENT" });
});

test("handoff-validation gate binds producer and validator to one run manifest", async (t) => {
  const fixture = await handoffGateFixture(t);
  const alternateManifestPath = join(
    fixture.runDirectory,
    "alternate-run.json",
  );
  await writeFile(alternateManifestPath, fixture.manifestBytes);
  const getTaskAuthority = fixture.adapter.getTaskAuthority;
  fixture.adapter.getTaskAuthority = async (request) => {
    const authority = await getTaskAuthority(request);
    if (request.taskId === fixture.producerTaskId) {
      authority.runManifestPath = alternateManifestPath;
    }
    return authority;
  };
  const stderr = captureStream();

  assert.equal(
    await runCli(["gate", "--spec", fixture.gatePath], {
      adapter: fixture.adapter,
      env: { HERMES_KANBAN_TASK: fixture.validatorTaskId },
      stdout: captureStream().stream,
      stderr: stderr.stream,
    }),
    1,
  );

  assert.match(stderr.value(), /producer task authority does not match/);
  await assert.rejects(readFile(fixture.evidencePath), { code: "ENOENT" });
});

test("handoff-validation gate aborts work at its timeout", async (t) => {
  const fixture = await handoffGateFixture(t, { timeoutSeconds: 1 });
  fixture.adapter.getTerminalCompletedAttempt = async ({ signal }) =>
    new Promise((resolve, reject) => {
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(signal.reason);
      }, { once: true });
    });
  const stderr = captureStream();

  assert.equal(
    await runCli(["gate", "--spec", fixture.gatePath], {
      adapter: fixture.adapter,
      env: { HERMES_KANBAN_TASK: fixture.validatorTaskId },
      stdout: captureStream().stream,
      stderr: stderr.stream,
    }),
    1,
  );

  assert.match(stderr.value(), /handoff-validation gate timed out after 1s/);
  await assert.rejects(readFile(fixture.evidencePath), { code: "ENOENT" });
});

async function handoffGateFixture(t, { timeoutSeconds = 30 } = {}) {
  const runDirectory = await mkdtemp(join(tmpdir(), "agent-flow-handoff-gate-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  const inputsDirectory = join(runDirectory, "inputs");
  const artifactsDirectory = join(runDirectory, "artifacts");
  const validationDirectory = join(runDirectory, "validated");
  await mkdir(inputsDirectory);
  await mkdir(artifactsDirectory);

  const artifactPath = join(artifactsDirectory, "correctness.json");
  const artifactBytes = JSON.stringify({ findings: [] });
  await writeFile(artifactPath, artifactBytes);

  const graph = {
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
        skill: "review-flow-controller",
        max_attempts: 1,
        semantic_measurement: false,
        validates_handoff_for: null,
        optional: false,
      },
      {
        key: "lens:correctness",
        profile: "analyst",
        workspace: "candidate-worktree",
        skill: "review-lens",
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
  const graphPath = join(inputsDirectory, "graph.json");
  const graphBytes = JSON.stringify(graph);
  await writeFile(graphPath, graphBytes);

  const evidencePath = join(artifactsDirectory, "correctness.validation.json");
  const gate = {
    schema: "agent-flow.gate/v1",
    name: "validate-correctness-handoff",
    version: 1,
    run_id: "review-handoff-example",
    stage: "validate-handoff:lens:correctness",
    kind: "handoff-validation",
    workspace: runDirectory,
    read_roots: [runDirectory],
    write_root: artifactsDirectory,
    timeout_seconds: timeoutSeconds,
    inputs: [],
    outputs: [evidencePath],
    handoff_validation: {
      producer_stage: "lens:correctness",
      require_passed: true,
    },
  };
  const gatePath = join(inputsDirectory, "validate-correctness.json");
  const gateBytes = JSON.stringify(gate);
  await writeFile(gatePath, gateBytes);

  const manifest = {
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
        "agent-flow.task-authority/v1",
        "agent-flow.command-result/v1",
      ],
      content_set_fingerprint: SHA256,
    },
    identity: {
      run_id: gate.run_id,
      run_directory: runDirectory,
      artifact_directory: artifactsDirectory,
      validation_directory: validationDirectory,
      flow: "review",
      repository: { path: runDirectory, forge_coordinate: null },
      board: "handoff-gate-test",
      tenant: gate.run_id,
      parent_run_id: null,
      external_root: null,
      supersedes: null,
    },
    graph: {
      name: graph.name,
      version: graph.version,
      flow: graph.flow,
      sealed_path: graphPath,
      sha256: sha256(graphBytes),
    },
    approved_read_roots: [runDirectory],
    approved_artifact_roots: [artifactsDirectory],
    inputs: [
      ["review-manifest", "review.json", join(inputsDirectory, "review.json"), SHA256],
      ["gate", "validate-correctness.json", gatePath, sha256(gateBytes)],
      ["skill", "handoff-validator", join(inputsDirectory, "handoff-validator.md"), SHA256],
      ["role-contract", "gate", join(inputsDirectory, "gate-contract.md"), SHA256],
    ].map(([kind, name, sealedPath, digest]) => ({
      kind,
      name,
      source_path: join(runDirectory, `source-${name}`),
      sealed_path: sealedPath,
      sha256: digest,
    })),
    profiles: {
      profile_set_fingerprint: SHA256,
      required: ["gate"],
      fingerprints: { gate: SHA256 },
    },
    limits: {
      max_created_cards: 3,
      max_worker_attempts: 4,
      max_elapsed_seconds: 300,
      max_feature_streams: 1,
    },
    revisions: { base: GIT_SHA, source: GIT_SHA, target: null },
    sealed_at: "2026-07-15T12:00:00Z",
  };
  const manifestPath = join(runDirectory, "run.json");
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(manifestPath, manifestBytes);

  const validatorTaskId = "t_validator";
  const producerTaskId = "t_producer";
  const handoff = {
    schema: "agent-flow.handoff/v1",
    run_id: gate.run_id,
    flow: "review",
    stage: gate.handoff_validation.producer_stage,
    attempt: 2,
    passed: true,
    artifacts: [
      {
        kind: "review-findings",
        path: artifactPath,
        sha256: sha256(artifactBytes),
      },
    ],
    changed_files: [],
    verification: [],
    dependencies: [],
    retry_notes: ["attempt 1 crashed before completion"],
    residual_risk: [],
  };
  const completed = {
    attemptId: "run-2",
    taskId: producerTaskId,
    attempt: 2,
    state: "completed",
    metadata: { handoff },
  };
  const authority = {
    runId: gate.run_id,
    runManifestPath: manifestPath,
    runManifestSha256: sha256(manifestBytes),
  };
  const adapter = {
    async getTaskAuthority({ taskId }) {
      if (taskId === validatorTaskId) {
        return {
          taskId,
          stage: gate.stage,
          ...authority,
          gateSpecPath: gatePath,
          gateSpecSha256: sha256(gateBytes),
          producerTaskId,
        };
      }
      return {
        taskId,
        stage: gate.handoff_validation.producer_stage,
        ...authority,
      };
    },
    async getTerminalCompletedAttempt() {
      return completed;
    },
    async getCompletedAttempt() {
      return completed;
    },
  };
  return {
    adapter,
    artifactBytes,
    completed,
    evidencePath,
    gatePath,
    handoff,
    manifestBytes,
    producerTaskId,
    runDirectory,
    validatorTaskId,
  };
}

function captureStream() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    value: () => value,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

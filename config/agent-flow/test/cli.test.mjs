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

import { runCli } from "../src/cli-command.mjs";
import {
  formatTaskAuthority,
  HermesAdapter,
} from "../src/hermes-adapter.mjs";
import { validateContract } from "../src/schema-validator.mjs";

const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function captureStream() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    value: () => value,
  };
}

test("agent-flow preserves the profile doctor command", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const report = {
    ok: true,
    checks: [{ ok: true, summary: "profiles are healthy", details: [] }],
  };

  assert.equal(
    await runCli(["doctor", "profiles", "--json"], {
      runDoctor: async () => report,
      stdout: stdout.stream,
      stderr: stderr.stream,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(stdout.value()), report);
  assert.equal(stderr.value(), "");

  const invalidStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", "relative-gate.json"], {
      adapter: {
        async getTaskAuthority() {
          throw new Error("relative path reached the adapter");
        },
      },
      env: { HERMES_KANBAN_TASK: "t_gate" },
      stdout: captureStream().stream,
      stderr: invalidStderr.stream,
    }),
    2,
  );
  assert.equal(invalidStderr.value(), "gate --spec path must be absolute\n");
});

test("agent-flow gate executes the command pinned to the current task", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "agent-flow-cli-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  const inputsDirectory = join(runDirectory, "inputs");
  const artifactsDirectory = join(runDirectory, "artifacts");
  await mkdir(inputsDirectory);
  await mkdir(artifactsDirectory);

  const outputPath = join(artifactsDirectory, "command.json");
  const gate = {
    schema: "agent-flow.gate/v1",
    name: "command-gate",
    version: 1,
    run_id: "review-cli-example",
    stage: "command-gate",
    kind: "command",
    workspace: runDirectory,
    read_roots: [runDirectory],
    write_root: artifactsDirectory,
    timeout_seconds: 30,
    inputs: [],
    outputs: [outputPath],
    commands: [
      {
        argv: [process.execPath, "-e", "process.stdout.write('gate-ok\\n')"],
        cwd: runDirectory,
        output_path: outputPath,
      },
    ],
  };
  const gatePath = join(inputsDirectory, "command-gate.json");
  let gateBytes = JSON.stringify(gate);
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
        "agent-flow.review-comments/v1",
        "agent-flow.review-result/v1",
        "agent-flow.task-authority/v1",
        "agent-flow.command-result/v1",
      ],
      content_set_fingerprint: SHA256,
    },
    identity: {
      run_id: "review-cli-example",
      run_directory: runDirectory,
      artifact_directory: artifactsDirectory,
      validation_directory: join(runDirectory, "validated"),
      flow: "review",
      repository: { path: runDirectory, forge_coordinate: null },
      board: "cli-test",
      tenant: "review-cli-example",
      parent_run_id: null,
      external_root: null,
      supersedes: null,
    },
    graph: {
      name: "local-review",
      version: 1,
      flow: "review",
      sealed_path: join(inputsDirectory, "graph.json"),
      sha256: SHA256,
    },
    approved_read_roots: [runDirectory],
    approved_artifact_roots: [artifactsDirectory],
    inputs: [
      ["review-manifest", "review.json"],
      ["gate", "command-gate.json"],
      ["skill", "gate-skill.md"],
      ["role-contract", "gate-contract.md"],
    ].map(([kind, name], index) => ({
      kind,
      name,
      source_path: join(runDirectory, `source-${index}`),
      sealed_path: kind === "gate"
        ? gatePath
        : join(inputsDirectory, `${index}-${name}`),
      sha256: kind === "gate" ? sha256(gateBytes) : SHA256,
    })),
    profiles: {
      profile_set_fingerprint: SHA256,
      required: ["gate"],
      fingerprints: { gate: SHA256 },
    },
    limits: {
      max_created_cards: 4,
      max_worker_attempts: 4,
      max_elapsed_seconds: 300,
      max_feature_streams: 1,
    },
    revisions: { base: GIT_SHA, source: GIT_SHA, target: null },
    sealed_at: "2026-07-14T12:00:00Z",
  };
  const manifestPath = join(runDirectory, "run.json");
  let manifestBytes = JSON.stringify(manifest);
  await writeFile(manifestPath, manifestBytes);
  async function sealGate() {
    gateBytes = JSON.stringify(gate);
    await writeFile(gatePath, gateBytes);
    manifest.inputs.find(({ kind }) => kind === "gate").sha256 =
      sha256(gateBytes);
    manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
  }

  const taskId = "t_command_gate";
  const adapter = {
    async getTaskAuthority() {
      return {
        taskId,
        runId: manifest.identity.run_id,
        stage: gate.stage,
        runManifestPath: manifestPath,
        runManifestSha256: sha256(manifestBytes),
        gateSpecPath: gatePath,
        gateSpecSha256: sha256(gateBytes),
      };
    },
  };
  const stdout = captureStream();
  const stderr = captureStream();

  const exitCode = await runCli(["gate", "--spec", gatePath], {
    adapter,
    env: { HERMES_KANBAN_TASK: taskId },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.value(), "ok - command gate passed\n");
  assert.equal(stderr.value(), "");
  const evidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(evidence, {
    schema: "agent-flow.command-result/v1",
    run_id: manifest.identity.run_id,
    stage: gate.stage,
    gate_name: gate.name,
    gate_version: gate.version,
    command_index: 0,
    argv: gate.commands[0].argv,
    cwd: runDirectory,
    termination: "exit",
    exit_code: 0,
    stdout: "gate-ok\n",
    stderr: "",
  });
  assert.equal((await validateContract(evidence)).valid, true);

  const missingOutputPath = join(artifactsDirectory, "missing-product.json");
  gate.outputs.push(missingOutputPath);
  await sealGate();
  const missingOutputStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: missingOutputStderr.stream,
    }),
    1,
  );
  assert.match(missingOutputStderr.value(), /declared gate output is missing/);
  gate.outputs.pop();
  await sealGate();

  const outsideOutputDirectory = await mkdtemp(
    join(tmpdir(), "agent-flow-output-escape-"),
  );
  t.after(() => rm(outsideOutputDirectory, { recursive: true, force: true }));
  const outsideOutput = join(outsideOutputDirectory, "product.json");
  const linkedOutput = join(artifactsDirectory, "linked-product.json");
  const commandMarker = join(artifactsDirectory, "command-ran");
  await writeFile(outsideOutput, "original");
  await symlink(outsideOutput, linkedOutput, "file");
  gate.outputs.push(linkedOutput);
  const successfulArgv = gate.commands[0].argv;
  gate.commands[0].argv = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(linkedOutput)}, "changed"); ` +
      `require("node:fs").writeFileSync(${JSON.stringify(commandMarker)}, "ran")`,
  ];
  await sealGate();
  const linkedOutputStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: linkedOutputStderr.stream,
    }),
    1,
  );
  assert.match(
    linkedOutputStderr.value(),
    /existing gate output resolves outside write root/,
  );
  assert.equal(await readFile(outsideOutput, "utf8"), "original");
  await assert.rejects(readFile(commandMarker), { code: "ENOENT" });
  gate.outputs.pop();
  gate.commands[0].argv = successfulArgv;
  await rm(linkedOutput);
  await sealGate();

  const danglingTarget = join(outsideOutputDirectory, "missing-product.json");
  const danglingOutput = join(artifactsDirectory, "dangling-product.json");
  await symlink(danglingTarget, danglingOutput, "file");
  gate.outputs.push(danglingOutput);
  gate.commands[0].argv = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(danglingOutput)}, "created"); ` +
      `require("node:fs").writeFileSync(${JSON.stringify(commandMarker)}, "ran")`,
  ];
  await sealGate();
  const danglingOutputStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: danglingOutputStderr.stream,
    }),
    1,
  );
  assert.match(danglingOutputStderr.value(), /dangling symlink/);
  await assert.rejects(readFile(danglingTarget), { code: "ENOENT" });
  await assert.rejects(readFile(commandMarker), { code: "ENOENT" });
  gate.outputs.pop();
  gate.commands[0].argv = successfulArgv;
  await rm(danglingOutput);
  await sealGate();

  const unpinnedPath = join(inputsDirectory, "unpinned-gate.json");
  await writeFile(unpinnedPath, gateBytes);
  const rejectedStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", unpinnedPath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: rejectedStderr.stream,
    }),
    1,
  );
  assert.match(rejectedStderr.value(), /not pinned to the task/);

  gate.commands[0].argv = [
    process.execPath,
    "-e",
    "process.stderr.write('gate-failed\\n'); process.exit(3)",
  ];
  await sealGate();

  const failedStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: failedStderr.stream,
    }),
    1,
  );
  assert.equal(failedStderr.value(), "not ok - command gate failed\n");
  const failedEvidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(failedEvidence.termination, "exit");
  assert.equal(failedEvidence.exit_code, 3);
  assert.equal(failedEvidence.stderr, "gate-failed\n");

  const descendantMarker = join(artifactsDirectory, "descendant-survived");
  const descendantScript =
    `setTimeout(() => require("node:fs").writeFileSync(` +
    `${JSON.stringify(descendantMarker)}, "survived"), 1500)`;
  gate.commands[0].argv = [
    process.execPath,
    "-e",
    `require("node:child_process").spawn(` +
      `${JSON.stringify(process.execPath)}, ` +
      `["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" }); ` +
      "setTimeout(() => {}, 5000)",
  ];
  gate.timeout_seconds = 1;
  await sealGate();
  const timeoutStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: timeoutStderr.stream,
    }),
    1,
  );
  assert.equal(timeoutStderr.value(), "not ok - command gate failed\n");
  const timeoutEvidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(timeoutEvidence.termination, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(readFile(descendantMarker), { code: "ENOENT" });

  const escapedWorkspace = join(runDirectory, "escaped-workspace");
  await symlink(tmpdir(), escapedWorkspace, "dir");
  gate.workspace = escapedWorkspace;
  gate.commands[0].cwd = escapedWorkspace;
  gate.timeout_seconds = 30;
  await sealGate();

  const escapedStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: escapedStderr.stream,
    }),
    1,
  );
  assert.match(escapedStderr.value(), /workspace resolves outside read roots/);

  await rm(escapedWorkspace);
  const outsideReadRoot = await mkdtemp(join(tmpdir(), "agent-flow-read-escape-"));
  t.after(() => rm(outsideReadRoot, { recursive: true, force: true }));
  const approvedReadLink = join(runDirectory, "approved-read-link");
  await symlink(outsideReadRoot, approvedReadLink, "dir");
  gate.workspace = approvedReadLink;
  gate.read_roots = [approvedReadLink];
  gate.commands[0].cwd = approvedReadLink;
  gate.commands[0].argv = [process.execPath, "-e", "process.exit(0)"];
  manifest.approved_read_roots = [approvedReadLink];
  await sealGate();
  const escapedReadRootStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: escapedReadRootStderr.stream,
    }),
    1,
  );
  assert.match(
    escapedReadRootStderr.value(),
    /approved read root resolves outside run or repository roots/,
  );

  gate.workspace = runDirectory;
  gate.read_roots = [runDirectory];
  gate.commands[0].cwd = runDirectory;
  manifest.approved_read_roots = [runDirectory];
  await rm(artifactsDirectory, { recursive: true });
  await symlink(inputsDirectory, artifactsDirectory, "dir");
  await sealGate();
  const aliasedArtifactRootStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: aliasedArtifactRootStderr.stream,
    }),
    1,
  );
  assert.match(
    aliasedArtifactRootStderr.value(),
    /artifact directory must resolve to canonical run artifacts directory/,
  );
  await rm(artifactsDirectory);
  const outsideArtifactRoot = await mkdtemp(
    join(tmpdir(), "agent-flow-write-escape-"),
  );
  t.after(() => rm(outsideArtifactRoot, { recursive: true, force: true }));
  await symlink(outsideArtifactRoot, artifactsDirectory, "dir");
  await sealGate();
  const escapedArtifactRootStderr = captureStream();
  assert.equal(
    await runCli(["gate", "--spec", gatePath], {
      adapter,
      env: { HERMES_KANBAN_TASK: taskId },
      stdout: captureStream().stream,
      stderr: escapedArtifactRootStderr.stream,
    }),
    1,
  );
  assert.match(
    escapedArtifactRootStderr.value(),
    /artifact directory must resolve to canonical run artifacts directory/,
  );
});

test("Hermes adapter translates native completed runs at the production seam", async () => {
  const calls = [];
  const authority = {
    schema: "agent-flow.task-authority/v1",
    run_id: "review-cli-example",
    stage: "validate-handoff:lens:correctness",
    run_manifest_path: "/tmp/run.json",
    run_manifest_sha256: SHA256,
    gate_spec_path: "/tmp/gate.json",
    gate_spec_sha256: SHA256,
    producer_task_id: "t_producer",
    input_task_ids: { "/tmp/input.validation.json": "t_input_validator" },
  };
  const adapter = new HermesAdapter({
    board: "cli-test",
    async run(args) {
      calls.push(args);
      return {
        task: {
          id: args.at(-2),
          body: `Review the candidate.\n\n${formatTaskAuthority(authority)}`,
        },
        runs: [
          {
            id: 41,
            status: "crashed",
            outcome: "crashed",
            started_at: 10,
            metadata: null,
          },
          {
            id: 42,
            status: "done",
            outcome: "completed",
            started_at: 20,
            metadata: { handoff: { passed: true } },
          },
        ],
      };
    },
  });

  assert.deepEqual(await adapter.getTaskAuthority({ taskId: "t_validator" }), {
    taskId: "t_validator",
    runId: "review-cli-example",
    stage: "validate-handoff:lens:correctness",
    runManifestPath: "/tmp/run.json",
    runManifestSha256: SHA256,
    gateSpecPath: "/tmp/gate.json",
    gateSpecSha256: SHA256,
    producerTaskId: "t_producer",
    inputTaskIds: { "/tmp/input.validation.json": "t_input_validator" },
  });
  assert.deepEqual(
    await adapter.getCompletedAttempt({ taskId: "t_lens", attempt: 2 }),
    {
      attemptId: "42",
      taskId: "t_lens",
      attempt: 2,
      state: "completed",
      metadata: { handoff: { passed: true } },
    },
  );
  assert.deepEqual(
    await adapter.getTerminalCompletedAttempt({ taskId: "t_lens" }),
    {
      attemptId: "42",
      taskId: "t_lens",
      attempt: 2,
      state: "completed",
      metadata: { handoff: { passed: true } },
    },
  );
  assert.deepEqual(calls, [
    ["kanban", "--board", "cli-test", "show", "t_validator", "--json"],
    ["kanban", "--board", "cli-test", "show", "t_lens", "--json"],
    ["kanban", "--board", "cli-test", "show", "t_lens", "--json"],
  ]);
});

test("Hermes adapter rejects malformed durable task authority", async () => {
  const adapter = new HermesAdapter({
    async run() {
      return {
        task: {
          id: "t_lens",
          body: formatTaskAuthority({
            schema: "agent-flow.task-authority/v1",
            run_id: "review-cli-example",
            stage: "lens:correctness",
            run_manifest_path: "/tmp/run.json",
            run_manifest_sha256: SHA256,
            unexpected: true,
          }),
        },
        runs: [],
      };
    },
  });

  await assert.rejects(
    adapter.getTaskAuthority({ taskId: "t_lens" }),
    /invalid agent-flow task authority/,
  );
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { digest } from "../../../tools/flow/src/canonical.mjs";
import { createDurableRunAuthority } from "../../../tools/flow/src/run-authority.mjs";
import {
  createFlowRuntime,
  statusAutonomousFlowRuntime,
  stopAutonomousFlowRuntime,
} from "../../../tools/flow/src/flow-runtime.mjs";
import {
  createFixedTimeDurableRunAuthority,
  fixedHostIdentity,
} from "../../../tools/flow/test-support/fixed-host-identity.mjs";
import {
  registeredOperationProposal,
} from "../../../tools/flow/test-support/registered-operation.mjs";
import { confirmedLaunchRequest } from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import { runUbuntuHeadlessTextCaptures } from "../src/host-recovery-operator-scenarios.mjs";
import {
  cleanupQualificationIsolation,
  createQualificationIsolation,
} from "../src/host-recovery-qualification.mjs";

const execFileAsync = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "../../..");
const PROVIDER = resolve(
  import.meta.dirname,
  "../scripts/run-host-recovery-headless-provider.mjs",
);

test("headless provider derives eight forms from real Flow projections and the operator driver accepts them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-headless-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, "captured");
  const rawRoot = join(root, "raw");
  await mkdir(inputRoot, { recursive: true, mode: 0o700 });

  const authority = createFixedTimeDurableRunAuthority({
    authorityDirectory: join(root, "authority"),
    hostIdentityAdapter: fixedHostIdentity("boot:provider-test", "process:provider-test"),
  });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    autonomous: false,
    registeredOperations: {
      "flow.operation/conformance-record/v1": {
        classification: "caller_idempotent",
        invoke() {},
      },
    },
  });
  t.after(() => authority.close());

  const prepared = runtime.prepare(registeredOperationProposal({ checkpointBound: true }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(launch.schema, "flow.launch-receipt/v1");
  const projection = runtime.query({ run_id: launch.run_id });
  const statusAuthority = createDurableRunAuthority({
    authorityDirectory: join(root, "status-authority"),
    hostIdentityAdapter: fixedHostIdentity("boot:status", "process:status"),
  });
  const statusRuntime = createFlowRuntime({
    runAuthority: statusAuthority,
    autonomous: true,
  });
  t.after(() => {
    stopAutonomousFlowRuntime(statusRuntime);
    statusAuthority.close();
  });
  const status = {
    ...statusAutonomousFlowRuntime(statusRuntime),
    watermark: projection.watermark,
    legal_actions: projection.legal_actions,
  };
  const releaseEvidence = {
    release_id: "flow-release-test/v1",
    route: "headless_text",
    manifest_digest: digest({ release_id: "flow-release-test/v1" }),
  };
  await writeFile(join(inputRoot, "status.json"), `${JSON.stringify(status)}\n`);
  await writeFile(join(inputRoot, "projection.json"), `${JSON.stringify(projection)}\n`);
  await writeFile(join(inputRoot, "candidate.json"), `${JSON.stringify({
    schema: "work.review-candidate-projection/v1",
    candidate_id: projection.run_id,
    candidate_fingerprint: projection.bundle_digest,
    watermark: projection.watermark,
    legal_actions: projection.legal_actions,
  })}\n`);
  await writeFile(join(inputRoot, "review.log"), `${JSON.stringify({
    command_kind: "query",
    output: {
      schema: "flow.review-inbox-projection/v1",
      watermark: projection.watermark,
      items: [],
      legal_actions: projection.legal_actions,
    },
  })}\n`);
  await writeFile(join(inputRoot, "release-evidence.json"), `${JSON.stringify(releaseEvidence)}\n`);

  const result = await execFileAsync(process.execPath, [
    PROVIDER,
    "--input-root", inputRoot,
  ], { cwd: WORKTREE, encoding: "utf8" });
  const provider = JSON.parse(result.stdout);
  assert.equal(provider.schema, "flow.host-recovery-headless-provider/v1");
  assert.equal(provider.status, "pass");
  assert.deepEqual(
    provider.captures.map(({ kind }) => kind),
    ["terminal", "status", "checkpoint", "candidate", "review", "graph", "timeline", "tuicr"],
  );
  assert.equal(new Set(provider.captures.map(({ kind }) => kind)).size, 8);
  for (const capture of provider.captures) {
    assert.equal(capture.provenance, "native_provider");
    assert.match(capture.watermark, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(Array.isArray(capture.legal_actions));
    assert.equal(capture.legibility, "pass");
    assert.equal(capture.source.provenance, "public_process");
  }
  assert.equal(provider.captures.find(({ kind }) => kind === "graph").watermark,
    projection.views.graph.authority_watermark);
  assert.deepEqual(
    provider.captures.find(({ kind }) => kind === "graph").legal_actions,
    projection.views.graph.legal_actions,
  );
  assert.deepEqual(
    provider.out_of_scope_forms.map(({ form }) => form),
    ["macos_visual", "expanded_macos_visuals"],
  );

  const isolation = createQualificationIsolation({
    worktreeRoot: WORKTREE,
    xdgStateHome: join(root, "driver-state"),
    authorityDirectory: join(root, "driver-authority"),
    socketPath: join(root, "driver-authority", "owner.sock"),
    endpointPath: join(root, "driver-authority", "owner.json"),
    backupDirectory: join(root, "driver-backup"),
    repositoryRoot: join(root, "driver-repository"),
    drovrConfigDirectory: join(root, "driver-drovr"),
    qualificationWorkspace: join(root, "driver-workspace"),
    herdrSession: "herdr:issue-46-headless-provider",
    runId: "run:issue-46-headless-provider",
  });
  const command = (kind, output) => ({
    command: {
      id: `command:${kind}`,
      argv: ["node", "config/flow/src/cli.mjs", kind, "--json"],
      command_kind: kind,
      launcher_ref: "config/flow/src/cli.mjs",
      host_ref: "config/flow/src/owner-process.mjs",
      working_directory_ref: "worktree",
      started_at: "2026-09-17T10:00:00.000Z",
      finished_at: "2026-09-17T10:00:00.001Z",
      duration_ms: 1,
      exit_code: 0,
      signal: null,
      expected_exit_code: 0,
      expected_signal: null,
      expected_timed_out: false,
      timed_out: false,
      logs: {
        stdout: { path: null, sha256: "a".repeat(64), bytes: 0 },
        stderr: { path: null, sha256: "b".repeat(64), bytes: 0 },
      },
    },
    output,
  });
  const statusOutput = status;
  const queryOutput = projection;
  const watchOutput = projection;
  const driver = await runUbuntuHeadlessTextCaptures({
    entrypoints: {
      node: { path: process.execPath },
      launcher: { path: join(WORKTREE, "config/flow/src/cli.mjs") },
      host: { path: join(WORKTREE, "config/flow/src/owner-process.mjs") },
    },
    isolation,
    rawRoot,
    commandRunner: async ({ kind }) => command(
      kind,
      kind === "status" ? statusOutput : kind === "query" ? queryOutput : watchOutput,
    ),
    toolRunner: async ({ operation }) => {
      if (operation !== "headless_captures") throw new Error(`unexpected operation ${operation}`);
      return {
        command: command("native_headless_capture_probe", provider).command,
        output: provider,
      };
    },
    cleanupRunner: () => cleanupQualificationIsolation(isolation),
    outOfScopeForms: provider.out_of_scope_forms,
  });
  assert.equal(driver.result.disposition, "pass", JSON.stringify(driver));
  assert.equal(driver.captures.length, 8);
});

test("headless provider fails closed when a required projection form is absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-headless-provider-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, "captured");
  await mkdir(inputRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(inputRoot, "release-evidence.json"), JSON.stringify({
    release_id: "flow-release-test/v1",
    route: "headless_text",
  }));
  await writeFile(join(inputRoot, "status.json"), JSON.stringify({
    schema: "flow.runtime-runner-status/v1",
    watermark: `sha256:${"a".repeat(64)}`,
    legal_actions: [],
  }));

  await assert.rejects(
    execFileAsync(process.execPath, [PROVIDER, "--input-root", inputRoot], {
      cwd: WORKTREE,
      encoding: "utf8",
    }),
    (error) => error?.code === 1 && /candidate|checkpoint|review|graph|timeline|tuicr/u.test(error.stderr),
  );
});

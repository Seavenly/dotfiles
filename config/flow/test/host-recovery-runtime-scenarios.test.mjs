import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createQualificationIsolation,
} from "../src/host-recovery-qualification.mjs";
import {
  runConcurrentRunsOwnerRestart,
  runActionableFailureRecovery,
  runBackupRestoreReconciliation,
  runProjectionRebuildReaders,
  runSuspendedRunAdmission,
} from "../src/host-recovery-runtime-scenarios.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_DIGEST = `sha256:${"c".repeat(64)}`;

test("concurrent owner restart driver proves bounded capacity and exactly-once effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-runtime-scenario-1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const isolation = createQualificationIsolation({
    worktreeRoot: worktree,
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    herdrSession: "herdr:scenario-1-fixture",
    runId: "run:scenario-1-fixture",
  });
  const rawRoot = join(root, "raw");
  const entrypoints = {
    node: { path: process.execPath },
    launcher: { path: join(worktree, "config/flow/src/cli.mjs") },
    host: { path: join(worktree, "config/flow/src/owner-process.mjs") },
  };
  const outputs = new Map([
    ["start", {
      schema: "flow.owner-status/v1",
      state: "running",
      pid: 100,
      process_identity: "owner:100:first",
      process_start_identity: "boot:fixture",
      proof: { client_exit: { client_exited: true } },
    }],
    ["status", {
      schema: "flow.owner-status/v1",
      state: "running",
      pid: 100,
      process_identity: "owner:100:first",
      process_start_identity: "boot:fixture",
      proof: { client_exit: { client_exited: true } },
    }],
    ["query", {
      schema: "flow.runtime-runner-status/v1",
      watermark: DIGEST,
      state: "running",
      delegates: { active: 2, capacity: 2, available: 0 },
      operations: { active: 0, capacity: 1, available: 1 },
      proof: {
        capacity: {
          bounded_capacity: true,
          capacity: 2,
          active_runs: 2,
          run_ids: ["run:one", "run:two"],
          slow_delegate: true,
        },
        effect: {
          duplicate_effect: false,
          effect_id: "effect:once",
          invocation_count: 1,
          manual_driver: false,
        },
        owner_restart: {
          owner_killed: true,
          termination_signal: "SIGKILL",
          same_boot_restart: true,
          before_boot_id: "boot:fixture",
          after_boot_id: "boot:fixture",
          before_process_identity: "owner:100:first",
          after_process_identity: "owner:101:second",
        },
      },
    }],
    ["watch", {
      schema: "flow.watch-observation/v1",
      watermark: DIGEST,
      proof: {
        owner_restart: {
          owner_killed: true,
          termination_signal: "SIGKILL",
          same_boot_restart: true,
          before_boot_id: "boot:fixture",
          after_boot_id: "boot:fixture",
          before_process_identity: "owner:100:first",
          after_process_identity: "owner:101:second",
        },
      },
    }],
  ]);
  const commandRunner = async ({ args }) => ({
    command: commandRecord(args[0]),
    stdout: outputs.has(args[0]) ? `${JSON.stringify(outputs.get(args[0]))}\n` : "",
    stderr: "",
  });
  const result = await runConcurrentRunsOwnerRestart({
    entrypoints,
    isolation,
    rawRoot,
    commandRunner,
    nativeDelegate: {
      schema: "flow.native-delegate-observation/v1",
      status: "available",
      provider_identity: "fixture/native-delegate",
      watermark: DIGEST,
      invocation_count: 2,
    },
  });

  assert.equal(result.result.disposition, "pass");
  assert.deepEqual(result.commands.map(({ command_kind }) => command_kind), [
    "start", "status", "query", "watch",
  ]);
  assert.deepEqual(result.observations.map(({ kind }) => kind), [
    "capacity", "client_exit", "owner_restart", "effect",
  ]);
  assert.equal(result.assertions.every(({ disposition }) => disposition === "pass"), true);
  assert.equal(result.captures.length >= 4, true);
  assert.equal(new Set(result.captures.map(({ kind }) => kind)).size, result.captures.length);
});

test("concurrent owner restart driver blocks without a native delegate observation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-runtime-scenario-1-blocked-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolation = createQualificationIsolation({
    worktreeRoot: join(root, "worktree"),
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    herdrSession: "herdr:scenario-1-blocked",
    runId: "run:scenario-1-blocked",
  });
  let calls = 0;
  const result = await runConcurrentRunsOwnerRestart({
    entrypoints: {
      node: { path: process.execPath },
      launcher: { path: join(root, "worktree", "config/flow/src/cli.mjs") },
      host: { path: join(root, "worktree", "config/flow/src/owner-process.mjs") },
    },
    isolation,
    rawRoot: join(root, "raw"),
    commandRunner: async () => {
      calls += 1;
      throw new Error("the live delegate is unavailable");
    },
  });

  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "native_delegate_unavailable");
  assert.equal(calls, 0);
  assert.equal(result.cleanup.disposition, "complete");
});

test("actionable failure driver records typed recovery failures and one-shot uncertainty", async (t) => {
  const fixture = await scenarioFixture(t, "scenario-2");
  const watermark = DIGEST;
  const outputs = new Map([
    ["prepare", {
      schema: "flow.prepared-run/v1",
      bundle_digest: DIGEST,
      plan_fingerprint: DIGEST,
      proof: {
        failure: {
          typed_failure: true,
          cancellation: true,
          deadline: true,
          capped_recovery: true,
          provider_outage: true,
          invalid_output: true,
          failure_codes: ["cancelled", "deadline_exhausted", "provider_outage", "invalid_output"],
          invocation_counts: {
            cancellation: 1,
            deadline: 1,
            capped_recovery: 1,
            provider_outage: 1,
            invalid_output: 1,
          },
          actionable_failures: Object.fromEntries(
            ["cancellation", "deadline", "capped_recovery", "provider_outage", "invalid_output"]
              .map((name) => [name, {
                observed: true,
                operator_response: `respond_${name}`,
                legal_actions: [],
              }])),
          watermark,
          legal_actions: [{ type: "retry", expected_watermark: watermark }],
          expected_negative_commands: [
            { action: "cancel", expected_exit_code: 1, expected_signal: null, expected_timed_out: false },
            { action: "deadline", expected_exit_code: 1, expected_signal: null, expected_timed_out: false },
          ],
        },
      },
    }],
    ["launch", {
      schema: "flow.launch-receipt/v1",
      run_id: "run:failure-fixture",
      bundle_digest: DIGEST,
      authority_watermark: watermark,
      proof: { failure: { typed_failure: true } },
    }],
    ["command", {
      schema: "flow.command-receipt/v1",
      command_type: "recovery",
      authority_watermark: watermark,
      proof: {
        failure: {
          typed_failure: true,
          cancellation: true,
          deadline: true,
          capped_recovery: true,
          provider_outage: true,
          invalid_output: true,
          watermark,
        },
        uncertainty: {
          one_shot: true,
          watermark,
          duplicate_effect: false,
          effect_id: "effect:uncertain-once",
          invocation_count: 1,
          legal_actions: [{ type: "reconcile", expected_watermark: watermark }],
          manual_driver: false,
        },
      },
    }],
    ["query", {
      schema: "flow.run-projection/v1",
      run_id: "run:failure-fixture",
      watermark,
      legal_actions: [{ type: "retry", expected_watermark: watermark }],
      proof: {
        failure: { typed_failure: true },
        uncertainty: { one_shot: true, duplicate_effect: false },
      },
    }],
  ]);
  const result = await runActionableFailureRecovery({
    ...fixture,
    commandRunner: async ({ args }) => ({
      command: commandRecord(args[0]),
      stdout: `${JSON.stringify(outputs.get(args[0]))}\n`,
      stderr: "",
    }),
    nativeDelegate: {
      schema: "flow.native-delegate-observation/v1",
      status: "available",
      provider_identity: "fixture/native-delegate",
      watermark: DIGEST,
      invocation_count: 1,
    },
  });

  assert.equal(result.result.disposition, "pass");
  assert.deepEqual(result.observations.map(({ kind }) => kind), ["failure", "uncertainty"]);
  assert.equal(result.observations[0].content.failure_codes.includes("provider_outage"), true);
  assert.equal(result.observations[1].content.invocation_count, 1);
  assert.equal(result.commands.every(({ expected_exit_code, exit_code }) =>
    expected_exit_code === exit_code), true);
  assert.equal(result.captures.length, 4);
});

test("backup restore driver records disposable loss, six-domain reconciliation, and admission", async (t) => {
  const fixture = await scenarioFixture(t, "scenario-3");
  const watermark = DIGEST;
  const manifest = MANIFEST_DIGEST;
  const probeOutput = {
    schema: "flow.production-backup-live-observation/v1",
    status: "pass",
    watermark,
    legal_actions: [{ type: "restore_reconcile", expected_watermark: watermark }],
    provider: {
      schema: "flow.filesystem-backup/v1",
      status: "available",
      provider_identity: "fixture/production-backup",
      watermark,
      manifest_digest: manifest,
      snapshot_digest: SNAPSHOT_DIGEST,
      backup_id: "backup:fixture",
    },
    proof: {
      backup: {
        production_backup: true,
        provider: "flow.filesystem-backup/v1",
        manifest_digest: manifest,
        snapshot_digest: SNAPSHOT_DIGEST,
        backup_id: "backup:fixture",
        watermark,
        legal_actions: [{ type: "restore_reconcile", expected_watermark: watermark }],
      },
      loss: {
        destructive_loss: true,
        disposable_only: true,
        protected_state_intact: true,
        lost_paths: ["isolation/state/disposable-cache"],
      },
      restore: {
        restored: true,
        manifest_digest: manifest,
        restore_id: "restore:fixture",
      },
      reconciliation: {
        domains_reconciled: 6,
        complete: true,
        manifest_digest: manifest,
        domains: [
          "database_streams", "artifact_state", "git_state",
          "filesystem_state", "external_effects", "drovr_obligations",
        ].map((domain) => ({ domain, status: "reconciled" })),
      },
      drovr_status: {
        observed: true,
        command: "drovr status",
        turn_id: "turn:issue-46-backup-retained",
        status: "working",
        provenance: "public_process",
        output_digest: DIGEST,
      },
      admission: {
        retained_result_admitted: true,
        manifest_digest: manifest,
        result_digest: DIGEST,
        explicit: true,
      },
    },
  };
  const result = await runBackupRestoreReconciliation({
    ...fixture,
    nativeBackupRestoreProbe: {
      command: commandRecord("native_backup_restore_probe"),
      output: probeOutput,
    },
  });

  assert.equal(result.result.disposition, "pass");
  assert.deepEqual(result.observations.map(({ kind }) => kind), [
    "backup", "loss", "restore", "reconciliation", "drovr_status", "admission",
  ]);
  assert.equal(result.observations.find(({ kind }) => kind === "reconciliation")
    .content.domains_reconciled, 6);
  assert.equal(result.retained_obligations.length, 0);
});

test("projection reader driver proves multiple views and bounded history latency without a mutation lock", async (t) => {
  const fixture = await scenarioFixture(t, "scenario-7");
  const queryWatermark = DIGEST;
  const watchWatermark = DIGEST;
  const outputs = new Map([
    ["query", {
      schema: "flow.run-index-projection/v1",
      watermark: queryWatermark,
      legal_actions: [{ type: "inspect", expected_watermark: queryWatermark }],
      proof: {
        query: { observed: true, watermark: queryWatermark },
        rebuild: {
          without_mutation_lock: true,
          mutation_lock_acquired: false,
          projection_identity_stable: true,
          rebuild_count: 2,
          provenance: "native_provider",
          owner_mutation_lock: {
            held: true,
            inspect_runtime_open: true,
            provenance: "native_provider",
          },
          inspect_runtime_lock_observations: [
            { available: true, held: true, provenance: "native_provider" },
            { available: true, held: true, provenance: "native_provider" },
          ],
          external_mutation_lock: {
            available: true,
            held: false,
            provenance: "native_provider",
          },
          owner_lock_release_observed: true,
          owner_authority_watermark: {
            before: queryWatermark,
            after: queryWatermark,
            stable: true,
            delta: null,
          },
        },
        views: {
          count: 3,
          view_ids: ["terminal", "status", "timeline"],
        },
        latency: {
          samples: [12, 18, 22],
          max_latency_ms: 100,
          history_entries: 4,
        },
      },
    }],
    ["watch", {
      schema: "flow.watch-observation/v1",
      watermark: watchWatermark,
      proof: {
        watch: { observed: true, watermark: watchWatermark },
      },
    }],
  ]);
  const result = await runProjectionRebuildReaders({
    ...fixture,
    commandRunner: async ({ args }) => ({
      command: commandRecord(args[0]),
      stdout: `${JSON.stringify(outputs.get(args[0]))}\n`,
      stderr: "",
    }),
  });

  assert.equal(result.result.disposition, "pass");
  assert.deepEqual(result.commands.map(({ command_kind }) => command_kind), ["query", "watch"]);
  assert.deepEqual(result.observations.map(({ kind }) => kind), [
    "query", "watch", "rebuild", "views", "latency",
  ]);
  assert.equal(result.observations.find(({ kind }) => kind === "rebuild")
    .content.mutation_lock_acquired, false);
});

test("suspended admission driver proves explicit simulated-boot admission without rebooting", async (t) => {
  const fixture = await scenarioFixture(t, "scenario-8");
  const watermark = DIGEST;
  const outputs = new Map([
    ["query", {
      schema: "flow.run-projection/v1",
      run_id: "run:suspended-fixture",
      watermark,
      admission: "suspended_after_reboot",
      authority_boot_id: "boot:simulated-new",
      legal_actions: [{
        schema: "flow.command/v1",
        type: "reboot_admission",
        expected_watermark: watermark,
        authority_boot_id: "boot:simulated-new",
        expected_generation: 3,
      }],
      proof: {
        suspended: {
          observed: true,
          admission: "suspended_after_reboot",
          prior_boot_id: "boot:simulated-old",
          current_boot_id: "boot:simulated-new",
          simulated_boot: true,
        },
      },
    }],
    ["command", {
      schema: "flow.command-receipt/v1",
      command_type: "reboot_admission",
      authority_watermark: watermark,
      proof: {
        admission: {
          explicit: true,
          command_type: "reboot_admission",
          action_identity: "reboot-action-fixture",
          simulated_boot: true,
        },
      },
    }],
    ["watch", {
      schema: "flow.watch-observation/v1",
      watermark,
      proof: {
        reboot: {
          actual_reboot: false,
          deferred: true,
          simulated: true,
          boot_identity_observed: true,
        },
      },
    }],
  ]);
  const result = await runSuspendedRunAdmission({
    ...fixture,
    commandRunner: async ({ args }) => ({
      command: commandRecord(args[0]),
      stdout: `${JSON.stringify(outputs.get(args[0]))}\n`,
      stderr: "",
    }),
  });

  assert.equal(result.result.disposition, "pass");
  assert.equal(result.observations.find(({ kind }) => kind === "reboot")
    .content.actual_reboot, false);
  assert.equal(result.observations.find(({ kind }) => kind === "admission")
    .content.explicit, true);
});

test("runtime capture persistence rejects command-id traversal and capture symlinks", async (t) => {
  const delegate = {
    schema: "flow.native-delegate-observation/v1",
    status: "available",
    provider_identity: "fixture/native-delegate",
    watermark: DIGEST,
    invocation_count: 1,
  };
  const output = {
    schema: "flow.owner-status/v1",
    state: "running",
    process_identity: "owner:fixture",
    proof: { client_exit: { client_exited: true } },
  };

  const traversal = await scenarioFixture(t, "capture-traversal");
  const traversalResult = await runConcurrentRunsOwnerRestart({
    ...traversal,
    commandRunner: async ({ args }) => ({
      command: commandRecord(args[0], { id: "../escape" }),
      stdout: `${JSON.stringify(output)}\n`,
      stderr: "",
    }),
    nativeDelegate: delegate,
  });
  assert.equal(traversalResult.result.disposition, "blocked");
  assert.equal(traversalResult.result.reason, "command_id_invalid");

  const symlinkFixture = await scenarioFixture(t, "capture-symlink");
  await mkdir(join(symlinkFixture.rawRoot, "outside"), { recursive: true });
  await mkdir(symlinkFixture.rawRoot, { recursive: true });
  await symlink(
    join(symlinkFixture.rawRoot, "outside"),
    join(symlinkFixture.rawRoot, "captures"),
  );
  const symlinkResult = await runConcurrentRunsOwnerRestart({
    ...symlinkFixture,
    commandRunner: async ({ args }) => ({
      command: commandRecord(args[0]),
      stdout: `${JSON.stringify(output)}\n`,
      stderr: "",
    }),
    nativeDelegate: delegate,
  });
  assert.equal(symlinkResult.result.disposition, "blocked");
  assert.equal(symlinkResult.result.reason, "capture_path_invalid");
});

test("runtime timeout aborts injected work and waits for acknowledgement before cleanup", async (t) => {
  const fixture = await scenarioFixture(t, "timeout-ack");
  let aborted = false;
  const result = await runProjectionRebuildReaders({
    ...fixture,
    timeoutMs: 10,
    commandRunner: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ command: commandRecord("query"), output: null });
      }, { once: true });
    }),
  });
  assert.equal(aborted, true);
  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "bounded_timeout");
  assert.equal(result.cleanup.disposition, "complete");
});

test("runtime timeout with no abort acknowledgement withholds cleanup", async (t) => {
  const fixture = await scenarioFixture(t, "timeout-unack");
  let cleanupCalled = false;
  const result = await runProjectionRebuildReaders({
    ...fixture,
    timeoutMs: 10,
    commandRunner: () => new Promise(() => {}),
    cleanup: () => {
      cleanupCalled = true;
      return { disposition: "complete", unresolved_obligations: [] };
    },
  });
  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "scenario_abort_unacknowledged");
  assert.equal(result.cleanup.disposition, "blocked");
  assert.equal(result.cleanup.unresolved_obligations[0].code, "work_in_flight");
  assert.equal(cleanupCalled, false);
});

function commandRecord(kind, { id = `fixture-${kind}` } = {}) {
  const started = "2026-09-17T10:00:00.000Z";
  const finished = "2026-09-17T10:00:00.010Z";
  return {
    id,
    argv: ["node", "config/flow/src/cli.mjs", kind, "--json"],
    command_kind: kind,
    launcher_ref: "config/flow/src/cli.mjs",
    host_ref: "config/flow/src/owner-process.mjs",
    working_directory_ref: "worktree",
    started_at: started,
    finished_at: finished,
    duration_ms: 10,
    exit_code: 0,
    signal: null,
    expected_exit_code: 0,
    expected_signal: null,
    expected_timed_out: false,
    timed_out: false,
    logs: { stdout: { path: null, sha256: "0".repeat(64), bytes: 0 }, stderr: { path: null, sha256: "0".repeat(64), bytes: 0 } },
  };
}

async function scenarioFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `flow-runtime-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const isolation = createQualificationIsolation({
    worktreeRoot: worktree,
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    herdrSession: `herdr:${name}-fixture`,
    runId: `run:${name}-fixture`,
  });
  return {
    isolation,
    rawRoot: join(root, "raw"),
    entrypoints: {
      node: { path: process.execPath },
      launcher: { path: join(worktree, "config/flow/src/cli.mjs") },
      host: { path: join(worktree, "config/flow/src/owner-process.mjs") },
    },
  };
}

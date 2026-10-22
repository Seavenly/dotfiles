import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createQualificationIsolation,
  resolvePinnedEntrypoints,
} from "../src/host-recovery-qualification.mjs";
import {
  adaptProjectionReaderProbeResult,
  adaptSuspendedAdmissionProbeResult,
  runSuspendedAdmissionProbe,
} from "../src/host-recovery-reader-integration.mjs";

const execFileAsync = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "../../..");

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `flow-issue-46-reader-integration-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolation = createQualificationIsolation({
    worktreeRoot: WORKTREE,
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    qualificationWorkspace: join(root, "workspace"),
    herdrSession: `herdr:issue-46-${label}-integration`,
    runId: `run:issue-46-${label}-integration`,
  });
  const rawRoot = join(root, "raw");
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  return {
    root,
    rawRoot,
    isolation,
    entrypoints: resolvePinnedEntrypoints({ worktreeRoot: WORKTREE }),
  };
}

function command(kind) {
  return {
    id: `${kind}-fixture-command`,
    argv: ["node", `config/flow/scripts/${kind}.mjs`],
    command_kind: kind,
    launcher_ref: `config/flow/scripts/${kind}.mjs`,
    host_ref: "native/reader-probe",
    working_directory_ref: "worktree",
    started_at: "2026-09-17T10:00:00.000Z",
    finished_at: "2026-09-17T10:00:00.010Z",
    duration_ms: 10,
    exit_code: 0,
    signal: null,
    expected_exit_code: 0,
    expected_signal: null,
    timed_out: false,
    expected_timed_out: false,
    logs: {
      stdout: { path: null, sha256: "0".repeat(64), bytes: 0 },
      stderr: { path: null, sha256: "0".repeat(64), bytes: 0 },
    },
  };
}

function cleanup() {
  const identities = [
    "isolation/qualification-workspace",
    "isolation/state",
    "isolation/authority",
    "isolation/backup",
    "isolation/repository",
    "isolation/drovr-config",
  ];
  return {
    disposition: "complete",
    owned_resources: identities.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
    })),
    resource_dispositions: identities.map((identity_ref) => ({
      kind: "isolated_root",
      identity_ref,
      disposition: "removed",
      proof: "absent_after_cleanup",
    })),
    unresolved_obligations: [],
    completed_at: "2026-09-17T10:00:00.020Z",
  };
}

test("projection adapter preserves public and native-provider provenance", async (t) => {
  const value = await fixture(t, "projection");
  const support = {
    schema: "flow.host-recovery-reader-support/v1",
    result: { disposition: "pass", reason: null },
    started_at: "2026-09-17T10:00:00.000Z",
    finished_at: "2026-09-17T10:00:00.010Z",
    proof: {
      query: { observed: true, watermark: "sha256:" + "1".repeat(64), provenance: "public_process" },
      watch: { observed: true, watermark: "sha256:" + "2".repeat(64), provenance: "public_process" },
      rebuild: {
        without_mutation_lock: true,
        mutation_lock_acquired: false,
        mutation_lock_observed: true,
        external_mutation_lock: { held: false, provenance: "native_provider" },
        owner_mutation_lock: {
          held: true,
          inspect_runtime_open: true,
          provenance: "native_provider",
        },
        inspect_runtime_lock_observations: [
          { available: true, held: true, provenance: "native_provider" },
          { available: true, held: true, provenance: "native_provider" },
        ],
        owner_lock_release_observed: true,
        owner_authority_watermark: {
          before: "sha256:" + "3".repeat(64),
          after: "sha256:" + "3".repeat(64),
          stable: true,
          delta: null,
        },
        projection_identity_stable: true,
        rebuild_count: 1,
        provenance: "native_provider",
      },
      views: {
        count: 2,
        view_ids: ["flow:run-index", "flow:review-inbox"],
        provenance: "native_provider",
      },
      latency: {
        samples: [4, 6],
        history_entries: 2,
        provenance: "native_provider",
      },
    },
    seed: { provenance: "deterministic_supporting_check", history_entries: 2 },
    commands: [
      { command_kind: "start" },
      { command_kind: "query" },
      { command_kind: "watch" },
      { command_kind: "stop" },
    ],
  };
  const result = adaptProjectionReaderProbeResult({
    support,
    command: command("native_projection_reader_probe"),
    cleanup: cleanup(),
    isolation: value.isolation,
    rawRoot: value.rawRoot,
  });

  assert.equal(result.schema, "flow.host-recovery-runtime-scenario/v1");
  assert.equal(result.execution_kind, "native_provider");
  assert.equal(result.result.disposition, "pass", JSON.stringify(result));
  assert.deepEqual(result.commands.map(({ command_kind }) => [command_kind]), [
    ["native_projection_reader_probe"],
  ]);
  assert.deepEqual(result.observations.map(({ kind }) => kind), [
    "query", "watch", "rebuild", "views", "latency",
  ]);
  assert.equal(result.observations[0].content.provenance, "public_process");
  assert.equal(result.observations[2].content.provenance, "native_provider");
  assert.equal(result.captures[0].provenance, "native_provider");
});

test("projection adapter rejects supporting-only rebuild proof", async (t) => {
  const value = await fixture(t, "projection-supporting-only");
  const support = {
    schema: "flow.host-recovery-reader-support/v1",
    result: { disposition: "pass", reason: null },
    started_at: "2026-09-17T10:00:00.000Z",
    finished_at: "2026-09-17T10:00:00.010Z",
    proof: {
      query: { observed: true, watermark: "sha256:" + "1".repeat(64), provenance: "public_process" },
      watch: { observed: true, watermark: "sha256:" + "2".repeat(64), provenance: "public_process" },
      rebuild: {
        without_mutation_lock: true,
        external_mutation_lock: { held: false, provenance: "deterministic_supporting_check" },
        provenance: "deterministic_supporting_check",
      },
      views: { count: 2, provenance: "deterministic_supporting_check" },
      latency: { samples: [4, 6], provenance: "deterministic_supporting_check" },
    },
  };
  const result = adaptProjectionReaderProbeResult({
    support,
    command: command("native_projection_reader_probe"),
    cleanup: cleanup(),
    isolation: value.isolation,
    rawRoot: value.rawRoot,
  });

  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "projection_rebuild_provenance_invalid");
});

test("suspended adapter retains deterministic boot and issue-47 deferral", async (t) => {
  const value = await fixture(t, "suspended");
  const support = {
    schema: "flow.host-recovery-reader-support/v1",
    result: { disposition: "pass", reason: null },
    started_at: "2026-09-17T10:00:00.000Z",
    finished_at: "2026-09-17T10:00:00.010Z",
    observations: {
      suspended: {
        observed: true,
        prior_boot_id: "old",
        current_boot_id: "new",
        simulated_boot: true,
        provenance: "production_runtime",
      },
      admission: {
        explicit: true,
        command_type: "reboot_admission",
        action_identity: "action:fixture",
        simulated_boot: true,
        provenance: "production_runtime",
      },
      reboot: {
        actual_reboot: false,
        deferred: true,
        simulated: true,
        boot_identity_observed: true,
        deferred_issue: "47",
        provenance: "deterministic_supporting_check",
      },
    },
  };
  const result = adaptSuspendedAdmissionProbeResult({
    support,
    command: command("native_suspended_admission_check"),
    cleanup: cleanup(),
    isolation: value.isolation,
    rawRoot: value.rawRoot,
  });

  assert.equal(result.result.disposition, "pass", JSON.stringify(result));
  assert.equal(result.observations.find(({ kind }) => kind === "reboot")
    .content.actual_reboot, false);
  assert.equal(result.observations.find(({ kind }) => kind === "reboot")
    .content.deferred_issue, "47");
  assert.equal(result.captures[0].provenance, "native_provider");
  assert.deepEqual(result.assertions.map(({ id, disposition }) => [id, disposition]), [
    ["suspended_run_observation", "pass"],
    ["explicit_admission", "pass"],
    ["actual_reboot_deferred", "pass"],
  ]);
});

test("suspended native probe CLI returns a deterministic adapter envelope", async (t) => {
  const value = await fixture(t, "cli");
  const script = join(WORKTREE, "config/flow/scripts/run-host-recovery-reader-probe.mjs");
  const args = [
    script,
    "--probe", "suspended",
    "--worktree", WORKTREE,
    "--raw-root", value.rawRoot,
    "--xdg-state-home", value.isolation.xdg_state_home,
    "--authority-directory", value.isolation.authority_directory,
    "--socket", value.isolation.socket_path,
    "--endpoint", value.isolation.endpoint_path,
    "--backup-directory", value.isolation.backup_directory,
    "--repository-root", value.isolation.repository_root,
    "--drovr-config-directory", value.isolation.drovr_config_directory,
    "--qualification-workspace", value.isolation.qualification_workspace,
    "--herdr-session", value.isolation.herdr_session,
    "--run-id", value.isolation.run_id,
    "--timeout", "30000",
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: WORKTREE,
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.schema, "flow.host-recovery-reader-integration/v1");
  assert.equal(result.command_kind, "native_suspended_admission_check");
  assert.equal(result.result.disposition, "pass", JSON.stringify(result));
  assert.equal(result.provenance.actual_reboot, false);
  assert.equal(result.provenance.deferred_issue, "47");
  assert.equal(result.support.observations.reboot.actual_reboot, false);
});

test("suspended native probe rejects actual reboot requests before production work", async (t) => {
  const value = await fixture(t, "no-reboot");
  const result = await runSuspendedAdmissionProbe({
    entrypoints: value.entrypoints,
    isolation: value.isolation,
    rawRoot: value.rawRoot,
    actualReboot: true,
  });
  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "actual_reboot_deferred");
  assert.equal(result.support.observations.reboot, null);
});

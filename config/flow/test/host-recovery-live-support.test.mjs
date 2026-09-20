import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createQualificationIsolation,
  resolvePinnedEntrypoints,
} from "../src/host-recovery-qualification.mjs";
import {
  createIssue46LiveSupport,
  runProductionBackupRestoreProbe,
  runDrovrRegistryLockProbe,
} from "../src/host-recovery-live-support.mjs";

const execFileAsync = promisify(execFile);
const WORKTREE = new URL("../../..", import.meta.url).pathname.replace(/\/$/u, "");

async function isolationFixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `flow-issue-46-live-support-${label}-`));
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
    qualificationWorkspace: join(root, "qualification"),
    herdrSession: `herdr:issue-46-${label}-support`,
    runId: `run:issue-46-${label}-support`,
  });
  return {
    root,
    rawRoot: join(root, "raw"),
    isolation,
    entrypoints: resolvePinnedEntrypoints({ worktreeRoot: WORKTREE }),
  };
}

test("live support runs the pinned public process and retains inspectable output", async (t) => {
  const fixture = await isolationFixture(t, "public");
  const support = createIssue46LiveSupport({
    entrypoints: fixture.entrypoints,
    isolation: fixture.isolation,
    rawRoot: fixture.rawRoot,
  });

  const result = await support.commandRunner({
    scenario_id: "projection_rebuild_readers",
    kind: "status",
    args: ["status", "--json"],
    timeoutMs: 30_000,
  });

  assert.equal(result.command.command_kind, "status");
  assert.equal(result.command.exit_code, 0);
  assert.equal(result.command.signal, null);
  assert.equal(result.command.timed_out, false);
  assert.equal(typeof result.output.schema, "string");
  assert.ok(result.command.logs.stdout.path);
  assert.ok((await readFile(join(fixture.rawRoot, "logs", result.command.logs.stdout.path), "utf8")).length > 0);
  assert.equal(support.commandObservations().length, 1);
});

test("production backup support performs disposable loss, restore, six-domain reconciliation, and admission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-46-live-support-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const drovr = join(root, "drovr");
  await cp(join(WORKTREE, "config/drovr"), drovr, { recursive: true });
  await mkdir(repository, { recursive: true, mode: 0o700 });
  await execFileAsync("git", ["-C", repository, "init", "--quiet"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "README.md"), "issue-46\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "--quiet", "-m", "issue-46"]);

  let statusEnvironment;
  const result = await runProductionBackupRestoreProbe({
    authorityDirectory: join(root, "authority"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: repository,
    drovrConfigDirectory: drovr,
    rawRoot: join(root, "raw"),
    env: {
      HOME: join(root, "home"),
      XDG_STATE_HOME: join(root, "state"),
      DROVR_AMBIENT_SHOULD_NOT_LEAK: "caller-value",
      PATH: "/qualification/bin",
    },
    drovrStatusRunner: ({ env }) => {
      statusEnvironment = env;
      return JSON.parse(execFileSync(process.execPath, [
        join(WORKTREE, "tools/drovr/src/cli.mjs"), "status",
      ], {
        cwd: join(WORKTREE, "tools/drovr/src"),
        env,
        encoding: "utf8",
      }));
    },
  });

  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.proof.backup.production_backup, true);
  assert.equal(result.proof.loss.destructive_loss, true);
  assert.equal(result.proof.loss.disposable_only, true);
  assert.equal(result.proof.restore.restored, true);
  assert.equal(result.proof.reconciliation.domains_reconciled, 6);
  assert.equal(result.proof.reconciliation.complete, true);
  assert.equal(result.proof.reconciliation.all_domains_non_empty, true);
  assert.deepEqual(result.proof.reconciliation.non_empty_domains, {
    database_streams: true,
    artifact_state: true,
    git_state: true,
    filesystem_state: true,
    external_effects: true,
    drovr_obligations: true,
  });
  assert.equal(result.proof.admission.retained_result_admitted, true);
  const statusSandbox = join(drovr, "status-sandbox");
  assert.equal(statusEnvironment.HOME, join(statusSandbox, "drovr-status-home"));
  assert.equal(statusEnvironment.XDG_STATE_HOME, join(statusSandbox, "drovr-status-state"));
  assert.equal(statusEnvironment.PATH, "/qualification/bin");
  assert.equal(Object.hasOwn(statusEnvironment, "DROVR_AMBIENT_SHOULD_NOT_LEAK"), false);
  assert.equal(result.cleanup.disposition, "complete");
  assert.deepEqual(result.cleanup.unresolved_obligations, []);
  assert.deepEqual(
    result.cleanup.owned_resources.map(({ identity_ref }) => identity_ref),
    [join(root, "authority"), statusSandbox],
  );
  assert.deepEqual(
    result.cleanup.resource_dispositions.map(({ identity_ref, proof }) => [identity_ref, proof]),
    [[join(root, "authority"), "absent_after_cleanup"], [statusSandbox, "absent_after_cleanup"]],
  );
  await assert.rejects(lstat(join(root, "authority")), { code: "ENOENT" });
  await assert.rejects(lstat(statusSandbox), { code: "ENOENT" });
  await assert.rejects(lstat(join(statusSandbox, "drovr-status-state")), { code: "ENOENT" });
});

test("Drovr lock support kills one isolated native owner and proves age/force are not takeover authority", async (t) => {
  const fixture = await isolationFixture(t, "lock");
  const result = await runDrovrRegistryLockProbe({
    nodePath: fixture.entrypoints.node.path,
    registryModulePath: join(WORKTREE, "tools/drovr/src/registry.mjs"),
    registryDirectory: join(fixture.isolation.drovr_config_directory, "registry"),
    rawRoot: fixture.rawRoot,
    resourceKey: "issue-46-live-lock",
  });

  assert.equal(result.owner_killed, true);
  assert.equal(result.owner_status, "absent");
  assert.equal(result.process_absence.status, "absent");
  assert.equal(typeof result.process_absence.process_identity, "string");
  assert.equal(result.negative_age.rejected, true);
  assert.equal(result.negative_age.mutated, false);
  assert.equal(result.negative_force.rejected, true);
  assert.equal(result.negative_force.mutated, false);
  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.cleanup.disposition, "complete");
  assert.equal(result.cleanup.unresolved_obligations.length, 0);
});

test("live support refuses a caller-shaped native delegate observation", async (t) => {
  const fixture = await isolationFixture(t, "delegate");
  const support = createIssue46LiveSupport({
    entrypoints: fixture.entrypoints,
    isolation: fixture.isolation,
    rawRoot: fixture.rawRoot,
  });

  const observation = await support.observeNativeDelegate({
    drovrBinary: join(fixture.root, "missing-drovr"),
  });
  assert.equal(observation.status, "blocked");
  assert.equal(observation.invocation_count, 0);
  assert.equal(observation.dispatch_attempted, false);
  assert.match(observation.reason, /native delegate dispatch/u);
});

test("support requires explicit isolated roots and rejects a worktree overlap", async () => {
  assert.throws(
    () => createIssue46LiveSupport({
      entrypoints: resolvePinnedEntrypoints({ worktreeRoot: WORKTREE }),
      isolation: {
        worktree_root: WORKTREE,
        xdg_state_home: join(WORKTREE, "state"),
      },
      rawRoot: join(WORKTREE, "raw"),
    }),
    /absolute|overlap|isolation/u,
  );
});

test("lock probe uses only an isolated registry directory", async (t) => {
  const fixture = await isolationFixture(t, "lock-path");
  const result = await runDrovrRegistryLockProbe({
    nodePath: fixture.entrypoints.node.path,
    registryModulePath: join(WORKTREE, "tools/drovr/src/registry.mjs"),
    registryDirectory: join(fixture.isolation.drovr_config_directory, "registry"),
    rawRoot: fixture.rawRoot,
    resourceKey: "issue-46-live-lock-path",
  });
  assert.equal(result.registry_directory, join(fixture.isolation.drovr_config_directory, "registry"));
  assert.equal(result.cleanup.resource_dispositions.every(({ proof }) => proof === "absent_after_cleanup"), true);
});

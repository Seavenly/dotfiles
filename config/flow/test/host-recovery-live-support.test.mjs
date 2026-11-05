import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("selected backup uses its release in both real public runtimes and the retained seed composition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-selected-backup-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  // This disposable source fixture observes the existing constructors without
  // replacing their production backup, restore, composition, or public gate.
  for (const path of ["config/flow", "tools/flow", "tools/drovr"]) {
    await cp(join(WORKTREE, path), join(candidate, path), { recursive: true });
  }
  const observationsPath = join(root, "constructor-observations.jsonl");
  const request = {
    schema: "flow.feature-preparation-request/v1",
    mode: "test",
    dark_opt_in: {
      schema: "flow.dark-opt-in/v1",
      release_id: "flow-release-1.1-dark-test/v1",
      purpose: "sacrificial_qualification",
    },
  };
  const observe = (kind, expression) =>
    `__observeBackupConstructor(${JSON.stringify(observationsPath)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, config: env.FLOW_CONFIG_DIRECTORY ?? null, root: env.FLOW_QUALIFICATION_REPOSITORY_ROOT ?? null, gate: ${expression} }) + "\\n");`;
  for (const [path, marker, observation] of [
    ["runtime.mjs", "    return runtime;", observe("public_runtime", `runtime.prepare(${JSON.stringify(request)}).code`)],
    ["production-composition.mjs", "  const repositories = new Map();", observe("production_composition", "null")],
  ]) {
    const modulePath = join(candidate, "config/flow/src", path);
    const source = await readFile(modulePath, "utf8");
    assert.equal(source.split(marker).length, 2, `unique passive observation seam: ${path}`);
    await writeFile(modulePath,
      `import { appendFileSync as __observeBackupConstructor } from "node:fs";\n` +
      source.replace(marker, `${observation}\n${marker}`));
  }
  const repository = join(root, "repository");
  const drovr = join(root, "drovr");
  await cp(join(WORKTREE, "config/drovr"), drovr, { recursive: true });
  await mkdir(repository, { recursive: true });
  for (const args of [
    ["init", "--quiet"], ["config", "user.email", "flow@example.test"],
    ["config", "user.name", "Flow Test"],
  ]) await execFileAsync("git", ["-C", repository, ...args]);
  await writeFile(join(repository, "README.md"), "selected backup\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "--quiet", "-m", "fixture"]);
  const config = join(candidate, "config/flow/releases/1.1-dark-test");
  const { runProductionBackupRestoreProbe: probe } = await import(
    pathToFileURL(join(candidate, "config/flow/src/host-recovery-live-support.mjs")));
  const statusEnvironments = [];
  const result = await probe({
    authorityDirectory: join(root, "authority"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: repository,
    drovrConfigDirectory: drovr,
    rawRoot: join(root, "raw"),
    env: { FLOW_CONFIG_DIRECTORY: config, FLOW_QUALIFICATION_REPOSITORY_ROOT: candidate },
    drovrStatusRunner: ({ env }) => {
      statusEnvironments.push(env);
      return JSON.parse(execFileSync(process.execPath, [
        join(candidate, "tools/drovr/src/cli.mjs"), "status",
      ], { env, encoding: "utf8" }));
    },
  });
  assert.equal(result.status, "pass", JSON.stringify(result));
  const observations = (await readFile(observationsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const publicRuntimes = observations.filter(({ kind }) => kind === "public_runtime");
  assert.equal(publicRuntimes.length, 2, "initial and restored production runtimes observed");
  // The selected manifest accepts its opt-in; this backup-only runtime has no
  // feature test check adapter, so its real public gate then refuses the route.
  assert.deepEqual(publicRuntimes.map(({ gate }) => gate), ["route_unavailable", "route_unavailable"]);
  assert.equal(observations.filter(({ kind }) => kind === "production_composition").length, 3,
    "initial, retained seed, and restored compositions observed");
  for (const observation of observations) {
    assert.equal(observation.config, config);
    assert.equal(observation.root, candidate);
  }
  assert.equal(result.proof.reconciliation.domains_reconciled, 6);
  assert.equal(result.proof.reconciliation.all_domains_non_empty, true);
  for (const environment of statusEnvironments) {
    assert.equal(Object.hasOwn(environment, "FLOW_CONFIG_DIRECTORY"), false);
    assert.equal(Object.hasOwn(environment, "FLOW_QUALIFICATION_REPOSITORY_ROOT"), false);
    assert.equal(environment.HOME, join(drovr, "status-sandbox/drovr-status-home"));
  }
});

test("selected backup rejects unsafe selection before creating or destroying probe state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-selected-backup-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = join(root, "authority");
  await mkdir(authority);
  await writeFile(join(authority, "retained.txt"), "retain exact bytes\n");
  const link = join(root, "config-link");
  await symlink(join(WORKTREE, "config/flow/releases/1.1-dark-test"), link);
  // The contained fixture permits a symlink ancestor to be tested without
  // adding any path to the real source tree.
  const candidate = join(root, "candidate");
  await mkdir(join(candidate, "config/flow/releases"), { recursive: true });
  await cp(join(WORKTREE, "config/flow/src"), join(candidate, "config/flow/src"), { recursive: true });
  await cp(join(WORKTREE, "tools/flow"), join(candidate, "tools/flow"), { recursive: true });
  await cp(join(WORKTREE, "tools/drovr"), join(candidate, "tools/drovr"), { recursive: true });
  await cp(join(WORKTREE, "config/flow/node_modules"), join(candidate, "config/flow/node_modules"), { recursive: true });
  await cp(join(WORKTREE, "config/flow/schemas"), join(candidate, "config/flow/schemas"), { recursive: true });
  await symlink(join(WORKTREE, "config/flow/releases/1.1-dark-test"),
    join(candidate, "config/flow/releases/linked"));
  const { runProductionBackupRestoreProbe: probe } = await import(
    pathToFileURL(join(candidate, "config/flow/src/host-recovery-live-support.mjs")));
  for (const [config, qualificationRoot, pattern] of [
    ["config/flow", candidate, /absolute/u],
    [join(root, "escape"), candidate, /below the pinned/u],
    [link, candidate, /below the pinned/u],
    [join(candidate, "config/flow/releases/linked"), candidate, /symlink/u],
    [join(candidate, "config/flow/releases/missing"), candidate, /unavailable/u],
    [join(candidate, "config/flow"), root, /pinned worktree repository root/u],
    [join(candidate, "config/flow"), undefined, /pinned worktree repository root/u],
  ]) {
    let statusCalls = 0;
    await assert.rejects(probe({
      authorityDirectory: authority,
      backupDirectory: join(root, "backup"),
      repositoryRoot: join(root, "repository"),
      drovrConfigDirectory: join(root, "drovr"),
      rawRoot: join(root, "raw"),
      env: { FLOW_CONFIG_DIRECTORY: config, FLOW_QUALIFICATION_REPOSITORY_ROOT: qualificationRoot },
      drovrStatusRunner: () => { statusCalls++; },
    }), pattern);
    assert.equal(statusCalls, 0);
    assert.equal(await readFile(join(authority, "retained.txt"), "utf8"), "retain exact bytes\n");
    for (const path of ["backup", "repository", "drovr", "raw"]) {
      await assert.rejects(lstat(join(root, path)), { code: "ENOENT" });
    }
  }
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

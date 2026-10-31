import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  TUICR_SCENARIO_ID,
  runTuicrReviewAfterProducerExit,
  runTuicrCli,
} from "../src/host-recovery-tuicr-scenario.mjs";
import {
  createProductionProducerAdapter,
  resolvePinnedTuicrPath,
} from "../src/host-recovery-tuicr-live-integration.mjs";
import { isolatedQualificationEnvironment } from "../src/host-recovery-qualification.mjs";
import { readProcessStartIdentity, stopFlowOwner } from "../src/owner-process.mjs";
import { copyQualifiedRuntimeFixture } from "../test-support/qualified-release-fixture.mjs";
import { initializePublicReviewRepository } from "../test-support/public-review-seed.mjs";
import { deriveOwnerRuntimeBinding } from "../src/owner-runtime-binding.mjs";
import { isGovernedReleasePath } from "../../../tools/flow/src/release-content-contract.mjs";

const WORKTREE = resolve(import.meta.dirname, "../..");

test("tuicr qualification fails closed when no isolated noninteractive session is supplied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-tuicr-scenario-"));
  const isolation = isolatedPaths(root);
  await Promise.all([
    mkdir(isolation.xdg_state_home, { recursive: true }),
    mkdir(isolation.authority_directory, { recursive: true }),
    mkdir(isolation.backup_directory, { recursive: true }),
    mkdir(isolation.repository_root, { recursive: true }),
    mkdir(isolation.drovr_config_directory, { recursive: true }),
    mkdir(isolation.qualification_workspace, { recursive: true }),
  ]);
  const rawRoot = join(root, "raw");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const result = await runTuicrReviewAfterProducerExit({
    worktreeRoot: WORKTREE,
    isolation,
    rawRoot,
    entrypoints: pinnedEntrypoints(),
    tuicrPath: resolvePinnedTuicrPath(),
    // No session path is an honest prerequisite failure: tuicr 0.19 exposes
    // list/comments/add, but no noninteractive local-session creation route.
  });

  assert.equal(result.schema, "flow.host-recovery-tuicr-scenario/v1");
  assert.equal(result.scenario_id, TUICR_SCENARIO_ID);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "tuicr_noninteractive_seed_required");
  assert.equal(result.observations.length, 0);
  assert.equal(result.cleanup.disposition, "not_started");
});

test("public owner shutdown preserves isolation when captured retirement is unproven", {
  skip: process.platform !== "linux",
}, async (t) => {
  for (const mode of ["invalid", "missing", "valid"]) {
    await t.test(mode, async () => {
      const root = await mkdtemp(join(tmpdir(), "flow-tuicr-owner-gate-"));
      const rawRoot = process.env.FLOW_OWNER_SHUTDOWN_TEST_RECEIPT_DIRECTORY
        ? join(process.env.FLOW_OWNER_SHUTDOWN_TEST_RECEIPT_DIRECTORY, `owner-shutdown-${mode}`)
        : join(root, "raw");
      await mkdir(rawRoot, { recursive: true, mode: 0o700 });
      let originalEndpoint;
      let retirementProven = false;
      let primaryError;
      try {
        const worktree = await copyQualifiedRuntimeFixture({
          sourceRoot: resolve(import.meta.dirname, "../../.."),
          destination: join(root, "worktree"),
        });
        const isolation = { ...isolatedPaths(root), worktree_root: worktree };
        const roots = [isolation.xdg_state_home, isolation.authority_directory,
          isolation.backup_directory, isolation.repository_root,
          isolation.drovr_config_directory, isolation.qualification_workspace];
        for (const path of roots) await mkdir(path, { recursive: true, mode: 0o700 });
        await cp(join(worktree, "config/drovr"), isolation.drovr_config_directory, {
          recursive: true, force: true,
        });
        await writeFile(join(isolation.repository_root, "tuicr-seed.txt"), "before\n");
        await initializePublicReviewRepository(isolation.repository_root);
        // This prerequisite placeholder is never consumed by Tuicr. The
        // controlled public query fails before any consumer command executes.
        const sessionPath = join(isolation.qualification_workspace, "prerequisite.json");
        await writeFile(sessionPath, "{}\n");
        const fixtureDirectory = join(worktree, ".owner-shutdown-fixture");
        await mkdir(fixtureDirectory, { mode: 0o700 });
        const runtimeModule = join(fixtureDirectory, "runtime.mjs");
        await writeFile(runtimeModule, `
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createFlowRuntime as realRuntime } from "../config/flow/test-support/public-owner-runtime.mjs";
export async function createFlowRuntime(options) {
  const runtime = await realRuntime(options);
  return { ...runtime, query(request) {
    if (request?.schema !== "flow.query/v1" || request.query !== "review_inbox") {
      return runtime.query(request);
    }
    return faultInbox(request);
  } };
  async function faultInbox(request) {
    const endpointBytes = await readFile(options.env.FLOW_OWNER_ENDPOINT_PATH, "utf8");
    await writeFile(${JSON.stringify(join(rawRoot, "endpoint-before.json"))}, endpointBytes);
    const reply = { schema: "controlled.invalid-inbox/v1", mode: ${JSON.stringify(mode)} };
    if (${JSON.stringify(mode)} === "invalid") {
      await writeFile(options.env.FLOW_OWNER_ENDPOINT_PATH, "{invalid endpoint\\n");
    } else if (${JSON.stringify(mode)} === "missing") {
      await unlink(options.env.FLOW_OWNER_ENDPOINT_PATH);
    }
    const endpointAfter = await readFile(options.env.FLOW_OWNER_ENDPOINT_PATH, "utf8")
      .catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    await writeFile(${JSON.stringify(join(rawRoot, "query.json"))}, JSON.stringify({ request, reply, endpointAfter }));
    return reply;
  }
}
`, { mode: 0o600 });
        const gitRead = (directory, ...args) => execFileSync("/usr/bin/git", [
          "-c", "diff.autoRefreshIndex=false", "-C", directory, ...args,
        ], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8" });
        const repositoryStatus = gitRead(isolation.repository_root, "status", "--porcelain");
        const repositoryHead = gitRead(isolation.repository_root, "rev-parse", "HEAD").trim();
        assert.equal(repositoryStatus, "", "producer requires a clean disposable subject");
        const content = JSON.parse(await readFile(join(worktree, "config/flow/evidence/release-content.v1.json"), "utf8"));
        const governedPaths = gitRead(worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
          .split("\0").filter(isGovernedReleasePath).sort();
        assert.deepEqual(governedPaths, content.files.map(({ path }) => path).sort());
        for (const file of content.files) {
          assert.equal(createHash("sha256").update(await readFile(join(worktree, file.path))).digest("hex"), file.sha256);
        }
        assert.equal(isGovernedReleasePath(".owner-shutdown-fixture/runtime.mjs"), false);
        const ownerBinding = deriveOwnerRuntimeBinding({
          env: { ...isolatedQualificationEnvironment(isolation, process.env), FLOW_OWNER_RUNTIME_MODULE: runtimeModule },
          ownerScript: join(worktree, "config/flow/src/owner-process.mjs"),
        });
        await writeFile(join(rawRoot, "fixture-preparation.json"), `${JSON.stringify({
          controlled_fixture: true, native_qualification: "NOT_RUN",
          repositoryStatus, repositoryHead, governedPaths, ownerBinding,
          fixture_module_mode: (await lstat(runtimeModule)).mode,
          fixture_directory_mode: (await lstat(fixtureDirectory)).mode,
          session_scope: "regular isolated prerequisite placeholder; no Tuicr consumer invocation",
        }, null, 2)}\n`);
        const producerAdapter = createProductionProducerAdapter({
          isolation, rawRoot, worktreeRoot: worktree,
          env: isolatedQualificationEnvironment(isolation, process.env),
          timeoutMs: 30_000,
        });
        const producer = {
          ...producerAdapter,
          async seed(input) {
            const seeded = await producerAdapter.seed(input);
            for (const path of roots) await writeFile(join(path, "owner-root-marker"), "owned root\n");
            return seeded;
          },
        };
        const result = await runTuicrReviewAfterProducerExit({
          isolation, rawRoot, producer, sessionPath, ownerRuntimeModule: runtimeModule,
          tuicrPath: resolvePinnedTuicrPath(), cleanupIsolation: true,
        });
        await writeFile(join(rawRoot, "scenario-result.json"), `${JSON.stringify(result, null, 2)}\n`);
        assert.equal(result.error?.code, "review_inbox_invalid", JSON.stringify(result.error));
        originalEndpoint = JSON.parse(await readFile(join(rawRoot, "endpoint-before.json"), "utf8"));
        const currentIdentity = readProcessStartIdentity(originalEndpoint.pid);
        const markers = await Promise.all(roots.map(async (path) => ({
          path, present: await readFile(join(path, "owner-root-marker"), "utf8")
            .then((value) => value === "owned root\n", (error) => error.code === "ENOENT" ? false : Promise.reject(error)),
        })));
        await writeFile(join(rawRoot, "result-before-teardown.json"), `${JSON.stringify({
          mode, originalEndpoint, currentIdentity, result, markers,
          producer: producer.lastReceipt(),
        }, null, 2)}\n`);
        assert.equal(result.error.code, "review_inbox_invalid", "the real public query must reach the shutdown path");
        assert.equal(producer.lastReceipt().producer_exited, true);
        assert.equal(result.commands.length, 0, "no Tuicr command is launched in this controlled failure");
        if (mode === "valid") {
          assert.equal(currentIdentity, null, "valid shutdown must retire the captured owner before cleanup");
          assert.equal(result.cleanup.disposition, "complete");
          assert.ok(markers.every(({ present }) => present === false));
        } else {
          assert.equal(currentIdentity, originalEndpoint.process_start_identity,
            "the refusal fixture must still have its actual captured owner");
          assert.equal(result.cleanup.disposition, "blocked", "unproven owner retirement must withhold root cleanup");
          assert.ok(markers.every(({ present }) => present === true));
          assert.equal(result.cleanup.owned_resources.length, roots.length);
          assert.ok(result.cleanup.resource_dispositions.every(({ disposition }) => disposition === "cleanup_blocked"));
          const shutdown = result.cleanup.unresolved_obligations.find(({ code }) => code === "owner_retirement_unproven");
          assert.deepEqual(shutdown.owner, {
            pid: originalEndpoint.pid, process_start_identity: originalEndpoint.process_start_identity,
          });
          assert.equal(shutdown.stop.state, mode === "invalid" ? "invalid" : "stopped");
          assert.equal(shutdown.absence.status, "present");
        }
      } catch (error) {
        primaryError = error;
        await writeFile(join(rawRoot, "primary-failure.json"), `${JSON.stringify({
          name: error.name, code: error.code, message: error.message, stack: error.stack,
        }, null, 2)}\n`);
        throw error;
      } finally {
        if (originalEndpoint === undefined) {
          try { originalEndpoint = JSON.parse(await readFile(join(rawRoot, "endpoint-before.json"), "utf8")); }
          catch (error) {
            await writeFile(join(rawRoot, "fixture-retirement.json"), `${JSON.stringify({
              root, captured_owner_absent: null, proof: "owner_identity_not_observed",
              primary_failure: primaryError?.message, observation_error: error.message,
              workspace_preserved: true,
            }, null, 2)}\n`);
            if (primaryError === undefined) throw error;
          }
        }
        if (originalEndpoint !== undefined) {
          if (readProcessStartIdentity(originalEndpoint.pid) === originalEndpoint.process_start_identity) {
            // Restore only the private endpoint for this exact still-owned
            // process. Never remove its isolation while retirement is unknown.
            await mkdir(originalEndpoint.authority_directory, { recursive: true, mode: 0o700 });
            await writeFile(originalEndpoint.endpoint_path, `${JSON.stringify(originalEndpoint)}\n`, { mode: 0o600 });
            const stopped = await stopFlowOwner({
              authorityDirectory: originalEndpoint.authority_directory,
              endpointPath: originalEndpoint.endpoint_path, socketPath: originalEndpoint.socket_path,
              pid: originalEndpoint.pid, processStartIdentity: originalEndpoint.process_start_identity,
              force: true, waitMs: 1_000, pollMs: 10,
            });
            assert.equal(stopped.state, "stopped", `fixture shutdown refused; preserving ${root}`);
          }
          const deadline = Date.now() + 5_000;
          while (readProcessStartIdentity(originalEndpoint.pid) === originalEndpoint.process_start_identity && Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
          }
          try { process.kill(originalEndpoint.pid, 0); }
          catch (error) { if (error.code === "ESRCH") retirementProven = true; else throw error; }
          assert.equal(retirementProven, true, `fixture process absence unproven; preserving ${root}`);
          await writeFile(join(rawRoot, "fixture-retirement.json"), `${JSON.stringify({
            pid: originalEndpoint.pid, process_start_identity: originalEndpoint.process_start_identity,
            captured_owner_absent: true, proof: "kill_0_esrch", root,
          }, null, 2)}\n`);
          await rm(root, { recursive: true, force: true });
        }
      }
    });
  }
});

test("tuicr CLI timeout waits for real child retirement and retains terminal facts", {
  skip: process.platform !== "linux",
}, async (t) => {
  for (const mode of ["immediate", "graceful", "resistant"]) {
    await t.test(mode, async () => {
      const root = await mkdtemp(join(tmpdir(), "flow-tuicr-retirement-"));
      const executable = join(root, "tuicr.mjs");
      const ready = join(root, "ready.json");
      const term = join(root, "term.json");
      const release = join(root, "release");
      await writeFile(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
const root = process.argv[3];
const stat = readFileSync("/proc/self/stat", "utf8");
const identity = { pid: process.pid, start_ticks: stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] };
process.on("SIGTERM", () => {
  writeFileSync(root + "/term.json", JSON.stringify(identity));
  if (mode === "graceful") process.exit(0);
});
writeFileSync(root + "/ready.json", JSON.stringify(identity));
if (mode === "immediate") { console.log("actual output"); process.exit(7); }
setInterval(() => { if (existsSync(root + "/release")) process.exit(0); }, 10);
`, { mode: 0o700 });
      let identity;
      try {
        const result = await runTuicrCli({
          tuicrPath: executable,
          args: [mode, root],
          cwd: root,
          env: { HOME: root },
          logDirectory: join(root, "logs"),
          commandKind: `retirement_${mode}`,
          timeoutMs: 5_000,
        });
        identity = JSON.parse(await readFile(ready, "utf8"));
        assert.equal(await sameProcess(identity), false, "helper returned before its child retired");
        assert.equal(result.command.timed_out, mode !== "immediate");
        assert.equal(result.command.exit_code, mode === "resistant" ? null : mode === "immediate" ? 7 : 0);
        assert.equal(result.command.signal, mode === "resistant" ? "SIGKILL" : null);
        if (mode !== "immediate") {
          assert.deepEqual(JSON.parse(await readFile(term, "utf8")), identity);
        } else {
          assert.equal(result.stdout, "actual output\n");
        }
      } finally {
        // On a regression, the exclusively owned fixture exits itself before
        // cleanup. Unknown identity or an unretired process preserves its
        // workspace for diagnosis.
        await writeFile(release, "release\n");
        if (identity === undefined) {
          try {
            identity = JSON.parse(await readFile(ready, "utf8"));
          } catch (error) {
            assert.fail(`owned fixture identity is unknown (${error.code ?? error.message}); preserving ${root}`);
          }
        }
        assert.ok(identity !== null && Number.isSafeInteger(identity.pid) && identity.pid > 0
          && typeof identity.start_ticks === "string" && /^\d+$/.test(identity.start_ticks),
        `owned fixture identity is unknown; preserving ${root}`);
        const deadline = Date.now() + 5_000;
        while (await sameProcess(identity) && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        assert.equal(await sameProcess(identity), false,
          `owned fixture remains live; preserving ${root}`);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("tuicr CLI reports an actual spawn error without a terminal command claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-tuicr-spawn-error-"));
  try {
    const executable = join(root, "tuicr");
    await writeFile(executable, "#!/nonexistent-flow-test-interpreter\n", { mode: 0o700 });
    await assert.rejects(runTuicrCli({
      tuicrPath: executable,
      args: ["review", "list"],
      cwd: root,
      env: { HOME: root },
      logDirectory: join(root, "logs"),
      commandKind: "spawn_error",
      timeoutMs: 2_000,
    }), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function sameProcess(identity) {
  const value = await readFile(`/proc/${identity.pid}/stat`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return value !== null && value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] === identity.start_ticks;
}

function isolatedPaths(root) {
  return {
    worktree_root: WORKTREE,
    xdg_state_home: join(root, "state"),
    authority_directory: join(root, "authority"),
    socket_path: join(root, "authority", "owner.sock"),
    endpoint_path: join(root, "authority", "owner.json"),
    backup_directory: join(root, "backup"),
    repository_root: join(root, "repository"),
    drovr_config_directory: join(root, "drovr"),
    qualification_workspace: join(root, "workspace"),
    runtime_directory: null,
    herdr_session: "issue-46-tuicr-test-session",
    run_id: "run:issue-46-tuicr-scenario-test",
  };
}

function pinnedEntrypoints() {
  return {
    node: { path: resolve(process.execPath) },
    launcher: { path: resolve(WORKTREE, "config/flow/src/cli.mjs") },
    host: { path: resolve(WORKTREE, "config/flow/src/owner-process.mjs") },
  };
}

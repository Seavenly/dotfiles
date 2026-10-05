import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  TUICR_SCENARIO_ID,
  runTuicrReviewAfterProducerExit,
  runTuicrCli,
} from "../src/host-recovery-tuicr-scenario.mjs";
import {
  resolvePinnedTuicrPath,
} from "../src/host-recovery-tuicr-live-integration.mjs";

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

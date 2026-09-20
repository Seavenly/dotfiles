import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  TUICR_SCENARIO_ID,
  runTuicrReviewAfterProducerExit,
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

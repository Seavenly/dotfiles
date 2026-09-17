import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createQualificationIsolation,
  resolvePinnedEntrypoints,
} from "../src/host-recovery-qualification.mjs";
import {
  createIssue46LiveSupport,
} from "../src/host-recovery-live-support.mjs";
import {
  runProjectionRebuildReaderSupport,
  runSuspendedRunAdmissionSupport,
} from "../src/host-recovery-reader-support.mjs";

const WORKTREE = resolve(import.meta.dirname, "../../..");

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `flow-issue-46-reader-${label}-`));
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
    herdrSession: `herdr:issue-46-${label}-reader`,
    runId: `run:issue-46-${label}-reader`,
  });
  await mkdir(join(root, "raw"), { recursive: true, mode: 0o700 });
  return {
    root,
    isolation,
    rawRoot: join(root, "raw"),
    entrypoints: resolvePinnedEntrypoints({ worktreeRoot: WORKTREE }),
  };
}

test("projection reader support uses public query/watch and a read-only rebuild", async (t) => {
  const fixtureValue = await fixture(t, "projection");
  const live = createIssue46LiveSupport({
    entrypoints: fixtureValue.entrypoints,
    isolation: fixtureValue.isolation,
    rawRoot: fixtureValue.rawRoot,
    timeoutMs: 30_000,
  });

  const result = await runProjectionRebuildReaderSupport({
    isolation: fixtureValue.isolation,
    rawRoot: fixtureValue.rawRoot,
    publicCommandRunner: live.commandRunner,
    timeoutMs: 30_000,
  });

  assert.equal(result.result.disposition, "pass", JSON.stringify(result));
  assert.equal(result.execution_kind, "live_public_process");
  assert.equal(result.provenance.query, "public_process");
  assert.equal(result.provenance.watch, "public_process");
  assert.equal(result.provenance.rebuild, "deterministic_supporting_check");
  assert.equal(result.seed.provenance, "deterministic_supporting_check");
  assert.deepEqual(result.commands.map(({ command_kind }) => command_kind), [
    "start", "query", "watch", "stop",
  ]);
  assert.equal(result.proof.query.observed, true);
  assert.equal(result.proof.watch.observed, true);
  assert.equal(result.proof.rebuild.without_mutation_lock, true);
  assert.equal(result.proof.rebuild.mutation_lock_acquired, false);
  assert.equal(result.proof.rebuild.projection_identity_stable, true);
  assert.ok(result.proof.views.count >= 2);
  assert.ok(result.proof.latency.samples.length >= 2);
  assert.ok(result.proof.latency.history_entries >= 2);
  assert.equal(result.cleanup.disposition, "complete");
  assert.deepEqual(result.cleanup.unresolved_obligations, []);

  assert.equal(result.outputs.query.proof.query.provenance, "public_process");
  assert.equal(result.outputs.query.proof.rebuild.provenance,
    "deterministic_supporting_check");
  assert.equal(result.outputs.watch.proof.watch.provenance, "public_process");
});

test("projection reader support fails closed without a public command runner", async (t) => {
  const fixtureValue = await fixture(t, "projection-blocked");
  await assert.rejects(
    () => runProjectionRebuildReaderSupport({
      isolation: fixtureValue.isolation,
      rawRoot: fixtureValue.rawRoot,
    }),
    (error) => error?.code === "public_command_runner_required",
  );
});

test("suspended admission support uses production runtime with a simulated boot only", async (t) => {
  const fixtureValue = await fixture(t, "suspended");
  const result = await runSuspendedRunAdmissionSupport({
    isolation: fixtureValue.isolation,
    rawRoot: fixtureValue.rawRoot,
    timeoutMs: 30_000,
  });

  assert.equal(result.result.disposition, "pass", JSON.stringify(result));
  assert.equal(result.execution_kind, "deterministic_supporting_check");
  assert.equal(result.provenance.suspended, "production_runtime");
  assert.equal(result.provenance.admission, "production_runtime");
  assert.equal(result.provenance.reboot, "deterministic_supporting_check");
  assert.equal(result.observations.suspended.observed, true);
  assert.equal(result.observations.suspended.simulated_boot, true);
  assert.equal(result.observations.suspended.prior_boot_id ===
    result.observations.suspended.current_boot_id, false);
  assert.equal(result.observations.admission.explicit, true);
  assert.equal(result.observations.admission.command_type, "reboot_admission");
  assert.equal(result.observations.reboot.actual_reboot, false);
  assert.equal(result.observations.reboot.deferred, true);
  assert.equal(result.observations.reboot.deferred_issue, "47");
  assert.equal(result.outputs.command.proof.admission.explicit, true);
  assert.equal(result.outputs.query.proof.suspended.observed, true);
  assert.equal(result.outputs.watch.proof.reboot.actual_reboot, false);
  assert.equal(result.cleanup.disposition, "complete");
});

test("suspended admission support refuses an actual reboot request", async (t) => {
  const fixtureValue = await fixture(t, "suspended-deferred");
  const result = await runSuspendedRunAdmissionSupport({
    isolation: fixtureValue.isolation,
    rawRoot: fixtureValue.rawRoot,
    actualReboot: true,
  });

  assert.equal(result.result.disposition, "blocked");
  assert.equal(result.result.reason, "actual_reboot_deferred");
  assert.equal(result.outputs.query, null);
  assert.equal(result.cleanup.disposition, "complete");
});

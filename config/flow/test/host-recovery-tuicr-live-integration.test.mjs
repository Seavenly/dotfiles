import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createQualificationIsolation,
} from "../src/host-recovery-qualification.mjs";
import {
  runTuicrLiveIntegration,
} from "../src/host-recovery-tuicr-live-integration.mjs";

const WORKTREE = resolve(import.meta.dirname, "../../..");

test("issue-46 tuicr runs after a real producer exits and survives owner rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-tuicr-live-integration-"));
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
    herdrSession: "issue-46-tuicr-live-integration",
    runId: "run:issue-46-tuicr-live-integration",
  });
  const rawRoot = join(root, "raw");
  try {
    const result = await runTuicrLiveIntegration({
      isolation,
      rawRoot,
      cleanupIsolation: true,
      producerTimeoutMs: 120_000,
      tuiTimeoutMs: 30_000,
    });

    assert.equal(result.schema, "flow.host-recovery-tuicr-live-integration/v1");
    assert.equal(result.status, "pass", JSON.stringify(result.error ?? result.scenario));
    assert.equal(result.scenario.status, "pass");
    assert.equal(result.tui_seed.consumer, "tuicr");
    assert.equal(result.tui_seed.comment_count >= 1, true);
    assert.equal(result.tui_seed.command.command_kind, "tuicr_tui_seed");
    assert.equal(result.tui_seed.command.exit_code, 0);
    assert.equal(result.tui_seed.command.signal, null);
    assert.match(result.tui_seed.command.argv[0], /\/script$/u);
    assert.match(result.tui_seed.command.argv[2], /tuicr.*--working-tree/u);

    assert.equal(result.producer.producer_exited, true);
    assert.equal(result.producer.process_absence.status, "absent");
    assert.equal(result.producer.process_absence.method, "waited_child_and_kill_0_esrch");
    assert.equal(result.producer.command.command_kind, "production_review_seed");
    assert.equal(result.producer.command.exit_code, 0);
    assert.equal(result.scenario.consumer.consumer, "tuicr");
    assert.equal(result.scenario.consumer.started, true);
    assert.equal(result.scenario.consumer.list.found, true);
    assert.equal(Array.isArray(result.scenario.consumer.comments), true);
    assert.equal(result.scenario.consumer.session_path, result.tui_seed.session_path);
    assert.equal(result.operator_inputs.consumer.session_id, result.tui_seed.session_id);
    assert.equal(result.operator_inputs.consumer.list.review_id, result.producer.review_id);
    assert.equal(result.operator_inputs.consumer.comments.review_id, result.producer.review_id);
    assert.equal(result.operator_inputs.review.approval, "approved");

    const observations = new Map(
      result.scenario.observations.map((observation) => [observation.kind, observation.content]),
    );
    assert.equal(observations.get("producer_exit").producer_exited, true);
    assert.equal(observations.get("producer_exit").process_absence.status, "absent");
    assert.equal(observations.get("disposition").flowruntime_disposition, "approved");
    assert.equal(observations.get("disposition").approval, "approved");
    assert.equal(observations.get("stale_action").rejected, true);
    assert.equal(observations.get("stale_action").mutated, false);
    assert.equal(observations.get("rebuild").identity_stable, true);
    assert.equal(observations.get("rebuild").without_mutation_lock, true);

    const commandKinds = result.scenario.commands.map(({ command_kind }) => command_kind);
    assert.deepEqual(commandKinds, ["tuicr_list", "tuicr_comments"]);
    assert.ok(result.scenario.captures.some(({ kind }) => kind === "tuicr-list"));
    assert.ok(result.scenario.captures.some(({ kind }) => kind === "tuicr-comments"));
    assert.equal(result.cleanup.disposition, "complete");
    assert.deepEqual(result.cleanup.unresolved_obligations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

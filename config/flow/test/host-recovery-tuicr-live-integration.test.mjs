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
import {
  adaptTuicrLiveProbeResult,
} from "../scripts/run-host-recovery-qualification.mjs";

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
    assert.equal(result.operator_inputs.review.disposition_receipt.accepted, true);
    assert.equal(result.operator_inputs.review.approval_command_receipt.accepted, true);
    assert.equal(result.operator_inputs.assertions.flowruntime_disposition_and_approval, true);

    const observations = new Map(
      result.scenario.observations.map((observation) => [observation.kind, observation.content]),
    );
    assert.equal(observations.get("producer_exit").producer_exited, true);
    assert.equal(observations.get("producer_exit").process_absence.status, "absent");
    assert.equal(observations.get("disposition").flowruntime_disposition, "accept");
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

test("tuicr qualification adapter blocks false and missing scenario assertions", async () => {
  for (const assertions of [
    undefined,
    {
      producer_exit_before_review: true,
      flowruntime_disposition_and_approval: false,
      stale_action_rejection: true,
      projection_rebuild_identity: true,
    },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "flow-tuicr-adapter-assertions-"));
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
      herdrSession: "issue-46-tuicr-adapter-assertions",
      runId: "run:issue-46-tuicr-adapter-assertions",
    });
    const rawRoot = join(root, "raw");
    const command = {
      id: "native-tuicr-assertion-gate",
      command_kind: "native_tuicr_live_probe",
      started_at: "2026-09-20T17:00:00.000Z",
      finished_at: "2026-09-20T17:00:00.001Z",
      exit_code: 0,
      signal: null,
      timed_out: false,
      logs: { stdout: { sha256: "a".repeat(64) }, stderr: { sha256: "b".repeat(64) } },
    };
    const output = {
      schema: "flow.host-recovery-tuicr-live-integration/v1",
      scenario_id: "tuicr_review_after_producer_exit",
      status: "pass",
      scenario: {
        status: "pass",
        observations: ["producer_exit", "disposition", "stale_action", "rebuild"].map((kind) => ({
          kind,
          content: { observed: true },
        })),
        ...(assertions === undefined ? {} : { assertions }),
      },
      cleanup: { disposition: "complete", unresolved_obligations: [] },
    };
    const result = adaptTuicrLiveProbeResult({ output, command, rawRoot, isolation });
    assert.equal(result.result.disposition, "blocked");
    assert.equal(result.result.reason, "scenario_assertion_failed");
    const adaptedById = new Map(result.assertions.map((assertion) => [assertion.id, assertion.disposition]));
    if (assertions === undefined) {
      assert.equal([...adaptedById.values()].every((disposition) => disposition === "not_observed"), true);
    } else {
      assert.equal(adaptedById.get("flowruntime_disposition_and_approval"), "not_observed");
      assert.equal(adaptedById.get("producer_exit_before_review"), "pass");
    }
    await rm(root, { recursive: true, force: true });
  }
});

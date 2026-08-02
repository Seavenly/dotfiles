import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExternalRootAdapter } from "../../../config/agent-flow/src/external-progress.mjs";
import { readTuicrComments } from "../../../config/agent-flow/src/review-manifest.mjs";
import { CardBlockObservationAdapter } from "../src/card-block-observation-adapter.mjs";
import { createDrovrDelegatedAgentPort } from "../src/drovr-delegated-agent-port.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createGitHubTrackerProgressOperation } from "../src/github-tracker-progress.mjs";
import {
  createDurableRunAuthority,
  createInMemoryRunAuthority,
} from "../src/run-authority.mjs";
import { foldRun, projectRun, runWatermark } from "../src/run-projection.mjs";
import {
  confirmedLaunchRequest,
  dependencyCheckpointProposal,
  revisionBlockedCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";
import { forbiddenLifecycleCommands } from "../test-support/forbidden-lifecycle-commands.mjs";
import { withoutViewWatermarks } from "../test-support/projection-assertions.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";
import {
  getArtifactAuthority,
  getResourceHandoffAuthority,
  getWorkspaceAuthority,
} from "../src/work-authority.mjs";

test("query exposes complete watermarked operator views from run authority", () => {
  const runtime = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
  });
  const prepared = runtime.prepare(dependencyCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const projection = runtime.query({ run_id: launch.run_id });

  assert.deepEqual(Object.keys(projection.views), [
    "graph",
    "kanban",
    "operator",
    "timeline",
    "trust",
  ]);
  for (const view of Object.values(projection.views)) {
    assert.equal(view.run_id, launch.run_id);
    assert.equal(view.authority_watermark, projection.watermark);
  }

  assert.equal(projection.views.operator.phase, "active");
  assert.equal(projection.views.operator.admission, "admitted");
  assert.deepEqual(
    projection.views.operator.readiness.map(({ id, status }) => ({ id, status })),
    [
      { id: "confirm-plan", status: "pending" },
      { id: "confirm-scope", status: "waiting_checkpoint" },
    ],
  );
  assert.deepEqual(projection.views.operator.checkpoints, [
    {
      card_id: "confirm-plan",
      decision: null,
      status: "pending",
    },
    {
      card_id: "confirm-scope",
      decision: null,
      status: "waiting_checkpoint",
    },
  ]);
  assert.deepEqual(projection.views.operator.routes, {
    cards: [
      { card_id: "confirm-plan", route: null },
      { card_id: "confirm-scope", route: null },
    ],
    attempts: [],
  });
  assert.deepEqual(projection.views.operator.revision, {
    current: projection.current_revision,
    history: projection.revisions,
  });
  assert.deepEqual(projection.views.operator.attempts, []);
  assert.deepEqual(projection.views.operator.capability, {
    bindings: [],
    effective: [],
    envelopes: [],
    grants: [],
  });
  assert.deepEqual(projection.views.operator.effects, []);
  assert.deepEqual(projection.views.operator.resources, {
    claims: [],
    dispositions: [],
  });
  assert.deepEqual(projection.views.operator.handoffs, {
    bindings: [],
    published: [],
  });
  assert.deepEqual(
    projection.views.operator.legal_actions,
    projection.legal_actions,
  );

  assert.deepEqual(projection.views.graph.edges, [
    { from: "confirm-scope", to: "confirm-plan" },
  ]);
  assert.deepEqual(
    projection.views.graph.nodes.map(({ id, status }) => ({ id, status })),
    projection.cards.map(({ id, status }) => ({ id, status })),
  );
  assert.deepEqual(projection.views.kanban.columns, [
    { status: "pending", card_ids: ["confirm-plan"] },
    { status: "waiting_checkpoint", card_ids: ["confirm-scope"] },
  ]);
  assert.deepEqual(projection.views.timeline.entries, [
    { sequence: 1, kind: "lifecycle", subject_id: launch.run_id },
  ]);
  assert.deepEqual(projection.views.trust.authority_boundaries, {
    adapters: "mechanism_only",
    delegated_runtime: "mechanism_only",
    effect_coordinator: "mechanism_only",
    flow_lifecycle: "RunAuthority",
    projections: "non_authoritative",
    work_domains: "bounded_subject_authority_only",
  });
  assert.deepEqual(projection.views.trust.routes, projection.views.operator.routes);
  assert.equal(Object.isFrozen(projection.views.operator), true);
});

test("projection construction rejects a substituted same-length event stream", () => {
  const prepared = createFlowRuntime({
    runAuthority: createInMemoryRunAuthority(),
  }).prepare(dependencyCheckpointProposal());
  const runId = `run:${prepared.bundle_digest.slice("sha256:".length)}`;
  const launchEvent = {
    type: "run_launched",
    bundle_digest: prepared.bundle_digest,
    plan_fingerprint: prepared.plan_fingerprint,
    confirmation_digest: prepared.confirmation_digest,
    closed_fact_observation_digest: `sha256:${"e".repeat(64)}`,
    run_ownership: {
      schema: "flow.run-ownership/v1",
      scope: "top_level",
      parent_run_id: null,
    },
  };
  const authoritativeRun = {
    run_id: runId,
    prepared,
    events: [launchEvent],
  };
  const fold = foldRun(authoritativeRun);
  const substituted = [{ ...launchEvent, bundle_digest: `sha256:${"f".repeat(64)}` }];

  assert.throws(
    () => projectRun({
      authorityEventStreamDigest: runWatermark(authoritativeRun),
      fold,
      events: substituted,
    }),
    /events do not match the authoritative fold/,
  );
});

test("deleted views rebuild exactly from durable authority without lifecycle mutation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-projections-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "projection-owner-a"),
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        schema: "flow.registered-operation/v1",
        classification: "caller_idempotent",
        invoke: (intent) => operationReceipt(intent),
      },
    },
  });
  const revisionPrepared = firstRuntime.prepare(revisionBlockedCheckpointProposal());
  const revisionLaunch = firstRuntime.launch(
    confirmedLaunchRequest(revisionPrepared),
  );
  firstRuntime.command(firstRuntime.query({ run_id: revisionLaunch.run_id })
    .legal_actions.find(({ type }) => type === "capability_grant"));
  firstRuntime.command(firstRuntime.query({ run_id: revisionLaunch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  firstRuntime.command(firstRuntime.query({ run_id: revisionLaunch.run_id })
    .legal_actions.find(({ type, decision }) =>
      type === "revision_decision" && decision === "accept"));
  firstRuntime.command(firstRuntime.query({ run_id: revisionLaunch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));

  const operationPrepared = firstRuntime.prepare(registeredOperationProposal());
  const operationLaunch = firstRuntime.launch(
    confirmedLaunchRequest(operationPrepared),
  );
  firstRuntime.command(firstRuntime.query({ run_id: operationLaunch.run_id })
    .legal_actions.find(({ decision }) => decision === "approve"));
  await until(() => firstRuntime.query({ run_id: operationLaunch.run_id }).phase ===
    "succeeded");
  const beforeDisposal = [revisionLaunch.run_id, operationLaunch.run_id].map(
    (runId) => firstRuntime.query({ run_id: runId }),
  );
  const discardedCopies = structuredClone(beforeDisposal);
  discardedCopies.forEach((projection) => delete projection.views);
  firstAuthority.close();

  const replayedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "projection-owner-b"),
  });
  t.after(() => replayedAuthority.close());
  const replayedRuntime = createFlowRuntime({ runAuthority: replayedAuthority });
  const rebuilt = beforeDisposal.map(({ run_id: runId }) =>
    replayedRuntime.query({ run_id: runId }));

  rebuilt.forEach((projection, index) => {
    assert.deepEqual(withoutViewWatermarks(projection.views),
      withoutViewWatermarks(beforeDisposal[index].views));
    for (const view of Object.values(projection.views)) {
      assert.equal(view.authority_watermark, projection.watermark);
    }
    assert.equal(projection.views.operator.phase, "succeeded");
    assert.equal(projection.views.operator.admission, "released");
    assert.deepEqual(projection.views.operator.legal_actions, []);
    assert.notEqual(projection.watermark, beforeDisposal[index].watermark);
  });
  const revisedOperator = rebuilt[0].views.operator;
  assert.equal(revisedOperator.revision.history.length, 1);
  assert.ok(revisedOperator.routes.cards.some(({ route }) => route !== null));
  assert.notEqual(revisedOperator.capability.effective.length, 0);
  assert.notEqual(revisedOperator.resources.claims.length, 0);
  const operationOperator = rebuilt[1].views.operator;
  assert.equal(operationOperator.attempts.length, 1);
  assert.equal(operationOperator.effects.length, 1);
  assert.equal(operationOperator.routes.attempts.length, 1);
  assert.notEqual(operationOperator.resources.claims.length, 0);
  assert.deepEqual(replayedRuntime.query().admission, {
    active_runs: 0,
    declared_capacity: 4,
  });
});

test("observers and non-authoritative actors cannot advance run lifecycle", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-boundaries-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const runAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "boundary-owner"),
  });
  t.after(() => runAuthority.close());
  const runtime = createFlowRuntime({ runAuthority });
  const prepared = runtime.prepare(dependencyCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const before = runtime.query({ run_id: launch.run_id });
  const watcher = runtime.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  const observed = (await watcher.next()).value;

  assert.deepEqual(observed, before);
  assert.deepEqual(runtime.query({ run_id: launch.run_id }), before);
  assert.throws(() => {
    observed.views.operator.phase = "succeeded";
  }, TypeError);

  const forbiddenCommands = forbiddenLifecycleCommands(
    launch.run_id,
    before.watermark,
  );
  const workAuthorities = [
    getWorkspaceAuthority({ runAuthority }),
    getArtifactAuthority({ runAuthority }),
  ];
  for (const authority of workAuthorities) {
    for (const command of forbiddenCommands) {
      const rejection = authority.command(command);
      assert.equal(rejection.schema, "work.rejection/v1", authority.schema);
      assert.deepEqual(
        runtime.query({ run_id: launch.run_id }),
        before,
        `${authority.schema} ${command.type}`,
      );
    }
  }
  const handoffRejection = getResourceHandoffAuthority({ runAuthority }).query({
    contract: "flow.command/v1",
    subject_id: launch.run_id,
  });
  assert.equal(handoffRejection.schema, "work.rejection/v1");

  await assert.rejects(
    runAuthority.invokeEffect({
      schema: "flow.effect-intent/v1",
      run_id: launch.run_id,
      effect_id: "effect:invented",
      idempotency_key: "invented",
    }, {
      invoke() {
        assert.fail("unrecorded EffectCoordinator request reached an Adapter");
      },
    }),
    (error) => error.code === "unrecorded_effect_intent",
  );
  assert.deepEqual(runtime.query({ run_id: launch.run_id }), before);

  const drovr = createDrovrDelegatedAgentPort();
  const tracker = createGitHubTrackerProgressOperation({
    driver: {
      async listComments() {
        assert.fail("invalid tracker input reached its driver");
      },
      async createComment() {
        assert.fail("invalid tracker input reached its driver");
      },
      async updateComment() {
        assert.fail("invalid tracker input reached its driver");
      },
    },
  });
  const forge = new ExternalRootAdapter();
  for (const command of forbiddenCommands) {
    const drovrProjection = await drovr.observe(command);
    assert.equal(drovrProjection.status, "blocked");
    assert.throws(() => CardBlockObservationAdapter.observe(command));
    await assert.rejects(tracker.observe(command), TypeError);
    await assert.rejects(forge.upsertProgress(command), TypeError);
    await assert.rejects(readTuicrComments(command), TypeError);
    assert.deepEqual(runtime.query({ run_id: launch.run_id }), before,
      `mechanism interfaces cannot apply ${command.type}`);
  }
  await watcher.return();
});

async function until(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("projection did not reach the expected state");
}

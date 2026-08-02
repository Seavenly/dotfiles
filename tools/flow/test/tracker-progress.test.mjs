import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createGitHubTrackerProgressOperation,
  TRACKER_PROGRESS_CONTRACT,
  TRACKER_PROGRESS_MARKER,
} from "../src/github-tracker-progress.mjs";
import { observeCardBlock } from
  "../src/card-block-observation-adapter.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { confirmedLaunchRequest } from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";

test("a confirmed top-level run creates and updates one authority-bound GitHub progress comment", async (t) => {
  const fixture = await trackerRuntime(t);
  const prepared = fixture.runtime.prepare(trackerProgressProposal([
    progressCard("publish-start", 1, "Implementation started", 0, 2),
    progressCard("publish-finish", 2, "Implementation verified", 2, 2),
  ]));
  const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));

  let projection = fixture.runtime.query({ run_id: launch.run_id });
  assert.equal(projection.tracker_progress.status, "ready");
  assert.equal(projection.tracker_progress.authority_watermark, projection.watermark);
  assert.deepEqual(
    projection.tracker_progress.legal_next_actions,
    projection.legal_actions,
  );
  assert.equal(projection.legal_actions.length, 1);

  fixture.runtime.command(projection.tracker_progress.legal_next_actions[0]);
  await until(() => fixture.driver.comments.length === 1);
  await until(() => fixture.runtime.query({ run_id: launch.run_id })
    .tracker_progress.sequence === 2);
  projection = fixture.runtime.query({ run_id: launch.run_id });
  fixture.runtime.command(projection.tracker_progress.legal_next_actions[0]);
  await until(() => fixture.runtime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  projection = fixture.runtime.query({ run_id: launch.run_id });
  assert.equal(fixture.driver.comments.length, 1);
  assert.equal(fixture.driver.createCount, 1);
  assert.equal(fixture.driver.updateCount, 1);
  assert.match(fixture.driver.comments[0].body, new RegExp(TRACKER_PROGRESS_MARKER));
  assert.match(fixture.driver.comments[0].body, /Implementation verified/);
  assert.match(fixture.driver.comments[0].body, /Authority watermark: sha256:/);
  assert.equal(projection.tracker_progress.status, "projected");
  assert.equal(projection.tracker_progress.projected_watermark,
    projection.effects.find(({ card_id: cardId }) =>
      cardId === projection.tracker_progress.operation_card_id)
      .receipt.provider_receipt.authority_watermark);
  assert.deepEqual(projection.tracker_progress.legal_next_actions, []);
});

test("child runs and tracker-gated graphs are rejected before mutation", async (t) => {
  const fixture = await trackerRuntime(t, {
    runOwnership: {
      schema: "flow.run-ownership/v1",
      scope: "child",
      parent_run_id: "run:parent",
    },
  });
  const child = fixture.runtime.prepare(trackerProgressProposal([
    progressCard("publish", 1, "Child progress", 0, 1),
  ]));
  const childLaunch = fixture.runtime.launch(confirmedLaunchRequest(child));
  assert.equal(childLaunch.code, "tracker_mutation_not_owned");

  const gated = trackerProgressProposal([
    progressCard("publish", 1, "Progress", 0, 1),
    checkpointCard("accept-from-tracker", ["publish"]),
  ]);
  gated.requested_authority.commands.push("checkpoint_decision");
  gated.explicit_facts.validator_contracts.push(
    "flow.validator/checkpoint-decision/v1",
  );
  gated.explicit_facts.limits.max_cards = 2;
  assert.throws(
    () => fixture.runtime.prepare(gated),
    /tracker progress cannot schedule downstream work/,
  );
  assert.equal(fixture.driver.createCount, 0);
  assert.equal(fixture.driver.updateCount, 0);
});

test("tracker-scoped mutation fencing prevents concurrent first-write duplicates", async (t) => {
  const fixture = await trackerRuntime(t, { listDelayMs: 20 });
  const prepared = ["First owner", "Second owner"].map((summary) =>
    fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, summary, 0, 1),
    ])));
  const launches = prepared.map((bundle) =>
    fixture.runtime.launch(confirmedLaunchRequest(bundle)));
  const actions = launches.map(({ run_id: runId }) =>
    fixture.runtime.query({ run_id: runId })
      .tracker_progress.legal_next_actions[0]);

  actions.forEach((action) => fixture.runtime.command(action));
  await until(() => launches.every(({ run_id: runId }) =>
    fixture.runtime.query({ run_id: runId }).effects[0]?.invocation_started));
  await until(() => fixture.driver.comments.length === 1);

  assert.equal(fixture.driver.createCount, 1);
  assert.equal(fixture.driver.comments.length, 1);
  assert.equal(launches.filter(({ run_id: runId }) =>
    fixture.runtime.query({ run_id: runId }).phase === "succeeded").length, 1);
});

test("tracker observations cannot admit, grant, decide, or advance a run", async (t) => {
  const fixture = await trackerRuntime(t);
  const prepared = fixture.runtime.prepare(trackerProgressProposal([
    progressCard("publish", 1, "Authority remains local", 0, 1),
  ]));
  const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));
  const before = fixture.runtime.query({ run_id: launch.run_id });
  fixture.driver.comments.push({ id: "ambient", body: "Provider says accepted" });

  for (const type of [
    "tracker_observation",
    "capability_grant",
    "checkpoint_decision",
    "reboot_admission",
  ]) {
    const result = fixture.runtime.command({
      schema: "flow.command/v1",
      type,
      run_id: launch.run_id,
      expected_watermark: before.watermark,
    });
    assert.equal(result.accepted, undefined, type);
  }
  assert.deepEqual(fixture.runtime.query({ run_id: launch.run_id }), before);
});

test("receipt loss adopts the exact marker-bound update without reposting", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const driver = new FakeGitHubDriver({ loseFirstReceipt: true });
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createTrackerRuntime(firstAuthority, driver);
  const prepared = firstRuntime.prepare(trackerProgressProposal([
    progressCard("publish", 1, "Ready for review", 1, 1),
  ]));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstRuntime.command(firstRuntime.query({ run_id: launch.run_id })
    .tracker_progress.legal_next_actions[0]);
  await until(() => driver.comments.length === 1);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createTrackerRuntime(recoveredAuthority, driver);
  await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
    "succeeded");

  const projection = recoveredRuntime.query({ run_id: launch.run_id });
  assert.equal(driver.createCount, 1);
  assert.equal(driver.updateCount, 0);
  assert.equal(projection.tracker_progress.status, "projected");
  assert.equal(projection.effects[0].last_observation.presence, "present");
});

test("duplicate or foreign marker ownership fails closed without tracker mutation", async (t) => {
  const fixture = await trackerRuntime(t, {
    comments: [{
      id: "foreign",
      body: `${TRACKER_PROGRESS_MARKER} owner=run:${"f".repeat(64)} -->\nForeign`,
    }],
  });
  const prepared = fixture.runtime.prepare(trackerProgressProposal([
    progressCard("publish", 1, "Owned progress", 0, 1),
  ]));
  const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));
  const beforeProviderChange = fixture.runtime.query({ run_id: launch.run_id });
  fixture.driver.comments[0].body += "\nProvider-only status: accepted";
  assert.deepEqual(
    fixture.runtime.query({ run_id: launch.run_id }),
    beforeProviderChange,
  );
  fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
    .tracker_progress.legal_next_actions[0]);
  await until(() => fixture.runtime.query({ run_id: launch.run_id })
    .effects[0]?.invocation_started === true);

  const projection = fixture.runtime.query({ run_id: launch.run_id });
  assert.equal(projection.tracker_progress.status, "unresolved");
  assert.equal(fixture.driver.createCount, 0);
  assert.equal(fixture.driver.updateCount, 0);
  assert.equal(fixture.driver.comments.length, 1);
});

test("duplicate progress markers remain unresolved and are never consolidated implicitly", async (t) => {
  const comments = ["one", "two"].map((id) => ({
    id,
    body: `${TRACKER_PROGRESS_MARKER} owner=run:${"f".repeat(64)} -->\n${id}`,
  }));
  const fixture = await trackerRuntime(t, { comments });
  const prepared = fixture.runtime.prepare(trackerProgressProposal([
    progressCard("publish", 1, "Owned progress", 0, 1),
  ]));
  const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));
  fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
    .tracker_progress.legal_next_actions[0]);
  await until(() => fixture.runtime.query({ run_id: launch.run_id })
    .effects[0]?.invocation_started === true);

  assert.equal(fixture.driver.comments.length, 2);
  assert.equal(fixture.driver.createCount, 0);
  assert.equal(fixture.driver.updateCount, 0);
  assert.equal(fixture.runtime.query({ run_id: launch.run_id })
    .tracker_progress.status, "unresolved");
});

test("tracker projection follows revision-added cards and ignores superseded cards", async (t) => {
  const fixture = await trackerRuntime(t);
  const proposal = trackerProgressProposal([
    progressCard("publish-original", 1, "Original progress", 0, 1),
  ]);
  const block = {
    schema: "flow.card-block/v1",
    id: "publish-original:revision",
    type: "plan_revision_required",
    trigger: {
      schema: "flow.revision-trigger/v1",
      type: "plan_revision_required",
      code: "progress_revision_required",
    },
    required_capabilities: [],
    revision_template_ids: ["replace-progress"],
  };
  proposal.requested_authority.commands.push("revision_decision");
  proposal.explicit_facts.operation_contracts.push(
    "flow.adapter/card-block-observation/v1",
  );
  proposal.explicit_facts.validator_contracts.push(
    "flow.validator/card-block-observation/v1",
  );
  proposal.explicit_facts.block_observations.push(observeCardBlock({
    card_id: "publish-original",
    block,
  }));
  Object.assign(proposal.explicit_facts.limits, {
    max_cards: 2,
    max_revisions: 1,
    max_cards_per_revision: 1,
  });
  proposal.revision_templates = [{
    schema: "flow.plan-revision-template/v1",
    id: "replace-progress",
    trigger: structuredClone(block.trigger),
    limits: { max_applications: 1 },
    changes: {
      add_cards: [progressCard(
        "publish-revised",
        2,
        "Revised progress",
        0,
        1,
      )],
      add_edges: [],
      supersede_cards: ["publish-original"],
      capability_additions: [],
      resource_additions: [],
      limit_changes: { max_cards: 2 },
    },
  }];

  const prepared = fixture.runtime.prepare(proposal);
  const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));
  const blocked = fixture.runtime.query({ run_id: launch.run_id });
  assert.equal(blocked.tracker_progress.operation_card_id, "publish-original");
  assert.equal(blocked.tracker_progress.status, "blocked");

  fixture.runtime.command(blocked.legal_actions.find(({ type }) =>
    type === "revision_decision"));
  const revised = fixture.runtime.query({ run_id: launch.run_id });
  assert.equal(revised.tracker_progress.operation_card_id, "publish-revised");
  assert.equal(revised.tracker_progress.sequence, 2);
  assert.deepEqual(
    revised.tracker_progress.legal_next_actions.map(({ type }) => type),
    ["operation_execute"],
  );
});

function trackerProgressProposal(cards) {
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: { schema: "flow.run-plan/v1", cards },
    requested_authority: {
      commands: ["operation_execute"],
      capabilities: [],
      mutations: [TRACKER_PROGRESS_CONTRACT],
    },
    explicit_facts: {
      catalog_fingerprint: `sha256:${"1".repeat(64)}`,
      route_snapshot: {
        watermark: `sha256:${"2".repeat(64)}`,
        bindings: [{ adapter: "github", contract: TRACKER_PROGRESS_CONTRACT }],
      },
      capability_envelopes: [],
      operation_contracts: [TRACKER_PROGRESS_CONTRACT],
      validator_contracts: ["flow.validator/operation-receipt/v1"],
      block_observations: [],
      tracker_binding: {
        schema: "flow.tracker-binding/v1",
        flow: "feature",
        tracker: {
          system: "github",
          owner: "Seavenly",
          repository: "dotfiles",
          issue_number: 34,
        },
      },
      elapsed_seconds: 0,
      limits: {
        max_cards: cards.length,
        max_revisions: 0,
        max_cards_per_revision: 0,
        max_capabilities: 0,
        max_resources: 1,
        max_elapsed_seconds: 0,
      },
      resource_claims: [{
        kind: "tracker-progress",
        id: "github:Seavenly/dotfiles#34",
      }],
    },
  };
}

function progressCard(id, sequence, summary, completed, total, dependencies = []) {
  return {
    id,
    executor: {
      kind: "operation",
      contract: TRACKER_PROGRESS_CONTRACT,
      effect_classification: "reconcilable",
    },
    dependencies,
    inputs: {
      schema: "flow.tracker-progress-update/v1",
      sequence,
      phase: completed === total ? "complete" : "active",
      summary,
      completed,
      total,
    },
    outputs: ["tracker_progress_receipt"],
    success_criteria: ["tracker_progress:reconciled"],
    validators: ["flow.validator/operation-receipt/v1"],
    data_references: [],
    evidence_references: [],
    route: { adapter: "github" },
    limits: { max_attempts: 1 },
    resource_claims: [{
      kind: "tracker-progress",
      id: "github:Seavenly/dotfiles#34",
    }],
    recovery: "reconcilable",
  };
}

function checkpointCard(id, dependencies) {
  return {
    id,
    executor: {
      kind: "checkpoint",
      contract: "flow.checkpoint/confirmation/v1",
    },
    dependencies,
    inputs: { prompt: "Accept from tracker" },
    outputs: [],
    success_criteria: ["decision:approve"],
    validators: ["flow.validator/checkpoint-decision/v1"],
    data_references: [],
    evidence_references: [],
    route: null,
    limits: {},
    resource_claims: [],
    recovery: "human_decision",
  };
}

async function trackerRuntime(t, options = {}) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    ...(options.runOwnership === undefined ? {} : {
      runOwnershipAdapter: {
        observe: () => structuredClone(options.runOwnership),
      },
    }),
  });
  t.after(() => authority.close());
  const driver = new FakeGitHubDriver(options);
  return { authority, driver, runtime: createTrackerRuntime(authority, driver) };
}

function createTrackerRuntime(authority, driver) {
  return createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TRACKER_PROGRESS_CONTRACT]: createGitHubTrackerProgressOperation({
        driver,
      }),
    },
  });
}

class FakeGitHubDriver {
  constructor({ comments = [], listDelayMs = 0, loseFirstReceipt = false } = {}) {
    this.comments = structuredClone(comments);
    this.createCount = 0;
    this.updateCount = 0;
    this.loseFirstReceipt = loseFirstReceipt;
    this.listDelayMs = listDelayMs;
  }

  async listComments() {
    const snapshot = structuredClone(this.comments);
    if (this.listDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.listDelayMs));
    }
    return snapshot;
  }

  async createComment(_tracker, body) {
    this.createCount += 1;
    const comment = { id: `comment-${this.createCount}`, body };
    this.comments.push(comment);
    if (this.loseFirstReceipt) {
      this.loseFirstReceipt = false;
      throw new Error("response lost after GitHub accepted the comment");
    }
    return structuredClone(comment);
  }

  async updateComment(_tracker, commentId, body) {
    this.updateCount += 1;
    const comment = this.comments.find(({ id }) => id === commentId);
    comment.body = body;
    return structuredClone(comment);
  }
}

async function until(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      assert.fail("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

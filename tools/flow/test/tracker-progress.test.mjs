import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digest } from "../src/canonical.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import {
  createGitHubTrackerProgressOperation,
  GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
  TRACKER_PROGRESS_CONTRACT as GITHUB_EXPORTED_TRACKER_PROGRESS_CONTRACT,
  TRACKER_PROGRESS_MARKER,
  validateTrackerProgressBinding as validateGitHubTrackerProgressBinding,
  validateTrackerProgressCard as validateGitHubTrackerProgressCard,
} from "../src/github-tracker-progress.mjs";
import {
  createJiraTrackerProgressOperation,
} from "../src/jira-tracker-progress.mjs";
import { observeCardBlock } from
  "../src/card-block-observation-adapter.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { compileDynamicPlan } from "../src/plan-compiler.mjs";
import {
  createTrackerProgressRegistrationBundle,
  TRACKER_PROGRESS_CONTRACT,
} from "../src/tracker-progress.mjs";
import { confirmedLaunchRequest } from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";

const TRACKER_PROVIDERS = ["github", "jira"];

test("the GitHub module preserves its v14 contract export", () => {
  assert.equal(
    GITHUB_EXPORTED_TRACKER_PROGRESS_CONTRACT,
    GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
  );
  assert.notEqual(
    GITHUB_EXPORTED_TRACKER_PROGRESS_CONTRACT,
    TRACKER_PROGRESS_CONTRACT,
  );
});

test("the v14 GitHub registration idiom still validates compatibility plans", () => {
  const runtime = createFlowRuntime({
    registeredOperations: {
      [GITHUB_EXPORTED_TRACKER_PROGRESS_CONTRACT]:
        createGitHubTrackerProgressOperation({
          driver: new FakeTrackerDriver(),
        }),
    },
  });
  const proposal = trackerProgressProposal([
    progressCard(
      "publish",
      1,
      "Compatibility progress",
      0,
      1,
      [],
      "github",
      GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
    ),
  ], "github", GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT);

  assert.doesNotThrow(() => runtime.prepare(proposal));
});

test("the v14 GitHub validators retain their provider-bound behavior", () => {
  const githubProposal = trackerProgressProposal([
    progressCard("publish", 1, "GitHub progress", 0, 1),
  ]);
  const jiraProposal = trackerProgressProposal([
    progressCard("publish", 1, "Jira progress", 0, 1, [], "jira"),
  ], "jira");

  assert.doesNotThrow(() =>
    validateGitHubTrackerProgressBinding(githubProposal));
  assert.throws(
    () => validateGitHubTrackerProgressBinding(jiraProposal),
    /confirmed GitHub tracker binding/,
  );
  assert.doesNotThrow(() =>
    validateGitHubTrackerProgressCard(
      githubProposal.graph.cards[0],
      githubProposal,
    ));
  assert.throws(
    () => validateGitHubTrackerProgressCard(
      jiraProposal.graph.cards[0],
      jiraProposal,
    ),
    /confirmed provider route/,
  );
});

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} registers the versioned tracker progress Adapter contract`, () => {
    const operation = createTrackerOperation(provider, new FakeTrackerDriver());
    assert.equal(operation.classification, "reconcilable");
    assert.equal(operation.contract, TRACKER_PROGRESS_CONTRACT);
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} creates and updates one authority-bound progress comment`, async (t) => {
    const fixture = await trackerRuntime(t, provider);
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish-start", 1, "Implementation started", 0, 2),
      progressCard("publish-finish", 2, "Implementation verified", 2, 2),
    ], provider));
    const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));

    let projection = fixture.runtime.query({ run_id: launch.run_id });
    assert.equal(projection.tracker_progress.status, "ready");
    assert.equal(projection.tracker_progress.authority_watermark, projection.watermark);
    assert.deepEqual(
      projection.tracker_progress.legal_next_actions,
      projection.legal_actions,
    );
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
    assert.equal(projection.tracker_progress.tracker.system, provider);
    const projectedEffect = projection.effects.find(({ card_id: cardId }) =>
      cardId === projection.tracker_progress.operation_card_id);
    assert.equal(projection.tracker_progress.projected_watermark,
      projectedEffect.receipt.provider_receipt.authority_watermark);
    assert.equal(projectedEffect.receipt.provider_receipt.system, provider);
    assert.deepEqual(projection.tracker_progress.legal_next_actions, []);
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} rejects an update receipt for the wrong comment ID`, async (t) => {
    const fixture = await trackerRuntime(t, provider, {
      alterUpdateReceiptId: true,
    });
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish-start", 1, "Implementation started", 0, 2),
      progressCard("publish-finish", 2, "Implementation verified", 2, 2),
    ], provider));
    const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));

    fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.legal_next_actions[0]);
    await until(() => fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.sequence === 2);
    fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.legal_next_actions[0]);
    await until(() => fixture.driver.updateCount === 1);
    await until(() => {
      const projection = fixture.runtime.query({ run_id: launch.run_id });
      const receipt = projection.effects[1]?.receipt;
      return receipt !== null && receipt !== undefined ||
        projection.tracker_progress.status === "unresolved";
    });

    const projection = fixture.runtime.query({ run_id: launch.run_id });
    assert.equal(fixture.driver.updateCount, 1);
    assert.equal(projection.effects[1].receipt, null);
    assert.equal(projection.tracker_progress.status, "unresolved");
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} rejects an update receipt with a normalized body`, async (t) => {
    const fixture = await trackerRuntime(t, provider);
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish-start", 1, "Implementation started", 0, 2),
      progressCard("publish-finish", 2, "Implementation verified", 2, 2),
    ], provider));
    const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));

    fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.legal_next_actions[0]);
    await until(() => fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.sequence === 2);
    fixture.driver.alterWriteReceipt = true;
    fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.legal_next_actions[0]);
    await until(() => fixture.driver.updateCount === 1);
    await until(() => fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.status === "unresolved");

    const projection = fixture.runtime.query({ run_id: launch.run_id });
    assert.equal(projection.effects[1].receipt, null);
    assert.equal(projection.tracker_progress.status, "unresolved");
  });
}

test("one neutral tracker registration dispatches GitHub and Jira concurrently", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const githubDriver = new FakeTrackerDriver({ listDelayMs: 20 });
  const jiraDriver = new FakeTrackerDriver({ listDelayMs: 20 });
  const registeredOperations = createTrackerProgressRegistrationBundle({
    github: { driver: githubDriver },
    jira: { driver: jiraDriver },
  });
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations,
  });
  const launches = ["github", "jira"].map((provider) => {
    const prepared = runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, `${provider} progress`, 0, 1),
    ], provider));
    return runtime.launch(confirmedLaunchRequest(prepared));
  });

  launches.forEach(({ run_id: runId }) => {
    runtime.command(runtime.query({ run_id: runId })
      .tracker_progress.legal_next_actions[0]);
  });
  await until(() => launches.every(({ run_id: runId }) =>
    runtime.query({ run_id: runId }).phase === "succeeded"));

  assert.equal(githubDriver.createCount, 1);
  assert.equal(jiraDriver.createCount, 1);
  assert.equal(githubDriver.comments.length, 1);
  assert.equal(jiraDriver.comments.length, 1);
});

test("standard tracker registration includes the neutral and v14 contracts", () => {
  const bundle = createTrackerProgressRegistrationBundle({
    github: { driver: new FakeTrackerDriver() },
    jira: { driver: new FakeTrackerDriver() },
  });

  assert.deepEqual(Object.keys(bundle).sort(), [
    GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
    TRACKER_PROGRESS_CONTRACT,
  ].sort());
  assert.equal(bundle[TRACKER_PROGRESS_CONTRACT].contract,
    TRACKER_PROGRESS_CONTRACT);
  assert.equal(bundle[GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT].contract,
    GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT);
});

for (const [provider, crossedRoute] of [
  ["github", "jira"],
  ["jira", "github"],
]) {
  test(`${provider} preparation rejects a ${crossedRoute} provider route`, () => {
    const proposal = trackerProgressProposal([
      progressCard("publish", 1, "Bounded progress", 0, 1, [], provider),
    ], provider);
    proposal.graph.cards[0].route.adapter = crossedRoute;

    assert.throws(
      () => createTrackerCompilerRuntime().prepare(proposal),
      /confirmed provider route/,
    );
  });
}

test("Jira preparation rejects the GitHub v14 compatibility contract", () => {
  const proposal = trackerProgressProposal([
    progressCard(
      "publish",
      1,
      "Bounded progress",
      0,
      1,
      [],
      "jira",
      GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
    ),
  ], "jira", GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT);

  assert.throws(
    () => createTrackerCompilerRuntime().prepare(proposal),
    /confirmed provider route/,
  );
});

test("a single-provider Adapter rejects an intent for another provider", async () => {
  const operation = createJiraTrackerProgressOperation({
    driver: new FakeTrackerDriver(),
  });

  await assert.rejects(
    operation.invoke({
      classification: "reconcilable",
      effect_id: "effect:provider-mismatch",
      idempotency_key: "tracker:provider-mismatch",
      operation_contract: TRACKER_PROGRESS_CONTRACT,
      operation_input: {
        schema: "flow.tracker-progress-update/v1",
        sequence: 1,
        phase: "active",
        summary: "Bounded progress",
        completed: 0,
        total: 1,
      },
      run_id: "run:provider-mismatch",
      run_ownership: {
        schema: "flow.run-ownership/v1",
        scope: "top_level",
        parent_run_id: null,
      },
      source_authority_watermark: "sha256:provider-mismatch",
      tracker_binding: {
        schema: "flow.tracker-binding/v1",
        flow: "feature",
        tracker: {
          system: "github",
          owner: "Seavenly",
          repository: "dotfiles",
          issue_number: 35,
        },
      },
    }),
    /exact top-level run authority/,
  );
});

test("standard tracker registration coexists with v14 GitHub recovery", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const githubDriver = new FakeTrackerDriver({
    partitionCommentsByTracker: true,
  });
  const jiraDriver = new FakeTrackerDriver();
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const registeredOperations = createTrackerProgressRegistrationBundle({
    github: { driver: githubDriver },
    jira: { driver: jiraDriver },
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations,
  });

  const newLaunches = [
    ["github", {
      system: "github",
      owner: "Seavenly",
      repository: "dotfiles",
      issue_number: 35,
    }],
    ["jira", {
      system: "jira",
      project: "FLOW",
      issue_number: 35,
    }],
  ].map(([provider, tracker]) => firstRuntime.launch(confirmedLaunchRequest(
    firstRuntime.prepare(trackerProgressProposal([
      progressCard(`${provider}-publish`, 1, `${provider} progress`, 0, 1,
        [], provider),
    ], provider, TRACKER_PROGRESS_CONTRACT, tracker)),
  )));
  newLaunches.forEach(({ run_id: runId }) => {
    firstRuntime.command(firstRuntime.query({ run_id: runId })
      .tracker_progress.legal_next_actions[0]);
  });
  await until(() => newLaunches.every(({ run_id: runId }) =>
    firstRuntime.query({ run_id: runId }).phase === "succeeded"));

  githubDriver.loseFirstReceipt = true;
  const legacyLaunch = firstRuntime.launch(confirmedLaunchRequest(
    firstRuntime.prepare(trackerProgressProposal([
      progressCard(
        "publish-legacy",
        1,
        "Ready for recovery",
        1,
        1,
        [],
        "github",
        GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT,
      ),
    ], "github", GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT, {
      system: "github",
      owner: "Seavenly",
      repository: "dotfiles",
      issue_number: 34,
    })),
  ));
  firstRuntime.command(firstRuntime.query({ run_id: legacyLaunch.run_id })
    .tracker_progress.legal_next_actions[0]);
  await until(() => githubDriver.comments.length === 2);
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createFlowRuntime({
    runAuthority: recoveredAuthority,
    registeredOperations: createTrackerProgressRegistrationBundle({
      github: { driver: githubDriver },
      jira: { driver: jiraDriver },
    }),
  });
  await until(() => recoveredRuntime.query({ run_id: legacyLaunch.run_id })
    .phase === "succeeded");

  const legacyProjection = recoveredRuntime.query({
    run_id: legacyLaunch.run_id,
  });
  assert.equal(legacyProjection.effects[0].operation_contract,
    GITHUB_TRACKER_PROGRESS_COMPATIBILITY_CONTRACT);
  assert.equal(githubDriver.createCount, 2);
  assert.equal(jiraDriver.createCount, 1);
  assert.equal(legacyProjection.tracker_progress.status, "projected");
});

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} child runs and tracker-gated graphs are rejected before mutation`, async (t) => {
    const fixture = await trackerRuntime(t, provider, {
      runOwnership: {
        schema: "flow.run-ownership/v1",
        scope: "child",
        parent_run_id: "run:parent",
      },
    });
    const child = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Child progress", 0, 1),
    ], provider));
    const childLaunch = fixture.runtime.launch(confirmedLaunchRequest(child));
    assert.equal(childLaunch.code, "tracker_mutation_not_owned");

    const gated = trackerProgressProposal([
      progressCard("publish", 1, "Progress", 0, 1),
      checkpointCard("accept-from-tracker", ["publish"]),
    ], provider);
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
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} child runs reject tracker cards declared only by a revision`, async (t) => {
    const fixture = await trackerRuntime(t, provider, {
      runOwnership: {
        schema: "flow.run-ownership/v1",
        scope: "child",
        parent_run_id: "run:parent",
      },
    });
    const proposal = revisionTrackerProgressProposal(provider);
    proposal.graph.cards = [checkpointCard("revise-progress", [])];
    proposal.revision_templates[0].changes.supersede_cards = ["revise-progress"];
    proposal.explicit_facts.block_observations[0] = observeCardBlock({
      card_id: "revise-progress",
      block: {
        ...proposal.explicit_facts.block_observations[0].block,
        id: "revise-progress:revision",
      },
    });
    proposal.explicit_facts.validator_contracts.push(
      "flow.validator/checkpoint-decision/v1",
    );
    proposal.requested_authority.commands.push("checkpoint_decision");

    const prepared = fixture.runtime.prepare(proposal);
    const rejection = fixture.runtime.launch(confirmedLaunchRequest(prepared));
    assert.equal(rejection.code, "tracker_mutation_not_owned");
    assert.equal(fixture.driver.createCount, 0);
    assert.equal(fixture.driver.updateCount, 0);
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} mutation fencing prevents concurrent first-write duplicates`, async (t) => {
    const fixture = await trackerRuntime(t, provider, { listDelayMs: 20 });
    const prepared = ["First owner", "Second owner"].map((summary) =>
      fixture.runtime.prepare(trackerProgressProposal([
        progressCard("publish", 1, summary, 0, 1),
      ], provider)));
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
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} status cannot admit, grant, decide, or advance a run`, async (t) => {
    const fixture = await trackerRuntime(t, provider);
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Authority remains local", 0, 1),
    ], provider));
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
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} receipt loss adopts the exact marker-bound update without reposting`, async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const driver = new FakeTrackerDriver({ loseFirstReceipt: true });
    const drivers = trackerDrivers(provider, driver);
    const firstAuthority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    });
    const firstRuntime = createTrackerRuntime(firstAuthority, drivers);
    const prepared = firstRuntime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Ready for review", 1, 1),
    ], provider));
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
    const recoveredRuntime = createTrackerRuntime(recoveredAuthority, drivers);
    await until(() => recoveredRuntime.query({ run_id: launch.run_id }).phase ===
      "succeeded");

    const projection = recoveredRuntime.query({ run_id: launch.run_id });
    assert.equal(driver.createCount, 1);
    assert.equal(driver.updateCount, 0);
    assert.equal(projection.tracker_progress.status, "projected");
    assert.equal(projection.tracker_progress.tracker.system, provider);
    assert.equal(projection.effects[0].last_observation.presence, "present");
    assert.deepEqual(projection.effects[0].last_observation.causation, {
      effect_id: projection.effects[0].effect_id,
      idempotency_key: projection.effects[0].idempotency_key,
    });
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} foreign marker ownership fails closed without tracker mutation`, async (t) => {
    const fixture = await trackerRuntime(t, provider, {
      comments: [{
        id: "foreign",
        body: `${TRACKER_PROGRESS_MARKER} owner=run:${"f".repeat(64)} -->\nForeign`,
      }],
    });
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Owned progress", 0, 1),
    ], provider));
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
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} duplicate progress markers remain unresolved and are never consolidated implicitly`, async (t) => {
    const comments = ["one", "two"].map((id) => ({
      id,
      body: `${TRACKER_PROGRESS_MARKER} owner=run:${"f".repeat(64)} -->\n${id}`,
    }));
    const fixture = await trackerRuntime(t, provider, { comments });
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Owned progress", 0, 1),
    ], provider));
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
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} altered write receipts cannot settle tracker progress`, async (t) => {
    const fixture = await trackerRuntime(t, provider, {
      alterWriteReceipt: true,
    });
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Exact progress", 0, 1),
    ], provider));
    const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));
    fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.legal_next_actions[0]);
    await until(() => fixture.runtime.query({ run_id: launch.run_id })
      .effects[0]?.invocation_started === true);

    const projection = fixture.runtime.query({ run_id: launch.run_id });
    assert.equal(projection.effects[0].receipt, null);
    assert.notEqual(projection.tracker_progress.status, "projected");
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} incomplete comment listings cannot authorize creation`, async (t) => {
    const fixture = await trackerRuntime(t, provider, {
      completeListing: false,
    });
    const prepared = fixture.runtime.prepare(trackerProgressProposal([
      progressCard("publish", 1, "Bounded progress", 0, 1),
    ], provider));
    const launch = fixture.runtime.launch(confirmedLaunchRequest(prepared));
    fixture.runtime.command(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.legal_next_actions[0]);
    await until(() => fixture.runtime.query({ run_id: launch.run_id })
      .effects[0]?.invocation_started === true);

    assert.equal(fixture.driver.createCount, 0);
    assert.equal(fixture.driver.updateCount, 0);
    assert.equal(fixture.runtime.query({ run_id: launch.run_id })
      .tracker_progress.status, "unresolved");
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} tracker projection follows revision-added cards and ignores superseded cards`, async (t) => {
    const fixture = await trackerRuntime(t, provider);
    const proposal = revisionTrackerProgressProposal(provider);
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
    assert.equal(revised.tracker_progress.tracker.system, provider);
    assert.deepEqual(
      revised.tracker_progress.legal_next_actions.map(({ type }) => type),
      ["operation_execute"],
    );
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} tracker revisions reject duplicate or regressing progress sequences`, () => {
    const duplicate = revisionTrackerProgressProposal(provider);
    duplicate.revision_templates[0].changes.add_cards[0].inputs.sequence = 1;
    assert.throws(
      () => createTrackerCompilerRuntime().prepare(duplicate),
      /tracker progress update sequences must be unique/,
    );

    const regressing = revisionTrackerProgressProposal(provider);
    regressing.graph.cards[0].inputs.sequence = 3;
    assert.throws(
      () => createTrackerCompilerRuntime().prepare(regressing),
      /revision progress sequence must advance the base plan/,
    );

    const ambiguous = revisionTrackerProgressProposal(provider);
    const secondTemplate = structuredClone(ambiguous.revision_templates[0]);
    secondTemplate.id = "replace-progress-again";
    secondTemplate.trigger.code = "second_progress_revision_required";
    secondTemplate.changes.add_cards[0].id = "publish-another-revision";
    secondTemplate.changes.add_cards[0].inputs.sequence = 3;
    ambiguous.revision_templates.push(secondTemplate);
    assert.throws(
      () => createTrackerCompilerRuntime().prepare(ambiguous),
      /one unambiguous revision path/,
    );
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} launch revalidates tracker revisions from a registry-neutral bundle`, () => {
    const proposal = revisionTrackerProgressProposal(provider);
    proposal.graph.cards[0].inputs.sequence = 3;
    const prepared = compileDynamicPlan(proposal);

    const rejection = createTrackerCompilerRuntime().launch(
      confirmedLaunchRequest(prepared),
    );
    assert.equal(rejection.code, "invalid_operation_input");
  });
}

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} launch rejects revision edges that make tracker progress gate work`, () => {
    const proposal = trackerProgressProposal([
      progressCard("publish", 1, "Bounded progress", 0, 1),
      checkpointCard("revise-work", []),
    ], provider);
    const block = {
      schema: "flow.card-block/v1",
      id: "revise-work:revision",
      type: "plan_revision_required",
      trigger: {
        schema: "flow.revision-trigger/v1",
        type: "plan_revision_required",
        code: "work_revision_required",
      },
      required_capabilities: [],
      revision_template_ids: ["replace-work"],
    };
    proposal.requested_authority.commands.push(
      "checkpoint_decision",
      "revision_decision",
    );
    proposal.explicit_facts.operation_contracts.push(
      "flow.adapter/card-block-observation/v1",
    );
    proposal.explicit_facts.validator_contracts.push(
      "flow.validator/card-block-observation/v1",
      "flow.validator/checkpoint-decision/v1",
    );
    proposal.explicit_facts.block_observations.push(observeCardBlock({
      card_id: "revise-work",
      block,
    }));
    Object.assign(proposal.explicit_facts.limits, {
      max_cards: 3,
      max_revisions: 1,
      max_cards_per_revision: 1,
    });
    proposal.revision_templates = [{
      schema: "flow.plan-revision-template/v1",
      id: "replace-work",
      trigger: structuredClone(block.trigger),
      limits: { max_applications: 1 },
      changes: {
        add_cards: [checkpointCard("accept-work", [])],
        add_edges: [{ from: "publish", to: "accept-work" }],
        supersede_cards: ["revise-work"],
        capability_additions: [],
        resource_additions: [],
        limit_changes: { max_cards: 3 },
      },
    }];
    const prepared = compileDynamicPlan(proposal);

    const rejection = createTrackerCompilerRuntime().launch(
      confirmedLaunchRequest(prepared),
    );
    assert.equal(rejection.code, "invalid_operation_input");
  });
}

test("relative GitHub owner and repository segments are rejected", () => {
  for (const field of ["owner", "repository"]) {
    const proposal = trackerProgressProposal([
      progressCard("publish", 1, "Bounded progress", 0, 1),
    ]);
    proposal.explicit_facts.tracker_binding.tracker[field] = "..";
    const identity = `github:${proposal.explicit_facts.tracker_binding.tracker.owner}/${proposal.explicit_facts.tracker_binding.tracker.repository}#34`;
    proposal.explicit_facts.resource_claims[0].id = identity;
    proposal.graph.cards[0].resource_claims[0].id = identity;
    assert.throws(
      () => createTrackerCompilerRuntime().prepare(proposal),
      /confirmed feature or epic tracker binding/,
      field,
    );
  }
});

test("invalid Jira project and issue identities are rejected", () => {
  const invalidProject = trackerProgressProposal([
    progressCard("publish", 1, "Bounded progress", 0, 1),
  ], "jira");
  invalidProject.explicit_facts.tracker_binding.tracker.project = "..";
  assert.throws(
    () => createTrackerCompilerRuntime().prepare(invalidProject),
    /confirmed feature or epic tracker binding/,
  );

  const invalidIssue = trackerProgressProposal([
    progressCard("publish", 1, "Bounded progress", 0, 1),
  ], "jira");
  invalidIssue.explicit_facts.tracker_binding.tracker.issue_number = 0;
  assert.throws(
    () => createTrackerCompilerRuntime().prepare(invalidIssue),
    /confirmed feature or epic tracker binding/,
  );

  const alternateShape = trackerProgressProposal([
    progressCard("publish", 1, "Bounded progress", 0, 1),
  ], "jira");
  delete alternateShape.explicit_facts.tracker_binding.tracker.issue_number;
  alternateShape.explicit_facts.tracker_binding.tracker.issue_key = "FLOW-35";
  assert.throws(
    () => createTrackerCompilerRuntime().prepare(alternateShape),
    /confirmed feature or epic tracker binding/,
  );
});

for (const provider of TRACKER_PROVIDERS) {
  test(`${provider} durable launch rejects a tracker card without its binding before commit`, async (t) => {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const authority = createDurableRunAuthority({
      authorityDirectory,
      hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    });
    t.after(() => authority.close());
    const prepared = structuredClone(compileDynamicPlan(trackerProgressProposal([
      progressCard("publish", 1, "Bounded progress", 0, 1),
    ], provider)));
    delete prepared.explicit_facts.tracker_binding;
    rebindPreparedIdentity(prepared);

    const rejection = authority.launch(confirmedLaunchRequest(prepared));

    assert.equal(rejection.schema, "flow.rejection/v1");
    assert.equal(rejection.code, "invalid_prepared_bundle");
    assert.equal(rejection.reason, "invalid_operation_input");
    assert.deepEqual(authority.query().runs, []);
  });
}

function revisionTrackerProgressProposal(
  provider = "github",
  contract = TRACKER_PROGRESS_CONTRACT,
) {
  const proposal = trackerProgressProposal([
    progressCard(
      "publish-original",
      1,
      "Original progress",
      0,
      1,
      [],
      provider,
      contract,
    ),
  ], provider, contract);
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
        [],
        provider,
        contract,
      )],
      add_edges: [],
      supersede_cards: ["publish-original"],
      capability_additions: [],
      resource_additions: [],
      limit_changes: { max_cards: 2 },
    },
  }];
  return proposal;
}

function trackerProgressProposal(
  cards,
  provider = "github",
  contract = TRACKER_PROGRESS_CONTRACT,
  trackerOverride = null,
) {
  const tracker = trackerOverride ?? (provider === "jira"
    ? { system: "jira", project: "FLOW", issue_number: 35 }
    : {
      system: "github",
      owner: "Seavenly",
      repository: "dotfiles",
      issue_number: 34,
    });
  const trackerId = tracker.system === "jira"
    ? `jira:${tracker.project}-${tracker.issue_number}`
    : `github:${tracker.owner}/${tracker.repository}#${tracker.issue_number}`;
  for (const card of cards) {
    card.route = { adapter: provider };
    card.resource_claims = [{ kind: "tracker-progress", id: trackerId }];
  }
  return {
    schema: "flow.dynamic-plan-proposal/v1",
    graph: { schema: "flow.run-plan/v1", cards },
    requested_authority: {
      commands: ["operation_execute"],
      capabilities: [],
      mutations: [contract],
    },
    explicit_facts: {
      catalog_fingerprint: `sha256:${"1".repeat(64)}`,
      route_snapshot: {
        watermark: `sha256:${"2".repeat(64)}`,
        bindings: [{ adapter: provider, contract }],
      },
      capability_envelopes: [],
      operation_contracts: [contract],
      validator_contracts: ["flow.validator/operation-receipt/v1"],
      block_observations: [],
      tracker_binding: {
        schema: "flow.tracker-binding/v1",
        flow: "feature",
        tracker,
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
        id: trackerId,
      }],
    },
  };
}

function progressCard(
  id,
  sequence,
  summary,
  completed,
  total,
  dependencies = [],
  provider = "github",
  contract = TRACKER_PROGRESS_CONTRACT,
) {
  const trackerId = provider === "jira"
    ? "jira:FLOW-35"
    : "github:Seavenly/dotfiles#34";
  return {
    id,
    executor: {
      kind: "operation",
      contract,
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
    route: { adapter: provider },
    limits: { max_attempts: 1 },
    resource_claims: [{
      kind: "tracker-progress",
      id: trackerId,
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

async function trackerRuntime(t, provider, options = {}) {
  const { runOwnership, ...driverOptions } = options;
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-tracker-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    ...(runOwnership === undefined ? {} : {
      runOwnershipAdapter: {
        observe: () => structuredClone(runOwnership),
      },
    }),
  });
  t.after(() => authority.close());
  const driver = new FakeTrackerDriver(driverOptions);
  const drivers = trackerDrivers(provider, driver);
  return {
    authority,
    authorityDirectory,
    driver,
    drivers,
    runtime: createTrackerRuntime(authority, drivers),
  };
}

function createTrackerRuntime(
  authority,
  drivers,
) {
  return createFlowRuntime({
    runAuthority: authority,
    registeredOperations: createTrackerProgressRegistrationBundle({
      github: { driver: drivers.github },
      jira: { driver: drivers.jira },
    }),
  });
}

function trackerDrivers(provider, selectedDriver) {
  return {
    github: provider === "github" ? selectedDriver : new FakeTrackerDriver(),
    jira: provider === "jira" ? selectedDriver : new FakeTrackerDriver(),
  };
}

function createTrackerCompilerRuntime() {
  return createFlowRuntime({
    registeredOperations: createTrackerProgressRegistrationBundle({
      github: { driver: new FakeTrackerDriver() },
      jira: { driver: new FakeTrackerDriver() },
    }),
  });
}

function createTrackerOperation(provider, driver) {
  return provider === "jira"
    ? createJiraTrackerProgressOperation({ driver })
    : createGitHubTrackerProgressOperation({ driver });
}

function rebindPreparedIdentity(prepared) {
  prepared.plan_fingerprint = digest(prepared.graph);
  prepared.bundle_digest = digest({
    schema: "flow.prepared-bundle/v1",
    kind: prepared.kind,
    graph: prepared.graph,
    plan_fingerprint: prepared.plan_fingerprint,
    requested_authority: prepared.requested_authority,
    explicit_facts: prepared.explicit_facts,
    revision_templates: prepared.revision_templates,
  });
  prepared.confirmation = {
    schema: "flow.dynamic-plan-confirmation/v1",
    bundle_digest: prepared.bundle_digest,
    graph: prepared.graph,
    requested_authority: prepared.requested_authority,
    explicit_facts: prepared.explicit_facts,
    revision_templates: prepared.revision_templates,
  };
  prepared.confirmation_digest = digest(prepared.confirmation);
}

class FakeTrackerDriver {
  constructor({
    alterWriteReceipt = false,
    alterUpdateReceiptId = false,
    comments = [],
    completeListing = true,
    listDelayMs = 0,
    loseFirstReceipt = false,
    partitionCommentsByTracker = false,
  } = {}) {
    this.alterWriteReceipt = alterWriteReceipt;
    this.alterUpdateReceiptId = alterUpdateReceiptId;
    this.comments = structuredClone(comments);
    this.completeListing = completeListing;
    this.createCount = 0;
    this.updateCount = 0;
    this.loseFirstReceipt = loseFirstReceipt;
    this.listDelayMs = listDelayMs;
    this.partitionCommentsByTracker = partitionCommentsByTracker;
    this.commentsByTracker = new Map();
  }

  async listComments(tracker) {
    const comments = this.partitionCommentsByTracker
      ? this.commentsByTracker.get(this.trackerKey(tracker)) ?? []
      : this.comments;
    const snapshot = structuredClone(comments);
    if (this.listDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.listDelayMs));
    }
    return { comments: snapshot, complete: this.completeListing };
  }

  async createComment(tracker, body) {
    this.createCount += 1;
    const comment = {
      id: `comment-${this.createCount}`,
      body: this.alterWriteReceipt ? `${body}\n` : body,
    };
    this.comments.push(comment);
    if (this.partitionCommentsByTracker) {
      const key = this.trackerKey(tracker);
      const comments = this.commentsByTracker.get(key) ?? [];
      comments.push(comment);
      this.commentsByTracker.set(key, comments);
    }
    if (this.loseFirstReceipt) {
      this.loseFirstReceipt = false;
      throw new Error("response lost after provider accepted the comment");
    }
    return structuredClone(comment);
  }

  async updateComment(tracker, commentId, body) {
    this.updateCount += 1;
    const comments = this.partitionCommentsByTracker
      ? this.commentsByTracker.get(this.trackerKey(tracker)) ?? []
      : this.comments;
    const comment = comments.find(({ id }) => id === commentId);
    comment.body = body;
    return structuredClone({
      ...comment,
      ...(this.alterWriteReceipt ? { body: `${comment.body}\n` } : {}),
      ...(this.alterUpdateReceiptId ? { id: "other-comment" } : {}),
    });
  }

  trackerKey(tracker) {
    return JSON.stringify(tracker);
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

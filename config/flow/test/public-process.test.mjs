import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { writeFileSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli-command.mjs";
import { createFlowClient } from "../src/client.mjs";
import {
  createFlowOwner,
  flowOwnerPaths,
  readProcessStartIdentity,
  startFlowOwner,
  statusFlowOwner,
  stopFlowOwner,
} from "../src/owner-process.mjs";
import {
  FLOW_RUNTIME_INTERFACE,
  FLOW_TRANSPORT_ERROR,
  createFlowTransportServer,
  requestFrame,
  watchFlowTransport,
} from "../src/transport.mjs";
import { confirmedLaunchRequest } from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import { registeredOperationProposal } from "../../../tools/flow/test-support/registered-operation.mjs";
import {
  initializePublicReviewRepository,
  seedPublicReview,
} from "../test-support/public-review-seed.mjs";

const PUBLIC_OWNER_RUNTIME_MODULE = resolve(
  import.meta.dirname,
  "../test-support/public-owner-runtime.mjs",
);
const FLOW_CLI_ENTRYPOINT = resolve(import.meta.dirname, "../src/cli.mjs");

test("client process exit does not stop the detached owner or its autonomous run", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  const started = await startDetachedFixture(fixture);
  assert.equal(started.state, "running");

  const preparedProcess = await runCliProcess(fixture.env, [
    "prepare",
    "--input",
    JSON.stringify(registeredOperationProposal({ checkpointBound: false })),
    "--json",
  ]);
  assert.equal(preparedProcess.code, 0, preparedProcess.stderr);
  assert.equal(preparedProcess.stderr, "");
  const prepared = JSON.parse(preparedProcess.stdout);
  assert.equal(prepared.schema, "flow.prepared-run/v1");

  const launchedProcess = await runCliProcess(fixture.env, [
    "launch",
    "--input",
    JSON.stringify(confirmedLaunchRequest(prepared)),
    "--json",
  ]);
  assert.equal(launchedProcess.code, 0, launchedProcess.stderr);
  assert.equal(launchedProcess.stderr, "");
  const launch = JSON.parse(launchedProcess.stdout);
  assert.equal(launch.schema, "flow.launch-receipt/v1");

  const afterClientExit = await statusFlowOwner({ ...fixture.paths });
  assert.equal(afterClientExit.state, "running");
  const client = createFlowClient({ socketPath: fixture.paths.socketPath });
  await waitFor(async () => (await client.query({ run_id: launch.run_id })).phase === "succeeded");
  assert.equal((await statusFlowOwner({ ...fixture.paths })).state, "running");
});

test("public host rebuilds the review inbox after the producing client exits", async (t) => {
  const fixture = await disposableOwnerFixture(t, { production: true });
  const seeded = await seedPublicReview({
    authorityDirectory: fixture.paths.authorityDirectory,
    env: fixture.env,
    repository: fixture.repository,
  });
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  await startDetachedFixture(fixture);

  const reconnected = createFlowClient({ socketPath: fixture.paths.socketPath });
  const inbox = await reconnected.query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  assert.equal(inbox.schema, "flow.review-inbox-projection/v1");
  assert.equal(inbox.items.length, 1);
  const [item] = inbox.items;
  assert.equal(item.review_id, seeded.review.subject_id);
  assert.equal(item.candidate_id, seeded.candidate.subject_id);
  assert.equal(item.candidate_fingerprint, seeded.candidate.candidate_fingerprint);
  assert.equal(item.lifecycle_generation, seeded.review.lifecycle_generation);
  assert.equal(item.candidate_authority_watermark, seeded.review.candidate_authority_watermark);
  assert.equal(item.review_authority_watermark, seeded.review.watermark);
  assert.equal(item.review.status, "automated_completed");
  assert.equal(item.review.current, true);

  const inboxWatcher = reconnected.watch({
    schema: "flow.watch/v1",
    query: "review_inbox",
  });
  const inboxObservation = await inboxWatcher.next();
  assert.equal(inboxObservation.done, false);
  assert.deepEqual(inboxObservation.value, inbox);
  await inboxWatcher.return();

  const authorityBeforeBoundary = await reconnected.query({});
  const seededFeatureAfterReconnect = await reconnected.query({
    run_id: seeded.feature.run_id,
  });
  const featureWatermark = seededFeatureAfterReconnect.watermark;
  const inboxBeforeBoundary = await reconnected.query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  const gitBeforeBoundary = gitObservation(fixture.repository);
  const unsupportedCommands = [
    {
      name: "schedule",
      command: {
        schema: "flow.command/v1",
        type: "schedule",
        run_id: seeded.feature.run_id,
        expected_watermark: featureWatermark,
      },
    },
    {
      name: "lifecycle",
      command: {
        schema: "flow.command/v1",
        type: "cancel",
        run_id: seeded.feature.run_id,
        expected_watermark: featureWatermark,
      },
    },
    {
      name: "seal",
      command: {
        schema: "work.review-candidate-seal-command/v1",
        type: "review_candidate_seal",
        contract: "work.review/v1",
        subject_id: seeded.candidate.subject_id,
        expected_generation: 0,
        candidate: seeded.candidate.candidate,
        run_id: seeded.feature.run_id,
        expected_watermark: featureWatermark,
      },
    },
    {
      name: "git integration",
      command: {
        schema: "flow.command/v1",
        type: "git_integrate",
        run_id: seeded.feature.run_id,
        expected_watermark: featureWatermark,
      },
    },
  ];
  const unsupportedCodes = {
    schedule: "run_terminal",
    lifecycle: "run_terminal",
    seal: "invalid_command",
    "git integration": "run_terminal",
  };
  for (const { name, command } of unsupportedCommands) {
    const rejection = await reconnected.command(command);
    assert.equal(rejection.schema, "flow.rejection/v1", name);
    assert.equal(rejection.accepted, undefined, name);
    assert.equal(rejection.code, unsupportedCodes[name], name);
  }
  assert.deepEqual(await reconnected.query({}), authorityBeforeBoundary);
  assert.deepEqual(await reconnected.query({
    schema: "flow.query/v1",
    query: "review_inbox",
  }), inboxBeforeBoundary);
  assert.deepEqual(gitObservation(fixture.repository), gitBeforeBoundary);

  const sessionStart = item.legal_actions.find(({ type }) =>
    type === "review_session_start");
  assert.ok(sessionStart);
  const sessionId = `session:${item.review_id}:operator`;
  const sessionReceipt = await reconnected.command(materializeReviewAction(
    sessionStart,
    { session_id: sessionId },
  ));
  assert.equal(sessionReceipt.accepted, true);

  const beforeStaleSession = await reconnected.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  const staleSession = await reconnected.command(materializeReviewAction(
    {
      ...sessionStart,
      command_id: `${sessionStart.command_id}:stale-replay`,
    },
    { session_id: sessionId },
  ));
  assert.equal(staleSession.schema, "work.rejection/v1");
  assert.equal(staleSession.accepted, undefined);
  assert.equal(staleSession.code, "stale_review_generation");

  let review = await reconnected.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  assert.deepEqual(review, beforeStaleSession);
  assert.equal(review.review_generation, 1);
  assert.equal(review.session.session_id, sessionId);
  const comment = review.legal_actions.find(({ type }) =>
    type === "review_comment");
  assert.ok(comment);
  assert.equal((await reconnected.command(materializeReviewAction(comment, {
    comment_id: "comment:public-host",
    body: "The retained candidate is ready for operator review.",
  }))).accepted, true);

  review = await reconnected.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  const disposition = review.legal_actions.find(({ type }) =>
    type === "review_disposition");
  assert.ok(disposition);
  assert.equal((await reconnected.command(materializeReviewAction(disposition, {
    disposition: "accept",
  }))).accepted, true);

  review = await reconnected.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  const approval = review.legal_actions.find(({ type, decision }) =>
    type === "review_approval" && decision === "approve");
  assert.ok(approval);
  assert.equal((await reconnected.command(materializeReviewAction(approval, {
    decision: "approve",
  }))).accepted, true);

  review = await reconnected.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  const integration = review.legal_actions.find(({ type }) =>
    type === "review_integration");
  assert.ok(integration);
  const integrationEvidence = {
    schema: "flow.review-integration-evidence/v1",
    candidate_fingerprint: review.candidate_fingerprint,
    lifecycle_generation: review.lifecycle_generation,
  };
  assert.equal((await reconnected.command(materializeReviewAction(integration, {
    evidence: integrationEvidence,
  }))).accepted, true);

  const completed = await reconnected.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  assert.equal(completed.review_generation, 5);
  assert.equal(completed.approval, "approved");
  assert.equal(completed.integration.evidence_digest !== undefined, true);
  assert.equal(completed.integration_eligible, true);
  assert.equal(completed.integration_authorized, true);
  assert.deepEqual(completed.legal_actions.map(({ type }) => type), [
    "review_comment",
    "review_disposition",
    "review_supersession",
  ]);
  assert.ok(completed.legal_actions.every((action) =>
    action.expected_watermark === completed.watermark &&
    action.expected_generation === completed.review_generation));
  assert.deepEqual(gitObservation(fixture.repository), gitBeforeBoundary);

  const beforeReopen = await reconnected.query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  await stopFlowOwner({ ...fixture.paths, force: true, waitMs: 1_000 });
  await startDetachedFixture(fixture);
  const afterReopen = await createFlowClient({
    socketPath: fixture.paths.socketPath,
  }).query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  assert.deepEqual(afterReopen, beforeReopen);
});

test("public host supersedes a production review and rejects stale follow-up actions", async (t) => {
  const fixture = await disposableOwnerFixture(t, { production: true });
  const seeded = await seedPublicReview({
    authorityDirectory: fixture.paths.authorityDirectory,
    env: fixture.env,
    repository: fixture.repository,
  });
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  await startDetachedFixture(fixture);

  const client = createFlowClient({ socketPath: fixture.paths.socketPath });
  const inbox = await client.query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  const [item] = inbox.items;
  assert.equal(item.review_id, seeded.review.subject_id);

  const sessionStart = materializeReviewAction(
    item.legal_actions.find(({ type }) => type === "review_session_start"),
    { session_id: "session:public-supersession" },
  );
  assert.ok(sessionStart);
  assert.equal((await client.command(sessionStart)).accepted, true);

  const reviewAfterSession = await client.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  const supersessionTemplate = reviewAfterSession.legal_actions.find(({ type }) =>
    type === "review_supersession");
  const staleCommentTemplate = reviewAfterSession.legal_actions.find(({ type }) =>
    type === "review_comment");
  assert.ok(supersessionTemplate);
  assert.ok(staleCommentTemplate);

  const supersession = materializeReviewAction(supersessionTemplate, {
    replacement: {
      candidate_fingerprint: `sha256:${"b".repeat(64)}`,
      lifecycle_generation: 1,
    },
  });
  assert.equal((await client.command(supersession)).accepted, true);

  const terminal = await client.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  });
  assert.equal(terminal.review_generation, 2);
  assert.equal(terminal.human_status, "superseded");
  assert.equal(terminal.current, false);
  assert.equal(terminal.evidence_currency, "stale");
  assert.equal(terminal.approval, "ineligible");
  assert.equal(terminal.integration_eligible, false);
  assert.deepEqual(terminal.legal_actions, []);
  assert.deepEqual(terminal.supersession.replacement, supersession.replacement);

  const staleComment = materializeReviewAction(staleCommentTemplate, {
    comment_id: "comment:stale-after-supersession",
    body: "This action was projected before supersession.",
  });
  const staleRejection = await client.command(staleComment);
  assert.equal(staleRejection.schema, "work.rejection/v1");
  assert.equal(staleRejection.code, "stale_review_generation");
  assert.equal(staleRejection.accepted, undefined);
  assert.deepEqual(await client.query({
    contract: "work.review/v1",
    subject_id: item.review_id,
  }), terminal);

  const terminalInbox = await client.query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  const terminalItem = terminalInbox.items.find(({ review_id: reviewId }) =>
    reviewId === item.review_id);
  assert.ok(terminalItem);
  assert.equal(terminalItem.current, false);
  assert.equal(terminalItem.review.human_status, "superseded");
  assert.deepEqual(terminalItem.legal_actions, []);

  await stopFlowOwner({ ...fixture.paths, force: true, waitMs: 1_000 });
  await startDetachedFixture(fixture);
  const rebuilt = await createFlowClient({
    socketPath: fixture.paths.socketPath,
  }).query({
    schema: "flow.query/v1",
    query: "review_inbox",
  });
  assert.deepEqual(rebuilt, terminalInbox);
});

test("detached owner progresses a multi-card dynamic run after explicit checkpoint admission", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  await startDetachedFixture(fixture);
  const client = createFlowClient({ socketPath: fixture.paths.socketPath });
  const prepared = await client.prepare(registeredOperationProposal({
    checkpointBound: true,
  }));
  assert.equal(prepared.graph.cards.length, 2);
  const launch = await client.launch(confirmedLaunchRequest(prepared));
  assert.equal(launch.created, true);
  await waitFor(async () => {
    const projection = await client.query({ run_id: launch.run_id });
    return projection.phase === "active" && projection.legal_actions.some(
      ({ type }) => type === "checkpoint_decision",
    );
  });
  const projection = await client.query({ run_id: launch.run_id });
  assert.equal(projection.phase, "active");
  assert.equal(projection.admission, "admitted");
  assert.deepEqual(
    projection.legal_actions.map(({ type, checkpoint_id, decision }) => ({
      type,
      checkpoint_id,
      decision,
    })),
    [
      {
        type: "checkpoint_decision",
        checkpoint_id: "confirm-plan",
        decision: "approve",
      },
      {
        type: "checkpoint_decision",
        checkpoint_id: "confirm-plan",
        decision: "decline",
      },
    ],
  );
  const approval = projection.legal_actions.find(({ decision }) =>
    decision === "approve");
  const commandReceipt = await client.command(approval);
  assert.equal(commandReceipt.accepted, true);
  await waitFor(async () =>
    (await client.query({ run_id: launch.run_id })).phase === "succeeded",
    { timeoutMs: 5_000 },
  );
  const completed = await client.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  assert.deepEqual(completed.cards.map(({ id, status }) => ({ id, status })), [
    { id: "confirm-plan", status: "completed" },
    { id: "record-outcome", status: "completed" },
  ]);
});

test("SIGKILL leaves a stale endpoint and same-boot restart resumes the durable effect", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  await startDetachedFixture(fixture);
  const client = createFlowClient({ socketPath: fixture.paths.socketPath });
  const proposal = registeredOperationProposal({ checkpointBound: false });
  proposal.graph.cards[0].limits.max_attempts = 2;
  const prepared = await client.prepare(proposal);
  const launch = await client.launch(confirmedLaunchRequest(prepared));
  let inFlight;
  await waitFor(async () => {
    inFlight = await client.query({ run_id: launch.run_id });
    if (!inFlight.effects?.[0]?.invocation_started ||
        inFlight.effects[0].receipt !== null) return false;
    const marker = await readFile(
      join(fixture.paths.authorityDirectory, "public-operation-invocations.log"),
      "utf8",
    ).catch(() => "");
    return marker.includes(inFlight.effects[0].effect_id);
  }, { timeoutMs: 3_000 });

  const endpoint = JSON.parse(await readFile(fixture.paths.endpointPath, "utf8"));
  process.kill(endpoint.pid, "SIGKILL");
  await waitFor(async () =>
    (await statusFlowOwner({ ...fixture.paths })).state === "stale",
  );
  const restarted = await startDetachedFixture(fixture);
  assert.equal(restarted.state, "running");
  assert.notEqual(restarted.process_identity, endpoint.process_identity);
  assert.equal(restarted.authority_directory, fixture.paths.authorityDirectory);

  await waitFor(async () =>
    (await client.query({ run_id: launch.run_id })).phase === "succeeded",
    { timeoutMs: 5_000 },
  );
  const completed = await client.query({ run_id: launch.run_id });
  assert.equal(completed.phase, "succeeded");
  assert.equal(completed.effects[0].receipt.outcome, "succeeded");
  const invocations = (await readFile(
    join(fixture.paths.authorityDirectory, "public-operation-invocations.log"),
    "utf8",
  )).trim().split("\n").filter(Boolean);
  assert.deepEqual(invocations, [inFlight.effects[0].effect_id]);
});

test("competing clients can query and watch without acquiring owner authority", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  const started = await startDetachedFixture(fixture);
  const clientOne = createFlowClient({ socketPath: fixture.paths.socketPath });
  const clientTwo = createFlowClient({ socketPath: fixture.paths.socketPath });
  const prepared = await clientOne.prepare(registeredOperationProposal({
    checkpointBound: false,
  }));
  const launch = await clientOne.launch(confirmedLaunchRequest(prepared));
  const before = await statusFlowOwner({ ...fixture.paths });
  assert.equal(before.state, "running");

  const [projectionOne, projectionTwo] = await Promise.all([
    clientOne.query({ run_id: launch.run_id }),
    clientTwo.query({ run_id: launch.run_id }),
  ]);
  assert.equal(projectionOne.run_id, launch.run_id);
  assert.deepEqual(projectionTwo, projectionOne);

  const watcherOne = clientOne.watch({ run_id: launch.run_id });
  const watcherTwo = clientTwo.watch({ run_id: launch.run_id });
  const [observationOne, observationTwo] = await Promise.all([
    watcherOne.next(),
    watcherTwo.next(),
  ]);
  assert.equal(observationOne.done, false);
  assert.equal(observationTwo.done, false);
  assert.equal(observationOne.value.run_id, launch.run_id);
  assert.equal(observationTwo.value.run_id, launch.run_id);
  await Promise.all([watcherOne.return(), watcherTwo.return()]);

  const after = await statusFlowOwner({ ...fixture.paths });
  assert.equal(after.state, "running");
  assert.equal(after.pid, started.pid);
  assert.equal(after.process_identity, started.process_identity);
});

test("owner refuses to touch a socket without durable mutation authority", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const runtime = {
    prepare: async () => ({}),
    launch: async () => ({}),
    command: async () => ({}),
    query: async () => ({}),
    watch: async () => oneObservationWatcher({}),
  };
  await assert.rejects(
    createFlowOwner({ runtime, ...fixture.paths, env: fixture.env }).start(),
    { code: "mutation_authority_unavailable" },
  );
  assert.equal(await exists(fixture.paths.socketPath), false);
  assert.equal(await exists(fixture.paths.endpointPath), false);
});

test("owner preserves a live socket when its endpoint is missing", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  await mkdir(dirname(fixture.paths.socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer();
  await listenRawServer(server, fixture.paths.socketPath);
  t.after(() => closeRawServer(server));

  const owner = createFlowOwner({
    runtime: authorizedRuntime({
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    }),
    ...fixture.paths,
    env: fixture.env,
  });
  await assert.rejects(owner.start(), { code: "socket_path_occupied" });
  assert.equal((await lstat(fixture.paths.socketPath)).isSocket(), true);
});

test("detached startup reports a child socket failure without waiting for timeout", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  await mkdir(dirname(fixture.paths.socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer();
  await listenRawServer(server, fixture.paths.socketPath);
  t.after(() => closeRawServer(server));

  await assert.rejects(
    startFlowOwner({
      env: fixture.env,
      ...fixture.paths,
      waitMs: 5_000,
      pollMs: 10,
    }),
    { code: "owner_exited_during_start" },
  );
  assert.equal((await lstat(fixture.paths.socketPath)).isSocket(), true);
});

test("endpoint publication is exclusive and a competing owner cannot replace it", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const runtime = () => authorizedRuntime({
    prepare: async () => ({}),
    launch: async () => ({}),
    command: async () => ({}),
    query: async () => ({}),
    watch: async () => oneObservationWatcher({}),
  });
  const owner = createFlowOwner({ runtime: runtime(), ...fixture.paths, env: fixture.env });
  await owner.start();
  t.after(() => owner.stop());
  const before = await readFile(fixture.paths.endpointPath, "utf8");

  const competing = createFlowOwner({
    runtime: runtime(),
    ...fixture.paths,
    env: fixture.env,
  });
  await assert.rejects(competing.start(), { code: "owner_already_running" });
  assert.equal(await readFile(fixture.paths.endpointPath, "utf8"), before);
  assert.equal((await statusFlowOwner({ ...fixture.paths })).state, "running");
});

test("stale cleanup preserves an endpoint replaced during the identity check", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  await mkdir(fixture.paths.authorityDirectory, { recursive: true, mode: 0o700 });
  const endpoint = {
    schema: "flow.owner-endpoint/v1",
    version: 1,
    owner_token: "owner:stale-a",
    pid: 99999999,
    process_identity: "owner:stale-a",
    process_start_identity: "dead-a",
    authority_directory: fixture.paths.authorityDirectory,
    endpoint_path: fixture.paths.endpointPath,
    socket_path: fixture.paths.socketPath,
    started_at: "2026-01-01T00:00:00.000Z",
  };
  const replacement = {
    ...endpoint,
    owner_token: "owner:replacement-b",
    process_identity: "owner:replacement-b",
    process_start_identity: "dead-b",
  };
  writeFileSync(fixture.paths.endpointPath, `${JSON.stringify(endpoint)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  let checked = false;
  const status = await statusFlowOwner({
    ...fixture.paths,
    cleanupStale: true,
    processStartIdentityReader: () => {
      if (!checked) {
        checked = true;
        writeFileSync(
          fixture.paths.endpointPath,
          `${JSON.stringify(replacement)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }
      return null;
    },
  });
  assert.equal(status.state, "stale");
  assert.deepEqual(JSON.parse(await readFile(fixture.paths.endpointPath, "utf8")), replacement);
});

test("owner rejects a precreated symlink fallback directory", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const longRoot = join(fixture.env.HOME, "x".repeat(180));
  const paths = flowOwnerPaths({
    env: fixture.env,
    authorityDirectory: longRoot,
    endpointPath: join(longRoot, "owner.json"),
    socketPath: join(longRoot, "owner.sock"),
  });
  const fallbackParent = dirname(paths.socketPath);
  const attackerDirectory = join(fixture.env.HOME, "attacker");
  await mkdir(attackerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(fallbackParent), { recursive: true, mode: 0o700 });
  await symlink(attackerDirectory, fallbackParent);
  const runtime = authorizedRuntime({
    prepare: async () => ({}),
    launch: async () => ({}),
    command: async () => ({}),
    query: async () => ({}),
    watch: async () => oneObservationWatcher({}),
  });
  await assert.rejects(
    createFlowOwner({ runtime, ...paths, env: fixture.env }).start(),
    { code: "socket_directory_symlink" },
  );
  assert.equal(await exists(join(attackerDirectory, "owner.sock")), false);
});

test("root-owned ancestor symlinks resolve for owner and transport", async (t) => {
  // This disposable alias models macOS /var -> /private/var without changing
  // a host-managed system path on Linux.
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const targetRoot = join(fixture.env.HOME, "private-var");
  const systemAlias = join(fixture.env.HOME, "var");
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await symlink(targetRoot, systemAlias);
  const directoryStatReader = async (path) => {
    const info = await lstat(path);
    if (path !== systemAlias) return info;
    return new Proxy(info, {
      get(target, property, receiver) {
        if (property === "uid") return 0;
        return Reflect.get(target, property, receiver);
      },
    });
  };
  const authorityDirectory = join(fixture.env.HOME, "authority");
  const paths = flowOwnerPaths({
    env: fixture.env,
    authorityDirectory,
    endpointPath: join(authorityDirectory, "owner.json"),
    socketPath: join(authorityDirectory, "owner.sock"),
    socketFallbackRoot: join(systemAlias, "flow-runtime"),
  });
  const runtime = authorizedRuntime({
    prepare: async () => ({}),
    launch: async () => ({}),
    command: async () => ({}),
    query: async () => ({}),
    watch: async () => oneObservationWatcher({}),
  });
  const owner = createFlowOwner({
    runtime,
    ...paths,
    env: fixture.env,
    directoryStatReader,
  });
  await owner.start();
  t.after(() => owner.stop());
  assert.equal((await lstat(join(targetRoot, "flow-runtime"))).isDirectory(), true);
  assert.equal((await lstat(paths.socketPath)).isSocket(), true);

  const transportSocketPath = join(systemAlias, "transport", "owner.sock");
  const transport = createFlowTransportServer({
    socketPath: transportSocketPath,
    runtime,
    directoryStatReader,
  });
  t.after(() => transport.close());
  await transport.start();
  assert.equal((await lstat(join(targetRoot, "transport", "owner.sock"))).isSocket(), true);
});

test("transport rejects a controlled socket leaf symlink", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  await mkdir(dirname(fixture.paths.socketPath), { recursive: true, mode: 0o700 });
  const target = join(fixture.env.HOME, "socket-target");
  await symlink(target, fixture.paths.socketPath);
  const transport = createFlowTransportServer({
    socketPath: fixture.paths.socketPath,
    runtime: authorizedRuntime({
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    }),
  });
  await assert.rejects(transport.start(), { code: "socket_path_symlink" });
  assert.equal((await lstat(fixture.paths.socketPath)).isSymbolicLink(), true);
});

test("fallback validates the XDG runtime root, ownership, mode, and traversal", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const runtimeDirectory = join(fixture.env.HOME, "xdg-runtime");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const authorityDirectory = join(fixture.env.HOME, `authority-${"a".repeat(150)}`);
  const endpointPath = join(authorityDirectory, "owner.json");
  const socketPath = join(authorityDirectory, "owner.sock");
  const env = { ...fixture.env, XDG_RUNTIME_DIR: runtimeDirectory };
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath,
    socketPath,
  });
  assert.equal(paths.socketFallbackBase, runtimeDirectory);
  assert.equal(paths.socketFallbackRoot, join(runtimeDirectory, "flow-sockets"));
  assert.ok(Buffer.byteLength(paths.socketPath) < 100);

  const owner = createFlowOwner({
    runtime: authorizedRuntime({
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    }),
    ...paths,
    env,
  });
  await owner.start();
  t.after(() => owner.stop());
  assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.socketFallbackRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(dirname(paths.socketPath))).mode & 0o777, 0o700);
  assert.equal((await stat(paths.socketPath)).mode & 0o777, 0o600);

  const modeRuntime = join(fixture.env.HOME, "xdg-mode");
  await mkdir(modeRuntime, { recursive: true, mode: 0o700 });
  await chmod(modeRuntime, 0o755);
  const modeEnv = { ...fixture.env, XDG_RUNTIME_DIR: modeRuntime };
  const modePaths = flowOwnerPaths({
    env: modeEnv,
    authorityDirectory: join(fixture.env.HOME, "mode-authority-" + "b".repeat(120)),
    endpointPath: join(fixture.env.HOME, "mode-authority-owner.json"),
    socketPath: join(fixture.env.HOME, `mode-${"c".repeat(180)}.sock`),
  });
  const modeOwner = createFlowOwner({
    runtime: authorizedRuntime({
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    }),
    ...modePaths,
    env: modeEnv,
  });
  await assert.rejects(modeOwner.start(), { code: "socket_runtime_directory_mode" });

  const ownerPaths = flowOwnerPaths({
    env,
    authorityDirectory: join(fixture.env.HOME, "owner-authority-" + "d".repeat(120)),
    endpointPath: join(fixture.env.HOME, "owner-endpoint.json"),
    socketPath: join(fixture.env.HOME, `owner-${"e".repeat(180)}.sock`),
  });
  await mkdir(ownerPaths.socketFallbackRoot, { recursive: true, mode: 0o700 });
  const ownerStatReader = async (path) => {
    const info = await lstat(path);
    if (path !== ownerPaths.socketFallbackRoot) return info;
    return new Proxy(info, {
      get(target, property, receiver) {
        return property === "uid"
          ? (target.uid ?? 0) + 1
          : Reflect.get(target, property, receiver);
      },
    });
  };
  const wrongOwner = createFlowOwner({
    runtime: authorizedRuntime({
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    }),
    ...ownerPaths,
    env,
    directoryStatReader: ownerStatReader,
  });
  await assert.rejects(wrongOwner.start(), { code: "socket_directory_owner" });

  assert.throws(() => flowOwnerPaths({
    env: {
      ...fixture.env,
      FLOW_OWNER_SOCKET_FALLBACK_ROOT: "/tmp/../attacker",
    },
    authorityDirectory: join(fixture.env.HOME, "traversal-authority"),
    endpointPath: join(fixture.env.HOME, "traversal-endpoint.json"),
    socketPath: join(fixture.env.HOME, "traversal.sock"),
  }), { code: "socketFallbackRoot_traversal" });
});

test("fallback rejects a symlinked XDG runtime component before chmod", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const target = join(fixture.env.HOME, "real-runtime");
  const linkPath = join(fixture.env.HOME, "runtime-link");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await symlink(target, linkPath);
  const env = { ...fixture.env, XDG_RUNTIME_DIR: linkPath };
  const paths = flowOwnerPaths({
    env,
    authorityDirectory: join(fixture.env.HOME, "symlink-authority-" + "f".repeat(120)),
    endpointPath: join(fixture.env.HOME, "symlink-endpoint.json"),
    socketPath: join(fixture.env.HOME, `symlink-${"g".repeat(180)}.sock`),
  });
  const owner = createFlowOwner({
    runtime: authorizedRuntime({
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    }),
    ...paths,
    env,
  });
  await assert.rejects(owner.start(), { code: "socket_runtime_directory_symlink" });
  assert.equal((await stat(target)).mode & 0o777, 0o700);
});

test("detached startup preserves the bounded fallback path across the child boundary", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const runtimeDirectory = join(fixture.env.HOME, "xdg-detached");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const authorityDirectory = join(fixture.env.HOME, `detached-${"h".repeat(150)}`);
  const env = {
    ...fixture.env,
    XDG_RUNTIME_DIR: runtimeDirectory,
    FLOW_OWNER_RUNTIME_MODULE: PUBLIC_OWNER_RUNTIME_MODULE,
  };
  const paths = flowOwnerPaths({
    env,
    authorityDirectory,
    endpointPath: join(authorityDirectory, "owner.json"),
    socketPath: join(authorityDirectory, "owner.sock"),
  });
  assert.ok(paths.socketFallbackRoot);
  try {
    const started = await startFlowOwner({
      env,
      ...paths,
      waitMs: 5_000,
      pollMs: 10,
    });
    assert.equal(started.state, "running");
    assert.ok(Buffer.byteLength(started.socket_path) < 100);
    assert.equal((await statusFlowOwner({ env, ...paths })).state, "running");
  } finally {
    await stopFlowOwner({
      env,
      ...paths,
      force: true,
      waitMs: 1_000,
      pollMs: 10,
    });
  }
});

test("malformed, multiple, and oversized frames fail closed with bounded errors", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const runtime = {
    mutationAuthority: true,
    prepare: async () => ({}),
    launch: async () => ({}),
    command: async () => ({}),
    query: async () => ({}),
    watch: async () => oneObservationWatcher({}),
  };
  const owner = createFlowOwner({
    runtime,
    ...fixture.paths,
    env: fixture.env,
    maxFrameBytes: 1_024,
  });
  await owner.start();
  t.after(() => owner.stop());

  const malformed = await rawTransportExchange(
    fixture.paths.socketPath,
    "not-json\n",
  );
  assertProtocolError(malformed, "invalid_json");

  const empty = await rawTransportExchange(fixture.paths.socketPath, "\n");
  assertProtocolError(empty, "invalid_json");

  const frame = JSON.stringify(requestFrame({
    operation: "query",
    request: { marker: "one" },
    requestId: "request-one",
  }));
  const secondFrame = JSON.stringify(requestFrame({
    operation: "query",
    request: { marker: "two" },
    requestId: "request-two",
  }));
  const multiple = await rawTransportExchange(
    fixture.paths.socketPath,
    `${frame}\n${secondFrame}\n`,
  );
  assertProtocolError(multiple, "multiple_requests_per_connection");

  const oversized = await rawTransportExchange(
    fixture.paths.socketPath,
    `${JSON.stringify(requestFrame({
      operation: "query",
      request: { marker: "x".repeat(2_000) },
      requestId: "request-large",
    }))}\n`,
  );
  assertProtocolError(oversized, "frame_too_large");
});

test("watch rejects an oversized incomplete server frame without buffering unbounded data", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const maxFrameBytes = 1_024;
  await mkdir(dirname(fixture.paths.socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.alloc(maxFrameBytes, 0x78));
    });
  });
  await listenRawServer(server, fixture.paths.socketPath);
  let watcher = null;
  t.after(async () => {
    await watcher?.return();
    await closeRawServer(server);
  });

  watcher = watchFlowTransport({
    socketPath: fixture.paths.socketPath,
    request: { run_id: "run:oversized-server" },
    requestId: "oversized-server",
    timeoutMs: 1_000,
    maxFrameBytes,
  });
  await assert.rejects(withTimeout(watcher.next()), { code: "frame_too_large" });
});

test("watch accepts one chunk containing multiple individually valid frames", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const maxFrameBytes = 1_024;
  const requestId = "multiple-valid-server";
  const observationFrames = Array.from({ length: 6 }, (_, index) => ({
    schema: "flow.transport-response/v1",
    interface: FLOW_RUNTIME_INTERFACE,
    version: 1,
    request_id: requestId,
    operation: "watch",
    ok: true,
    done: false,
    sequence: index,
    watermark: `watermark:${index}`,
    result: { index, payload: "x".repeat(140) },
  }));
  const terminalFrame = {
    schema: "flow.transport-response/v1",
    interface: FLOW_RUNTIME_INTERFACE,
    version: 1,
    request_id: requestId,
    operation: "watch",
    ok: true,
    done: true,
    sequence: observationFrames.length,
  };
  const encodedFrames = Buffer.from([
    ...observationFrames,
    terminalFrame,
  ].map((frame) => `${JSON.stringify(frame)}\n`).join(""));
  assert.ok(encodedFrames.byteLength > maxFrameBytes);
  assert.ok(observationFrames.every((frame) =>
    Buffer.byteLength(JSON.stringify(frame)) + 1 <= maxFrameBytes));

  await mkdir(dirname(fixture.paths.socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.write(encodedFrames));
  });
  await listenRawServer(server, fixture.paths.socketPath);
  let watcher = null;
  t.after(async () => {
    await watcher?.return();
    await closeRawServer(server);
  });

  watcher = watchFlowTransport({
    socketPath: fixture.paths.socketPath,
    request: { run_id: "run:multiple-valid-server" },
    requestId,
    timeoutMs: 1_000,
    maxFrameBytes,
  });
  const observations = [];
  for await (const observation of watcher) observations.push(observation);
  assert.deepEqual(observations.map(({ index }) => index), [0, 1, 2, 3, 4, 5]);
});

test("public CLI sends all five FlowRuntime operations over one versioned transport", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const calls = [];
  const runtime = {
    prepare(request) {
      calls.push({ operation: "prepare", request });
      return { operation: "prepare", request };
    },
    launch(request) {
      calls.push({ operation: "launch", request });
      return { operation: "launch", request };
    },
    command(request) {
      calls.push({ operation: "command", request });
      return { operation: "command", request };
    },
    query(request) {
      calls.push({ operation: "query", request });
      return { operation: "query", request };
    },
    watch(request) {
      calls.push({ operation: "watch", request });
      return oneObservationWatcher({
        watermark: "watermark:watch",
        request,
      });
    },
    mutationAuthority: true,
  };
  const owner = createFlowOwner({ runtime, ...fixture.paths, env: fixture.env });
  await owner.start();
  t.after(() => owner.stop());

  const requests = {
    prepare: { marker: "prepare-request" },
    launch: { marker: "launch-request" },
    command: { marker: "command-request" },
    query: { marker: "query-request" },
    watch: { marker: "watch-request" },
  };
  for (const operation of ["prepare", "launch", "command", "query"]) {
    let stdout = "";
    let stderr = "";
    const status = await runCli(
      [operation, "--input", JSON.stringify(requests[operation]), "--json"],
      {
        client: createFlowClient({ socketPath: fixture.paths.socketPath }),
        env: fixture.env,
        ownerOptions: fixture.paths,
        stderr: { write: (chunk) => { stderr += chunk; } },
        stdout: { write: (chunk) => { stdout += chunk; } },
      },
    );
    assert.equal(status, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      operation,
      request: requests[operation],
    });
  }

  let stdout = "";
  let stderr = "";
  assert.equal(await runCli(
    ["watch", "--input", JSON.stringify(requests.watch), "--json"],
    {
      client: createFlowClient({ socketPath: fixture.paths.socketPath }),
      env: fixture.env,
      ownerOptions: fixture.paths,
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  ), 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    watermark: "watermark:watch",
    request: requests.watch,
  });
  assert.deepEqual(calls, [
    { operation: "prepare", request: requests.prepare },
    { operation: "launch", request: requests.launch },
    { operation: "command", request: requests.command },
    { operation: "query", request: requests.query },
    { operation: "watch", request: requests.watch },
  ]);
});

test("public FlowRuntime clients expose exactly the five versioned operations", () => {
  const client = createFlowClient({ socketPath: "/tmp/flow-public-client-surface.sock" });
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Object.keys(client).sort(), [
    "command",
    "launch",
    "prepare",
    "query",
    "watch",
  ]);
});

test("owner tightens pre-existing endpoint and socket parent permissions", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const endpointParent = join(fixture.env.HOME, "endpoint-parent");
  const socketParent = join(fixture.env.HOME, "socket-parent");
  await mkdir(endpointParent, { recursive: true, mode: 0o755 });
  await mkdir(socketParent, { recursive: true, mode: 0o755 });
  const owner = createFlowOwner({
    runtime: {
      mutationAuthority: true,
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    },
    env: fixture.env,
    authorityDirectory: fixture.paths.authorityDirectory,
    endpointPath: join(endpointParent, "owner.json"),
    socketPath: join(socketParent, "owner.sock"),
  });
  await owner.start();
  t.after(() => owner.stop());

  assert.equal((await stat(endpointParent)).mode & 0o777, 0o700);
  assert.equal((await stat(socketParent)).mode & 0o777, 0o700);
});

test("CLI transport failures keep their bounded result shape for null requests", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  let stdout = "";
  let stderr = "";
  const status = await runCli(["query", "--input", "null", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  });
  assert.equal(status, 1);
  assert.equal(stdout, "");
  const rejection = JSON.parse(stderr);
  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "transport_unavailable");
});

test("CLI rejects an extra positional value after an input flag", async () => {
  let stdout = "";
  let stderr = "";
  const status = await runCli(
    ["query", "--input", '{"marker":"request"}', "unexpected", "--json"],
    {
      runtime: { query: async () => ({}) },
      stderr: { write: (chunk) => { stderr += chunk; } },
      stdout: { write: (chunk) => { stdout += chunk; } },
    },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^Usage:/u);
  assert.equal(stdout, "");
});

test("public lifecycle commands use disposable owner state", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  let stderr = "";
  let stdout = "";
  const status = await runCli(["start", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  });
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).state, "running");

  stdout = "";
  assert.equal(await runCli(["status", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  }), 0);
  assert.equal(JSON.parse(stdout).state, "running");

  stdout = "";
  assert.equal(await runCli(["start", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  }), 0);
  assert.equal(JSON.parse(stdout).already_running, true);

  const endpoint = JSON.parse(await readFile(fixture.paths.endpointPath, "utf8"));
  assert.equal((await stat(fixture.paths.authorityDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(fixture.paths.endpointPath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.paths.socketPath)).mode & 0o777, 0o600);
  const mismatch = await stopFlowOwner({
    ...fixture.paths,
    ownerToken: `${endpoint.owner_token}-wrong`,
  });
  assert.equal(mismatch.state, "owner_mismatch");
  const pidMismatch = await stopFlowOwner({
    ...fixture.paths,
    pid: endpoint.pid + 1,
  });
  assert.equal(pidMismatch.state, "owner_mismatch");
  assert.equal((await statusFlowOwner({ ...fixture.paths })).state, "running");

  stdout = "";
  assert.equal(await runCli(["stop", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  }), 0);
  assert.equal(JSON.parse(stdout).state, "stopped");
});

test("detached owner forwards runner capacity and exposes it through flow status", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  fixture.env.FLOW_RUNNER_DELEGATE_CAPACITY = "3";
  fixture.env.FLOW_RUNNER_OPERATION_CAPACITY = "2";

  const started = await startDetachedFixture(fixture);
  const client = createFlowClient({ socketPath: fixture.paths.socketPath });
  const runner = await client.query({
    schema: "flow.query/v1",
    query: "autonomous_runner_status",
  });
  assert.equal(runner.delegates.capacity, 3);
  assert.equal(runner.operations.capacity, 2);

  let stdout = "";
  let stderr = "";
  assert.equal(await runCli(["status", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  }), 0);
  assert.equal(stderr, "");
  const status = JSON.parse(stdout);
  assert.equal(status.state, "running");
  assert.equal(status.runner.delegates.capacity, 3);
  assert.equal(status.runner.operations.capacity, 2);

  const stopped = await stopFlowOwner({
    ...fixture.paths,
    waitMs: 1_000,
    pollMs: 10,
    force: true,
  });
  assert.equal(stopped.state, "stopped");

  const restarted = await startDetachedFixture(fixture, {
    runnerOptions: { delegateCapacity: 4, operationCapacity: 5 },
  });
  const restartedRunner = await createFlowClient({
    socketPath: fixture.paths.socketPath,
  }).query({
    schema: "flow.query/v1",
    query: "autonomous_runner_status",
  });
  assert.equal(restarted.state, "running");
  assert.equal(restartedRunner.delegates.capacity, 4);
  assert.equal(restartedRunner.operations.capacity, 5);
});

test("owner persists bounded private sanitized runner errors", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const secret = "token=owner-test-secret";
  const callbacks = [];
  const owner = createFlowOwner({
    ...fixture.paths,
    env: fixture.env,
    runtimeFactory: async ({ runnerErrorSink }) => {
      for (let index = 0; index < 24; index += 1) {
        const error = new Error(`${secret}-${index}`);
        error.code = "provider_secret_token";
        runnerErrorSink(error);
      }
      return authorizedRuntime({
        prepare: async () => ({}),
        launch: async () => ({}),
        command: async () => ({}),
        query: async () => ({}),
        watch: async () => oneObservationWatcher({}),
      });
    },
    onError: (error) => callbacks.push(error),
  });
  await owner.start();
  t.after(() => owner.stop());

  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(fixture.paths.operatorErrorPath, "utf8"))
        .count === 24;
    } catch {
      return false;
    }
  });
  const info = await stat(fixture.paths.operatorErrorPath);
  const bytes = await readFile(fixture.paths.operatorErrorPath, "utf8");
  const log = JSON.parse(bytes);
  assert.equal(info.mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(bytes) <= 32 * 1024);
  assert.equal(log.count, 24);
  assert.equal(log.suppressed, 8);
  assert.equal(log.entries.length, 16);
  assert.equal(log.entries.at(-1).code, "runner_error");
  assert.equal(bytes.includes(secret), false);
  assert.equal(bytes.includes("provider_secret_token"), false);
  assert.equal(callbacks.length, 24);
  assert.equal(callbacks.at(-1).message, "Autonomous runner error");
  assert.equal(callbacks.at(-1).code, "runner_error");

  const status = await statusFlowOwner({ ...fixture.paths });
  assert.equal(status.operator_errors.count, 24);
  assert.equal(status.operator_errors.suppressed, 8);
  assert.equal(status.operator_errors.last.code, "runner_error");

  let stdout = "";
  let stderr = "";
  assert.equal(await runCli(["status", "--json"], {
    env: fixture.env,
    ownerOptions: fixture.paths,
    stderr: { write: (chunk) => { stderr += chunk; } },
    stdout: { write: (chunk) => { stdout += chunk; } },
  }), 0);
  const cliStatus = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.equal(cliStatus.operator_errors.count, 24);
  assert.equal(cliStatus.operator_errors.last.code, "runner_error");
});

test("process identity fallback supports /proc-less hosts and fences reused PIDs", async (t) => {
  assert.equal(readProcessStartIdentity(42, {
    readProc: () => { throw new Error("/proc unavailable"); },
    readPs: () => "darwin-start-identity",
  }), "darwin-start-identity");

  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const owner = createFlowOwner({
    runtime: {
      mutationAuthority: true,
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    },
    ...fixture.paths,
    env: fixture.env,
    processStartIdentityReader: () => "darwin-start-identity",
  });
  await owner.start();
  t.after(() => owner.stop());
  assert.equal((await statusFlowOwner({
    ...fixture.paths,
    processStartIdentityReader: () => "darwin-start-identity",
  })).state, "running");
  assert.equal((await statusFlowOwner({
    ...fixture.paths,
    processStartIdentityReader: () => "reused-pid-identity",
  })).state, "stale");
  assert.equal((await statusFlowOwner({
    ...fixture.paths,
    processStartIdentityReader: () => null,
  })).state, "unknown");
});

test("detached start replaces a reused-PID endpoint without signalling that PID", async (t) => {
  const fixture = await disposableOwnerFixture(t);
  fixture.env.FLOW_OWNER_RUNTIME_MODULE = PUBLIC_OWNER_RUNTIME_MODULE;
  await mkdir(fixture.paths.authorityDirectory, { recursive: true, mode: 0o700 });
  const staleEndpoint = {
    schema: "flow.owner-endpoint/v1",
    version: 1,
    owner_token: "owner:reused-pid-stale",
    pid: process.pid,
    process_identity: "owner:reused-pid-stale",
    process_start_identity: "definitely-not-this-process-start",
    authority_directory: fixture.paths.authorityDirectory,
    endpoint_path: fixture.paths.endpointPath,
    socket_path: fixture.paths.socketPath,
    started_at: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(fixture.paths.endpointPath, `${JSON.stringify(staleEndpoint)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  assert.equal((await statusFlowOwner({ ...fixture.paths })).state, "stale");
  const started = await startDetachedFixture(fixture);
  assert.equal(started.state, "running");
  assert.notEqual(started.pid, process.pid);
  const replacement = JSON.parse(await readFile(fixture.paths.endpointPath, "utf8"));
  assert.notEqual(replacement.owner_token, staleEndpoint.owner_token);
  assert.notEqual(replacement.pid, process.pid);
});

test("owner start fails closed when an existing PID identity cannot be read", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const identity = "darwin-start-identity";
  const owner = createFlowOwner({
    runtime: {
      mutationAuthority: true,
      prepare: async () => ({}),
      launch: async () => ({}),
      command: async () => ({}),
      query: async () => ({}),
      watch: async () => oneObservationWatcher({}),
    },
    ...fixture.paths,
    env: fixture.env,
    processStartIdentityReader: () => identity,
  });
  await owner.start();
  t.after(() => owner.stop());

  await assert.rejects(
    startFlowOwner({
      ...fixture.paths,
      processStartIdentityReader: () => null,
      ownerScript: resolve("config/flow/test-support/missing-owner-entrypoint.mjs"),
      waitMs: 50,
      pollMs: 5,
    }),
    { code: "owner_identity_unavailable" },
  );
  assert.equal((await statusFlowOwner({
    ...fixture.paths,
    processStartIdentityReader: () => identity,
  })).state, "running");
});

test("long explicit socket paths are reduced to an AF_UNIX-safe endpoint", () => {
  const requestedSocketPath = join(tmpdir(), `flow-${"x".repeat(180)}.sock`);
  const paths = flowOwnerPaths({
    authorityDirectory: join(tmpdir(), "flow-portability-paths"),
    endpointPath: join(tmpdir(), "flow-portability-paths", "owner.json"),
    socketPath: requestedSocketPath,
  });
  assert.ok(Buffer.byteLength(paths.socketPath) < 100);
  assert.notEqual(paths.socketPath, requestedSocketPath);
  assert.notEqual(dirname(paths.socketPath), tmpdir());
});

test("a malformed endpoint is invalid rather than a stopped owner", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  await mkdir(fixture.paths.authorityDirectory, { recursive: true, mode: 0o700 });
  await writeFile(fixture.paths.endpointPath, "not-json\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  const invalid = await statusFlowOwner({ ...fixture.paths });
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.reason, "invalid_endpoint_record");

  const cleaned = await statusFlowOwner({ ...fixture.paths, cleanupStale: true });
  assert.equal(cleaned.state, "invalid");
  assert.equal(await exists(fixture.paths.endpointPath), true);
  assert.equal((await statusFlowOwner({ ...fixture.paths })).state, "invalid");
});

test("watch carries watermarks and returns the server iterator on client disconnect", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  let returnCalls = 0;
  let releasePending = null;
  let emittedInitial = false;
  let emittedLater = false;
  const iterator = {
    async next() {
      if (!emittedInitial) {
        emittedInitial = true;
        return {
          done: false,
          value: { watermark: "watermark:initial", value: "first" },
        };
      }
      if (!emittedLater) {
        emittedLater = true;
        return {
          done: false,
          value: { watermark: "watermark:later", value: "second" },
        };
      }
      return new Promise((resolve) => { releasePending = resolve; });
    },
    async return() {
      returnCalls += 1;
      releasePending?.({ done: true, value: undefined });
      releasePending = null;
      return { done: true, value: undefined };
    },
  };
  const runtime = {
    mutationAuthority: true,
    prepare: async () => ({}),
    launch: async () => ({}),
    command: async () => ({}),
    query: async () => ({}),
    watch: async () => ({
      [Symbol.asyncIterator]() {
        return iterator;
      },
    }),
  };
  const owner = createFlowOwner({ runtime, ...fixture.paths, env: fixture.env });
  await owner.start();
  t.after(() => owner.stop());

  const watcher = createFlowClient({ socketPath: fixture.paths.socketPath }).watch({
    run_id: "run:watch",
  });
  const first = await watcher.next();
  assert.deepEqual(first, {
    done: false,
    value: { watermark: "watermark:initial", value: "first" },
  });
  const second = await watcher.next();
  assert.deepEqual(second, {
    done: false,
    value: { watermark: "watermark:later", value: "second" },
  });
  await watcher.return();
  await waitFor(() => returnCalls === 1);
  assert.equal(returnCalls, 1);
});

async function disposableOwnerFixture(
  t,
  { cleanupOwner = true, production = false } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-process-"));
  const state = join(scratch, "state");
  const repository = join(scratch, "repository");
  const paths = flowOwnerPaths({
    env: { HOME: scratch, XDG_STATE_HOME: state },
    authorityDirectory: join(state, "flow"),
    endpointPath: join(state, "flow", "owner.json"),
    socketPath: join(state, "flow", "owner.sock"),
  });
  const env = {
    ...process.env,
    HOME: scratch,
    XDG_STATE_HOME: state,
    FLOW_AUTHORITY_DIRECTORY: paths.authorityDirectory,
    FLOW_OWNER_ENDPOINT_PATH: paths.endpointPath,
    FLOW_OWNER_SOCKET_PATH: paths.socketPath,
    ...(production ? { FLOW_PUBLIC_REPOSITORY: repository } : {}),
  };
  if (production) {
    await mkdir(repository, { recursive: true, mode: 0o700 });
    await writeFile(join(repository, "feature.txt"), "before\n");
    await initializePublicReviewRepository(repository);
  }
  t.after(async () => {
    if (!cleanupOwner) {
      await rm(scratch, { recursive: true, force: true });
      return;
    }
    const current = await statusFlowOwner({ ...paths, cleanupStale: false });
    if (["running", "starting"].includes(current.state)) {
      await stopFlowOwner({ ...paths, force: true, waitMs: 1000 });
    }
    await rm(scratch, { recursive: true, force: true });
  });
  return { env, paths, repository };
}

function authorizedRuntime(runtime) {
  return Object.freeze({ ...runtime, mutationAuthority: true });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function startDetachedFixture(fixture, options = {}) {
  return startFlowOwner({
    env: fixture.env,
    ...fixture.paths,
    waitMs: 3_000,
    pollMs: 10,
    ...options,
  });
}

function runCliProcess(env, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [
      FLOW_CLI_ENTRYPOINT,
      ...args,
    ], {
      cwd: resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

function gitObservation(repository) {
  return {
    commit_sha: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    status: execFileSync("git", [
      "-C",
      repository,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ], { encoding: "utf8" }).trim(),
  };
}

function materializeReviewAction(action, values) {
  if (action === undefined) return null;
  const { operator_input: _operatorInput, ...command } = action;
  return { ...command, ...values };
}

function oneObservationWatcher(observation) {
  let index = 0;
  return {
    async next() {
      if (index > 0) return { done: true, value: undefined };
      index += 1;
      return { done: false, value: observation };
    },
    async return() {
      index = 1;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for public-process condition");
}

function withTimeout(promise, timeoutMs = 500) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("timed out waiting for transport rejection");
      error.code = "test_timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function listenRawServer(server, socketPath) {
  return new Promise((resolveServer, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveServer();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeRawServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveServer) => server.close(resolveServer));
}

function rawTransportExchange(socketPath, payload, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolveExchange, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("timed out waiting for raw transport response"));
    }, timeoutMs);
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveExchange(Buffer.concat(chunks));
    };
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", (error) => {
      if (chunks.length === 0) finish(error);
    });
    socket.once("close", () => finish());
    socket.once("connect", () => socket.write(payload));
  });
}

function assertProtocolError(raw, code) {
  const frames = raw.toString("utf8").trim().split("\n").filter(Boolean);
  assert.equal(frames.length, 1);
  const response = JSON.parse(frames[0]);
  assert.equal(response.schema, "flow.transport-response/v1");
  assert.equal(response.interface, FLOW_RUNTIME_INTERFACE);
  assert.equal(response.version, 1);
  assert.equal(response.request_id, null);
  assert.equal(response.operation, null);
  assert.equal(response.ok, false);
  assert.equal(response.done, true);
  assert.deepEqual(response.error, {
    schema: FLOW_TRANSPORT_ERROR,
    version: 1,
    code,
  });
  assert.equal(Object.hasOwn(response, "result"), false);
}

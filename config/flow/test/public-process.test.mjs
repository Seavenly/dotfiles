import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  requestFrame,
  watchFlowTransport,
} from "../src/transport.mjs";
import { confirmedLaunchRequest } from "../../../tools/flow/test-support/dynamic-checkpoint.mjs";
import { registeredOperationProposal } from "../../../tools/flow/test-support/registered-operation.mjs";

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

test("malformed, multiple, and oversized frames fail closed with bounded errors", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const runtime = {
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

test("process identity fallback supports /proc-less hosts and fences reused PIDs", async (t) => {
  assert.equal(readProcessStartIdentity(42, {
    readProc: () => { throw new Error("/proc unavailable"); },
    readPs: () => "darwin-start-identity",
  }), "darwin-start-identity");

  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const owner = createFlowOwner({
    runtime: {
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

test("owner start fails closed when an existing PID identity cannot be read", async (t) => {
  const fixture = await disposableOwnerFixture(t, { cleanupOwner: false });
  const identity = "darwin-start-identity";
  const owner = createFlowOwner({
    runtime: {
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
  assert.equal((await statusFlowOwner({ ...fixture.paths })).state, "stopped");
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

async function disposableOwnerFixture(t, { cleanupOwner = true } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "flow-public-process-"));
  const state = join(scratch, "state");
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
  };
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
  return { env, paths };
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

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { runCli } from "../src/cli-command.mjs";
import { createFlowClient } from "../src/client.mjs";

const runId = `run:${"a".repeat(64)}`;
const finalWatermark = `sha256:${"b".repeat(64)}`;

function bounded(promise, label, milliseconds = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}

// A real owned Unix socket speaks the public protocol. The finite server is
// deliberately a transport fixture, never a Flow owner or authority. It reads
// no retained state and can only answer watch/query requests.
async function observationServer(t, frames) {
  const root = realpathSync(mkdtempSync("/tmp/flow-observe-public-")), socketPath = join(root, "view.sock");
  const sockets = new Set(), requests = [];
  let closeWatch;
  const watchClosed = new Promise(resolve => { closeWatch = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      socket.removeAllListeners("data");
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))); requests.push(request);
      const envelope = values => ({ schema: "flow.transport-response/v1", interface: "flow.runtime/v1", version: 1,
        request_id: request.request_id, operation: request.operation, ...values });
      if (request.operation === "watch") {
        socket.once("close", closeWatch);
        socket.end(frames.map(value => JSON.stringify(envelope(value)) + "\n").join(""));
      } else if (request.operation === "query") {
        socket.end(JSON.stringify(envelope({ ok: true, done: true, result: { schema: "flow.run-projection/v1", run_id: runId,
          phase: "active", sequence: 128, watermark: finalWatermark } })) + "\n");
      } else socket.destroy(new Error("Unexpected lifecycle request to read-only fixture"));
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), "owned fixture server did not close");
    rmSync(root, { recursive: true, force: true });
  });
  await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }), "owned fixture server did not listen");
  return { client: createFlowClient({ socketPath, timeoutMs: 1000 }), watchClosed, requests };
}

const observation = index => ({ ok: true, done: false, sequence: index, watermark: `fixture:${index}`, result: { index, watermark: `fixture:${index}` } });

test("public watch retains a terminal failure that arrived behind queued observations", async t => {
  const f = await observationServer(t, [observation(0), { ok: false, done: true, error: { schema: "flow.transport-error/v1", version: 1, code: "observation_fixture_failure" } }]);
  const watcher = f.client.watch({ run_id: runId }); t.after(() => watcher.return());
  await bounded(f.watchClosed, "client did not finish the finite watch response");
  assert.deepEqual(await bounded(watcher.next(), "queued observation missing"), { done: false, value: { index: 0, watermark: "fixture:0" } });
  await assert.rejects(bounded(watcher.next(), "retained watch failure missing"), { code: "observation_fixture_failure" });
  assert.deepEqual(f.requests.map(request => request.operation), ["watch"]);
});

test("a slow public watch consumer gets bounded FIFO observations then explicit backpressure failure", async t => {
  const frames = Array.from({ length: 128 }, (_, index) => observation(index));
  frames.push({ ok: true, done: true, sequence: 128 });
  const f = await observationServer(t, frames), watcher = f.client.watch({ run_id: runId }); t.after(() => watcher.return());
  // Socket closure proves the finite producer has been processed before the
  // consumer begins; this is deliberate queue pressure, not a timing sleep.
  await bounded(f.watchClosed, "client did not retire the bounded watch connection");
  const observed = []; let failure = null, ended = false;
  for (let index = 0; index <= 128; index++) {
    try {
      const item = await bounded(watcher.next(), "watch queue did not settle");
      if (item.done) { ended = true; break; }
      observed.push(item.value.index);
    } catch (error) { failure = error; break; }
  }
  assert.equal(failure?.code, "watch_backpressure_exceeded", `Unexpected watch completion: ended=${ended}; queued=${observed.length}`);
  assert.deepEqual(observed, Array.from({ length: 64 }, (_, index) => index));
  const fresh = await f.client.query({ run_id: runId });
  assert.equal(fresh.run_id, runId); assert.equal(fresh.watermark, finalWatermark);
  assert.deepEqual(f.requests.map(request => request.operation), ["watch", "query"]);
});

test("explicit watch return discards queued observations and retained failure", async t => {
  const f = await observationServer(t, [observation(0), { ok: false, done: true, error: { schema: "flow.transport-error/v1", version: 1, code: "observation_fixture_failure" } }]);
  const watcher = f.client.watch({ run_id: runId }); t.after(() => watcher.return());
  await bounded(f.watchClosed, "client did not finish the finite watch response");
  await watcher.return();
  assert.deepEqual(await bounded(watcher.next(), "returned watch remained live"), { done: true, value: undefined });
  assert.deepEqual(await bounded(watcher.next(), "returned watch reopened"), { done: true, value: undefined });
  assert.deepEqual(f.requests.map(request => request.operation), ["watch"]);
});


function blockedCliOutput(t) {
  const root = realpathSync(mkdtempSync("/tmp/flow-observe-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseFirst, firstWritten, held = true, pulls = 0, returns = 0, commands = 0;
  const firstWrite = new Promise(resolve => { firstWritten = resolve; }), written = [];
  const stdout = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    written.push(chunk.toString());
    if (held) { releaseFirst = callback; firstWritten(); }
    else queueMicrotask(callback);
  } });
  // Tests deliberately destroy the stream; collect its error rather than let
  // EventEmitter turn a controlled stdout failure into an uncaught exception.
  stdout.on("error", () => {});
  const watcher = { [Symbol.asyncIterator]() { return this; },
    next() { pulls++; return Promise.resolve(pulls <= 2 ? { done: false, value: { watermark: `fixture:${pulls}` } } : { done: true, value: undefined }); },
    return() { returns++; return Promise.resolve({ done: true, value: undefined }); } };
  const client = { watch(request) { assert.deepEqual(request, { run_id: runId }); return watcher; },
    command() { commands++; throw new Error("No lifecycle command belongs to output handling"); } };
  let stderr = "";
  const execution = runCli(["watch", "--input", JSON.stringify({ run_id: runId }), "--json"], {
    client, env: { HOME: root, XDG_STATE_HOME: root }, stdout, stderr: { write(chunk) { stderr += chunk; } },
  });
  t.after(async () => {
    held = false; releaseFirst?.(); stdout.destroy();
    await bounded(execution, "owned CLI fixture did not settle during cleanup");
  });
  return { stdout, firstWrite, execution, written, get pulls() { return pulls; }, get returns() { return returns; }, get commands() { return commands; }, get stderr() { return stderr; },
    release() { held = false; releaseFirst(); releaseFirst = null; } };
}

test("public CLI watch waits for stdout drain before pulling another observation", async t => {
  const f = blockedCliOutput(t); await bounded(f.firstWrite, "first CLI write missing");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pulls, 1, "stdout.write(false) must pause public watch iteration");
  f.release(); assert.equal(await bounded(f.execution, "CLI did not resume after drain"), 0);
  assert.equal(f.stderr, ""); assert.equal(f.commands, 0);
  assert.deepEqual(f.written.map(value => JSON.parse(value).watermark), ["fixture:1", "fixture:2"]);
});

for (const mode of ["error", "close"]) test(`public CLI stdout ${mode} while blocked releases the watch without cancellation`, async t => {
  const f = blockedCliOutput(t); await bounded(f.firstWrite, "first CLI write missing");
  f.stdout.destroy(mode === "error" ? new Error("owned stdout failure") : undefined);
  assert.equal(await bounded(f.execution, `CLI hung after stdout ${mode}`), 1);
  assert.equal(f.returns, 1, "output failure must close the exact public iterator");
  assert.equal(f.commands, 0); assert.ok(f.stderr.length, "output failure must remain visible");
});

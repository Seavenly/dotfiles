import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FLOW_RUNTIME_INTERFACE, FLOW_TRANSPORT_RESPONSE, watchFlowTransport } from "../src/transport.mjs";

async function fixture(t, connected) {
  const directory = await mkdtemp(join(tmpdir(), "flow-watch-")), path = join(directory, "s");
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    connected(socket);
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

test("return before connection completes never subscribes and closes the late socket", { timeout: 5000 }, async t => {
  let received = 0, peerClosed;
  const closed = new Promise(resolve => { peerClosed = resolve; });
  const path = await fixture(t, socket => {
    socket.on("data", bytes => { received += bytes.length; });
    socket.once("close", peerClosed);
  });
  const watcher = watchFlowTransport({ socketPath: path, request: {} });
  await watcher.return();
  await closed;
  assert.equal(received, 0);
  assert.deepEqual(await watcher.next(), { done: true, value: undefined });
});

test("public transport byte cap rejects a few individually valid large frames", { timeout: 5000 }, async t => {
  let peerClosed;
  const closed = new Promise(resolve => { peerClosed = resolve; });
  const path = await fixture(t, socket => {
    socket.once("close", peerClosed);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      socket.removeAllListeners("data");
      const request = JSON.parse(buffer.split("\n")[0]);
      for (let sequence = 0; sequence < 3; sequence++) socket.write(JSON.stringify({
        schema: FLOW_TRANSPORT_RESPONSE, interface: FLOW_RUNTIME_INTERFACE, version: 1,
        request_id: request.request_id, operation: "watch", ok: true, done: false, sequence,
        result: { watermark: String(sequence), payload: "x".repeat(3 * 1024 * 1024) },
      }) + "\n");
      socket.end();
    });
  });
  const watcher = watchFlowTransport({ socketPath: path, request: {} });
  await closed;
  for (let sequence = 0; sequence < 2; sequence++) assert.equal((await watcher.next()).value.watermark, String(sequence));
  await assert.rejects(watcher.next(), { code: "watch_backpressure_exceeded" });
  await watcher.return();
});

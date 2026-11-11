import test from "node:test";
import assert from "node:assert/strict";
import { createProjectionWatcher } from "../src/projection-watcher.mjs";

test("slow observers retain FIFO through the finite count limit then receive an explicit failure", async () => {
  let closed = 0;
  const watcher = createProjectionWatcher({ initialProjection: { watermark: "0" }, close: () => closed++ });
  for (let i = 1; i <= 128; i++) watcher.publish({ watermark: String(i) });
  for (let i = 0; i < 64; i++) assert.equal((await watcher.next()).value.watermark, String(i));
  await assert.rejects(watcher.next(), { code: "watch_backpressure_exceeded" });
  assert.equal(closed, 1);
  await watcher.return();
  assert.deepEqual(await watcher.next(), { done: true, value: undefined });
  assert.equal(closed, 1);
});

test("serialized byte budget bounds a few large queued observations, independently of count", async () => {
  let closed = 0;
  const watcher = createProjectionWatcher({ initialProjection: { watermark: "0" }, close: () => closed++ });
  const payload = "x".repeat(3 * 1024 * 1024);
  for (let i = 1; i <= 3; i++) watcher.publish({ watermark: String(i), payload });
  for (let i = 0; i < 3; i++) assert.equal((await watcher.next()).value.watermark, String(i));
  await assert.rejects(watcher.next(), { code: "watch_backpressure_exceeded" });
  assert.equal(closed, 1);
  await watcher.return();
});

test("an oversized initial observation closes after its subscription is registered", async () => {
  let registered = false, closed = 0;
  const watcher = createProjectionWatcher({ initialProjection: { watermark: "0", payload: "x".repeat(8 * 1024 * 1024) },
    close() { assert.equal(registered, true); closed++; } });
  registered = true;
  await assert.rejects(watcher.next(), { code: "watch_backpressure_exceeded" });
  assert.equal(closed, 1);
  await watcher.return();
  assert.deepEqual(await watcher.next(), { done: true, value: undefined });
});

test("explicit return discards buffered snapshots and resolves pending observation exactly once", async () => {
  let closed = 0;
  const watcher = createProjectionWatcher({ initialProjection: { watermark: "0" }, close: () => closed++ });
  watcher.publish({ watermark: "1" });
  await watcher.return();
  assert.deepEqual(await watcher.next(), { done: true, value: undefined });
  assert.equal(closed, 1);
  const pending = createProjectionWatcher({ initialProjection: { watermark: "a" }, close: () => closed++ });
  await pending.next();
  const observation = pending.next();
  await pending.return();
  assert.deepEqual(await observation, { done: true, value: undefined });
  assert.equal(closed, 2);
});

test("pending consumers receive exact changes without a queue or duplicate watermark", async () => {
  const watcher = createProjectionWatcher({ initialProjection: { watermark: "0" }, readProjection: () => ({ watermark: "0" }), close() {} });
  await watcher.next();
  const observation = watcher.next();
  watcher.publish({ watermark: "0" });
  watcher.publish({ watermark: "1", sequence: 1 });
  assert.deepEqual((await observation).value, { watermark: "1", sequence: 1 });
  await watcher.return();
});

test("poll read exceptions fail only the observer and remain sticky until explicit return", async () => {
  let reads = 0, closed = 0;
  const watcher = createProjectionWatcher({ initialProjection: { watermark: "0" }, pollInterval: 1,
    readProjection() { reads++; throw new Error("private diagnostic must not escape"); }, close: () => closed++ });
  await watcher.next();
  await assert.rejects(watcher.next(), { code: "watch_read_failed" });
  await assert.rejects(watcher.next(), { code: "watch_read_failed" });
  assert.equal(reads, 1);
  assert.equal(closed, 1);
  await watcher.return();
});

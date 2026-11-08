import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireFileLock } from "../src/file-lock.mjs";

test("file locks recover stale malformed owners and interrupted candidates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, "review.lock");
  const candidate = `${lock}.candidate.999999:interrupted`;
  await writeFile(lock, "{truncated");
  await writeFile(candidate, "stale candidate\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  const release = await acquireFileLock(lock, {
    malformedGraceMs: 10,
    retries: 2,
    retryDelayMs: 1,
  });
  const owner = JSON.parse(await readFile(lock, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal((await readdir(directory)).some((entry) => entry.includes("999999")), false);
  await release();
  assert.deepEqual(await readdir(directory), []);
});

test("file locks do not reclaim a recently malformed owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-lock-busy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, "review.lock");
  await writeFile(lock, "{truncated");

  await assert.rejects(
    acquireFileLock(lock, { malformedGraceMs: 60_000, retries: 1 }),
    /resource is busy/,
  );
});

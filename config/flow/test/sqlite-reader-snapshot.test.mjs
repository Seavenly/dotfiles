import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  readAuthorityStream,
  replayAuthorityStream,
} from "../../../tools/flow/src/sqlite-authority-replay.mjs";
import { seedProjectionHistory } from "../src/host-recovery-reader-support.mjs";
import {
  createQualificationIsolation,
  isolatedQualificationEnvironment,
} from "../src/host-recovery-qualification.mjs";
import {
  closeFlowRuntime,
  createFlowRuntime,
  flowRuntimeMutationAuthority,
} from "../src/runtime.mjs";

const WORKTREE = resolve(import.meta.dirname, "../../..");
const WORKER = resolve(import.meta.dirname, "../test-support/sqlite-reader-snapshot-worker.mjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "flow-reader-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolation = createQualificationIsolation({
    worktreeRoot: WORKTREE,
    xdgStateHome: join(root, "state"),
    authorityDirectory: join(root, "authority"),
    socketPath: join(root, "authority", "owner.sock"),
    endpointPath: join(root, "authority", "owner.json"),
    backupDirectory: join(root, "backup"),
    repositoryRoot: join(root, "repository"),
    drovrConfigDirectory: join(root, "drovr"),
    qualificationWorkspace: join(root, "qualification"),
    herdrSession: "herdr:reader-snapshot",
    runId: "run:reader-snapshot",
  });
  return { root, isolation, env: isolatedQualificationEnvironment(isolation) };
}

function inspectRuntime(value) {
  return createFlowRuntime({
    env: value.env,
    authorityDirectory: value.isolation.authority_directory,
    authorityOptions: { access: "inspect" },
    autonomous: false,
  });
}

test("production inspect query snapshots a real concurrent checkpoint append", async (t) => {
  const value = await fixture(t);
  const configuration = join(value.root, "isolation.json");
  writeFileSync(configuration, JSON.stringify(value.isolation), { mode: 0o600 });
  const child = spawn(process.execPath, [WORKER, configuration, value.root], {
    env: value.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const originalPrepare = DatabaseSync.prototype.prepare;
  let runtime = null;
  let headReads = 0;
  let capturedHead = null;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(value.root, "ready"))) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, "writer did not commit five real history entries");
      await delay(25);
    }
    runtime = inspectRuntime(value);
    assert.equal(flowRuntimeMutationAuthority(runtime), false);
    const lock = new DatabaseSync(join(value.isolation.authority_directory, "authority.lock.sqlite"));
    try {
      assert.throws(() => lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"),
        (error) => error.errcode === 5);
    } finally {
      lock.close();
    }
    DatabaseSync.prototype.prepare = function prepare(sql) {
      const statement = originalPrepare.call(this, sql);
      if (!/SELECT \* FROM authority_streams WHERE stream_id = \?/u.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === "get") return (...args) => {
            const result = target.get(...args);
            if (args[0] === "host:runs" && ++headReads === 2) {
              capturedHead = Number(result.head_sequence);
              writeFileSync(join(value.root, "release"), "append sixth checkpoint");
              const deadline = Date.now() + 10_000;
              while (!existsSync(join(value.root, "done"))) {
                assert.ok(Date.now() < deadline, "real writer append did not complete");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
            }
            return result;
          };
          const result = Reflect.get(target, key);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
    };
    const before = runtime.query({});
    DatabaseSync.prototype.prepare = originalPrepare;
    const after = runtime.query({});
    t.diagnostic(JSON.stringify({ capturedHead, before, after }));
    assert.equal(capturedHead, 5);
    assert.equal(before.schema, "flow.run-index-projection/v1",
      "a committed owner append must not appear as corrupt history");
    assert.equal(before.runs.length, 5);
    assert.equal(after.schema, "flow.run-index-projection/v1");
    assert.equal(after.runs.length, 6);
    assert.equal(flowRuntimeMutationAuthority(runtime), false);
    const releasedLock = new DatabaseSync(join(value.isolation.authority_directory, "authority.lock.sqlite"));
    try {
      // The inspector remains open but owns no mutation lock after the writer exits.
      releasedLock.exec("BEGIN IMMEDIATE; ROLLBACK;");
    } finally {
      releasedLock.close();
    }
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    if (runtime !== null) await closeFlowRuntime(runtime);
    if (!existsSync(join(value.root, "release"))) {
      writeFileSync(join(value.root, "release"), "retire owned writer");
    }
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    t.diagnostic(JSON.stringify({ writer_pid: child.pid, exit: code, signal, reaped: true }));
  }
});

for (const begin of ["BEGIN", "BEGIN IMMEDIATE"]) {
  test(`replay preserves the caller-owned ${begin} transaction`, async (t) => {
    const value = await fixture(t);
    assert.equal(seedProjectionHistory({ isolation: value.isolation, environment: value.env }).status, "pass");
    const database = new DatabaseSync(join(value.isolation.authority_directory, "authority.sqlite"));
    try {
      database.exec(begin);
      assert.equal(readAuthorityStream(database, "host:runs").records.length, 6);
      assert.equal(database.isTransaction, true);
      assert.equal(replayAuthorityStream(database, "host:runs").records.length, 6);
      assert.equal(database.isTransaction, true);
      assert.equal(readAuthorityStream(database, "host:missing"), null);
      assert.equal(database.isTransaction, true);
      database.exec("ROLLBACK");
      assert.equal(database.isTransaction, false);
    } finally {
      database.close();
    }
  });
}

for (const reason of ["omission", "duplication", "fold_mismatch"]) {
  test(`production inspect still rejects genuine ${reason} corruption`, async (t) => {
    const value = await fixture(t);
    assert.equal(seedProjectionHistory({ isolation: value.isolation, environment: value.env }).status, "pass");
    const database = new DatabaseSync(join(value.isolation.authority_directory, "authority.sqlite"));
    try {
      if (reason === "omission") {
        database.exec("DROP TRIGGER authority_events_no_delete;");
        database.exec("DELETE FROM authority_events WHERE stream_id = 'host:runs' AND sequence = 6;");
      } else if (reason === "duplication") {
        database.exec(`INSERT INTO authority_events
          SELECT stream_id, 7, generation, contract, payload_json, payload_digest,
                 previous_digest, record_digest, authority_epoch, boot_id, process_identity
            FROM authority_events WHERE stream_id = 'host:runs' AND sequence = 6;`);
      } else {
        database.exec("UPDATE authority_streams SET fold_json = '{}' WHERE stream_id = 'host:runs';");
      }
    } finally {
      database.close();
    }
    const runtime = inspectRuntime(value);
    try {
      const rejection = runtime.query({});
      assert.equal(rejection.schema, "flow.rejection/v1");
      assert.equal(rejection.code, "authority_integrity_failure");
      assert.equal(rejection.reason, reason);
      assert.equal(rejection.authority_watermark, null);
      assert.deepEqual(rejection.legal_actions, []);
    } finally {
      await closeFlowRuntime(runtime);
    }
  });
}

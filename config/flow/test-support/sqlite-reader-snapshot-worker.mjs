import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { seedProjectionHistory } from "../src/host-recovery-reader-support.mjs";
import { isolatedQualificationEnvironment } from "../src/host-recovery-qualification.mjs";

const isolation = JSON.parse(readFileSync(process.argv[2], "utf8"));
const directory = process.argv[3];
const originalExec = DatabaseSync.prototype.exec;
let paused = false;

// Commit real checkpoint history before pausing its sole writer. The parent
// releases the sixth append between its stream-head and event-row SELECTs.
DatabaseSync.prototype.exec = function exec(sql) {
  const result = originalExec.call(this, sql);
  if (!paused && sql === "COMMIT") {
    const head = this.prepare(`
      SELECT head_sequence FROM authority_streams WHERE stream_id = 'host:runs'
    `).get();
    if (Number(head?.head_sequence) === 5) {
      paused = true;
      writeFileSync(join(directory, "ready"), JSON.stringify(head));
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(directory, "release"))) {
        assert.ok(Date.now() < deadline, "reader did not release the owned writer");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  return result;
};

try {
  const seed = seedProjectionHistory({
    isolation,
    environment: isolatedQualificationEnvironment(isolation),
  });
  assert.equal(seed.status, "pass");
  assert.equal(seed.history_entries, 6);
  writeFileSync(join(directory, "done"), JSON.stringify(seed));
} finally {
  DatabaseSync.prototype.exec = originalExec;
}

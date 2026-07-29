import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRecords, writeRecord } from "../src/registry.mjs";

test("registry reads reject unsafe directory permissions without repairing them", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-permissions-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-1",
  });
  await chmod(registryDirectory, 0o755);

  await assert.rejects(readRecords(registryDirectory, "groups"), {
    code: 3,
    outcome: "unsafe_state_permissions",
  });
  assert.equal((await stat(registryDirectory)).mode & 0o777, 0o755);
});

test("registry reads reject unsafe record-directory permissions", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-record-permissions-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const groupDirectory = join(registryDirectory, "groups");
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-1",
  });
  await chmod(groupDirectory, 0o755);

  await assert.rejects(readRecords(registryDirectory, "groups"), {
    code: 3,
    outcome: "unsafe_state_permissions",
  });
  assert.equal((await stat(groupDirectory)).mode & 0o777, 0o755);
});

test("registry reads reject unsafe record-file permissions", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-record-file-permissions-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const record = {
    schema: "drovr.group/v1",
    id: "group-1",
  };
  const recordFile = join(registryDirectory, "groups", `${record.id}.json`);
  await writeRecord(registryDirectory, "groups", record);
  await chmod(recordFile, 0o644);

  await assert.rejects(readRecords(registryDirectory, "groups"), {
    code: 3,
    outcome: "unsafe_state_permissions",
  });
  assert.equal((await stat(recordFile)).mode & 0o777, 0o644);
});

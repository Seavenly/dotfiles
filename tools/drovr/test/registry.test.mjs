import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  acquireResourceLock,
  readResourceLock,
  readRecords,
  reconcileResourceLock,
  registryLockOptions,
  registryOperation,
  registryWatermark,
  releaseResourceLock,
  resourceLockPath,
  resourceLockProjection,
  withOrderedResourceLocks,
  withResourceLock,
  writeRecord,
} from "../src/registry.mjs";

const execFileAsync = promisify(execFile);
const registryModule = new URL("../src/registry.mjs", import.meta.url).href;

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

test("lock publication leaves no authoritative lock when token publication fails", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-publish-token-fault-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  await assert.rejects(acquireResourceLock(directory, "resource-1", {
    operationId: "operation-1",
    authorityId: "authority-1",
    fs: { link: async () => { const error = new Error("token link failed"); error.code = "EIO"; throw error; } },
  }), { code: "EIO" });
  assert.equal((await readResourceLock(directory, "resource-1")).status, "absent");
});

test("lock publication cleans the non-authoritative token when canonical publication fails", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-publish-canonical-fault-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  let links = 0;
  await assert.rejects(acquireResourceLock(directory, "resource-1", {
    operationId: "operation-1",
    authorityId: "authority-1",
    fs: { link: async (source, target) => { if (++links === 2) { const error = new Error("canonical link failed"); error.code = "EIO"; throw error; } return link(source, target); } },
  }), { code: "EIO" });
  assert.equal((await readResourceLock(directory, "resource-1")).status, "absent");
  assert.deepEqual(await readdir(join(directory, "locks")), []);
});

test("lock readers reject incomplete and wrong-schema lock documents as corruption", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-schema-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  const locks = join(directory, "locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const filePath = resourceLockPath(directory, "resource-1");
  await writeFile(filePath, JSON.stringify({ schema: "drovr.registry-lock/v1" }));
  await chmod(filePath, 0o600);
  await assert.rejects(readResourceLock(directory, "resource-1"), { outcome: "corrupt_registry" });

  await rm(filePath, { force: true });
  await mkdir(filePath, { mode: 0o700 });
  await writeFile(join(filePath, "owner.json"), JSON.stringify({ schema: "wrong/v1" }));
  await chmod(join(filePath, "owner.json"), 0o600);
  await assert.rejects(readResourceLock(directory, "resource-1"), { outcome: "corrupt_registry" });
});

test("resource lock acquisition records exact owner, operation, and registry watermark", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-identity-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-1",
  });

  let observed;
  await withResourceLock(
    registryDirectory,
    "group-key:group-1",
    async (lock) => {
      observed = lock;
    },
    {
      operationId: "operation-1",
      authorityId: "authority-1",
    },
  );

  assert.equal(observed.resource_key, "group-key:group-1");
  assert.equal(observed.operation.id, "operation-1");
  assert.equal(observed.operation.kind, "registry_mutation");
  assert.equal(observed.owner.authority_id, "authority-1");
  assert.equal(observed.owner.process_identity.pid, process.pid);
  assert.match(observed.acquisition_watermark.registry_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(observed.acquisition_watermark.groups_count, 1);
});

test("a live competing owner is blocked without age-based takeover", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-competing-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const first = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-1",
    authorityId: "authority-1",
    maxAttempts: 0,
  });

  await assert.rejects(
    () =>
      acquireResourceLock(registryDirectory, "resource-1", {
        operationId: "operation-2",
        authorityId: "authority-2",
        maxAttempts: 0,
      }),
    (error) => {
      assert.equal(error.outcome, "registry_locked");
      assert.equal(error.details.owner_status, "live");
      assert.deepEqual(error.details.legal_next_actions, ["status"]);
      return true;
    },
  );
  assert.equal((await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id, first.metadata.lock_id);
  await releaseResourceLock(first);
});

test("malformed process identity cannot prove owner absence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-process-evidence-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const predecessor = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-malformed",
    processIdentity: {
      schema: "not-drovr-process-identity",
      pid: -1,
      start_token: "",
    },
  });

  await assert.rejects(
    () =>
      acquireResourceLock(
        registryDirectory,
        "resource-1",
        registryLockOptions(
          registryOperation("task.close", "task-1"),
          { maxAttempts: 0 },
        ),
      ),
    (error) => {
      assert.equal(error.outcome, "corrupt_registry");
      return true;
    },
  );
  await rm(resourceLockPath(registryDirectory, "resource-1"), { force: true });
});

test("terminated owner recovery requires exact absence evidence", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-lost",
    authorityId: "authority-lost",
    processIdentity: {
      schema: "drovr.process-identity/v1",
      pid: 999999,
      boot_id: "boot-1",
      start_token: "1",
    },
  });

  let recoveryInput;
  const replacement = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-new",
    authorityId: "authority-new",
    recover: async (input) => {
      recoveryInput = input;
      return {
        action: "proven_absence",
        evidence: {
          kind: "operation_absence",
          operation_id: input.lock.operation.id,
          operation_kind: input.lock.operation.kind,
          owner_status: input.owner_status,
          process_identity: input.lock.owner.process_identity,
        },
        authority_watermark: input.authority_watermark,
      };
    },
  });

  assert.equal(recoveryInput.owner_status, "absent");
  assert.equal(recoveryInput.lock.operation.id, "operation-lost");
  assert.equal(replacement.metadata.operation.id, "operation-new");
  await releaseResourceLock(replacement);
});

test("continuing-operation recovery adopts the exact operation with a new process authority", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-adoption-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const predecessor = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-continuing",
    authorityId: "authority-old",
    processIdentity: {
      schema: "drovr.process-identity/v1",
      pid: 999999,
      boot_id: "boot-1",
      start_token: "1",
    },
  });

  const adopted = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-continuing",
    authorityId: "authority-new",
    recover: async (input) => ({
      action: "adopt",
      evidence: {
        kind: "continuing_operation",
        operation_id: input.lock.operation.id,
        operation_kind: input.lock.operation.kind,
        owner_status: input.owner_status,
        process_identity: input.lock.owner.process_identity,
        receipt: "resume-1",
      },
      authority_watermark: input.authority_watermark,
    }),
  });
  assert.equal(adopted.metadata.operation.id, predecessor.metadata.operation.id);
  assert.equal(adopted.metadata.owner.authority_id, "authority-new");
  assert.notEqual(adopted.metadata.lock_id, predecessor.metadata.lock_id);
  await releaseResourceLock(adopted);
});

test("recovery rejects claimed absence while the current owner is live", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-live-recovery-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const predecessor = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-live",
  });
  const evidence = {
    operation_id: predecessor.metadata.operation.id,
    operation_kind: predecessor.metadata.operation.kind,
    owner_status: "absent",
    process_identity: predecessor.metadata.owner.process_identity,
  };

  for (const action of ["adopt", "proven_absence"]) {
    await assert.rejects(
      async () =>
        reconcileResourceLock(
          registryDirectory,
          "resource-1",
          {
            action,
            evidence: {
              kind: action === "adopt"
                ? "continuing_operation"
                : "operation_absence",
              ...evidence,
            },
            authority_watermark: await registryWatermark(registryDirectory),
          },
          { ownerLiveness: async () => "live" },
        ),
      (error) => {
        assert.equal(error.outcome, "registry_lock_recovery_evidence_invalid");
        assert.equal(error.details.owner_status, "live");
        return true;
      },
    );
  }
  assert.equal(
    (await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id,
    predecessor.metadata.lock_id,
  );
  await releaseResourceLock(predecessor);
});

test("operation payload identity fences retries with changed invocation facts", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-payload-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const predecessor = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("task.close", "task-1", { force: false }),
    authorityId: "authority-lost",
    processIdentity: {
      schema: "drovr.process-identity/v1",
      pid: 999999,
      boot_id: "boot-1",
      start_token: "1",
    },
  });
  const retry = registryOperation("task.close", "task-1", { force: true });

  await assert.rejects(
    () =>
      acquireResourceLock(
        registryDirectory,
        "resource-1",
        registryLockOptions(retry, { maxAttempts: 0 }),
      ),
    { outcome: "registry_lock_recovery_required" },
  );
  assert.equal(
    (await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id,
    predecessor.metadata.lock_id,
  );
  await reconcileResourceLock(registryDirectory, "resource-1", {
    action: "proven_absence",
    evidence: {
      kind: "operation_absence",
      operation_id: predecessor.metadata.operation.id,
      operation_kind: predecessor.metadata.operation.kind,
      operation_payload_digest: predecessor.metadata.operation.payload_digest,
      owner_status: "absent",
      process_identity: predecessor.metadata.owner.process_identity,
    },
    authority_watermark: await registryWatermark(registryDirectory),
  });
});

test("automatic recovery blocks a different semantic operation on the same resource", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-operation-fence-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const predecessor = await acquireResourceLock(
    registryDirectory,
    "resource-1",
    {
      operation: registryOperation("task.close", "task-1"),
      authorityId: "authority-lost",
      processIdentity: {
        schema: "drovr.process-identity/v1",
        pid: 999999,
        boot_id: "boot-1",
        start_token: "1",
      },
    },
  );

  await assert.rejects(
    () =>
      acquireResourceLock(
        registryDirectory,
        "resource-1",
        registryLockOptions(registryOperation("agent.retire", "agent-1"), {
          maxAttempts: 0,
        }),
      ),
    (error) => {
      assert.equal(error.outcome, "registry_lock_recovery_required");
      assert.deepEqual(error.details.legal_next_actions, ["task_close"]);
      return true;
    },
  );
  assert.equal(
    (await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id,
    predecessor.metadata.lock_id,
  );
  const heldWatermark = await registryWatermark(registryDirectory);
  await assert.rejects(
    () =>
      reconcileResourceLock(registryDirectory, "resource-1", {
        action: "abandon",
        abandonment_type: "operator_disposition",
        evidence: { kind: "operator_disposition", reference: "held-lock" },
        authority_watermark: heldWatermark,
      }),
    { outcome: "registry_lock_recovery_evidence_invalid" },
  );
  await reconcileResourceLock(registryDirectory, "resource-1", {
    action: "proven_absence",
    evidence: {
      kind: "operation_absence",
      operation_id: predecessor.metadata.operation.id,
      operation_kind: predecessor.metadata.operation.kind,
      owner_status: "absent",
      process_identity: predecessor.metadata.owner.process_identity,
    },
    authority_watermark: await registryWatermark(registryDirectory),
  });
});

test("recovery rejects a stale watermark without changing the surviving lock", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-stale-watermark-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const predecessor = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-lost",
    authorityId: "authority-lost",
    processIdentity: {
      schema: "drovr.process-identity/v1",
      pid: 999999,
      boot_id: "boot-1",
      start_token: "1",
    },
  });
  const stale = await registryWatermark(registryDirectory);
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-after-lock",
  });

  await assert.rejects(
      () =>
      reconcileResourceLock(registryDirectory, "resource-1", {
        action: "proven_absence",
        evidence: {
          kind: "operation_absence",
          operation_id: predecessor.metadata.operation.id,
          operation_kind: predecessor.metadata.operation.kind,
          owner_status: "absent",
          process_identity: predecessor.metadata.owner.process_identity,
        },
        authority_watermark: stale,
      }),
    { outcome: "registry_lock_recovery_evidence_invalid" },
  );
  assert.equal((await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id, predecessor.metadata.lock_id);
  await reconcileResourceLock(registryDirectory, "resource-1", {
    action: "proven_absence",
    evidence: {
      kind: "operation_absence",
      operation_id: predecessor.metadata.operation.id,
      operation_kind: predecessor.metadata.operation.kind,
      owner_status: "absent",
      process_identity: predecessor.metadata.owner.process_identity,
    },
    authority_watermark: await registryWatermark(registryDirectory),
  });
});

test("release is idempotent and an old owner cannot remove a successor", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-successor-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const first = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-1",
    authorityId: "authority-1",
  });
  await rm(resourceLockPath(registryDirectory, "resource-1"), {
    recursive: true,
    force: true,
  });
  const successor = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "operation-2",
    authorityId: "authority-2",
  });

  assert.deepEqual(await releaseResourceLock(first), {
    status: "successor_owner",
    resource_key: "resource-1",
    expected_lock_id: first.metadata.lock_id,
    observed_lock_id: successor.metadata.lock_id,
    already_released: true,
  });
  assert.equal((await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id, successor.metadata.lock_id);
  assert.deepEqual(await releaseResourceLock(successor), {
    status: "released",
    lock_id: successor.metadata.lock_id,
  });
  assert.deepEqual(await releaseResourceLock(successor), {
    status: "released",
    already_released: true,
  });
});

test("release validates the lock document content before claiming its token", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-content-fence-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const handle = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-1",
  });
  const lockPath = resourceLockPath(registryDirectory, "resource-1");
  const forged = JSON.parse(await readFile(lockPath, "utf8"));
  forged.owner.authority_id = "forged-authority";
  await writeFile(lockPath, `${JSON.stringify(forged)}\n`, "utf8");

  const result = await releaseResourceLock(handle);
  assert.equal(result.status, "successor_owner");
  assert.equal((await readResourceLock(registryDirectory, "resource-1")).status, "held");
});

test("concurrent old releases cannot remove a successor after one unlink", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-release-race-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const key = "resource-1";
  const first = await acquireResourceLock(registryDirectory, key, {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-old",
  });
  const second = { ...first, released: false };
  let successor;
  let releaseSuccessor;
  const successorReady = new Promise((resolve) => {
    releaseSuccessor = resolve;
  });
  let firstUnlink = true;
  const canonicalPath = resourceLockPath(registryDirectory, key);
  const fs = {
    rm: async (path, options) => {
      if (path !== canonicalPath) return rm(path, options);
      if (firstUnlink) {
        firstUnlink = false;
        const result = await rm(path, options);
        successor = await acquireResourceLock(registryDirectory, key, {
          operation: registryOperation("agent.retire", "agent-1"),
          authorityId: "authority-successor",
        });
        releaseSuccessor();
        return result;
      }
      await successorReady;
      return rm(path, options);
    },
  };
  first.fs = fs;
  second.fs = fs;

  await Promise.all([
    releaseResourceLock(first),
    releaseResourceLock(second),
  ]);
  assert.equal(
    (await readResourceLock(registryDirectory, key)).metadata.lock_id,
    successor.metadata.lock_id,
  );
  await releaseResourceLock(successor);
});

test("simultaneous token claims never recreate a missing token or unlink a successor", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-claim-barrier-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  const key = "resource-1";
  const first = await acquireResourceLock(directory, key, {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-old",
  });
  const second = { ...first, released: false };
  const canonicalPath = resourceLockPath(directory, key);
  let claimReady;
  let releaseClaimReady;
  const claimEntered = new Promise((resolve) => { claimReady = resolve; });
  const secondStarted = new Promise((resolve) => { releaseClaimReady = resolve; });
  let canonicalRemovals = 0;
  let successor;
  const fs = {
    rename: async (source, target) => {
      const result = await import("node:fs/promises").then(({ rename }) => rename(source, target));
      if (target.endsWith(".claim")) {
        claimReady();
        await secondStarted;
      }
      return result;
    },
    rm: async (path, options) => {
      if (path !== canonicalPath) return rm(path, options);
      canonicalRemovals += 1;
      const result = await rm(path, options);
      successor = await acquireResourceLock(directory, key, {
        operation: registryOperation("agent.retire", "agent-1"),
        authorityId: "authority-successor",
      });
      return result;
    },
  };
  first.fs = fs;
  second.fs = fs;
  const firstRelease = releaseResourceLock(first);
  await claimEntered;
  const secondRelease = releaseResourceLock(second);
  releaseClaimReady();
  await Promise.all([firstRelease, secondRelease]);
  assert.equal(canonicalRemovals, 1);
  assert.equal((await readResourceLock(directory, key)).metadata.lock_id, successor.metadata.lock_id);
  await releaseResourceLock(successor);
});

test("an absent claimant can be reclaimed after an unlink failure", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-stale-claim-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  const key = "resource-1";
  const handle = await acquireResourceLock(directory, key, { operationId: "operation-1", authorityId: "authority-1" });
  const lockPath = resourceLockPath(directory, key);
  const token = (await readdir(join(directory, "locks"))).find((name) => name.endsWith(".token"));
  await rm(join(directory, "locks", token), { force: true });
  await link(lockPath, join(directory, "locks", `${token}.999999.unknown.12345.dead.claim`));
  const result = await releaseResourceLock(handle);
  assert.equal(result.status, "released");
  assert.equal((await readResourceLock(directory, key)).status, "absent");
});

test("live or unproven claimants cannot be stolen", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-live-claim-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  const key = "resource-1";
  const handle = await acquireResourceLock(directory, key, { operationId: "operation-1", authorityId: "authority-1" });
  const lockPath = resourceLockPath(directory, key);
  const token = (await readdir(join(directory, "locks"))).find((name) => name.endsWith(".token"));
  await rm(join(directory, "locks", token), { force: true });
  const identity = handle.metadata.owner.process_identity;
  await link(lockPath, join(directory, "locks", `${token}.${identity.pid}.${encodeURIComponent(identity.boot_id ?? "unknown")}.${encodeURIComponent(identity.start_token ?? "unknown")}.live.claim`));
  const result = await releaseResourceLock(handle);
  assert.equal(result.status, "successor_owner");
  assert.equal((await readResourceLock(directory, key)).status, "held");
  await rm(lockPath, { force: true });
});

test("malformed claim metadata is a typed blocking state", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-malformed-claim-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "drovr");
  const key = "resource-1";
  const handle = await acquireResourceLock(directory, key, { operationId: "operation-1", authorityId: "authority-1" });
  const lockPath = resourceLockPath(directory, key);
  const token = (await readdir(join(directory, "locks"))).find((name) => name.endsWith(".token"));
  await rm(join(directory, "locks", token), { force: true });
  await link(lockPath, join(directory, "locks", `${token}.malformed.claim`));
  await assert.rejects(releaseResourceLock(handle), (error) => {
    assert.equal(error.outcome, "registry_lock_recovery_required");
    assert.equal(error.details.owner_status, "unproven");
    assert.deepEqual(error.details.legal_next_actions, ["status"]);
    assert.match(error.details.authority_watermark.registry_sha256, /^sha256:[0-9a-f]{64}$/u);
    return true;
  });
  await rm(lockPath, { force: true });
});

test("partial multi-lock acquisition releases only locks owned by the failed operation", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-partial-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const unrelated = await acquireResourceLock(registryDirectory, "b", {
    operationId: "unrelated-operation",
    authorityId: "unrelated-authority",
  });

  await assert.rejects(
    () =>
      withOrderedResourceLocks(
        registryDirectory,
        ["a", "b", "c"],
        async () => "unreachable",
        { operationId: "failed-operation", authorityId: "failed-authority", maxAttempts: 0 },
      ),
    { outcome: "registry_locked" },
  );
  assert.equal((await readResourceLock(registryDirectory, "a")).status, "absent");
  assert.equal((await readResourceLock(registryDirectory, "b")).metadata.lock_id, unrelated.metadata.lock_id);
  assert.equal((await readResourceLock(registryDirectory, "c")).status, "absent");
  await releaseResourceLock(unrelated);
});

test("bare lock directories are blocked until typed reconciliation", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-bare-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const path = resourceLockPath(registryDirectory, "resource-1");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const staleWatermark = await registryWatermark(registryDirectory);
  await writeRecord(registryDirectory, "groups", {
    schema: "drovr.group/v1",
    id: "group-before-bare-abandonment",
  });

  await assert.rejects(
    () => acquireResourceLock(registryDirectory, "resource-1", { maxAttempts: 0 }),
    (error) => {
      assert.equal(error.outcome, "registry_lock_recovery_required");
      assert.equal(error.details.owner_status, "unproven");
      assert.deepEqual(error.details.legal_next_actions, [
        "abandon_bare_registry_lock",
      ]);
      return true;
    },
  );
  await assert.rejects(
    () =>
      reconcileResourceLock(registryDirectory, "resource-1", {
        action: "abandon",
        abandonment_type: "operator_disposition",
      evidence: {
        kind: "operator_disposition",
        decision_id: "review-stale-bare",
      },
        authority_watermark: staleWatermark,
      }),
    { outcome: "registry_lock_recovery_evidence_invalid" },
  );
  const report = await reconcileResourceLock(
    registryDirectory,
    "resource-1",
    {
      action: "abandon",
      abandonment_type: "operator_disposition",
      evidence: {
        kind: "operator_disposition",
        decision_id: "review-1",
      },
      authority_watermark: await registryWatermark(registryDirectory),
    },
  );
  assert.equal(report.status, "abandoned");
  assert.equal(report.legal_next_actions[0], "acquire_registry_lock");
  const projection = await resourceLockProjection(registryDirectory);
  assert.equal(projection.status, "clear");
  assert.match(projection.authority_watermark.registry_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(projection.legal_next_actions, ["acquire_registry_lock"]);
});

test("bare abandonment rejects caller prose without an operator decision identity", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-bare-decision-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  await mkdir(resourceLockPath(registryDirectory, "resource-1"), {
    recursive: true,
    mode: 0o700,
  });
  const authorityWatermark = await registryWatermark(registryDirectory);

  await assert.rejects(
    () => reconcileResourceLock(registryDirectory, "resource-1", {
      action: "abandon",
      abandonment_type: "operator_disposition",
      evidence: { kind: "operator_disposition", reference: "operator prose" },
      authority_watermark: authorityWatermark,
    }),
    { outcome: "registry_lock_recovery_evidence_invalid" },
  );
  assert.equal((await readResourceLock(registryDirectory, "resource-1")).status, "bare");
});

test("lock projection rejects a forged hashed path", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-forged-path-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const handle = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-1",
  });
  await link(
    resourceLockPath(registryDirectory, "resource-1"),
    resourceLockPath(registryDirectory, "resource-2"),
  );
  await assert.rejects(
    () => resourceLockProjection(registryDirectory),
    { outcome: "corrupt_registry" },
  );
  await releaseResourceLock(handle);
});

test("lock projection rejects a held lock with malformed resource identity", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-malformed-resource-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const handle = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("task.close", "task-1"),
    authorityId: "authority-1",
  });
  const lockPath = resourceLockPath(registryDirectory, "resource-1");
  const metadata = JSON.parse(await readFile(lockPath, "utf8"));
  metadata.resource_key = { forged: true };
  await writeFile(lockPath, `${JSON.stringify(metadata)}\n`, "utf8");

  await assert.rejects(
    () => resourceLockProjection(registryDirectory),
    { outcome: "corrupt_registry" },
  );
  await releaseResourceLock(handle).catch(() => {});
});

test("a same-boot process restart requires recovery after the old process terminates", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-process-loss-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  const childSource = [
    `import { acquireResourceLock } from ${JSON.stringify(registryModule)};`,
    `await acquireResourceLock(${JSON.stringify(registryDirectory)}, "resource-1", { operationId: "child-operation", authorityId: "child-authority" });`,
  ].join("\n");
  await execFileAsync(process.execPath, ["--input-type=module", "-e", childSource]);

  const replacement = await acquireResourceLock(registryDirectory, "resource-1", {
    operationId: "restarted-operation",
    authorityId: "restarted-authority",
    recover: async (input) => ({
      action: "proven_absence",
      evidence: {
        kind: "operation_absence",
        operation_id: input.lock.operation.id,
        operation_kind: input.lock.operation.kind,
        owner_status: input.owner_status,
        process_identity: input.lock.owner.process_identity,
      },
      authority_watermark: input.authority_watermark,
    }),
  });
  assert.equal(replacement.metadata.operation.id, "restarted-operation");
  await releaseResourceLock(replacement);
});

test("release failure retains owner evidence for a later retry", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "drovr-registry-lock-release-failure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const registryDirectory = join(scratch, "drovr");
  let failRelease = true;
  const releaseFs = {
    rm: async (path, options) => {
      if (failRelease) {
        const error = new Error("simulated release failure");
        error.code = "EIO";
        throw error;
      }
      return rm(path, options);
    },
  };
  const handle = await acquireResourceLock(registryDirectory, "resource-1", {
    operation: registryOperation("agent.retire", "agent-1"),
    operationId: "operation-1",
    authorityId: "authority-1",
    fs: releaseFs,
  });

  let releaseError;
  try {
    await releaseResourceLock(handle);
    assert.fail("release should fail");
  } catch (error) {
    releaseError = error;
  }
  assert.equal(releaseError.outcome, "registry_lock_release_failed");
  assert.deepEqual(releaseError.details.legal_next_actions, [
    "agent_retire",
    "status",
  ]);
  assert.deepEqual(
    releaseError.details.authority_watermark,
    await registryWatermark(registryDirectory),
  );
  assert.equal((await readResourceLock(registryDirectory, "resource-1")).metadata.lock_id, handle.metadata.lock_id);
  failRelease = false;
  assert.deepEqual(await releaseResourceLock(handle), {
    status: "released",
    lock_id: handle.metadata.lock_id,
  });

  failRelease = true;
  let nestedError;
  try {
    await withResourceLock(
      registryDirectory,
      "resource-2",
      async () => "complete",
      {
        operation: registryOperation("task.close", "task-2"),
        authorityId: "authority-2",
        fs: releaseFs,
      },
    );
    assert.fail("nested release should fail");
  } catch (error) {
    nestedError = error;
  }
  assert.deepEqual(nestedError.details.legal_next_actions, [
    "task_close",
    "status",
  ]);
  assert.deepEqual(
    nestedError.details.authority_watermark,
    await registryWatermark(registryDirectory),
  );

  let multiError;
  try {
    await withOrderedResourceLocks(
      registryDirectory,
      ["resource-3", "resource-4"],
      async () => "complete",
      {
        operation: registryOperation("group.close", "group-3"),
        authorityId: "authority-3",
        fs: releaseFs,
      },
    );
    assert.fail("partial release should fail");
  } catch (error) {
    multiError = error;
  }
  assert.deepEqual(multiError.details.legal_next_actions, [
    "group_close",
    "status",
  ]);
  assert.deepEqual(
    multiError.details.authority_watermark,
    await registryWatermark(registryDirectory),
  );
  assert.equal((await readResourceLock(registryDirectory, "resource-3")).status, "held");
  assert.equal((await readResourceLock(registryDirectory, "resource-4")).status, "held");
});

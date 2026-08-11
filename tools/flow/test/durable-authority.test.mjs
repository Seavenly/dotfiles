import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { canonicalize, digest } from "../src/canonical.mjs";
import {
  createBackupManifest,
  initialBackupProjection,
  initialRestoreBarrier,
  reduceHostRecoveryEvent,
} from "../src/backup-restore.mjs";
import { decideLifecycle } from "../src/lifecycle-kernel.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { preparedObservation } from "../src/reboot-revalidation.mjs";
import {
  capabilityBlockedCheckpointProposal,
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
  revisionBlockedCheckpointProposal,
  repeatedRevisionCheckpointProposal,
  terminalRevisionCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";

test("durable backup manifests remain byte-identical across authority reopen", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-backup-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{ id: "host:runs", suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      git_state: {
        commit: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        tree: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        clean: true,
      },
      filesystem_state: [{ path: "/state/authority.sqlite", digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    },
    artifacts: [{ digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", bytes_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", byte_availability: "available" }],
    legacy_roots: [{ path: "/legacy/flow", digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
    external_pointers: [{
      effect_id: "e1",
      provider: "github",
      pointer: "issue:15",
      idempotency_key: "issue:15",
      receipt: {
        schema: "flow.external-effect-receipt/v1",
        effect_id: "e1",
        idempotency_key: "issue:15",
        provider_receipt_id: "provider/e1",
        outcome: "succeeded",
      },
    }],
    drovr_obligations: [{
      turn_id: "turn:1",
      disposition: "retire",
      receipt: {
        schema: "flow.drovr-retirement-receipt/v1",
        turn_id: "turn:1",
        disposition: "retire",
        retirement_receipt_id: "drovr/turn:1",
        outcome: "retired",
      },
    }],
  };
  const adapter = {
    observeBackup: () => observation,
    createBackup: ({ manifest }) => ({
      manifest_digest: manifest.manifest_digest,
      bytes_digest: manifest.manifest_digest,
    }),
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: adapter,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => firstAuthority.close());
  const first = createFlowRuntime({ runAuthority: firstAuthority });
  const firstReceipt = first.command({ type: "backup_create" });
  const expected = createBackupManifest(observation);
  assert.deepEqual(firstReceipt.manifest, expected);
  firstAuthority.close();

  const secondAuthority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: adapter,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
  });
  t.after(() => secondAuthority.close());
  const second = createFlowRuntime({ runAuthority: secondAuthority });
  const secondReceipt = second.command({ type: "backup_create" });

  assert.deepEqual(secondReceipt.manifest, firstReceipt.manifest);
  assert.deepEqual(second.query().backup.manifest, expected);
});

test("host replay rejects the obsolete backup_created event", () => {
  const manifest = createBackupManifest({
    replacement_authority: {},
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  });
  assert.throws(
    () => reduceHostRecoveryEvent({
      backup: initialBackupProjection(),
      restore: initialRestoreBarrier(),
    }, {
      type: "backup_created",
      manifest,
      receipt: {
        schema: "flow.backup-receipt/v1",
        manifest_digest: manifest.manifest_digest,
        provider_receipt: { id: "obsolete" },
      },
    }),
    (error) => error.code === "backup_created_event_unsupported",
  );
});

test("durable host replay rejects an obsolete backup_created event", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-backup-replay-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("backup-replay-boot", "process-a"),
  });
  authority.close();

  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  allowEventTampering(database);
  const stream = database.prepare(`
    SELECT * FROM authority_streams WHERE stream_id = 'host:admission'
  `).get();
  const previous = database.prepare(`
    SELECT * FROM authority_events
     WHERE stream_id = 'host:admission'
     ORDER BY sequence DESC LIMIT 1
  `).get();
  const payload = { type: "backup_created" };
  const payloadJson = JSON.stringify(canonicalize(payload));
  const payloadDigest = digest(payload);
  const sequence = Number(stream.head_sequence) + 1;
  const record = {
    schema: "flow.authority-event-record/v1",
    stream_id: "host:admission",
    sequence,
    generation: Number(stream.generation),
    contract: "flow.host-admission-event/v1",
    payload,
    payload_digest: payloadDigest,
    previous_digest: previous.record_digest,
    authority_epoch: Number(previous.authority_epoch),
    boot_id: previous.boot_id,
    process_identity: previous.process_identity,
  };
  const recordDigest = digest(record);
  database.prepare(`
    INSERT INTO authority_events(
      stream_id, sequence, generation, contract, payload_json,
      payload_digest, previous_digest, record_digest, authority_epoch,
      boot_id, process_identity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "host:admission",
    sequence,
    Number(stream.generation),
    "flow.host-admission-event/v1",
    payloadJson,
    payloadDigest,
    previous.record_digest,
    recordDigest,
    Number(previous.authority_epoch),
    previous.boot_id,
    previous.process_identity,
  );
  database.prepare(`
    UPDATE authority_streams
       SET head_sequence = ?, head_digest = ?, fold_json = ?, fold_digest = ?
     WHERE stream_id = 'host:admission'
  `).run(
    sequence,
    recordDigest,
    JSON.stringify(canonicalize({
      ...JSON.parse(stream.fold_json),
      watermark: recordDigest,
    })),
    digest({ ...JSON.parse(stream.fold_json), watermark: recordDigest }),
  );
  database.close();

  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("backup-replay-boot", "inspector"),
  });
  t.after(() => inspector.close());

  const rejection = createFlowRuntime({ runAuthority: inspector }).query();

  assert.equal(rejection.code, "authority_integrity_failure");
  assert.equal(rejection.reason, "corrupt_recovery_state");
});

test("durable launch ownership reentry preserves host reconciliation rejection", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-launch-reentry-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: { database_streams: [], filesystem_state: [] },
    artifacts: [], legacy_roots: [], external_pointers: [], drovr_obligations: [],
  };
  let runtime;
  let nested;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: { observeRestore: () => observation },
    runOwnershipAdapter: {
      observe: () => {
        nested = runtime.command({ type: "restore", manifest: createBackupManifest(observation) });
        return {
          schema: "flow.run-ownership/v1",
          scope: "top_level",
          parent_run_id: null,
        };
      },
    },
    hostIdentityAdapter: fixedHostIdentity("launch-reentry-boot", "launch-reentry-process"),
  });
  t.after(() => authority.close());
  runtime = createFlowRuntime({ runAuthority: authority });
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  assert.equal(nested.accepted, true);
  assert.equal(launch.code, "host_reconciliation_required");
  assert.equal(launch.authority_watermark_domain, "host");
  assert.equal(launch.authority_watermark, runtime.query().watermark);
  assert.deepEqual(launch.legal_actions, runtime.query().restore.legal_actions);
  assert.equal(runtime.query().restore.active, true);
  assert.deepEqual(runtime.query().restore.legal_actions, [{
    schema: "flow.command/v1",
    type: "restore_reconcile",
    expected_watermark: runtime.query().watermark,
  }]);
  assert.equal(runtime.query({ run_id: launch.run_id }).code, "unknown_run");
});

test("durable backup records intent before mutation and retains receipt loss for reconciliation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-backup-boundary-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tree: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        clean: true,
      },
      filesystem_state: [{
        path: "/state/authority.sqlite",
        digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      }],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  let authority;
  let writerCalls = 0;
  let externalBackup = null;
  let projectionDuringWriter = null;
  const adapter = {
    observeBackup: () => observation,
    createBackup: ({ manifest }) => {
      writerCalls += 1;
      projectionDuringWriter = authority.query();
      externalBackup = { manifest_digest: manifest.manifest_digest };
      throw new Error("backup receipt lost after external write");
    },
    reconcile: ({ manifest, intent }) => externalBackup === null
      ? {
          schema: "flow.backup-reconciliation-observation/v1",
          operation: "backup_create",
          operation_id: intent.operation_id,
          idempotency_key: intent.idempotency_key,
          manifest_digest: intent.manifest_digest,
          status: "absent",
          safe_to_retry: true,
          provider_evidence: {
            schema: "flow.backup-provider-evidence/v1",
            provider: "test-backup",
            proof_id: "absence-proof-boundary",
            outcome: "absent",
          },
        }
      : {
          schema: "flow.backup-reconciliation-observation/v1",
          operation: "backup_create",
          operation_id: intent.operation_id,
          idempotency_key: intent.idempotency_key,
          manifest_digest: intent.manifest_digest,
          status: "present",
          provider_evidence: {
            schema: "flow.backup-provider-evidence/v1",
            provider: "test-backup",
            proof_id: "presence-proof-boundary",
            outcome: "present",
          },
          receipt: {
            manifest_digest: manifest.manifest_digest,
            provider_receipt: externalBackup,
          },
        },
  };
  authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: adapter,
    hostIdentityAdapter: fixedHostIdentity("backup-boot-a", "backup-process-a"),
  });
  const first = createFlowRuntime({ runAuthority: authority });
  const failed = first.command({ type: "backup_create" });
  assert.equal(failed.accepted, undefined);
  assert.equal(projectionDuringWriter.backup.state, "reconciling");
  assert.equal(writerCalls, 1);
  authority.close();

  authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: adapter,
    hostIdentityAdapter: fixedHostIdentity("backup-boot-b", "backup-process-b"),
  });
  t.after(() => authority.close());
  const second = createFlowRuntime({ runAuthority: authority });
  const pending = second.query().backup;
  assert.equal(pending.state, "reconciling");
  assert.deepEqual(pending.legal_actions, [{
    schema: "flow.command/v1",
    type: "backup_reconcile",
    expected_watermark: second.query().watermark,
  }]);
  assert.equal(second.command({ type: "backup_create" }).code,
    "host_reconciliation_required");
  assert.equal(writerCalls, 1);
  const restoreBlocked = second.command({
    type: "restore",
    manifest: createBackupManifest(observation),
  });
  assert.equal(restoreBlocked.code, "host_action_not_projected");
  assert.deepEqual(restoreBlocked.legal_actions, pending.legal_actions);
  const reconciled = second.command(pending.legal_actions[0]);
  assert.equal(reconciled.accepted, true);
  assert.equal(second.query().backup.state, "completed");
  assert.equal(writerCalls, 1);
});

test("backup retry reuses the retained intent after safe absence despite observation drift", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-backup-retry-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstObservation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tree: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const secondObservation = {
    ...firstObservation,
    replacement_authority: {
      ...firstObservation.replacement_authority,
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      }],
    },
  };
  let currentObservation = firstObservation;
  let writerCalls = 0;
  let failFirstWrite = true;
  const writes = [];
  const adapter = {
    observeBackup: () => currentObservation,
    createBackup: ({ manifest, operation_id, intent }) => {
      writerCalls += 1;
      writes.push({
        manifest,
        operation_id,
        intent,
      });
      if (failFirstWrite) {
        failFirstWrite = false;
        throw new Error("backup receipt lost before external presence");
      }
      return {
        manifest_digest: manifest.manifest_digest,
        provider_receipt_id: "backup/retained-intent",
      };
    },
    reconcile: ({ intent }) => ({
      schema: "flow.backup-reconciliation-observation/v1",
      operation: "backup_create",
      operation_id: intent.operation_id,
      idempotency_key: intent.idempotency_key,
      manifest_digest: intent.manifest_digest,
      status: "absent",
      safe_to_retry: true,
      provider_evidence: {
        schema: "flow.backup-provider-evidence/v1",
        provider: "test-backup",
        proof_id: "absence-proof-retry",
        outcome: "absent",
      },
    }),
  };
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: adapter,
    hostIdentityAdapter: fixedHostIdentity("retry-boot-a", "retry-process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const failed = runtime.command({ type: "backup_create" });
  assert.equal(failed.accepted, undefined);
  const pending = runtime.query().backup;
  assert.equal(runtime.command(pending.legal_actions[0]).accepted, true);
  const retryable = runtime.query().backup;
  const originalManifestDigest = retryable.intent.manifest_digest;
  const originalOperationId = retryable.intent.operation_id;
  const restoreBlocked = runtime.command({
    type: "restore",
    manifest: retryable.manifest,
  });
  assert.equal(restoreBlocked.code, "host_action_not_projected");
  assert.deepEqual(restoreBlocked.legal_actions, retryable.legal_actions);

  currentObservation = secondObservation;
  const retried = runtime.command(retryable.legal_actions[0]);

  assert.equal(retried.accepted, true);
  assert.equal(writerCalls, 2);
  assert.equal(writes[1].manifest.manifest_digest, originalManifestDigest);
  assert.equal(writes[1].operation_id, originalOperationId);
  assert.equal(writes[1].intent.operation_id, originalOperationId);
  assert.deepEqual(writes[1].manifest, writes[0].manifest);
});

test("durable restore barrier survives process replacement and gates launch", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{ id: "host:runs", suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      git_state: {
        commit: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        tree: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        clean: true,
      },
      filesystem_state: [{ path: "/state/authority.sqlite", digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const manifest = createBackupManifest(observation);
  let firstAuthority;
  let projectionDuringRestore;
  const restoreAdapter = {
    observeRestore: () => observation,
    restore: ({ manifest: appliedManifest }) => {
      projectionDuringRestore = firstAuthority.query();
      assert.equal(appliedManifest.manifest_digest, manifest.manifest_digest);
      throw new Error("restore receipt lost after mutation boundary");
    },
  };
  firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: restoreAdapter,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const first = createFlowRuntime({ runAuthority: firstAuthority });
  assert.equal(first.command({ type: "restore", manifest }).code,
    "restore_apply_failed");
  assert.equal(projectionDuringRestore.restore.active, true);
  assert.equal(projectionDuringRestore.restore.applied_receipt, null);
  firstAuthority.close();

  const secondAuthority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: restoreAdapter,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
  });
  t.after(() => secondAuthority.close());
  const second = createFlowRuntime({ runAuthority: secondAuthority });
  const restored = second.query();
  assert.equal(restored.restore.state, "reconciling");
  assert.equal(restored.restore.applied_receipt, null);
  assert.equal(second.launch({}).code, "host_reconciliation_required");
  assert.equal(second.command(restored.restore.legal_actions[0]).accepted, true);
  const ready = second.query();
  assert.equal(second.command(ready.restore.legal_actions[0]).accepted, true);
  assert.equal(second.query().restore.state, "admitted");
});

test("durable restore records an exact intent before mutation and preserves it across lost receipt", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-intent-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        tree: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        clean: true,
      },
      filesystem_state: [{
        path: "/state/authority.sqlite",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const manifest = createBackupManifest(observation);
  let restoreCalls = 0;
  let received;
  const restoreAdapter = {
    observeRestore: () => observation,
    restore: (request) => {
      restoreCalls += 1;
      received = request;
      throw new Error("restore receipt lost after provider mutation");
    },
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: restoreAdapter,
    hostIdentityAdapter: fixedHostIdentity("restore-intent-boot-a", "restore-intent-process-a"),
  });
  const first = createFlowRuntime({ runAuthority: firstAuthority });
  assert.equal(first.command({ type: "restore", manifest }).code,
    "restore_apply_failed");
  const pending = first.query().restore;
  assert.equal(restoreCalls, 1);
  assert.equal(received.intent.operation, "restore");
  assert.equal(received.intent.manifest_digest, manifest.manifest_digest);
  assert.equal(received.operation_id, pending.intent.operation_id);
  assert.equal(received.idempotency_key, pending.intent.idempotency_key);
  assert.equal(pending.applied_receipt, null);
  firstAuthority.close();

  const secondAuthority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: {
      observeRestore: () => observation,
    },
    hostIdentityAdapter: fixedHostIdentity("restore-intent-boot-b", "restore-intent-process-b"),
  });
  t.after(() => secondAuthority.close());
  const second = createFlowRuntime({ runAuthority: secondAuthority });
  const restored = second.query().restore;
  assert.deepEqual(restored.intent, pending.intent);
  assert.equal(restored.applied_receipt, null);
  assert.equal(second.command(restored.legal_actions[0]).accepted, true);
  const ready = second.query().restore;
  assert.equal(ready.applied_receipt, null);
  const admission = second.command(ready.legal_actions[0]);
  assert.equal(admission.accepted, true);
  assert.equal(admission.receipt.operation_id, pending.intent.operation_id);
  assert.equal(admission.receipt.idempotency_key, pending.intent.idempotency_key);
  assert.equal(admission.receipt.reconciliation_digest,
    ready.reconciliation.reconciliation_digest);
});

test("durable run query and watch expose host reconciliation while barrier is active", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-run-view-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-view-boot", "restore-view-process"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const watch = runtime.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  await watch.next();
  const manifest = createBackupManifest(observation);
  assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);

  const blocked = runtime.query({ run_id: launch.run_id });
  const marker = blocked.host_reconciliation;
  assert.equal(marker?.active, true);
  assert.deepEqual(blocked.legal_actions, []);
  for (const view of Object.values(blocked.views)) {
    assert.deepEqual(view.legal_actions, []);
    assert.deepEqual(view.host_reconciliation, marker);
  }
  const watched = await watch.next();
  assert.deepEqual(watched.value.host_reconciliation, marker);
  await watch.return();
});

test("durable restore admission rejects changed Adapter evidence before clearing the barrier", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-fresh-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstObservation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        tree: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const changedObservation = {
    ...firstObservation,
    replacement_authority: {
      ...firstObservation.replacement_authority,
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }],
    },
  };
  let currentObservation = firstObservation;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: {
      observeRestore: () => currentObservation,
    },
    hostIdentityAdapter: fixedHostIdentity("restore-fresh-boot", "restore-fresh-process"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const manifest = createBackupManifest(firstObservation);
  assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);
  assert.equal(runtime.command(runtime.query().restore.legal_actions[0]).accepted, true);
  const ready = runtime.query();

  currentObservation = changedObservation;
  const stale = runtime.command(ready.restore.legal_actions[0]);
  const quarantined = runtime.query();

  assert.equal(stale.code, "restore_reconciliation_changed");
  assert.equal(quarantined.restore.state, "failed");
  assert.deepEqual(quarantined.restore.legal_actions, [{
    schema: "flow.command/v1",
    type: "restore_reconcile",
    expected_watermark: quarantined.watermark,
  }]);
});

test("durable restore admission remains closed while an external effect is in flight", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-effect-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        tree: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  let startedResolve;
  let releaseEffect;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const effectPending = new Promise((resolve) => { releaseEffect = resolve; });
  const registration = {
    classification: "caller_idempotent",
    invoke: async (intent) => {
      startedResolve(intent);
      const providerReceipt = await effectPending;
      return operationReceipt(intent, providerReceipt);
    },
  };
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-effect-boot", "restore-effect-process"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: registration },
  });
  const prepared = runtime.prepare(registeredOperationProposal({ checkpointBound: false }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const operationAction = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );
  const effectCommand = runtime.command(operationAction);
  const intent = await started;
  assert.equal(effectCommand.accepted, true);
  assert.equal(intent.effect_id, effectCommand.effect_intents[0].effect_id);

  const manifest = createBackupManifest(observation);
  assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);
  assert.equal(runtime.command(runtime.query().restore.legal_actions[0]).accepted, true);
  const ready = runtime.query();
  const blocked = runtime.command(ready.restore.legal_actions[0]);
  assert.equal(blocked.code, "host_effects_in_flight");
  assert.equal(runtime.query().restore.state, "ready");

  releaseEffect({ record: "effect-finished" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "active");
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
  const stillBlocked = runtime.command(runtime.query().restore.legal_actions[0]);
  assert.equal(stillBlocked.code, "host_effects_unresolved");
  assert.equal(runtime.query().restore.state, "ready");
});

test("durable restore admission remains closed for a persisted unresolved run effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-run-effect-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        tree: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    lifecycleKernel: effectLifecycle,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-run-effect-boot", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "0");
  const effectReceipt = firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  assert.equal(effectReceipt.accepted, true);
  assert.equal(firstRuntime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
  firstAuthority.close();

  const authority = createDurableRunAuthority({
    authorityDirectory,
    lifecycleKernel: effectLifecycle,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-run-effect-boot", "process-b"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const manifest = createBackupManifest(observation);

  assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);
  assert.equal(runtime.command(runtime.query().restore.legal_actions[0]).accepted,
    true);
  const ready = runtime.query();
  assert.equal(ready.restore.state, "ready");

  const blocked = runtime.command(ready.restore.legal_actions[0]);

  assert.equal(blocked.code, "host_effects_unresolved");
  assert.equal(runtime.query().restore.state, "ready");
  assert.equal(runtime.query().restore.active, true);
});

test("durable effect receipt is fenced if restore activates after Adapter return", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-effect-after-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        tree: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const manifest = createBackupManifest(observation);
  const authority = createDurableRunAuthority({
    authorityDirectory,
    lifecycleKernel: effectLifecycle,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-effect-after-boot", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const effectReceipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = effectReceipt.effect_intents;
  let adapterCalls = 0;

  await assert.rejects(
    () => authority.invokeEffect(intent, {
      invoke() {
        adapterCalls += 1;
        assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);
        return "provider-returned";
      },
    }),
    (error) => error.code === "host_reconciliation_required",
  );
  assert.equal(adapterCalls, 1);
  assert.equal(runtime.query().restore.active, true);
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
});

test("durable async effect settlement is fenced when restore activates while pending", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-effect-pending-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        tree: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  const authority = createDurableRunAuthority({
    authorityDirectory,
    lifecycleKernel: effectLifecycle,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-effect-pending-boot", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const effectReceipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = effectReceipt.effect_intents;
  let startedResolve;
  let release;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const pending = authority.invokeEffect(intent, {
    invoke() {
      startedResolve();
      return new Promise((resolve) => { release = resolve; });
    },
  });
  await started;

  const manifest = createBackupManifest(observation);
  assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);
  release("provider-returned");

  await assert.rejects(
    () => pending,
    (error) => error.code === "host_reconciliation_required",
  );
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
});

test("durable effect admission rereads the host barrier before invocation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-restore-effect-race-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [{
        id: "host:runs",
        suffix: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }],
      git_state: {
        commit: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        tree: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        clean: true,
      },
      filesystem_state: [],
    },
    artifacts: [],
    legacy_roots: [],
    external_pointers: [],
    drovr_obligations: [],
  };
  let adapterCalls = 0;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    lifecycleKernel: effectLifecycle,
    backupRestoreAdapter: { observeRestore: () => observation },
    hostIdentityAdapter: fixedHostIdentity("restore-effect-race-boot", "restore-effect-race-process"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke: async () => operationReceipt({}),
      },
    },
  });
  const prepared = runtime.prepare(registeredOperationProposal({ checkpointBound: false }));
  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const operationAction = runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  );
  const effectReceipt = authority.command(operationAction);
  const [intent] = effectReceipt.effect_intents;
  const invocation = authority.invokeEffect(intent, {
    invoke() {
      adapterCalls += 1;
    },
  });

  const manifest = createBackupManifest(observation);
  assert.equal(runtime.command({ type: "restore", manifest }).accepted, true);
  await assert.rejects(
    () => invocation,
    (error) => error.code === "host_reconciliation_required",
  );
  assert.equal(adapterCalls, 0);
  assert.equal(runtime.query({ run_id: launch.run_id }).effects[0].status,
    "unresolved");
});

test("a launched run and its authority projection survive process replacement", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => firstAuthority.close());
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(dynamicCheckpointProposal());
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  const beforeRestart = firstRuntime.query({ run_id: launch.run_id });

  firstAuthority.close();
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());
  const recovered = createFlowRuntime({ runAuthority: inspector });

  assert.deepEqual(recovered.query({ run_id: launch.run_id }), beforeRestart);
  assert.deepEqual(recovered.query().runs, [launch.run_id]);
});

test("durable launch projects digest-bound card blocks and their legal grant", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const prepared = runtime.prepare(capabilityBlockedCheckpointProposal());

  const launch = runtime.launch(confirmedLaunchRequest(prepared));
  const blocked = runtime.query({ run_id: launch.run_id });

  assert.equal(blocked.progress, "blocked");
  assert.deepEqual(blocked.blocks.map(({ card_id: cardId }) => cardId), [
    "confirm-plan",
  ]);
  assert.deepEqual(blocked.legal_actions.map(({ type }) => type), [
    "capability_grant",
  ]);
  assert.equal(runtime.command(blocked.legal_actions[0]).accepted, true);
  assert.equal(runtime.query({ run_id: launch.run_id }).progress, "waiting");
});

test("a terminal checkpoint revision succeeds and atomically releases capacity", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 1,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const prepared = runtime.prepare(terminalRevisionCheckpointProposal());
  const launch = runtime.launch(confirmedLaunchRequest(prepared));

  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ type }) => type === "capability_grant",
  ));
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-scope" && decision === "approve",
  ));
  const blocked = runtime.query({ run_id: launch.run_id });
  const staleAcceptance = blocked.legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "accept",
  );
  const decline = blocked.legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "decline",
  );

  assert.equal(runtime.command(decline).accepted, true);
  const afterDecline = runtime.query({ run_id: launch.run_id });
  assert.equal(afterDecline.phase, "active");
  assert.equal(afterDecline.current_revision.ordinal, 0);
  assert.equal(runtime.query().admission.active_runs, 1);
  assert.equal(runtime.command(staleAcceptance).code, "stale_authority_watermark");
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "active");
  assert.equal(runtime.query().admission.active_runs, 1);

  const cappedProposal = repeatedRevisionCheckpointProposal();
  cappedProposal.explicit_facts.limits.max_revisions = 1;
  const nextPrepared = runtime.prepare(cappedProposal);
  const capacityRejection = runtime.launch(confirmedLaunchRequest(nextPrepared));
  assert.equal(capacityRejection.code, "host_capacity_exhausted");

  const revision = afterDecline.legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "accept",
  );

  assert.equal(runtime.command(revision).accepted, true);
  const terminal = runtime.query({ run_id: launch.run_id });
  assert.equal(terminal.phase, "succeeded");
  assert.equal(terminal.progress, "complete");
  assert.deepEqual(terminal.cards, [
    { id: "confirm-plan", executor_kind: "checkpoint", status: "superseded" },
    { id: "confirm-scope", executor_kind: "checkpoint", status: "completed" },
  ]);
  assert.deepEqual(terminal.legal_actions, []);
  assert.equal(runtime.query().admission.active_runs, 0);

  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());
  const replayed = createFlowRuntime({ runAuthority: inspector });
  assert.deepEqual(replayed.query({ run_id: launch.run_id }), terminal);
  assert.equal(replayed.query().admission.active_runs, 0);

  const nextLaunch = runtime.launch(confirmedLaunchRequest(nextPrepared));
  assert.equal(nextLaunch.created, true);
  assert.equal(runtime.query().admission.active_runs, 1);

  const nextInitial = runtime.query({ run_id: nextLaunch.run_id });
  runtime.command(nextInitial.legal_actions.find(({ template_id: templateId }) =>
    templateId === "replace-confirm-plan"));
  const capped = runtime.query({ run_id: nextLaunch.run_id });
  assert.ok(!capped.legal_actions.some(({ type, decision }) =>
    type === "revision_decision" && decision === "accept"));
  assert.equal(runtime.command(capped.legal_actions.find(
    ({ type, decision }) =>
      type === "revision_decision" && decision === "decline",
  )).accepted, true);
  assert.equal(runtime.query({ run_id: nextLaunch.run_id }).phase, "active");
  assert.equal(runtime.query().admission.active_runs, 1);

  const unavailable = runtime.prepare(dynamicCheckpointProposal());
  assert.equal(
    runtime.launch(confirmedLaunchRequest(unavailable)).code,
    "host_capacity_exhausted",
  );
});

test("same-boot recovery advances the epoch and resumes from replayed authority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(dynamicCheckpointProposal());
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = createFlowRuntime({
    runAuthority: recoveredAuthority,
  });
  const waiting = recoveredRuntime.query({ run_id: launch.run_id });

  assert.equal(waiting.authority_epoch, 2);
  assert.equal(waiting.authority_boot_id, "boot-a");
  const receipt = recoveredRuntime.command(waiting.legal_actions[0]);
  assert.equal(receipt.accepted, true);
  assert.equal(
    recoveredRuntime.query({ run_id: launch.run_id }).phase,
    "succeeded",
  );
});

test("a reboot suspends each run until its typed admission command", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "7");
  const staleCheckpoint = firstRuntime.query({
    run_id: launch.run_id,
  }).legal_actions[0];
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: preparedRebootObservation(),
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const suspended = rebooted.query({ run_id: launch.run_id });

  assert.equal(suspended.admission, "suspended_after_reboot");
  assert.deepEqual(suspended.legal_actions.map(({ type }) => type), [
    "reboot_admission",
  ]);
  assert.equal(rebooted.command(staleCheckpoint).code, "stale_authority_watermark");

  assert.equal(rebooted.command(suspended.legal_actions[0]).accepted, true);
  const admitted = rebooted.query({ run_id: launch.run_id });
  assert.equal(admitted.admission, "admitted");
  assert.deepEqual(
    [...new Set(admitted.legal_actions.map(({ type }) => type))],
    ["checkpoint_decision"],
  );
});

test("reboot admission rejects any drift from the complete revalidation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "9");
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: preparedRebootObservation(),
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const action = rebooted.query({ run_id: launch.run_id }).legal_actions[0];

  for (const field of [
    "catalog_fingerprint",
    "route_snapshot",
    "capability_envelopes",
    "operation_contracts",
    "validator_contracts",
    "resource_claims",
    "limits",
    "elapsed_seconds",
    "time_facts",
    "subject_generations",
    "effect_rechecks",
  ]) {
    const changed = structuredClone(action);
    changed.revalidation.observed[field] = field.endsWith("fingerprint")
      ? `sha256:${"0".repeat(64)}`
      : field === "route_snapshot"
        ? { watermark: `sha256:${"0".repeat(64)}`, bindings: [] }
        : [{ changed: field }];
    const rejection = rebooted.command(changed);
    assert.equal(rejection.code, "stale_reboot_admission", field);
  }
  const changedEffects = structuredClone(action);
  changedEffects.revalidation.unresolved_effects = [{
    effect_id: "effect:unexpected",
  }];
  assert.equal(
    rebooted.command(changedEffects).code,
    "stale_reboot_admission",
    "unresolved_effects",
  );
  const incomplete = structuredClone(action);
  delete incomplete.revalidation;
  assert.equal(
    rebooted.command(incomplete).code,
    "stale_reboot_admission",
  );

  assert.equal(rebooted.command(action).accepted, true);
});

test("reboot admission uses current Adapter observations", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "8");
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared }) {
        const facts = prepared.explicit_facts;
        return {
          catalog_fingerprint: `sha256:${"0".repeat(64)}`,
          route_snapshot: facts.route_snapshot,
          capability_envelopes: facts.capability_envelopes,
          operation_contracts: facts.operation_contracts,
          validator_contracts: facts.validator_contracts,
          resource_claims: facts.resource_claims,
          time_facts: [],
          subject_generations: [],
          effect_rechecks: [],
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const suspended = rebooted.query({ run_id: launch.run_id });

  assert.equal(suspended.legal_actions[0].revalidation.valid, false);
  assert.equal(
    rebooted.command(suspended.legal_actions[0]).code,
    "reboot_revalidation_failed",
  );
  assert.equal(
    rebooted.query({ run_id: launch.run_id }).admission,
    "suspended_after_reboot",
  );
});

test("reboot admission fails closed without a current-observation Adapter", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "8");
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const action = rebooted.query({ run_id: launch.run_id }).legal_actions[0];

  assert.equal(action.revalidation.valid, false);
  assert.equal(action.revalidation.observed, null);
  assert.notEqual(action.revalidation.expected, null);
  assert.equal(
    rebooted.command(action).code,
    "reboot_revalidation_failed",
  );
});

test("reboot admission rechecks typed time facts and subject generations", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const proposal = dynamicCheckpointProposal();
  proposal.explicit_facts.time_facts = [
    {
      schema: "flow.time-fact/v1",
      kind: "wall_clock",
      value_ms: 1_700_000_000_000,
      uncertainty_ms: 0,
      clock_source_id: "wall:host-a",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "suspend_excluding_monotonic",
      value_ns: "42000000000",
      uncertainty_ns: "0",
      clock_source_id: "mono:host-a",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "boot",
      boot_id: "boot-a",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "clock_source",
      identity: "clockset:host-a:v1",
    },
  ];
  proposal.explicit_facts.subject_generations = [{
    schema: "flow.subject-generation/v1",
    contract: "work.workspace/v1",
    subject_id: "workspace:flow",
    generation: 7,
    fingerprint: `sha256:${"a".repeat(64)}`,
  }];
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared }) {
        const observed = preparedObservation(prepared);
        return {
          ...observed,
          time_facts: prepared.explicit_facts.time_facts.map((fact) =>
            fact.kind === "boot" ? { ...fact, boot_id: "boot-b" } : fact),
          subject_generations: prepared.explicit_facts.subject_generations,
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const action = rebooted.query({ run_id: launch.run_id }).legal_actions[0];

  assert.deepEqual(
    action.revalidation.expected.time_facts,
    prepared.explicit_facts.time_facts,
  );
  assert.deepEqual(
    action.revalidation.expected.subject_generations,
    prepared.explicit_facts.subject_generations,
  );
  assert.equal(rebooted.command(action).accepted, true);
});

test("reboot admission rejects an exhausted elapsed limit without typed time facts", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const proposal = dynamicCheckpointProposal();
  proposal.explicit_facts.time_facts = [];
  proposal.explicit_facts.elapsed_seconds = 10;
  proposal.explicit_facts.limits.max_elapsed_seconds = 10;
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: preparedRebootObservation(),
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const suspended = rebooted.query({ run_id: launch.run_id });

  assert.equal(suspended.reboot_revalidation.valid, false);
  assert.equal(
    rebooted.command(suspended.legal_actions[0]).code,
    "reboot_revalidation_failed",
  );
});

test("reboot admission rechecks current facts after a nonterminal plan revision", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const proposal = revisionBlockedCheckpointProposal();
  proposal.explicit_facts.elapsed_seconds = 10;
  proposal.explicit_facts.time_facts = rebootTimeFacts({
    wallValueMs: 1_700_000_000_000,
    wallUncertaintyMs: 0,
    monotonicValueNs: "1000000000",
    monotonicUncertaintyNs: "0",
    bootId: "boot-a",
  });
  proposal.revision_templates[0].changes.limit_changes.max_elapsed_seconds = 120;

  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  let projection = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(firstRuntime.command(projection.legal_actions.find(
    ({ type }) => type === "capability_grant",
  )).accepted, true);
  projection = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(firstRuntime.command(projection.legal_actions.find(
    ({ type, checkpoint_id: checkpointId, decision }) =>
      type === "checkpoint_decision" && checkpointId === "confirm-scope" &&
      decision === "approve",
  )).accepted, true);
  projection = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(firstRuntime.command(projection.legal_actions.find(
    ({ type, decision }) => type === "revision_decision" && decision === "accept",
  )).accepted, true);
  const revised = firstRuntime.query({ run_id: launch.run_id });
  assert.equal(revised.current_revision.ordinal, 1);
  assert.deepEqual(revised.resource_claims, [{ kind: "artifact", id: "revised-plan" }]);
  assert.equal(revised.limits.max_elapsed_seconds, 120);
  firstAuthority.close();

  let useCurrentFacts = false;
  let observedCurrentFacts;
  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared: observedPrepared, currentFacts }) {
        observedCurrentFacts = structuredClone(currentFacts);
        const observation = preparedObservation(observedPrepared);
        return {
          ...observation,
          resource_claims: useCurrentFacts
            ? currentFacts.resource_claims
            : observation.resource_claims,
          limits: useCurrentFacts ? currentFacts.limits : observation.limits,
          elapsed_seconds: useCurrentFacts
            ? currentFacts.elapsed_seconds
            : observation.elapsed_seconds,
          time_facts: rebootTimeFacts({
            wallValueMs: 1_700_000_005_000,
            wallUncertaintyMs: 0,
            monotonicValueNs: "1000",
            monotonicUncertaintyNs: "1",
            bootId: "boot-b",
          }),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const stale = rebooted.query({ run_id: launch.run_id });

  assert.deepEqual(observedCurrentFacts, {
    resource_claims: revised.resource_claims,
    limits: revised.limits,
    elapsed_seconds: prepared.explicit_facts.elapsed_seconds,
  });
  assert.deepEqual(stale.reboot_revalidation.expected.resource_claims,
    revised.resource_claims);
  assert.deepEqual(stale.reboot_revalidation.expected.limits, revised.limits);
  assert.equal(stale.reboot_revalidation.expected.elapsed_seconds,
    prepared.explicit_facts.elapsed_seconds);
  assert.equal(stale.reboot_revalidation.valid, false);
  assert.equal(
    rebooted.command(stale.legal_actions[0]).code,
    "reboot_revalidation_failed",
  );

  useCurrentFacts = true;
  const current = rebooted.query({ run_id: launch.run_id });
  assert.equal(current.reboot_revalidation.valid, true);
  assert.equal(rebooted.command(current.legal_actions[0]).accepted, true);
});

test("reboot admission blocks an elapsed limit when time uncertainty straddles it and recovers", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const proposal = dynamicCheckpointProposal();
  proposal.explicit_facts.elapsed_seconds = 0;
  proposal.explicit_facts.limits.max_elapsed_seconds = 10;
  proposal.explicit_facts.time_facts = rebootTimeFacts({
    wallValueMs: 1_700_000_000_000,
    wallUncertaintyMs: 0,
    monotonicValueNs: "1000000000",
    monotonicUncertaintyNs: "0",
    bootId: "boot-a",
  });
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstAuthority.close();

  let wallUncertaintyMs = 1_000;
  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared: observedPrepared }) {
        return {
          ...preparedObservation(observedPrepared),
          time_facts: rebootTimeFacts({
            wallValueMs: 1_700_000_009_500,
            wallUncertaintyMs,
            monotonicValueNs: "1000",
            monotonicUncertaintyNs: "1",
            bootId: "boot-b",
          }),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const uncertain = rebooted.query({ run_id: launch.run_id });

  assert.equal(uncertain.admission, "suspended_after_reboot");
  assert.equal(uncertain.legal_actions[0].revalidation.valid, false);
  assert.equal(
    rebooted.command(uncertain.legal_actions[0]).code,
    "reboot_revalidation_failed",
  );

  wallUncertaintyMs = 0;
  const recovered = rebooted.query({ run_id: launch.run_id });
  assert.equal(recovered.legal_actions[0].revalidation.valid, true);
  assert.equal(rebooted.command(recovered.legal_actions[0]).accepted, true);
  assert.equal(rebooted.query({ run_id: launch.run_id }).admission, "admitted");
});

test("reboot observation refresh keeps the authority watermark stable", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const proposal = dynamicCheckpointProposal();
  proposal.explicit_facts.elapsed_seconds = 0;
  proposal.explicit_facts.limits.max_elapsed_seconds = 10;
  proposal.explicit_facts.time_facts = rebootTimeFacts({
    wallValueMs: 1_700_000_000_000,
    wallUncertaintyMs: 0,
    monotonicValueNs: "1000000000",
    monotonicUncertaintyNs: "0",
    bootId: "boot-a",
  });
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  firstAuthority.close();

  let wallValueMs = 1_700_000_005_000;
  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared: observedPrepared }) {
        return {
          ...preparedObservation(observedPrepared),
          time_facts: rebootTimeFacts({
            wallValueMs,
            wallUncertaintyMs: 0,
            monotonicValueNs: "1000",
            monotonicUncertaintyNs: "1",
            bootId: "boot-b",
          }),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const first = rebooted.query({ run_id: launch.run_id });

  wallValueMs += 1_000;
  const refreshed = rebooted.query({ run_id: launch.run_id });

  assert.equal(refreshed.watermark, first.watermark);
  assert.notDeepEqual(
    refreshed.legal_actions[0].revalidation,
    first.legal_actions[0].revalidation,
  );
  assert.equal(
    rebooted.command(first.legal_actions[0]).code,
    "stale_reboot_admission",
  );
  assert.equal(rebooted.command(refreshed.legal_actions[0]).accepted, true);
});

test("reboot admission accepts exact absent evidence before FlowRuntime recovery", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let firstInvocationStarted = false;
  let invocationMode = "lost";
  let recoveredInvocationCount = 0;
  const lifecycle = (fold, command) =>
    ["recovery", "reboot_admission"].includes(command.type)
    ? decideLifecycle(fold, command)
    : effectLifecycle(fold, command, "reconcilable");
  const registration = {
    classification: "reconcilable",
    observe(intent) {
      return {
        schema: "flow.effect-observation/v1",
        effect_id: intent.effect_id,
        idempotency_key: intent.idempotency_key,
        presence: "absent",
        causation: null,
        provider_observation: {
          found: false,
          proof: "exact_absence",
        },
      };
    },
    invoke(intent) {
      if (invocationMode === "lost") {
        firstInvocationStarted = true;
        return new Promise(() => {});
      }
      recoveredInvocationCount += 1;
      return operationReceipt(intent);
    },
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: lifecycle,
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: { "flow.operation/test/v1": registration },
  });
  const launch = launchDistinctRun(firstRuntime, "5");
  assert.equal(firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions[0],
  ).accepted, true);
  await until(() => firstInvocationStarted);
  firstAuthority.close();
  invocationMode = "recover";

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    lifecycleKernel: lifecycle,
    rebootObservationAdapter: {
      observe({ prepared, unresolvedEffects }) {
        return {
          ...withRebootBoot(preparedObservation(prepared), "boot-b"),
          effect_rechecks: unresolvedEffects.map((effect) => ({
            schema: "flow.reboot-effect-recheck/v1",
            effect_id: effect.effect_id,
            idempotency_key: effect.idempotency_key,
            classification: effect.classification,
            operation_contract: effect.operation_contract,
            recovery: "reconcile",
            observed_status: "reconciling",
            observation: {
              schema: "flow.effect-observation/v1",
              effect_id: effect.effect_id,
              idempotency_key: effect.idempotency_key,
              presence: "absent",
              causation: null,
              provider_observation: {
                found: false,
                proof: "exact_absence",
              },
            },
          })),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({
    runAuthority: rebootedAuthority,
    registeredOperations: { "flow.operation/test/v1": registration },
  });
  const suspended = rebooted.query({ run_id: launch.run_id });
  assert.equal(suspended.reboot_revalidation.valid, true);
  assert.equal(rebooted.command(suspended.legal_actions[0]).accepted, true);

  const admitted = rebooted.query({ run_id: launch.run_id });
  const recovery = admitted.legal_actions.find(({ type }) => type === "recovery");
  assert.equal(recovery.recovery, "reconcile");
  assert.equal(rebooted.command(recovery).accepted, true);
  await until(() => rebooted.query({ run_id: launch.run_id }).phase === "succeeded");
  const completed = rebooted.query({ run_id: launch.run_id });
  assert.equal(completed.effects[0].idempotency_key,
    admitted.effects[0].idempotency_key);
  assert.equal(recoveredInvocationCount, 1);
});

test("reboot admission adopts exact one-shot presence without reinvocation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let invocationCount = 0;
  let originalIntent;
  const presentObservation = (intent) => ({
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "present",
    causation: {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    },
    provider_observation: { provider_id: "accepted-once" },
  });
  const registration = {
    classification: "one_shot_uncertain",
    observe: presentObservation,
    invoke(intent) {
      invocationCount += 1;
      originalIntent = intent;
      throw new Error("receipt lost after one-shot effect");
    },
  };
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: registration },
  });
  const prepared = firstRuntime.prepare(registeredOperationProposal({
    classification: "one_shot_uncertain",
  }));
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  assert.equal(firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions.find(
      ({ decision }) => decision === "approve",
    ),
  ).accepted, true);
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: {
      observe({ prepared: observedPrepared, unresolvedEffects }) {
        return {
          ...withRebootBoot(preparedObservation(observedPrepared), "boot-b"),
          effect_rechecks: unresolvedEffects.map((effect) => ({
            schema: "flow.reboot-effect-recheck/v1",
            effect_id: effect.effect_id,
            idempotency_key: effect.idempotency_key,
            classification: effect.classification,
            operation_contract: effect.operation_contract,
            recovery: "reconcile",
            observed_status: "uncertain",
            observation: presentObservation(effect),
          })),
        };
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({
    runAuthority: rebootedAuthority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: registration },
  });
  const suspended = rebooted.query({ run_id: launch.run_id });
  assert.equal(suspended.reboot_revalidation.valid, true);
  assert.equal(rebooted.command(suspended.legal_actions[0]).accepted, true);

  const admitted = rebooted.query({ run_id: launch.run_id });
  const recovery = admitted.legal_actions.find(({ type }) => type === "recovery");
  assert.equal(recovery.recovery, "reconcile");
  assert.equal(rebooted.command(recovery).accepted, true);
  await until(() => rebooted.query({ run_id: launch.run_id }).phase === "succeeded");
  const completed = rebooted.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 1);
  assert.equal(completed.effects[0].effect_id, originalIntent.effect_id);
  assert.equal(completed.effects[0].receipt.provider_receipt.provider_id,
    "accepted-once");
});

for (const classification of ["read_only", "caller_idempotent"]) {
  test(`cross-boot ${classification} repeat-exact recovery survives a second reboot`,
    async (t) => {
      await runCrossBootRepeatExactRecovery(t, classification);
    });
}

test("a competing runtime inspects but cannot mutate regardless of lock age", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const ownerAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "owner"),
  });
  t.after(() => ownerAuthority.close());
  const owner = createFlowRuntime({ runAuthority: ownerAuthority });
  const prepared = owner.prepare(dynamicCheckpointProposal());
  const launch = owner.launch(confirmedLaunchRequest(prepared));

  await utimes(join(authorityDirectory, "authority.lock.sqlite"), 0, 0);
  const competitorAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "competitor"),
  });
  t.after(() => competitorAuthority.close());
  const competitor = createFlowRuntime({ runAuthority: competitorAuthority });

  assert.deepEqual(
    competitor.query({ run_id: launch.run_id }),
    owner.query({ run_id: launch.run_id }),
  );
  const rejection = competitor.command(
    competitor.query({ run_id: launch.run_id }).legal_actions[0],
  );
  assert.equal(rejection.code, "mutation_authority_unavailable");
  assert.equal(owner.query({ run_id: launch.run_id }).phase, "active");
});

test("the advisory lock fences a competing operating-system process", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const owner = fork(fileURLToPath(new URL(
    "../test-support/durable-owner-process.mjs",
    import.meta.url,
  )), [authorityDirectory], { silent: true });
  t.after(() => owner.kill());
  const [{ runId, projection }] = await once(owner, "message");
  const competitorAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "competitor-process"),
  });
  t.after(() => competitorAuthority.close());
  const competitor = createFlowRuntime({ runAuthority: competitorAuthority });

  assert.deepEqual(competitor.query({ run_id: runId }), projection);
  assert.equal(
    competitor.command(projection.legal_actions[0]).code,
    "mutation_authority_unavailable",
  );
  assert.equal(
    competitor.launch(confirmedLaunchRequest(
      prepareDistinctRun(competitor, "2"),
    )).code,
    "mutation_authority_unavailable",
  );

  owner.send("close");
  await once(owner, "exit");

  competitorAuthority.close();
  const successorAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "successor-process"),
  });
  t.after(() => successorAuthority.close());
  const successor = createFlowRuntime({ runAuthority: successorAuthority });
  assert.equal(
    successor.command(successor.query({ run_id: runId }).legal_actions[0])
      .accepted,
    true,
  );
});

test("a read-only watcher observes durable mutations from the owner", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const ownerAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "owner"),
  });
  t.after(() => ownerAuthority.close());
  const owner = createFlowRuntime({ runAuthority: ownerAuthority });
  const launch = launchDistinctRun(owner, "8");
  const inspectorAuthority = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspectorAuthority.close());
  const inspector = createFlowRuntime({ runAuthority: inspectorAuthority });
  const watcher = inspector.watch({ run_id: launch.run_id })[Symbol.asyncIterator]();
  const initial = (await watcher.next()).value;
  const update = watcher.next();

  owner.command(owner.query({ run_id: launch.run_id }).legal_actions[0]);

  const changed = await withTimeout(
    update,
    500,
    "durable watch did not observe the owner",
  );
  assert.notEqual(changed.value.watermark, initial.watermark);
  assert.equal(changed.value.phase, "succeeded");
  await watcher.return();
});

test("concurrent top-level runs are independently fenced below capacity", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "owner"),
    declaredCapacity: 2,
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });

  const first = launchDistinctRun(runtime, "3");
  const second = launchDistinctRun(runtime, "4");
  const secondBefore = runtime.query({ run_id: second.run_id });
  const thirdPrepared = prepareDistinctRun(runtime, "5");

  assert.equal(
    runtime.launch(confirmedLaunchRequest(thirdPrepared)).code,
    "host_capacity_exhausted",
  );

  runtime.command(runtime.query({ run_id: first.run_id }).legal_actions[0]);

  assert.deepEqual(runtime.query({ run_id: second.run_id }), secondBefore);
  const third = runtime.launch(confirmedLaunchRequest(thirdPrepared));
  assert.equal(third.created, true);
  assert.deepEqual(runtime.query().admission, {
    active_runs: 2,
    declared_capacity: 2,
  });
});

test("the authority epoch is rechecked immediately before an external effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let firstAuthority;
  let replacementAuthority;
  let adapterCalled = false;
  firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: effectLifecycle,
    beforeEffect() {
      firstAuthority.close();
      replacementAuthority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
      });
    },
  });
  t.after(() => firstAuthority.close());
  t.after(() => replacementAuthority?.close());
  const runtime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(runtime, "0");
  const receipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );

  await assert.rejects(
    () => firstAuthority.invokeEffect(receipt.effect_intents[0], {
      invoke() {
        adapterCalled = true;
      },
    }),
    (error) => error.code === "stale_authority_epoch",
  );
  assert.equal(adapterCalled, false);
});

test("only a complete durable effect intent is invoked and receipted", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: effectLifecycle,
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const receipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = receipt.effect_intents;

  assert.equal(intent.run_id, launch.run_id);
  assert.equal(intent.authority_epoch, 1);
  assert.equal(intent.authority_boot_id, "boot-a");
  assert.equal(intent.idempotency_key, "effect:test:v1");
  for (const field of [
    "decision_digest",
    "command_digest",
    "catalog_fingerprint",
    "route_snapshot",
    "capability_envelopes",
    "operation_contracts",
    "validator_contracts",
    "resource_claims",
    "time_facts",
    "subject_generations",
  ]) {
    assert.notEqual(intent[field], undefined, field);
  }

  assert.equal(await authority.invokeEffect(intent, {
    invoke: () => "invoked",
  }), "invoked");
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "succeeded");
  assert.equal(runtime.query().admission.active_runs, 0);
  await assert.rejects(
    () => authority.invokeEffect(intent, { invoke() {} }),
    (error) => error.code === "effect_already_recorded",
  );
  await assert.rejects(
    () => authority.recordEffectObservation(intent, {
      schema: "flow.effect-observation/v1",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      presence: "indeterminate",
      causation: null,
      provider_observation: { checked: true },
    }),
    (error) => error.code === "effect_already_recorded",
  );
});

test("authority rejects kernel resource claims outside prepared facts", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel(fold, command) {
      const decision = effectLifecycle(fold, command);
      if (decision.schema === "flow.rejection/v1") return decision;
      decision.effect_intents[0].resource_claims = [{
        kind: "production-database",
        id: "*",
      }];
      return decision;
    },
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");

  assert.throws(
    () => runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]),
    /lifecycle decisions must emit identified, idempotent effect intents/,
  );
  assert.deepEqual(runtime.query({ run_id: launch.run_id }).effects, []);
});

test("deferred terminal events survive out-of-order multi-effect settlement", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: multiEffectLifecycle,
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const first = runtime.command({
    schema: "flow.command/v1",
    type: "first_effect",
    run_id: launch.run_id,
  });
  const second = runtime.command({
    schema: "flow.command/v1",
    type: "terminal_effect",
    run_id: launch.run_id,
  });

  await authority.invokeEffect(second.effect_intents[0], {
    invoke: () => "terminal-first",
  });
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "active");
  await authority.invokeEffect(first.effect_intents[0], {
    invoke: () => "first-last",
  });

  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "succeeded");
  assert.equal(runtime.query().admission.active_runs, 0);
  const database = new DatabaseSync(
    join(authorityDirectory, "authority.sqlite"),
    { readOnly: true },
  );
  const releases = database.prepare(`
    SELECT COUNT(*) AS count
      FROM authority_events
     WHERE stream_id = 'host:admission'
       AND json_extract(payload_json, '$.type') = 'run_capacity_released'
       AND json_extract(payload_json, '$.run_id') = ?
  `).get(launch.run_id);
  database.close();
  assert.equal(Number(releases.count), 1);
});

test("an inspecting effect runner cannot create or mutate authority", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());

  await assert.rejects(
    () => inspector.invokeEffect({}, { invoke() {} }),
    (error) => error.code === "mutation_authority_unavailable",
  );
  await assert.rejects(
    () => stat(join(authorityDirectory, "authority.sqlite")),
    (error) => error.code === "ENOENT",
  );
});

test("a non-canonical command is rejected before durable mutation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const command = {
    ...runtime.query({ run_id: launch.run_id }).legal_actions[0],
    accidental_undefined: undefined,
  };

  const rejection = runtime.command(command);

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "invalid_command");
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "active");
});

test("a rejected asynchronous effect is not receipted", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: effectLifecycle,
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const receipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = receipt.effect_intents;

  await assert.rejects(
    () => authority.invokeEffect(intent, {
      invoke: async () => { throw new Error("provider failed"); },
    }),
    /provider failed/,
  );
  assert.equal(await authority.invokeEffect(intent, {
    invoke: async () => "retried",
  }), "retried");
  assert.equal(runtime.query({ run_id: launch.run_id }).phase, "succeeded");
});

test("concurrent dispatch reaches the effect Adapter only once", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: effectLifecycle,
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const receipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = receipt.effect_intents;
  let settle;
  let invocationCount = 0;
  const first = authority.invokeEffect(intent, {
    invoke() {
      invocationCount += 1;
      return new Promise((resolve) => { settle = resolve; });
    },
  });

  await assert.rejects(
    () => authority.invokeEffect(intent, {
      invoke() { invocationCount += 1; },
    }),
    (error) => error.code === "effect_dispatch_in_progress",
  );
  settle("done");
  assert.equal(await first, "done");
  assert.equal(invocationCount, 1);
});

test("settlement after lock release cannot write an effect receipt", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: effectLifecycle,
  });
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const receipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = receipt.effect_intents;
  let settle;
  const invocation = authority.invokeEffect(intent, {
    invoke: () => new Promise((resolve) => { settle = resolve; }),
  });

  await Promise.resolve();
  authority.close();
  settle("provider-settled");
  await assert.rejects(
    () => invocation,
    (error) => error.code === "stale_authority_epoch",
  );

  const recovered = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recovered.close());
  assert.equal(await recovered.invokeEffect(intent, {
    invoke: () => "reconciled",
  }), "reconciled");
});

test("same-boot recovery adopts the exact outstanding effect", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: effectLifecycle,
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "0");
  const receipt = firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  const [intent] = receipt.effect_intents;
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
    lifecycleKernel: effectLifecycle,
  });
  t.after(() => recoveredAuthority.close());
  let invoked;
  await recoveredAuthority.invokeEffect(intent, {
    invoke(adopted) {
      invoked = adopted;
    },
  });

  assert.equal(invoked.effect_id, intent.effect_id);
  assert.equal(invoked.idempotency_key, intent.idempotency_key);
  assert.equal(invoked.authority_epoch, 2);
  assert.equal(invoked.authority_boot_id, "boot-a");
  assert.equal(
    createFlowRuntime({ runAuthority: recoveredAuthority }).query({
      run_id: launch.run_id,
    }).phase,
    "succeeded",
  );
});

test("recovery fails closed for effects that require reconciliation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: (fold, command) => effectLifecycle(
      fold,
      command,
      "reconcilable",
    ),
  });
  const runtime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(runtime, "0");
  const receipt = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  firstAuthority.close();

  const recovered = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recovered.close());
  await assert.rejects(
    () => recovered.invokeEffect(receipt.effect_intents[0], { invoke() {} }),
    (error) => error.code === "effect_reconciliation_required",
  );
  const normalized = await recovered.recordEffectObservation(
    receipt.effect_intents[0],
    {
      schema: "flow.effect-observation/v1",
      effect_id: receipt.effect_intents[0].effect_id,
      idempotency_key: receipt.effect_intents[0].idempotency_key,
      presence: "absent",
      causation: null,
      provider_observation: null,
    },
  );
  assert.equal(normalized.presence, "indeterminate");
  await assert.rejects(
    () => recovered.invokeEffect(receipt.effect_intents[0], {
      reconciliation: "adopt_present",
    }),
    (error) => error.code === "effect_presence_not_proven",
  );
  await assert.rejects(
    () => recovered.invokeEffect(receipt.effect_intents[0], {
      reconciliation: "invoke_absent",
      invoke() {},
    }),
    (error) => error.code === "effect_absence_not_proven",
  );
  const presentWithoutEvidence = await recovered.recordEffectObservation(
    receipt.effect_intents[0],
    {
      schema: "flow.effect-observation/v1",
      effect_id: receipt.effect_intents[0].effect_id,
      idempotency_key: receipt.effect_intents[0].idempotency_key,
      presence: "present",
      causation: {
        effect_id: receipt.effect_intents[0].effect_id,
        idempotency_key: receipt.effect_intents[0].idempotency_key,
      },
      provider_observation: null,
    },
  );
  assert.equal(presentWithoutEvidence.presence, "indeterminate");
  await recovered.recordEffectObservation(receipt.effect_intents[0], {
    schema: "flow.effect-observation/v1",
    effect_id: receipt.effect_intents[0].effect_id,
    idempotency_key: receipt.effect_intents[0].idempotency_key,
    presence: "absent",
    causation: null,
    provider_observation: { found: false },
  });
  await assert.rejects(
    () => recovered.invokeEffect(receipt.effect_intents[0], {
      reconciliation: "invoke_absent",
      invoke() { throw new Error("receipt lost after mutation"); },
    }),
    /receipt lost after mutation/,
  );
  await assert.rejects(
    () => recovered.invokeEffect(receipt.effect_intents[0], {
      reconciliation: "invoke_absent",
      invoke() { assert.fail("stale absence must not authorize invocation"); },
    }),
    (error) => error.code === "effect_absence_not_proven",
  );
});

test("presence evidence older than an invocation cannot be adopted", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: (fold, command) => effectLifecycle(
      fold,
      command,
      "reconcilable",
    ),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const [intent] = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  ).effect_intents;
  await authority.recordEffectObservation(intent, {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "present",
    causation: {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    },
    provider_observation: { provider_id: "existing" },
  });
  await assert.rejects(
    () => authority.invokeEffect(intent, {
      invoke() { throw new Error("receipt lost after mutation"); },
    }),
    /receipt lost after mutation/,
  );

  await assert.rejects(
    () => authority.invokeEffect(intent, { reconciliation: "adopt_present" }),
    (error) => error.code === "effect_presence_not_proven",
  );
});

test("one-shot effects cannot use absence to authorize reinvocation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: (fold, command) => effectLifecycle(
      fold,
      command,
      "one_shot_uncertain",
    ),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "0");
  const [intent] = runtime.command(
    runtime.query({ run_id: launch.run_id }).legal_actions[0],
  ).effect_intents;
  await authority.recordEffectObservation(intent, {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "absent",
    causation: null,
    provider_observation: { found: false },
  });

  await assert.rejects(
    () => authority.invokeEffect(intent, {
      reconciliation: "invoke_absent",
      invoke() { assert.fail("one-shot effect must not be invoked"); },
    }),
    (error) => error.code === "effect_absence_not_proven",
  );
});

test("effect authority seams require explicit admission after reboot", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: (fold, command) => effectLifecycle(
      fold,
      command,
      "reconcilable",
    ),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "0");
  const [intent] = firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions[0],
  ).effect_intents;
  await firstAuthority.recordEffectObservation(intent, {
    schema: "flow.effect-observation/v1",
    effect_id: intent.effect_id,
    idempotency_key: intent.idempotency_key,
    presence: "present",
    causation: {
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    },
    provider_observation: { provider_id: "existing" },
  });
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
  });
  t.after(() => rebootedAuthority.close());
  await assert.rejects(
    () => rebootedAuthority.recordEffectObservation(intent, {
      schema: "flow.effect-observation/v1",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      presence: "absent",
      causation: null,
      provider_observation: { found: false },
    }),
    (error) => error.code === "run_requires_reboot_admission",
  );
  await assert.rejects(
    () => rebootedAuthority.invokeEffect(intent, {
      reconciliation: "adopt_present",
    }),
    (error) => error.code === "run_requires_reboot_admission",
  );
  assert.equal(
    createFlowRuntime({ runAuthority: rebootedAuthority }).query({
      run_id: launch.run_id,
    }).admission,
    "suspended_after_reboot",
  );
});

test("an unresolved effect keeps reboot admission suspended", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
    lifecycleKernel: (fold, command) => effectLifecycle(
      fold,
      command,
      "reconcilable",
    ),
  });
  const firstRuntime = createFlowRuntime({ runAuthority: firstAuthority });
  const launch = launchDistinctRun(firstRuntime, "0");
  const receipt = firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions[0],
  );
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    lifecycleKernel: (fold, command) => effectLifecycle(
      fold,
      command,
      "reconcilable",
    ),
    rebootObservationAdapter: {
      observe({ prepared, unresolvedEffects }) {
        unresolvedEffects.length = 0;
        return preparedObservation(prepared);
      },
    },
  });
  t.after(() => rebootedAuthority.close());
  const rebooted = createFlowRuntime({ runAuthority: rebootedAuthority });
  const action = rebooted.query({ run_id: launch.run_id }).legal_actions[0];

  assert.equal(action.revalidation.unresolved_effects.length, 1);
  assert.equal(action.revalidation.valid, false);
  assert.equal(
    rebooted.command(action).code,
    "reboot_revalidation_failed",
  );
  let adapterCalled = false;
  await assert.rejects(
    () => rebootedAuthority.invokeEffect(receipt.effect_intents[0], {
      invoke() { adapterCalled = true; },
    }),
    (error) => error.code === "run_requires_reboot_admission",
  );
  assert.equal(adapterCalled, false);
});

test("a fabricated current-epoch effect intent cannot reach its adapter", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let adapterCalled = false;
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());

  await assert.rejects(
    () => authority.invokeEffect({
      schema: "flow.effect-intent/v1",
      effect_id: "effect:fabricated",
      authority_epoch: 1,
      authority_boot_id: "boot-a",
    }, {
      invoke() {
        adapterCalled = true;
      },
    }),
    (error) => error.code === "unrecorded_effect_intent",
  );
  assert.equal(adapterCalled, false);
});

test("corrupt or non-replayable run streams fail closed through query", async (t) => {
  const corruptions = {
    reordering(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        UPDATE authority_events SET sequence = 100
         WHERE stream_id = ? AND sequence = 2
      `).run(runId);
    },
    omission(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        DELETE FROM authority_events WHERE stream_id = ? AND sequence = 2
      `).run(runId);
    },
    duplication(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        INSERT INTO authority_events
        SELECT stream_id, 4, generation, contract, payload_json,
               payload_digest, previous_digest, record_digest, authority_epoch,
               boot_id, process_identity
          FROM authority_events
         WHERE stream_id = ? AND sequence = 3
      `).run(runId);
    },
    digest_conflict(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        UPDATE authority_events SET payload_json = '{}'
         WHERE stream_id = ? AND sequence = 1
      `).run(runId);
    },
    unknown_contract(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        UPDATE authority_events SET contract = 'flow.run-event/v999'
         WHERE stream_id = ? AND sequence = 1
      `).run(runId);
    },
    corrupt_json(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        UPDATE authority_events SET payload_json = '{'
         WHERE stream_id = ? AND sequence = 1
      `).run(runId);
    },
    stale_generation(database, runId) {
      allowEventTampering(database);
      database.prepare(`
        UPDATE authority_events SET generation = 2
         WHERE stream_id = ? AND sequence = 1
      `).run(runId);
    },
    fold_mismatch(database, runId) {
      database.prepare(`
        UPDATE authority_streams SET fold_json = '{}'
         WHERE stream_id = ?
      `).run(runId);
    },
  };

  for (const [name, corrupt] of Object.entries(corruptions)) {
    const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
    const { runId } = seedCompletedRun(authorityDirectory);
    const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
    corrupt(database, runId);
    database.close();
    const inspector = createDurableRunAuthority({
      authorityDirectory,
      access: "inspect",
      hostIdentityAdapter: fixedHostIdentity("boot-a", `inspector-${name}`),
    });
    t.after(() => inspector.close());

    const rejection = createFlowRuntime({ runAuthority: inspector }).query({
      run_id: runId,
    });
    assert.equal(rejection.schema, "flow.rejection/v1", name);
    assert.equal(rejection.code, "authority_integrity_failure", name);
    assert.equal(rejection.reason, name, name);
    assert.equal(rejection.authority_watermark, null, name);
    assert.deepEqual(rejection.legal_actions, [], name);
    const commandRejection = createFlowRuntime({
      runAuthority: inspector,
    }).command({
      schema: "flow.command/v1",
      type: "checkpoint_decision",
      run_id: runId,
      checkpoint_id: "confirm-plan",
      decision: "approve",
      expected_watermark: `sha256:${"0".repeat(64)}`,
    });
    assert.equal(commandRejection.code, "authority_integrity_failure", name);
    assert.equal(commandRejection.reason, name, name);
  }
});

test("store-level corruption fails closed instead of appearing absent", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  await writeFile(join(authorityDirectory, "authority.sqlite"), "not sqlite");
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());

  const rejection = createFlowRuntime({ runAuthority: inspector }).query();

  assert.equal(rejection.schema, "flow.rejection/v1");
  assert.equal(rejection.code, "authority_integrity_failure");
  assert.equal(rejection.reason, "corrupt_store");
});

test("host stream corruption fails closed through the run index", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  seedCompletedRun(authorityDirectory);
  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  database.prepare(`
    UPDATE authority_streams SET fold_json = '{}'
     WHERE stream_id = 'host:runs'
  `).run();
  database.close();
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());

  const rejection = createFlowRuntime({ runAuthority: inspector }).query();

  assert.equal(rejection.code, "authority_integrity_failure");
  assert.equal(rejection.reason, "fold_mismatch");
});

test("schema-v2 host admission folds without recovery fields reopen cleanly", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "seed"),
  });
  t.after(() => authority.close());
  authority.close();

  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  const stream = database.prepare(`
    SELECT head_digest FROM authority_streams WHERE stream_id = 'host:admission'
  `).get();
  const baselineFold = {
    schema: "flow.host-admission-fold/v1",
    watermark: stream.head_digest,
    authority_epoch: 1,
    boot_id: "boot-a",
    declared_capacity: 4,
    process_identity: "seed",
    active_runs: [],
  };
  database.prepare(`
    UPDATE authority_streams
       SET fold_json = ?, fold_digest = ?
     WHERE stream_id = 'host:admission'
  `).run(JSON.stringify(canonicalize(baselineFold)), digest(baselineFold));
  database.close();

  const reopened = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-b", "inspector"),
  });
  t.after(() => reopened.close());
  const projection = createFlowRuntime({ runAuthority: reopened }).query();

  assert.notEqual(
    projection.code,
    "authority_integrity_failure",
    JSON.stringify(projection),
  );
  assert.equal(projection.authority_schema.status, "compatible");
});

test("a run stream without its launch event fails closed", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  seedCompletedRun(authorityDirectory);
  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  database.prepare(`
    INSERT INTO authority_streams(
      stream_id, stream_kind, generation, head_sequence, head_digest
    ) VALUES ('run:missing-launch', 'run', 1, 0, ?)
  `).run(`sha256:${"0".repeat(64)}`);
  database.close();
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());

  const rejection = createFlowRuntime({ runAuthority: inspector }).query({
    run_id: "run:missing-launch",
  });

  assert.equal(rejection.code, "authority_integrity_failure");
  assert.equal(rejection.reason, "missing_launch_event");
});

test("durable authority events cannot be updated or deleted", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const { runId } = seedCompletedRun(authorityDirectory);
  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  t.after(() => database.close());

  assert.throws(
    () => database.prepare(`
      UPDATE authority_events SET payload_json = '{}'
       WHERE stream_id = ? AND sequence = 1
    `).run(runId),
    /authority events are append-only/,
  );
  assert.throws(
    () => database.prepare(`
      DELETE FROM authority_events WHERE stream_id = ? AND sequence = 1
    `).run(runId),
    /authority events are append-only/,
  );
});

function seedCompletedRun(authorityDirectory) {
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "seed"),
  });
  const runtime = createFlowRuntime({ runAuthority: authority });
  const launch = launchDistinctRun(runtime, "6");
  runtime.command(runtime.query({ run_id: launch.run_id }).legal_actions[0]);
  authority.close();
  return { runId: launch.run_id };
}

function allowEventTampering(database) {
  database.exec(`
    DROP TRIGGER authority_events_no_update;
    DROP TRIGGER authority_events_no_delete;
  `);
}

function launchDistinctRun(runtime, fingerprintDigit) {
  const prepared = prepareDistinctRun(runtime, fingerprintDigit);
  return runtime.launch(confirmedLaunchRequest(prepared));
}

function prepareDistinctRun(runtime, fingerprintDigit) {
  const proposal = dynamicCheckpointProposal();
  proposal.explicit_facts.catalog_fingerprint =
    `sha256:${fingerprintDigit.repeat(64)}`;
  return runtime.prepare(proposal);
}

async function runCrossBootRepeatExactRecovery(t, classification) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  let mode = "lost";
  let invocationCount = 0;
  const idempotencyKeys = [];
  const invocationBootIds = [];
  const registration = {
    classification,
    invoke(intent) {
      invocationCount += 1;
      idempotencyKeys.push(intent.idempotency_key);
      invocationBootIds.push(intent.authority_boot_id);
      if (mode === "lost") return new Promise(() => {});
      return operationReceipt(intent);
    },
  };
  const proposal = registeredOperationProposal({ classification });
  proposal.explicit_facts.time_facts = rebootTimeFacts({
    wallValueMs: 1_700_000_000_000,
    wallUncertaintyMs: 0,
    monotonicValueNs: "1000000000",
    monotonicUncertaintyNs: "0",
    bootId: "boot-a",
  });
  proposal.explicit_facts.limits.max_elapsed_seconds = 60;

  const rebootObservationAdapter = (bootId) => ({
    observe({ prepared, unresolvedEffects }) {
      const observation = withRebootBoot(
        preparedObservation(prepared),
        bootId,
      );
      return {
        ...observation,
        effect_rechecks: unresolvedEffects.map((effect) => ({
          schema: "flow.reboot-effect-recheck/v1",
          effect_id: effect.effect_id,
          idempotency_key: effect.idempotency_key,
          classification: effect.classification,
          operation_contract: effect.operation_contract,
          recovery: "repeat_exact",
          observed_status: "unresolved",
          observation: {
            schema: "flow.effect-observation/v1",
            effect_id: effect.effect_id,
            idempotency_key: effect.idempotency_key,
            presence: "absent",
            causation: null,
            provider_observation: {
              found: false,
              proof: "exact_absence",
            },
          },
        })),
      };
    },
  });

  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = createFlowRuntime({
    runAuthority: firstAuthority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: registration },
  });
  const prepared = firstRuntime.prepare(proposal);
  const launch = firstRuntime.launch(confirmedLaunchRequest(prepared));
  const firstReceipt = firstRuntime.command(
    firstRuntime.query({ run_id: launch.run_id }).legal_actions.find(
      ({ decision }) => decision === "approve",
    ),
  );
  assert.equal(firstReceipt.accepted, true);
  const originalIntent = firstReceipt.effect_intents[0];
  await until(() => invocationCount === 1);
  firstAuthority.close();

  const secondAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    rebootObservationAdapter: rebootObservationAdapter("boot-b"),
  });
  const secondRuntime = createFlowRuntime({
    runAuthority: secondAuthority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: registration },
  });
  const secondSuspended = secondRuntime.query({ run_id: launch.run_id });
  assert.equal(secondSuspended.reboot_revalidation.valid, true);
  assert.equal(secondSuspended.reboot_revalidation.unresolved_effects.length, 1);
  assert.equal(secondRuntime.command(
    secondSuspended.legal_actions[0],
  ).accepted, true);
  const secondAdmitted = secondRuntime.query({ run_id: launch.run_id });
  const secondRecovery = secondAdmitted.legal_actions.find(
    ({ type }) => type === "recovery",
  );
  assert.equal(secondRecovery.recovery, "repeat_exact");
  assert.equal(secondRuntime.command(secondRecovery).accepted, true);
  await until(() => invocationCount === 2);
  secondAuthority.close();
  mode = "complete";

  const thirdAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-c", "process-c"),
    rebootObservationAdapter: rebootObservationAdapter("boot-c"),
  });
  t.after(() => thirdAuthority.close());
  const thirdRuntime = createFlowRuntime({
    runAuthority: thirdAuthority,
    registeredOperations: { [TEST_OPERATION_CONTRACT]: registration },
  });
  const thirdSuspended = thirdRuntime.query({ run_id: launch.run_id });
  assert.equal(thirdSuspended.reboot_revalidation.valid, true);
  assert.equal(thirdSuspended.reboot_revalidation.unresolved_effects.length, 1);
  assert.equal(thirdRuntime.command(
    thirdSuspended.legal_actions[0],
  ).accepted, true);
  const thirdAdmitted = thirdRuntime.query({ run_id: launch.run_id });
  const thirdRecovery = thirdAdmitted.legal_actions.find(
    ({ type }) => type === "recovery",
  );
  assert.equal(thirdRecovery.recovery, "repeat_exact");
  assert.equal(thirdRuntime.command(thirdRecovery).accepted, true);
  await until(() => thirdRuntime.query({ run_id: launch.run_id }).phase === "succeeded");

  const completed = thirdRuntime.query({ run_id: launch.run_id });
  assert.equal(invocationCount, 3);
  assert.deepEqual(idempotencyKeys, [
    originalIntent.idempotency_key,
    originalIntent.idempotency_key,
    originalIntent.idempotency_key,
  ]);
  assert.deepEqual(invocationBootIds, ["boot-a", "boot-b", "boot-c"]);
  assert.equal(completed.effects[0].idempotency_key,
    originalIntent.idempotency_key);
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function until(condition) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function effectLifecycle(fold, command, classification = "caller_idempotent") {
  const decision = decideLifecycle(fold, command);
  return decision.schema === "flow.rejection/v1"
    ? decision
    : {
        ...decision,
        effect_intents: [{
          schema: "flow.effect-intent/v1",
          effect_id: "effect:test",
          idempotency_key: "effect:test:v1",
          attempt_id: "attempt:test",
          classification,
          operation_contract: "flow.operation/test/v1",
          route_binding: null,
          resource_claims: [],
        }],
      };
}

function multiEffectLifecycle(_fold, command) {
  const terminal = command.type === "terminal_effect";
  return {
    schema: "flow.decision/v1",
    command_type: command.type,
    events: terminal ? [{ type: "run_succeeded" }] : [],
    effect_intents: [{
      schema: "flow.effect-intent/v1",
      effect_id: terminal ? "effect:terminal" : "effect:first",
      idempotency_key: terminal ? "effect:terminal:v1" : "effect:first:v1",
      attempt_id: terminal ? "attempt:terminal" : "attempt:first",
      classification: "caller_idempotent",
      operation_contract: "flow.operation/test/v1",
      route_binding: null,
      resource_claims: [],
    }],
    obligations: [],
    projection_hints: [],
  };
}

function preparedRebootObservation() {
  return Object.freeze({
    observe: ({ prepared }) => withRebootBoot(
      preparedObservation(prepared),
      "boot-b",
    ),
  });
}

function withRebootBoot(observation, bootId) {
  return {
    ...observation,
    time_facts: observation.time_facts.map((fact) =>
      fact.kind === "boot" ? { ...fact, boot_id: bootId } : fact),
  };
}

function rebootTimeFacts({
  bootId,
  monotonicUncertaintyNs,
  monotonicValueNs,
  wallUncertaintyMs,
  wallValueMs,
}) {
  return [
    {
      schema: "flow.time-fact/v1",
      kind: "wall_clock",
      value_ms: wallValueMs,
      uncertainty_ms: wallUncertaintyMs,
      clock_source_id: "wall:host-a",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "suspend_excluding_monotonic",
      value_ns: monotonicValueNs,
      uncertainty_ns: monotonicUncertaintyNs,
      clock_source_id: "mono:host-a",
    },
    {
      schema: "flow.time-fact/v1",
      kind: "boot",
      boot_id: bootId,
    },
    {
      schema: "flow.time-fact/v1",
      kind: "clock_source",
      identity: "clockset:host-a:v1",
    },
  ];
}

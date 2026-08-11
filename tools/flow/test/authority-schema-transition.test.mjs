import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  readAuthoritySchemaCompatibility,
  transitionAuthoritySchema,
} from "../src/authority-schema.mjs";
import { createBackupManifest } from "../src/backup-restore.mjs";
import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";
import {
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";

test("a fresh authority store exposes its exact compatible schema release", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const boundaries = [];
  const authority = createDurableRunAuthority({
    authorityDirectory,
    beforeSchemaTransitionCommit: (boundary) => boundaries.push(boundary),
    afterSchemaTransitionCommit: (boundary) => boundaries.push(boundary),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());

  const projection = createFlowRuntime({ runAuthority: authority }).query();

  assert.deepEqual(projection.authority_schema, {
    schema: "flow.authority-schema-compatibility/v1",
    status: "compatible",
    store_contract: "flow.sqlite-authority-store/v1",
    version: 2,
    transition_release: {
      schema: "flow.runtime-release/v1",
      id: "flow-runtime-authority-schema/v2",
      catalog_version: 8,
    },
    transition_sequence: 1,
    watermark: projection.authority_schema.watermark,
  });
  assert.match(projection.authority_schema.watermark, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(projection.legal_actions, []);
  assert.equal(
    await validatesPublishedSchema(
      "flow.authority-schema-compatibility.v1.schema.json",
      projection.authority_schema,
    ),
    true,
  );
  assert.equal(boundaries.length, 2);
  assert.deepEqual(Object.keys(boundaries[0]), Object.keys(boundaries[1]));
  for (const boundary of boundaries) {
    assert.equal(
      await validatesPublishedSchema(
        "flow.authority-schema-transition-boundary.v1.schema.json",
        boundary,
      ),
      true,
    );
  }
});

test("inspection before store creation exposes uninitialized compatibility", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());

  const projection = createFlowRuntime({ runAuthority: inspector }).query();

  assert.equal(projection.authority_schema.status, "uninitialized");
  assert.equal(projection.authority_schema.version, 0);
  assert.deepEqual(projection.legal_actions, []);
  assert.equal(
    await validatesPublishedSchema(
      "flow.authority-schema-compatibility.v1.schema.json",
      projection.authority_schema,
    ),
    true,
  );
});

test("a version-one store transitions without changing existing run behavior", async (t) => {
  const authorityDirectory = await versionOneStoreWithRun(t);
  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  const beforeRuntime = createFlowRuntime({ runAuthority: inspector });
  const beforeHost = beforeRuntime.query();
  const beforeRun = beforeRuntime.query({ run_id: beforeHost.runs[0] });
  inspector.close();

  assert.equal(beforeHost.authority_schema.status, "transition_required");
  assert.equal(beforeHost.authority_schema.version, 1);
  assert.deepEqual(beforeHost.legal_actions.map(({ type }) => type), [
    "recovery",
  ]);
  assert.equal(
    beforeHost.legal_actions[0].recovery,
    "authority_schema_transition",
  );
  assert.deepEqual(beforeRun.legal_actions, []);
  for (const view of Object.values(beforeRun.views)) {
    assert.equal(view.authority_watermark, beforeRun.watermark);
    assert.deepEqual(view.legal_actions, []);
  }
  assert.equal(
    await validatesPublishedSchema(
      "flow.authority-schema-compatibility.v1.schema.json",
      beforeHost.authority_schema,
    ),
    true,
  );

  const boundaries = [];
  const owner = createDurableRunAuthority({
    authorityDirectory,
    beforeSchemaTransitionCommit: (boundary) => boundaries.push(boundary),
    afterSchemaTransitionCommit: (boundary) => boundaries.push(boundary),
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => owner.close());
  const afterRuntime = createFlowRuntime({ runAuthority: owner });
  const watcher = afterRuntime.watch();
  t.after(() => watcher.return());
  assert.equal(
    (await watcher.next()).value.authority_schema.status,
    "transition_required",
  );
  const runWatcher = afterRuntime.watch({ run_id: beforeRun.run_id });
  t.after(() => runWatcher.return());
  assert.deepEqual((await runWatcher.next()).value.legal_actions, []);
  const blockedPrepared = afterRuntime.prepare(dynamicCheckpointProposal());
  const blockedLaunch = afterRuntime.launch(
    confirmedLaunchRequest(blockedPrepared),
  );
  assert.equal(blockedLaunch.code, "authority_schema_transition_required");
  assert.deepEqual(
    blockedLaunch.legal_actions,
    afterRuntime.query().legal_actions,
  );
  const blockedRunCommand = afterRuntime.command({
    schema: "flow.command/v1",
    type: "cancel",
    run_id: beforeRun.run_id,
  });
  assert.equal(
    blockedRunCommand.code,
    "authority_schema_transition_required",
  );
  assert.equal(blockedRunCommand.command_type, "cancel");
  assert.equal(blockedRunCommand.run_id, beforeRun.run_id);
  assert.equal(blockedRunCommand.authority_watermark_domain, "host");
  assert.deepEqual(
    blockedRunCommand.legal_actions,
    afterRuntime.query().legal_actions,
  );
  const unrelatedRecovery = afterRuntime.command({
    schema: "flow.command/v1",
    type: "recovery",
    recovery: "other",
  });
  assert.equal(
    unrelatedRecovery.code,
    "authority_schema_transition_required",
  );
  const staleAction = structuredClone(afterRuntime.query().legal_actions[0]);
  staleAction.expected_watermark = `sha256:${"0".repeat(64)}`;
  const stale = afterRuntime.command(staleAction);
  assert.equal(stale.code, "stale_authority_schema_transition");
  assert.deepEqual(stale.legal_actions, afterRuntime.query().legal_actions);
  const watchedTransition = watcher.next();
  const watchedRunTransition = runWatcher.next();
  const transitionReceipt = afterRuntime.command(
    afterRuntime.query().legal_actions[0],
  );
  const afterHost = afterRuntime.query();
  assert.equal(
    (await watchedTransition).value.authority_schema.status,
    "compatible",
  );
  const afterRun = afterRuntime.query({ run_id: beforeRun.run_id });
  const watchedRun = (await watchedRunTransition).value;

  assert.equal(afterHost.authority_schema.status, "compatible");
  assert.equal(transitionReceipt.accepted, true);
  assert.equal(afterHost.authority_schema.version, 2);
  assert.equal(
    afterHost.authority_schema.transition_release.id,
    "flow-runtime-authority-schema/v2",
  );
  assert.deepEqual(replayVisibleRun(afterRun), replayVisibleRun(beforeRun));
  assert.deepEqual(watchedRun, afterRun);
  assert.deepEqual(
    afterRun.legal_actions.map(({ type, decision }) => ({ type, decision })),
    [
      { type: "checkpoint_decision", decision: "approve" },
      { type: "checkpoint_decision", decision: "decline" },
    ],
  );
  assert.equal(boundaries.length, 2);
  for (const boundary of boundaries) {
    assert.equal(
      await validatesPublishedSchema(
        "flow.authority-schema-transition-boundary.v1.schema.json",
        boundary,
      ),
      true,
    );
  }
});

test("a version-one store with backup history projects its schema transition", async (t) => {
  const authorityDirectory = await versionOneStoreWithBackup(t);
  const owner = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "owner"),
  });
  t.after(() => owner.close());
  const runtime = createFlowRuntime({ runAuthority: owner });
  const before = runtime.query();

  assert.equal(before.authority_schema.status, "transition_required");
  assert.equal(before.backup.state, "completed");
  assert.deepEqual(before.legal_actions.map(({ recovery }) => recovery), [
    "authority_schema_transition",
  ]);

  const receipt = runtime.command(before.legal_actions[0]);

  assert.equal(receipt.accepted, true);
  assert.equal(runtime.query().authority_schema.status, "compatible");
  assert.equal(runtime.query().backup.state, "completed");
});

test("schema transition outranks an active durable restore barrier", async (t) => {
  const authorityDirectory = await versionOneStoreWithActiveRestore(t);
  const owner = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: {
      observeRestore: () => completeRecoveryObservation(),
      restore: () => ({ provider_receipt_id: "restore/provider-1" }),
    },
    hostIdentityAdapter: fixedHostIdentity("boot-b", "owner"),
  });
  t.after(() => owner.close());
  const runtime = createFlowRuntime({ runAuthority: owner });
  const before = runtime.query();

  assert.equal(before.restore.active, true);
  assert.equal(before.authority_schema.status, "transition_required");
  assert.equal(
    before.legal_actions[0].recovery,
    "authority_schema_transition",
  );

  assert.equal(runtime.command(before.legal_actions[0]).accepted, true);
  const after = runtime.query();
  assert.equal(after.authority_schema.status, "compatible");
  assert.equal(after.restore.active, true);
  assert.equal(after.legal_actions[0].type, "restore_reconcile");
});

test("termination before the schema commit preserves the old valid authority", async (t) => {
  const authorityDirectory = await versionOneStoreWithRun(t);

  const crashingAuthority = createDurableRunAuthority({
    authorityDirectory,
    beforeSchemaTransitionCommit() {
      throw new Error("simulated termination before schema commit");
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "crashing-process"),
  });
  const crashingRuntime = createFlowRuntime({ runAuthority: crashingAuthority });
  assert.throws(
    () => crashingRuntime.command(crashingRuntime.query().legal_actions[0]),
    /simulated termination before schema commit/,
  );
  crashingAuthority.close();

  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());
  const projection = createFlowRuntime({ runAuthority: inspector }).query();

  assert.equal(projection.authority_schema.status, "transition_required");
  assert.equal(projection.authority_schema.version, 1);
  assert.equal(projection.runs.length, 1);
});

test("termination after the schema commit preserves new replay-valid authority", async (t) => {
  const authorityDirectory = await versionOneStoreWithRun(t);

  const crashingAuthority = createDurableRunAuthority({
    authorityDirectory,
    afterSchemaTransitionCommit() {
      throw new Error("simulated termination after schema commit");
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "crashing-process"),
  });
  const crashingRuntime = createFlowRuntime({ runAuthority: crashingAuthority });
  assert.throws(
    () => crashingRuntime.command(crashingRuntime.query().legal_actions[0]),
    /simulated termination after schema commit/,
  );
  crashingAuthority.close();

  const inspector = createDurableRunAuthority({
    authorityDirectory,
    access: "inspect",
    hostIdentityAdapter: fixedHostIdentity("boot-a", "inspector"),
  });
  t.after(() => inspector.close());
  const runtime = createFlowRuntime({ runAuthority: inspector });
  const projection = runtime.query();

  assert.equal(projection.authority_schema.status, "compatible");
  assert.equal(projection.authority_schema.version, 2);
  assert.equal(runtime.query({ run_id: projection.runs[0] }).phase, "active");
});

test("unknown and incompatible authority schemas refuse public mutation", async (t) => {
  for (const incompatible of [
    {
      name: "unknown store contract",
      sql: "UPDATE authority_metadata SET contract = 'flow.unknown-store/v1'",
    },
    {
      name: "future schema version",
      sql: "UPDATE authority_metadata SET schema_version = 99",
    },
    {
      name: "mismatched transition release",
      sql: `UPDATE authority_metadata
              SET transition_release_json =
                '{"schema":"flow.runtime-release/v1","id":"other-release","catalog_version":8}'`,
    },
    {
      name: "version-one marker with retained transition history",
      sql: "UPDATE authority_metadata SET schema_version = 1",
    },
    {
      name: "malformed transition release",
      sql: `UPDATE authority_metadata
              SET transition_release_json = '"junk"'`,
    },
    {
      name: "transition release with unknown contract",
      sql: `UPDATE authority_metadata
              SET transition_release_json =
                '{"schema":"other/v1","id":"release","catalog_version":8}'`,
    },
    {
      name: "negative schema version",
      sql: "UPDATE authority_metadata SET schema_version = -1",
      corrupt: true,
    },
    {
      name: "negative transition sequence",
      sql: "UPDATE authority_metadata SET transition_sequence = -1",
      corrupt: true,
    },
    {
      name: "non-text store contract",
      sql: "UPDATE authority_metadata SET contract = x'00'",
    },
    {
      name: "non-text transition contract",
      sql: `DROP TRIGGER authority_schema_transitions_no_update;
            UPDATE authority_schema_transitions SET contract = x'00'`,
    },
    {
      name: "non-numeric transition version",
      sql: `DROP TRIGGER authority_schema_transitions_no_update;
            UPDATE authority_schema_transitions SET from_version = 'junk'`,
      corrupt: true,
    },
  ]) {
    await t.test(incompatible.name, async (t) => {
      const authorityDirectory = await currentStore(t);
      const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
      if (incompatible.corrupt) {
        database.exec("PRAGMA ignore_check_constraints = ON");
      }
      database.exec(incompatible.sql);
      database.close();

      const authority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity("boot-a", "incompatible-owner"),
      });
      t.after(() => authority.close());
      const runtime = createFlowRuntime({ runAuthority: authority });
      const host = runtime.query();
      const prepared = runtime.prepare(dynamicCheckpointProposal());
      const launch = runtime.launch(confirmedLaunchRequest(prepared));
      const command = runtime.command({
        schema: "flow.command/v1",
        type: "cancel",
        run_id: "run:unknown",
      });

      assert.equal(host.authority_schema.status, "incompatible");
      assert.deepEqual(host.legal_actions, []);
      assert.equal(
        await validatesPublishedSchema(
          "flow.authority-schema-compatibility.v1.schema.json",
          host.authority_schema,
        ),
        true,
      );
      for (const result of [launch, command]) {
        assert.equal(result.schema, "flow.rejection/v1");
        assert.equal(result.code, "authority_schema_incompatible");
        assert.equal(
          result.authority_watermark,
          host.watermark,
        );
        assert.equal(result.authority_watermark_domain, "host");
        assert.deepEqual(result.legal_actions, []);
      }

      const secondAuthority = createDurableRunAuthority({
        authorityDirectory,
        hostIdentityAdapter: fixedHostIdentity(
          "boot-a",
          "second-incompatible-owner",
        ),
      });
      t.after(() => secondAuthority.close());
      const secondResult = createFlowRuntime({
        runAuthority: secondAuthority,
      }).command({
        schema: "flow.command/v1",
        type: "cancel",
        run_id: "run:unknown",
      });
      assert.equal(secondResult.code, "authority_schema_incompatible");
    });
  }
});

test("a stale schema watermark is a non-poisoning no-op", async (t) => {
  const authorityDirectory = await versionOneStoreWithRun(t);
  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  t.after(() => database.close());
  const before = readAuthoritySchemaCompatibility(database);
  const columnsBefore = database.prepare(
    "PRAGMA table_info(authority_metadata)",
  ).all();
  const streamHeadsBefore = database.prepare(`
    SELECT stream_id, head_sequence, head_digest
      FROM authority_streams ORDER BY stream_id
  `).all();

  const stale = transitionAuthoritySchema(database, {
    expectedWatermark: `sha256:${"0".repeat(64)}`,
  });

  assert.deepEqual(stale, before);
  assert.deepEqual(readAuthoritySchemaCompatibility(database), before);
  assert.deepEqual(
    database.prepare("PRAGMA table_info(authority_metadata)").all(),
    columnsBefore,
  );
  assert.equal(
    database.prepare(`
      SELECT 1 FROM sqlite_schema
       WHERE type = 'table' AND name = 'authority_schema_transitions'
    `).get(),
    undefined,
  );
  assert.deepEqual(database.prepare(`
    SELECT stream_id, head_sequence, head_digest
      FROM authority_streams ORDER BY stream_id
  `).all(), streamHeadsBefore);

  const transitioned = transitionAuthoritySchema(database, {
    expectedWatermark: before.watermark,
  });
  assert.equal(transitioned.status, "compatible");
});

async function versionOneStoreWithRun(t) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "seed"),
  });
  const runtime = createFlowRuntime({ runAuthority: authority });
  const prepared = runtime.prepare(dynamicCheckpointProposal());
  runtime.launch(confirmedLaunchRequest(prepared));
  authority.close();

  downgradeCurrentStoreToVersionOne(authorityDirectory);
  return authorityDirectory;
}

async function versionOneStoreWithBackup(t) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = {
    replacement_authority: {
      database_streams: [],
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
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: {
      observeBackup: () => observation,
      createBackup: ({ manifest }) => ({
        manifest_digest: manifest.manifest_digest,
      }),
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "seed"),
  });
  const runtime = createFlowRuntime({ runAuthority: authority });
  assert.equal(runtime.command({ type: "backup_create" }).accepted, true);
  authority.close();

  downgradeCurrentStoreToVersionOne(authorityDirectory);
  return authorityDirectory;
}

async function versionOneStoreWithActiveRestore(t) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const observation = completeRecoveryObservation();
  const authority = createDurableRunAuthority({
    authorityDirectory,
    backupRestoreAdapter: {
      observeRestore: () => observation,
      restore: () => ({ provider_receipt_id: "restore/provider-1" }),
    },
    hostIdentityAdapter: fixedHostIdentity("boot-a", "seed"),
  });
  const runtime = createFlowRuntime({ runAuthority: authority });
  assert.equal(runtime.command({
    type: "restore",
    manifest: createBackupManifest(observation),
  }).accepted, true);
  authority.close();

  downgradeCurrentStoreToVersionOne(authorityDirectory);
  return authorityDirectory;
}

function completeRecoveryObservation() {
  return {
    replacement_authority: {
      database_streams: [],
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
}

function downgradeCurrentStoreToVersionOne(authorityDirectory) {

  const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
  database.exec(`
    DROP TRIGGER authority_schema_transitions_no_update;
    DROP TRIGGER authority_schema_transitions_no_delete;
    DROP TABLE authority_schema_transitions;
    ALTER TABLE authority_metadata RENAME TO authority_metadata_v2;
    CREATE TABLE authority_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      contract TEXT NOT NULL
    );
    INSERT INTO authority_metadata(singleton, contract)
      VALUES (1, 'flow.sqlite-authority-store/v1');
    DROP TABLE authority_metadata_v2;
  `);
  database.close();
}

async function currentStore(t) {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-authority-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "seed"),
  });
  authority.close();
  return authorityDirectory;
}

function replayVisibleRun(projection) {
  const {
    admission: _admission,
    authority_boot_id: _authorityBootId,
    authority_epoch: _authorityEpoch,
    legal_actions: _legalActions,
    stream_generation: _streamGeneration,
    watermark: _watermark,
    ...stable
  } = projection;
  return {
    ...stable,
    views: Object.fromEntries(Object.entries(stable.views).map(
      ([name, view]) => {
        const {
          authority_watermark: _viewWatermark,
          legal_actions: _viewActions,
          ...stableView
        } = view;
        return [name, stableView];
      },
    )),
  };
}

async function validatesPublishedSchema(filename, value) {
  const schema = JSON.parse(await readFile(new URL(
    `../../../config/flow/schemas/${filename}`,
    import.meta.url,
  )));
  return new Ajv2020({ allErrors: true, strict: true }).validate(schema, value);
}

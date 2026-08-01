import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

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
  const authority = createDurableRunAuthority({
    authorityDirectory,
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

  const owner = createDurableRunAuthority({
    authorityDirectory,
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
  const blockedPrepared = afterRuntime.prepare(dynamicCheckpointProposal());
  const blockedLaunch = afterRuntime.launch(
    confirmedLaunchRequest(blockedPrepared),
  );
  assert.equal(blockedLaunch.code, "authority_schema_transition_required");
  assert.deepEqual(
    blockedLaunch.legal_actions,
    afterRuntime.query().legal_actions,
  );
  const staleAction = structuredClone(afterRuntime.query().legal_actions[0]);
  staleAction.expected_watermark = `sha256:${"0".repeat(64)}`;
  const stale = afterRuntime.command(staleAction);
  assert.equal(stale.code, "stale_authority_schema_transition");
  assert.deepEqual(stale.legal_actions, afterRuntime.query().legal_actions);
  const watchedTransition = watcher.next();
  const transitionReceipt = afterRuntime.command(
    afterRuntime.query().legal_actions[0],
  );
  const afterHost = afterRuntime.query();
  assert.equal(
    (await watchedTransition).value.authority_schema.status,
    "compatible",
  );
  const afterRun = afterRuntime.query({ run_id: beforeRun.run_id });

  assert.equal(afterHost.authority_schema.status, "compatible");
  assert.equal(transitionReceipt.accepted, true);
  assert.equal(afterHost.authority_schema.version, 2);
  assert.equal(
    afterHost.authority_schema.transition_release.id,
    "flow-runtime-authority-schema/v2",
  );
  assert.deepEqual(replayVisibleRun(afterRun), replayVisibleRun(beforeRun));
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
  ]) {
    await t.test(incompatible.name, async (t) => {
      const authorityDirectory = await currentStore(t);
      const database = new DatabaseSync(join(authorityDirectory, "authority.sqlite"));
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
    });
  }
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
  return authorityDirectory;
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
    legal_actions: legalActions,
    stream_generation: _streamGeneration,
    watermark: _watermark,
    ...stable
  } = projection;
  return {
    ...stable,
    legal_actions: legalActions.map(({ expected_watermark: _expected, ...action }) =>
      action),
  };
}

async function validatesPublishedSchema(filename, value) {
  const schema = JSON.parse(await readFile(new URL(
    `../../../config/flow/schemas/${filename}`,
    import.meta.url,
  )));
  return new Ajv2020({ allErrors: true, strict: true }).validate(schema, value);
}

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { decideLifecycle } from "../src/lifecycle-kernel.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import { preparedObservation } from "../src/reboot-revalidation.mjs";
import {
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";

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
    "time_facts",
    "subject_generations",
    "unresolved_effects",
  ]) {
    const changed = structuredClone(action);
    changed.revalidation[field] = field.endsWith("fingerprint")
      ? `sha256:${"0".repeat(64)}`
      : field === "route_snapshot"
        ? { watermark: `sha256:${"0".repeat(64)}`, bindings: [] }
        : [{ changed: field }];
    const rejection = rebooted.command(changed);
    assert.equal(rejection.code, "stale_reboot_admission", field);
  }
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
  assert.equal(
    rebooted.command(action).code,
    "reboot_revalidation_failed",
  );
});

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

  owner.send("close");
  await once(owner, "exit");
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
});

test("an unresolved effect keeps reboot admission suspended", async (t) => {
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
  firstAuthority.close();

  const rebootedAuthority = createDurableRunAuthority({
    authorityDirectory,
    hostIdentityAdapter: fixedHostIdentity("boot-b", "process-b"),
    lifecycleKernel: effectLifecycle,
    rebootObservationAdapter: preparedRebootObservation(),
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
    (error) => error.code === "stale_authority_epoch",
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

function withTimeout(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
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
        }],
      };
}

function preparedRebootObservation() {
  return Object.freeze({
    observe: ({ prepared }) => preparedObservation(prepared),
  });
}

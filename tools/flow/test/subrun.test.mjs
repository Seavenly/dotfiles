import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFlowRuntime } from "../src/flow-runtime.mjs";
import { createDurableRunAuthority } from "../src/run-authority.mjs";
import {
  confirmedLaunchRequest,
  dynamicCheckpointProposal,
  revisionBlockedCheckpointProposal,
} from "../test-support/dynamic-checkpoint.mjs";
import {
  operationReceipt,
  registeredOperationProposal,
  TEST_OPERATION_CONTRACT,
} from "../test-support/registered-operation.mjs";
import { fixedHostIdentity } from "../test-support/fixed-host-identity.mjs";
import { createSubrunRegistration } from "../src/subrun-effects.mjs";
import { delegateCardProposal } from "../test-support/delegate-card.mjs";
import { supportedDescription } from
  "../test-support/delegated-agent-description.mjs";

const SUBRUN_CONTRACT = "flow.subrun/create-and-observe/v1";
const SUBRUN_RECEIPT_VALIDATOR = "flow.validator/subrun-receipt/v1";

test("a parent admits and claims one independently authoritative child run", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke: operationReceipt,
      },
    },
  });
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));
  const parentReady = runtime.query({ run_id: parentLaunch.run_id });

  assert.deepEqual(parentReady.legal_actions.map(({ type }) => type), [
    "subrun_execute",
    "cancel",
  ]);
  assert.equal(runtime.command(parentReady.legal_actions[0]).accepted, true);
  await until(() => runtime.query().runs.length === 2);

  const parentExecuting = runtime.query({ run_id: parentLaunch.run_id });
  const childLink = parentExecuting.subruns[0];
  const childReady = runtime.query({ run_id: childLink.child_run_id });

  assert.equal(childLink.parent_run_id, parentLaunch.run_id);
  assert.equal(childLink.card_id, "child");
  assert.equal(childLink.revision_ordinal, 0);
  assert.match(childLink.card_identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(childLink.status, "active");
  assert.equal(childLink.child_watermark, childReady.watermark);
  assert.equal(childLink.result_disposition, "pending");
  assert.notEqual(childReady.run_id, parentExecuting.run_id);
  assert.notEqual(childReady.bundle_digest, parentExecuting.bundle_digest);
  assert.equal(childReady.parent.card_identity, childLink.card_identity);
  assert.deepEqual(childReady.limits, childProposal.explicit_facts.limits);
  assert.deepEqual(parentExecuting.limits,
    parentPrepared.explicit_facts.limits);
  assert.equal(parentExecuting.attempts[0].card_id, "child");
  assert.deepEqual(childReady.legal_actions.map(({ type }) => type), [
    "operation_execute",
    "cancel",
  ]);

  assert.equal(runtime.command(childReady.legal_actions[0]).accepted, true);
  await until(() => runtime.query({ run_id: parentLaunch.run_id }).phase ===
    "succeeded");
  const parentComplete = runtime.query({ run_id: parentLaunch.run_id });
  const childComplete = runtime.query({ run_id: childLink.child_run_id });

  assert.equal(childComplete.phase, "succeeded");
  assert.equal(childComplete.attempts[0].status, "completed");
  assert.equal(parentComplete.phase, "succeeded");
  assert.equal(parentComplete.attempts[0].status, "completed");
  assert.equal(parentComplete.subruns[0].status, "succeeded");
  assert.equal(parentComplete.subruns[0].result_disposition, "claimed");
  assert.equal(parentComplete.subruns[0].child_watermark,
    childComplete.watermark);
  assert.deepEqual(parentComplete.legal_actions, []);
});

test("same-boot replay adopts the exact nonterminal child", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  const firstRuntime = subrunRuntime(firstAuthority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = firstRuntime.prepare(childProposal);
  const parentPrepared = firstRuntime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = firstRuntime.launch(confirmedLaunchRequest(parentPrepared));
  firstRuntime.command(firstRuntime.query({ run_id: parentLaunch.run_id })
    .legal_actions.find(({ type }) => type === "subrun_execute"));
  await until(() => firstRuntime.query().runs.length === 2);
  const exactChildId = firstRuntime.query({
    run_id: parentLaunch.run_id,
  }).subruns[0].child_run_id;
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-b"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = subrunRuntime(recoveredAuthority);
  await until(() => recoveredRuntime.query({ run_id: parentLaunch.run_id })
    .effects[0].status === "reconciling");
  const recoveredParent = recoveredRuntime.query({ run_id: parentLaunch.run_id });

  assert.deepEqual([...recoveredRuntime.query().runs].sort(), [
    exactChildId,
    parentLaunch.run_id,
  ].sort());
  assert.equal(recoveredParent.subruns[0].child_run_id, exactChildId);
  assert.equal(recoveredParent.subruns[0].status, "active");
  assert.equal(recoveredRuntime.query({ run_id: exactChildId }).parent.parent_run_id,
    parentLaunch.run_id);

  recoveredRuntime.command(recoveredRuntime.query({ run_id: exactChildId })
    .legal_actions.find(({ type }) => type === "operation_execute"));
  await until(() => recoveredRuntime.query({ run_id: exactChildId }).phase ===
    "succeeded");
  await until(() => recoveredRuntime.query({ run_id: parentLaunch.run_id }).phase ===
    "succeeded");

  assert.equal(recoveredRuntime.query().runs.length, 2);
  assert.equal(recoveredRuntime.query({ run_id: parentLaunch.run_id })
    .subruns[0].child_run_id, exactChildId);
});

test("same-boot replay repairs child admission after the child commit boundary", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const firstAuthority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-crash"),
    afterChildLaunchCommit() {
      throw new Error("simulated loss after child commit");
    },
  });
  const firstRuntime = subrunRuntime(firstAuthority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = firstRuntime.prepare(childProposal);
  const parentPrepared = firstRuntime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = firstRuntime.launch(confirmedLaunchRequest(parentPrepared));
  firstRuntime.command(firstRuntime.query({ run_id: parentLaunch.run_id })
    .legal_actions.find(({ type }) => type === "subrun_execute"));
  await until(() => firstRuntime.query().runs.length === 2);
  const interrupted = firstRuntime.query({ run_id: parentLaunch.run_id });
  const childRunId = interrupted.subruns[0].child_run_id;
  assert.equal(interrupted.subruns[0].status, "admission_pending");
  firstAuthority.close();

  const recoveredAuthority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-recovered"),
  });
  t.after(() => recoveredAuthority.close());
  const recoveredRuntime = subrunRuntime(recoveredAuthority);
  await until(() => recoveredRuntime.query({ run_id: parentLaunch.run_id })
    .subruns[0].status === "active");
  const recoveredParent = recoveredRuntime.query({ run_id: parentLaunch.run_id });
  assert.equal(recoveredParent.subruns[0].child_watermark,
    recoveredRuntime.query({ run_id: childRunId }).watermark);

  recoveredRuntime.command(recoveredRuntime.query({ run_id: childRunId })
    .legal_actions.find(({ type }) => type === "operation_execute"));
  await until(() => recoveredRuntime.query({ run_id: parentLaunch.run_id }).phase ===
    "succeeded");
  assert.equal(recoveredRuntime.query().runs.length, 2);
});

test("parent cancellation reconciles the child request and quarantines late output", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  let settleChild;
  const runtime = subrunRuntime(authority, {
    invoke(intent) {
      return new Promise((resolve) => {
        settleChild = () => resolve(operationReceipt(intent, {
          record: "late-child-output",
        }));
      });
    },
  });
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id }).legal_actions.find(
    ({ type }) => type === "subrun_execute",
  ));
  await until(() => runtime.query().runs.length === 2);
  const childRunId = runtime.query({ run_id: parentLaunch.run_id })
    .subruns[0].child_run_id;
  runtime.command(runtime.query({ run_id: childRunId }).legal_actions.find(
    ({ type }) => type === "operation_execute",
  ));
  await until(() => typeof settleChild === "function");

  const parentExecuting = runtime.query({ run_id: parentLaunch.run_id });
  runtime.command(parentExecuting.legal_actions.find(({ type }) => type === "cancel"));
  await until(() => runtime.query({ run_id: childRunId }).phase === "cancelled");
  const requested = runtime.query({ run_id: parentLaunch.run_id });

  assert.equal(requested.phase, "cancelled");
  assert.equal(requested.subruns[0].cancellation_disposition, "requested");
  assert.equal(requested.subruns[0].result_disposition, "quarantined");
  assert.equal(runtime.query({ run_id: childRunId }).phase, "cancelled");

  settleChild();
  await until(() => runtime.query({ run_id: childRunId }).effects[0].status ===
    "late_succeeded");
  await until(() => runtime.query({ run_id: parentLaunch.run_id })
    .subruns[0].cancellation_disposition === "reconciled");
  const parentSettled = runtime.query({ run_id: parentLaunch.run_id });
  const childSettled = runtime.query({ run_id: childRunId });

  assert.equal(parentSettled.phase, "cancelled");
  assert.equal(parentSettled.subruns[0].status, "cancelled");
  assert.equal(parentSettled.subruns[0].output_disposition, "late_unclaimed");
  assert.equal(parentSettled.subruns[0].result_disposition, "quarantined");
  assert.equal(parentSettled.subruns[0].child_watermark, childSettled.watermark);
  assert.equal(parentSettled.effects[0].status, "late_succeeded");
  assert.equal(parentSettled.effects[0].disposition, "quarantined");
  assert.equal(childSettled.effects[0].status, "late_succeeded");
  assert.equal(childSettled.effects[0].disposition, "quarantined");
  assert.equal(childSettled.effects[0].receipt.provider_receipt.record,
    "late-child-output");
  assert.deepEqual(parentSettled.legal_actions, []);
});

test("child admission has its own capacity decision and fails without a phantom run", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 1,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = subrunRuntime(authority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id }).legal_actions.find(
    ({ type }) => type === "subrun_execute",
  ));
  await until(() => runtime.query({ run_id: parentLaunch.run_id })
    .effects[0].invocation_started === true);
  const parent = runtime.query({ run_id: parentLaunch.run_id });

  assert.deepEqual(runtime.query().runs, [parentLaunch.run_id]);
  assert.equal(runtime.query().admission.active_runs, 1);
  assert.equal(parent.phase, "active");
  assert.equal(parent.subruns[0].status, "admission_pending");
  assert.equal(parent.effects[0].status, "unresolved");
  assert.deepEqual(parent.legal_actions.map(({ type }) => type), [
    "recovery",
    "cancel",
  ]);

  runtime.command(parent.legal_actions.find(({ type }) => type === "cancel"));
  const cancelled = runtime.query({ run_id: parentLaunch.run_id });
  runtime.command(cancelled.legal_actions.find(({ type }) => type === "recovery"));
  await until(() => runtime.query({ run_id: parentLaunch.run_id })
    .effects[0].status === "not_created");
  const reconciled = runtime.query({ run_id: parentLaunch.run_id });
  assert.equal(reconciled.subruns[0].status, "not_created");
  assert.equal(reconciled.subruns[0].result_disposition, "not_created");
  assert.equal(reconciled.subruns[0].cancellation_disposition, "reconciled");
  assert.equal(reconciled.subruns[0].output_disposition, "none");
  assert.deepEqual(reconciled.legal_actions, []);
});

test("cancellation before child admission settles as exact non-creation", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-cancel-race"),
  });
  t.after(() => authority.close());
  const runtime = subrunRuntime(authority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));
  const ready = runtime.query({ run_id: parentLaunch.run_id });

  runtime.command(ready.legal_actions.find(({ type }) => type === "subrun_execute"));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id })
    .legal_actions.find(({ type }) => type === "cancel"));
  await new Promise((resolve) => setImmediate(resolve));

  const cancelled = runtime.query({ run_id: parentLaunch.run_id });
  assert.deepEqual(runtime.query().runs, [parentLaunch.run_id]);
  assert.equal(cancelled.effects[0].status, "abandoned");
  assert.equal(cancelled.subruns[0].status, "not_created");
  assert.equal(cancelled.subruns[0].cancellation_disposition, "reconciled");
  assert.equal(cancelled.subruns[0].output_disposition, "none");
  assert.deepEqual(cancelled.legal_actions, []);
});

test("subrun reconciliation distinguishes exact absence from authority failure", () => {
  const intent = {
    run_id: "run:parent",
    card_id: "child",
    card_identity: `sha256:${"a".repeat(64)}`,
    revision_ordinal: 0,
    effect_id: "effect:child",
    idempotency_key: "child-key",
  };
  let rejection = {
    schema: "flow.rejection/v1",
    code: "authority_integrity_failure",
    authority_watermark: null,
    authority_watermark_domain: "run",
  };
  const registration = createSubrunRegistration({
    getRuntime: () => ({ query: () => rejection }),
    runAuthority: {},
  });

  assert.equal(registration.observe(intent).presence, "indeterminate");

  rejection = {
    schema: "flow.rejection/v1",
    code: "unknown_run",
    authority_watermark: "sha256:host-index",
    authority_watermark_domain: "host",
  };
  assert.equal(registration.observe(intent).presence, "absent");
});

for (const status of ["quarantined", "late_quarantined"]) {
  test(`subrun settlement accepts a terminal child with ${status} effects`, async () => {
    const child = {
      run_id: "run:child:settled",
      phase: "declined",
      watermark: `sha256:${"b".repeat(64)}`,
      attempts: [{ attempt_id: "attempt:delegate", status: "completed" }],
      effects: [{ status }],
    };
    const registration = createSubrunRegistration({
      getRuntime: () => ({
        watch: () => ({
          async *[Symbol.asyncIterator]() {
            yield child;
          },
        }),
      }),
      runAuthority: {
        launchChild: () => ({ run_id: child.run_id }),
      },
    });
    const receipt = await registration.invoke({
      run_id: "run:parent",
      card_id: "child",
      card_identity: `sha256:${"a".repeat(64)}`,
      revision_ordinal: 0,
      effect_id: "effect:child",
      idempotency_key: "child-key",
      operation_input: { child_launch_request: {} },
    });

    assert.equal(receipt.provider_receipt.child_phase, "declined");
    assert.equal(receipt.provider_receipt.child_watermark, child.watermark);
  });
}

test("parent launch preflights delegate compatibility inside exact child bundles", async () => {
  const runtime = createFlowRuntime();
  const childProposal = delegateCardProposal(
    await compatibleDelegateDescription(),
  );
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));

  const rejected = runtime.launch(confirmedLaunchRequest(parentPrepared));

  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "delegated_agent_port_unavailable");
  assert.deepEqual(runtime.query().runs, []);
});

test("child authority rejects a launch request outside the confirmed subrun card", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-binding"),
  });
  t.after(() => authority.close());
  const runtime = subrunRuntime(authority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childLaunchRequest = confirmedLaunchRequest(runtime.prepare(childProposal));
  const otherProposal = registeredOperationProposal({ checkpointBound: false });
  otherProposal.graph.cards[0].inputs = { record: "different-child" };
  const otherLaunchRequest = confirmedLaunchRequest(runtime.prepare(otherProposal));
  const parentPrepared = runtime.prepare(parentProposal(childLaunchRequest));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id })
    .legal_actions.find(({ type }) => type === "subrun_execute"));
  const link = runtime.query({ run_id: parentLaunch.run_id }).subruns[0];

  const rejected = authority.launchChild({
    parent_run_id: parentLaunch.run_id,
    card_id: link.card_id,
    card_identity: link.card_identity,
    revision_ordinal: link.revision_ordinal,
    launch_request: otherLaunchRequest,
  });

  assert.equal(rejected.schema, "flow.rejection/v1");
  assert.equal(rejected.code, "subrun_not_actionable");
  assert.deepEqual(runtime.query().runs, [parentLaunch.run_id]);
  await until(() => runtime.query().runs.length === 2);
  assert.equal(runtime.query({ run_id: link.child_run_id }).bundle_digest,
    childLaunchRequest.prepared.bundle_digest);
});

test("prepare rejects a subrun whose exact child launch binding was changed", () => {
  const runtime = createFlowRuntime({
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        invoke: operationReceipt,
      },
    },
  });
  const childPrepared = runtime.prepare(
    registeredOperationProposal({ checkpointBound: false }),
  );
  const childLaunch = confirmedLaunchRequest(childPrepared);
  childLaunch.closed_facts.facts.catalog_fingerprint =
    `sha256:${"9".repeat(64)}`;

  assert.throws(
    () => runtime.prepare(parentProposal(childLaunch)),
    /subrun card is incomplete: child/,
  );
});

test("a child terminal decision cannot become parent success", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = subrunRuntime(authority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(parentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id }).legal_actions.find(
    ({ type }) => type === "subrun_execute",
  ));
  await until(() => runtime.query().runs.length === 2);
  const childRunId = runtime.query({ run_id: parentLaunch.run_id })
    .subruns[0].child_run_id;

  runtime.command(runtime.query({ run_id: childRunId }).legal_actions.find(
    ({ type }) => type === "cancel",
  ));
  await until(() => runtime.query({ run_id: parentLaunch.run_id }).phase !==
    "active");
  const parent = runtime.query({ run_id: parentLaunch.run_id });

  assert.equal(parent.phase, "declined");
  assert.equal(parent.cards[0].status, "declined");
  assert.equal(parent.subruns[0].status, "cancelled");
  assert.equal(parent.subruns[0].result_disposition, "quarantined");
  assert.equal(parent.subruns[0].output_disposition, "terminal_unclaimed");
  assert.deepEqual(parent.legal_actions, []);
});

test("a revised subrun identity binds its revision ordinal and immutable card", async (t) => {
  const authorityDirectory = await mkdtemp(join(tmpdir(), "flow-subrun-"));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));
  const authority = createDurableRunAuthority({
    authorityDirectory,
    declaredCapacity: 2,
    hostIdentityAdapter: fixedHostIdentity("boot-a", "process-a"),
  });
  t.after(() => authority.close());
  const runtime = subrunRuntime(authority);
  const childProposal = registeredOperationProposal({ checkpointBound: false });
  childProposal.requested_authority.commands.push("cancel");
  const childPrepared = runtime.prepare(childProposal);
  const parentPrepared = runtime.prepare(revisedParentProposal(
    confirmedLaunchRequest(childPrepared),
  ));
  const parentLaunch = runtime.launch(confirmedLaunchRequest(parentPrepared));

  runtime.command(runtime.query({ run_id: parentLaunch.run_id }).legal_actions.find(
    ({ type }) => type === "capability_grant",
  ));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id }).legal_actions.find(
    ({ checkpoint_id: checkpointId, decision }) =>
      checkpointId === "confirm-scope" && decision === "approve",
  ));
  runtime.command(runtime.query({ run_id: parentLaunch.run_id }).legal_actions.find(
    ({ decision, type }) => type === "revision_decision" && decision === "accept",
  ));
  const revised = runtime.query({ run_id: parentLaunch.run_id });
  assert.equal(revised.current_revision.ordinal, 1);
  runtime.command(revised.legal_actions.find(
    ({ type }) => type === "subrun_execute",
  ));
  await until(() => runtime.query().runs.length === 2);
  const parent = runtime.query({ run_id: parentLaunch.run_id });
  const child = runtime.query({ run_id: parent.subruns[0].child_run_id });

  assert.equal(parent.subruns[0].revision_ordinal, 1);
  assert.equal(child.parent.revision_ordinal, 1);
  assert.equal(child.parent.card_identity, parent.subruns[0].card_identity);
  assert.match(child.run_id, /^run:child:[0-9a-f]{64}$/);
});

function parentProposal(childLaunchRequest) {
  const proposal = dynamicCheckpointProposal();
  proposal.graph.cards = [{
    id: "child",
    executor: {
      kind: "subrun",
      contract: SUBRUN_CONTRACT,
      effect_classification: "reconcilable",
    },
    dependencies: [],
    inputs: { child_launch_request: childLaunchRequest },
    outputs: ["child_terminal_result"],
    success_criteria: ["child:succeeded"],
    validators: [SUBRUN_RECEIPT_VALIDATOR],
    data_references: [],
    evidence_references: [],
    route: { adapter: "run-authority" },
    limits: { max_attempts: 1 },
    resource_claims: [],
    recovery: "reconcile",
  }];
  proposal.requested_authority = {
    commands: ["subrun_execute", "cancel"],
    capabilities: [],
    mutations: [SUBRUN_CONTRACT],
  };
  proposal.explicit_facts.operation_contracts = [SUBRUN_CONTRACT];
  proposal.explicit_facts.validator_contracts = [SUBRUN_RECEIPT_VALIDATOR];
  return proposal;
}

function subrunRuntime(authority, operation = { invoke: operationReceipt }) {
  return createFlowRuntime({
    runAuthority: authority,
    registeredOperations: {
      [TEST_OPERATION_CONTRACT]: {
        classification: "caller_idempotent",
        ...operation,
      },
    },
  });
}

function revisedParentProposal(childLaunchRequest) {
  const proposal = revisionBlockedCheckpointProposal();
  const subrun = parentProposal(childLaunchRequest).graph.cards[0];
  const template = proposal.revision_templates[0];
  template.changes.add_cards = [subrun];
  template.changes.add_edges = [{ from: "confirm-scope", to: "child" }];
  template.changes.capability_additions = [];
  proposal.requested_authority.commands.push("subrun_execute", "cancel");
  proposal.requested_authority.mutations.push(SUBRUN_CONTRACT);
  proposal.explicit_facts.operation_contracts.push(SUBRUN_CONTRACT);
  proposal.explicit_facts.validator_contracts.push(SUBRUN_RECEIPT_VALIDATOR);
  return proposal;
}

function compatibleDelegateDescription() {
  return supportedDescription({
    schema: "drovr.delegated-agent-description-request/v1",
    launch: {
      harness: "codex",
      role: "reviewer",
      model: "gpt-5.6",
      effort: "high",
      capability: "read-only",
    },
    caller_metadata: { owner: "flow" },
  }, {});
}

async function until(condition) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
